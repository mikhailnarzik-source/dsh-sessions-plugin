/**
 * M5: резервный канал — полная сверка.
 *
 * Проверяем требования П3–П7 по 12-задача-резерв-канал.md:
 * - П4: резюмируемое скачивание (`.part`, Range, пропуск готового, размер);
 * - П5: таймауты (файл 30 с, операция 15 мин), отмена, 8 потоков;
 * - П3: коды ошибок 401/403/timeout/tls/network/quota с файлом и подсказкой;
 * - П6: прогресс (файлы/байты/текущий файл) и статусы
 *   «не сверен / сверяется / сверен / ошибка»;
 * - П7: основная синхронизация не ждёт резерв;
 * - маршруты GET /secondary-init/status и POST /secondary-init/cancel;
 * - рендер полосы прогресса, статусов и кнопки «Отменить» (headless).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import {
  RESERVE_ERROR_CODES,
  SECONDARY_CONCURRENCY,
  SECONDARY_FILE_TIMEOUT_MS,
  SECONDARY_OPERATION_TIMEOUT_MS,
  classifyReserveError,
  createWebdavBackend,
  reserveError,
  reserveErrorHint,
} from '../lib/webdav.mjs'
import {
  cancelSecondaryInit,
  initializeSecondaryChannel,
  readSecondaryInitStatus,
  readSecondaryState,
  readSecondaryStatus,
  secondaryInitSnapshot,
} from '../lib/secondary-init.mjs'
import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { pullReplicated, pushReplicated, secondaryConfig } from '../lib/replica.mjs'
import { push } from '../lib/sync.mjs'
import { localSessionDir } from '../lib/store.mjs'

const WEBDAV_ROOT = '/dsh-sync'
const PROJECT = 'p'

// --- общие помощники --------------------------------------------------------

async function waitFor(predicate, timeoutMs = 4000, stepMs = 10) {
  const started = Date.now()
  for (;;) {
    const value = predicate()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() - started > timeoutMs) throw new Error('условие не наступило за отведённое время')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** Ответ, как у fetch: текст, размер и заголовки (WebDAV-мок). */
function responseLike({ status = 200, body = '', headers = {} } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name ?? '').toLowerCase()] ?? null },
    text: async () => buffer.toString('utf8'),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  }
}

/** PROPFIND-ответ: один уровень каталога `dirRel` по карте файлов облака. */
function propfindXml(dirRel, files) {
  const prefix = dirRel === '' ? '' : `${dirRel}/`
  const children = new Map()
  for (const [rel, value] of files) {
    if (!rel.startsWith(prefix)) continue
    const rest = rel.slice(prefix.length)
    if (rest === '') continue
    const slash = rest.indexOf('/')
    if (slash === -1) children.set(rest, { dir: false, size: Buffer.byteLength(Buffer.isBuffer(value) ? value : String(value)) })
    else children.set(rest.slice(0, slash), { dir: true, size: 0 })
  }
  const rows = []
  for (const [name, meta] of children) {
    const href = `${WEBDAV_ROOT}/${prefix}${name}`
    if (meta.dir) {
      rows.push(`<d:response><d:href>${href}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`)
    } else {
      rows.push(`<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${meta.size}</d:getcontentlength></d:prop></d:propstat></d:response>`)
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${rows.join('')}</d:multistatus>`
}

/**
 * Мок Яндекс.Диска по WebDAV.
 * @param files Map(rel → Buffer) — что лежит в облаке
 * @param options.beforeRequest({method, rel, init}) может вернуть свой ответ
 * @param options.onFile(rel, init, body) может вернуть свой ответ или Promise
 * @param options.respectRange true (по умолчанию) — отвечать 206 на Range
 */
function cloudFetch(files, options = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const pathname = decodeURIComponent(new URL(String(url)).pathname)
    const method = String(init.method ?? 'GET').toUpperCase()
    const rel = pathname === `${WEBDAV_ROOT}/`
      ? ''
      : pathname.startsWith(`${WEBDAV_ROOT}/`)
        ? pathname.slice(WEBDAV_ROOT.length + 1).replace(/\/+$/, '')
        : null
    if (rel === null) return responseLike({ status: 404 })
    calls.push({ method, rel, pathname, headers: init.headers ?? {}, signal: init.signal })
    if (typeof options.beforeRequest === 'function') {
      const override = await options.beforeRequest({ method, rel, init, pathname })
      if (override !== undefined) return override
    }
    if (method === 'PROPFIND') return responseLike({ status: 207, body: propfindXml(rel, files) })
    if (method !== 'GET') return responseLike({ status: 405 })
    const body = files.get(rel)
    if (body === undefined) return responseLike({ status: 404 })
    if (typeof options.onFile === 'function') {
      const override = await options.onFile(rel, init, body)
      if (override !== undefined) return override
    }
    const range = String(init.headers?.range ?? init.headers?.Range ?? '')
    const match = /^bytes=(\d+)-$/.exec(range)
    if (options.respectRange !== false && match !== null) {
      const start = Number(match[1])
      if (start >= body.length) return responseLike({ status: 416 })
      return responseLike({ status: 206, body: body.subarray(start) })
    }
    return responseLike({ status: 200, body })
  }
  return { calls, fetch: fetchImpl }
}

/** Подменить глобальный fetch на время теста. */
async function withCloud(files, options, run) {
  const cloud = cloudFetch(files, options)
  const previous = globalThis.fetch
  globalThis.fetch = cloud.fetch
  try {
    return await run(cloud)
  } finally {
    globalThis.fetch = previous
  }
}

function makeBackend(root, extra = {}) {
  return createWebdavBackend({
    backend: 'webdav',
    repoDir: join(root, 'replica-webdav'),
    webdavLogin: 'user',
    webdavPassword: 'app-password',
    webdavPath: 'dsh-sync',
    concurrency: 3,
    ...extra,
  }, { retryBaseMs: 1 })
}

/** Дождаться, пока висящий запрос будет прерван сигналом (для timeout/отмены). */
function hangUntilAbort(init) {
  return new Promise((resolve, reject) => {
    const signal = init?.signal
    const fail = () => reject(signal?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal?.aborted === true) {
      fail()
      return
    }
    signal?.addEventListener('abort', fail, { once: true })
  })
}

// --- П5: константы и коды ошибок -------------------------------------------

test('П5: таймауты файла/операции, потоки и контракт ошибок резерва', () => {
  assert.equal(SECONDARY_FILE_TIMEOUT_MS, 30_000, 'файл — 30 с')
  assert.equal(SECONDARY_OPERATION_TIMEOUT_MS, 15 * 60_000, 'операция — 15 мин')
  assert.equal(SECONDARY_CONCURRENCY, 8, 'максимум 8 файлов параллельно')

  const error = reserveError(RESERVE_ERROR_CODES.unauthorized, 'нет доступа', { file: 'sessions/p/s1/session.v4.jsonl.zstd' })
  assert.equal(error.code, '401')
  assert.equal(error.file, 'sessions/p/s1/session.v4.jsonl.zstd')
  assert.match(error.hint, /пароль приложения/i)

  const hints = new Map([
    ['401', /401|пароль приложения/i],
    ['403', /403|доступ/i],
    ['timeout', /30 с|15 мин/i],
    ['tls', /сертификат/i],
    ['network', /интернет/i],
    ['quota', /место/i],
  ])
  for (const [code, pattern] of hints) {
    const described = classifyReserveError(Object.assign(new Error('сбой'), { code }))
    assert.equal(described.code, code)
    assert.match(described.hint, pattern, `подсказка для кода ${code}`)
    assert.equal(typeof described.message, 'string')
    assert.equal(typeof described.file, 'string')
  }
  assert.match(reserveErrorHint('timeout'), /продолжится с места остановки/i)

  // Коды распознаются и по HTTP-статусу, и по тексту сетевого исключения.
  assert.equal(classifyReserveError(Object.assign(new Error('Яндекс.Диск (WebDAV): HTTP 401'), { status: 401 })).code, '401')
  assert.equal(classifyReserveError(Object.assign(new Error('Яндекс.Диск (WebDAV): HTTP 403'), { status: 403 })).code, '403')
  assert.equal(classifyReserveError(Object.assign(new Error('HTTP 507 Insufficient Storage'), { status: 507 })).code, 'quota')
  assert.equal(classifyReserveError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })).code, 'timeout')
  assert.equal(classifyReserveError(Object.assign(new TypeError('fetch failed'), {
    cause: new Error('schannel: certificate verify failed'),
  })).code, 'tls')
  assert.equal(classifyReserveError(Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  })).code, 'network')
})

// --- П4: резюмируемое скачивание -------------------------------------------

test('П4: .part докачивается через Range, готовый файл пропускается', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m5-resume-'))
  try {
    const repoDir = join(root, 'replica-webdav')
    const files = new Map([
      ['profile/a.json', Buffer.from('a'.repeat(100))],
      ['sessions/p/s1/session.v4.jsonl.zstd', Buffer.from('s'.repeat(50))],
    ])
    const backend = makeBackend(root)
    // Готовый файл уже лежит в кеше: его не качаем.
    await mkdir(join(repoDir, 'profile'), { recursive: true })
    await writeFile(join(repoDir, 'profile', 'a.json'), files.get('profile/a.json'))
    // Недокачанный: 20 из 50 байт в `.part`.
    const partPath = join(repoDir, 'sessions', 'p', 's1', 'session.v4.jsonl.zstd.part')
    await mkdir(join(repoDir, 'sessions', 'p', 's1'), { recursive: true })
    await writeFile(partPath, files.get('sessions/p/s1/session.v4.jsonl.zstd').subarray(0, 20))

    const progress = []
    await withCloud(files, {}, async (cloud) => {
      const result = await backend.sync({ onProgress: (snapshot) => progress.push({ ...snapshot }) })
      assert.equal(result.ok, true)
      assert.equal(result.totals.files, 2)
      assert.equal(result.totals.bytes, 150)
      assert.equal(result.totals.skipped, 1, 'готовый файл не перекачивали')
      assert.equal(result.totals.downloaded, 1)
      assert.equal(result.totals.resumed, 1, 'недокачанный файл продолжен с места остановки')

      const gets = cloud.calls.filter((call) => call.method === 'GET')
      assert.equal(gets.length, 1, 'запрос только за недокачанным файлом')
      assert.equal(gets[0].rel, 'sessions/p/s1/session.v4.jsonl.zstd')
      assert.equal(gets[0].headers.range, 'bytes=20-', 'докачка через Range')

      assert.deepEqual(await readFile(join(repoDir, 'sessions', 'p', 's1', 'session.v4.jsonl.zstd')), files.get('sessions/p/s1/session.v4.jsonl.zstd'))
      assert.equal(existsSync(partPath), false, '.part переименован после проверки размера')

      // Прогресс: N из M файлов, байты и текущий файл.
      assert.ok(progress.length > 0, 'прогресс отдавался')
      const withFile = progress.find((snapshot) => snapshot.filesTotal === 2 && snapshot.currentFile !== '')
      assert.ok(withFile, 'в прогрессе есть общее число файлов и текущий файл')
      assert.equal(withFile.bytesTotal, 150)
      assert.ok(progress.some((snapshot) => snapshot.bytesDone > 0), 'скачанные байты видны в прогрессе')
      assert.equal(progress.at(-1).percent, 100, 'финальный процент — 100')

      // Повторный запуск ничего не скачивает.
      cloud.calls.length = 0
      const again = await backend.sync()
      assert.equal(again.totals.downloaded, 0)
      assert.equal(again.totals.skipped, 2)
      assert.equal(cloud.calls.filter((call) => call.method === 'GET').length, 0, 'готовое не перекачивается')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('П4: недокачанный файл остаётся .part, следующий запуск продолжает', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m5-part-'))
  try {
    const repoDir = join(root, 'replica-webdav')
    const rel = 'profile/big.json'
    const files = new Map([[rel, Buffer.from('b'.repeat(60))]])
    const backend = makeBackend(root)
    const partPath = join(repoDir, 'profile', 'big.json.part')

    // Первый запуск: сервер отдал только 25 байт из 60 — размер не сошёлся.
    await withCloud(files, {
      onFile: async () => responseLike({ status: 200, body: files.get(rel).subarray(0, 25) }),
    }, async () => {
      await assert.rejects(backend.sync({ fileTimeoutMs: 500 }), (error) => {
        assert.equal(error.code, 'network')
        assert.equal(error.file, rel)
        assert.match(error.message, /скачано 25 из 60/)
        assert.ok(error.totals, 'в ошибке есть итоги для панели')
        return true
      })
    })
    assert.equal(existsSync(partPath), true, 'частичный файл остался как .part')
    assert.equal((await stat(partPath)).size, 25)
    assert.equal(existsSync(join(repoDir, 'profile', 'big.json')), false, 'недокачанный файл не считается готовым')

    // Второй запуск: Range отдаёт остаток, размер сходится — переименование.
    await withCloud(files, {}, async (cloud) => {
      const result = await backend.sync()
      assert.equal(result.ok, true)
      assert.equal(result.totals.resumed, 1)
      assert.equal(cloud.calls.find((call) => call.method === 'GET').headers.range, 'bytes=25-')
      assert.deepEqual(await readFile(join(repoDir, 'profile', 'big.json')), files.get(rel))
      assert.equal(existsSync(partPath), false)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- П5: таймауты и отмена --------------------------------------------------

test('П5: таймаут файла — код timeout, файл и совет повторить', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m5-file-timeout-'))
  try {
    const rel = 'sessions/p/s1/session.v4.jsonl.zstd'
    const files = new Map([[rel, Buffer.from('x'.repeat(40))]])
    const backend = makeBackend(root)
    await withCloud(files, { onFile: (relArg, init) => hangUntilAbort(init) }, async () => {
      await assert.rejects(backend.sync({ fileTimeoutMs: 60 }), (error) => {
        assert.equal(error.code, 'timeout')
        assert.equal(error.file, rel)
        assert.match(error.message, /не скачался за/i)
        assert.match(error.hint, /30 с|продолжится с места остановки/i)
        return true
      })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('П5: таймаут операции — 15-минутный бюджет прерывает скачивание', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m5-op-timeout-'))
  try {
    const files = new Map([
      ['profile/a.json', Buffer.from('a'.repeat(10))],
      ['profile/b.json', Buffer.from('b'.repeat(10))],
      ['profile/c.json', Buffer.from('c'.repeat(10))],
    ])
    const backend = makeBackend(root)
    await withCloud(files, { onFile: (rel, init) => hangUntilAbort(init) }, async () => {
      const started = Date.now()
      await assert.rejects(backend.sync({ operationTimeoutMs: 180, fileTimeoutMs: 10_000 }), (error) => {
        assert.equal(error.code, 'timeout')
        assert.match(error.message, /не уложилась/)
        assert.ok(error.totals, 'итоги сохраняются даже при таймауте операции')
        return true
      })
      assert.ok(Date.now() - started < 5000, 'операция не ждёт 15 минут в тесте')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- П3: ошибки полной сверки ----------------------------------------------

test('П3: 401/403/TLS/сеть/квота — код, файл, человеческий текст и действие', async () => {
  const rootFor = async () => mkdtemp(join(tmpdir(), 'dsh-m5-errors-'))
  const roots = []
  const make = async () => {
    const root = await rootFor()
    roots.push(root)
    return { root, backend: makeBackend(root) }
  }
  try {
    // 401 на листинге: не приняли пароль приложения.
    {
      const { backend } = await make()
      await withCloud(new Map(), {}, async () => {
        globalThis.fetch = async () => responseLike({ status: 401, body: 'Unauthorized' })
        await assert.rejects(backend.sync(), (error) => {
          assert.equal(error.code, '401')
          assert.match(error.hint, /пароль приложения/i)
          return true
        })
      })
    }
    // 403 на скачивании файла: доступ к папке резерва запрещён.
    {
      const { backend } = await make()
      const files = new Map([['profile/a.json', Buffer.from('a'.repeat(5))]])
      await withCloud(files, { onFile: async () => responseLike({ status: 403, body: 'Forbidden' }) }, async () => {
        await assert.rejects(backend.sync(), (error) => {
          assert.equal(error.code, '403')
          assert.equal(error.file, 'profile/a.json')
          assert.match(error.hint, /403|доступ/i)
          return true
        })
      })
    }
    // TLS-сбой: сертификат не проверен.
    {
      const { backend } = await make()
      const previous = globalThis.fetch
      globalThis.fetch = async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('schannel: certificate verify failed') })
      }
      try {
        await assert.rejects(backend.sync(), (error) => {
          assert.equal(error.code, 'tls')
          assert.match(error.hint, /сертификат/i)
          return true
        })
      } finally {
        globalThis.fetch = previous
      }
    }
    // Сеть: соединение сброшено.
    {
      const { backend } = await make()
      const previous = globalThis.fetch
      globalThis.fetch = async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        })
      }
      try {
        await assert.rejects(backend.sync(), (error) => {
          assert.equal(error.code, 'network')
          assert.match(error.hint, /интернет|продолжится/i)
          return true
        })
      } finally {
        globalThis.fetch = previous
      }
    }
    // Квота: сервер ответил 507.
    {
      const { backend } = await make()
      const previous = globalThis.fetch
      globalThis.fetch = async () => responseLike({ status: 507, body: 'Insufficient Storage' })
      try {
        await assert.rejects(backend.sync(), (error) => {
          assert.equal(error.code, 'quota')
          assert.match(error.hint, /место/i)
          return true
        })
      } finally {
        globalThis.fetch = previous
      }
    }
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true })
  }
})

// --- П6: прогресс, статус и totals полной сверки ---------------------------

function makeHostConfig({ root, home, secondaryRepoDir }) {
  const projectPath = join(root, 'project')
  return {
    ...defaultConfig(home),
    backend: 'folder',
    deviceId: `device-${randomUUID()}`,
    repoDir: join(root, 'mirror'),
    attachments: false,
    profile: { enabled: false },
    workspace: { enabled: false },
    autoSync: { enabled: false },
    sync: { autoPrune: false },
    projects: { [PROJECT]: { path: projectPath, title: PROJECT } },
    secondary: {
      enabled: true,
      backend: 'webdav',
      repoDir: secondaryRepoDir,
      webdavLogin: 'user',
      webdavPassword: 'app-password',
      webdavPath: 'dsh-sync',
      concurrency: 3,
    },
  }
}

function sessionBytes(projectPath, id, seq = 0) {
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: projectPath, isSeeded: false, delegationDepth: 0 }
  return Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ seq, text: `событие ${seq}` })}\n`)),
  ])
}

async function writeLocalSession(home, projectPath, id) {
  const dir = localSessionDir(home, projectPath, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), sessionBytes(projectPath, id))
  return dir
}

async function makeInitEnv() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m5-init-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  await mkdir(join(root, 'project'), { recursive: true })
  const config = makeHostConfig({ root, home, secondaryRepoDir: join(root, 'replica-webdav') })
  await saveConfig(home, config)
  return { root, home, config, secondary: secondaryConfig(config) }
}

test('П6: полная сверка — живой прогресс, totals и статус «сверен»', async () => {
  const env = await makeInitEnv()
  try {
    const files = new Map([
      ['profile/a.json', Buffer.from('a'.repeat(40))],
      ['profile/b.json', Buffer.from('b'.repeat(80))],
      ['profile/c.json', Buffer.from('c'.repeat(120))],
    ])
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const snapshots = []
    await withCloud(files, {
      onFile: async (rel) => {
        if (rel === 'profile/b.json') await gate
      },
    }, async () => {
      const init = initializeSecondaryChannel({
        home: env.home,
        config: env.config,
        secondary: env.secondary,
        dshVersion: '0.0.0-test',
        onProgress: (snapshot) => snapshots.push({ ...snapshot }),
      })
      try {
        const running = await waitFor(() => {
          const snapshot = secondaryInitSnapshot()
          return snapshot.running === true && snapshot.progress.currentFile !== '' ? snapshot : null
        })
        assert.equal(running.running, true)
        assert.equal(running.cancelRequested, false)
        assert.equal(running.progress.filesTotal, 3, 'в прогрессе M файлов')
        assert.equal(running.progress.bytesTotal, 240, 'в прогрессе Y байт')
        assert.notEqual(running.progress.currentFile, '')
        assert.equal(typeof running.progress.percent, 'number')

        // GET-статус во время работы: «сверяется», прогресс и отмена.
        const status = await readSecondaryInitStatus({ home: env.home, secondary: env.secondary })
        assert.equal(status.ok, true)
        assert.equal(status.state, 'comparing')
        assert.equal(status.label, 'сверяется')
        assert.equal(status.running, true)
        assert.equal(status.progress.filesTotal, 3)
        assert.equal(status.backend, 'webdav')
      } finally {
        release()
      }
      const result = await init
      assert.equal(result.ok, true, `сверка должна пройти: ${result.message ?? ''}`)
      assert.equal(result.initialized, true)
      assert.equal(result.code, 'secondary/initialized')
      assert.equal(result.totals.files, 3)
      assert.equal(result.totals.bytes, 240)
      assert.equal(result.totals.downloaded, 3)
      assert.equal(result.totals.failed, 0)
      assert.equal(result.progress.percent, 100)
    })

    // Файлы лежат в каталоге кеша резерва (он создан сразу).
    assert.equal(existsSync(join(env.secondary.repoDir, 'profile', 'a.json')), true)
    assert.equal(existsSync(join(env.secondary.repoDir, 'profile', 'c.json')), true)

    // Прогресс отдавался по ходу: файлы, байты, текущий файл, фазы.
    assert.ok(snapshots.some((snapshot) => snapshot.filesTotal === 3 && snapshot.currentFile !== ''), 'текущий файл в прогрессе')
    assert.ok(snapshots.some((snapshot) => snapshot.bytesDone > 0 && snapshot.percent > 0), 'процент растёт')
    assert.ok(snapshots.some((snapshot) => snapshot.phase === 'done'), 'финальная фаза — «готово»')

    // Сохранённый итог и состояние.
    const status = await readSecondaryStatus(env.home)
    assert.equal(status.ok, true)
    assert.equal(status.code, 'secondary/initialized')
    assert.equal(status.scope, 'secondary-init')
    assert.equal(status.running, false)
    assert.equal(status.totals.files, 3)
    assert.equal(status.totals.bytes, 240)
    const state = await readSecondaryState(env.home)
    assert.equal(state.initialized, true)
    assert.equal(state.files, 3)
    assert.equal(state.bytes, 240)
    const summary = await readSecondaryInitStatus({ home: env.home, secondary: env.secondary })
    assert.equal(summary.state, 'compared')
    assert.equal(summary.label, 'сверен')
    assert.equal(summary.initialized, true)
    assert.equal(summary.totals.files, 3)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('П5: «Отменить» останавливает сверку, статус — «не сверен»', async () => {
  const env = await makeInitEnv()
  try {
    const files = new Map([
      ['sessions/p/s1/session.v4.jsonl.zstd', Buffer.from('s'.repeat(60))],
      ['sessions/p/s2/session.v4.jsonl.zstd', Buffer.from('t'.repeat(60))],
    ])
    await withCloud(files, { onFile: (rel, init) => hangUntilAbort(init) }, async () => {
      let result
      let init
      try {
        init = initializeSecondaryChannel({
          home: env.home,
          config: env.config,
          secondary: env.secondary,
          dshVersion: '0.0.0-test',
        })
        await waitFor(() => {
          const snapshot = secondaryInitSnapshot()
          return snapshot.running === true && snapshot.progress.currentFile !== '' ? snapshot : null
        })
        const cancel = cancelSecondaryInit('тест: кнопка «Отменить»')
        assert.equal(cancel.ok, true)
        assert.match(cancel.message, /уже скачанное останется/)
        result = await init
      } finally {
        // Если проверка упала до отмены — не оставляем висящую сверку.
        cancelSecondaryInit()
        if (init !== undefined && result === undefined) await init.catch(() => {})
      }
      assert.equal(result.ok, false)
      assert.equal(result.cancelled, true)
      assert.equal(result.code, RESERVE_ERROR_CODES.cancelled)
      assert.match(result.message, /отменена/)
      assert.match(result.hint, /продолжится с места остановки/i)
      assert.equal(result.initialized, false)
    })
    assert.equal(secondaryInitSnapshot().running, false, 'сверка больше не идёт')
    const status = await readSecondaryStatus(env.home)
    assert.equal(status.running, false)
    assert.equal(status.cancelled, true)
    const summary = await readSecondaryInitStatus({ home: env.home, secondary: env.secondary })
    assert.equal(summary.running, false)
    assert.equal(summary.state, 'not-compared', 'отменённая сверка не «ошибка»')
    assert.equal(summary.label, 'не сверен')

    // Отменять нечего — понятный ответ, а не падение.
    const again = cancelSecondaryInit()
    assert.equal(again.ok, false)
    assert.equal(again.code, 'secondary/not-running')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- маршруты host-части ----------------------------------------------------

async function bootPlugin({ home }) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { apply } = await import('../index.js')
  const routes = new Map()
  const cleanups = []
  const ctx = {
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    tools: { register: () => {} },
    get: (name) => (name === 'sessionPersistence' ? { list: async () => [] } : undefined),
  }
  apply(ctx)
  return {
    routes,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          // таймеры уже сняты
        }
      }
    },
    restoreHome: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

async function callRoute(routes, path, { method = 'POST', payload } = {}) {
  const route = routes.get(path)
  assert.ok(route, `маршрут ${path} зарегистрирован`)
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (method !== 'GET') init.body = JSON.stringify(payload ?? {})
  const response = await route.fetch(new Request(`http://local${path}`, init))
  return { status: response.status, body: await response.json() }
}

test('маршруты: GET /secondary-init/status и POST /secondary-init/cancel', async () => {
  const env = await makeInitEnv()
  const files = new Map([
    ['sessions/p/s1/session.v4.jsonl.zstd', Buffer.from('s'.repeat(60))],
    ['sessions/p/s2/session.v4.jsonl.zstd', Buffer.from('t'.repeat(60))],
  ])
  await withCloud(files, { onFile: (rel, init) => hangUntilAbort(init) }, async (cloud) => {
    const previousFetch = globalThis.fetch
    // Маршруты обновления тоже ходят в сеть: отдаём 404, кроме WebDAV-мока.
    globalThis.fetch = async (url, init) => {
      const href = String(url)
      if (href.startsWith('https://webdav.yandex.ru')) return cloud.fetch(url, init)
      return responseLike({ status: 404 })
    }
    let boot
    try {
      boot = await bootPlugin({ home: env.home })
      for (const path of [
        '/api/dsh-sync/secondary-init',
        '/api/dsh-sync/secondary-init/status',
        '/api/dsh-sync/secondary-init/cancel',
        '/api/dsh-sync/secondary-probe',
      ]) {
        assert.ok(boot.routes.has(path), `маршрут ${path} зарегистрирован`)
      }

      // До сверки: «не сверен», прогресса нет.
      const initial = await callRoute(boot.routes, '/api/dsh-sync/secondary-init/status', { method: 'GET' })
      assert.equal(initial.status, 200)
      assert.equal(initial.body.ok, true)
      assert.equal(initial.body.state, 'not-compared')
      assert.equal(initial.body.label, 'не сверен')
      assert.equal(initial.body.running, false)
      assert.equal(initial.body.progress, null)

      // Отмена без запущенной сверки — понятный ответ.
      const idleCancel = await callRoute(boot.routes, '/api/dsh-sync/secondary-init/cancel')
      assert.equal(idleCancel.status, 200)
      assert.equal(idleCancel.body.ok, false)
      assert.equal(idleCancel.body.code, 'secondary/not-running')

      // Запускаем сверку и смотрим статус снаружи, пока она идёт.
      let init
      let result
      try {
        init = initializeSecondaryChannel({
          home: env.home,
          config: env.config,
          secondary: env.secondary,
          dshVersion: '0.0.0-test',
        })
        await waitFor(() => {
          const snapshot = secondaryInitSnapshot()
          return snapshot.running === true && snapshot.progress.currentFile !== '' ? snapshot : null
        })
        const during = await callRoute(boot.routes, '/api/dsh-sync/secondary-init/status', { method: 'GET' })
        assert.equal(during.body.state, 'comparing')
        assert.equal(during.body.label, 'сверяется')
        assert.equal(during.body.running, true)
        assert.equal(during.body.progress.filesTotal, 2)
        assert.notEqual(during.body.progress.currentFile, '')

        // Кнопка «Отменить» — отдельный POST-маршрут.
        const cancelled = await callRoute(boot.routes, '/api/dsh-sync/secondary-init/cancel')
        assert.equal(cancelled.body.ok, true)
        assert.match(cancelled.body.message, /отмена запрошена/)
        result = await init
      } finally {
        cancelSecondaryInit()
        if (init !== undefined && result === undefined) await init.catch(() => {})
      }
      assert.equal(result.cancelled, true)

      const after = await callRoute(boot.routes, '/api/dsh-sync/secondary-init/status', { method: 'GET' })
      assert.equal(after.body.running, false)
      assert.equal(after.body.state, 'not-compared')
    } finally {
      globalThis.fetch = previousFetch
      boot?.dispose()
      boot?.restoreHome()
    }
  })
  await rm(env.root, { recursive: true, force: true })
})

// --- старая кнопка POST /secondary-init: результат с totals -----------------

test('host: POST /secondary-init возвращает totals, статус — «сверен»', async () => {
  const env = await makeInitEnv()
  const files = new Map([
    ['profile/a.json', Buffer.from('a'.repeat(40))],
    ['profile/b.json', Buffer.from('b'.repeat(80))],
  ])
  await withCloud(files, {}, async (cloud) => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const href = String(url)
      if (href.startsWith('https://webdav.yandex.ru')) return cloud.fetch(url, init)
      return responseLike({ status: 404 })
    }
    let boot
    try {
      boot = await bootPlugin({ home: env.home })
      const { status, body } = await callRoute(boot.routes, '/api/dsh-sync/secondary-init', { payload: {} })
      assert.equal(status, 200, `маршрут не упал: ${body?.message ?? ''}`)
      assert.equal(body.ok, true, `полная сверка прошла: ${body.message ?? ''}`)
      assert.equal(body.initialized, true)
      assert.equal(body.code, 'secondary/initialized')
      assert.equal(typeof body.totals, 'object', 'старая кнопка теперь возвращает totals')
      assert.equal(body.totals.files, 2)
      assert.equal(body.totals.bytes, 120)
      assert.equal(body.totals.downloaded, 2)
      assert.match(body.message, /резерв сверен/)
      assert.equal(typeof body.hint, 'string')

      const summary = await callRoute(boot.routes, '/api/dsh-sync/secondary-init/status', { method: 'GET' })
      assert.equal(summary.body.state, 'compared')
      assert.equal(summary.body.label, 'сверен')
      assert.equal(summary.body.totals.files, 2)
    } finally {
      globalThis.fetch = previousFetch
      boot?.dispose()
      boot?.restoreHome()
    }
  })
  await rm(env.root, { recursive: true, force: true })
})

// --- П7: основная синхронизация не ждёт резерв -----------------------------

test('П7: резерв не блокирует основную синхронизацию, его сбой её не валит', async () => {
  const env = await makeInitEnv()
  try {
    const id = `session-${randomUUID()}`
    await writeLocalSession(env.home, join(env.root, 'project'), id)
    const files = new Map([
      ['sessions/p/s1/session.v4.jsonl.zstd', Buffer.from('s'.repeat(60))],
    ])
    await withCloud(files, { onFile: (rel, init) => hangUntilAbort(init) }, async () => {
      // Резерв «висит» на скачивании: основная синхронизация не должна его ждать.
      let init
      try {
        init = initializeSecondaryChannel({
          home: env.home,
          config: env.config,
          secondary: env.secondary,
          dshVersion: '0.0.0-test',
        })
        await waitFor(() => {
          const snapshot = secondaryInitSnapshot()
          return snapshot.running === true && snapshot.progress.currentFile !== '' ? snapshot : null
        })
        const started = Date.now()
        const summary = await push({ home: env.home, config: env.config })
        assert.ok(summary.pushed >= 1, 'основная синхронизация отправила сессию')
        assert.ok(Date.now() - started < 10_000)
        assert.equal(secondaryInitSnapshot().running, true, 'резерв всё ещё качается — основная его не ждала')
        assert.equal(existsSync(join(env.config.repoDir, 'sessions', PROJECT, id, 'session.v4.jsonl.zstd')), true)

        cancelSecondaryInit()
        const result = await init
        assert.equal(result.cancelled, true)
      } finally {
        cancelSecondaryInit()
        if (init !== undefined) await init.catch(() => {})
      }
    })

    // Сбойное резервное хранилище (папка — это файл) не валит push/pull.
    const secondId = `session-${randomUUID()}`
    await writeLocalSession(env.home, join(env.root, 'project'), secondId)
    const brokenCloud = join(env.root, 'not-a-folder')
    await writeFile(brokenCloud, 'это файл, а не папка')
    const brokenConfig = {
      ...env.config,
      secondary: { enabled: true, backend: 'folder', repoDir: join(env.root, 'replica-folder'), folderDir: brokenCloud },
    }
    const summary = await pushReplicated({ home: env.home, config: brokenConfig })
    assert.ok(summary.pushed >= 1, 'основная синхронизация отработала при сбойном резерве')
    assert.ok(summary.secondaryBlocked !== undefined || summary.secondaryError !== undefined, 'резерв либо пропущен, либо с ошибкой — не исключение')
    const pulled = await pullReplicated({ home: env.home, config: brokenConfig })
    assert.equal(typeof pulled, 'object', 'приём из основного работает при сбойном резерве')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- рендер карточки (headless) ---------------------------------------------

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let clientModule = null

/** Загрузить client.js в поддельном окне, как в client-render.test.mjs. */
function loadClientModule() {
  if (clientModule !== null) return clientModule
  const styles = []
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  globalThis.document = {
    documentElement: { style: {}, dataset: {} },
    body: {},
    createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
    head: { appendChild: (node) => { styles.push(node.textContent) } },
  }
  // eslint-disable-next-line no-new-func
  new Function(clientSource)()
  assert.equal(loaded?.id, 'dsh-sessions')
  const React = {
    Component: class Component {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        this.state = { ...this.state, ...next }
      }
    },
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useReducer: (reducer, initial) => [initial, () => {}],
  }
  const dictionaries = {}
  const registrations = []
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`неожиданный require: ${id}`)
  }
  const ctx = {
    effect: (fn) => { fn() },
    locale: {
      bind: (ns) => (key) => dictionaries[ns]?.ru?.[key] ?? key,
      subscribe: () => () => {},
      register: (ns, localeOrDict, maybeDict) => { dictionaries[ns] = maybeDict ?? localeOrDict },
    },
    slots: {
      inject: (name, register) => { register() },
      register: (options, component) => { registrations.push({ options, component }) },
    },
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => responseLike({ status: 404, body: '{}' })
  try {
    const exported = loaded.factory(requireStub)
    exported.apply(ctx)
    clientModule = { exported, registrations, styles }
  } finally {
    globalThis.fetch = previousFetch
  }
  return clientModule
}

function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

function textOf(node) {
  const parts = []
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return
    if (Array.isArray(value)) {
      for (const child of value) push(child)
      return
    }
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value))
      return
    }
    if (value.children !== undefined) push(value.children)
  }
  push(node)
  return parts.join(' ')
}

function classNameOf(node) {
  return typeof node?.props?.className === 'string' ? node.props.className : ''
}

test('П6/П7: рендер полосы прогресса, статусов и кнопки «Отменить»', () => {
  const { exported, styles } = loadClientModule()
  const ReserveProgress = exported.__test.ReserveProgress
  assert.equal(typeof ReserveProgress, 'function')

  let cancelled = 0
  const running = ReserveProgress({
    init: {
      running: true,
      cancelRequested: false,
      progress: {
        phase: 'download',
        filesTotal: 10,
        filesDone: 3,
        filesProcessed: 3,
        bytesTotal: 5 * 1024 * 1024,
        bytesDone: 1.5 * 1024 * 1024,
        currentFile: 'sessions/p/s1/session.v4.jsonl.zstd',
        percent: 30,
      },
    },
    status: null,
    busy: true,
    onCancel: () => { cancelled += 1 },
  })
  const runningText = textOf(running)
  assert.match(runningText, /3 из 10 файлов/, 'N из M файлов')
  assert.match(runningText, /1,5 МБ из 5,0 МБ/, 'X из Y МБ')
  assert.match(runningText, /30%/)
  assert.match(runningText, /сейчас: .*session\.v4\.jsonl\.zstd/, 'текущий файл')
  assert.match(runningText, /скачиваем файлы/, 'фаза операции')
  assert.equal(classNameOf(running), 'dshs-reserve-progress')
  assert.equal(running.props['data-state'], 'running')

  const bar = flatten(running).find((node) => node?.props?.role === 'progressbar')
  assert.ok(bar, 'полоса progressbar')
  assert.equal(bar.props['aria-valuenow'], '30')
  assert.ok(flatten(running).some((node) => classNameOf(node) === 'dshs-reserve-progress-fill'), 'заливка полосы')

  const cancelButton = flatten(running).find((node) => node?.type === 'button' && textOf(node).trim() === 'Отменить')
  assert.ok(cancelButton, 'кнопка «Отменить» рядом с полосой')
  cancelButton.props.onClick()
  assert.equal(cancelled, 1, 'нажатие зовёт отмену')

  // Завершённая сверка: отчёт «скачано/пропущено» и статус «сверен».
  const done = ReserveProgress({
    init: null,
    status: {
      ok: true,
      scope: 'secondary-init',
      totals: { files: 10, bytes: 5 * 1024 * 1024, downloaded: 2, skipped: 8, failed: 0 },
      message: 'резерв сверен',
    },
    busy: false,
  })
  const doneText = textOf(done)
  assert.match(doneText, /скачано: 2/)
  assert.match(doneText, /пропущено: 8/)
  assert.match(doneText, /10 из 10 файлов/)
  assert.equal(flatten(done).some((node) => node?.type === 'button'), false, 'после завершения кнопки отмены нет')

  // Ошибка: код, файл и что делать.
  const failed = ReserveProgress({
    init: null,
    status: {
      ok: false,
      scope: 'secondary-init',
      code: 'timeout',
      file: 'sessions/p/s1/session.v4.jsonl.zstd',
      message: 'файл не скачался за 30 с',
      hint: 'Повторите — скачивание продолжится с места остановки.',
    },
    busy: false,
  })
  const failedText = textOf(failed)
  assert.match(failedText, /Файл: sessions\/p\/s1\/session\.v4\.jsonl\.zstd/)
  assert.match(failedText, /продолжится с места остановки/)
  assert.equal(failed.props['data-state'], 'error')
  const empty = ReserveProgress({ init: null, status: undefined, busy: false })
  assert.equal(empty, null, 'без данных блока прогресса нет')

  // Статусы бейджа: не сверен / сверяется / сверен / ошибка.
  const status = exported.__test.reserveStatusOf
  assert.equal(status({ activeBackend: 'webdav', secondary: { initialized: false } }).label, 'не сверен')
  assert.equal(status({ activeBackend: 'webdav', secondary: { initialized: true } }).label, 'сверен')
  assert.equal(status({
    activeBackend: 'webdav',
    secondary: { initialized: false, status: { ok: false, code: '401', message: 'нет доступа' } },
  }).label, 'ошибка')
  const comparing = status({
    activeBackend: 'webdav',
    secondary: { initialized: false },
    init: { running: true, progress: { filesDone: 2, filesTotal: 10 } },
  })
  assert.equal(comparing.label, 'сверяется')
  assert.match(comparing.hint, /2 из 10 файлов/)
  // Отмена — не ошибка: резерв снова «не сверен».
  assert.equal(status({
    activeBackend: 'webdav',
    secondary: { initialized: false, status: { ok: false, code: 'cancelled', cancelled: true, message: 'сверка отменена' } },
  }).label, 'не сверен')
  // Живой прогресс приходит и в сохранённом статусе (running).
  assert.equal(status({
    activeBackend: 'webdav',
    secondary: { initialized: false, status: { ok: true, running: true, progress: { filesDone: 1, filesTotal: 4 } } },
  }).label, 'сверяется')

  // Человеческие тексты для новых кодов ошибок.
  const errorText = exported.__test.reserveErrorText
  assert.match(errorText({ ok: false, code: 'timeout', file: 'profile/a.json' }), /30 с|15 мин/)
  assert.match(errorText({ ok: false, code: 'timeout', file: 'profile/a.json' }), /Файл: profile\/a\.json/)
  assert.match(errorText({ ok: false, code: 'quota', message: 'HTTP 507' }), /место/i)
  assert.match(errorText({ ok: false, code: 'cancelled' }), /отменена/i)
  assert.match(errorText({ ok: false, code: 'network', message: 'fetch failed' }), /интернет/i)

  // Стили полосы прогресса и адаптив на месте.
  const css = styles.join('\n')
  for (const marker of ['.dshs-reserve-progress{', '.dshs-reserve-progress-fill{', '.dshs-reserve-progress-actions{']) {
    assert.ok(css.includes(marker), `стиль ${marker} есть`)
  }
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/)
  assert.match(css, /@media \(max-width:480px\)/)
})
