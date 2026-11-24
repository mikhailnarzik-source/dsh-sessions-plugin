/**
 * M1-C: wiring дедупликации в движок, панель и CLI.
 *
 * Проверяем то, что нельзя проверить одними lib-тестами m1-identity:
 * - D2: импорт/pull не создаёт копию, если такая сессия уже есть локально под
 *   другим id — причина `duplicate` в summary и журнале (`duplicatesSkipped`);
 * - «Найти дубли»: маршрут `/api/dsh-sync/duplicates` отдаёт группы с
 *   каноническим id (рейтинг + дети), седьмую корзину плана и ничего не пишет;
 * - действие «Убрать дубли в карантин»: без confirm — 409, с confirm лишние
 *   копии уходят в `_deleted` с причиной `duplicate`, каноническая не тронута;
 * - восстановление: rankCandidates/chooseCanonical выбирают канонический id с
 *   детьми, restoredFrom в отчёте, проигравшие — superseded;
 * - client.js: корзина «Дубли», кнопки «Найти дубли» и карантина;
 * - cli.mjs: подпись корзины и read-only команда `duplicates`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { encodeSegment, readHeader, rewriteHeader } from '../lib/format.mjs'
import { readHistory } from '../lib/history.mjs'
import { collectDuplicateGroups, listQuarantineSessions, applyDeletions, pull, push } from '../lib/sync.mjs'
import { readTombstones } from '../lib/tombstones.mjs'
import { localSessionDir } from '../lib/store.mjs'

const LOG_NAME = 'session.v4.jsonl.zstd'
const PROJECT = 'alpha'
const PROJECT_PATH = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
const CREATED_AT = Date.UTC(2026, 10, 20, 10, 0, 0)

// --- помощники логов -------------------------------------------------------

function frameOf(event) {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))
}

function makeLog(header, events = []) {
  return Buffer.concat([frameOf(header), ...events.map(frameOf)])
}

function headerFor(id, options = {}) {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: options.createdAt ?? CREATED_AT,
    cwd: options.cwd ?? PROJECT_PATH,
    isSeeded: false,
    delegationDepth: options.parent === undefined ? 0 : 1,
  }
  if (options.parent !== undefined) header.parentSession = options.parent
  return header
}

function titleEvent(title, seq = 0) {
  return { type: 'session/title', seq, time: CREATED_AT + 500, data: { title } }
}

function userEvent(text, seq = 1) {
  return { type: 'user/message', seq, time: CREATED_AT + 1000, data: { content: [{ type: 'text', text }] } }
}

function assistantEvent(text, seq = 2) {
  return { type: 'assistant/message', seq, time: CREATED_AT + 1500, data: { content: [{ type: 'text', text }] } }
}

/** Копия лога: тот же хвост, другой id (contentHash нормализует id и cwd). */
function copyLog(log, patch) {
  const parsed = readHeader(log)
  return rewriteHeader(log, { ...parsed.header, ...patch }, parsed.frameEnd)
}

async function writeLocalLog(home, projectPath, id, bytes) {
  const dir = localSessionDir(home, projectPath, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG_NAME), bytes)
  return dir
}

// --- окружение -------------------------------------------------------------

async function makeHome(prefix = 'dsh-sync-m1-wiring-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  return { root, home }
}

/** Окружение с локальными дублями: a (родитель с ребёнком c) и b — его копия. */
async function setupDuplicateEnvironment(prefix = 'dsh-sync-m1-dupes-') {
  const { root, home } = await makeHome(prefix)
  const repoDir = join(root, 'mirror')
  await mkdir(repoDir, { recursive: true })
  const config = {
    ...defaultConfig(home),
    backend: 'folder',
    deviceId: 'device-wiring',
    repoDir,
    attachments: false,
    profile: { enabled: false },
    workspace: { enabled: false },
  }
  config.projects = { [PROJECT]: { path: PROJECT_PATH, title: PROJECT } }
  await saveConfig(home, config)
  const a = `session-${randomUUID()}`
  const b = `session-${randomUUID()}`
  const c = `session-${randomUUID()}`
  const aLog = makeLog(headerFor(a), [
    titleEvent('Диалог с субагентом'),
    userEvent('привет'),
    assistantEvent('ответ'),
  ])
  const bLog = copyLog(aLog, { id: b })
  const cLog = makeLog(headerFor(c, { parent: a }), [userEvent('задача субагента')])
  await writeLocalLog(home, PROJECT_PATH, a, aLog)
  await writeLocalLog(home, PROJECT_PATH, b, bLog)
  await writeLocalLog(home, PROJECT_PATH, c, cLog)
  await push({ home, config })
  return { root, home, repoDir, config, ids: { a, b, c }, logs: { a: aLog, b: bLog, c: cLog } }
}

// --- host-часть плагина в тесте (как в m0-c) ------------------------------

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
  const { apply } = await import('../index.js')
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

// --- D2: импорт с дедупликацией -------------------------------------------

test('D2: pull не создаёт копию, если та же сессия уже лежит локально под другим id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-m1-import-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const mirror = join(root, 'mirror')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(mirror, { recursive: true })
  const pathA = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const pathB = process.platform === 'win32' ? 'D:\\projects\\alpha' : '/home/user/alpha'
  const configA = { ...defaultConfig(homeA), backend: 'folder', deviceId: 'device-a', repoDir: mirror, profile: { enabled: false }, workspace: { enabled: false } }
  const configB = { ...defaultConfig(homeB), backend: 'folder', deviceId: 'device-b', repoDir: mirror, profile: { enabled: false }, workspace: { enabled: false } }
  configA.projects = { [PROJECT]: { path: pathA, title: PROJECT } }
  configB.projects = { [PROJECT]: { path: pathB, title: PROJECT } }
  await saveConfig(homeA, configA)
  await saveConfig(homeB, configB)
  try {
    const a = `session-${randomUUID()}`
    const b = `session-${randomUUID()}`
    const aLog = makeLog(headerFor(a, { cwd: pathA }), [
      titleEvent('Рабочий диалог'),
      userEvent('Покажи файлы проекта'),
      assistantEvent('Вот файлы'),
    ])
    await writeLocalLog(homeA, pathA, a, aLog)
    await push({ home: homeA, config: configA })

    // На втором устройстве уже есть копия под другим id (тот же хвост, свой путь).
    const bLog = copyLog(aLog, { id: b, cwd: pathB })
    const bDir = await writeLocalLog(homeB, pathB, b, bLog)

    const summary = await pull({ home: homeB, config: configB })
    assert.equal(summary.imported, 0, 'копия не создана')
    assert.equal(summary.duplicatesSkipped, 1, 'пропуск по причине duplicate посчитан')
    assert.deepEqual(summary.duplicateReasons, ['duplicate'])
    assert.equal(summary.duplicateIds.length, 1)
    assert.equal(summary.duplicateIds[0].id, a, 'пропущена приехавшая копия a')
    assert.equal(summary.duplicateIds[0].duplicateOf, b, 'найдена локальная копия b')
    assert.equal(summary.duplicateIds[0].match, 'contentHash')
    assert.equal(existsSync(localSessionDir(homeB, pathB, a)), false, 'нового каталога a нет')
    assert.equal(existsSync(bDir), true, 'локальная копия b не тронута')
    assert.equal(summary.projects[0].duplicatesSkipped, 1, 'счётчик есть и по проекту')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('D2: независимые сессии с разными id не считаются копиями и импортируются обе', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-m1-import2-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const mirror = join(root, 'mirror')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(mirror, { recursive: true })
  const pathA = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const pathB = process.platform === 'win32' ? 'D:\\projects\\alpha' : '/home/user/alpha'
  const configA = { ...defaultConfig(homeA), backend: 'folder', deviceId: 'device-a', repoDir: mirror, profile: { enabled: false }, workspace: { enabled: false } }
  const configB = { ...defaultConfig(homeB), backend: 'folder', deviceId: 'device-b', repoDir: mirror, profile: { enabled: false }, workspace: { enabled: false } }
  configA.projects = { [PROJECT]: { path: pathA, title: PROJECT } }
  configB.projects = { [PROJECT]: { path: pathB, title: PROJECT } }
  await saveConfig(homeA, configA)
  await saveConfig(homeB, configB)
  try {
    const first = `session-${randomUUID()}`
    const second = `session-${randomUUID()}`
    const firstLog = makeLog(headerFor(first, { cwd: pathA }), [userEvent('Первая сессия')])
    const secondLog = makeLog(headerFor(second, { cwd: pathA, createdAt: CREATED_AT + 60_000 }), [userEvent('Вторая сессия')])
    await writeLocalLog(homeA, pathA, first, firstLog)
    await writeLocalLog(homeA, pathA, second, secondLog)
    await push({ home: homeA, config: configA })

    const summary = await pull({ home: homeB, config: configB })
    assert.equal(summary.imported, 2, 'обе независимые сессии приняты')
    assert.equal(summary.duplicatesSkipped ?? 0, 0, 'ложных дублей нет')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- «Найти дубли»: lib-функция -------------------------------------------

test('collectDuplicateGroups: канонический id с детьми, лишняя копия и только чтение', async () => {
  const env = await setupDuplicateEnvironment()
  try {
    const before = await readHistory(env.home, 50)
    const report = await collectDuplicateGroups({ home: env.home, config: env.config })
    assert.equal(report.ok, true)
    assert.equal(report.readOnly, true, 'поиск помечен read-only')
    assert.equal(report.action, 'duplicates')
    assert.equal(report.count, 1, 'одна группа дублей')
    assert.equal(report.duplicates, 1, 'одна лишняя копия')
    const group = report.groups[0]
    assert.equal(group.canonicalId, env.ids.a, 'канонический — родитель с детьми')
    assert.equal(group.children >= 1, true, 'у канонического id есть дети')
    assert.equal(group.match, 'contentHash')
    assert.deepEqual(group.supersededIds, [env.ids.b])
    const canonical = group.sessions.find(item => item.id === env.ids.a)
    const loser = group.sessions.find(item => item.id === env.ids.b)
    assert.equal(canonical.canonical, true)
    assert.equal(loser.canonical, false)
    assert.equal(loser.side, 'both', 'копия есть и локально, и в зеркале')
    assert.match(report.message, /дубл/i)
    assert.deepEqual(await readHistory(env.home, 50), before, 'поиск не пишет журнал')
    assert.equal(existsSync(join(env.home, 'dsh-sync', 'last-run.json')), false, 'last-run поиском не создаётся')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('collectDuplicateGroups учитывает карантин: удалённая копия входит в группу', async () => {
  const env = await setupDuplicateEnvironment('dsh-sync-m1-quar-')
  try {
    // Убираем b из локального стора и зеркала обычным удалением — в карантин.
    await rm(localSessionDir(env.home, PROJECT_PATH, env.ids.b), { recursive: true, force: true })
    await applyDeletions({ home: env.home, config: env.config, confirm: true, ids: [env.ids.b] })
    const report = await collectDuplicateGroups({ home: env.home, config: env.config })
    assert.equal(report.count, 1, 'группа видна и после удаления копии')
    const group = report.groups[0]
    const quarantined = group.sessions.find(item => item.id === env.ids.b)
    assert.ok(quarantined, 'карантинная копия b в группе')
    assert.equal(quarantined.sides.includes('quarantine'), true, 'сторона quarantine отмечена')
    assert.ok((await listQuarantineSessions(env.repoDir, PROJECT)).some(item => item.id === env.ids.b))
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- маршруты «Найти дубли» и «Убрать дубли в карантин» --------------------

test('маршрут /duplicates: группы с каноническим id, read-only и 409 без подтверждения', async () => {
  const env = await setupDuplicateEnvironment('dsh-sync-m1-route-')
  let boot
  try {
    boot = await bootPlugin({ home: env.home })
    const historyBefore = await readHistory(env.home, 50)
    const scan = await boot.call('/api/dsh-sync/duplicates', {})
    assert.equal(scan.status, 200)
    assert.equal(scan.body.ok, true)
    assert.equal(scan.body.readOnly, true)
    assert.equal(scan.body.count, 1)
    assert.equal(scan.body.groups[0].canonicalId, env.ids.a)
    assert.deepEqual(scan.body.groups[0].supersededIds, [env.ids.b])
    assert.deepEqual(await readHistory(env.home, 50), historyBefore, 'маршрут поиска не пишет журнал')

    const denied = await boot.call('/api/dsh-sync/duplicates/quarantine', {})
    assert.equal(denied.status, 409, 'без confirm маршрут просит подтверждение')
    assert.equal(denied.body.code, 'confirm-required')
    assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.b), LOG_NAME)), true, 'без подтверждения копия на месте')
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('маршрут /duplicates/quarantine: лишняя копия в _deleted с reason duplicate, каноническая цела', async () => {
  const env = await setupDuplicateEnvironment('dsh-sync-m1-action-')
  let boot
  try {
    boot = await bootPlugin({ home: env.home })
    const canonicalBefore = await readFile(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.a), LOG_NAME))
    const result = await boot.call('/api/dsh-sync/duplicates/quarantine', { confirm: true })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.action, 'duplicates')
    assert.equal(result.body.quarantined, 1)
    assert.deepEqual(result.body.quarantinedIds, [env.ids.b])
    assert.equal(result.body.kept, 1)
    assert.deepEqual(result.body.keptIds, [env.ids.a])
    assert.deepEqual(result.body.reasons, ['duplicate'])

    // Каноническая копия не тронута — и в зеркале, и локально.
    assert.equal(
      (await readFile(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.a), LOG_NAME))).equals(canonicalBefore),
      true,
      'лог канонической копии не изменился',
    )
    assert.equal(existsSync(localSessionDir(env.home, PROJECT_PATH, env.ids.a)), true)
    assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.c), LOG_NAME)), true, 'ребёнок канонической копии цел')

    // Лишняя копия перенесена в карантин зеркала и локальный архив.
    assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.b))), false, 'живой копии b в зеркале нет')
    const deletedDir = join(env.repoDir, 'sessions', PROJECT, '_deleted', encodeSegment(env.ids.b))
    assert.equal(existsSync(join(deletedDir, LOG_NAME)), true, 'копия в _deleted')
    const deletedAt = JSON.parse(await readFile(join(deletedDir, 'deleted-at.json'), 'utf8'))
    assert.equal(deletedAt.reason, 'duplicate')
    assert.equal(existsSync(join(env.home, 'dsh-sync', 'deleted')), true, 'локальная копия в архиве устройства')

    const tombstones = await readTombstones(env.repoDir)
    assert.equal(tombstones.sessions[env.ids.b]?.reason, 'duplicate', 'метка с причиной duplicate')
    assert.equal(tombstones.sessions[env.ids.a], undefined, 'каноническая без метки')

    const lastRun = JSON.parse(await readFile(join(env.home, 'dsh-sync', 'last-run.json'), 'utf8'))
    assert.equal(lastRun.action, 'duplicates')
    assert.ok(lastRun.reasons.includes('duplicate'), 'журнал знает причину duplicate')
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- восстановление: рейтинг и canonical с детьми -------------------------

test('restore: канонический id выбирается рейтингом, проигравший — superseded, restoredFrom в отчёт', async () => {
  const env = await setupDuplicateEnvironment('dsh-sync-m1-restore-')
  let boot
  try {
    // Удаляем только родителя: ребёнок c остаётся живым в зеркале, поэтому у
    // канонического id a есть дети и рейтинг обязан выбрать именно его.
    await rm(localSessionDir(env.home, PROJECT_PATH, env.ids.a), { recursive: true, force: true })
    const deleted = await applyDeletions({ home: env.home, config: env.config, confirm: true, ids: [env.ids.a] })
    assert.equal(deleted.removed, 1, 'родитель удалён в карантин')
    assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, '_deleted', encodeSegment(env.ids.a), LOG_NAME)), true)

    boot = await bootPlugin({ home: env.home })
    const restored = await boot.call('/api/dsh-sync/restore', { id: env.ids.a })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.ok, true)
    assert.deepEqual(restored.body.restoredIds, [env.ids.a], 'восстановлен канонический id')
    assert.deepEqual(restored.body.canonicalIds, [env.ids.a], 'канонический id — с детьми')
    assert.equal(restored.body.restoreRank[0].canonicalId, env.ids.a)
    assert.equal(restored.body.restoreRank[0].children >= 1, true)
    assert.equal(restored.body.restoreRank[0].match, 'contentHash')
    assert.equal(restored.body.restoredFrom[env.ids.a], 'manual', 'restoredFrom — прежняя причина удаления')
    assert.ok(restored.body.superseded.includes(env.ids.b), 'проигравшая копия b отмечена superseded')
    assert.ok(restored.body.reasons.includes('superseded'))

    // Каноническая копия снова живая вместе с ребёнком, лишняя — в карантине.
    assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.a), LOG_NAME)), true)
    assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.c), LOG_NAME)), true)
    assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.b))), false)
    const loserDir = join(env.repoDir, 'sessions', PROJECT, '_deleted', encodeSegment(env.ids.b))
    assert.equal(existsSync(join(loserDir, LOG_NAME)), true, 'проигравший b в карантине')
    const deletedAt = JSON.parse(await readFile(join(loserDir, 'deleted-at.json'), 'utf8'))
    assert.equal(deletedAt.reason, 'superseded')
    const tombstones = await readTombstones(env.repoDir)
    assert.equal(tombstones.sessions[env.ids.b]?.reason, 'superseded')
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- CLI: команда duplicates ----------------------------------------------

test('CLI `dsh-sync duplicates` показывает группы и ничего не меняет', async () => {
  const env = await setupDuplicateEnvironment('dsh-sync-m1-cli-')
  try {
    const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
    const before = await readHistory(env.home, 50)
    const output = execFileSync(process.execPath, [cli, 'duplicates', '--home', env.home], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: env.home },
    })
    assert.match(output, /проверка дублей: ничего не изменено/)
    assert.match(output, /групп: 1/)
    assert.match(output, /канонический/)
    assert.ok(output.includes(env.ids.a), 'канонический id в выводе')
    assert.ok(output.includes(env.ids.b), 'лишняя копия в выводе')
    assert.deepEqual(await readHistory(env.home, 50), before, 'команда не пишет журнал')
    assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, encodeSegment(env.ids.b), LOG_NAME)), true, 'ничего не удалено')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- client.js: корзина «Дубли» и кнопки ----------------------------------

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let clientEntry
globalThis.window = { __ModuleLoader__: { load: (entry) => { clientEntry = entry } } }
const injectedStyles = []
globalThis.document = {
  documentElement: { style: {}, dataset: {} },
  body: {},
  createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
  head: { appendChild: (node) => { injectedStyles.push(node.textContent) } },
}
// eslint-disable-next-line no-new-func
new Function(clientSource)()

const MiniReact = {
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

function renderClient() {
  const dictionaries = {}
  const registrations = []
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
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, ready: true, config: {}, checks: [], history: [] }),
  })
  const exported = clientEntry.factory((id) => {
    if (id === 'react') return MiniReact
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`неожиданный require: ${id}`)
  })
  exported.apply(ctx)
  const main = registrations.find(entry => entry.options.name === 'main' && entry.options.key === 'dsh-sessions')
  assert.ok(main, 'страница синхронизации зарегистрирована')
  return { exported, main }
}

const resolveNode = (node) => {
  let current = node
  for (let step = 0; step < 40; step += 1) {
    if (current === null || current === undefined || typeof current !== 'object') return current
    const type = current.type
    if (typeof type !== 'function') break
    const children = current.children ?? []
    const props = { ...current.props, children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children }
    current = type.prototype && typeof type.prototype.render === 'function'
      ? new type(props).render()
      : type(props)
  }
  if (current === null || current === undefined || typeof current !== 'object') return current
  const flat = []
  const push = (child) => {
    if (Array.isArray(child)) child.forEach(push)
    else flat.push(child)
  }
  ;(current.children ?? []).forEach(push)
  return { type: current.type, props: current.props ?? {}, children: flat.map(child => resolveNode(child)) }
}

const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join(' ')
}

test('client: седьмая корзина «Дубли», кнопка «Найти дубли» и карточка карантина', async () => {
  const { exported, main } = renderClient()
  await new Promise((resolve) => setTimeout(resolve, 20))
  exported.__test.setHostState({ ok: true, ready: true, config: {}, checks: [], history: [], status: { local: 3, mirror: 3 } })

  // Корзина «Дубли» в плане: счётчик и список лишних копий.
  exported.__test.setPlan({
    ok: true,
    readOnly: true,
    action: 'plan',
    at: '2026-11-24T10:05:00.000Z',
    message: 'Проверка выполнена: ничего не изменено. Дублей: 1 (копии, можно оставить одну).',
    counts: { onlyLocal: 0, onlyCloud: 0, same: 1, localAhead: 0, cloudAhead: 0, conflicts: 0, duplicates: 1 },
    sizes: { onlyLocal: 0, onlyCloud: 0, same: 0, localAhead: 0, cloudAhead: 0, conflicts: 0, duplicates: 2048 },
    buckets: {
      onlyLocal: [],
      onlyCloud: [],
      same: [],
      localAhead: [],
      cloudAhead: [],
      conflicts: [],
      duplicates: [{ id: 'session-loser-1', canonicalId: 'session-canonical-1', match: 'contentHash', size: 2048 }],
    },
    duplicates: {
      count: 1,
      bytes: 2048,
      byContentHash: 1,
      byEventsBytes: 0,
      groups: [{
        canonicalId: 'session-canonical-1',
        match: 'contentHash',
        children: 1,
        sessions: [
          { id: 'session-canonical-1', side: 'both', canonical: true, sizeBytes: 1024, events: 3 },
          { id: 'session-loser-1', side: 'mirror', canonical: false, sizeBytes: 1024, events: 3 },
        ],
      }],
    },
    deletions: [],
    deletionCount: 0,
    localSkipped: 0,
    warnings: [],
  })
  let nodes = walk(resolveNode(main.component({})))
  let text = nodes.map(textOf).join('\n')
  assert.ok(nodes.some(node => textOf(node).includes('Дубли')), 'корзина «Дубли» в плане')
  assert.match(text, /Группы дублей/, 'группы дублей в плане')
  assert.match(text, /канонические помечены «=»/, 'подпись групп дублей')
  assert.ok(nodes.some(node => node.type === 'button' && textOf(node).trim() === 'Найти дубли'), 'кнопка «Найти дубли»')

  // Отчёт «Найти дубли»: карточка с группами и подтверждением действия.
  exported.__test.setDuplicates({
    ok: true,
    readOnly: true,
    action: 'duplicates',
    count: 1,
    duplicates: 1,
    groups: [{
      projectId: PROJECT,
      canonicalId: 'session-canonical-1',
      children: 1,
      match: 'contentHash',
      supersededIds: ['session-loser-1'],
      sessions: [
        { id: 'session-canonical-1', side: 'both', canonical: true },
        { id: 'session-loser-1', side: 'mirror', canonical: false },
      ],
    }],
    message: 'Найдено дублей: 1 (групп: 1).',
  })
  nodes = walk(resolveNode(main.component({})))
  text = nodes.map(textOf).join('\n')
  assert.match(text, /Найдено лишних копий: 1/, 'итог поиска виден')
  assert.match(text, /= каноническая session-canonical-1/, 'каноническая копия помечена')
  assert.match(text, /− лишняя session-loser-1/, 'лишняя копия помечена')
  assert.ok(nodes.some(node => node.type === 'button' && /Убрать дубли в карантин \(1\)/.test(textOf(node))), 'действие карантина')
  assert.ok(injectedStyles.some(css => String(css).includes('.dshs-duplicates-group')), 'стили групп дублей внедрены')
  assert.match(String(injectedStyles.join('\n')), /\.dshs-duplicates-groups\{[^}]*overflow-y:auto/, 'список групп прокручивается')

  exported.__test.setPlan(null)
  exported.__test.setDuplicates(null)
})
