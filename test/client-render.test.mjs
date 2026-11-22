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
    secondary: { backend: 'none' },
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
  assert.match(pageCss, /@media \(max-width:720px\)\{\.dshs-sync-page\{padding:\d+px 16px \d+px\}\}/, 'на узком экране поля 16 px')
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
  const titles = ['Синхронизация', 'Подключение', 'Дополнительно', 'Проверка окружения', 'Обслуживание']
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
    'Резервное хранилище (дублирование)',
  ]) {
    assert.ok(texts.includes(label), `поле «${label}» на месте`)
  }

  const selects = nodes.filter((node) => node.type === 'select')
  assert.ok(selects.length >= 2, 'есть выбор хранилища и резерва')
  const backends = selects[0].children.map((option) => option?.props?.value)
  assert.deepEqual(backends, ['git', 'folder', 'webdav', 'yandex'], 'все типы хранилищ сохранены')

  for (const label of ['Синхронизировать', 'Только принять', 'Только отправить', 'Сохранить', 'Создать репозиторий', 'Диагностика']) {
    assert.ok(buttonTexts.includes(label), `кнопка «${label}» на месте`)
  }
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
