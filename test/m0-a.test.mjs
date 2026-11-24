/**
 * M0, агент A: индикатор без пустых мест (H1), причины надгробий (H8),
 * проверка версии (H11), errorKind/failures в панели (H9-client) и подписи
 * сессий title/shortId (H2-client).
 *
 * Клиентская часть грузится в поддельном окне, как в соседних тестах: настоящий
 * React и сеть не нужны.
 *
 * Запуск: node --test test/m0-a.test.mjs
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TOMBSTONE_REASONS,
  addTombstone,
  isActiveTombstone,
  readTombstones,
  writeTombstones,
} from '../lib/tombstones.mjs'
import {
  UPDATE_NAME,
  UPDATE_REPOSITORY,
  UPDATE_SPEC,
  checkForUpdate,
  describeUpdate,
  updateState,
} from '../lib/update.js'

/* --------------------------------------------------------------- client.js */

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let loaded
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }

const styles = []
globalThis.document = {
  documentElement: { style: {}, dataset: {} },
  body: {},
  createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
  head: { appendChild: (node) => { styles.push(node.textContent) } },
}

// eslint-disable-next-line no-new-func
new Function(source)()
assert.equal(loaded?.id, 'dsh-sessions', 'клиент грузится под именем пакета')

// Мини-React: ровно то, что использует клиент (состояние и эффекты).
// Булевы состояния сразу «включены»: так в тесте видны и свёрнутые по умолчанию
// списки плана и удалений, где и проверяются подписи сессий.
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
  useState: (initial) => {
    const value = typeof initial === 'function' ? initial() : initial
    return [value === false ? true : value, () => {}]
  },
  useEffect: () => {},
  useReducer: (reducer, initial) => [initial, () => {}],
}

const requireStub = (id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return { createPortal: (node) => node }
  throw new Error(`неожиданный require: ${id}`)
}

// Ответ host-части: минимальное состояние, на котором страница рисуется.
const readyState = {
  ok: true,
  ready: true,
  mode: 'builtin',
  version: '1.0.66',
  config: {
    backend: 'git',
    remote: 'https://github.com/user/dsh-sessions.git',
    projectPath: 'C:\\work\\project',
    projectId: 'harness',
    attachments: true,
    autoUpdate: true,
    secondary: { backend: 'folder', folderDir: 'C:\\cloud\\backup' },
  },
  secondary: {
    enabled: true,
    backend: 'folder',
    folderDir: 'C:\\cloud\\backup',
    recommended: 'folder',
    initialized: false,
    compare: null,
  },
  checks: [],
  status: { local: 1, mirror: 1, onlyLocal: 0, onlyMirror: 0, subagents: 0, subagentsAvailable: 0 },
  external: { found: false },
  lastRun: { at: '2026-11-22T10:00:00.000Z', ok: false, message: 'ошибка синхронизации' },
  history: [],
  backup: { percent: 100 },
  pending: false,
}
let hostState = readyState

const fetchCalls = []
globalThis.fetch = async (url) => {
  const target = String(url)
  fetchCalls.push(target)
  const payload = target.endsWith('/sessions') ? { ok: true, sessions: [] } : hostState
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }
}

const dictionaries = {}
const registrations = []
const ctx = {
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
}

const exported = loaded.factory(requireStub)
exported.apply(ctx)

const api = exported.__test
assert.ok(api?.SessionSyncIndicator, 'крючок индикатора доступен тесту')

// ---- раскрытие дерева компонентов (как в client-render.test.mjs) ----------

const resolveNode = (node) => {
  let current = node
  for (let step = 0; step < 40; step += 1) {
    if (current === null || current === undefined || typeof current !== 'object') return current
    const type = current.type
    if (typeof type !== 'function') break
    const children = current.children ?? []
    const props = {
      ...current.props,
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    }
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
  return {
    type: current.type,
    props: current.props ?? {},
    children: flat.map((child) => resolveNode(child)),
  }
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

const renderPage = () => {
  const main = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'dsh-sessions')
  assert.ok(main, 'страница синхронизации зарегистрирована')
  return resolveNode(main.component({}))
}

const pageText = () => walk(renderPage()).map(textOf).join('\n')

/* -------------------------------------------------- H1: индикатор без дыр */

const findIndicator = (sessionId) => {
  const slot = registrations.find((entry) => entry.options.name === 'sidebar.session.row.leading')
  const slotNode = resolveNode(slot.component({ sessionId }))
  assert.ok(slotNode, 'слот индикатора вернул элемент, а не null')
  return slotNode
}

test('H1: строка без данных снимка получает «ждёт», а не пустое место', () => {
  api.setSessionStates(null)

  const node = findIndicator('session-unknown')
  assert.ok(node, 'индикатор не null')
  assert.equal(node.props.className, 'dshs-ind')
  assert.equal(node.props['data-state'], 'pending', 'состояние pending')
  assert.equal(node.props.role, 'img')
  assert.equal(node.props.tabIndex, 0, 'доступен с клавиатуры')
  assert.match(node.props['aria-describedby'], /session-unknown/, 'подсказка привязана к этому id')
  assert.match(node.props.title, /Облачная сессия/, 'подпись говорит про облачную сессию')
  assert.match(node.props.title, /Ещё не уходила в зеркало/, 'причина понятна: сессия не уходила в облако')

  const bar = walk(node).find((child) => String(child.props?.className ?? '') === 'dshs-ind-bar-fill dshs-ind-bar-fill-pending')
  assert.ok(bar, 'полоса pending нарисована')
  assert.equal(bar.props.style.width, '55%', 'янтарное облако заполнено на 55 %')

  // Инвариант «у каждой строки есть иконка»: ни один вызов не даёт null.
  for (const id of ['session-a', 'session-b', 'session-c']) {
    assert.ok(findIndicator(id), `иконка есть для ${id}`)
  }
  assert.ok(api.SessionSyncIndicator({}), 'иконка есть даже без id')
  assert.ok(api.SessionSyncIndicator({ sessionId: undefined, session: undefined }), 'вызов с пустыми props не пустой')
})

test('H1: известная сессия рисуется по своему значку', () => {
  api.setSessionStates({
    ok: true,
    syncing: false,
    sessions: [
      { id: 'session-known', mode: 'cloud', badge: 'synced' },
      { id: 'session-known-local', mode: 'local', badge: 'local' },
    ],
  })
  const node = findIndicator('session-known')
  assert.equal(node.props['data-state'], 'synced')
  assert.equal(findIndicator('session-known-local').props['data-state'], 'local')
  api.setSessionStates(null)
})

test('H1: страница без снимка всё равно рисует индикаторы в строках', () => {
  api.setSessionStates({
    ok: true,
    syncing: false,
    sessions: [
      { id: 'session-one', title: 'Первая', mode: 'cloud', badge: 'never' },
      { id: 'session-two', title: 'Вторая', mode: 'cloud', badge: 'synced' },
    ],
  })
  const indicators = walk(renderPage()).filter((node) => String(node.props?.className ?? '') === 'dshs-ind')
  assert.equal(indicators.length, 2, 'у каждой строки есть индикатор')
  api.setSessionStates(null)
})

test('H1: запрос обновления снимка таймится и не дублируется', async () => {
  fetchCalls.length = 0
  api.requestSessionStatesRefresh()
  api.requestSessionStatesRefresh()
  assert.equal(
    fetchCalls.filter((url) => url.endsWith('/sessions')).length,
    1,
    'два запроса подряд дают одно обращение к /sessions',
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
})

/* ------------------------------------- H2-client: title и shortId в подписях */

test('H2-client: в тексте название, «Без названия» — без подмены id', () => {
  const untitled = api.sessionLabel({ id: 'session-abcdefgh-1234', title: '' })
  assert.equal(untitled.id, 'Без названия', 'безымянная сессия подписана словами')
  assert.equal(untitled.shortId, 'abcdefgh-1234', 'shortId хранится отдельно для tooltip')

  const titled = api.sessionLabel({ id: 'session-abcdefgh-1234', title: '  Мой   диалог  ', shortId: 'abcd…1234' })
  assert.equal(titled.id, 'Мой диалог', 'название показывается как есть (пробелы схлопнуты)')
  assert.equal(titled.shortId, 'abcd…1234', 'shortId от host-части имеет приоритет')

  assert.equal(api.shortSessionId('session-abcdefgh-1234'), 'abcdefgh-1234')
  assert.equal(api.shortSessionId('session-2'), '2')
  assert.equal(api.shortSessionId(''), '')
})

test('H2-client: строки режимов и удалённые — title в тексте, shortId в tooltip', () => {
  api.setSessionStates({
    ok: true,
    syncing: false,
    sessions: [
      { id: 'session-abcdefgh-1234', title: '', mode: 'cloud', badge: 'never' },
      { id: 'session-named', title: 'Названная сессия', mode: 'cloud', badge: 'synced' },
    ],
  })
  api.setTombstones({
    ok: true,
    quarantineDays: 30,
    count: 1,
    sessions: [
      { id: 'session-deleted-2', title: '', at: '2026-11-20T10:00:00.000Z', device: 'd', reason: 'manual', by: 'owner', quarantined: true, remainingDays: 27, expired: false, canRestore: true },
    ],
  })
  const nodes = walk(renderPage())
  const modeRows = nodes.filter((node) => String(node.props?.className ?? '') === 'dshs-modes-row')
  assert.equal(modeRows.length, 2, 'обе строки режимов на странице')

  const untitledRow = modeRows.find((node) => textOf(node).includes('Без названия'))
  assert.ok(untitledRow, 'безымянная сессия подписана «Без названия»')
  assert.equal(untitledRow.props.title, 'abcdefgh-1234', 'shortId только в tooltip строки')
  assert.equal(textOf(untitledRow).includes('abcdefgh'), false, 'id не подменяет название в тексте')

  const namedRow = modeRows.find((node) => textOf(node).includes('Названная сессия'))
  assert.ok(namedRow, 'название видно в строке')
  assert.equal(namedRow.props.title, 'named', 'tooltip — короткий id')

  const deletedRow = nodes.find((node) => String(node.props?.className ?? '') === 'dshs-deleted-row')
  assert.ok(deletedRow, 'удалённая сессия на странице')
  assert.match(textOf(deletedRow), /Без названия/)
  assert.equal(deletedRow.props.title, 'deleted-2', 'shortId удалённой сессии в tooltip')
  assert.equal(textOf(deletedRow).includes('deleted-2'), false, 'shortId не в тексте удалённой строки')
  api.setSessionStates(null)
  api.setTombstones(null)
})

test('H2-client: план — title в тексте, shortId в tooltip', () => {
  const plan = {
    ok: true,
    readOnly: true,
    action: 'plan',
    at: '2026-11-22T10:05:00.000Z',
    message: 'Проверка выполнена',
    counts: { onlyLocal: 0, onlyCloud: 1, same: 0, localAhead: 0, cloudAhead: 0, conflicts: 0 },
    sizes: {},
    buckets: { onlyLocal: [], onlyCloud: [{ id: 'session-cloud-1', title: '', size: 10 }], same: [], localAhead: [], cloudAhead: [], conflicts: [] },
    deletions: [
      { id: 'session-drop-2', title: '', humanReason: 'удалено вместе с родителем', reason: 'children', size: 256 },
    ],
    deletionCount: 1,
    localSkipped: 0,
    warnings: [],
  }
  api.setPlan(plan)
  const nodes = walk(renderPage())
  const text = nodes.map(textOf).join('\n')
  assert.match(text, /Без названия \(удалено вместе с родителем\)/, 'в удалениях плана — «Без названия», а не id')
  assert.match(text, /Без названия/, 'в корзинах плана — «Без названия»')
  const deletionRow = nodes.find(
    (node) => node.type === 'span' && textOf(node).includes('удалено вместе с родителем'),
  )
  assert.equal(deletionRow.props.title, 'drop-2', 'shortId удаления в tooltip')
  assert.equal(text.includes('session-drop-2'), false, 'полный id не показывается в тексте')
  api.setPlan(null)
})

/* ---------------------------------- H9-client: errorKind/failures в панели */

test('H9-client: строка последней ошибки из summary и из last-run', () => {
  assert.equal(
    api.lastErrorLine({ summary: { errorKind: 'network', failures: 3 } }),
    'последняя ошибка: network, неудач: 3',
  )
  assert.equal(
    api.lastErrorLine({ lastRun: { errorKind: 'auth', failures: ['a', 'b'] } }),
    'последняя ошибка: auth, неудач: 2',
  )
  assert.equal(api.lastErrorLine({ summary: { failures: 2 } }), 'неудач: 2')
  assert.equal(api.lastErrorLine({ summary: { errorKind: 'guard' } }), 'последняя ошибка: guard')
  assert.equal(api.lastErrorLine({ summary: { errorKind: '', failures: 0 } }), '')
  assert.equal(api.lastErrorLine({}), '')
})

test('H9-client: панель показывает вид ошибки и число неудач', () => {
  api.setHostState({
    ...readyState,
    lastRun: { at: '2026-11-22T10:00:00.000Z', ok: false, message: 'сбой' },
    summary: { errorKind: 'reserve', failures: 4 },
  })
  const text = pageText()
  assert.match(text, /последняя ошибка: reserve, неудач: 4/, 'строка с видом ошибки и числом неудач видна в панели')

  // Старый журнал без summary: поля пришли прямо в last-run.
  api.setHostState({
    ...readyState,
    lastRun: { at: '2026-11-22T10:00:00.000Z', ok: false, message: 'сбой', errorKind: 'format', failures: 1 },
  })
  assert.match(pageText(), /последняя ошибка: format, неудач: 1/, 'контракт last-run тоже работает')

  // Ошибок нет — строки нет.
  api.setHostState({ ...readyState, summary: { errorKind: '', failures: 0 } })
  assert.equal(pageText().includes('последняя ошибка'), false, 'без ошибок строки нет')
  api.setHostState(readyState)
})

/* --------------------- очередь повторов и shortId из ответа host-части */

test('очередь повторов: строка «в очереди: N» только при N>0', () => {
  const base = { ...readyState }
  assert.equal(api.outboxCount(base), 0, 'пустое состояние — очередь нулевая')
  assert.equal(api.outboxCount({ ...base, outboxCount: 2 }), 2, 'state.outboxCount')
  assert.equal(api.outboxCount({ ...base, outbox: { count: 3 } }), 3, 'state.outbox.count')
  assert.equal(api.outboxCount({ ...base, lastRun: { ...readyState.lastRun, outbox: { count: 1 } } }), 1, 'lastRun.outbox.count')
  assert.equal(api.outboxCount({ ...base, lastRun: { ...readyState.lastRun, outbox: 4 } }), 4, 'lastRun.outbox числом')
  assert.equal(api.outboxCount({ ...base, outboxCount: -1, outbox: { count: 0 } }), 0, 'ноль и минус не показываются')

  api.setHostState({ ...base, outboxCount: 2 })
  const rendered = walk(renderPage())
  const queueNode = rendered.find((node) => String(node.props?.['data-outbox'] ?? '') === '2')
  assert.ok(queueNode, 'строка очереди отрисована рядом со статусом')
  assert.equal(textOf(queueNode).trim(), 'в очереди: 2')
  assert.match(pageText(), /в очереди: 2/, 'счётчик виден в карточке «Синхронизация»')

  api.setHostState({ ...base, outbox: { count: 0, pending: [] } })
  assert.equal(pageText().includes('в очереди:'), false, 'пустая очередь строки не даёт')

  api.setHostState({ ...base, outbox: { count: 5 } })
  assert.match(pageText(), /в очереди: 5/, 'вложенный outbox.count тоже работает')

  api.setHostState({ ...base, lastRun: { ...readyState.lastRun, outbox: { count: 1 } } })
  assert.match(pageText(), /в очереди: 1/, 'lastRun.outbox тоже работает')
  api.setHostState(readyState)
})

test('H2-host: shortId из ответа host-части попадает в tooltip «Удалённых» и режимов', () => {
  api.setSessionStates({
    ok: true,
    syncing: false,
    sessions: [
      { id: 'session-abcdefgh-1234', title: 'Без названия', shortId: 'abcdefgh…1234', titleSource: 'fallback', mode: 'cloud', badge: 'never' },
    ],
  })
  api.setTombstones({
    ok: true,
    quarantineDays: 30,
    count: 1,
    sessions: [
      {
        id: 'session-deleted-2',
        title: 'Без названия',
        shortId: 'deleted-2',
        titleSource: 'fallback',
        at: '2026-11-20T10:00:00.000Z',
        device: 'd',
        reason: 'manual',
        by: 'owner',
        quarantined: true,
        remainingDays: 27,
        expired: false,
        canRestore: true,
      },
    ],
  })
  const nodes = walk(renderPage())
  const modeRow = nodes.find((node) => String(node.props?.className ?? '') === 'dshs-modes-row')
  assert.ok(modeRow, 'строка режимов найдена')
  assert.equal(modeRow.props.title, 'abcdefgh…1234', 'tooltip режимов — shortId из host-части')
  assert.match(textOf(modeRow), /Без названия/, 'в тексте — «Без названия»')

  const deletedRow = nodes.find((node) => String(node.props?.className ?? '') === 'dshs-deleted-row')
  assert.ok(deletedRow, 'строка «Удалённых» найдена')
  assert.equal(deletedRow.props.title, 'deleted-2', 'tooltip «Удалённых» — shortId из host-части')
  assert.match(textOf(deletedRow), /Без названия/, 'в тексте «Удалённых» — «Без названия»')
  api.setSessionStates(null)
  api.setTombstones(null)
})

/* --------------------------------------------------- H8: причины надгробий */

test('H8: новые причины надгробий не коэрсятся при чтении и записи', async () => {
  for (const reason of ['duplicate', 'made-local', 'superseded']) {
    assert.ok(TOMBSTONE_REASONS.includes(reason), `причина ${reason} в списке допустимых`)
  }
  assert.ok(TOMBSTONE_REASONS.includes('manual'), 'старые причины остались')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-sessions-m0-a-'))
  try {
    const data = await readTombstones(dir)
    for (const reason of ['duplicate', 'made-local', 'superseded']) {
      addTombstone(data, `session-${reason}`, 'device-a', { reason, by: 'sync', title: reason })
    }
    addTombstone(data, 'session-unknown', 'device-a', { reason: 'неизвестная', by: 'sync' })
    await writeTombstones(dir, data)

    const read = await readTombstones(dir)
    for (const reason of ['duplicate', 'made-local', 'superseded']) {
      assert.equal(read.sessions[`session-${reason}`].reason, reason, `причина ${reason} сохранилась`)
      assert.equal(isActiveTombstone(read.sessions[`session-${reason}`]), true, 'метка действует')
    }
    assert.equal(read.sessions['session-unknown'].reason, 'manual', 'неизвестная причина по-прежнему manual')

    const raw = JSON.parse(await readFile(join(dir, 'tombstones.json'), 'utf8'))
    assert.equal(raw.sessions['session-made-local'].reason, 'made-local', 'в файле причина записана как есть')
    assert.equal(raw.sessions['session-superseded'].reason, 'superseded')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------ H11: проверка версии */

test('H11: правильный репозиторий, имя пакета и версия с коммитом', async () => {
  assert.equal(UPDATE_REPOSITORY, 'mikhailnarzik-source/dsh-sessions-plugin')
  assert.equal(UPDATE_NAME, 'dsh-sessions')
  assert.equal(UPDATE_SPEC, 'github:mikhailnarzik-source/dsh-sessions-plugin')

  const oldHome = process.env.DSH_HOME
  const oldFetch = globalThis.fetch
  const sha = '83ee8a87508d47c56fdfa377b7d35cf8e3a1fe52'
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessions-m0-a-update-'))
  try {
    process.env.DSH_HOME = root
    await mkdir(join(root, 'dsh-sync'), { recursive: true })
    await writeFile(
      join(root, 'dsh-sync', 'installed-version.json'),
      `${JSON.stringify({ version: '1.0.66', installedCommit: sha, at: '2026-11-24T10:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    )

    const urls = []
    globalThis.fetch = async (url) => {
      urls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ sha, commit: { message: 'тестовый коммит', committer: { date: '2026-11-24T09:00:00Z' } } }),
      }
    }
    const state = await checkForUpdate()
    assert.equal(state.status, 'current', 'коммиты совпали — обновление не нужно')
    assert.equal(state.installed, sha, 'установленный коммит из installed-version.json')
    assert.match(String(state.version), /^\d+\.\d+\.\d+$/, 'версия пакета известна')
    assert.equal(urls[0], `https://api.github.com/repos/mikhailnarzik-source/dsh-sessions-plugin/commits/main`)
    assert.match(describeUpdate(), /обновление не требуется: v\d+\.\d+\.\d+ \(83ee8a8\)/, 'в подписи версия и короткий коммит')

    // Ветка ушла вперёд — статус «доступно обновление» с обеими подписями.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sha: 'ffffffffffffffffffffffffffffffffffffffff', commit: { message: 'новее', committer: { date: '2026-11-24T11:00:00Z' } } }),
    })
    const behind = await checkForUpdate()
    assert.equal(behind.status, 'behind')
    assert.match(describeUpdate(), /доступно обновление: v\d+\.\d+\.\d+ \(83ee8a8\) → fffffff/)

    // Ошибка сети/API — честный статус, а не «актуально».
    globalThis.fetch = async () => ({ ok: false, status: 403 })
    const failed = await checkForUpdate()
    assert.equal(failed.status, 'error')
    assert.match(describeUpdate(), /проверка не удалась: HTTP 403/)
  } finally {
    globalThis.fetch = oldFetch
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
})

test('H11: локальная установка не предлагает автообновление', async () => {
  const oldHome = process.env.DSH_HOME
  const oldFetch = globalThis.fetch
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessions-m0-a-local-'))
  try {
    process.env.DSH_HOME = root
    const profile = join(root, 'profiles', 'desktop')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
    await writeFile(
      join(profile, 'package.json'),
      `${JSON.stringify({ dependencies: { 'dsh-sessions': 'link:E:/DeepSeek Harness/.publish/dsh-sessions-plugin' } }, null, 2)}\n`,
      'utf8',
    )
    let called = 0
    globalThis.fetch = async () => {
      called += 1
      return { ok: false, status: 500 }
    }
    const state = await checkForUpdate()
    assert.equal(state.status, 'local', 'link-установка распознана')
    assert.equal(called, 0, 'для локальной установки GitHub не опрашивается')
    assert.match(describeUpdate(), /локальная установка — автообновление не применяется/, 'статус объясняет поведение')
    assert.equal(updateState().status, 'local')
  } finally {
    globalThis.fetch = oldFetch
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
})
