/**
 * M9-A: кэш метаданных зеркала и единый снапшот `/state` + `/sessions`.
 *
 * Что проверяем:
 * - lib/store.mjs: заголовок лога читается префиксом, кэш по (path, mtime, size),
 *   повторный список логи не перечитывает, изменение лога обновляет одну запись,
 *   кэш ограничен по размеру, `session.bytes` читаются лениво;
 * - lib/state-snapshot.mjs: single-flight, TTL, инвалидация по подписи,
 *   invalidate() и устойчивость к ошибке сборки;
 * - index.js: `/state` и `/sessions` собираются ОДИН раз (общий снапшот),
 *   повторный опрос не читает логи, изменение логов/ledger видно сразу,
 *   формат ответов прежний, клиент рисует страницу на реальном ответе.
 *
 * Запуск: node --import ./test/setup.mjs --test test/state-cache.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import {
  MIRROR_CACHE_LIMIT,
  clearMirrorCache,
  setMirrorCacheLimit,
  listMirrorSessions,
  listMirrorSessionsCached,
  localSessionDir,
  resetStoreStats,
  storeStats,
} from '../lib/store.mjs'
import { createStateSnapshot, fileSignature } from '../lib/state-snapshot.mjs'
import { apply, stateSnapshotStats } from '../index.js'

const LOG_NAME = 'session.v4.jsonl.zstd'
const PROJECT = 'alpha'
const PROJECT_PATH = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
const CREATED_AT = Date.UTC(2026, 10, 20, 10, 0, 0)

// --- помощники логов и окружения ------------------------------------------

function frameOf(event) {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))
}

function headerFor(id, options = {}) {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: CREATED_AT,
    cwd: PROJECT_PATH,
    isSeeded: false,
    delegationDepth: options.parent === undefined ? 0 : 1,
  }
  if (options.parent !== undefined) header.parentSession = options.parent
  return header
}

function makeLog(header, events = []) {
  return Buffer.concat([frameOf(header), ...events.map(frameOf)])
}

/** Лог зеркала; `bytes` — объём «событий» после заголовка (несжимаемый текст). */
function makeMirrorLog(id, options = {}) {
  const events = [{ type: 'session/title', seq: 0, time: CREATED_AT, data: { title: `Зеркало ${id.slice(-4)}` } }]
  const size = options.bytes ?? 0
  if (size > 0) {
    const chunks = []
    while (chunks.length * 32 < size) chunks.push(randomUUID())
    events.push({
      type: 'user/message',
      seq: 1,
      time: CREATED_AT + 1000,
      data: { content: [{ type: 'text', text: chunks.join('').slice(0, size) }] },
    })
  }
  return makeLog(headerFor(id, options), events)
}

/** Временный DSH_HOME + зеркало: локальные сессии и сессии облака. */
async function makeEnvironment(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-state-cache-'))
  const home = join(root, 'home')
  const repoDir = join(root, 'mirror')
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  await mkdir(join(repoDir, 'sessions', PROJECT), { recursive: true })
  const config = {
    ...defaultConfig(home),
    backend: 'folder',
    deviceId: 'device-state-cache',
    repoDir,
    attachments: false,
    profile: { enabled: false },
    workspace: { enabled: false },
    autoSync: { enabled: false },
  }
  config.projects = { [PROJECT]: { path: PROJECT_PATH, title: PROJECT } }
  await saveConfig(home, config)

  const snapshots = []
  const localIds = []
  for (let index = 0; index < (options.local ?? 1); index += 1) {
    const id = `session-${randomUUID()}`
    localIds.push(id)
    const dir = localSessionDir(home, PROJECT_PATH, id)
    await mkdir(dir, { recursive: true })
    const path = join(dir, LOG_NAME)
    await writeFile(path, makeLog(headerFor(id), [{
      type: 'session/title',
      seq: 0,
      time: CREATED_AT,
      data: { title: `Сессия ${index + 1}` },
    }]))
    snapshots.push({ header: headerFor(id), location: { path }, title: `Сессия ${index + 1}`, sizeBytes: 64 })
  }

  let mirrorBytes = 0
  const mirrorIds = []
  for (let index = 0; index < (options.mirror ?? 2); index += 1) {
    const id = `session-${randomUUID()}`
    mirrorIds.push(id)
    const dir = join(repoDir, 'sessions', PROJECT, id)
    await mkdir(dir, { recursive: true })
    const bytes = makeMirrorLog(id, { bytes: options.mirrorLogBytes ?? 0 })
    mirrorBytes += bytes.length
    await writeFile(join(dir, LOG_NAME), bytes)
  }

  return {
    root,
    home,
    repoDir,
    config,
    snapshots,
    localIds,
    mirrorIds,
    mirrorBytes,
    persistence: { list: async () => snapshots },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** Добавить сессию в зеркало (имитация приёма из облака другим процессом). */
async function addMirrorSession(env, options = {}) {
  const id = `session-${randomUUID()}`
  const dir = join(env.repoDir, 'sessions', PROJECT, id)
  await mkdir(dir, { recursive: true })
  const bytes = makeMirrorLog(id, options)
  await writeFile(join(dir, LOG_NAME), bytes)
  return { id, bytes }
}

/** Host-часть плагина с временным DSH_HOME (как в m2-ui.test.mjs). */
async function bootPlugin({ home, persistence, ttlMs }) {
  const previous = {
    home: process.env.DSH_HOME,
    ttl: process.env.DSH_SYNC_STATE_SNAPSHOT_TTL_MS,
  }
  process.env.DSH_HOME = home
  if (ttlMs === undefined) delete process.env.DSH_SYNC_STATE_SNAPSHOT_TTL_MS
  else process.env.DSH_SYNC_STATE_SNAPSHOT_TTL_MS = String(ttlMs)

  const routes = new Map()
  const cleanups = []
  const ctx = {
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    tools: { register: () => {} },
    get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
  }
  apply(ctx)

  const call = async (path, payload) => {
    const response = await routes.get(path).fetch(new Request(`http://local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }))
    return { status: response.status, body: await response.json() }
  }

  return {
    routes,
    call,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          // маршруты уже сняты
        }
      }
      if (previous.home === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous.home
      if (previous.ttl === undefined) delete process.env.DSH_SYNC_STATE_SNAPSHOT_TTL_MS
      else process.env.DSH_SYNC_STATE_SNAPSHOT_TTL_MS = previous.ttl
    },
  }
}

// --- 1. lib/state-snapshot.mjs --------------------------------------------

test('снапшот: N одновременных вызовов = один расчёт (single-flight)', async () => {
  let release
  let collects = 0
  const snapshot = createStateSnapshot({
    collect: async () => {
      collects += 1
      const number = collects
      await new Promise((resolve) => { release = resolve })
      return { number }
    },
    signature: async () => 'stable',
    ttlMs: 60_000,
    now: () => 1_000,
  })

  const pending = [snapshot.get(), snapshot.get(), snapshot.get(), snapshot.get()]
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const views = await Promise.all(pending)

  assert.equal(collects, 1, 'сборка выполнена один раз')
  assert.equal(views.length, 4)
  for (const view of views) {
    assert.equal(view.value.number, 1, 'все вызовы получили один и тот же сбор')
    assert.equal(view.at, 1_000, 'at — время сборки')
  }
  const stats = snapshot.stats()
  assert.equal(stats.collects, 1)
  assert.equal(stats.waits, 3, 'три вызова дождались чужого расчёта')
})

test('снапшот: TTL, подпись (mtime) и invalidate', async () => {
  let clock = 1_000
  let signatureValue = 'logs:v1'
  let collects = 0
  const snapshot = createStateSnapshot({
    collect: async () => {
      collects += 1
      return { number: collects }
    },
    signature: async () => signatureValue,
    ttlMs: 5_000,
    now: () => clock,
  })

  // Первый вызов собирает состояние.
  assert.equal((await snapshot.get()).value.number, 1)
  // В пределах TTL и без изменений — из снапшота, без сборки.
  clock += 1_000
  assert.equal((await snapshot.get()).value.number, 1)
  assert.equal(snapshot.stats().hits, 1)
  // Лог/ledger изменился (подпись) — пересчёт, не дожидаясь TTL.
  signatureValue = 'logs:v2'
  assert.equal((await snapshot.get()).value.number, 2)
  // Изменений нет, но TTL истёк — пересчёт как гарантия свежести.
  clock += 5_001
  assert.equal((await snapshot.get()).value.number, 3)
  // Явная инвалидация после операции — пересчёт сразу.
  snapshot.invalidate('session-mode')
  assert.equal((await snapshot.get()).value.number, 4)
  const stats = snapshot.stats()
  assert.equal(stats.collects, 4)
  assert.equal(stats.invalidations, 1)
  assert.equal(stats.lastInvalidationReason, 'session-mode')
})

test('снапшот: invalidate во время расчёта не сохраняет устаревшее значение', async () => {
  let release
  let collects = 0
  const snapshot = createStateSnapshot({
    collect: async () => {
      collects += 1
      const number = collects
      if (number === 1) await new Promise((resolve) => { release = resolve })
      return { number }
    },
    signature: async () => 'stable',
    ttlMs: 60_000,
    now: () => Date.now(),
  })

  const first = snapshot.get()
  await new Promise((resolve) => setImmediate(resolve))
  snapshot.invalidate('operation')
  release()
  assert.equal((await first).value.number, 1, 'вызвавший получил свой расчёт')
  assert.equal(snapshot.peek(), undefined, 'устаревший расчёт в кэш не попал')

  const second = await snapshot.get()
  assert.equal(second.value.number, 2, 'следующий вызов собрал заново')
  assert.equal(snapshot.stats().collects, 2)
})

test('снапшот: ошибка сборки не залипает в полёте', async () => {
  let calls = 0
  const snapshot = createStateSnapshot({
    collect: async () => {
      calls += 1
      if (calls === 1) throw new Error('сборка упала')
      return { ok: true }
    },
    signature: async () => '',
    ttlMs: 1_000,
  })

  await assert.rejects(snapshot.get(), /сборка упала/)
  assert.equal(snapshot.stats().collecting, false, 'single-flight сброшен')
  const value = await snapshot.get()
  assert.equal(value.value.ok, true)
  assert.equal(snapshot.stats().collects, 2)
})

test('fileSignature: меняется при правке файла и отмечает отсутствующие', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-state-signature-'))
  try {
    const ledger = join(dir, 'ledger.json')
    const tombstones = join(dir, 'tombstones.json')
    const before = await fileSignature([ledger, tombstones])
    assert.match(before, /tombstones\.json:-/, 'отсутствующий файл тоже часть подписи')

    await writeFile(ledger, '{"sessions":{}}', 'utf8')
    const afterCreate = await fileSignature([ledger, tombstones])
    assert.notEqual(afterCreate, before, 'появление ledger меняет подпись')

    await writeFile(ledger, '{"sessions":{"session-x":{}}}', 'utf8')
    const afterWrite = await fileSignature([ledger, tombstones])
    assert.notEqual(afterWrite, afterCreate, 'изменение ledger меняет подпись')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- 2. lib/store.mjs: кэш метаданных зеркала -----------------------------

test('стор: заголовок читается префиксом, повторный список логи не читает', async () => {
  const env = await makeEnvironment({ local: 0, mirror: 4, mirrorLogBytes: 96 * 1024 })
  try {
    clearMirrorCache()
    resetStoreStats()
    const first = await listMirrorSessionsCached(env.repoDir, PROJECT)
    const afterFirst = storeStats()
    assert.equal(first.length, 4)
    assert.equal(afterFirst.mirrorFullReads, 0, 'логи целиком не читались')
    assert.equal(afterFirst.mirrorFullBytes, 0)
    assert.equal(afterFirst.headerReads, 4, 'по одному чтению префикса на сессию')
    assert.ok(afterFirst.headerBytes <= 4 * 512, `префиксы: ${afterFirst.headerBytes} байт`)
    assert.ok(afterFirst.headerBytes < env.mirrorBytes / 50, 'прочитано в разы меньше объёма логов')
    assert.equal('bytes' in first[0], false, 'в метаданных нет ленивых байтов')

    resetStoreStats()
    const second = await listMirrorSessionsCached(env.repoDir, PROJECT)
    const afterSecond = storeStats()
    assert.equal(second.length, 4)
    assert.equal(afterSecond.headerReads, 0, 'повторно заголовки не читаются')
    assert.equal(afterSecond.metadataHits, 4)
    for (const item of second) {
      const info = await stat(item.path)
      assert.equal(item.size, info.size, 'размер файла в записи')
      assert.equal(item.mtimeMs, info.mtimeMs, 'mtime файла в записи')
      assert.equal(typeof item.header?.id, 'string')
      assert.equal(item.id, item.header.id)
    }
  } finally {
    await env.cleanup()
  }
})

test('стор: байты лога читаются лениво — только при обращении к bytes', async () => {
  const env = await makeEnvironment({ local: 0, mirror: 2 })
  try {
    clearMirrorCache()
    resetStoreStats()
    const sessions = await listMirrorSessions(env.repoDir, PROJECT)
    assert.equal(storeStats().mirrorFullReads, 0, 'при сборке списка файлы не читались')
    const bytes = sessions[0].bytes
    assert.equal(Buffer.isBuffer(bytes), true)
    assert.equal(bytes.length, sessions[0].size)
    assert.equal(storeStats().mirrorFullReads, 1, 'файл прочитан ровно один раз')
    // Повторное обращение к свойству — из памяти того же вызова.
    assert.equal(sessions[0].bytes.length, sessions[0].size)
    assert.equal(storeStats().mirrorFullReads, 1)
  } finally {
    await env.cleanup()
  }
})

test('стор: изменение лога перечитывает заголовок только этого лога', async () => {
  const env = await makeEnvironment({ local: 0, mirror: 2, mirrorLogBytes: 16 * 1024 })
  try {
    clearMirrorCache()
    await listMirrorSessionsCached(env.repoDir, PROJECT)
    resetStoreStats()

    // Дописали событие в один лог: размер файла изменился, заголовок — нет.
    const target = join(env.repoDir, 'sessions', PROJECT, env.mirrorIds[0], LOG_NAME)
    await appendFile(target, frameOf({ type: 'user/message', seq: 99, time: CREATED_AT + 5_000, data: { content: [] } }))
    const afterAppend = await listMirrorSessionsCached(env.repoDir, PROJECT)
    const appendStats = storeStats()
    assert.equal(afterAppend.length, 2)
    assert.equal(appendStats.headerReads, 1, 'перечитан только изменённый лог')
    assert.equal(appendStats.metadataMisses, 1)
    assert.equal(appendStats.metadataHits, 1)

    // Подменили лог целиком: другой id в заголовке — кэш обязан обновиться.
    const replacedId = `session-${randomUUID()}`
    await writeFile(target, makeMirrorLog(replacedId))
    resetStoreStats()
    const afterReplace = await listMirrorSessionsCached(env.repoDir, PROJECT)
    assert.ok(afterReplace.some((item) => item.id === replacedId), 'новый id из заголовка')
    assert.equal(storeStats().headerReads, 1)
  } finally {
    await env.cleanup()
  }
})

test('стор: кэш метаданных ограничен по размеру (limit)', async () => {
  const env = await makeEnvironment({ local: 0, mirror: 5 })
  try {
    clearMirrorCache()
    resetStoreStats()
    setMirrorCacheLimit(2)
    try {
      const sessions = await listMirrorSessionsCached(env.repoDir, PROJECT)
      assert.equal(sessions.length, 5, 'список полный независимо от кэша')
      const stats = storeStats()
      assert.equal(stats.mirrorCacheSize, 2, 'в памяти не больше limit записей')
      assert.ok(stats.metadataEvictions >= 3, `вытеснено: ${stats.metadataEvictions}`)
    } finally {
      setMirrorCacheLimit(MIRROR_CACHE_LIMIT)
    }
  } finally {
    await env.cleanup()
  }
})

test('стор: лог без сжатия тоже читается по заголовку', async () => {
  const env = await makeEnvironment({ local: 0, mirror: 0 })
  try {
    const id = `session-${randomUUID()}`
    const dir = join(env.repoDir, 'sessions', PROJECT, id)
    await mkdir(dir, { recursive: true })
    const plain = `${JSON.stringify(headerFor(id))}\n${JSON.stringify({ type: 'user/message', seq: 1, time: CREATED_AT, data: {} })}\n`
    await writeFile(join(dir, LOG_NAME), plain, 'utf8')
    clearMirrorCache()
    const sessions = await listMirrorSessionsCached(env.repoDir, PROJECT)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, id)
    assert.equal(sessions[0].cwd, PROJECT_PATH)
  } finally {
    await env.cleanup()
  }
})

// --- 3. index.js: общий снапшот /state и /sessions ------------------------

test('/state и /sessions собираются один раз (общий снапшот)', async () => {
  const env = await makeEnvironment({ local: 2, mirror: 4, mirrorLogBytes: 32 * 1024 })
  const boot = await bootPlugin({ home: env.home, persistence: env.persistence })
  try {
    const state = await boot.call('/api/dsh-sync/state')
    assert.equal(state.status, 200)
    assert.equal(state.body.ok, true)
    assert.equal(state.body.status.local, 2)
    assert.equal(state.body.status.mirror, 4)
    const afterState = stateSnapshotStats()
    assert.equal(afterState.collects, 1, 'первый опрос собрал снапшот')

    const sessions = await boot.call('/api/dsh-sync/sessions')
    assert.equal(sessions.status, 200)
    assert.equal(sessions.body.sessions.length, 2)
    const afterSessions = stateSnapshotStats()
    assert.equal(afterSessions.collects, 1, '/sessions взял тот же расчёт')
    assert.equal(afterSessions.hits, 1)

    const again = await boot.call('/api/dsh-sync/state')
    assert.equal(stateSnapshotStats().collects, 1, 'повторный /state не пересобирает')
    assert.deepEqual(again.body.status, state.body.status)
  } finally {
    boot.dispose()
    await env.cleanup()
  }
})

test('/state не читает логи зеркала: метрики чтений и повторный опрос', async () => {
  const env = await makeEnvironment({ local: 1, mirror: 6, mirrorLogBytes: 128 * 1024 })
  const boot = await bootPlugin({ home: env.home, persistence: env.persistence })
  try {
    resetStoreStats()
    const first = await boot.call('/api/dsh-sync/state')
    const firstStats = storeStats()
    assert.equal(first.body.status.mirror, 6)
    assert.equal(firstStats.mirrorFullReads, 0, 'ни один лог не прочитан целиком')
    assert.equal(firstStats.mirrorFullBytes, 0)
    assert.ok(firstStats.headerBytes > 0)
    assert.ok(
      firstStats.headerBytes * 20 < env.mirrorBytes,
      `прочитано ${firstStats.headerBytes} из ${env.mirrorBytes} байт логов`,
    )

    // Второй опрос в пределах TTL: логи (даже заголовки) не перечитываются.
    resetStoreStats()
    const second = await boot.call('/api/dsh-sync/state')
    const secondStats = storeStats()
    assert.equal(second.body.status.mirror, 6)
    assert.equal(secondStats.headerReads, 0, 'заголовки из кэша метаданных')
    assert.equal(secondStats.headerBytes, 0)
    assert.equal(secondStats.mirrorFullReads, 0)
    assert.ok(env.mirrorBytes > firstStats.headerBytes * 20)
  } finally {
    boot.dispose()
    await env.cleanup()
  }
})

test('инвалидация по логам: новая сессия в зеркале видна сразу, без ожидания TTL', async () => {
  const env = await makeEnvironment({ local: 1, mirror: 2 })
  const boot = await bootPlugin({ home: env.home, persistence: env.persistence })
  try {
    const before = await boot.call('/api/dsh-sync/state')
    assert.equal(before.body.status.mirror, 2)
    assert.equal(stateSnapshotStats().collects, 1)

    await addMirrorSession(env)
    const after = await boot.call('/api/dsh-sync/state')
    assert.equal(after.body.status.mirror, 3, 'подпись логов изменилась — снапшот пересобран')
    assert.equal(stateSnapshotStats().collects, 2)
  } finally {
    boot.dispose()
    await env.cleanup()
  }
})

test('инвалидация по ledger: значки /sessions обновляются при записи реестра', async () => {
  const env = await makeEnvironment({ local: 1, mirror: 1 })
  const boot = await bootPlugin({ home: env.home, persistence: env.persistence })
  try {
    const before = await boot.call('/api/dsh-sync/sessions')
    assert.equal(before.body.sessions[0].state, 'red', 'без записи в ledger сессия не синхронизирована')

    const info = await stat(env.snapshots[0].location.path)
    const ledger = {
      version: 1,
      sessions: {
        [env.localIds[0]]: { at: Date.now(), mtimeMs: Math.round(info.mtimeMs), size: info.size },
      },
    }
    await writeFile(join(env.home, 'dsh-sync', 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    const after = await boot.call('/api/dsh-sync/sessions')
    assert.equal(after.body.sessions[0].state, 'green', 'запись ledger применилась')
    assert.ok(stateSnapshotStats().collects >= 2, 'снапшот пересобран по подписи ledger')
  } finally {
    boot.dispose()
    await env.cleanup()
  }
})

test('TTL из окружения: 0 — снапшот пересобирается на каждый вызов', async () => {
  const env = await makeEnvironment({ local: 1, mirror: 1 })
  const boot = await bootPlugin({ home: env.home, persistence: env.persistence, ttlMs: 0 })
  try {
    await boot.call('/api/dsh-sync/state')
    assert.equal(stateSnapshotStats().collects, 1)
    assert.equal(stateSnapshotStats().ttlMs, 0)
    await boot.call('/api/dsh-sync/state')
    assert.equal(stateSnapshotStats().collects, 2, 'TTL 0 отключает кэш по времени')
  } finally {
    boot.dispose()
    await env.cleanup()
  }
})

test('операция меняет режим: снапшот инвалидируется и /state видит новое', async () => {
  const env = await makeEnvironment({ local: 1, mirror: 0 })
  const boot = await bootPlugin({ home: env.home, persistence: env.persistence })
  try {
    const before = await boot.call('/api/dsh-sync/state')
    assert.equal(before.body.modes.local, 0)
    assert.equal(stateSnapshotStats().collects, 1)

    const mode = await boot.call('/api/dsh-sync/session-mode', { id: env.localIds[0], mode: 'local' })
    assert.equal(mode.body.ok, true)

    const after = await boot.call('/api/dsh-sync/state')
    assert.equal(after.body.modes.local, 1, 'операция инвалидировала снапшот')
    assert.ok(stateSnapshotStats().collects >= 2)
  } finally {
    boot.dispose()
    await env.cleanup()
  }
})

// --- 4. формат ответов прежний --------------------------------------------

const STATE_KEYS = [
  'automation', 'checks', 'config', 'debug', 'deviceId', 'external', 'history', 'lastRun',
  'mode', 'modes', 'ok', 'onboarding', 'outbox', 'outboxCount', 'pending', 'preferExternal',
  'profile', 'ready', 'secondary', 'secondaryBackend', 'secondaryPasswordStored', 'status',
  'suggestedFolder', 'suggestedSecondaryFolder', 'version', 'workspace',
]
const STATE_CONFIG_KEYS = [
  'attachments', 'backend', 'branch', 'profile', 'projectId', 'projectPath', 'remote',
  'repoDir', 'sync', 'useExternal', 'workspace',
]
const SESSIONS_KEYS = [
  'attachAvailable', 'cloud', 'groups', 'localOnly', 'modes', 'ok', 'outbox', 'sessions',
  'states', 'syncing', 'unattached', 'workspaces',
]
const SESSION_ROW_KEYS = [
  'attached', 'badge', 'bytes', 'children', 'childrenCount', 'childrenMissing',
  'childrenMissingCount', 'cloudCopy', 'declared', 'groupId', 'groupSize', 'id', 'mode',
  'orphan', 'parentMissing', 'parentSession', 'path', 'projectId', 'rawTitle', 'shortId',
  'state', 'syncedAt', 'title', 'titleSource', 'workspaceId',
]

test('/state и /sessions сохраняют формат ответов', async () => {
  const env = await makeEnvironment({ local: 2, mirror: 1 })
  const boot = await bootPlugin({ home: env.home, persistence: env.persistence })
  try {
    const state = await boot.call('/api/dsh-sync/state')
    assert.equal(state.status, 200)
    assert.deepEqual(Object.keys(state.body).sort(), STATE_KEYS, 'поля /state прежние')
    assert.deepEqual(Object.keys(state.body.config).sort(), STATE_CONFIG_KEYS, 'поля config прежние')
    assert.equal(state.body.ready, false, 'без remote окружение не готово')
    assert.equal(state.body.checks.length, 4, 'четыре проверки окружения')
    assert.equal(state.body.status.local, 2)
    assert.equal(state.body.status.mirror, 1)
    assert.equal(typeof state.body.deviceId, 'string')
    for (const key of ['status', 'modes', 'profile', 'workspace', 'external', 'automation', 'config', 'debug']) {
      assert.equal(typeof state.body[key], 'object', `${key} — объект`)
    }

    const sessions = await boot.call('/api/dsh-sync/sessions')
    assert.equal(sessions.status, 200)
    assert.deepEqual(Object.keys(sessions.body).sort(), SESSIONS_KEYS, 'поля /sessions прежние')
    assert.equal(sessions.body.sessions.length, 2)
    assert.deepEqual(Object.keys(sessions.body.states).sort(), [...env.localIds].sort(), 'states по id сессий')
    for (const row of sessions.body.sessions) {
      assert.deepEqual(
        Object.keys(row).filter((key) => key !== 'cloudCopyBytes').sort(),
        SESSION_ROW_KEYS,
        'поля строки сессии прежние',
      )
      assert.equal(typeof row.id, 'string')
      assert.equal(typeof row.title, 'string')
      assert.ok(['green', 'orange', 'red'].includes(row.state))
    }
  } finally {
    boot.dispose()
    await env.cleanup()
  }
})

// --- 5. клиентский рендер на реальном ответе снапшота ---------------------

/**
 * Загрузить client.js в поддельном окне, накормить его реальными ответами
 * host-части и вернуть текст отрисованной страницы. Хуки React — минимальные,
 * как в test/client-render.test.mjs (полноценный рендер там проверяется
 * отдельно на фикстурах; здесь важен стык «снапшот → клиент»).
 */
async function renderClientWithPayload({ state, sessions }) {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  }
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  globalThis.document = {
    documentElement: { style: {}, dataset: {} },
    body: {},
    createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
    head: { appendChild: () => {} },
  }
  globalThis.fetch = async (path) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(String(path).includes('/sessions') ? sessions : state),
  })
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)()
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
    const requireStub = (id) => {
      if (id === 'react') return React
      if (id === 'react-dom') return { createPortal: (node) => node }
      throw new Error(`неожиданный require: ${id}`)
    }
    const registrations = []
    const exported = loaded.factory(requireStub)
    exported.apply({
      effect: (fn) => { fn() },
      locale: {
        bind: (ns) => (key) => dictionaries[ns]?.ru?.[key] ?? key,
        subscribe: () => () => {},
        register: (ns, localeOrDict, maybeDict) => {
          dictionaries[ns] = maybeDict ?? localeOrDict
        },
      },
      slots: {
        inject: (name, register) => { register() },
        register: (options, component) => { registrations.push({ options, component }) },
      },
    })
    // Ждём асинхронный опрос /state из apply.
    await new Promise((resolve) => setTimeout(resolve, 40))
    const main = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'dsh-sessions')
    assert.ok(main, 'страница регистрируется в main')
    return resolveTree(main.component({}))
  } finally {
    if (saved.window === undefined) delete globalThis.window
    else globalThis.window = saved.window
    if (saved.document === undefined) delete globalThis.document
    else globalThis.document = saved.document
    globalThis.fetch = saved.fetch
  }
}

function resolveTree(node, depth = 0) {
  if (depth > 40 || node === null || node === undefined || typeof node !== 'object') return node
  const type = node.type
  const children = node.children ?? []
  const props = {
    ...node.props,
    children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
  }
  if (typeof type !== 'function') return { type, props: node.props ?? {}, children: children.map((child) => resolveTree(child, depth + 1)) }
  const rendered = type.prototype && typeof type.prototype.render === 'function'
    ? new type(props).render()
    : type(props)
  return resolveTree(rendered, depth + 1)
}

function collectText(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node !== null && typeof node === 'object') {
    for (const child of node.children ?? []) collectText(child, out)
  }
  return out
}

test('клиент рисует страницу на реальном ответе снапшота', async () => {
  const env = await makeEnvironment({ local: 2, mirror: 1 })
  const boot = await bootPlugin({ home: env.home, persistence: env.persistence })
  try {
    const state = await boot.call('/api/dsh-sync/state')
    const sessions = await boot.call('/api/dsh-sync/sessions')
    const tree = await renderClientWithPayload({ state: state.body, sessions: sessions.body })
    const text = collectText(tree).join(' ')
    assert.match(text, /Синхронизация сессий/, 'заголовок страницы отрисован')
    for (const section of ['Хранилище', 'План и синхронизация', 'Сессии и режим', 'Проверка окружения']) {
      assert.ok(text.includes(section), `секция «${section}» отрисована`)
    }
  } finally {
    boot.dispose()
    await env.cleanup()
  }
})
