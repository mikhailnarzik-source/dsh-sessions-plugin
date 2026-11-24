/**
 * M0-C: названия сессий (H2), восстановление с тем же id (H4), очередь
 * операций outbox и flush (H6), проверка интерфейса резерва (H5) и отсутствие
 * дублей recordRun (H10).
 *
 * Запуск: node --test test/m0-c.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { recordRun, readHistory } from '../lib/history.mjs'
import { encodeSegment, projectKey } from '../lib/format.mjs'
import { localSessionDir, splitLog } from '../lib/store.mjs'
import { addTombstone, readTombstones, writeTombstones } from '../lib/tombstones.mjs'
import { setSessionMode } from '../lib/session-modes.mjs'
import { titleOfLogBytes, resolveSessionTitle, shortSessionId, displayTitle, clearTitleCache, titleCacheSize, UNTITLED, TITLE_READ_BYTES } from '../lib/titles.mjs'
import {
  OUTBOX_MAX_DELAY_MS,
  backendSupports,
  backoffDelay,
  classifyBackendFailure,
  enqueueOutbox,
  flushOutbox,
  outboxSummary,
  parseOutbox,
  readOutbox,
  removeOutbox,
  unsupportedBackendMessage,
} from '../lib/outbox.mjs'

// --- helpers ---------------------------------------------------------------

function frame(value) {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`))
}

function makeLog(header, events = []) {
  return Buffer.concat([frame(header), ...events.map(frame)])
}

function headerFor(cwd, id = `session-${randomUUID()}`) {
  return { type: 'session', version: 4, id, createdAt: Date.now(), cwd }
}

function titleEvent(title) {
  return { type: 'session/title', seq: 3, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } }
}

function userEvent(text) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }] } }
}

async function makeHome(prefix = 'dsh-sync-m0c-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  return { root, home }
}

async function writeLocalLog(home, projectPath, id, events) {
  const dir = localSessionDir(home, projectPath, id)
  await mkdir(dir, { recursive: true })
  const logPath = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(logPath, makeLog(headerFor(projectPath, id), events))
  return logPath
}

function routeCaller(routes) {
  return async (path, payload) => {
    const response = await routes.get(path).fetch(new Request(`http://local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }))
    return { status: response.status, body: await response.json() }
  }
}

async function bootPlugin({ ctx = {}, home }) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { apply, invalidateSessionStates } = await import('../index.js')
  invalidateSessionStates()
  clearTitleCache()
  const routes = new Map()
  const cleanups = []
  const effective = {
    ...ctx,
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    tools: { register: () => {} },
    get: ctx.get ?? (() => undefined),
  }
  apply(effective)
  return {
    routes,
    call: routeCaller(routes),
    // Снять таймеры плагина: иначе flush из одного теста может писать в home
    // следующего теста.
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

function encode(id) {
  return encodeSegment(id)
}

/** Очистить очередь перед закрытием плагина: фоновый flush не должен писать
 * в уже удаляемый временный home. */
async function clearOutboxQueue(home) {
  const data = await readOutbox(home)
  for (const operation of data.operations) await removeOutbox(home, operation.id)
}

// --- H2: названия ----------------------------------------------------------

test('H2: titleOfLogBytes читает последнее событие session/title из zstd-фреймов', () => {
  const id = `session-${randomUUID()}`
  const bytes = makeLog(headerFor('C:\\work\\alpha', id), [userEvent('привет'), titleEvent('Первый заголовок'), titleEvent('Второй заголовок')])
  assert.equal(titleOfLogBytes(bytes), 'Второй заголовок', 'DSH пишет сначала предварительное название, затем настоящее')
  assert.equal(titleOfLogBytes(makeLog(headerFor('C:\\work\\alpha', id), [userEvent('без названия')])), '')
  assert.equal(titleOfLogBytes(Buffer.alloc(0)), '')
})

test('H2: цепочка названий — лог (последнее) → session.title → session.json зеркала → «Без названия»', async () => {
  const { root, home } = await makeHome()
  try {
    const id = `session-${randomUUID()}`
    const projectPath = join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    const logPath = await writeLocalLog(home, projectPath, id, [titleEvent('Название из лога')])

    // 1. Лог сильнее переданного session.title: в логе последнее событие — настоящее.
    const fromSession = await resolveSessionTitle({ id, title: 'Название из DSH', path: logPath })
    assert.equal(fromSession.title, 'Название из лога')
    assert.equal(fromSession.titleSource, 'log')

    // 2. Лога нет — берём переданное session.title.
    const fromGiven = await resolveSessionTitle({ id, title: 'Название из DSH' })
    assert.equal(fromGiven.title, 'Название из DSH')
    assert.equal(fromGiven.titleSource, 'session')
    assert.equal(fromGiven.shortId, shortSessionId(id))

    // 3. Нет лога — session.json рядом с копией зеркала.
    const repoDir = join(root, 'mirror')
    const mirrorDir = join(repoDir, 'sessions', 'alpha', encode(id))
    await mkdir(mirrorDir, { recursive: true })
    await writeFile(join(mirrorDir, 'session.json'), `${JSON.stringify({ id, title: 'Из зеркала' })}\n`, 'utf8')
    const fromMirror = await resolveSessionTitle({ id, title: '', repoDir, projectId: 'alpha' })
    assert.equal(fromMirror.title, 'Из зеркала')
    assert.equal(fromMirror.titleSource, 'mirror')

    // 4. Ничего нет — «Без названия» + короткий id.
    const fallback = await resolveSessionTitle({ id, title: '' })
    assert.equal(fallback.title, UNTITLED)
    assert.equal(fallback.titleSource, 'fallback')
    assert.equal(fallback.shortId, shortSessionId(id))
    assert.match(shortSessionId(id), /…/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('H2: кеш лога обновляется по mtime и не растёт бесконечно', async () => {
  const { root, home } = await makeHome()
  try {
    const id = `session-${randomUUID()}`
    const projectPath = join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    const logPath = await writeLocalLog(home, projectPath, id, [titleEvent('Старое имя')])
    clearTitleCache()
    assert.equal((await resolveSessionTitle({ id, title: '', path: logPath })).title, 'Старое имя')
    assert.equal(titleCacheSize(), 1)

    // Перезаписали лог — mtime и размер изменились, кеш обязан обновиться.
    await writeFile(logPath, makeLog(headerFor(projectPath, id), [titleEvent('Новое имя')]))
    const stamp = new Date(Date.now() + 5_000)
    await utimes(logPath, stamp, stamp)
    assert.equal((await resolveSessionTitle({ id, title: '', path: logPath })).title, 'Новое имя')
    assert.equal(titleCacheSize() <= 500, true)
  } finally {
    clearTitleCache()
    await rm(root, { recursive: true, force: true })
  }
})

test('H2: название дальше первых 2 МБ читается из хвоста лога (позднее переименование)', async () => {
  const { root, home } = await makeHome()
  try {
    const id = `session-${randomUUID()}`
    const projectPath = join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    // plain JSONL: событие с названием стоит после 2 МБ данных.
    const filler = `${JSON.stringify(userEvent('x'.repeat(TITLE_READ_BYTES + 64)))}\n`
    const tail = `${JSON.stringify(titleEvent('Поздний заголовок'))}\n`
    const logPath = join(localSessionDir(home, projectPath, id), 'session.v4.jsonl.zstd')
    await mkdir(join(localSessionDir(home, projectPath, id)), { recursive: true })
    await writeFile(logPath, `${filler}${tail}`, 'utf8')
    const limited = await resolveSessionTitle({ id, title: '', path: logPath })
    assert.equal(limited.title, 'Поздний заголовок', 'хвост лога читается: последнее название важнее')
    const bytes = await readFile(logPath)
    assert.equal(titleOfLogBytes(bytes, { maxBytes: bytes.length }), 'Поздний заголовок')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('H2: маршрут /sessions отдаёт названия вместо id и «Без названия»', async () => {
  const { root, home } = await makeHome()
  let boot
  try {
    const projectPath = join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-titles', repoDir: join(root, 'mirror'), profile: { enabled: false }, workspace: { enabled: false } }
    config.projects = { alpha: { path: projectPath, title: 'alpha' } }
    config.autoSync = { enabled: false }
    await saveConfig(home, config)

    const namedId = `session-${randomUUID()}`
    const unnamedId = `session-${randomUUID()}`
    const namedPath = await writeLocalLog(home, projectPath, namedId, [titleEvent('Диалог про отпуск')])
    const unnamedPath = await writeLocalLog(home, projectPath, unnamedId, [userEvent('без заголовка')])

    const snapshots = [
      { header: { id: namedId, cwd: projectPath }, location: { path: namedPath }, sizeBytes: 10, title: '' },
      { header: { id: unnamedId, cwd: projectPath }, location: { path: unnamedPath }, sizeBytes: 10 },
    ]
    boot = await bootPlugin({
      home,
      ctx: { get: (name) => (name === 'sessionPersistence' ? { list: async () => snapshots } : undefined) },
    })
    const listed = await boot.call('/api/dsh-sync/sessions', {})
    assert.equal(listed.status, 200)
    assert.equal(listed.body.ok, true)
    const byId = new Map(listed.body.sessions.map(session => [session.id, session]))
    assert.equal(byId.get(namedId).title, 'Диалог про отпуск')
    assert.equal(byId.get(namedId).titleSource, 'log')
    assert.equal(byId.get(namedId).shortId, shortSessionId(namedId))
    assert.equal(byId.get(unnamedId).title, UNTITLED)
    assert.equal(byId.get(unnamedId).titleSource, 'fallback')
    assert.equal(typeof listed.body.outbox.count, 'number', 'счётчик очереди в панели')
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(root, { recursive: true, force: true })
  }
})

test('H2: «Удалённые» и план показывают названия, а не только id', async () => {
  const { root, home } = await makeHome()
  let boot
  try {
    const repoDir = join(root, 'mirror')
    const projectPath = join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-del', repoDir, profile: { enabled: false }, workspace: { enabled: false } }
    config.projects = { alpha: { path: projectPath, title: 'alpha' } }
    config.autoSync = { enabled: false }
    await saveConfig(home, config)

    const namedId = `session-${randomUUID()}`
    const anonymousId = `session-${randomUUID()}`
    for (const [id, events] of [[namedId, [titleEvent('Удалённый диалог')]], [anonymousId, [userEvent('без названия')]]]) {
      const dir = join(repoDir, 'sessions', 'alpha', '_deleted', encode(id))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), makeLog(headerFor(projectPath, id), events))
    }
    const data = await readTombstones(repoDir)
    addTombstone(data, namedId, 'device-owner', { reason: 'manual', by: 'owner', projectId: 'alpha' })
    addTombstone(data, anonymousId, 'device-owner', { reason: 'manual', by: 'owner', projectId: 'alpha' })
    await writeTombstones(repoDir, data)

    boot = await bootPlugin({ home, ctx: { get: () => undefined } })
    const listed = await boot.call('/api/dsh-sync/tombstones', {})
    assert.equal(listed.status, 200)
    const rows = new Map(listed.body.sessions.map(row => [row.id, row]))
    assert.equal(rows.get(namedId).title, 'Удалённый диалог')
    assert.equal(rows.get(namedId).titleSource, 'quarantine-log')
    assert.equal(rows.get(anonymousId).title, UNTITLED)
    assert.equal(rows.get(anonymousId).titleSource, 'fallback')
    assert.equal(typeof rows.get(namedId).shortId, 'string')

    // План: названия в удалениях и корзинах.
    const { decoratePlanTitles } = await import('../index.js')
    const plan = {
      deletions: [{ id: namedId, projectId: 'alpha' }],
      buckets: { onlyLocal: [{ id: anonymousId, projectId: 'alpha' }] },
    }
    await decoratePlanTitles(plan, { home, config })
    assert.equal(plan.deletions[0].title, 'Удалённый диалог')
    assert.equal(plan.buckets.onlyLocal[0].title, UNTITLED)
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(root, { recursive: true, force: true })
  }
})

test('H2: displayTitle и короткий id для подсказки', () => {
  assert.equal(displayTitle('  Мой   диалог '), 'Мой диалог')
  assert.equal(displayTitle(''), UNTITLED)
  assert.equal(displayTitle(undefined), UNTITLED)
  assert.equal(shortSessionId('session-12345678-90ab-cdef-1234-567890abcdef'), '12345678…cdef')
  assert.equal(shortSessionId('short'), 'short')
  assert.equal(shortSessionId(''), '')
})

// --- H4: восстановление с тем же id ---------------------------------------

async function restoreEnvironment(root) {
  const home = join(root, 'home')
  const repoDir = join(root, 'mirror')
  const projectPath = join(root, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(projectPath, { recursive: true })
  const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-restore', repoDir, profile: { enabled: false }, workspace: { enabled: false } }
  config.projects = { alpha: { path: projectPath, title: 'alpha' } }
  config.autoSync = { enabled: false }
  await saveConfig(home, config)
  return { home, repoDir, projectPath, config }
}

async function writeQuarantine(repoDir, id, { title = 'Восстановленный диалог', headerId, events } = {}) {
  const dir = join(repoDir, 'sessions', 'alpha', '_deleted', encode(id))
  await mkdir(dir, { recursive: true })
  const header = headerFor('/dsh-sync/projects/alpha', headerId ?? id)
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), makeLog(header, events ?? [titleEvent(title)]))
  await writeFile(join(dir, 'session.json'), `${JSON.stringify({ id, title })}\n`, 'utf8')
  return dir
}

async function writeTombstoneEntry(repoDir, id, meta = {}) {
  const data = await readTombstones(repoDir)
  addTombstone(data, id, 'device-owner', { reason: 'manual', by: 'owner', projectId: 'alpha', ...meta })
  await writeTombstones(repoDir, data)
}

test('H4: restore принимает короткий id и возвращает канонический (без новой копии)', async () => {
  const { root } = await makeHome('dsh-sync-h4-a-')
  let boot
  try {
    const { home, repoDir, projectPath } = await restoreEnvironment(root)
    const id = `session-${randomUUID()}`
    await writeQuarantine(repoDir, id)
    await writeTombstoneEntry(repoDir, id)
    boot = await bootPlugin({ home, ctx: { get: () => undefined } })

    const shortId = id.replace(/^session-/, '')
    const restored = await boot.call('/api/dsh-sync/restore', { id: shortId })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.ok, true)
    assert.deepEqual(restored.body.restoredIds, [id], 'id канонический, без нового префикса')
    assert.equal(existsSync(join(repoDir, 'sessions', 'alpha', encode(shortId))), false, 'копии под коротким id нет')
    assert.equal(existsSync(join(repoDir, 'sessions', 'alpha', encode(id), 'session.v4.jsonl.zstd')), true)
    assert.equal(existsSync(localSessionDir(home, projectPath, id)), true, 'локальная копия под каноническим id')
    assert.equal(existsSync(join(home, 'sessions', projectKey(projectPath), encode(shortId))), false)

    const tombstone = await readTombstones(repoDir)
    assert.equal(tombstone.sessions[id].reason, 'restored')
    assert.equal(tombstone.sessions[id].restoredFrom, 'manual', 'restoredFrom записан в метку')

    const log = splitLog(await readFile(join(repoDir, 'sessions', 'alpha', encode(id), 'session.v4.jsonl.zstd')))
    assert.equal(log.header.id, id, 'заголовок лога сохраняет тот же id')
    const history = await readHistory(home, 5)
    const record = history[history.length - 1]
    assert.equal(record.action, 'restore')
    assert.deepEqual(record.restoredFrom, { [id]: 'manual' }, 'restoredFrom есть и в журнале')
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(root, { recursive: true, force: true })
  }
})

test('H4: чужой id в заголовке карантинной копии приводится к каноническому', async () => {
  const { root } = await makeHome('dsh-sync-h4-b-')
  let boot
  try {
    const { home, repoDir } = await restoreEnvironment(root)
    const id = `session-${randomUUID()}`
    const foreign = `session-${randomUUID()}`
    await writeQuarantine(repoDir, id, { headerId: foreign })
    await writeTombstoneEntry(repoDir, id)
    boot = await bootPlugin({ home, ctx: { get: () => undefined } })

    const restored = await boot.call('/api/dsh-sync/restore', { id })
    assert.equal(restored.status, 200)
    assert.deepEqual(restored.body.idFixed, [id], 'исправление id отражено в отчёте')
    const logPath = join(repoDir, 'sessions', 'alpha', encode(id), 'session.v4.jsonl.zstd')
    const { header } = splitLog(await readFile(logPath))
    assert.equal(header.id, id, 'DSH увидит восстановленную сессию, а не «новую»')
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(root, { recursive: true, force: true })
  }
})

test('H4: живая конфликтующая копия уходит в карантин с reason=superseded', async () => {
  const { root } = await makeHome('dsh-sync-h4-c-')
  let boot
  try {
    const { home, repoDir } = await restoreEnvironment(root)
    const id = `session-${randomUUID()}`
    await writeQuarantine(repoDir, id, { events: [titleEvent('Удалённая версия'), userEvent('старое')] })
    // Живая копия с другим содержимым: восстановление не должно её затирать.
    const liveDir = join(repoDir, 'sessions', 'alpha', encode(id))
    await mkdir(liveDir, { recursive: true })
    await writeFile(join(liveDir, 'session.v4.jsonl.zstd'), makeLog(headerFor('/dsh-sync/projects/alpha', id), [titleEvent('Живая версия'), userEvent('новое')]))
    await writeTombstoneEntry(repoDir, id)
    boot = await bootPlugin({ home, ctx: { get: () => undefined } })

    const restored = await boot.call('/api/dsh-sync/restore', { id })
    assert.equal(restored.status, 200)
    assert.deepEqual(restored.body.superseded, [id], 'проигравшая копия отмечена в отчёте')
    assert.equal(restored.body.reasons.includes('superseded'), true)
    assert.equal(restored.body.by.includes('sync'), true)

    // Восстановленная (удалённая) версия стоит на месте живой.
    const activeBytes = await readFile(join(liveDir, 'session.v4.jsonl.zstd'))
    assert.equal(titleOfLogBytes(activeBytes), 'Удалённая версия')
    // Проигравшая копия сохранена в карантине с причиной superseded.
    const deletedRoot = join(repoDir, 'sessions', 'alpha', '_deleted')
    const entries = await readdir(deletedRoot, { withFileTypes: true })
    const supersededDir = entries.find(entry => entry.name.startsWith(`${encode(id)}.superseded-`))
    assert.ok(supersededDir, 'карантин проигравшей копии создан')
    const meta = JSON.parse(await readFile(join(deletedRoot, supersededDir.name, 'deleted-at.json'), 'utf8'))
    assert.equal(meta.reason, 'superseded')
    assert.equal(meta.by, 'sync')
    const loser = await readFile(join(deletedRoot, supersededDir.name, 'session.v4.jsonl.zstd'))
    assert.equal(titleOfLogBytes(loser), 'Живая версия')
    assert.equal(existsSync(join(deletedRoot, encode(id))), false, 'карантинная копия переехала на место живой')

    const history = await readHistory(home, 5)
    const record = history[history.length - 1]
    assert.deepEqual(record.superseded, [id])
    assert.deepEqual(record.restoredFrom, { [id]: 'manual' })
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(root, { recursive: true, force: true })
  }
})

// --- H6: outbox и flush ----------------------------------------------------

test('H6: backoff растёт и упирается в потолок', () => {
  assert.equal(backoffDelay(1), 30_000)
  assert.equal(backoffDelay(2), 60_000)
  assert.equal(backoffDelay(3), 120_000)
  assert.equal(backoffDelay(20), OUTBOX_MAX_DELAY_MS)
})

test('H6: outbox.json — постановка, дедуп, удаление и битый файл', async () => {
  const { root, home } = await makeHome('dsh-sync-outbox-')
  try {
    assert.equal((await outboxSummary(home)).count, 0)
    const first = await enqueueOutbox(home, { type: 'push', payload: { action: 'push' }, error: 'нет сети' })
    assert.equal(first.added, true)
    assert.equal(first.count, 1)
    const again = await enqueueOutbox(home, { type: 'push', payload: { action: 'push' }, error: 'снова нет сети' })
    assert.equal(again.added, false, 'дубль не размножается')
    assert.equal(again.count, 1)
    assert.equal((await outboxSummary(home)).lastError, 'снова нет сети')

    const data = await readOutbox(home)
    const operation = data.operations[0]
    assert.equal(operation.type, 'push')
    assert.equal(operation.attempts, 0)
    assert.equal(typeof operation.at, 'string')
    assert.equal(typeof operation.nextAt, 'string')

    assert.equal(await removeOutbox(home, operation.id), true)
    assert.equal((await outboxSummary(home)).count, 0)

    // Битый файл не роняет панель.
    await writeFile(join(home, 'dsh-sync', 'outbox.json'), '{oops', 'utf8')
    assert.deepEqual(parseOutbox('{oops'), { version: 1, operations: [] })
    assert.equal((await outboxSummary(home)).count, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('H6: flush выполняет операцию, при ошибке копит attempts и backoff', async () => {
  const { root, home } = await makeHome('dsh-sync-flush-')
  try {
    await enqueueOutbox(home, { type: 'delete', payload: { ids: ['session-a'] }, error: 'офлайн' })
    const okHandlers = { delete: async () => true }
    const success = await flushOutbox(home, { handlers: okHandlers })
    assert.equal(success.flushed.length, 1)
    assert.equal(success.remaining, 0)

    await enqueueOutbox(home, { type: 'delete', payload: { ids: ['session-b'] }, error: 'офлайн' })
    const failing = await flushOutbox(home, { handlers: { delete: async () => { throw new Error('сеть недоступна') } } })
    assert.equal(failing.failed.length, 1)
    const afterFailure = await outboxSummary(home)
    assert.equal(afterFailure.count, 1)
    assert.equal(afterFailure.pending[0].attempts, 1)
    assert.equal(afterFailure.pending[0].lastError, 'сеть недоступна')
    assert.ok(Date.parse(afterFailure.pending[0].nextAt) > Date.now(), 'повтор отложен (backoff)')

    // Пока пауза не прошла — операция не трогается.
    const tooEarly = await flushOutbox(home, { handlers: { delete: async () => true } })
    assert.equal(tooEarly.flushed.length, 0)
    assert.equal(tooEarly.skipped >= 1, true)

    // По истечении паузы — повтор и успех.
    const later = Date.now() + OUTBOX_MAX_DELAY_MS + 1_000
    const retried = await flushOutbox(home, { handlers: { delete: async () => true }, now: later })
    assert.equal(retried.flushed.length, 1)
    assert.equal((await outboxSummary(home)).count, 0)

    // Таймаут одной операции не роняет цикл и оставляет операцию в очереди.
    await enqueueOutbox(home, { type: 'push', payload: { action: 'push' } })
    const timedOut = await flushOutbox(home, {
      handlers: { push: () => new Promise(() => {}) },
      opTimeoutMs: 20,
      totalTimeoutMs: 40,
    })
    assert.equal(timedOut.timedOut, true)
    assert.equal((await outboxSummary(home)).count, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('H6: счётчик «в очереди: N» виден в состоянии панели', async () => {
  const { root, home } = await makeHome('dsh-sync-outbox-state-')
  let boot
  try {
    const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-queue', repoDir: join(root, 'mirror'), profile: { enabled: false }, workspace: { enabled: false } }
    config.projects = { alpha: { path: join(root, 'project'), title: 'alpha' } }
    config.autoSync = { enabled: false }
    await mkdir(join(root, 'project'), { recursive: true })
    await saveConfig(home, config)
    await enqueueOutbox(home, { type: 'push', payload: { action: 'push' }, error: 'нет сети' })
    boot = await bootPlugin({ home, ctx: { get: () => undefined } })
    const state = await boot.call('/api/dsh-sync/state', {})
    assert.equal(state.status, 200)
    assert.equal(state.body.outboxCount, 1, 'счётчик для строки «в очереди: N»')
    assert.equal(state.body.outbox.count, 1)
    assert.match(state.body.outbox.lastError, /нет сети/)
  } finally {
    await clearOutboxQueue(home).catch(() => {})
    boot?.dispose(); boot?.restoreHome()
    await rm(root, { recursive: true, force: true })
  }
})

// --- H5: единый интерфейс резерва -----------------------------------------

test('H5: backend supports/classify — понятное сообщение вместо сырого TypeError', () => {
  assert.equal(backendSupports({ sync() {} }, 'sync'), true)
  assert.equal(backendSupports({}, 'sync'), false)
  assert.equal(backendSupports(undefined, 'sync'), false)
  assert.equal(backendSupports({ sync() {}, capabilities: { sync: false } }, 'sync'), false)

  const raw = classifyBackendFailure(new TypeError('remote.sync is not a function'), { operation: 'sync' })
  assert.equal(raw.unsupported, true)
  assert.equal(raw.code, 'reserve/unsupported')
  assert.match(raw.message, /резерв не поддерживает операцию «синхронизация»/)
  assert.doesNotMatch(raw.message, /is not a function/)

  const explicit = classifyBackendFailure(Object.assign(new Error('резерв «webdav» не поддерживает операцию «remove»'), { code: 'reserve/unsupported' }), { operation: 'remove' })
  assert.equal(explicit.unsupported, true)
  assert.equal(explicit.message, 'резерв «webdav» не поддерживает операцию «remove»')

  const network = classifyBackendFailure(new Error('getaddrinfo ENOTFOUND'), { operation: 'sync' })
  assert.equal(network.unsupported, false)
  assert.equal(network.message, 'getaddrinfo ENOTFOUND')
  assert.match(unsupportedBackendMessage('remove'), /резерв не поддерживает операцию/)
})

test('H5: flush не зовёт отсутствующий метод резерва — сообщение и операция в очереди', async () => {
  const { root, home } = await makeHome('dsh-sync-h5-')
  let boot
  try {
    const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-h5', repoDir: join(root, 'mirror'), profile: { enabled: false }, workspace: { enabled: false } }
    config.projects = { alpha: { path: join(root, 'project'), title: 'alpha' } }
    // Старая конфигурация с резервом, который не умеет операцию.
    config.secondary = { enabled: true, backend: 'ftp', repoDir: join(root, 'replica-ftp') }
    config.autoSync = { enabled: false }
    await mkdir(join(root, 'project'), { recursive: true })
    await saveConfig(home, config)
    await enqueueOutbox(home, { type: 'push', payload: { action: 'push', secondary: true }, error: 'офлайн' })

    boot = await bootPlugin({ home, ctx: { get: () => undefined } })
    const { flushOutboxCycle } = await import('../index.js')
    const outcome = await flushOutboxCycle({ connection: {}, tools: {} }, { opTimeoutMs: 500, totalTimeoutMs: 1_000 })
    assert.equal(outcome.failed.length, 1)
    const summary = await outboxSummary(home)
    assert.equal(summary.count, 1, 'операция осталась в очереди')
    assert.match(summary.pending[0].lastError, /не поддерживает операцию/)
    assert.doesNotMatch(summary.pending[0].lastError, /is not a function/)
  } finally {
    await clearOutboxQueue(home).catch(() => {})
    boot?.dispose(); boot?.restoreHome()
    await rm(root, { recursive: true, force: true })
  }
})

test('H5: маршрут удаления облачной копии проходит проверку интерфейса backend', async () => {
  const { root, home } = await makeHome('dsh-sync-h5-route-')
  let boot
  try {
    const repoDir = join(root, 'mirror')
    const projectPath = join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-cloud', repoDir, profile: { enabled: false }, workspace: { enabled: false } }
    config.projects = { alpha: { path: projectPath, title: 'alpha' } }
    config.autoSync = { enabled: false }
    await saveConfig(home, config)

    const id = `session-${randomUUID()}`
    const copyDir = join(repoDir, 'sessions', 'alpha', encode(id))
    await mkdir(copyDir, { recursive: true })
    await writeFile(join(copyDir, 'session.v4.jsonl.zstd'), makeLog(headerFor(projectPath, id), [titleEvent('Облачная копия')]))
    await writeFile(join(copyDir, 'session.json'), `${JSON.stringify({ id, title: 'Облачная копия' })}\n`, 'utf8')
    await setSessionMode(home, [id], 'local')

    boot = await bootPlugin({ home, ctx: { get: () => undefined } })
    const asked = await boot.call('/api/dsh-sync/session-cloud-copy', { id })
    assert.equal(asked.status, 409)
    assert.equal(asked.body.code, 'confirm-required')
    assert.match(asked.body.message, /подтвердите/)

    const deleted = await boot.call('/api/dsh-sync/session-cloud-copy', { id, confirm: true })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.ok, true)
    assert.equal(deleted.body.action, 'cloud-copy-delete')
    assert.equal(deleted.body.reasons[0], 'manual')
    assert.equal(existsSync(copyDir), false, 'копия ушла из зеркала')
    const tombstones = await readTombstones(repoDir)
    assert.equal(tombstones.sessions[id].reason, 'manual')
    assert.equal(tombstones.sessions[id].by, 'owner')
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(root, { recursive: true, force: true })
  }
})

// --- H10: без дублей recordRun --------------------------------------------

test('H10: updateLastRun обновляет last-run, не дописывая журнал', async () => {
  const { root, home } = await makeHome('dsh-sync-h10-')
  const previous = process.env.DSH_HOME
  try {
    // updateLastRun берёт каталог из DSH_HOME: не трогаем реальный ~/.dsh.
    process.env.DSH_HOME = home
    const { updateLastRun } = await import('../index.js')
    await recordRun(home, { ok: true, action: 'sync', message: 'первый запуск' })
    assert.equal((await readHistory(home, 50)).length, 1)
    await updateLastRun({ ok: true, action: 'sync', message: 'уточнённый запуск' })
    const history = await readHistory(home, 50)
    assert.equal(history.length, 1, 'журнал не задублирован')
    const lastRun = JSON.parse(await readFile(join(home, 'dsh-sync', 'last-run.json'), 'utf8'))
    assert.equal(lastRun.message, 'уточнённый запуск')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('H10: в index.js доводка результата дочернего процесса не пишет в журнал повторно', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal((source.match(/writeLastRun\(\{ \.\.\.viaChild \}\)/g) ?? []).length, 0, 'нет повторных записях в журнал')
  assert.equal((source.match(/updateLastRun\(\{ \.\.\.viaChild \}\)/g) ?? []).length, 3, 'три доводки идут через last-run')
  // Ровно один вызов recordRun на «запуск»: хелпер writeLastRun + две точечные записи.
  assert.equal((source.match(/await recordRun\(/g) ?? []).length <= 3, true)
})
