/**
 * Дымовой прогон клиентской половины: загружаем client.js в поддельном окне,
 * вызываем factory с заглушкой React и проверяем, что карточка регистрируется
 * и рендерится без ошибок.
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

// Мини-React: ровно то, что использует карточка.
let stateSlots = []
globalThis.document = {
  documentElement: { style: {}, dataset: {} },
  createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
  head: { appendChild() {} },
}
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
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
assert.equal(registrations.length, 9)
assert.ok(registrations.some(entry => entry.options.name === 'plugins.detail.section'), 'настройки на странице своего плагина')
assert.ok(registrations.some(entry => entry.options.name === 'main' && entry.options.key === 'dsh-sync'), 'страница плагина в main')
assert.ok(registrations.some(entry => entry.options.name === 'sidebar.panellist'), 'пункт в левой панели')
assert.ok(registrations.some(entry => entry.options.name === 'sidebar.session.row.leading'), 'индикатор в строке сессии')
assert.ok(registrations.some(entry => entry.options.name === 'sidebar.footer.action'), 'строка состояния в подвале панели')
assert.ok(registrations.some(entry => entry.options.name === 'conversation.composer.dock'), 'плашка состояния у поля ввода')
assert.ok(!registrations.some(entry => entry.options.name === 'conversation.header'), 'шапку беседы не трогаем: слот одиночный')
const cardRegistration = registrations.find(entry => entry.options.name === 'plugins.item')
assert.ok(cardRegistration, 'карточка плагина регистрируется')
const { options, component } = cardRegistration
assert.equal(options.id, 'dsh-sync')
assert.equal(options.name, 'plugins.item')
assert.equal(typeof component, 'function')
assert.equal(typeof options.label(), 'string')
assert.ok(effects.length > 0, 'эффект с словарями должен регистрироваться')

// Рендер сводки и полной карточки на пустом снимке состояния.
const summary = component({ view: 'summary' })
assert.equal(summary.type, 'span')
const page = component({ view: 'page' })
assert.equal(page.type, 'div')
assert.ok(page.children.length >= 3, 'страница карточки содержит проверку, настройки и синхронизацию')

// Страница пункта в левой панели и иконка рендерятся без ошибок.
const panelRegistration = registrations.find(entry => entry.options.name === 'main')
const panel = panelRegistration.component({})
assert.equal(panel.type, 'div')
assert.ok(panel.children.length >= 3, 'страница синхронизации содержит статус и кнопку')

const sidebarRegistration = registrations.find(entry => entry.options.name === 'sidebar.panellist')
const icon = sidebarRegistration.component({ size: 16 })
assert.equal(icon.type, 'span', 'иконка дополнена контейнером для уведомлений')
assert.ok(icon.children.some((child) => child && child.type === 'svg'), 'внутри остаётся иконка')

// Индикатор без данных ничего не рисует (точка появляется после ответа host).
const dotRegistration = registrations.find(entry => entry.options.name === 'sidebar.session.row.leading')
assert.equal(dotRegistration.component({ sessionId: 'session-x' }), null)

console.log('client smoke: OK')
console.log('  слот:', options.name, '| id:', options.id, '| label:', options.label())
console.log('  элементов на странице:', page.children.length)
