/**
 * M3-A: перестроенная страница настроек dsh-sessions и лёгкая сверка резерва.
 *
 * Проверяем то, что видит пользователь:
 * - 4 основные карточки («Хранилище», «План и синхронизация», «Сессии и режим»,
 *   «Резервный канал») и 2 аккордеона («Дополнительно», «Опасная зона»),
 *   свёрнутые по умолчанию, с красным акцентом у опасной зоны;
 * - «Сохранить» рядом с полями и бейдж «есть изменения» на карточке;
 * - статусы резерва: не включён / не сохранён / не сверен / сверен / ошибка;
 * - человеческие тексты ошибок 401/403, таймаута, TLS и неподдерживаемого канала;
 * - список сессий с поиском и «Показать ещё», адаптив и внутренний скролл;
 * - host-часть: маршрут `/api/dsh-sync/secondary-probe` делает лёгкую сверку
 *   (PROPFIND + profile/manifest.json, без скачивания логов) на моке fetch,
 *   старые маршруты на месте, ветка репозитория сохраняется.
 *
 * Запуск: node --import ./test/setup.mjs --test test/m3-ux.test.mjs
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
import { reserveHint } from '../index.js'

const LOG_NAME = 'session.v4.jsonl.zstd'
const PROJECT = 'alpha'
const PROJECT_PATH = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
const CREATED_AT = Date.UTC(2026, 10, 20, 10, 0, 0)

// --- общий рендер клиента без настоящего React ----------------------------

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const styles = []
let clientEntry
globalThis.window = { __ModuleLoader__: { load: (entry) => { clientEntry = entry } } }
globalThis.document = {
  documentElement: { style: {}, dataset: {} },
  body: {},
  createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
  head: { appendChild: (node) => { styles.push(node.textContent) } },
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

/** Состояние host-части для страницы: настроено, резерв включён, не сверен. */
function hostState(patch = {}) {
  return {
    ok: true,
    ready: true,
    mode: 'builtin',
    config: {
      backend: 'git',
      branch: 'main',
      remote: 'https://github.com/user/dsh-sessions.git',
      projectPath: PROJECT_PATH,
      projectId: 'harness',
      attachments: true,
      autoUpdate: true,
      useExternal: true,
      secondary: { backend: 'folder', folderDir: 'C:\\cloud\\dsh-sync-backup' },
    },
    secondary: {
      enabled: true,
      backend: 'folder',
      folderDir: 'C:\\cloud\\dsh-sync-backup',
      recommended: 'folder',
      initialized: false,
      compare: null,
      initializedAt: null,
      pulled: null,
      lastPushAt: null,
      lastPushOk: null,
      lastPushUploaded: 0,
      status: undefined,
    },
    checks: [
      { id: 'node', title: 'Node.js', ok: true, detail: 'v24.13.0' },
      { id: 'git', title: 'git', ok: true, detail: '2.50.0' },
    ],
    status: { local: 3, mirror: 3, onlyLocal: 0, onlyMirror: 0 },
    external: { found: false },
    lastRun: { at: '2026-11-22T10:00:00.000Z', ok: true, message: 'синхронизировано' },
    history: [],
    backup: { percent: 100 },
    pending: false,
    ...patch,
  }
}

function renderClient(initialState = hostState()) {
  const dictionaries = {}
  const registrations = []
  const ctx = {
    effect: (fn) => { fn() },
    locale: {
      bind: (ns) => (key, params) => {
        const dict = dictionaries[ns]
        const raw = dict?.ru?.[key] ?? key
        if (params === undefined) return raw
        return String(raw).replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      },
      subscribe: () => () => {},
      register: (ns, localeOrDict, maybeDict) => {
        if (maybeDict !== undefined) {
          dictionaries[ns] = { ...(dictionaries[ns] ?? {}), [localeOrDict]: maybeDict }
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
  let state = initialState
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(state),
  })
  const exported = clientEntry.factory((id) => {
    if (id === 'react') return MiniReact
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`неожиданный require: ${id}`)
  })
  exported.apply(ctx)
  // Состояние host-части кладём в снимок сразу: в живом интерфейсе его
  // приносит опрос STATE_PATH, а headless-тесту ждать таймер незачем.
  exported.__test.setHostState(initialState)
  const main = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'dsh-sessions')
  assert.ok(main, 'страница синхронизации зарегистрирована')
  return { exported, main, registrations }
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

const classNameOf = (node) => String(node?.props?.className ?? '')

/** Прямые дети `.dshs-sync-sections`: 4 карточки + 2 аккордеона. */
function pageSections(tree) {
  const nodes = walk(tree)
  const root = nodes.find((node) => classNameOf(node).includes('dshs-sync-sections'))
  assert.ok(root, 'страница настроек найдена')
  return { nodes, root, children: root.children.filter((child) => child !== null && typeof child === 'object') }
}

const titleOf = (node) => {
  const heading = walk(node).find((child) => child.type === 'h2')
  return heading === undefined ? '' : textOf(heading).trim()
}

const buttonTexts = (node) => walk(node)
  .filter((child) => child.type === 'button')
  .map((child) => textOf(child).trim())

// --- 1. 4 карточки + 2 аккордеона -----------------------------------------

test('страница настроек: 4 основные карточки и 2 свёрнутых аккордеона', () => {
  const { main } = renderClient()
  const tree = resolveNode(main.component({}))
  const { children } = pageSections(tree)
  const cards = children.filter((child) => child.type === 'section' && classNameOf(child).includes('dshs-sync-card'))
  const accordions = children.filter((child) => child.type === 'section' && classNameOf(child).includes('dshs-accordion'))

  assert.deepEqual(cards.map(titleOf), ['Хранилище', 'План и синхронизация', 'Сессии и режим', 'Резервный канал'], 'четыре основные карточки по порядку')
  assert.equal(accordions.length, 2, 'два аккордеона: «Дополнительно» и «Опасная зона»')
  assert.deepEqual(accordions.map(titleOf), ['Дополнительно', 'Опасная зона'])

  // «Дополнительно» свёрнуто, без красного акцента.
  const extra = accordions[0]
  assert.equal(extra.props['data-open'], 'false', '«Дополнительно» свёрнуто по умолчанию')
  const extraHead = walk(extra).find((node) => classNameOf(node).includes('dshs-accordion-head'))
  assert.equal(extraHead.props['aria-expanded'], 'false', 'кнопка-шапка сообщает о свёрнутости')
  const extraBody = walk(extra).find((node) => classNameOf(node).includes('dshs-accordion-body'))
  assert.equal(extraBody.props.style.display, 'none', 'содержимое скрыто, но остаётся в дереве')
  assert.doesNotMatch(classNameOf(extra), /danger/, 'обычный аккордеон без красного акцента')

  // «Опасная зона» свёрнута и выделена красным.
  const danger = accordions[1]
  assert.equal(danger.props['data-open'], 'false', 'опасная зона свёрнута')
  assert.match(classNameOf(danger), /dshs-accordion-danger/, 'у опасной зоны красный акцент')
  assert.equal(danger.props['data-danger'], 'true')
  const dangerBody = walk(danger).find((node) => classNameOf(node).includes('dshs-accordion-body'))
  assert.equal(dangerBody.props.style.display, 'none')

  // Внутри аккордеонов — служебные секции, а не новые основные карточки.
  assert.ok(walk(extra).some((node) => node.type === 'h2' && textOf(node).trim() === 'Проверка окружения'), 'проверка окружения спрятана в «Дополнительно»')
  assert.ok(walk(extra).some((node) => node.type === 'h2' && textOf(node).trim() === 'Обслуживание'), 'обновления — в «Дополнительно»')
  assert.ok(walk(danger).some((node) => node.type === 'h2' && textOf(node).trim() === 'Удалённые'), 'удалённые — в «Опасной зоне»')
})

// --- 2. «Сохранить» рядом с полями и бейдж изменений ----------------------

test('«Сохранить» внутри карточки и бейдж «есть изменения»', () => {
  const { exported, main } = renderClient()
  let tree = resolveNode(main.component({}))
  let nodes = walk(tree)
  const storage = nodes.find((node) => node.type === 'section' && textOf(node).includes('Хранилище'))
  assert.ok(storage, 'карточка «Хранилище»')
  assert.ok(buttonTexts(storage).includes('Сохранить'), '«Сохранить» — рядом с полями хранилища')
  assert.equal(nodes.filter((node) => classNameOf(node) === 'dshs-save-badge').length, 0, 'без изменений бейджа нет')

  // Меняем поля хранилища: бейдж «есть изменения», «Сохранить» активна.
  exported.__test.setDraft({ remote: 'https://github.com/user/other.git' })
  tree = resolveNode(main.component({}))
  nodes = walk(tree)
  const dirtyStorage = nodes.find((node) => node.type === 'section' && textOf(node).includes('Хранилище'))
  const badge = walk(dirtyStorage).find((node) => classNameOf(node) === 'dshs-save-badge')
  assert.ok(badge, 'бейдж «есть изменения» на карточке')
  assert.equal(textOf(badge).trim(), 'есть изменения')
  const save = walk(dirtyStorage).find((node) => node.type === 'button' && textOf(node).trim() === 'Сохранить')
  assert.equal(save.props.disabled, false, 'кнопка сохранения активна при изменениях')

  // Резерв: изменение режима — бейдж и статус «не сохранён».
  exported.__test.setDraft({ secondaryBackend: 'webdav' })
  tree = resolveNode(main.component({}))
  nodes = walk(tree)
  const reserve = nodes.find((node) => node.type === 'section' && textOf(node).includes('Резервный канал'))
  assert.ok(walk(reserve).some((node) => classNameOf(node) === 'dshs-save-badge'), 'бейдж на карточке резерва')
  assert.match(textOf(reserve), /не сохранён/, 'статус резерва «не сохранён»')
  assert.match(textOf(reserve), /Настройки резерва ещё не сохранены/, 'подсказка: сначала сохранить')

  exported.__test.resetDraft()
})

test('резерв не блокирует основную синхронизацию', () => {
  const { main } = renderClient(hostState({
    config: { ...hostState().config, secondary: { backend: 'none' } },
    secondary: { ...hostState().secondary, enabled: false, backend: 'none' },
  }))
  const nodes = walk(resolveNode(main.component({})))
  const mainSync = nodes.find((node) => node.type === 'button' && textOf(node).trim() === 'Синхронизировать')
  assert.ok(mainSync, 'кнопка основной синхронизации на месте')
  assert.equal(mainSync.props.disabled, false, 'резерв не блокирует основную синхронизацию')
  const reserveCard = nodes.find((node) => node.type === 'section' && textOf(node).includes('Резервный канал'))
  const compare = walk(reserveCard).find((node) => node.type === 'button' && textOf(node).trim() === 'Сверить')
  const full = walk(reserveCard).find((node) => node.type === 'button' && textOf(node).trim() === 'Синхронизировать резерв')
  assert.equal(compare.props.disabled, true, 'у выключенного резерва сверка недоступна')
  assert.equal(full.props.disabled, true, 'полная сверка резерва тоже недоступна')
  assert.match(textOf(reserveCard), /не включён/, 'статус резерва — «не включён»')
})

// --- 3. Статусы резерва и человеческие ошибки -----------------------------

test('статусы резерва: не включён / не сохранён / не сверен / сверен / ошибка', () => {
  const { exported } = renderClient()
  const status = exported.__test.reserveStatusOf

  assert.equal(status({ activeBackend: 'none', secondary: { enabled: false } }).label, 'не включён')
  assert.equal(status({ activeBackend: 'folder', dirty: true }).label, 'не сохранён')
  assert.equal(status({ activeBackend: 'folder', secondary: { initialized: false } }).label, 'не сверен')
  assert.equal(status({ activeBackend: 'folder', secondary: { initialized: true } }).label, 'сверен')
  assert.equal(status({ activeBackend: 'folder', secondary: { initialized: true, status: { ok: false, code: 'reserve/unauthorized', message: '401' } } }).label, 'ошибка')
  // «needs-compare» — это не ошибка, а ожидание сверки.
  assert.equal(status({ activeBackend: 'folder', secondary: { initialized: false, status: { ok: false, code: 'secondary/needs-compare' } } }).label, 'не сверен')
  // Неподдерживаемый канал лёгкой сверки — тоже статус ошибки со своим советом.
  const unsupported = status({ activeBackend: 'git', probe: { ok: false, code: 'reserve/unsupported', skipped: true } })
  assert.equal(unsupported.label, 'ошибка')
  assert.match(unsupported.hint, /Синхронизировать резерв/)
})

test('человеческие тексты ошибок сверки: 401/403, таймаут, TLS, канал', () => {
  const { exported } = renderClient()
  const text = exported.__test.reserveErrorText

  const unauthorized = text({ ok: false, code: 'reserve/unauthorized', message: 'Яндекс.Диск не принял логин или пароль приложения (401)' })
  assert.match(unauthorized, /401\/403/, 'ошибка входа названа кодом')
  assert.match(unauthorized, /пароль приложения/i, 'какое действие: проверить пароль приложения')
  assert.doesNotMatch(unauthorized, /^HTTP/, 'не сырой HTTP-ответ')

  const forbidden = text({ ok: false, message: 'Яндекс.Диск (WebDAV): HTTP 403' })
  assert.match(forbidden, /401\/403/, '403 тоже распознан')

  const timeout = text({ ok: false, code: 'reserve/timeout', message: 'лёгкая сверка не уложилась в 20 с' })
  assert.match(timeout, /10–30 с/, 'таймаут с бюджетом')
  assert.match(timeout, /интернет|повторите/i, 'что сделать при таймауте')

  const tls = text({ ok: false, message: 'fetch failed: schannel: certificate verify failed' })
  assert.match(tls, /TLS|cертификат|сертификат/i, 'TLS распознан')
  assert.match(tls, /сертификат/i, 'совет про сертификаты')

  const unsupported = text({ ok: false, code: 'reserve/unsupported', skipped: true })
  assert.match(unsupported, /Синхронизировать резерв/, 'для папки/git — полная сверка')

  const notConfigured = text({ ok: false, code: 'secondary/not-configured' })
  assert.match(notConfigured, /Резерв не включён/)
})

test('статус резерва отражается бейджем в шапке карточки', () => {
  const { exported, main } = renderClient()
  const badgeOf = () => {
    const nodes = walk(resolveNode(main.component({})))
    return nodes.find((node) => classNameOf(node) === 'dshs-reserve-status')
  }
  assert.equal(textOf(badgeOf()).trim(), 'не сверен', 'по умолчанию резерв не сверен')

  exported.__test.setHostState(hostState({
    secondary: { ...hostState().secondary, initialized: true },
  }))
  assert.equal(textOf(badgeOf()).trim(), 'сверен', 'после сверки — «сверен»')

  exported.__test.setHostState(hostState({
    secondary: { ...hostState().secondary, status: { ok: false, code: 'reserve/timeout', message: 'лёгкая сверка не уложилась в 20 с' } },
  }))
  assert.equal(textOf(badgeOf()).trim(), 'ошибка', 'ошибка сверки видна в бейдже')
  const reserveText = textOf(walk(resolveNode(main.component({}))).find((node) => node.type === 'section' && textOf(node).includes('Резервный канал')) ?? { children: [] })
  assert.match(reserveText, /10–30 с|интернет/i, 'в карточке — действие, а не сырой код')

  exported.__test.setHostState(hostState())
})

// --- 4. «Сессии и режим»: поиск и «Показать ещё» -------------------------

function sessionList(count) {
  const sessions = []
  for (let index = 0; index < count; index += 1) {
    sessions.push({
      id: `session-${String(index).padStart(3, '0')}`,
      title: `Сессия ${index}`,
      shortId: `s-${index}`,
      path: PROJECT_PATH,
      projectId: PROJECT,
      mode: index % 3 === 0 ? 'local' : 'cloud',
      badge: 'synced',
      attached: true,
    })
  }
  return sessions
}

test('список сессий: поиск, группы и «Показать ещё»', () => {
  const { exported, main } = renderClient()
  exported.__test.setSessionStates({ ok: true, sessions: sessionList(60), groups: { count: 0, subagents: 0, orphans: 0, line: 'групп: 0, субагентов: 0, сирот: 0' } })
  let nodes = walk(resolveNode(main.component({})))
  const search = nodes.find((node) => classNameOf(node).includes('dshs-sessions-search'))
  assert.ok(search, 'поле поиска в карточке «Сессии и режим»')
  const input = walk(search).find((node) => node.type === 'input')
  assert.equal(input.props.placeholder, 'Поиск по названию или id')
  assert.equal(typeof input.props.onChange, 'function', 'поиск реагирует на ввод')

  const rows = nodes.filter((node) => classNameOf(node) === 'dshs-modes-row')
  assert.equal(rows.length, 50, 'по умолчанию показываются первые 50 строк')
  const more = nodes.find((node) => node.type === 'button' && /^Показать ещё \d+/.test(textOf(node).trim()))
  assert.ok(more, 'кнопка «Показать ещё» есть при длинном списке')
  assert.match(textOf(more), /Показать ещё 10/, 'осталось ровно 10 строк')
  assert.match(nodes.map(textOf).join('\n'), /показано 50 из 60/, 'видно, сколько показано')

  // Группы субагентов по-прежнему вложены под родителем (контракт M2).
  assert.ok(exported.__test.sessionGroupRows, 'крючок групп на месте')
  exported.__test.setSessionStates(null)
})

// --- 5. Адаптив и скролл ---------------------------------------------------

test('адаптив и скролл: аккордеоны, бейджи, скрытие итога на узком экране', () => {
  renderClient()
  const css = styles.join('\n')
  for (const selector of ['.dshs-accordion{', '.dshs-accordion-danger{', '.dshs-accordion-body{', '.dshs-save-badge{', '.dshs-reserve-status{', '.dshs-collapsible{', '.dshs-sessions-search{']) {
    assert.ok(css.includes(selector), `стили ${selector} внедрены`)
  }
  assert.match(css, /\.dshs-accordion-body\{[^}]*display:flex/, 'тело аккордеона — flex-колонка')
  assert.match(css, /\.dshs-accordion-danger\{[^}]*state-error-primary/, 'красный акцент у опасной зоны')
  assert.match(css, /@media \(max-width:640px\)\{\.dshs-accordion-body/, 'аккордеоны адаптивны на 640 px')
  assert.ok(css.includes('.dshs-accordion-summary{display:none'), 'подпись прячется на узком экране')
  assert.match(css, /\.dshs-modes-list\{[^}]*overflow-y:auto/, 'список сессий скроллится внутри')
  assert.match(css, /\.dshs-mode-menu\{[^}]*overflow-y:auto/, 'меню режима скроллится внутри')
  // Ширина контейнера не менялась: max-width 960.
  const { main } = renderClient()
  const container = walk(resolveNode(main.component({}))).find((node) => classNameOf(node) === 'dshs-sync-container')
  assert.equal(container.props.style.maxWidth, 960)
})

// --- 6. Host-часть: маршруты и лёгкая сверка ------------------------------

function frameOf(event) {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))
}

function makeLog(header, events = []) {
  return Buffer.concat([frameOf(header), ...events.map(frameOf)])
}

function sessionHeader(id) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: CREATED_AT,
    cwd: PROJECT_PATH,
    isSeeded: false,
    delegationDepth: 0,
  }
}

async function makeEnvironment({ secondary } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m3-ux-'))
  const home = join(root, 'home')
  const repoDir = join(root, 'mirror')
  await mkdir(home, { recursive: true })
  await mkdir(join(repoDir, 'sessions', PROJECT), { recursive: true })
  const config = {
    ...defaultConfig(home),
    backend: 'folder',
    deviceId: 'device-m3-ux',
    repoDir,
    attachments: false,
    profile: { enabled: false },
    workspace: { enabled: false },
    autoSync: { enabled: false },
    sync: { autoPrune: false },
  }
  config.projects = { [PROJECT]: { path: PROJECT_PATH, title: PROJECT } }
  if (secondary !== undefined) config.secondary = secondary
  await saveConfig(home, config)
  return { root, home, repoDir, config }
}

/** Локальная сессия: заголовок + два события (лёгкая сверка увидит events=2). */
async function writeLocalSession(home, id) {
  const dir = localSessionDir(home, PROJECT_PATH, id)
  await mkdir(dir, { recursive: true })
  const events = [
    { type: 'session/title', seq: 0, time: CREATED_AT + 500, data: { title: `Сессия ${id.slice(-2)}` } },
    { type: 'user/message', seq: 1, time: CREATED_AT + 1000, data: { content: [{ type: 'text', text: 'привет' }] } },
  ]
  await writeFile(join(dir, LOG_NAME), makeLog(sessionHeader(id), events))
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

async function bootPlugin({ home, credentials }) {
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
    get: (name) => {
      if (name === 'sessionPersistence') return { list: async () => [] }
      if (name === 'credentials') return credentials
      return undefined
    },
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

/** Ответ WebDAV-мока: PROPFIND со списком сессий и манифест профиля. */
function propfindXml(ids) {
  const rows = [
    '<d:response><d:href>/dsh-sync/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>',
    ...ids.map((id) => `<d:response><d:href>/dsh-sync/sessions/${PROJECT}/${id}/session.v4.jsonl.zstd</d:href><d:propstat><d:prop><d:resourcetype/><d:getlastmodified>Wed, 19 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>`),
  ]
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${rows.join('')}</d:multistatus>`
}

function responseLike({ status = 200, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  }
}

test('host: маршруты синхронизации, профиля и резерва не потеряны', async () => {
  const env = await makeEnvironment()
  let boot
  try {
    boot = await bootPlugin({ home: env.home })
    for (const path of [
      '/api/dsh-sync/state',
      '/api/dsh-sync/config',
      '/api/dsh-sync/run',
      '/api/dsh-sync/plan',
      '/api/dsh-sync/prune',
      '/api/dsh-sync/diagnostics',
      '/api/dsh-sync/sessions',
      '/api/dsh-sync/tombstones',
      '/api/dsh-sync/restore',
      '/api/dsh-sync/duplicates',
      '/api/dsh-sync/duplicates/quarantine',
      '/api/dsh-sync/session-mode',
      '/api/dsh-sync/session-cloud-copy',
      '/api/dsh-sync/local-only-migration',
      '/api/dsh-sync/profile',
      '/api/dsh-sync/profile/apply',
      '/api/dsh-sync/browser-settings',
      '/api/dsh-sync/secondary-init',
      '/api/dsh-sync/secondary-probe',
    ]) {
      assert.ok(boot.routes.has(path), `маршрут ${path} зарегистрирован`)
    }
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('host: «Сверить» — лёгкая сверка PROPFIND + manifest без скачивания логов', async () => {
  const env = await makeEnvironment({
    secondary: {
      enabled: true,
      backend: 'webdav',
      repoDir: join(tmpdir(), `dsh-m3-replica-${randomUUID()}`),
      webdavLogin: 'user',
      webdavPassword: 'app-password',
      webdavPath: 'dsh-sync',
    },
  })
  await writeLocalSession(env.home, 'session-a')
  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const href = String(url)
    calls.push({ method, url: href })
    if (method === 'PROPFIND') return responseLike({ status: 207, body: propfindXml(['session-a', 'session-b']) })
    if (href.endsWith('/profile/manifest.json')) {
      return responseLike({
        status: 200,
        body: JSON.stringify({
          device: 'device-cloud',
          updatedAt: '2026-11-22T10:00:00.000Z',
          files: { 'profile/settings/a.json': {} },
          sessions: { 'session-a': { events: 2 } },
        }),
      })
    }
    return responseLike({ status: 404, body: '' })
  }
  let boot
  try {
    boot = await bootPlugin({ home: env.home })
    const { status, body } = await boot.call('/api/dsh-sync/secondary-probe', {})
    assert.equal(status, 200)
    assert.equal(body.ok, true, 'лёгкая сверка удалась')
    assert.equal(body.code, 'reserve/ok')
    assert.equal(body.backend, 'webdav')
    assert.equal(body.local.count, 1, 'локально одна сессия')
    assert.equal(body.cloud.count, 2, 'в облаке две сессии')
    assert.equal(body.onlyLocal, 0)
    assert.equal(body.onlyCloud, 1, 'одна сессия есть только в облаке')
    assert.equal(body.differ, 0, 'состав совпадает по событиям')
    assert.ok(body.timeoutMs >= 10000 && body.timeoutMs <= 30000, `таймаут лёгкой сверки 10–30 с, а не ${body.timeoutMs}`)
    assert.equal(typeof body.hint, 'string')
    assert.equal(body.hint, '', 'при успехе совета нет')

    // Логи не скачивались: только PROPFIND корня и чтение манифеста.
    assert.equal(calls.length, 2, `ожидалось два запроса, а не ${calls.length}: ${JSON.stringify(calls)}`)
    assert.equal(calls[0].method, 'PROPFIND', 'первый запрос — PROPFIND')
    assert.ok(calls[0].url.endsWith('/dsh-sync/'), 'PROPFIND корня зеркала')
    assert.equal(calls[1].method, 'GET', 'второй запрос — манифест')
    assert.ok(calls[1].url.endsWith('/profile/manifest.json'), 'читается profile/manifest.json')
    assert.equal(calls.some((call) => /session\.v4\.jsonl\.zstd/.test(call.url)), false, 'логи сессий не запрашивались')

    // Статус сверки сохранён для панели.
    const statusFile = join(env.home, 'dsh-sync', 'secondary-status.json')
    assert.equal(existsSync(statusFile), true, 'secondary-status.json записан')
    const saved = JSON.parse(await readFile(statusFile, 'utf8'))
    assert.equal(saved.ok, true)
    assert.equal(saved.backend, 'webdav')
  } finally {
    globalThis.fetch = previousFetch
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('host: 401 при сверке резерва — человеческий текст с действием', async () => {
  const env = await makeEnvironment({
    secondary: {
      enabled: true,
      backend: 'webdav',
      repoDir: join(tmpdir(), `dsh-m3-replica-${randomUUID()}`),
      webdavLogin: 'user',
      webdavPassword: 'wrong-password',
      webdavPath: 'dsh-sync',
    },
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => responseLike({ status: 401, body: 'Unauthorized' })
  let boot
  try {
    boot = await bootPlugin({ home: env.home })
    const { status, body } = await boot.call('/api/dsh-sync/secondary-probe', {})
    assert.equal(status, 200, 'ошибка сверки не роняет маршрут')
    assert.equal(body.ok, false)
    assert.equal(body.code, 'reserve/unauthorized')
    assert.match(body.message, /401|логин или пароль приложения/i)
    assert.match(body.hint, /401\/403/)
    assert.match(body.hint, /пароль приложения/i, 'совет говорит, что проверить')
    assert.equal(reserveHint(body), body.hint, 'helper host-части и поле hint совпадают')
  } finally {
    globalThis.fetch = previousFetch
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('host: пароль WebDAV резерва берётся из хранилища секретов', async () => {
  // В настройках пароля нет (он в сейфе профиля): без подстановки секрета
  // лёгкая сверка упала бы «не заданы логин и пароль приложения».
  const env = await makeEnvironment({
    secondary: {
      enabled: true,
      backend: 'webdav',
      repoDir: join(tmpdir(), `dsh-m3-replica-${randomUUID()}`),
      webdavLogin: 'user',
      webdavPath: 'dsh-sync',
      passwordStored: true,
    },
  })
  const previousFetch = globalThis.fetch
  const previousEnv = process.env.DSH_SYNC_WEBDAV_PASSWORD
  delete process.env.DSH_SYNC_WEBDAV_PASSWORD
  const authorizations = []
  globalThis.fetch = async (url, init = {}) => {
    authorizations.push(String(init.headers?.authorization ?? ''))
    if ((init.method ?? 'GET') === 'PROPFIND') {
      return responseLike({
        status: 207,
        body: '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dsh-sync/sessions/alpha/session-a/session.v4.jsonl.zstd</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>',
      })
    }
    return responseLike({ status: 200, body: JSON.stringify({ files: {}, sessions: {} }) })
  }
  let boot
  try {
    boot = await bootPlugin({
      home: env.home,
      credentials: {
        resolve: async (key) => (key === 'DSH_SYNC_WEBDAV_PASSWORD' ? { value: 'app-password' } : undefined),
      },
    })
    const { body } = await boot.call('/api/dsh-sync/secondary-probe', {})
    assert.equal(body.ok, true, `сверка должна пройти с паролем из сейфа: ${body.message ?? ''}`)
    assert.equal(body.backend, 'webdav')
    const expected = `Basic ${Buffer.from('user:app-password').toString('base64')}`
    assert.ok(authorizations.includes(expected), 'WebDAV получил логин и пароль из хранилища секретов')
  } finally {
    globalThis.fetch = previousFetch
    if (previousEnv === undefined) delete process.env.DSH_SYNC_WEBDAV_PASSWORD
    else process.env.DSH_SYNC_WEBDAV_PASSWORD = previousEnv
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('host: канал без лёгкой сверки и выключенный резерв — понятные ответы', async () => {
  const folder = await makeEnvironment({
    secondary: {
      enabled: true,
      backend: 'folder',
      repoDir: join(tmpdir(), `dsh-m3-replica-${randomUUID()}`),
      folderDir: join(tmpdir(), `dsh-m3-cloud-${randomUUID()}`),
    },
  })
  let boot
  try {
    boot = await bootPlugin({ home: folder.home })
    const unsupported = await boot.call('/api/dsh-sync/secondary-probe', {})
    assert.equal(unsupported.body.ok, false)
    assert.equal(unsupported.body.code, 'reserve/unsupported')
    assert.equal(unsupported.body.skipped, true)
    assert.match(unsupported.body.hint, /Синхронизировать резерв/, 'предлагает полную сверку')
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(folder.root, { recursive: true, force: true })
  }

  const off = await makeEnvironment()
  try {
    boot = await bootPlugin({ home: off.home })
    const notConfigured = await boot.call('/api/dsh-sync/secondary-probe', {})
    assert.equal(notConfigured.body.ok, false)
    assert.equal(notConfigured.body.code, 'secondary/not-configured')
    assert.match(notConfigured.body.hint, /Резерв не включён/)
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(off.root, { recursive: true, force: true })
  }
})

test('host: ветка репозитория сохраняется из карточки «Хранилище»', async () => {
  const env = await makeEnvironment()
  let boot
  try {
    boot = await bootPlugin({ home: env.home })
    const { status, body } = await boot.call('/api/dsh-sync/config', {
      backend: 'git',
      remote: 'https://github.com/user/dsh-sessions.git',
      branch: 'release',
      projectPath: PROJECT_PATH,
      projectId: PROJECT,
      attachments: false,
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.config.branch, 'release', 'ветка возвращается в состоянии')
    const saved = JSON.parse(await readFile(join(env.home, 'dsh-sync.json'), 'utf8'))
    assert.equal(saved.branch, 'release', 'ветка записана в настройки')
  } finally {
    boot?.dispose()
    boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})
