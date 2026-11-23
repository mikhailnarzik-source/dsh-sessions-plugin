/**
 * Дымовой прогон клиентской половины: загружаем client.js в поддельном окне,
 * вызываем factory с заглушкой React и проверяем, что компоненты
 * регистрируются и страница синхронизации рендерится без ошибок.
 *
 * Это не модульный тест (npm test гоняет test/*.test.mjs): скрипт удобно
 * запускать отдельно при правках слотов и клиентской части.
 *
 * Запуск: node test/client-smoke.mjs
 */
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let loaded
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }

// eslint-disable-next-line no-new-func
new Function(source)()
assert.equal(loaded?.id, 'dsh-sessions', 'идентификатор клиента совпадает с именем пакета')
assert.equal(typeof loaded.factory, 'function')

// Мини-React: ровно то, что использует клиент.
globalThis.document = {
  documentElement: { style: {}, dataset: {} },
  body: {},
  createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
  head: { appendChild() {} },
}
const React = {
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(next) { this.state = { ...this.state, ...next } }
  },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useReducer: (reducer, initial) => [initial, () => {}],
}

const modules = { react: React, 'react-dom': { createPortal: (node) => node } }
const requireStub = (id) => {
  if (modules[id] === undefined) throw new Error(`неожиданный require: ${id}`)
  return modules[id]
}

const exported = loaded.factory(requireStub)
assert.equal(typeof exported.apply, 'function')
assert.deepEqual(exported.inject, ['slots', 'locale'])

const registrations = []
const effects = []
let boundNs = ''
const ctx = {
  effect: (fn, label) => { effects.push(label); fn() },
  locale: {
    bind: (ns) => { boundNs = ns; return (key) => key },
    subscribe: () => () => {},
    register: (ns, localeOrDict, maybeDict) => {
      const dictionary = maybeDict ?? localeOrDict
      assert.equal(typeof dictionary, 'object', `нет словаря для ${ns}`)
    },
  },
  slots: {
    inject: (name, register) => { register() },
    register: (options, component) => { registrations.push({ options, component }) },
  },
}

exported.apply(ctx)

assert.ok(['dshSync', 'sessionDelete'].includes(boundNs), 'пространство имён клиента зарегистрировано')
// 6 регистраций карточки синхронизации (main — две, по старому и новому ключу)
// плюс 2 пункта удаления сессии и пункт меню режима сессии.
assert.equal(registrations.length, 9, 'все слоты зарегистрированы')
const mainEntries = registrations.filter((entry) => entry.options.name === 'main')
assert.deepEqual(mainEntries.map((entry) => entry.options.key).sort(), ['dsh-sessions', 'dsh-sync'])
assert.ok(registrations.some((entry) => entry.options.name === 'sidebar.panellist'), 'пункт в левой панели')
assert.ok(registrations.some((entry) => entry.options.name === 'sidebar.session.row.leading'), 'индикатор в строке сессии')
assert.ok(registrations.some((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item'), 'пункт меню режима сессии')
assert.ok(registrations.some((entry) => entry.options.name === 'conversation.composer.dock'), 'плашка у поля ввода')
assert.ok(registrations.some((entry) => entry.options.name === 'plugins.detail.section'), 'секция на странице плагина')
assert.ok(!registrations.some((entry) => entry.options.name === 'conversation.header'), 'шапку беседы не трогаем: слот одиночный')
assert.ok(effects.length > 0, 'эффект со словарями должен регистрироваться')

// Обёртка-перехватчик ошибок — это класс: разворачиваем до обычного элемента.
const unwrap = (node) => {
  let current = node
  for (let step = 0; step < 10; step += 1) {
    if (current === null || typeof current !== 'object') return current
    const type = current.type
    if (typeof type === 'function' && type.prototype?.render) {
      current = new type({ ...current.props, children: current.children?.[0] ?? null }).render()
      continue
    }
    if (typeof type === 'function') {
      current = type({ ...current.props, children: current.children?.length === 1 ? current.children[0] : current.children })
      continue
    }
    return current
  }
  return current
}

// Страница пункта в левой панели: шапка и центрированный контейнер.
const panel = unwrap(mainEntries[0].component({}))
assert.equal(panel.type, 'div')
assert.match(String(panel.props.className), /dshs-sync-page/, 'страница синхронизации с полями по краям')
assert.ok(panel.children.length >= 1, 'внутри страницы есть контейнер с контентом')

// Глубокий разбор дерева: рендерим и вложенные компоненты, чтобы поймать
// ошибки в новых секциях (список сессий, профиль, рабочие пространства).
const deepExpand = (node, depth = 0) => {
  if (depth > 16) return '<max-depth>'
  if (Array.isArray(node)) return node.map((child) => deepExpand(child, depth + 1))
  if (node === null || node === undefined) return null
  if (typeof node !== 'object') return node
  const type = node.type
  const props = { ...(node.props ?? {}) }
  const children = node.children?.length === 1 ? node.children[0] : node.children
  if (typeof type === 'function') {
    let rendered
    if (type.prototype?.render) rendered = new type({ ...props, children }).render()
    else rendered = type({ ...props, children })
    return deepExpand(rendered, depth + 1)
  }
  return { type, props, children: deepExpand(node.children, depth + 1) }
}
const pageTree = JSON.stringify(deepExpand(mainEntries[0].component({})))
assert.match(pageTree, /Сессии и режим синхронизации/, 'секция режимов сессий на странице')
assert.match(pageTree, /Профиль и рабочие пространства/, 'секция профиля и рабочих пространств')
assert.match(pageTree, /Синхронизирована|Локальная сессия|Сессии появятся/, 'у секции режимов есть содержимое')

// Пункт меню сессии рендерится и подписан режимом по умолчанию (облако).
const menuRegistration = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
const menuItem = deepExpand(menuRegistration.component({
  sessionId: 'session-smoke',
  useMenuOpenState: () => [false, () => {}],
}))
const menuTree = JSON.stringify(menuItem)
assert.match(menuTree, /Сделать локальной/, 'меню предлагает сделать сессию локальной')

// Секция на странице плагина тоже рендерится без ошибок.
const detailEntry = registrations.find((entry) => entry.options.name === 'plugins.detail.section')
const detail = unwrap(detailEntry.component({ subject: { kind: 'bundle', pkg: { name: 'dsh-sessions' } } }))
assert.equal(detail.type, 'div')
assert.match(String(detail.props.className), /dshs-detail/)

// Секция чужого плагина не показывает наши настройки.
assert.equal(detailEntry.component({ subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } }), null)

// Иконка в левой панели: svg в контейнере (обёртка нужна для точки состояния).
const sidebarRegistration = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
const icon = unwrap(sidebarRegistration.component({ size: 16 }))
assert.equal(icon.type, 'span', 'иконка дополнена контейнером для уведомлений')
assert.ok(icon.children.some((child) => child && child.type === 'svg'), 'внутри остаётся иконка')

// Индикатор без данных ничего не рисует (точка появляется после ответа host).
const dotRegistration = registrations.find((entry) => entry.options.name === 'sidebar.session.row.leading')
assert.equal(dotRegistration.component({ sessionId: 'session-x' }), null)

console.log('client smoke: OK')
console.log('  регистраций:', registrations.length)
console.log('  страница синхронизации:', panel.props.className)
