/**
 * M0-D: единый интерфейс резервных бэкендов (H5) и лёгкая сверка (U3).
 *
 * Проверяем:
 * - у WebDAV есть list/sync/commit/remove/capabilities/lightProbe;
 * - отсутствующий метод даёт понятную ошибку reserve/unsupported, а не
 *   «… is not a function»;
 * - remove уходит в облачный карантин или в очередь и не роняет синхронизацию;
 * - lightProbe сверяет id/events/sizeBytes только по PROPFIND и
 *   profile/manifest.json (логи сессий не скачиваются), укладывается в таймаут;
 * - secondary-init использует лёгкую сверку, а на бэкенде без неё говорит
 *   «reserve/unsupported» и переходит к полной сверке.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import {
  BACKEND_METHODS,
  RESERVE_CODES,
  WEBDAV_CAPABILITIES,
  backendCapabilities,
  createWebdavBackend,
  lightProbeTimeoutMs,
  normalizeBackend,
  readRemoveQueue,
  removeQueuePath,
  unsupportedOperation,
} from '../lib/webdav.mjs'
import { encodeSegment } from '../lib/format.mjs'
import { canonicalize, localSessionDir } from '../lib/store.mjs'
import {
  collectLocalProbeEntries,
  probeSecondaryChannel,
  readSecondaryStatus,
} from '../lib/secondary-init.mjs'

const LOG_NAME = 'session.v4.jsonl.zstd'

/** Лог сессии: кадр-заголовок + N кадров событий. */
function sessionBytes(projectPath, id, events = 2) {
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: projectPath, isSeeded: false }
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (let index = 0; index < events; index++) {
    frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify({ seq: index, type: 'text', data: { text: `событие ${index}` } })}\n`)))
  }
  return Buffer.concat(frames)
}

/**
 * Поддельный WebDAV: дерево в памяти, PROPFIND с depth 0/1/infinity, MOVE,
 * GET/PUT/MKCOL/DELETE. Все вызовы пишутся в calls — по ним видно, что именно
 * скачивала лёгкая сверка.
 */
function fakeWebdav(options = {}) {
  const files = new Map()
  const dirs = new Set(['/dsh-sync'])
  const calls = []
  const supportMove = options.move !== false
  const supportInfinity = options.infinity !== false
  let moves = 0

  if (options.manifest !== undefined) {
    dirs.add('/dsh-sync/profile')
    files.set('/dsh-sync/profile/manifest.json', Buffer.from(JSON.stringify(options.manifest)))
  }

  const allPaths = () => [...dirs, ...files.keys()]
  const descendants = (target) => allPaths().filter(path => path !== target && path.startsWith(`${target}/`))
  const dirChildren = (target) => {
    const prefix = `${target}/`
    const found = new Set()
    for (const path of allPaths()) {
      if (path === target || !path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest === '') continue
      found.add(`${prefix}${rest.split('/')[0]}`)
    }
    return [...found]
  }

  const responseFor = (path) => {
    const isDir = dirs.has(path)
    const href = isDir ? `${path}/` : path
    const length = isDir ? '' : `<d:getcontentlength>${files.get(path)?.length ?? 0}</d:getcontentlength>`
    return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>${length}</d:prop></d:propstat></d:response>`
  }

  const handler = async (url, init = {}) => {
    const parsed = new URL(url)
    const decoded = decodeURIComponent(parsed.pathname)
    const target = decoded.replace(/\/+$/, '') || '/'
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, path: target, depth: init.headers?.depth })

    if (!String(init.headers?.authorization ?? '').startsWith('Basic ')) {
      return new Response('unauthorized', { status: 401 })
    }
    const credentials = Buffer.from(String(init.headers.authorization).slice(6), 'base64').toString('utf8')
    if (credentials !== 'user:app-pass') return new Response('unauthorized', { status: 401 })

    if (method === 'PROPFIND') {
      if (!dirs.has(target) && !files.has(target)) return new Response('not found', { status: 404 })
      const depth = String(init.headers?.depth ?? '1')
      if (depth === 'infinity' && !supportInfinity) return new Response('depth not supported', { status: 403 })
      if (depth === 'infinity' && !dirs.has(target)) return new Response('not a collection', { status: 403 })
      let items
      if (depth === 'infinity') items = [target, ...descendants(target)]
      else if (depth === '1') items = [target, ...dirChildren(target)]
      else items = [target]
      return new Response(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${items.map(responseFor).join('')}</d:multistatus>`,
        { status: 207 },
      )
    }

    if (method === 'MOVE') {
      if (!supportMove) return new Response('move not supported', { status: 501 })
      if (!files.has(target)) return new Response('not found', { status: 404 })
      const destination = decodeURIComponent(new URL(init.headers.destination).pathname).replace(/\/+$/, '')
      files.set(destination, files.get(target))
      files.delete(target)
      dirs.add(destination.slice(0, destination.lastIndexOf('/')))
      moves += 1
      return new Response(null, { status: 201 })
    }

    if (method === 'GET') {
      const buffer = files.get(target)
      if (buffer === undefined) return new Response('not found', { status: 404 })
      return new Response(buffer, { status: 200 })
    }

    if (method === 'PUT') {
      files.set(target, Buffer.from(init.body))
      dirs.add(target.slice(0, target.lastIndexOf('/')))
      return new Response(null, { status: 201 })
    }

    if (method === 'MKCOL') {
      if (dirs.has(target)) return new Response(null, { status: 405 })
      const parent = target.slice(0, target.lastIndexOf('/')) || '/'
      if (parent !== '/' && !dirs.has(parent)) return new Response('no parent', { status: 409 })
      dirs.add(target)
      return new Response(null, { status: 201 })
    }

    if (method === 'DELETE') {
      files.delete(target)
      return new Response(null, { status: 204 })
    }

    return new Response('unexpected', { status: 500 })
  }

  return { files, dirs, calls, handler, get moves() { return moves } }
}

/** Положить в «облако» канонический лог сессии (как после push). */
function putCloudBytes(disk, { projectId = 'p', id, bytes }) {
  const dir = `/dsh-sync/sessions/${projectId}/${encodeSegment(id)}`
  disk.dirs.add('/dsh-sync/sessions')
  disk.dirs.add(`/dsh-sync/sessions/${projectId}`)
  disk.dirs.add(dir)
  disk.files.set(`${dir}/${LOG_NAME}`, bytes)
  return bytes
}

/** Положить в «облако» канонический лог сессии (как после push). */
function putCloudSession(disk, { projectId = 'p', projectPath = 'C:\\project', id, events = 2 }) {
  return putCloudBytes(disk, { projectId, id, bytes: canonicalize(sessionBytes(projectPath, id, events), projectId) })
}

function cloudSessionPath({ projectId = 'p', id }) {
  return `sessions/${projectId}/${encodeSegment(id)}/${LOG_NAME}`
}

function makeBackend(repoDir) {
  return createWebdavBackend(
    { backend: 'webdav', repoDir, webdavLogin: 'user', webdavPassword: 'app-pass', webdavPath: 'dsh-sync' },
    { retryBaseMs: 1 },
  )
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-m0-d-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('WebDAV: единый интерфейс — методы, capabilities, kind', async () => {
  const backend = createWebdavBackend({ backend: 'webdav', repoDir: tmpdir(), webdavLogin: 'user', webdavPassword: 'app-pass', webdavPath: 'dsh-sync' })
  for (const method of [...BACKEND_METHODS, 'kind', 'capabilities']) {
    assert.ok(backend[method] !== undefined, `у бэкенда есть ${method}`)
  }
  assert.equal(backend.kind, 'webdav')
  assert.deepEqual(backend.capabilities, { list: true, sync: true, commit: true, remove: true, lightProbe: true })
  assert.deepEqual(backend.capabilities, WEBDAV_CAPABILITIES)
  for (const method of BACKEND_METHODS) assert.equal(typeof backend[method], 'function', `${method} — функция`)
})

test('normalizeBackend: отсутствующий метод — ошибка reserve/unsupported, а не TypeError', async () => {
  const missing = normalizeBackend({ kind: 'folder' })
  assert.equal(missing.kind, 'folder')
  assert.deepEqual(missing.capabilities, { list: false, sync: false, commit: false, remove: false, lightProbe: false })
  for (const method of BACKEND_METHODS) {
    assert.equal(missing.supports(method), false, `${method} не поддержан`)
    await assert.rejects(
      () => missing[method](),
      (error) => {
        assert.equal(error.code, RESERVE_CODES.unsupported, 'код reserve/unsupported')
        assert.match(error.message, /folder/, 'в ошибке видно, какой это канал')
        assert.match(error.message, new RegExp(method), 'в ошибке назван метод')
        assert.doesNotMatch(error.message, /is not a function/, 'нет TypeError-сообщения')
        return true
      },
    )
  }
  // Даже нормализация «пустого» бэкенда не падает: заглушки бросают при вызове.
  const empty = normalizeBackend(null, { kind: 'reserve' })
  await assert.rejects(() => empty.sync(), { code: RESERVE_CODES.unsupported })
  // Реализованные методы пробрасываются как есть, заглушкой становится только отсутствующий.
  const partial = normalizeBackend({ kind: 'git', async sync() { return 'ok' }, async commit() { return { committed: true } } })
  assert.equal(await partial.sync(), 'ok')
  assert.deepEqual(await partial.commit(), { committed: true })
  assert.equal(partial.capabilities.sync, true)
  assert.equal(partial.capabilities.remove, false)
  await assert.rejects(() => partial.remove('x'), { code: RESERVE_CODES.unsupported })
  // Утилита ошибки отдаёт тот же код.
  assert.equal(unsupportedOperation('remove', 'yandex').code, RESERVE_CODES.unsupported)
  assert.deepEqual(backendCapabilities(null), { list: false, sync: false, commit: false, remove: false, lightProbe: false })
})

test('normalizeBackend: WebDAV сохраняет capabilities и пробрасывает вызовы', async () => {
  const disk = fakeWebdav()
  globalThis.fetch = disk.handler
  try {
    await withTempDir(async (root) => {
      const normalized = normalizeBackend(makeBackend(join(root, 'cache')))
      assert.equal(normalized.kind, 'webdav')
      assert.deepEqual(normalized.capabilities, { list: true, sync: true, commit: true, remove: true, lightProbe: true })
      for (const method of BACKEND_METHODS) assert.equal(normalized.supports(method), true, `${method} поддержан`)
      assert.deepEqual(await normalized.list(), [], 'пустое облако — пустой список')
    })
  } finally {
    delete globalThis.fetch
  }
})

test('list() отдаёт пути, размеры и дату изменения', async () => {
  const disk = fakeWebdav()
  globalThis.fetch = disk.handler
  try {
    await withTempDir(async (root) => {
      const id = `session-${randomUUID()}`
      const canonical = putCloudSession(disk, { id, events: 2 })
      const backend = makeBackend(join(root, 'cache'))
      const items = await backend.list()
      assert.equal(items.length, 1)
      assert.equal(items[0].rel, cloudSessionPath({ id }))
      assert.equal(items[0].size, canonical.length)
      assert.equal(typeof items[0].modified, 'string')
    })
  } finally {
    delete globalThis.fetch
  }
})

test('lightProbe: сверка id/events/sizeBytes без скачивания логов', async () => {
  const disk = fakeWebdav({ manifest: { version: 1, device: 'device-cloud', updatedAt: '2026-11-20T09:00:00.000Z', files: { 'profile/cordis.patch.yml': { sha256: 'a'.repeat(64), bytes: 10 } } } })
  globalThis.fetch = disk.handler
  try {
    await withTempDir(async (root) => {
      const id = `session-${randomUUID()}`
      const canonical = putCloudSession(disk, { id, events: 3 })
      const backend = makeBackend(join(root, 'cache'))
      const probe = await backend.lightProbe({
        local: [{ id, project: 'p', events: 3, sizeBytes: canonical.length }],
        projects: ['p'],
      })
      assert.equal(probe.ok, true)
      assert.equal(probe.code, RESERVE_CODES.ok)
      assert.equal(probe.local.count, 1)
      assert.deepEqual(probe.local.ids, [id])
      assert.equal(probe.cloud.count, 1)
      assert.deepEqual(probe.cloud.ids, [id])
      assert.equal(probe.cloud.sizesKnown, true)
      assert.equal(probe.onlyLocal, 0)
      assert.equal(probe.onlyCloud, 0)
      assert.equal(probe.differ, 0)
      assert.deepEqual(probe.onlyLocalIds, [])
      assert.deepEqual(probe.onlyCloudIds, [])
      assert.deepEqual(probe.differIds, [])
      assert.equal(probe.manifest.present, true)
      assert.equal(probe.manifest.device, 'device-cloud')
      assert.equal(probe.manifest.files, 1)
      assert.equal(probe.timeoutMs, lightProbeTimeoutMs(undefined))

      // Главное: логи сессий не скачивались — только PROPFIND и манифест.
      const sessionGets = disk.calls.filter(call => call.method === 'GET' && call.path.includes('/sessions/'))
      assert.deepEqual(sessionGets, [], 'логи сессий не скачивались')
      const gets = disk.calls.filter(call => call.method === 'GET')
      assert.ok(gets.length <= 1, `GET только манифест, было ${gets.length}`)
      assert.ok(gets.every(call => call.path.endsWith('/profile/manifest.json')))
      assert.ok(disk.calls.length <= 4, `лёгкая сверка — мало запросов, было ${disk.calls.length}`)
      assert.ok(disk.calls.some(call => call.method === 'PROPFIND'), 'использован PROPFIND')
    })
  } finally {
    delete globalThis.fetch
  }
})

test('lightProbe: расхождения onlyLocal/onlyCloud/differ с подробностями', async () => {
  try {
    await withTempDir(async (root) => {
      const same = `session-${randomUUID()}`
      const differs = `session-${randomUUID()}`
      const cloudOnly = `session-${randomUUID()}`
      const localOnly = `session-${randomUUID()}`
      // Манифест отдаёт индекс сессий (заготовка U3): по нему сверяются события.
      const disk = fakeWebdav({
        manifest: { version: 1, device: 'device-cloud', updatedAt: '2026-11-20T09:00:00.000Z', files: {}, sessions: { [differs]: { events: 2 } } },
      })
      globalThis.fetch = disk.handler
      const sameBytes = putCloudSession(disk, { id: same, events: 2 })
      const differBytes = putCloudSession(disk, { id: differs, events: 2 })
      putCloudSession(disk, { id: cloudOnly, events: 1 })
      const backend = makeBackend(join(root, 'cache'))
      const probe = await backend.lightProbe({
        local: [
          { id: same, project: 'p', events: 2, sizeBytes: sameBytes.length },
          { id: differs, project: 'p', events: 7, sizeBytes: differBytes.length + 5 },
          { id: localOnly, project: 'p', events: 1, sizeBytes: 100 },
        ],
        projects: ['p'],
      })
      assert.equal(probe.ok, true)
      assert.equal(probe.local.count, 3)
      assert.equal(probe.cloud.count, 3)
      assert.equal(probe.onlyLocal, 1)
      assert.deepEqual(probe.onlyLocalIds, [localOnly])
      assert.equal(probe.onlyCloud, 1)
      assert.deepEqual(probe.onlyCloudIds, [cloudOnly])
      assert.equal(probe.differ, 1)
      assert.deepEqual(probe.differIds, [differs])
      assert.equal(probe.differItems.length, 1)
      assert.deepEqual(probe.differItems[0].events, { local: 7, cloud: 2 })
      assert.equal(probe.differItems[0].sizeBytes.local, differBytes.length + 5)
      assert.equal(probe.differItems[0].sizeBytes.cloud, differBytes.length)
    })
  } finally {
    delete globalThis.fetch
  }
})

test('lightProbe: depth infinity не поддержан — пошаговый обход, id без размеров', async () => {
  const disk = fakeWebdav({ infinity: false })
  globalThis.fetch = disk.handler
  try {
    await withTempDir(async (root) => {
      const first = `session-${randomUUID()}`
      const second = `session-${randomUUID()}`
      putCloudSession(disk, { id: first, events: 1 })
      putCloudSession(disk, { id: second, events: 2 })
      const backend = makeBackend(join(root, 'cache'))
      const probe = await backend.lightProbe({
        local: [{ id: first, project: 'p', events: 1, sizeBytes: 1 }],
        projects: ['p'],
      })
      assert.equal(probe.ok, true)
      assert.equal(probe.cloud.count, 2)
      assert.deepEqual(probe.cloud.ids, [first, second].sort())
      assert.equal(probe.cloud.sizesKnown, false, 'размеры без depth infinity неизвестны')
      assert.equal(probe.differ, 0, 'без размеров расхождений по размеру нет — ложных не выдумываем')
      assert.equal(probe.onlyCloud, 1)
      // Один PROPFIND отклонён (403), дальше — depth 1: корень, sessions, проект.
      assert.ok(disk.calls.some(call => call.depth === 'infinity'))
      assert.ok(disk.calls.filter(call => call.depth === '1').length >= 3)
      assert.deepEqual(disk.calls.filter(call => call.method === 'GET' && call.path.includes('/sessions/')), [], 'логи сессий не скачивали')
    })
  } finally {
    delete globalThis.fetch
  }
})

test('remove: облачная копия уходит в карантин .trash', async () => {
  const disk = fakeWebdav()
  globalThis.fetch = disk.handler
  try {
    await withTempDir(async (root) => {
      const id = `session-${randomUUID()}`
      putCloudSession(disk, { id })
      const repoDir = join(root, 'cache')
      const backend = makeBackend(repoDir)
      const rel = cloudSessionPath({ id })
      const result = await backend.remove(rel)
      assert.equal(result.ok, true)
      assert.equal(result.removed, true)
      assert.equal(result.quarantined, true)
      assert.equal(result.queued, false)
      assert.equal(disk.files.has(`/dsh-sync/${rel}`), false, 'исходный файл убран')
      const trash = [...disk.files.keys()].filter(path => path.startsWith('/dsh-sync/.trash/'))
      assert.equal(trash.length, 1, 'копия лежит в карантине')
      assert.ok(trash[0].endsWith(`/${rel}`), 'в карантине тот же относительный путь')
      assert.equal(disk.moves, 1)
      const queue = await readRemoveQueue(repoDir)
      assert.deepEqual(queue.operations, [], 'очередь не нужна — удалили сразу')
    })
  } finally {
    delete globalThis.fetch
  }
})

test('remove: MOVE не поддержан — операция встаёт в очередь, синхронизация не падает', async () => {
  const disk = fakeWebdav({ move: false })
  globalThis.fetch = disk.handler
  try {
    await withTempDir(async (root) => {
      const id = `session-${randomUUID()}`
      putCloudSession(disk, { id })
      const repoDir = join(root, 'cache')
      const backend = makeBackend(repoDir)
      const rel = cloudSessionPath({ id })
      const result = await backend.remove(rel)
      assert.equal(result.ok, true, 'наружу не ошибка')
      assert.equal(result.queued, true)
      assert.equal(result.quarantined, false)
      assert.match(result.reason, /MOVE/)
      const queue = await readRemoveQueue(repoDir)
      assert.equal(queue.operations.length, 1)
      assert.equal(queue.operations[0].path, rel)
      assert.ok(existsSync(removeQueuePath(repoDir)), 'очередь лежит рядом с кешем')
      // Повторный remove не плодит дубли.
      await backend.remove(rel)
      assert.equal((await readRemoveQueue(repoDir)).operations.length, 1)
    })
  } finally {
    delete globalThis.fetch
  }
})

test('remove: сеть недоступна — очередь вместо исключения', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') }) }
  try {
    await withTempDir(async (root) => {
      const repoDir = join(root, 'cache')
      const backend = makeBackend(repoDir)
      const rel = 'sessions/p/dead-session/session.v4.jsonl.zstd'
      const result = await backend.remove(rel)
      assert.equal(result.ok, true)
      assert.equal(result.queued, true)
      assert.equal(result.quarantined, false)
      const queue = await readRemoveQueue(repoDir)
      assert.equal(queue.operations.length, 1)
      assert.equal(queue.operations[0].path, rel)
      assert.match(queue.operations[0].reason, /fetch failed|ECONNRESET|aborted/i)
    })
  } finally {
    delete globalThis.fetch
  }
})

test('lightProbe: таймаут 10–30 с, понятная ошибка reserve/timeout', async () => {
  // Границы таймаута по аудиту: меньше 10 с не опускаем, больше 30 не поднимаем.
  assert.equal(lightProbeTimeoutMs(undefined), 20_000)
  assert.equal(lightProbeTimeoutMs(1000), 10_000)
  assert.equal(lightProbeTimeoutMs(15_000), 15_000)
  assert.equal(lightProbeTimeoutMs(60_000), 30_000)
  assert.equal(lightProbeTimeoutMs(-5), 20_000)

  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }
  try {
    await withTempDir(async (root) => {
      const backend = makeBackend(join(root, 'cache'))
      const started = Date.now()
      const probe = await backend.lightProbe({ local: [{ id: 's', project: 'p', events: 1, sizeBytes: 1 }], projects: ['p'], timeoutMs: 1000 })
      const elapsed = Date.now() - started
      assert.equal(probe.ok, false)
      assert.equal(probe.code, RESERVE_CODES.timeout)
      assert.match(probe.message, /не уложилась в 10 с/)
      assert.equal(probe.local.count, 1)
      assert.equal(probe.cloud.count, 0)
      assert.ok(elapsed < 5_000, `сверка упала по таймауту быстро, а не ждала 10 с (${elapsed} мс)`)
      assert.ok(calls <= 6, `повторов немного (${calls})`)
    })
  } finally {
    delete globalThis.fetch
  }
})

test('secondary-init: локальный слепок для лёгкой сверки — id, events, размер канонического лога', async () => {
  await withTempDir(async (root) => {
    const home = join(root, 'home')
    const projectPath = join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    const id = `session-${randomUUID()}`
    const bytes = sessionBytes(projectPath, id, 2)
    const dir = localSessionDir(home, projectPath, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, LOG_NAME), bytes)

    const entries = await collectLocalProbeEntries({ home, config: { projects: { p: { path: projectPath } } } })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, id)
    assert.equal(entries[0].project, 'p')
    assert.equal(entries[0].events, 2, 'число событий по кадрам лога')
    assert.equal(entries[0].sizeBytes, canonicalize(bytes, 'p').length, 'размер — как у копии в облаке')
  })
})

test('probeSecondaryChannel: бэкенд без lightProbe — reserve/unsupported и полная сверка', async () => {
  await withTempDir(async (root) => {
    const home = join(root, 'home')
    const result = await probeSecondaryChannel({
      home,
      config: { projects: {} },
      secondary: { backend: 'folder', repoDir: join(root, 'cache'), folderDir: join(root, 'cloud') },
      remote: { kind: 'folder', async sync() { return true }, async commit() { return { committed: false } } },
      local: [],
      writeStatus: false,
    })
    assert.equal(result.ok, false)
    assert.equal(result.skipped, true)
    assert.equal(result.code, RESERVE_CODES.unsupported)
    assert.match(result.message, /не поддерживает лёгкую сверку/)
    assert.match(result.message, /reserve\/unsupported/)
  })
})

test('probeSecondaryChannel: лёгкая сверка WebDAV — счётчики и статус для панели', async () => {
  await withTempDir(async (root) => {
    const home = join(root, 'home')
    const projectPath = join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    const id = `session-${randomUUID()}`
    const dir = localSessionDir(home, projectPath, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, LOG_NAME), sessionBytes(projectPath, id, 3))
    let received = null
    const remote = {
      kind: 'webdav',
      capabilities: { list: true, sync: true, commit: true, remove: true, lightProbe: true },
      async lightProbe(options) {
        received = options
        return {
          ok: true,
          code: RESERVE_CODES.ok,
          local: { count: options.local.length, ids: options.local.map(entry => entry.id) },
          cloud: { count: 0, ids: [], sizesKnown: true },
          onlyLocal: options.local.length,
          onlyCloud: 0,
          differ: 0,
          durationMs: 5,
        }
      },
    }
    const config = { projects: { p: { path: projectPath } } }
    const result = await probeSecondaryChannel({
      home,
      config,
      secondary: { backend: 'webdav', repoDir: join(root, 'cache'), webdavLogin: 'user', webdavPassword: 'app-pass' },
      remote,
    })
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'webdav')
    assert.equal(result.local.count, 1)
    assert.equal(result.onlyLocal, 1)
    assert.match(result.message, /лёгкая сверка/)
    assert.match(result.message, /локально 1/)
    assert.equal(received.local.length, 1)
    assert.equal(received.local[0].id, id)
    assert.equal(received.local[0].events, 3)
    assert.deepEqual(received.projects, ['p'])
    const status = await readSecondaryStatus(home)
    assert.equal(status.ok, true)
    assert.equal(status.code, RESERVE_CODES.ok)
    assert.match(status.message, /лёгкая сверка/)
  })
})

test('probeSecondaryChannel: ошибка сверки с кодом сохраняется, исключения нет', async () => {
  await withTempDir(async (root) => {
    const home = join(root, 'home')
    const remote = {
      kind: 'webdav',
      capabilities: { list: true, sync: true, commit: true, remove: true, lightProbe: true },
      async lightProbe() {
        const error = new Error('сеть недоступна')
        error.code = RESERVE_CODES.timeout
        throw error
      },
    }
    const result = await probeSecondaryChannel({
      home,
      config: { projects: {} },
      secondary: { backend: 'webdav', repoDir: join(root, 'cache') },
      remote,
      local: [],
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, RESERVE_CODES.timeout)
    assert.match(result.message, /лёгкая сверка резерва не удалась: сеть недоступна/)
    const status = await readSecondaryStatus(home)
    assert.equal(status.ok, false)
    assert.equal(status.code, RESERVE_CODES.timeout)
  })
})

test('probeSecondaryChannel: настоящий WebDAV-бэкенд — сверка без скачивания логов', async () => {
  const disk = fakeWebdav({ manifest: { version: 1, device: 'device-cloud', updatedAt: '2026-11-20T09:00:00.000Z', files: {} } })
  globalThis.fetch = disk.handler
  try {
    await withTempDir(async (root) => {
      const home = join(root, 'home')
      const projectPath = join(root, 'project')
      await mkdir(projectPath, { recursive: true })
      const id = `session-${randomUUID()}`
      const bytes = sessionBytes(projectPath, id, 3)
      const dir = localSessionDir(home, projectPath, id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, LOG_NAME), bytes)
      // В облаке — та же сессия после push: канонический лог с тем же хвостом.
      putCloudBytes(disk, { id, bytes: canonicalize(bytes, 'p') })
      const secondary = {
        enabled: true,
        backend: 'webdav',
        repoDir: join(root, 'cache'),
        webdavLogin: 'user',
        webdavPassword: 'app-pass',
        webdavPath: 'dsh-sync',
      }
      const result = await probeSecondaryChannel({
        home,
        config: { projects: { p: { path: projectPath } } },
        secondary,
        writeStatus: false,
      })
      assert.equal(result.ok, true)
      assert.equal(result.backend, 'webdav')
      assert.equal(result.local.count, 1)
      assert.equal(result.cloud.count, 1)
      assert.equal(result.onlyLocal, 0)
      assert.equal(result.onlyCloud, 0)
      assert.equal(result.differ, 0, 'id/events/sizeBytes совпадают')
      assert.equal(result.manifest.device, 'device-cloud')
      // Логи не скачивались: лёгкая сверка не должна тянуть блобы.
      assert.deepEqual(disk.calls.filter(call => call.method === 'GET' && call.path.includes('/sessions/')), [])
    })
  } finally {
    delete globalThis.fetch
  }
})

test('probeSecondaryChannel: резерв не настроен — понятный код', async () => {
  const result = await probeSecondaryChannel({ home: tmpdir(), config: { projects: {} }, secondary: undefined })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'secondary/not-configured')
})
