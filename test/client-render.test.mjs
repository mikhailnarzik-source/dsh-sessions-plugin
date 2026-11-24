/**
 * Тест рендера страницы «Синхронизация сессий» без браузера.
 *
 * Загружаем client.js в поддельном окне, подменяем React минимальным
 * набором хуков и раскрываем дерево компонентов. Проверяем то, что видно
 * пользователю и что нельзя проверить синтаксисом: центрированный контейнер
 * 940 px, секции-карточки, шапку со статус-чипом, сохранность полей и кнопок.
 *
 * Запуск: node --test test/client-render.test.mjs
 */
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let loaded
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }

// Стили перехватываем: по ним проверяем медиазапрос и токены темы.
const styles = []
globalThis.document = {
  documentElement: { style: {}, dataset: {} },
  body: {},
  createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
  head: { appendChild: (node) => { styles.push(node.textContent) } },
}

// eslint-disable-next-line no-new-func
new Function(source)()
assert.equal(loaded?.id, 'dsh-sessions', 'идентификатор клиента совпадает с именем пакета')
assert.equal(typeof loaded.factory, 'function')

// Мини-React: ровно то, что использует страница (состояние, эффекты, классы).
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

const rows = []
const requireStub = (id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return { createPortal: (node) => node }
  throw new Error(`неожиданный require: ${id}`)
}
void rows

// Локаль: bind возвращает переводчик по русскому словарю из register.
const dictionaries = {}
const registrations = []

// Ответ host-части на /api/dsh-sync/state: настроенная синхронизация.
const readyState = {
  ok: true,
  ready: true,
  mode: 'builtin',
  config: {
    backend: 'git',
    remote: 'https://github.com/user/dsh-sessions.git',
    projectPath: 'C:\\work\\project',
    projectId: 'harness',
    attachments: true,
    autoUpdate: true,
    secondary: { backend: 'folder', folderDir: 'C:\\cloud\\dsh-sync-backup' },
  },
  // Резерв включён, но ещё не сверен: карточка должна показать «Сначала сверка».
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
    { id: 'project', title: 'Папка проекта', ok: true, detail: 'C:\\work\\project' },
    { id: 'remote', title: 'Репозиторий зеркала', ok: true, detail: 'доступен' },
  ],
  status: { local: 3, mirror: 3, onlyLocal: 0, onlyMirror: 0 },
  external: { found: false },
  lastRun: { at: '2026-11-22T10:00:00.000Z', ok: true, message: 'синхронизировано' },
  history: [],
  backup: { percent: 100 },
  pending: false,
}
let hostState = readyState

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(hostState),
})

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

const main = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'dsh-sessions')
assert.ok(main, 'страница синхронизации регистрируется в main по имени пакета')

// ---- раскрытие дерева ------------------------------------------------------

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

// Сначала состояние ещё грузится: страница рисуется с чипом «проверка…».
const loadingTree = resolveNode(main.component({}))
const loadingHeader = walk(loadingTree).find((node) => node.type === 'header')
const loadingText = textOf(loadingHeader)
// Ждём асинхронный опрос состояния из apply и рисуем страницу с данными.
await new Promise((resolve) => setTimeout(resolve, 30))
const tree = resolveNode(main.component({}))
const nodes = walk(tree)
const texts = nodes.map(textOf).join('\n')
const styleNodes = nodes.filter((node) => node.props?.className === 'dshs-sync-card')
const buttonTexts = nodes
  .filter((node) => node.type === 'button')
  .map((node) => textOf(node).trim())

// ---- проверки --------------------------------------------------------------

test('контент страницы в центрированном контейнере 900–980 px', () => {
  assert.equal(tree.type, 'div', 'корень страницы — обычный блок')
  assert.match(String(tree.props.className), /dshs-sync-page/, 'у страницы есть класс с полями по краям')
  assert.deepEqual(tree.props.style.padding, undefined, 'поля задаёт класс, а не inline-стиль')

  const container = nodes.find((node) => node.props?.className === 'dshs-sync-container')
  assert.ok(container, 'центрированный контейнер найден')
  const { maxWidth, margin, width, boxSizing } = container.props.style
  assert.ok(typeof maxWidth === 'number' && maxWidth >= 900 && maxWidth <= 980, `max-width 900–980, а не ${maxWidth}`)
  assert.equal(margin, '0 auto', 'контейнер центрируется по горизонтали')
  assert.equal(width, '100%', 'контейнер занимает доступную ширину')
  assert.equal(boxSizing, 'border-box', 'поля входят в ширину контейнера')

  // Симметричные отступы и 16 px на узком экране — в слое оформления.
  const pageCss = styles.find((text) => typeof text === 'string' && text.includes('.dshs-sync-page'))
  assert.ok(pageCss, 'стили страницы внедряются')
  const base = pageCss.match(/\.dshs-sync-page\{padding:(\d+)px (\d+)px (\d+)px\}/)
  assert.ok(base, 'у страницы есть базовые поля')
  assert.equal(base[2], base[2], 'поля слева и справа одинаковые')
  assert.match(pageCss, /@media \(max-width:900px\)\{\.dshs-sync-page\{padding:\d+px 18px \d+px\}\}/, 'на 900 px поля 18 px')
  assert.match(pageCss, /@media \(max-width:640px\)\{\.dshs-sync-page\{padding:\d+px 14px \d+px\}/, 'на 640 px поля 14 px')
  assert.match(pageCss, /--dsw-alias-/, 'цвета берутся из токенов темы')
})

test('шапка: иконка в круге, заголовок, подзаголовок, чип и «Обновить»', () => {
  const header = nodes.find((node) => node.type === 'header')
  assert.ok(header, 'шапка страницы есть')
  assert.equal(header.props.className, 'dshs-sync-header')

  const headerNodes = walk(header)
  const title = headerNodes.find((node) => node.type === 'h1')
  assert.equal(textOf(title), 'Синхронизация сессий')
  assert.ok(headerNodes.some((node) => node.type === 'p' && textOf(node).includes('между устройствами')), 'подзаголовок на месте')

  // Иконка — svg внутри круглого бейджа.
  const icon = headerNodes.find(
    (node) => typeof node.props?.style?.borderRadius === 'number' && node.props.style.borderRadius >= 50 && walk(node).some((child) => child.type === 'svg'),
  )
  assert.ok(icon, 'иконка синхронизации в круге')

  // Чип состояния и время последней синхронизации.
  const chip = headerNodes.find((node) => String(node.props?.className ?? '').includes('dshs-sync-chip'))
  assert.ok(chip, 'статус-чип найден')
  assert.match(textOf(chip), /настроено/, 'в настроенном состоянии чип говорит «настроено»')
  assert.match(textOf(header), /Последняя синхронизация/, 'чип показывает последнюю синхронизацию')

  // Черновик состояния (loading): до ответа host чип честно пишет «проверка…».
  assert.match(loadingText, /проверка/, 'пока состояние грузится — «проверка…»')

  assert.ok(buttonTexts.includes('Обновить'), 'в шапке есть кнопка «Обновить»')
})

test('секции-карточки с заголовками и единым оформлением', () => {
  const titles = ['Синхронизация', 'Проверка', 'Подключение', 'Дополнительно', 'Резервный канал', 'Проверка окружения', 'Обслуживание', 'Удалённые']
  for (const title of titles) {
    const heading = nodes.find((node) => node.type === 'h2' && textOf(node).trim() === title)
    assert.ok(heading, `секция «${title}» есть на странице`)
  }
  assert.ok(styleNodes.length >= 5, `карточек минимум 5, а не ${styleNodes.length}`)
  for (const card of styleNodes) {
    assert.equal(card.props.style.borderRadius, 14, 'у всех карточек одинаковый радиус')
    assert.equal(card.props.style.padding, '16px 18px', 'у всех карточек одинаковые поля')
    assert.match(String(card.props.style.border), /--dsw-alias-border/, 'границы из токенов темы')
    assert.ok(walk(card).some((child) => child.type === 'h2'), 'у каждой карточки есть заголовок')
  }
})

test('поля настроек и кнопки сохранены', () => {
  for (const label of [
    'Тип хранилища',
    'Адрес репозитория с сессиями (приватный)',
    'Путь к проекту на этом компьютере',
    'Идентификатор проекта (одинаковый на всех устройствах)',
    'Синхронизировать вложения (картинки и файлы из чата)',
    'Папка облака для резерва',
  ]) {
    assert.ok(texts.includes(label), `поле «${label}» на месте`)
  }

  const selects = nodes.filter((node) => node.type === 'select')
  assert.ok(selects.length >= 1, 'есть выбор основного хранилища')
  const backends = selects[0].children.map((option) => option?.props?.value)
  assert.deepEqual(backends, ['git', 'folder', 'webdav', 'yandex'], 'все типы хранилищ сохранены')

  for (const label of ['Синхронизировать', 'Только принять', 'Только отправить', 'Сохранить', 'Создать репозиторий', 'Диагностика', 'Сверить']) {
    assert.ok(buttonTexts.includes(label), `кнопка «${label}» на месте`)
  }
})

test('карточка «Резервный канал»: переключатель folder/webdav, статус и «Сверить»', () => {
  const card = nodes.find((node) => node.type === 'section' && textOf(node).includes('Резервный канал'))
  assert.ok(card, 'карточка «Резервный канал» есть на странице')
  assert.match(textOf(card), /Папка облака \(рекомендуется\)/, 'папка облака предложена как рекомендуемый вариант')
  assert.match(textOf(card), /WebDAV/, 'WebDAV оставлен как вариант')
  assert.match(textOf(card), /Сначала сверка/, 'без сверки видно предупреждение «Сначала сверка»')
  assert.match(textOf(card), /папка облака: C:\\cloud\\dsh-sync-backup/, 'показан выбранный путь облака')

  const toggles = walk(card).filter((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined)
  assert.ok(toggles.length >= 2, 'переключатель резерва — кнопки-чипы')
  for (const toggle of toggles) {
    assert.equal(toggle.props.style.height, 32, 'переключатель — 32 px')
    assert.equal(toggle.props.style.borderRadius, 10, 'переключатель — радиус 10')
  }
  const folderToggle = toggles.find((node) => textOf(node).includes('Папка облака'))
  assert.equal(folderToggle.props['aria-pressed'], 'true', 'папка облака выбрана')
  const webdavToggle = toggles.find((node) => textOf(node).includes('WebDAV'))
  assert.equal(webdavToggle.props['aria-pressed'], 'false', 'WebDAV не выбран')
  const compare = nodes.find((node) => node.type === 'button' && textOf(node).trim() === 'Сверить')
  assert.ok(compare, 'кнопка «Сверить» на месте')
  assert.equal(compare.props.disabled, false, 'при сохранённых настройках сверка доступна')
})

test('проверка окружения: строки с зелёными точками', () => {
  for (const title of ['Node.js', 'git', 'Папка проекта', 'Репозиторий зеркала']) {
    assert.ok(texts.includes(title), `строка проверки «${title}» есть`)
  }
  const greenDots = nodes.filter(
    (node) => node.props?.style?.background && String(node.props.style.background).includes('state-success'),
  )
  assert.ok(greenDots.length >= 4, `зелёные точки нарисованы, а не ${greenDots.length}`)
})

test('панель действий и подсказки внизу страницы', () => {
  const actions = nodes.find((node) => node.props?.className === 'dshs-sync-actions')
  assert.ok(actions, 'панель действий есть')
  assert.equal(actions.props.style.borderRadius, 14, 'панель оформлена как карточка')
  const actionButtons = walk(actions).filter((node) => node.type === 'button').map((node) => textOf(node).trim())
  assert.deepEqual(actionButtons.sort(), ['Диагностика', 'Создать репозиторий', 'Сохранить'].sort(), 'в панели три действия')
  assert.match(texts, /Репозиторий создаётся приватным/, 'подсказка про токен GitHub сохранена')
})

test('в секции обслуживания — проверка обновления и «Диагностика»', () => {
  const maintenance = nodes.find((node) => node.type === 'section' && textOf(node).includes('Обслуживание'))
  assert.ok(maintenance, 'секция «Обслуживание» найдена')
  assert.match(textOf(maintenance), /Проверяем версию|Актуально|Доступно обновление|Локальная установка|Состояние неизвестно/, 'статус проверки версии виден')
})

test('кнопки страницы: 36/32, радиус 10, мягкая заливка brand, ширина по тексту', () => {
  const buttons = nodes.filter((node) => node.type === 'button')
  assert.ok(buttons.length >= 6, `кнопок на странице: ${buttons.length}`)
  for (const button of buttons) {
    const style = button.props.style ?? {}
    if (style.position === 'absolute') continue // иконка-шеврон, отдельный вариант
    assert.ok([32, 36].includes(style.height), `высота кнопки 32 или 36, а не ${style.height}`)
    assert.equal(style.borderRadius, 10, 'радиус кнопки 10')
    assert.equal(style.display, 'inline-flex', 'кнопка — inline-flex')
    assert.equal(style.fontWeight, 600, 'кнопка — 600')
    assert.equal(style.fontSize, 12.5, 'кнопка — 12.5')
    assert.equal(style.whiteSpace, 'nowrap', 'подпись не переносится')
    if (textOf(button).trim() !== '') {
      assert.equal(style.width, undefined, 'у текстовой кнопки нет фиксированной ширины')
      assert.equal(style.minWidth, undefined, 'нет фиксированной min-width')
    }
    assert.doesNotMatch(String(style.color ?? ''), /#fff|label-primary-foreground/i, 'нет белого текста на кнопке')
  }

  const primary = buttons.find((button) => String(button.props.className ?? '').includes('dshs-btn-primary'))
  assert.ok(primary, 'primary-кнопка «Синхронизировать» найдена')
  assert.match(String(primary.props.style.background), /color-mix\(in srgb, ?var\(--dsw-alias-brand-primary, #4a7dcc\) 18%, ?transparent\)/)
  assert.match(String(primary.props.style.border), /color-mix\(in srgb, ?var\(--dsw-alias-brand-primary, #4a7dcc\) 55%, ?transparent\)/)
  assert.equal(primary.props.style.color, 'var(--dsw-alias-brand-primary, #4a7dcc)')

  const headerRefresh = buttons.find((button) => textOf(button).includes('Обновить') && button.props.style.height === 32)
  assert.ok(headerRefresh, '«Обновить» в шапке — 32 px')
  assert.equal(headerRefresh.props.style.background, 'transparent')
})

test('секции режимов сессий и профиля: фильтр, список, рабочие пространства', () => {
  const modesSection = nodes.find((node) => node.type === 'section' && textOf(node).includes('Сессии и режим синхронизации'))
  assert.ok(modesSection, 'секция «Сессии и режим синхронизации» есть')
  assert.match(textOf(modesSection), /Все \(\d+\)/, 'фильтр «Все» с количеством')
  assert.match(textOf(modesSection), /Облачные \(\d+\)/, 'фильтр «Облачные»')
  assert.match(textOf(modesSection), /Локальные \(\d+\)/, 'фильтр «Локальные»')
  assert.match(textOf(modesSection), /Требуют внимания \(\d+\)/, 'фильтр «Требуют внимания»')
  assert.match(textOf(modesSection), /Сделать облачными|Сделать локальными/, 'массовые кнопки режима')
  assert.match(textOf(modesSection), /Привязать непривязанные|Сессии появятся здесь|Под фильтр ничего не попало/, 'список сессий рендерится')

  const profileSection = nodes.find((node) => node.type === 'section' && textOf(node).includes('Профиль'))
  assert.ok(profileSection, 'секция «Профиль» есть')
  assert.match(textOf(profileSection), /Профиль|Загрузка состояния профиля/, 'состояние профиля видно')
  assert.match(textOf(profileSection), /Обновить состояние/, 'кнопка обновления состояния профиля')
})

test('новые элементы: кнопки 32 px, список сессий со скроллом, пункт меню сессии', () => {
  const modesSection = nodes.find((node) => node.type === 'section' && textOf(node).includes('Сессии и режим синхронизации'))
  const chips = walk(modesSection).filter((node) => String(node.props?.className ?? '').includes('dshs-modes-chip'))
  assert.equal(chips.length, 4, 'четыре чипа фильтра')
  for (const chip of chips) {
    assert.equal(chip.props.style.height, 32, 'чип — 32 px')
    assert.equal(chip.props.style.borderRadius, 10, 'чип — радиус 10')
    assert.equal(chip.props.style.fontWeight, 600, 'чип — 600')
  }

  const pageCss = styles.find((text) => typeof text === 'string' && text.includes('.dshs-sync-page'))
  assert.match(pageCss, /\.dshs-modes-list\{[^}]*overflow-y:auto/, 'список сессий прокручивается внутри')
  assert.match(pageCss, /\.dshs-modes-list\{[^}]*max-height:320px/, 'у списка ограничена высота')
  assert.match(pageCss, /\.dshs-modes-row\{[^}]*min-width:0/, 'строки списка не распирают карточку')
  assert.match(pageCss, /\.dshs-modes-chip\{[^}]*height:32px/, 'чипы оформлены как кнопки')
  assert.match(pageCss, /\.dshs-menu-item\{[^}]*height:32px/, 'пункт меню сессии — 32 px')
  assert.match(pageCss, /\.dshs-menu-item:hover/, 'у пункта меню есть hover')
  assert.match(pageCss, /\.dshs-modes-chip:hover/, 'у чипов есть hover')
  assert.match(pageCss, /\.dshs-menu-item:focus-visible/, 'у пункта меню есть focus-visible')

  const menuRegistration = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  assert.ok(menuRegistration, 'пункт меню режима сессии зарегистрирован')
})

test('список сессий с данными: режимы, значки, действия и пункт меню', () => {
  assert.ok(exported.__test?.setSessionStates, 'тестовый крючок для состояния сессий доступен')
  exported.__test.setSessionStates({
    ok: true,
    states: {},
    sessions: [
      {
        id: 'session-local-1',
        title: 'Локальная работа',
        projectId: 'harness',
        path: 'C:\\work\\project',
        mode: 'local',
        state: 'green',
        badge: 'local',
        attached: true,
      },
      {
        id: 'session-cloud-1',
        title: 'Общая сессия',
        projectId: 'harness',
        path: 'C:\\work\\project',
        mode: 'cloud',
        state: 'orange',
        badge: 'pending',
        attached: true,
      },
      {
        id: 'session-free-1',
        title: '',
        projectId: 'harness',
        path: 'C:\\work\\project',
        mode: 'cloud',
        state: 'green',
        badge: 'unattached',
        attached: false,
      },
    ],
    modes: { local: 1, cloud: 2 },
    unattached: 1,
    cloud: { offline: false, ok: true, at: null, message: '' },
    attachAvailable: true,
  })

  const treeWithSessions = resolveNode(main.component({}))
  const sessionNodes = walk(treeWithSessions)
  const rows = sessionNodes.filter((node) => String(node.props?.className ?? '').includes('dshs-modes-row'))
  assert.equal(rows.length, 3, 'все три сессии отрисованы')
  const rowsText = rows.map(textOf).join('\n')
  assert.match(rowsText, /Локальная работа/, 'название локальной сессии видно')
  assert.match(rowsText, /Общая сессия/, 'название облачной сессии видно')
  assert.match(rowsText, /локальная/, 'у локальной сессии подпись режима')
  assert.match(rowsText, /облачная/, 'у облачной сессии подпись режима')
  assert.match(rowsText, /Локальная сессия: не синхронизируется/, 'значок локальной сессии подписан')
  assert.match(rowsText, /Есть неотправленные изменения/, 'значок «ждёт отправки» подписан')
  assert.match(rowsText, /не привязана к рабочему пространству/, 'значок «не привязана» подписан')
  const rowButtons = rows.flatMap((row) => walk(row).filter((node) => node.type === 'button').map(textOf))
  assert.ok(rowButtons.some((text) => text.includes('В облако')), 'локальную можно вернуть в облако')
  assert.ok(rowButtons.some((text) => text.includes('Локально')), 'облачную можно сделать локальной')
  assert.ok(sessionNodes.some((node) => node.type === 'button' && textOf(node).includes('Сделать локальными (0)')), 'массовая кнопка учитывает выбор')

  // Пункт меню для локальной сессии предлагает вернуть её в облако.
  const menuRegistration = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  const menuNode = resolveNode(menuRegistration.component({
    sessionId: 'session-local-1',
    useMenuOpenState: () => [false, () => {}],
  }))
  assert.match(textOf(menuNode), /Сделать облачной/, 'меню локальной сессии предлагает облако')
  const cloudMenuNode = resolveNode(menuRegistration.component({
    sessionId: 'session-cloud-1',
    useMenuOpenState: () => [false, () => {}],
  }))
  assert.match(textOf(cloudMenuNode), /Сделать локальной/, 'меню облачной сессии предлагает локальный режим')

  exported.__test.setSessionStates(null)
})

test('адаптив: flex-wrap кнопок, медиа 900/640, без белого на белом и fixed width', () => {
  const pageCss = styles.find((text) => typeof text === 'string' && text.includes('.dshs-sync-page'))
  assert.ok(pageCss, 'слой оформления страницы внедрён')
  assert.match(pageCss, /\.dshs-sync-page\{padding:28px 24px 48px;overflow-wrap:anywhere\}/)
  assert.match(pageCss, /\.dshs-sync-header\{gap:10px\}/)
  assert.match(pageCss, /@media \(max-width:900px\)/, 'есть медиа 900 px')
  assert.match(pageCss, /@media \(max-width:640px\)/, 'есть медиа 640 px')
  assert.match(pageCss, /button\.dshs-btn-primary:hover:not\(:disabled\)\{background:color-mix\(in srgb,var\(--dsw-alias-brand-primary/, 'hover primary — мягкая заливка brand')
  assert.doesNotMatch(pageCss, /button:hover:not\(:disabled\)\{background:rgba\(128,128,128/, 'нет старых rgba-кнопок')

  const container = nodes.find((node) => node.props?.className === 'dshs-sync-container')
  assert.equal(container.props.style.maxWidth, 960, 'контейнер 960 px')
  assert.equal(container.props.style.width, '100%')

  const dialogCss = styles.find((text) => typeof text === 'string' && text.includes('.dshsd-button{'))
  assert.ok(dialogCss, 'стили диалога удаления внедрены')
  assert.match(dialogCss, /\.dshsd-button\{[^}]*height:36px/)
  assert.match(dialogCss, /\.dshsd-button\{[^}]*padding:0 14px/)
  assert.match(dialogCss, /\.dshsd-button\{[^}]*border-radius:10px/)
  assert.match(dialogCss, /\.dshsd-button\{[^}]*font-size:12\.5px/)
  assert.match(dialogCss, /\.dshsd-button\{[^}]*font-weight:600/)
  assert.match(dialogCss, /\.dshsd-button\{[^}]*min-width:0/)
  assert.doesNotMatch(dialogCss, /min-width:72px/, 'нет фиксированной min-width у кнопок')
  assert.doesNotMatch(dialogCss, /\.dshsd-button-primary\{[^}]*button-primary-fill/, 'нет старой сплошной заливки brand')
  assert.match(dialogCss, /\.dshsd-button-primary\{[^}]*color-mix\(in srgb,var\(--dsw-alias-brand-primary/)
  assert.match(dialogCss, /\.dshsd-button-primary\{[^}]*color:var\(--dsw-alias-brand-primary/)
  assert.doesNotMatch(dialogCss, /button-primary\{[^}]*label-primary-foreground/, 'нет белого текста на primary')
  assert.match(dialogCss, /\.dshsd-button-delete:not\(:disabled\)\{[^}]*color-mix\(in srgb,var\(--dsw-alias-state-error-primary/)
  assert.match(dialogCss, /@media \(max-width:640px\)\{\.dshsd-footer/, 'на 640 px кнопки могут растягиваться')
})

test('секция «Удалённые»: список со сроком карантина, причинами и восстановлением', () => {
  assert.ok(exported.__test?.setTombstones, 'тестовый крючок для списка удалённых доступен')
  assert.ok(exported.__test?.setSessionStates, 'крючок сессий остался доступен')

  // Пустое состояние: удалённых нет.
  exported.__test.setTombstones({ ok: true, quarantineDays: 30, count: 0, sessions: [] })
  const emptyTree = resolveNode(main.component({}))
  const emptyText = walk(emptyTree).map(textOf).join('\n')
  assert.match(emptyText, /Удалённых сессий нет/, 'пустой список подписан')

  // Две метки: ручное удаление с карантином и истёкшая автоочистка.
  exported.__test.setTombstones({
    ok: true,
    quarantineDays: 30,
    count: 2,
    sessions: [
      {
        id: 'session-deleted-1',
        title: 'Ненужный диалог',
        at: '2026-11-20T10:00:00.000Z',
        device: 'device-a',
        reason: 'manual',
        by: 'owner',
        projectId: 'harness',
        quarantined: true,
        localQuarantined: false,
        liveInMirror: false,
        remainingDays: 27,
        expired: false,
        canRestore: true,
      },
      {
        id: 'session-deleted-2',
        title: '',
        at: '2026-10-01T10:00:00.000Z',
        device: 'device-b',
        reason: 'prune',
        by: 'sync',
        projectId: 'harness',
        quarantined: false,
        localQuarantined: false,
        liveInMirror: false,
        remainingDays: 0,
        expired: true,
        canRestore: false,
      },
    ],
  })

  const deletedTree = resolveNode(main.component({}))
  const deletedNodes = walk(deletedTree)
  const deletedText = deletedNodes.map(textOf).join('\n')
  assert.match(deletedText, /Удалённые/, 'карточка «Удалённые» на странице')
  assert.match(deletedText, /Ненужный диалог/, 'название удалённой сессии видно')
  // H2: в тексте подпись «Без названия», короткий id — только в tooltip строки.
  assert.match(deletedText, /Без названия/, 'у сессии без названия подпись «Без названия»')
  const untitledDeleted = deletedNodes.find(
    (node) => String(node.props?.className ?? '') === 'dshs-deleted-row' && textOf(node).includes('Без названия'),
  )
  assert.ok(untitledDeleted, 'строка удалённой сессии без названия найдена')
  assert.equal(untitledDeleted.props.title, 'deleted-2', 'shortId удалённой сессии — в tooltip')
  assert.equal(deletedText.includes('deleted-2'), false, 'shortId не подменяет название в тексте')
  assert.match(deletedText, /вручную/, 'причина ручного удаления подписана')
  assert.match(deletedText, /автоочистка/, 'причина автоочистки подписана')
  assert.match(deletedText, /пользователь/, 'автор удаления подписан')
  assert.match(deletedText, /синхронизация/, 'автоматический автор подписан')
  assert.match(deletedText, /в карантине ещё 27 дн\./, 'виден остаток 30-дневного карантина')
  assert.match(deletedText, /карантин истёк/, 'истёкший карантин подписан')

  const deletedSection = deletedNodes.find(
    (node) => node.type === 'section' && textOf(node).includes('Удалённые'),
  )
  assert.ok(deletedSection, 'секция «Удалённые» найдена')
  const deletedButtons = walk(deletedSection).filter((node) => node.type === 'button')
  const deletedButtonTexts = deletedButtons.map((node) => textOf(node).trim())
  assert.equal(deletedButtonTexts.filter((text) => text === 'Восстановить').length, 2, 'у каждой строки кнопка «Восстановить»')
  assert.ok(deletedButtonTexts.some((text) => text.includes('Восстановить всё (1)')), 'кнопка «Восстановить всё» считает доступные')
  for (const button of deletedButtons) {
    const style = button.props.style ?? {}
    assert.ok([32, 36].includes(style.height), `высота кнопки 32/36, а не ${style.height}`)
    assert.equal(style.borderRadius, 10, 'радиус кнопки 10')
    assert.equal(style.whiteSpace, 'nowrap', 'подпись не переносится')
  }
  const restoreRow = walk(deletedSection).find(
    (node) => node.type === 'button' && textOf(node).trim() === 'Восстановить',
  )
  assert.equal(restoreRow.props.disabled, false, 'доступную сессию можно вернуть')
  const expiredRows = walk(deletedSection).filter(
    (node) => node.type === 'button' && textOf(node).trim() === 'Восстановить' && node.props.disabled === true,
  )
  assert.equal(expiredRows.length, 1, 'истёкшую сессию вернуть нельзя')

  const pageCss = styles.find((text) => typeof text === 'string' && text.includes('.dshs-sync-page'))
  assert.match(pageCss, /\.dshs-deleted-list\{[^}]*overflow-y:auto/, 'список удалённых прокручивается внутри')
  assert.match(pageCss, /\.dshs-deleted-row\{[^}]*min-width:0/, 'строки не распирают карточку')
  assert.match(pageCss, /\.dshs-deleted-row:hover/, 'у строк есть hover')

  exported.__test.setTombstones(null)
})

// ---- индикаторы по макету, умолчания пространств, облачная копия ----------

test('индикатор: маппинг состояний полосы и цвета', () => {
  const testApi = exported.__test
  assert.ok(testApi.indicatorStateOf, 'маппинг состояний доступен тестам')
  const states = testApi.INDICATOR_STATES
  assert.ok(states, 'описание состояний индикатора есть')

  // Точные проценты и цвета из макета.
  assert.equal(states.synced.percent, 100)
  assert.equal(states.synced.fill, 'gradient')
  assert.equal(states.pending.percent, 55)
  assert.equal(states.pending.fill, 'amber')
  assert.equal(states.pending.dot, 'pulse')
  assert.equal(states.exchanging.percent, 70)
  assert.equal(states.exchanging.fill, 'gradient')
  assert.equal(states.exchanging.dot, 'run')
  assert.equal(states.conflict.percent, 100)
  assert.equal(states.conflict.fill, 'red')
  assert.equal(states.conflict.breathe, true)
  assert.equal(states.conflict.bang, true, '«!» у конфликта остаётся без анимации')
  assert.equal(states.offline.percent, 25)
  assert.equal(states.offline.fill, 'gray')
  assert.equal(states.offline.crossed, true)
  assert.equal(states.local.kind, 'monitor')
  assert.equal(states.local.percent, 0)

  // Цвета бренда/янтарный/красный/серый — как в макете.
  assert.equal(testApi.INDICATOR_COLORS.brandFrom, '#6EE2FF')
  assert.equal(testApi.INDICATOR_COLORS.brandTo, '#4882FF')
  assert.equal(testApi.INDICATOR_COLORS.amber, '#F7BE4C')
  assert.equal(testApi.INDICATOR_COLORS.red, '#EC6064')
  assert.equal(testApi.INDICATOR_COLORS.gray, '#7E8694')

  // Код значка от host-части → визуальное состояние.
  assert.equal(testApi.indicatorStateOf({ mode: 'cloud', badge: 'synced' }, {}), 'synced')
  assert.equal(testApi.indicatorStateOf({ mode: 'cloud', badge: 'pending' }, {}), 'pending')
  assert.equal(testApi.indicatorStateOf({ mode: 'cloud', badge: 'never' }, {}), 'pending')
  assert.equal(testApi.indicatorStateOf({ mode: 'cloud', badge: 'unattached' }, {}), 'pending')
  assert.equal(testApi.indicatorStateOf({ mode: 'cloud', badge: 'conflict' }, {}), 'conflict')
  assert.equal(testApi.indicatorStateOf({ mode: 'cloud', badge: 'offline' }, {}), 'offline')
  assert.equal(testApi.indicatorStateOf({ mode: 'local', badge: 'local' }, {}), 'local')
  // Идёт обмен — синее облако с бегущей точкой, даже если прошлый значок «synced».
  assert.equal(testApi.indicatorStateOf({ mode: 'cloud', badge: 'synced' }, { syncing: true }), 'exchanging')
  // Конфликт важнее идущего обмена.
  assert.equal(testApi.indicatorStateOf({ mode: 'cloud', badge: 'conflict' }, { syncing: true }), 'conflict')
})

test('индикатор: подсказка — режим, дата последней синхронизации, размер', () => {
  const testApi = exported.__test
  const tip = testApi.indicatorTip({
    id: 'session-1',
    mode: 'cloud',
    badge: 'synced',
    bytes: 2048,
    syncedAt: '2026-11-23T20:41:00.000Z',
  }, {})
  assert.match(tip, /Облачная сессия/)
  assert.match(tip, /Синхронизирована/)
  assert.match(tip, /последняя синхронизация 2026-11-23 20:41/)
  assert.match(tip, /размер 2,0 КБ/)

  const localTip = testApi.indicatorTip({
    id: 'session-2',
    mode: 'local',
    badge: 'local',
    bytes: 512,
    cloudCopy: true,
  }, {})
  assert.match(localTip, /Локальная сессия: не синхронизируется/)
  assert.match(localTip, /синхронизация отключена/)
  assert.match(localTip, /размер 512 Б/)
  assert.match(localTip, /в облаке есть копия/)

  // Неизвестное состояние — «ждёт синхронизации», без выдуманных дат.
  const unknown = testApi.indicatorTip({ id: 'session-3', mode: 'cloud', badge: 'offline' }, {})
  assert.match(unknown, /Облако недоступно/)
  assert.match(unknown, /ещё не синхронизировалась/)
  assert.equal(testApi.formatBytesShort(1024), '1,0 КБ')
  assert.equal(testApi.formatBytesShort(0), '')
})

test('индикатор в списке: облако 26×18 + полоса 24×3, монитор 20×16, фокус и подсказка', () => {
  const testApi = exported.__test
  testApi.setSessionStates({
    ok: true,
    syncing: false,
    states: {},
    sessions: [
      { id: 'session-ind-synced', title: 'Синхронная', projectId: 'harness', path: 'C:\\work\\project', mode: 'cloud', state: 'green', badge: 'synced', attached: true, bytes: 4096, syncedAt: '2026-11-23T20:41:00.000Z' },
      { id: 'session-ind-pending', title: 'Ждёт', projectId: 'harness', path: 'C:\\work\\project', mode: 'cloud', state: 'orange', badge: 'pending', attached: true, bytes: 1000, syncedAt: '2026-11-20T10:00:00.000Z' },
      { id: 'session-ind-conflict', title: 'Конфликт', projectId: 'harness', path: 'C:\\work\\project', mode: 'cloud', state: 'green', badge: 'conflict', attached: true, bytes: 1000, syncedAt: null },
      { id: 'session-ind-offline', title: 'Офлайн', projectId: 'harness', path: 'C:\\work\\project', mode: 'cloud', state: 'orange', badge: 'offline', attached: true, bytes: 1000, syncedAt: null },
      { id: 'session-ind-local', title: 'Локальная', projectId: 'harness', path: 'C:\\work\\project', mode: 'local', state: 'green', badge: 'local', attached: true, bytes: 2048, syncedAt: null },
    ],
    modes: { local: 1, cloud: 4 },
    unattached: 0,
    workspaces: [],
    cloud: { offline: false, ok: true, at: null, message: '', skippedLocal: 0 },
    attachAvailable: true,
  })

  const treeWithIndicators = resolveNode(main.component({}))
  const indicatorNodes = walk(treeWithIndicators).filter((node) => String(node.props?.className ?? '') === 'dshs-ind')
  assert.equal(indicatorNodes.length, 5, 'у каждой строки свой индикатор')

  const byState = new Map(indicatorNodes.map((node) => [node.props['data-state'], node]))
  assert.deepEqual([...byState.keys()].sort(), ['conflict', 'local', 'offline', 'pending', 'synced'])

  // Облако — ровно 26×18, полоса — 24×3 (размеры заданы в CSS).
  const clouds = indicatorNodes
    .filter((node) => node.props['data-state'] !== 'local')
    .flatMap((node) => walk(node).filter((child) => child.type === 'svg'))
  assert.equal(clouds.length, 4, 'у четырёх облачных состояний есть облако')
  for (const cloud of clouds) {
    assert.equal(cloud.props.width, 26, 'облако 26 px')
    assert.equal(cloud.props.height, 18, 'облако 18 px')
    assert.equal(cloud.props.viewBox, '0 0 24 24')
  }
  const monitor = walk(byState.get('local')).find((node) => node.type === 'svg')
  assert.equal(monitor.props.width, 20, 'монитор 20 px')
  assert.equal(monitor.props.height, 16, 'монитор 16 px')
  assert.equal(walk(byState.get('local')).some((node) => String(node.props?.className ?? '') === 'dshs-ind-bar'), false, 'у локальной сессии полосы нет')
  assert.equal(walk(byState.get('synced')).some((node) => String(node.props?.className ?? '') === 'dshs-ind-bar'), true, 'у облачной есть полоса')

  // Заполнение полосы — проценты макета.
  const barWidth = (state) => {
    const bar = walk(byState.get(state)).find((node) => String(node.props?.className ?? '') === `dshs-ind-bar-fill dshs-ind-bar-fill-${state}`)
    assert.ok(bar, `заливка полосы ${state} нарисована`)
    return bar.props.style.width
  }
  assert.equal(barWidth('synced'), '100%')
  assert.equal(barWidth('pending'), '55%')
  assert.equal(barWidth('conflict'), '100%')
  assert.equal(barWidth('offline'), '25%')

  // Пульс, бегущая точка и «!» — отдельные элементы.
  assert.equal(walk(byState.get('pending')).some((node) => String(node.props?.className ?? '') === 'dshs-ind-dot'), true, 'пульсирующая точка pending')
  assert.equal(walk(byState.get('conflict')).some((node) => textOf(node) === '!'), true, '«!» у конфликта')
  const offlinePaths = walk(byState.get('offline')).filter((node) => node.type === 'path' && node.props.stroke === '#7E8694' && node.props.strokeWidth === 1.8)
  assert.equal(offlinePaths.length, 2, 'облако offline перечёркнуто')

  // Клавиатурный фокус и подсказка (title + aria) у каждого индикатора.
  for (const node of indicatorNodes) {
    assert.equal(node.props.tabIndex, 0, 'индикатор доступен с клавиатуры')
    assert.equal(node.props.role, 'img')
    assert.equal(typeof node.props.title, 'string')
    assert.ok(node.props.title.length > 10, 'подсказка содержательна')
    assert.equal(node.props['aria-label'], node.props.title, 'aria совпадает с title')
    assert.match(node.props.title, /Облачная сессия|Локальная сессия/)
    const tipNode = walk(node).find((child) => String(child.props?.className ?? '') === 'dshs-ind-tip')
    assert.ok(tipNode, 'всплывающая подсказка отрисована')
    assert.equal(tipNode.props.id, node.props['aria-describedby'])
  }
  const syncedTip = walk(byState.get('synced')).find((node) => String(node.props?.className ?? '') === 'dshs-ind-tip')
  assert.match(textOf(syncedTip), /последняя синхронизация 2026-11-23 20:41/)
  assert.match(textOf(syncedTip), /размер 4,0 КБ/)

  // Обмен с облаком: 70 % + бегущая точка.
  testApi.setSessionStates({
    ok: true,
    syncing: true,
    states: {},
    sessions: [
      { id: 'session-ind-exchanging', title: 'Обмен', projectId: 'harness', path: 'C:\\work\\project', mode: 'cloud', state: 'green', badge: 'synced', attached: true, bytes: 1000, syncedAt: null },
    ],
    modes: { local: 0, cloud: 1 },
    unattached: 0,
    workspaces: [],
    cloud: { offline: false, ok: true },
    attachAvailable: true,
  })
  const exchangingTree = resolveNode(main.component({}))
  const exchanging = walk(exchangingTree).find((node) => String(node.props?.className ?? '') === 'dshs-ind')
  assert.equal(exchanging.props['data-state'], 'exchanging')
  const exchangingFill = walk(exchanging).find((node) => String(node.props?.className ?? '').includes('dshs-ind-bar-fill-exchanging'))
  assert.equal(exchangingFill.props.style.width, '70%')
  assert.equal(walk(exchanging).some((node) => String(node.props?.className ?? '') === 'dshs-ind-run'), true, 'бегущая точка exchanging')

  // Слот левой панели отдаёт тот же индикатор, а не прежнюю точку.
  const indicatorSlot = registrations.find((entry) => entry.options.name === 'sidebar.session.row.leading')
  assert.ok(indicatorSlot, 'слот индикатора в списке сессий зарегистрирован')
  testApi.setSessionStates({
    ok: true,
    syncing: false,
    states: {},
    sessions: [
      { id: 'session-slot-1', mode: 'cloud', badge: 'synced', state: 'green', attached: true, bytes: 10 },
    ],
    modes: { local: 0, cloud: 1 },
    unattached: 0,
    workspaces: [],
    cloud: { offline: false, ok: true },
    attachAvailable: true,
  })
  const slotNode = resolveNode(indicatorSlot.component({ sessionId: 'session-slot-1' }))
  assert.equal(slotNode.type, 'span')
  assert.equal(slotNode.props.className, 'dshs-ind')
  assert.equal(slotNode.props['data-state'], 'synced')

  testApi.setSessionStates(null)
})

test('reduced-motion: анимации выключены, заполнение и «!» остаются', () => {
  const pageCss = styles.find((text) => typeof text === 'string' && text.includes('.dshs-ind'))
  assert.ok(pageCss, 'стили индикатора внедрены')
  assert.match(pageCss, /@keyframes dshs-ind-pulse/)
  assert.match(pageCss, /@keyframes dshs-ind-run/)
  assert.match(pageCss, /@keyframes dshs-ind-breathe/)
  assert.match(pageCss, /@media\(prefers-reduced-motion:reduce\)\{/, 'есть медиа reduced-motion')
  assert.match(pageCss, /@media\(prefers-reduced-motion:reduce\)\{[^}]*animation:none !important/, 'при reduced-motion анимации выключены')
  // Размеры и заполнение — не в анимации: полоса и проценты остаются.
  assert.match(pageCss, /\.dshs-ind-bar\{[^}]*width:24px/, 'полоса 24 px')
  assert.match(pageCss, /\.dshs-ind-bar\{[^}]*height:3px/, 'полоса 3 px')
  assert.match(pageCss, /\.dshs-ind-bar\{[^}]*border-radius:1\.5px/, 'радиус полосы 1.5')
  assert.match(pageCss, /\.dshs-ind-bar-fill-synced[^{]*\{[^}]*linear-gradient\(90deg,#6EE2FF,#4882FF\)/, 'синяя заливка бренда')
  assert.match(pageCss, /\.dshs-ind-bar-fill-pending\{background:#F7BE4C\}/)
  assert.match(pageCss, /\.dshs-ind-bar-fill-conflict\{background:#EC6064\}/)
  assert.match(pageCss, /\.dshs-ind-bar-fill-offline\{background:#7E8694\}/)
  assert.match(pageCss, /\.dshs-ind-bang\{[^}]*color:#EC6064/, '«!» конфликта виден и без анимации')
  assert.match(pageCss, /\.dshs-ind:focus-visible\{outline:/, 'у индикатора есть focus-visible')
  assert.match(pageCss, /\.dshs-ind:hover \.dshs-ind-tip,\.dshs-ind:focus-visible \.dshs-ind-tip\{opacity:1/, 'подсказка видна по hover/focus')
})

test('умолчание режима рабочих пространств: селектор в карточке режимов', () => {
  exported.__test.setSessionStates({
    ok: true,
    syncing: false,
    states: {},
    sessions: [],
    modes: { local: 0, cloud: 0 },
    unattached: 0,
    workspaces: [
      { id: 'ws-alpha', title: 'Alpha', path: 'C:\\work\\alpha', sessions: 3, defaultMode: 'local' },
      { id: 'ws-beta', title: 'Beta', path: 'C:\\work\\beta', sessions: 2, defaultMode: 'cloud' },
    ],
    cloud: { offline: false, ok: true, at: null, message: '' },
    attachAvailable: true,
  })
  const tree = resolveNode(main.component({}))
  const nodes = walk(tree)
  const text = nodes.map(textOf).join('\n')
  assert.match(text, /Режим по умолчанию для рабочих пространств/)
  assert.match(text, /Действует для новых сессий; уже переключённые сессии не меняются\./)
  assert.match(text, /Alpha · сессий: 3/)
  assert.match(text, /Beta · сессий: 2/)

  const select = nodes.find((node) => node.type === 'select' && String(node.props?.['aria-label'] ?? '').startsWith('Режим по умолчанию для Alpha'))
  assert.ok(select, 'селектор умолчания для Alpha есть')
  assert.equal(select.props.value, 'local', 'умолчание Alpha — локальная')
  const options = select.children.map((option) => option?.props?.value)
  assert.deepEqual(options, ['cloud', 'local'])
  assert.match(text, /Облачная/)
  assert.match(text, /Локальная/)

  const modesCss = styles.find((textCss) => typeof textCss === 'string' && textCss.includes('.dshs-ws-default-row'))
  assert.ok(modesCss, 'стили умолчаний внедрены')
  assert.match(modesCss, /\.dshs-ws-default-row\{[^}]*flex-wrap:wrap/, 'строка умолчания переносится на узком экране')
  assert.match(modesCss, /\.dshs-ws-defaults\{[^}]*min-width:0/, 'блок не распирает карточку')

  exported.__test.setSessionStates(null)
})

test('облачная копия локальной сессии: подсказка и действие «Удалить копию из облака»', () => {
  exported.__test.setSessionStates({
    ok: true,
    syncing: false,
    states: {},
    sessions: [
      {
        id: 'session-local-copy',
        title: 'Локальная работа',
        projectId: 'harness',
        path: 'C:\\work\\project',
        mode: 'local',
        state: 'green',
        badge: 'local',
        attached: true,
        bytes: 2048,
        syncedAt: null,
        cloudCopy: true,
        cloudCopyBytes: 1536,
      },
    ],
    modes: { local: 1, cloud: 0 },
    unattached: 0,
    workspaces: [],
    cloud: { offline: false, ok: true, at: null, message: '' },
    attachAvailable: true,
  })
  const tree = resolveNode(main.component({}))
  const nodes = walk(tree)
  const text = nodes.map(textOf).join('\n')
  assert.match(text, /В облаке есть копия \(1,5 КБ\), локально отключена — сессия остаётся здесь\./)
  const deleteButton = nodes.find((node) => node.type === 'button' && textOf(node).trim() === 'Удалить копию из облака')
  assert.ok(deleteButton, 'кнопка «Удалить копию из облака» есть')
  assert.equal(deleteButton.props.disabled, false)
  assert.equal(deleteButton.props.style.height, 32, 'кнопка действия 32 px')
  assert.equal(deleteButton.props.style.borderRadius, 10)
  const copyHint = nodes.find((node) => String(node.props?.className ?? '').includes('dshs-cloud-copy'))
  assert.ok(copyHint, 'блок-подсказка оформлен классом dshs-cloud-copy')

  // Отдельное действие и в меню сессии: подсказка + подтверждение вторым кликом.
  const menuRegistration = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  const menuNode = resolveNode(menuRegistration.component({
    sessionId: 'session-local-copy',
    useMenuOpenState: () => [false, () => {}],
  }))
  const menuText = textOf(menuNode)
  assert.match(menuText, /Удалить копию из облака/, 'действие в меню сессии')
  assert.match(menuText, /в облаке есть копия, локальная сессия останется/)

  const pageCss = styles.find((textCss) => typeof textCss === 'string' && textCss.includes('.dshs-ind'))
  assert.match(pageCss, /\.dshs-cloud-copy\{[^}]*min-width:0/, 'подсказка не распирает строку')
  assert.match(pageCss, /\.dshs-cloud-copy-actions\{[^}]*flex-wrap:wrap/, 'кнопки подтверждения переносятся')

  exported.__test.setSessionStates(null)
})

test('skippedLocal в панели: строка «Локальных сессий пропущено» и журнал', () => {
  exported.__test.setHostState({
    ...readyState,
    lastRun: {
      at: '2026-11-22T10:00:00.000Z',
      ok: true,
      message: 'синхронизировано',
      skippedLocal: 4,
      localMirrorProtected: 2,
    },
    history: [
      { at: '2026-11-22T09:00:00.000Z', ok: true, message: 'отправлено: 2', skippedLocal: 4 },
    ],
  })
  const tree = resolveNode(main.component({}))
  const text = walk(tree).map(textOf).join('\n')
  assert.match(text, /Локальных сессий пропущено: 4 \(копий в зеркале защищено: 2\)\./)
  assert.match(text, /локальных пропущено: 4/)
  exported.__test.setHostState(readyState)
})

test('карточка «Проверка»: план из шести корзин, «ничего не изменено» и «Применить удаления (N)»', () => {
  assert.equal(typeof exported.__test.setPlan, 'function', 'крючок плана доступен тестам')

  // Пустое состояние: кнопка «Проверить» и подсказка, что изменения не делаются.
  exported.__test.setPlan(null)
  const emptyText = walk(resolveNode(main.component({}))).map(textOf).join('\n')
  assert.match(emptyText, /Сравнение локальных сессий с зеркалом/, 'карточка «Проверка» на странице')
  assert.match(emptyText, /Удаления выполняются только кнопкой «Применить удаления»/, 'подсказка про подтверждение')
  assert.ok(emptyText.includes('Проверить'), 'кнопка «Проверить» есть без плана')

  const plan = {
    ok: true,
    readOnly: true,
    action: 'plan',
    at: '2026-11-22T10:05:00.000Z',
    message: 'Проверка выполнена: удалений 2 ждёт подтверждения; ничего не изменено.',
    counts: { onlyLocal: 1, onlyCloud: 2, same: 3, localAhead: 4, cloudAhead: 5, conflicts: 6 },
    sizes: { onlyLocal: 1024, onlyCloud: 2048, same: 3072, localAhead: 4096, cloudAhead: 5120, conflicts: 6144 },
    buckets: {
      onlyLocal: [{ id: 'session-local-1' }],
      onlyCloud: [{ id: 'session-cloud-1' }, { id: 'session-cloud-2' }],
      same: [],
      localAhead: [],
      cloudAhead: [],
      conflicts: [],
    },
    deletions: [
      { id: 'session-drop-1', title: 'Старый диалог', humanReason: 'удалено локально', reason: 'prune', size: 512 },
      { id: 'session-drop-2', title: '', humanReason: 'удалено вместе с родителем', reason: 'children', size: 256, parent: 'session-drop-1' },
    ],
    deletionCount: 2,
    localSkipped: 1,
    warnings: [],
    requireConfirmation: { removed: 2, subagents: 1, maxCount: 5, maxRatio: 0.2, overCount: false },
  }
  exported.__test.setPlan(plan)
  const nodes = walk(resolveNode(main.component({})))
  const text = nodes.map(textOf).join('\n')

  // Корзины подписаны и показывают числа.
  for (const label of ['Только локально', 'Только в зеркале', 'Совпадают', 'Локально новее', 'В зеркале новее', 'Расхождения']) {
    assert.ok(nodes.some((node) => textOf(node).includes(label)), `корзина «${label}» на странице`)
  }
  assert.match(text, /Только локально/, 'подпись корзины')
  assert.match(text, /Только в зеркале/, 'счётчики и списки корзин')

  // План — только чтение: подпись «ничего не изменено» и блок удалений.
  assert.match(text, /ничего не изменено/i)
  assert.match(text, /Было бы удалено из зеркала: 2/)
  assert.match(text, /Удаления 2 2 · в карантин на 30 дней/, 'список удалений свёрнут, но счётчик и срок видны')

  // Кнопка удалений невидима до подтверждения: сначала «Применить удаления (N)».
  const applyButton = nodes.find((node) => node.type === 'button' && textOf(node).trim() === 'Применить удаления (2)')
  assert.ok(applyButton, 'кнопка «Применить удаления (2)» есть только при deletions > 0')
  assert.equal(applyButton.props.style.height, 36, 'кнопка удалений 36 px')
  assert.equal(applyButton.props.style.borderRadius, 10)
  const checkButton = nodes.find((node) => node.type === 'button' && textOf(node).trim() === 'Проверить снова')
  assert.ok(checkButton, 'после проверки кнопка предлагает проверить снова')

  // Без удалений план говорит прямо, что удалять нечего.
  exported.__test.setPlan({ ...plan, deletions: [], deletionCount: 0, requireConfirmation: undefined })
  const noDeletions = walk(resolveNode(main.component({}))).map(textOf).join('\n')
  assert.match(noDeletions, /Удалений нет: удалять из зеркала нечего\./)
  assert.equal(noDeletions.includes('Применить удаления'), false, 'кнопка удалений скрыта, когда удалений нет')

  exported.__test.setPlan(null)
})
