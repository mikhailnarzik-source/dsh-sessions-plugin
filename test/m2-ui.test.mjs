/**
 * M2-B: UI и маршруты групп «родитель + субагенты».
 *
 * Проверяем то, что видно пользователю и что нельзя проверить lib-тестами M2-A:
 * - `/api/dsh-sync/sessions` отдаёт для каждой сессии groupId, parentSession,
 *   children/childrenCount, childrenMissingCount, orphan, groupSize, а также
 *   сводку групп и строку «групп: N, субагентов: M, сирот: K»;
 * - `/api/dsh-sync/state` показывает те же счётчики в статусе;
 * - `/api/dsh-sync/tombstones` — groupId и childrenCount у удалённых родителей;
 * - `/api/dsh-sync/restore` по id ребёнка возвращает всю группу и идемпотентен;
 * - client.js: субагенты вложены под родителем (свёрнуто, бейдж «+N»,
 *   раскрытие), счётчик в шапке карточки, бейдж «сирота», кнопка
 *   «Восстановить группу» в «Удалённых» и подтверждение удаления с числом детей;
 * - helper'ы отчёта: computeSessionGroupStats / decorateSessionGroupReport /
 *   decoratePruneChildren / tombstoneGroup.
 *
 * Запуск: node --import ./test/setup.mjs --test test/m2-ui.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir } from '../lib/store.mjs'
import {
  computeSessionGroupStats,
  decoratePruneChildren,
  decorateSessionGroupReport,
  subagentsPhrase,
  tombstoneGroup,
} from '../index.js'

const LOG_NAME = 'session.v4.jsonl.zstd'
const PROJECT = 'alpha'
const PROJECT_PATH = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
const CREATED_AT = Date.UTC(2026, 10, 20, 10, 0, 0)

// --- помощники логов и среды ----------------------------------------------

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

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m2-ui-'))
  const home = join(root, 'home')
  const repoDir = join(root, 'mirror')
  await mkdir(home, { recursive: true })
  await mkdir(join(repoDir, 'sessions', PROJECT), { recursive: true })
  const config = {
    ...defaultConfig(home),
    backend: 'folder',
    deviceId: 'device-m2-ui',
    repoDir,
    attachments: false,
    profile: { enabled: false },
    workspace: { enabled: false },
    autoSync: { enabled: false },
    sync: { autoPrune: false },
  }
  config.projects = { [PROJECT]: { path: PROJECT_PATH, title: PROJECT } }
  await saveConfig(home, config)
  return { root, home, repoDir, config }
}

/** Локальный лог сессии: заголовок + событие названия. Возвращает snapshot. */
async function writeLocalSession(home, id, options = {}) {
  const dir = localSessionDir(home, PROJECT_PATH, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, LOG_NAME)
  const header = headerFor(id, { parent: options.parent })
  await writeFile(path, makeLog(header, [titleEvent(options.title ?? `Сессия ${id.slice(-4)}`), userEvent('привет')]))
  return {
    header: { ...header },
    location: { path },
    title: options.title ?? '',
  }
}

/** Описание сессии в зеркале: отдаёт связи группы панели. */
async function writeMirrorSidecar(repoDir, id, sidecar) {
  const dir = join(repoDir, 'sessions', PROJECT, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.json'), `${JSON.stringify({ id, ...sidecar }, null, 2)}\n`, 'utf8')
  await writeFile(join(dir, LOG_NAME), makeLog(headerFor(id, { parent: sidecar.parent }), [titleEvent(sidecar.title ?? '')]))
}

/** Родитель, ребёнок, внук, сирота и одиночная сессия. */
async function makeFamily(env) {
  const ids = {
    parent: `session-${randomUUID()}`,
    child: `session-${randomUUID()}`,
    grandchild: `session-${randomUUID()}`,
    orphan: `session-${randomUUID()}`,
    standalone: `session-${randomUUID()}`,
    missingParent: `session-${randomUUID()}`,
    missingChild: `session-${randomUUID()}`,
  }
  const snapshots = []
  snapshots.push(await writeLocalSession(env.home, ids.parent, { title: 'Родитель группы' }))
  snapshots.push(await writeLocalSession(env.home, ids.child, { parent: ids.parent, title: 'Субагент' }))
  snapshots.push(await writeLocalSession(env.home, ids.grandchild, { parent: ids.child, title: 'Внук' }))
  snapshots.push(await writeLocalSession(env.home, ids.orphan, { parent: ids.missingParent, title: 'Сирота' }))
  snapshots.push(await writeLocalSession(env.home, ids.standalone, { title: 'Одиночная' }))
  // Родитель в зеркале знает двух детей: второго локально нет — «в облаке ещё 1».
  await writeMirrorSidecar(env.repoDir, ids.parent, {
    title: 'Родитель группы',
    children: [ids.child, ids.missingChild],
    root: ids.parent,
  })
  await writeMirrorSidecar(env.repoDir, ids.child, {
    title: 'Субагент',
    parent: ids.parent,
    children: [ids.grandchild],
    root: ids.parent,
  })
  const persistence = { list: async () => snapshots }
  return { ids, snapshots, persistence }
}

// --- host-часть плагина в тесте -------------------------------------------

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

async function bootPlugin({ home, persistence }) {
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
    get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
  }
  apply(ctx)
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

// --- 1. поля групп в /sessions --------------------------------------------

test('сессии: groupId, parentSession, children, childrenMissingCount, orphan, groupSize', async () => {
  const env = await makeEnvironment()
  const { ids, persistence } = await makeFamily(env)
  let boot
  try {
    boot = await bootPlugin({ home: env.home, persistence })
    assert.ok(boot.routes.has('/api/dsh-sync/sessions'), 'маршрут списка сессий зарегистрирован')

    const { status, body } = await boot.call('/api/dsh-sync/sessions', {})
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    const byId = new Map(body.sessions.map((row) => [row.id, row]))

    // Родитель: корень группы из трёх сессий, один ребёнок локально и один в зеркале.
    const parent = byId.get(ids.parent)
    assert.ok(parent, 'родитель в списке')
    assert.equal(parent.parentSession, '')
    assert.equal(parent.groupId, ids.parent, 'корень — сам родитель')
    assert.deepEqual(parent.children, [ids.child])
    assert.equal(parent.childrenCount, 1)
    assert.equal(parent.childrenMissingCount, 1, 'ребёнок из зеркала, которого нет локально')
    assert.deepEqual(parent.childrenMissing, [ids.missingChild])
    assert.equal(parent.orphan, false)
    assert.equal(parent.groupSize, 3, 'родитель + ребёнок + внук')

    // Субагент первого уровня: та же группа, свой ребёнок.
    const child = byId.get(ids.child)
    assert.equal(child.parentSession, ids.parent)
    assert.equal(child.groupId, ids.parent)
    assert.deepEqual(child.children, [ids.grandchild])
    assert.equal(child.groupSize, 3, 'размер группы одинаков у всех её участников')
    assert.equal(child.orphan, false)

    // Внук: корень — верхний родитель.
    const grandchild = byId.get(ids.grandchild)
    assert.equal(grandchild.parentSession, ids.child)
    assert.equal(grandchild.groupId, ids.parent)
    assert.deepEqual(grandchild.children, [])
    assert.equal(grandchild.childrenCount, 0)
    assert.equal(grandchild.groupSize, 3)

    // Сирота: родителя нет на этом устройстве — свой корень и признак orphan.
    const orphan = byId.get(ids.orphan)
    assert.equal(orphan.parentSession, ids.missingParent)
    assert.equal(orphan.orphan, true)
    assert.equal(orphan.parentMissing, true)
    assert.equal(orphan.groupId, ids.orphan, 'без родителя корень — сама сессия')
    assert.equal(orphan.groupSize, 1)

    // Одиночная сессия — не группа.
    const standalone = byId.get(ids.standalone)
    assert.equal(standalone.groupSize, 1)
    assert.equal(standalone.orphan, false)
    assert.deepEqual(standalone.children, [])

    // Сводка групп для шапки карточки и строки отчёта.
    assert.ok(body.groups, 'сводка групп в ответе')
    assert.equal(body.groups.count, 1, 'одна семья с детьми')
    assert.equal(body.groups.subagents, 3, 'ребёнок, внук и сирота')
    assert.equal(body.groups.orphans, 1)
    assert.match(body.groups.line, /^групп: 1, субагентов: 3, сирот: 1$/)
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('state: счётчики групп и строка «групп: N, субагентов: M, сирот: K»', async () => {
  const env = await makeEnvironment()
  const { persistence } = await makeFamily(env)
  let boot
  try {
    boot = await bootPlugin({ home: env.home, persistence })
    const { status, body } = await boot.call('/api/dsh-sync/state', {})
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.ok(body.status, 'статус в ответе')
    assert.equal(body.status.groups, 1)
    assert.equal(body.status.orphans, 1)
    assert.match(body.status.groupLine, /групп: 1, субагентов: 3, сирот: 1/)
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 2. «Удалённые»: группа у надгробий ------------------------------------

test('«Удалённые»: groupId и childrenCount для удалённых родителей и сирота', async () => {
  const env = await makeEnvironment()
  const parent = `session-${randomUUID()}`
  const child = `session-${randomUUID()}`
  const grandchild = `session-${randomUUID()}`
  const orphan = `session-${randomUUID()}`
  const missingParent = `session-${randomUUID()}`
  const at = new Date().toISOString()
  await writeFile(join(env.repoDir, 'tombstones.json'), JSON.stringify({
    version: 2,
    sessions: {
      [parent]: { at, device: 'device-a', reason: 'manual', by: 'owner', title: 'Родитель группы' },
      [child]: { at, device: 'device-a', reason: 'children', by: 'owner', parent, title: 'Субагент' },
      [grandchild]: { at, device: 'device-a', reason: 'children', by: 'owner', parent: child, title: 'Внук' },
      [orphan]: { at, device: 'device-a', reason: 'children', by: 'owner', parent: missingParent, title: 'Сирота' },
    },
  }, null, 2), 'utf8')
  let boot
  try {
    boot = await bootPlugin({ home: env.home, persistence: { list: async () => [] } })
    const { status, body } = await boot.call('/api/dsh-sync/tombstones', {})
    assert.equal(status, 200)
    assert.equal(body.count, 4)
    const byId = new Map(body.sessions.map((row) => [row.id, row]))

    const parentRow = byId.get(parent)
    assert.equal(parentRow.groupId, parent)
    assert.equal(parentRow.childrenCount, 1)
    assert.equal(parentRow.children.length, 1)
    assert.equal(parentRow.groupSize, 3, 'удалена вся семья: родитель + двое')
    assert.equal(parentRow.parentSession, '')
    assert.equal(parentRow.orphan, false)

    const childRow = byId.get(child)
    assert.equal(childRow.groupId, parent, 'ребёнок относится к группе родителя')
    assert.equal(childRow.parentSession, parent)
    assert.equal(childRow.childrenCount, 1)

    const grandchildRow = byId.get(grandchild)
    assert.equal(grandchildRow.groupId, parent)
    assert.equal(grandchildRow.groupSize, 3)

    const orphanRow = byId.get(orphan)
    assert.equal(orphanRow.orphan, true, 'родителя нет в списке удалённых')
    assert.equal(orphanRow.groupId, orphan)
    assert.equal(orphanRow.groupSize, 1)
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 3. restore: id ребёнка возвращает всю группу --------------------------

async function writeTombstoneGroup(env, ids) {
  const at = new Date().toISOString()
  const entries = {
    [ids.parent]: { at, device: 'device-a', reason: 'manual', by: 'owner', title: 'Родитель группы' },
    [ids.child]: { at, device: 'device-a', reason: 'children', by: 'owner', parent: ids.parent, title: 'Субагент' },
    [ids.grandchild]: { at, device: 'device-a', reason: 'children', by: 'owner', parent: ids.child, title: 'Внук' },
  }
  await writeFile(join(env.repoDir, 'tombstones.json'), JSON.stringify({ version: 2, sessions: entries }, null, 2), 'utf8')
  for (const [id, entry] of Object.entries(entries)) {
    const dir = join(env.repoDir, 'sessions', PROJECT, '_deleted', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, LOG_NAME), makeLog(headerFor(id, { parent: entry.parent }), [titleEvent(entry.title)]))
    await writeFile(join(dir, 'session.json'), `${JSON.stringify({ id, title: entry.title })}\n`, 'utf8')
    await writeFile(join(dir, 'deleted-at.json'), `${JSON.stringify({
      at,
      reason: entry.reason,
      by: 'owner',
      device: 'device-a',
      ...(entry.parent === undefined ? {} : { parent: entry.parent }),
      size: 3,
    })}\n`, 'utf8')
  }
}

test('restore по id ребёнка возвращает всю группу и идемпотентен', async () => {
  const env = await makeEnvironment()
  const ids = {
    parent: `session-${randomUUID()}`,
    child: `session-${randomUUID()}`,
    grandchild: `session-${randomUUID()}`,
  }
  await writeTombstoneGroup(env, ids)
  let boot
  try {
    boot = await bootPlugin({ home: env.home, persistence: { list: async () => [] } })
    const restored = await boot.call('/api/dsh-sync/restore', { id: ids.child })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.ok, true)
    assert.equal(restored.body.restored, 3, 'вернулись родитель, ребёнок и внук')
    assert.deepEqual([...restored.body.restoredIds].sort(), [ids.parent, ids.child, ids.grandchild].sort())
    assert.ok(restored.body.restoredGroup, 'в отчёте есть restoredGroup')
    assert.equal(restored.body.restoredGroup.root, ids.parent, 'корень восстановленной группы')
    assert.equal(restored.body.restoredGroup.size, 3)
    assert.equal(restored.body.restoredGroup.children, 2)
    assert.equal(restored.body.restoredGroup.group, true)
    assert.equal(restored.body.restoredGroup.requested[0], ids.child, 'начали с ребёнка')
    assert.match(restored.body.message, /вся группа/)
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(join(env.repoDir, 'sessions', PROJECT, id, LOG_NAME)), true, `в зеркале снова есть ${id}`)
      assert.equal(existsSync(localSessionDir(env.home, PROJECT_PATH, id)), true, `локально появилась ${id}`)
    }

    // Повторный вызов ничего не ломает: метки уже сняты, группа на месте.
    const again = await boot.call('/api/dsh-sync/restore', { id: ids.child })
    assert.equal(again.status, 200)
    assert.equal(again.body.ok, true)
    assert.equal(again.body.restored, 0, 'идемпотентно: восстанавливать больше нечего')
    assert.match(again.body.message, /нечего/)
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 4. helper'ы отчёта и группы надгробий ---------------------------------

test('сводка групп: родитель с детьми — группа, сирота, одиночная', () => {
  const stats = computeSessionGroupStats([
    { id: 'session-p', parentSession: '' },
    { id: 'session-c', parentSession: 'session-p' },
    { id: 'session-g', parentSession: 'session-c' },
    { id: 'session-o', parentSession: 'session-missing' },
    { id: 'session-s', parentSession: '' },
  ])
  assert.equal(stats.groups, 1)
  assert.equal(stats.subagents, 3)
  assert.equal(stats.orphans, 1)
  assert.equal(stats.groupLine, 'групп: 1, субагентов: 3, сирот: 1')
  // Пустой список — нули, без исключений.
  assert.deepEqual(computeSessionGroupStats(), {
    sessions: 0,
    groups: 0,
    subagents: 0,
    orphans: 0,
    groupLine: 'групп: 0, субагентов: 0, сирот: 0',
  })
})

test('отчёт синхронизации: строка групп дописывается один раз', () => {
  const record = { ok: true, message: 'принято: 1' }
  decorateSessionGroupReport(record, [{ id: 'session-p', parentSession: '' }, { id: 'session-c', parentSession: 'session-p' }])
  assert.equal(record.groupsCount, 1)
  assert.equal(record.orphanCount, 0)
  assert.match(record.message, /принято: 1; групп: 1, субагентов: 1, сирот: 0/)
  // Повторная доводка (host после дочернего процесса) строку не дублирует.
  decorateSessionGroupReport(record, [{ id: 'session-p', parentSession: '' }, { id: 'session-c', parentSession: 'session-p' }])
  assert.equal((record.message.match(/групп:/g) ?? []).length, 1)
  // Запись об ошибке строку групп не получает: там важна причина.
  const failed = decorateSessionGroupReport({ ok: false, message: 'boom' }, [])
  assert.equal(failed.message, 'boom')
})

test('удаление родителя: «вместе с N субагентами» в отчёте', () => {
  const record = decoratePruneChildren({ ok: true, message: 'удалено в карантин: 3', prune: { childrenQuarantined: 2 } })
  assert.equal(record.childrenQuarantined, 2)
  assert.match(record.message, /вместе с 2 субагентами/)
  // Одиночное удаление фразу не получает.
  const alone = decoratePruneChildren({ ok: true, message: 'удалено в карантин: 1' })
  assert.equal(alone.childrenQuarantined, 0)
  assert.doesNotMatch(alone.message, /вместе с/)
  assert.equal(subagentsPhrase(1), '1 субагентом')
  assert.equal(subagentsPhrase(2), '2 субагентами')
  assert.equal(subagentsPhrase(5), '5 субагентами')
  assert.equal(subagentsPhrase(11), '11 субагентами')
  assert.equal(subagentsPhrase(21), '21 субагентом')
})

test('tombstoneGroup: корень вверх, дети вниз, метки recovered не в группе', () => {
  const tombstones = {
    sessions: {
      'session-p': { at: new Date().toISOString(), reason: 'manual' },
      'session-c1': { at: new Date().toISOString(), reason: 'children', parent: 'session-p' },
      'session-c2': { at: new Date().toISOString(), reason: 'children', parent: 'session-p' },
      'session-old': { at: new Date().toISOString(), reason: 'restored' },
    },
  }
  const fromChild = tombstoneGroup({ tombstones, id: 'session-c1' })
  assert.equal(fromChild.root, 'session-p')
  assert.deepEqual([...fromChild.ids].sort(), ['session-c1', 'session-c2', 'session-p'])
  assert.equal(fromChild.children, 2)
  const fromParent = tombstoneGroup({ tombstones, id: 'session-p' })
  assert.equal(fromParent.size, 3)
  // Снятая метка в группу не попадает.
  const restored = tombstoneGroup({ tombstones, id: 'session-old' })
  assert.deepEqual(restored.ids, ['session-old'])
  assert.equal(restored.size, 1)
})

// --- 5. client.js: вложенность, счётчик, «сирота», удаление и restore ------

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
  useRef: (initial) => ({ current: initial ?? null }),
}

function renderClient() {
  const dictionaries = {}
  const registrations = []
  const ctx = {
    effect: (fn) => { fn() },
    locale: {
      // Словари двух видов: основной плагин регистрирует { en, ru } сразу,
      // плагин удаления — по одному языку (locale, dictionary).
      bind: (ns) => (key, params) => {
        const dict = dictionaries[ns]
        if (dict === undefined || dict === null || typeof dict !== 'object') return key
        const raw = dict.ru !== undefined && typeof dict.ru === 'object' ? (dict.ru[key] ?? key) : key
        if (params === undefined || params === null) return raw
        return String(raw).replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      },
      subscribe: () => () => {},
      register: (ns, localeOrDict, maybeDict) => {
        if (maybeDict !== undefined) {
          const current = dictionaries[ns]
          dictionaries[ns] = current !== null && typeof current === 'object' ? { ...current, [localeOrDict]: maybeDict } : { [localeOrDict]: maybeDict }
          return
        }
        dictionaries[ns] = localeOrDict
      },
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
  const main = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'dsh-sessions')
  assert.ok(main, 'страница синхронизации зарегистрирована')
  return { exported, registrations, main, dictionaries }
}

const resolveNode = (node) => {
  let current = node
  for (let step = 0; step < 60; step += 1) {
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
    else if (child !== null && child !== undefined) flat.push(child)
  }
  ;(current.children ?? []).forEach(push)
  return { type: current.type, props: current.props ?? {}, children: flat.map((child) => resolveNode(child)) }
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

/** Сессии для панели: группа из трёх, сирота и одиночная. */
function panelSessions() {
  return [
    {
      id: 'session-p', title: 'Родитель группы', shortId: 'parent', path: PROJECT_PATH, projectId: PROJECT,
      mode: 'cloud', badge: 'synced', parentSession: '', groupId: 'session-p', children: ['session-c'],
      childrenCount: 1, childrenMissing: ['session-missing'], childrenMissingCount: 1, orphan: false, groupSize: 3,
    },
    {
      id: 'session-c', title: 'Субагент', shortId: 'child', path: PROJECT_PATH, projectId: PROJECT,
      mode: 'cloud', badge: 'synced', parentSession: 'session-p', groupId: 'session-p', children: ['session-g'],
      childrenCount: 1, childrenMissing: [], childrenMissingCount: 0, orphan: false, groupSize: 3,
    },
    {
      id: 'session-g', title: 'Внук', shortId: 'grandchild', path: PROJECT_PATH, projectId: PROJECT,
      mode: 'cloud', badge: 'synced', parentSession: 'session-c', groupId: 'session-p', children: [],
      childrenCount: 0, childrenMissing: [], childrenMissingCount: 0, orphan: false, groupSize: 3,
    },
    {
      id: 'session-o', title: 'Сирота', shortId: 'orphan', path: PROJECT_PATH, projectId: PROJECT,
      mode: 'cloud', badge: 'offline', parentSession: 'session-missing', groupId: 'session-o', children: [],
      childrenCount: 0, childrenMissing: [], childrenMissingCount: 0, orphan: true, groupSize: 1,
    },
    {
      id: 'session-s', title: 'Одиночная', shortId: 'standalone', path: PROJECT_PATH, projectId: PROJECT,
      mode: 'local', badge: 'synced', parentSession: '', groupId: 'session-s', children: [],
      childrenCount: 0, childrenMissing: [], childrenMissingCount: 0, orphan: false, groupSize: 1,
    },
  ]
}

test('UI: субагенты свёрнуты под родителем, бейдж «+N», раскрытие по клику', () => {
  const { exported } = renderClient()
  const sessions = panelSessions()

  // Свёрнуто по умолчанию: дети в список не попадают.
  const collapsed = exported.__test.sessionGroupRows(sessions, new Set())
  assert.deepEqual(collapsed.map((row) => row.session.id), ['session-p', 'session-o', 'session-s'])
  assert.equal(collapsed[0].isParent, true)
  assert.equal(collapsed[0].depth, 0)
  assert.deepEqual(collapsed[0].children, ['session-c'])
  assert.equal(collapsed[0].expanded, false)

  // Раскрыли родителя — появился ребёнок, внук всё ещё спрятан.
  const opened = exported.__test.sessionGroupRows(sessions, new Set(['session-p']))
  assert.deepEqual(opened.map((row) => row.session.id), ['session-p', 'session-c', 'session-o', 'session-s'])
  assert.equal(opened[1].depth, 1)
  assert.equal(opened[1].isParent, true, 'у ребёнка тоже есть дети')
  assert.equal(opened[1].expanded, false)

  // Раскрыли и ребёнка — внук на втором уровне.
  const deep = exported.__test.sessionGroupRows(sessions, new Set(['session-p', 'session-c']))
  assert.deepEqual(deep.map((row) => row.session.id), ['session-p', 'session-c', 'session-g', 'session-o', 'session-s'])
  assert.equal(deep[2].depth, 2)

  // Сирота показывается верхним уровнем: родителя нет в списке.
  assert.equal(deep.find((row) => row.session.id === 'session-o').depth, 0)

  // В панели свёрнутая строка родителя рисует кнопку «+1» и не рисует ребёнка.
  const rendered = renderClient()
  rendered.exported.__test.setSessionStates({ ok: true, sessions })
  const tree = resolveNode(rendered.main.component({}))
  const nodes = walk(tree)
  const toggle = nodes.find((node) => node.props?.className === 'dshs-group-toggle')
  assert.ok(toggle, 'кнопка раскрытия группы есть у родителя')
  assert.equal(textOf(toggle).trim(), '+1', 'бейдж «+N» — число свёрнутых субагентов')
  assert.equal(toggle.props['aria-expanded'], 'false')
  const rowTexts = nodes.filter((node) => node.props?.className === 'dshs-modes-row').map(textOf).join('\n')
  assert.match(rowTexts, /Родитель группы/, 'родитель в списке')
  assert.doesNotMatch(rowTexts, /Внук/, 'внук свёрнут')
  const subRows = nodes.filter((node) => node.props?.className === 'dshs-modes-row' && node.props?.['data-subagent'] === 'true')
  assert.equal(subRows.length, 0, 'свёрнутый субагент не рисуется')
})

test('UI: счётчик групп в шапке карточки «Сессии и режим»', () => {
  const { exported, main } = renderClient()
  exported.__test.setSessionStates({ ok: true, sessions: panelSessions(), groups: { count: 1, subagents: 3, orphans: 1, line: 'групп: 1, субагентов: 3, сирот: 1' } })
  const tree = resolveNode(main.component({}))
  const counter = walk(tree).find((node) => node.props?.className === 'dshs-groups-counter')
  assert.ok(counter, 'счётчик в шапке карточки найден')
  assert.equal(textOf(counter).trim(), 'групп: 1, субагентов: 3, сирот: 1')
  assert.equal(counter.props['data-groups'], '1')
  assert.equal(counter.props['data-subagents'], '3')

  // Сводка считается и без host-поля groups: по childrenCount/groupSize.
  const summary = exported.__test.sessionGroupSummary(panelSessions())
  assert.equal(summary.groups, 1)
  assert.equal(summary.subagents, 3)
  assert.equal(summary.orphans, 1)

  // Стили групп внедряются: бейдж, «сирота», счётчик.
  const css = injectedStyles.join('\n')
  assert.match(css, /\.dshs-group-toggle\{/)
  assert.match(css, /\.dshs-group-badge\{/)
  assert.match(css, /\.dshs-orphan-badge\{/)
  assert.match(css, /\.dshs-groups-counter\{/)
})

test('UI: бейдж «сирота» с подсказкой у субагента без родителя', () => {
  const { exported, main } = renderClient()
  const sessions = panelSessions()
  exported.__test.setSessionStates({ ok: true, sessions })
  const tree = resolveNode(main.component({}))
  const nodes = walk(tree)
  const orphanRow = nodes.find((node) => node.props?.className === 'dshs-modes-row' && node.props?.['data-orphan'] === 'true')
  assert.ok(orphanRow, 'строка сироты помечена для оформления')
  const badge = nodes.find((node) => node.props?.className === 'dshs-orphan-badge')
  assert.ok(badge, 'бейдж «сирота» есть')
  assert.equal(textOf(badge).trim(), 'сирота')
  assert.match(String(badge.props.title), /Родитель.*не найден/, 'подсказка объясняет, почему сирота')
  // У обычного субагента бейджа нет.
  assert.equal(nodes.filter((node) => node.props?.className === 'dshs-orphan-badge').length, 1)
})

test('UI: «Удалённые» — восстановление группы одной кнопкой', () => {
  const { exported, main } = renderClient()
  const at = new Date().toISOString()
  exported.__test.setTombstones({
    ok: true,
    count: 3,
    sessions: [
      { id: 'session-p', title: 'Родитель группы', reason: 'manual', by: 'owner', at, canRestore: true, quarantined: true, remainingDays: 30, groupId: 'session-p', parentSession: '', children: ['session-c'], childrenCount: 1, groupSize: 2, orphan: false },
      { id: 'session-c', title: 'Субагент', reason: 'children', by: 'owner', at, canRestore: true, quarantined: true, remainingDays: 30, groupId: 'session-p', parentSession: 'session-p', children: [], childrenCount: 0, groupSize: 2, orphan: false },
      { id: 'session-o', title: 'Сирота', reason: 'children', by: 'owner', at, canRestore: true, quarantined: true, remainingDays: 30, groupId: 'session-o', parentSession: 'session-missing', children: [], childrenCount: 0, groupSize: 1, orphan: true },
    ],
  })
  const tree = resolveNode(main.component({}))
  const nodes = walk(tree)
  const buttons = nodes.filter((node) => node.type === 'button').map((node) => textOf(node).trim())
  assert.ok(buttons.some((text) => /^Восстановить группу/.test(text)), 'кнопка восстановления группы')
  assert.ok(nodes.some((node) => node.props?.className === 'dshs-group-badge' && textOf(node).includes('+1')), 'бейдж «+N» у удалённого родителя')
  const orphanBadge = nodes.find((node) => node.props?.className === 'dshs-orphan-badge')
  assert.ok(orphanBadge, 'удалённая сирота помечена')
  const rows = nodes.filter((node) => node.props?.className === 'dshs-deleted-row')
  assert.equal(rows.length, 3)
  const parentRow = rows.find((row) => textOf(row).includes('Родитель группы'))
  assert.match(textOf(parentRow), /вместе с 1 субагентом/, 'в строке удалённого родителя — сколько детей ушло с ним')
})

test('UI: подтверждение удаления показывает, что уйдут субагенты', () => {
  const { exported, registrations } = renderClient()
  const dialog = registrations.find((entry) => entry.options.name === 'shell.overlay' && entry.options.id === 'session-delete.dialog')
  assert.ok(dialog, 'диалог удаления зарегистрирован')
  assert.ok(exported.__test.deleteDialog, 'есть крючок состояния диалога')

  // Считаем детей по списку связанных сессий.
  const related = [
    { sessionId: 'session-parent', relation: 'parent', depth: 0, title: 'Родитель', running: false },
    { sessionId: 'session-c1', relation: 'child', depth: 1, title: 'Субагент 1', running: false },
    { sessionId: 'session-c2', relation: 'child', depth: 1, title: 'Субагент 2', running: false },
  ]
  assert.equal(exported.__test.deleteDialog.relatedChildren(related), 2)
  assert.deepEqual(exported.__test.deleteDialog.relatedSummary(related), { total: 3, children: 2, parents: 1 })

  // Подтверждение (шаг ввода слова): предупреждение с числом субагентов.
  exported.__test.deleteDialog.setState({
    open: true,
    target: { sessionId: 'session-c1', displayTitle: 'Субагент 1' },
    step: 'word',
    draft: 'delete',
    info: {
      ok: true,
      session: { sessionId: 'session-c1', title: 'Субагент 1' },
      related,
      files: [],
      live: false,
      running: false,
    },
    error: null,
    busy: false,
  })
  const dialogTree = resolveNode(dialog.component({}))
  const dialogText = textOf(dialogTree)
  assert.match(dialogText, /Вместе с этой сессией будут удалены субагенты: 2/, 'в подтверждении видно число субагентов')
  assert.match(dialogText, /Подтверждение удаления/)
  const dialogButtons = walk(dialogTree).filter((node) => node.type === 'button').map((node) => textOf(node).trim())
  assert.ok(dialogButtons.includes('Да'), 'кнопка подтверждения на месте')
  assert.ok(dialogButtons.includes('Нет'), 'кнопка отмены на месте')

  // Шаг «связанные сессии»: то же предупреждение до ввода слова.
  exported.__test.deleteDialog.setState({ step: 'related', draft: '' })
  const relatedTree = resolveNode(dialog.component({}))
  assert.match(textOf(relatedTree), /Вместе с этой сессией будут удалены субагенты: 2/)
  // Без детей предупреждения нет.
  exported.__test.deleteDialog.setState({
    step: 'word',
    info: { ok: true, session: { title: 'Одиночная' }, related: [{ sessionId: 'x', relation: 'parent' }], files: [] },
  })
  const singleTree = resolveNode(dialog.component({}))
  assert.doesNotMatch(textOf(singleTree), /будут удалены субагенты/)
})
