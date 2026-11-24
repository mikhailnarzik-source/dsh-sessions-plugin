/**
 * M4: онбординг нового устройства, песочница и статус секретов.
 *
 * Что проверяем:
 * - чистый `collectOnboarding` (lib/onboarding.mjs): шаги и статусы
 *   ok/warn/fail/todo, ready/count, semver-сравнение версии DSH;
 * - в отчёте нет значений секретов — только «есть/нет» (ни в JSON, ни в HTML);
 * - песочница: on/off/unknown по политике, unknown без сервиса;
 * - host: GET /api/dsh-sync/onboarding, поле onboarding в /state, старые
 *   маршруты M3 на месте;
 * - client: чип «Это новое устройство? N шагов» в шапке карточки «Сессии и
 *   режим», карточка со шагами, блоки «Песочница и доступы» и «Секреты»,
 *   git-команды, кнопка «Проверить»; M3-карточки не сломаны.
 *
 * Запуск: node --import ./test/setup.mjs --test test/m4-onboarding.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import {
  DSH_MIN_VERSION,
  collectOnboarding,
  compareVersions,
  describeSandbox,
  isVersionAtLeast,
  parseVersion,
  sanitizeRemote,
} from '../lib/onboarding.mjs'

// Секрет-приманка: его не должно быть ни в JSON, ни в отрисованном дереве.
const SECRET_SENTINEL = 'TESTONLY-SECRET-0123456789ABCDEF'
const LEAK_KEYS = ['value', 'masked', 'token', 'password', 'secret']

function allOkInput(patch = {}) {
  return {
    tools: {
      node: { ok: true, version: 'v24.13.0' },
      git: { ok: true, version: '2.50.0' },
    },
    dshVersion: '0.2.3-alpha.2',
    refs: {
      GITHUB_TOKEN: { configured: true },
      DEEPSEEK_API_KEY: { configured: true },
      DSH_SYNC_WEBDAV_PASSWORD: { configured: true },
      DSH_VAULT_PASSPHRASE: { configured: true },
    },
    profile: { available: true, conflictCount: 0, plan: { present: false, files: 0 } },
    sync: {
      backend: 'git',
      remote: 'https://github.com/user/dsh-sessions.git',
      repoDir: 'C:\\mirror',
      configured: true,
      reachable: true,
    },
    localCopies: { checked: true, count: 0 },
    workspace: { enabled: true, matched: 2, localWorkspaces: 2, hints: [] },
    sandbox: { available: true, mode: 'workspace-write', workspaceRoot: 'C:\\work' },
    ...patch,
  }
}

const stepById = (report, id) => report.steps.find(step => step.id === id)

// --- 1. Детекция шагов ------------------------------------------------------

test('onboarding: все шаги в порядке → ready и count 0', () => {
  const report = collectOnboarding(allOkInput())
  assert.equal(report.ok, true)
  assert.equal(report.steps.length, 10, 'десять шагов нового устройства')
  assert.equal(report.ready, true, 'готово к работе')
  assert.equal(report.count, 0, 'ни одного шага к выполнению')
  assert.equal(report.fail, 0)
  assert.equal(report.todo, 0)
  for (const step of report.steps) {
    assert.equal(step.status, 'ok', `шаг ${step.id} в порядке`)
    assert.ok(typeof step.title === 'string' && step.title !== '', `у шага ${step.id} есть заголовок`)
    assert.ok(typeof step.detail === 'string', `у шага ${step.id} есть пояснение`)
  }
  assert.equal(report.version.min, DSH_MIN_VERSION)
  assert.equal(report.version.current, '0.2.3-alpha.2')
})

test('onboarding: не хватает GitHub-токена → fail именно на этом шаге', () => {
  const report = collectOnboarding(allOkInput({
    refs: { ...allOkInput().refs, GITHUB_TOKEN: { configured: false } },
  }))
  const step = stepById(report, 'github-token')
  assert.equal(step.status, 'fail', 'без токена git-хранилище не заработает')
  assert.match(step.detail, /не задан/)
  assert.deepEqual(step.action, { label: 'Открыть настройки', route: 'settings' })
  assert.equal(report.ready, false)
  assert.ok(report.count >= 1)
  assert.equal(report.fail, 1)
})

test('onboarding: конфликт профиля — warn с кнопкой «Применить профиль», не блокирует работу', () => {
  const report = collectOnboarding(allOkInput({
    profile: { available: true, conflictCount: 3, plan: { present: false, files: 0 } },
  }))
  const step = stepById(report, 'profile')
  assert.equal(step.status, 'warn')
  assert.match(step.detail, /конфликтов в журнале: 3/)
  assert.deepEqual(step.action, { label: 'Применить профиль', route: 'profile-apply' })
  assert.equal(report.warn, 1)
  assert.equal(report.ready, true, 'предупреждение не блокирует готовность')
})

test('onboarding: старый DSH и неизвестная версия дают fail/todo', () => {
  const old = collectOnboarding(allOkInput({ dshVersion: '0.2.2' }))
  assert.equal(stepById(old, 'dsh-version').status, 'fail')
  assert.equal(old.ready, false)

  const unknown = collectOnboarding(allOkInput({ dshVersion: undefined }))
  assert.equal(stepById(unknown, 'dsh-version').status, 'todo')
  assert.equal(unknown.ready, false)
})

test('onboarding: нет git/Node → fail с перечнем отсутствующего', () => {
  const report = collectOnboarding(allOkInput({
    tools: { node: { ok: false, version: '' }, git: { ok: true, version: '2.50.0' } },
  }))
  const step = stepById(report, 'tools')
  assert.equal(step.status, 'fail')
  assert.match(step.detail, /Node\.js/)
  assert.ok(step.action !== null && step.action.route === 'refresh')
})

test('onboarding: локальные копии и рабочее пространство — необязательные шаги', () => {
  const report = collectOnboarding(allOkInput({
    localCopies: { checked: true, count: 4 },
    workspace: { enabled: true, matched: 0, localWorkspaces: 2, hints: [{}, {}] },
  }))
  const copies = stepById(report, 'local-copies')
  assert.equal(copies.status, 'todo')
  assert.deepEqual(copies.action, { label: 'Убрать облачные копии', route: 'local-only-migration' })
  const workspace = stepById(report, 'workspace')
  assert.equal(workspace.status, 'todo')
  assert.match(workspace.detail, /не привязано сессий: 2/)
  assert.equal(report.count, 2, 'два шага к выполнению')
})

test('semver: prerelease сравнивается по semver, версия DSH — не ниже минимальной', () => {
  assert.deepEqual(parseVersion('0.2.3-alpha.2'), { main: [0, 2, 3], pre: ['alpha', '2'] })
  assert.equal(parseVersion('не версия'), null)
  assert.equal(compareVersions('0.2.3-alpha.1', '0.2.3-alpha.2'), -1)
  assert.equal(compareVersions('0.2.3-alpha.2', '0.2.3-alpha.2'), 0)
  assert.equal(compareVersions('0.2.3', '0.2.3-alpha.2'), 1)
  assert.equal(compareVersions('0.2.10', '0.2.3'), 1)
  assert.equal(compareVersions('0.3.0-alpha.1', '0.2.3-alpha.2'), 1)
  assert.equal(compareVersions('1.0.0+build', '1.0.0'), 0)
  assert.equal(isVersionAtLeast('0.2.3-alpha.2'), true)
  assert.equal(isVersionAtLeast('0.2.3-alpha.1'), false)
  assert.equal(isVersionAtLeast(''), false)
  assert.equal(isVersionAtLeast('0.2.3'), true)
})

test('onboarding: новый компьютер без адреса репозитория — sync todo, а не fail', () => {
  const report = collectOnboarding(allOkInput({
    sync: { backend: 'git', remote: '', repoDir: 'C:\\dsh-sync\\repo', configured: false, reachable: false },
  }))
  const step = stepById(report, 'sync')
  assert.equal(step.status, 'todo', 'ещё не настроено — это todo, а не ошибка')
  assert.match(step.detail, /не настроено/)
  assert.deepEqual(step.action, { label: 'Открыть настройки', route: 'settings' })
  assert.deepEqual(report.commands, [], 'без адреса репозитория git-команд нет')
  assert.equal(report.ready, false)
})

// --- 2. Песочница -----------------------------------------------------------

test('песочница: workspace-write → on, danger-full-access → off', () => {
  const on = describeSandbox({ sandbox: { available: true, mode: 'workspace-write', workspaceRoot: 'C:\\work' } })
  assert.equal(on.status, 'on')
  assert.match(on.label, /запись только в рабочем каталоге/)
  assert.ok(on.allowed.length > 0)
  assert.ok(on.denied.some(item => /вне рабочего каталога/.test(item)))
  assert.match(on.approvals, /подтвержден/i)

  const off = describeSandbox({ sandbox: { available: true, mode: 'danger-full-access', workspaceRoot: 'C:\\work' } })
  assert.equal(off.status, 'off')
  assert.equal(off.denied.length, 0)

  const readOnly = describeSandbox({ sandbox: { available: true, mode: 'read-only' } })
  assert.equal(readOnly.status, 'on')
  assert.match(readOnly.label, /только чтение/)
})

test('песочница: API политики недоступен → status unknown без догадок', () => {
  for (const input of [{}, { sandbox: { available: false } }, { sandbox: { available: true, mode: '' } }]) {
    const block = describeSandbox(input)
    assert.equal(block.status, 'unknown')
    assert.match(block.label, /неизвестно/)
    assert.equal(block.mode, null)
    assert.deepEqual(block.allowed, [])
    assert.deepEqual(block.denied, [])
  }
})

// --- 3. Секреты без значений --------------------------------

test('секреты: только «есть/нет», без значений и масок в JSON', () => {
  const report = collectOnboarding(allOkInput({
    refs: {
      GITHUB_TOKEN: { configured: true, value: SECRET_SENTINEL, masked: SECRET_SENTINEL },
      DEEPSEEK_API_KEY: { configured: false, value: SECRET_SENTINEL },
      DSH_SYNC_WEBDAV_PASSWORD: { configured: false },
      DSH_VAULT_PASSPHRASE: { configured: true },
    },
  }))
  assert.equal(report.secrets.length, 4)
  const github = report.secrets.find(secret => secret.id === 'GITHUB_TOKEN')
  assert.equal(github.present, true)
  assert.equal(github.ref, 'refs.GITHUB_TOKEN')
  assert.equal(report.secrets.find(secret => secret.id === 'DEEPSEEK_API_KEY').present, false)
  for (const secret of report.secrets) {
    for (const key of LEAK_KEYS) {
      assert.equal(Object.hasOwn(secret, key), false, `в секрете ${secret.id} нет поля ${key}`)
    }
  }
  const json = JSON.stringify(report)
  assert.equal(json.includes(SECRET_SENTINEL), false, 'значение секрета не попало в JSON')
  assert.equal(/("masked"|"value")\s*:/.test(json), false, 'нет полей value/masked')
})

test('секреты: реф не нужен (резерв не WebDAV) → шаг ok без действия', () => {
  const report = collectOnboarding(allOkInput({
    refs: { ...allOkInput().refs, DSH_SYNC_WEBDAV_PASSWORD: { configured: false } },
    sync: { ...allOkInput().sync, configured: true, reachable: true },
  }))
  const step = stepById(report, 'webdav-password')
  assert.equal(step.status, 'ok')
  assert.match(step.detail, /не нужен/)
  assert.equal(step.action, null)
})

test('git-команды: адрес репозитория без логина и пароля', () => {
  assert.equal(sanitizeRemote('https://user:pass@github.com/u/r.git'), 'https://github.com/u/r.git')
  assert.equal(sanitizeRemote('https://github.com/u/r.git'), 'https://github.com/u/r.git')
  const report = collectOnboarding(allOkInput({
    sync: {
      backend: 'git',
      remote: 'https://user:secret@github.com/user/dsh-sessions.git',
      repoDir: 'C:\\mirror',
      configured: true,
      reachable: true,
    },
  }))
  assert.equal(report.commands.length >= 1, true)
  const joined = report.commands.map(item => item.command).join('\n')
  assert.match(joined, /git ls-remote https:\/\/github\.com\/user\/dsh-sessions\.git/)
  assert.doesNotMatch(joined, /secret/)
})

// --- 4. Host: GET /api/dsh-sync/onboarding и поле onboarding в /state -------

const PROJECT = 'alpha'
const PROJECT_PATH = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'

async function makeEnvironment({ backend = 'folder', remote = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m4-onboarding-'))
  const home = join(root, 'home')
  const repoDir = join(root, 'mirror')
  await mkdir(home, { recursive: true })
  await mkdir(repoDir, { recursive: true })
  const config = {
    ...defaultConfig(home),
    backend,
    remote,
    deviceId: 'device-m4',
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

/** Фейковый credential store: describe отдаёт маску, но не значение. */
function makeCredentials({ present = true } = {}) {
  const seen = []
  return {
    seen,
    describe: async (ref) => {
      seen.push(ref)
      return present
        ? { configured: true, source: 'provider', writable: true, masked: `${SECRET_SENTINEL.slice(0, 7)}…` }
        : { configured: false, writable: true }
    },
    resolve: async () => undefined,
    listRecords: async () => [],
  }
}

async function bootPlugin({ home, credentials, sandboxPolicy }) {
  const previousHome = process.env.DSH_HOME
  const previousVersion = process.env.DSH_VERSION
  process.env.DSH_HOME = home
  process.env.DSH_VERSION = DSH_MIN_VERSION
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
      if (name === 'sandboxPolicy') return sandboxPolicy
      return undefined
    },
  }
  apply(ctx)
  return {
    routes,
    sandboxPolicy,
    async call(path, method = 'POST', payload = {}) {
      const route = routes.get(path)
      assert.ok(route, `маршрут ${path} зарегистрирован`)
      const response = await route.fetch(new Request(`http://local${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
      }))
      return { status: response.status, body: await response.json(), methods: route.methods }
    },
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          // таймеры уже сняты
        }
      }
    },
    restoreEnv: () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousVersion === undefined) delete process.env.DSH_VERSION
      else process.env.DSH_VERSION = previousVersion
    },
  }
}

test('маршрут GET /api/dsh-sync/onboarding: шаги, ready, count и никаких секретов', async () => {
  const env = await makeEnvironment()
  const credentials = makeCredentials({ present: true })
  let boot
  try {
    boot = await bootPlugin({ home: env.home, credentials })
    assert.ok(boot.routes.has('/api/dsh-sync/onboarding'), 'маршрут онбординга зарегистрирован')
    const { status, body, methods } = await boot.call('/api/dsh-sync/onboarding', 'GET')
    assert.equal(status, 200)
    assert.deepEqual(methods, ['GET'], 'маршрут только для чтения — GET')
    assert.equal(body.ok, true)
    assert.equal(Array.isArray(body.steps), true)
    assert.equal(body.steps.length, 10)
    assert.equal(typeof body.ready, 'boolean')
    assert.equal(typeof body.count, 'number')
    assert.equal(typeof body.warn, 'number')
    assert.equal(typeof body.fail, 'number')
    assert.equal(typeof body.todo, 'number')
    assert.equal(body.count, body.fail + body.todo)
    assert.ok(typeof body.sandbox === 'object' && body.sandbox !== null)
    assert.equal(body.sandbox.status, 'unknown', 'без сервиса sandboxPolicy — unknown')
    assert.equal(Array.isArray(body.secrets) && body.secrets.length === 4, true)
    for (const secret of body.secrets) {
      assert.equal(secret.present, true, 'фейковый store отдаёт «есть»')
    }
    // Секреты и маски не должны утечь в ответ ни в каком виде.
    const json = JSON.stringify(body)
    assert.equal(json.includes(SECRET_SENTINEL), false, 'значение секрета не в JSON')
    assert.equal(/("masked"|"value")\s*:/.test(json), false, 'нет полей value/masked')
    // Каждый шаг имеет стабильные поля контракта.
    for (const step of body.steps) {
      assert.ok(['ok', 'warn', 'fail', 'todo'].includes(step.status), `статус ${step.id}`)
      assert.ok(typeof step.id === 'string' && step.id !== '')
      assert.ok(typeof step.title === 'string' && step.title !== '')
      assert.equal(Object.hasOwn(step, 'action'), true)
    }
  } finally {
    boot?.dispose()
    boot?.restoreEnv()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('маршрут онбординга: песочница on и старые маршруты M3 на месте', async () => {
  const env = await makeEnvironment()
  const credentials = makeCredentials({ present: false })
  const sandboxPolicy = {
    defaultMode: 'workspace-write',
    workspaceRoot: env.root,
    additionalWritableRoots: [],
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: env.root, additionalWritableRoots: [] }),
  }
  let boot
  try {
    boot = await bootPlugin({ home: env.home, credentials, sandboxPolicy })
    const { body } = await boot.call('/api/dsh-sync/onboarding', 'GET')
    assert.equal(body.sandbox.status, 'on')
    assert.equal(body.sandbox.mode, 'workspace-write')
    assert.match(body.sandbox.label, /только в рабочем каталоге/)
    // Секретов нет: все present false, шаг токена — fail (git/remote настроен).
    assert.equal(body.secrets.every(secret => secret.present === false), true)
    assert.equal(body.steps.find(step => step.id === 'github-token').status, 'fail')
    assert.equal(body.ready, false)
    // M3-маршруты не потеряны.
    for (const path of [
      '/api/dsh-sync/state',
      '/api/dsh-sync/config',
      '/api/dsh-sync/run',
      '/api/dsh-sync/plan',
      '/api/dsh-sync/secondary-probe',
      '/api/dsh-sync/profile',
      '/api/dsh-sync/profile/apply',
    ]) {
      assert.ok(boot.routes.has(path), `маршрут ${path} на месте`)
    }
  } finally {
    boot?.dispose()
    boot?.restoreEnv()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('маршрут онбординга: git без адреса репозитория — шаг «Синхронизация» todo', async () => {
  const env = await makeEnvironment({ backend: 'git', remote: '' })
  const credentials = makeCredentials({ present: false })
  let boot
  try {
    boot = await bootPlugin({ home: env.home, credentials })
    const { body } = await boot.call('/api/dsh-sync/onboarding', 'GET')
    const syncStep = body.steps.find((step) => step.id === 'sync')
    assert.equal(syncStep.status, 'todo', 'без адреса это ещё не настроено, а не ошибка')
    assert.match(syncStep.detail, /не настроено/)
    assert.equal(body.commands.length, 0, 'git-команд без адреса нет')
    assert.equal(body.steps.find((step) => step.id === 'github-token').status, 'fail', 'для git-хранилища токен обязателен')
  } finally {
    boot?.dispose()
    boot?.restoreEnv()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('state: поле onboarding {ready,warn,fail} и без значений секретов', async () => {
  const env = await makeEnvironment()
  const credentials = makeCredentials({ present: true })
  let boot
  try {
    boot = await bootPlugin({ home: env.home, credentials })
    const { status, body } = await boot.call('/api/dsh-sync/state', 'POST')
    assert.equal(status, 200)
    assert.ok(body.onboarding !== null && typeof body.onboarding === 'object', 'сводка онбординга в состоянии')
    assert.equal(typeof body.onboarding.ready, 'boolean', 'onboarding.ready — булево')
    for (const key of ['warn', 'fail', 'todo', 'count']) {
      assert.equal(typeof body.onboarding[key], 'number', `onboarding.${key} — число`)
    }
    assert.equal(body.onboarding.count, body.onboarding.fail + body.onboarding.todo)
    const json = JSON.stringify(body)
    assert.equal(json.includes(SECRET_SENTINEL), false)
  } finally {
    boot?.dispose()
    boot?.restoreEnv()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 5. Client: чип и карточка онбординга -----------------------------------

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const clientStyles = []
let clientEntry
globalThis.window = { __ModuleLoader__: { load: (entry) => { clientEntry = entry } } }
globalThis.document = {
  documentElement: { style: {}, dataset: {} },
  body: {},
  createElement: () => ({ textContent: '', dataset: {}, remove() {} }),
  head: { appendChild: (node) => { clientStyles.push(node.textContent) } },
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
      useExternal: true,
      secondary: { backend: 'folder', folderDir: 'C:\\cloud\\dsh-sync-backup' },
    },
    secondary: { enabled: true, backend: 'folder', initialized: true },
    checks: [
      { id: 'node', title: 'Node.js', ok: true, detail: 'v24.13.0' },
      { id: 'git', title: 'git', ok: true, detail: '2.50.0' },
    ],
    status: { local: 2, mirror: 2, onlyLocal: 0, onlyMirror: 0, groups: 0, subagents: 0, orphans: 0 },
    external: { found: false },
    lastRun: { at: '2026-11-22T10:00:00.000Z', ok: true, message: 'синхронизировано' },
    history: [],
    backup: { percent: 100 },
    pending: false,
    onboarding: { ready: false, warn: 0, fail: 1, todo: 1, count: 2 },
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
  const state = initialState
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(state),
    }
  }
  const exported = clientEntry.factory((id) => {
    if (id === 'react') return MiniReact
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`неожиданный require: ${id}`)
  })
  exported.apply(ctx)
  exported.__test.setHostState(initialState)
  const main = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'dsh-sessions')
  assert.ok(main, 'страница синхронизации зарегистрирована')
  return { exported, main, registrations, calls }
}

const resolveNode = (node) => {
  let current = node
  for (let step = 0; step < 80; step += 1) {
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

const pageSections = (tree) => {
  const nodes = walk(tree)
  const root = nodes.find((node) => classNameOf(node).includes('dshs-sync-sections'))
  assert.ok(root, 'страница настроек найдена')
  return { nodes, root, children: root.children.filter((child) => child !== null && typeof child === 'object') }
}

const titleOf = (node) => {
  const heading = walk(node).find((child) => child.type === 'h2')
  return heading === undefined ? '' : textOf(heading).trim()
}

/** M3-контракт: четыре основные карточки не должны пострадать от M4. */
function assertM3Cards(main) {
  const tree = resolveNode(main.component({}))
  const { children } = pageSections(tree)
  const cards = children.filter((child) => child.type === 'section' && classNameOf(child).includes('dshs-sync-card'))
  const accordions = children.filter((child) => child.type === 'section' && classNameOf(child).includes('dshs-accordion'))
  assert.deepEqual(cards.map(titleOf), ['Хранилище', 'План и синхронизация', 'Сессии и режим', 'Резервный канал'], 'M3-карточки на месте')
  assert.equal(accordions.length, 2, 'M3-аккордеоны на месте')
  return { tree, cards, accordions }
}

function findChip(tree) {
  return walk(tree).find((node) => classNameOf(node).includes('dshs-onboarding-chip'))
}

test('client: чип «Это новое устройство? N шагов» в шапке карточки «Сессии и режим»', () => {
  const { main } = renderClient(hostState({ onboarding: { ready: false, warn: 0, fail: 1, todo: 1, count: 2 } }))
  const tree = resolveNode(main.component({}))
  const chip = findChip(tree)
  assert.ok(chip, 'чип онбординга отрисован')
  assert.equal(chip.type, 'button')
  assert.equal(chip.props['data-count'], '2')
  assert.equal(chip.props['data-ready'], 'false')
  assert.match(textOf(chip), /Это новое устройство\? 2 шага/)
  assert.equal(chip.props['aria-expanded'], 'false')
  // Чип стоит в шапке карточки «Сессии и режим», рядом со счётчиком групп.
  const sessionsCard = pageSections(tree).children.find((child) => titleOf(child) === 'Сессии и режим')
  assert.ok(sessionsCard, 'карточка «Сессии и режим» найдена')
  assert.ok(walk(sessionsCard).some((node) => classNameOf(node).includes('dshs-onboarding-chip')), 'чип именно в её шапке')
  assertM3Cards(main)
})

test('client: при ready чип показывает «Всё готово» и не считает шаги', () => {
  const { main } = renderClient(hostState({ onboarding: { ready: true, warn: 1, fail: 0, todo: 0, count: 0 } }))
  const tree = resolveNode(main.component({}))
  const chip = findChip(tree)
  assert.equal(chip.props['data-ready'], 'true')
  assert.equal(chip.props['data-count'], '0')
  assert.match(textOf(chip), /Всё готово/)
})

test('client: клик по чипу открывает карточку онбординга', () => {
  const { exported, main } = renderClient()
  const tree = resolveNode(main.component({}))
  const chip = findChip(tree)
  assert.equal(exported.__test.readOnboardingOpen(), false)
  chip.props.onClick()
  assert.equal(exported.__test.readOnboardingOpen(), true)
  exported.__test.setOnboardingOpen(false)
  assert.equal(exported.__test.readOnboardingOpen(), false)
})

const SAMPLE_REPORT = {
  ok: true,
  version: { min: DSH_MIN_VERSION, current: DSH_MIN_VERSION },
  steps: [
    { id: 'tools', title: 'Git и Node.js', status: 'ok', detail: 'Node v24.13.0 · git 2.50.0', action: null, blocking: true },
    { id: 'github-token', title: 'GitHub-токен', status: 'fail', detail: 'не задан: приватный репозиторий недоступен без токена', action: { label: 'Открыть настройки', route: 'settings' }, blocking: true },
    { id: 'profile', title: 'Профиль DSH', status: 'warn', detail: 'конфликтов в журнале: 2 — примените план вручную', action: { label: 'Применить профиль', route: 'profile-apply' }, blocking: true },
  ],
  ready: false,
  count: 1,
  warn: 1,
  fail: 1,
  todo: 0,
  secrets: [
    { id: 'GITHUB_TOKEN', ref: 'refs.GITHUB_TOKEN', title: 'GitHub-токен', purpose: 'доступ к репозиторию', need: 'git', present: false },
    { id: 'DEEPSEEK_API_KEY', ref: 'refs.DEEPSEEK_API_KEY', title: 'Ключ DeepSeek API', purpose: 'модель DeepSeek', need: 'model', present: true },
    { id: 'DSH_SYNC_WEBDAV_PASSWORD', ref: 'refs.DSH_SYNC_WEBDAV_PASSWORD', title: 'Пароль WebDAV резерва', purpose: 'резерв', need: 'reserve', present: false },
    { id: 'DSH_VAULT_PASSPHRASE', ref: 'refs.DSH_VAULT_PASSPHRASE', title: 'Пароль сейфа DSH', purpose: 'сейф', need: 'optional', present: true },
  ],
  sandbox: {
    status: 'on',
    mode: 'workspace-write',
    label: 'Песочница включена: запись только в рабочем каталоге',
    detail: 'Изменения вне рабочего каталога запрещены.',
    allowed: ['чтение файлов', 'запись внутри рабочего каталога'],
    denied: ['запись вне рабочего каталога'],
    approvals: 'Запись вне рабочего каталога возможна только через подтверждение (approvals).',
  },
  commands: [
    { label: 'Проверить доступ', command: 'git ls-remote https://github.com/user/dsh-sessions.git' },
  ],
}

test('client: карточка онбординга — шаги с бейджами, песочница, секреты, git-команды', () => {
  const { exported, main } = renderClient()
  exported.__test.setOnboarding(SAMPLE_REPORT)
  exported.__test.setOnboardingOpen(true)
  const tree = resolveNode(main.component({}))
  const nodes = walk(tree)

  // Карточка «Это новое устройство» появилась после карточки «Сессии и режим».
  const card = pageSections(tree).children.find((child) => titleOf(child) === 'Это новое устройство')
  assert.ok(card, 'карточка онбординга отрисована')
  assert.match(textOf(card), /готово 1 из 3/)

  // Шаги и их бейджи (ровно элементы шага, не их текстовые части).
  const steps = nodes.filter((node) => classNameOf(node).trim() === 'dshs-onboarding-step')
  assert.equal(steps.length, 3)
  assert.deepEqual(steps.map((node) => node.props['data-status']), ['ok', 'fail', 'warn'])
  assert.match(textOf(card), /Git и Node\.js/)
  assert.match(textOf(card), /в порядке/)
  assert.match(textOf(card), /ошибка/)
  assert.match(textOf(card), /внимание/)
  assert.match(textOf(card), /конфликтов в журнале: 2/)

  // Действия шагов: настройки и применение профиля.
  const buttons = walk(card).filter((node) => node.type === 'button').map((node) => textOf(node).trim())
  for (const label of ['Проверить', 'Свернуть', 'Открыть настройки', 'Применить профиль']) {
    assert.ok(buttons.includes(label), `кнопка «${label}» есть`)
  }

  // Блок «Песочница и доступы».
  const sandbox = nodes.find((node) => classNameOf(node).includes('dshs-onboarding-block') && node.props['data-sandbox'] !== undefined)
  assert.ok(sandbox, 'блок песочницы отрисован')
  assert.equal(sandbox.props['data-sandbox'], 'on')
  const sandboxText = textOf(sandbox)
  assert.match(sandboxText, /Песочница включена/)
  assert.match(sandboxText, /Разрешено/)
  assert.match(sandboxText, /Запрещено/)
  assert.match(sandboxText, /подтверждени[ея] \(approvals\)/)

  // Блок «Секреты»: только «есть/нет», без значений.
  const secretsBlock = nodes.find((node) => classNameOf(node).includes('dshs-onboarding-block') && node.props['data-secrets'] !== undefined)
  assert.ok(secretsBlock, 'блок секретов отрисован')
  assert.equal(secretsBlock.props['data-secrets'], '4')
  const secretRows = walk(secretsBlock).filter((node) => classNameOf(node).includes('dshs-secret-row'))
  assert.equal(secretRows.length, 4)
  assert.deepEqual(secretRows.map((node) => node.props['data-present']), ['false', 'true', 'false', 'true'])
  const secretsText = textOf(secretsBlock)
  assert.match(secretsText, /refs\.GITHUB_TOKEN/)
  assert.match(secretsText, /credential store DSH/)
  assert.match(secretsText, /есть/)
  assert.match(secretsText, /нет/)

  // Git-команды и копирование.
  const commandBlock = nodes.find((node) => textOf(node).includes('git ls-remote') && classNameOf(node).includes('dshs-onboarding-block'))
  assert.ok(commandBlock, 'блок git-команд отрисован')
  assert.ok(walk(commandBlock).some((node) => node.type === 'button' && textOf(node).includes('Копировать')), 'кнопка копирования есть')

  // Ни значения, ни маски секрета в отрисованном HTML.
  const html = textOf(tree)
  assert.equal(html.includes(SECRET_SENTINEL), false, 'значение секрета не попало в HTML')
  assert.equal(/ghp_[A-Za-z0-9]{8,}/.test(html), false, 'в HTML нет похожего на токен значения')
})

test('client: «Убрать облачные копии» требует подтверждения вторым кликом', async () => {
  const { exported, main, calls } = renderClient()
  exported.__test.setOnboarding({
    ...SAMPLE_REPORT,
    steps: [{
      id: 'local-copies',
      title: 'Миграция локальных копий',
      status: 'todo',
      detail: 'локальных сессий с облачными копиями: 2',
      action: { label: 'Убрать облачные копии', route: 'local-only-migration' },
      blocking: false,
    }],
    count: 1,
    warn: 0,
    fail: 0,
    todo: 1,
  })
  exported.__test.setOnboardingOpen(true)

  await exported.__test.runOnboardingAction('local-only-migration')
  assert.equal(exported.__test.readOnboardingConfirm(), 'local-only-migration', 'первый клик просит подтверждение')
  assert.equal(calls.some((call) => call.url.includes('local-only-migration')), false, 'первый клик ничего не удаляет')

  const tree = resolveNode(main.component({}))
  const buttons = walk(tree).filter((node) => node.type === 'button').map((node) => textOf(node).trim())
  assert.ok(buttons.includes('Подтвердить удаление копий'), 'кнопка сменилась на подтверждение')

  await exported.__test.runOnboardingAction('local-only-migration')
  assert.equal(
    calls.some((call) => call.url.includes('local-only-migration') && call.method === 'POST'),
    true,
    'второй клик выполняет миграцию',
  )
  assert.equal(exported.__test.readOnboardingConfirm(), '', 'подтверждение сброшено')
})

test('client: песочница unknown в карточке — честное «неизвестно»', () => {
  const { exported, main } = renderClient()
  exported.__test.setOnboarding({
    ...SAMPLE_REPORT,
    sandbox: {
      status: 'unknown',
      mode: null,
      label: 'Песочница: состояние неизвестно',
      detail: 'Версия DSH не отдаёт политику файловой песочницы.',
      allowed: [],
      denied: [],
      approvals: 'Подтверждения (approvals) выдаются при операции вне разрешённых каталогов.',
    },
  })
  exported.__test.setOnboardingOpen(true)
  const tree = resolveNode(main.component({}))
  const nodes = walk(tree)
  const sandbox = nodes.find((node) => node.props['data-sandbox'] === 'unknown')
  assert.ok(sandbox, 'статус unknown отрисован')
  assert.match(textOf(sandbox), /состояние неизвестно/)
  assert.doesNotMatch(textOf(sandbox), /Разрешено/) // списки не выдумываются
})

test('client: без отчёта карточка предлагает «Проверить», а M3-страница цела', () => {
  const { exported, main } = renderClient(hostState({ onboarding: null }))
  exported.__test.setOnboardingOpen(true)
  const tree = resolveNode(main.component({}))
  const nodes = walk(tree)
  const card = pageSections(tree).children.find((child) => titleOf(child) === 'Это новое устройство')
  assert.ok(card, 'карточка отрисована даже без отчёта')
  assert.match(textOf(card), /Шаги ещё не загружены/)
  assert.ok(walk(card).some((node) => node.type === 'button' && textOf(node).includes('Проверить')))
  // Блоки секретов/песочницы не выдумываются до получения отчёта.
  assert.equal(nodes.some((node) => node.props['data-secrets'] !== undefined), false)
  assert.equal(nodes.some((node) => node.props['data-sandbox'] !== undefined), false)
  // Стили M4 добавлены в общий слой, M3-стили на месте.
  const css = clientStyles.join('\n')
  assert.match(css, /\.dshs-onboarding-chip\{/)
  assert.match(css, /\.dshs-onboarding-block\{/)
  assert.match(css, /@media \(max-width:640px\)\{\.dshs-onboarding-step/)
  assert.match(css, /\.dshs-sync-card\{/)
})
