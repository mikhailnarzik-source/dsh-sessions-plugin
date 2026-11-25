/**
 * M6-B: UI и маршруты правил сессий (задача 22, этап 3).
 *
 * Проверяем то, что видит пользователь, и контракт host-части:
 * - GET  /api/dsh-sync/session-rules — сводка правил, разбор по сессиям,
 *   счётчики, журнал; ответ без секретов;
 * - POST /api/dsh-sync/session-rules — пресет раскладывается в поля, наследование
 *   даёт предупреждение (не блок), {clear:true} снимает правило, правка пишется
 *   в rules-history и в копию профиля зеркала;
 * - GET  /api/dsh-sync/session-rules/verify — «Проверить правила»: только
 *   чтение, корзины «защищено / только владелец / лимит / локальные / развилка»,
 *   источники session/parent/match и конфликты слияния с профилем;
 * - карточка «Правила» в панели: фильтр все/защищённые/контрольные/архив,
 *   щиты, бейджи пресета/владельца/лимита, «Проверить правила» и отчёт;
 * - меню сессии: пункт «Правила сессии…» и модалка с пресетами, полями,
 *   «Сохранить» и «Проверить правила»;
 * - список «Сессии и режим»: щит у сессии с правилом, «лимит: X/Y МБ»,
 *   «правило: только владелец», «изменено не владельцем» и баннер
 *   «Сессия выросла до X МБ — перевести в локальные?» (без вопроса при autoLocal);
 * - адаптив/скролл/кнопки по гайду.
 *
 * Запуск: node --import ./test/setup.mjs --test test/m6-ui.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { readSessionRules, writeRulesProfile } from '../lib/session-rules.mjs'

const PROJECT_PATH = process.platform === 'win32' ? 'C:\\work\\rules' : '/work/rules'

// --- общие помощники --------------------------------------------------------

async function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  const started = Date.now()
  for (;;) {
    const value = predicate()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() - started > timeoutMs) return undefined
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** Ответ, как у fetch: только то, что читают маршруты и обновление. */
function offlineFetch() {
  return async () => ({
    ok: false,
    status: 404,
    text: async () => '',
    json: async () => ({}),
  })
}

// --- окружение host-части ---------------------------------------------------

/**
 * Домашний каталог DSH с конфигом и тремя локальными сессиями:
 * alpha (родитель, 4 КБ), beta (субагент alpha, 256 КБ), gamma (4 КБ).
 */
async function makeRulesEnv() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m6-rules-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const mirror = join(root, 'mirror')
  const logs = join(root, 'logs')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  await mkdir(mirror, { recursive: true })
  await mkdir(logs, { recursive: true })
  const sizes = { 'session-alpha': 4096, 'session-beta': 256 * 1024, 'session-gamma': 4096 }
  const paths = {}
  for (const [id, size] of Object.entries(sizes)) {
    const path = join(logs, `${id}.zstd`)
    await writeFile(path, Buffer.alloc(size, 7))
    paths[id] = path
  }
  const config = defaultConfig(home)
  config.deviceId = 'device-a'
  config.repoDir = mirror
  config.projects = { alpha: { path: project, title: 'Alpha' } }
  await saveConfig(home, config)
  const snapshots = [
    { header: { id: 'session-alpha', cwd: project }, location: { path: paths['session-alpha'] }, title: 'Деплой' },
    { header: { id: 'session-beta', cwd: project, parentSession: 'session-alpha' }, location: { path: paths['session-beta'] }, title: 'Черновик' },
    { header: { id: 'session-gamma', cwd: project }, location: { path: paths['session-gamma'] }, title: 'Архивная' },
  ]
  return {
    root,
    home,
    project,
    mirror,
    paths,
    snapshots,
    rulesPath: join(home, 'dsh-sync', 'session-rules.json'),
    historyPath: join(home, 'dsh-sync', 'rules-history.jsonl'),
    profilePath: join(mirror, 'profile', 'session-rules.json'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** Поднять плагин с поддельным ctx: маршруты сохраняем в Map. */
async function bootPlugin(env) {
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = env.home
  globalThis.fetch = offlineFetch()
  const module = await import('../index.js')
  const routes = new Map()
  const cleanups = []
  const ctx = {
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    tools: { register: () => {} },
    get: (name) => (name === 'sessionPersistence' ? { list: async () => env.snapshots } : undefined),
  }
  module.apply(ctx)
  // Кеш состояний сессий — на процесс: для нового домашнего каталога сбрасываем.
  module.invalidateSessionStates()
  return {
    module,
    routes,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          // таймеры уже сняты
        }
      }
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      globalThis.fetch = previousFetch
    },
  }
}

async function callRoute(routes, path, { method = 'POST', payload } = {}) {
  const route = routes.get(path)
  assert.ok(route, `маршрут ${path} зарегистрирован`)
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (method !== 'GET') init.body = JSON.stringify(payload ?? {})
  const response = await route.fetch(new Request(`http://local${path}`, init))
  return { status: response.status, body: await response.json() }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readHistoryLines(path) {
  if (!existsSync(path)) return []
  const text = await readFile(path, 'utf8')
  const entries = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // битая строка журнала не мешает остальным
    }
  }
  return entries
}

function rowOf(body, id) {
  const row = (Array.isArray(body?.sessions) ? body.sessions : []).find((item) => item.id === id)
  assert.ok(row, `сессия ${id} есть в разборе правил`)
  return row
}

// ===========================================================================
// 1. Маршруты host-части
// ===========================================================================

test('GET /session-rules: сводка, разбор по сессиям и без секретов', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    boot = await bootPlugin(env)
    assert.ok(boot.routes.has('/api/dsh-sync/session-rules'), 'маршрут правил зарегистрирован')
    assert.ok(boot.routes.has('/api/dsh-sync/session-rules/verify'), 'маршрут проверки зарегистрирован')

    const { status, body } = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { method: 'GET' })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.deviceId, 'device-a', 'устройство из конфига')
    assert.equal(body.rules.version, 1, 'формат хранилища правил — версия 1')
    assert.equal(body.sessions.length, 3, 'разбор по всем локальным сессиям')

    const alpha = rowOf(body, 'session-alpha')
    assert.equal(alpha.title, 'Деплой', 'название сессии в разборе')
    assert.equal(alpha.ruleSource, 'default', 'правила ещё нет')
    assert.equal(alpha.hasRule, false)
    assert.equal(alpha.protect, false)
    assert.equal(body.counts.sessions, 0, 'в файле правил пусто')
    assert.equal(body.counts.rows, 3)
    assert.ok(Array.isArray(body.history), 'журнал правил в ответе')
    assert.equal(body.lastRun.at, null, 'последнего запуска ещё нет')

    // Копии правил в профиле нет — её создаст первое сохранение.
    assert.equal(body.profile.present, false)

    const json = JSON.stringify(body)
    for (const secret of ['GITHUB_TOKEN', 'DEEPSEEK_API_KEY', 'webdavPassword', 'password']) {
      assert.equal(json.includes(secret), false, `в ответе нет «${secret}»`)
    }
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

test('POST preset control: пресет раскладывается в поля, копия в профиль и журнал', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    boot = await bootPlugin(env)
    const saved = await callRoute(boot.routes, '/api/dsh-sync/session-rules', {
      payload: { id: 'session-alpha', preset: 'control' },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.action, 'set')
    assert.equal(saved.body.updated, 1)
    assert.equal(saved.body.profileWritten, true, 'копия правил записана в профиль зеркала')

    const file = await readJson(env.rulesPath)
    const entry = file.sessions['session-alpha']
    assert.ok(entry, 'правило сессии в файле')
    assert.equal(entry.preset, 'control')
    assert.equal(entry.protect, true, 'защита из пресета')
    assert.equal(entry.maxMb, 15, 'лимит 15 МБ из пресета')
    assert.equal(entry.forbidFork, true, 'запрет развилки из пресета')
    assert.equal(entry.notifyForeignAppend, true, 'уведомления из пресета')
    assert.ok(Number.isFinite(Date.parse(entry.updatedAt)), 'у записи есть updatedAt')

    // Копия в зеркале: второе устройство увидит правило после pull.
    assert.ok(existsSync(env.profilePath), 'profile/session-rules.json в зеркале')
    const profile = await readJson(env.profilePath)
    assert.equal(profile.sessions['session-alpha'].protect, true)

    // Правка попала в журнал правил (kind — не конфликт слияния).
    const history = await readHistoryLines(env.historyPath)
    const setEntry = history.find((item) => item.kind === 'session-rule-set')
    assert.ok(setEntry, 'журнал: правило изменено')
    assert.equal(setEntry.id, 'session-alpha')
    assert.equal(setEntry.type, 'session-rules')

    const { body } = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { method: 'GET' })
    const alpha = rowOf(body, 'session-alpha')
    assert.equal(alpha.ruleSource, 'session')
    assert.equal(alpha.hasRule, true)
    assert.equal(alpha.preset, 'control')
    assert.equal(alpha.presetLabel, 'Контрольная')
    assert.equal(alpha.protect, true)
    assert.equal(body.counts.protected, 2, 'alpha защищена, beta унаследовала защиту')
    assert.equal(body.counts.control, 2, 'пресет control виден и у наследника')
    assert.equal(body.counts.sources.session, 1)
    assert.equal(body.counts.sources.session, 1)
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

test('наследование: субагент получает правило родителя, своё правило — предупреждение', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    boot = await bootPlugin(env)
    await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: { id: 'session-alpha', preset: 'control' } })

    let { body } = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { method: 'GET' })
    const beta = rowOf(body, 'session-beta')
    assert.equal(beta.ruleSource, 'parent', 'субагент наследует правило родителя')
    assert.equal(beta.inheritedFrom, 'session-alpha')
    assert.equal(beta.protect, true, 'защита унаследована')
    assert.equal(beta.maxMb, 15, 'лимит унаследован')
    assert.equal(beta.maxMb, 15)
    assert.equal(body.counts.sources.parent, 1)

    // Своё правило ребёнку задать можно, но host отвечает предупреждением.
    const own = await callRoute(boot.routes, '/api/dsh-sync/session-rules', {
      payload: { id: 'session-beta', preset: 'keep' },
    })
    assert.equal(own.status, 200)
    assert.equal(own.body.ok, true, 'предупреждение не блокирует сохранение')
    assert.ok(Array.isArray(own.body.warnings) && own.body.warnings.length === 1, 'одно предупреждение')
    assert.match(own.body.warnings[0].message, /субагенту/)
    assert.match(own.body.warnings[0].message, /наследует/, 'объясняет наследование')
    assert.equal(own.body.warning, own.body.warnings[0].message)

    ;({ body } = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { method: 'GET' }))
    assert.equal(rowOf(body, 'session-beta').ruleSource, 'session', 'своё правило сильнее наследования')
    assert.equal(rowOf(body, 'session-beta').preset, 'keep')
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

test('POST clear: правило снято, наследование снова действует', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    boot = await bootPlugin(env)
    await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: { id: 'session-alpha', preset: 'control' } })
    await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: { id: 'session-beta', preset: 'keep' } })

    const cleared = await callRoute(boot.routes, '/api/dsh-sync/session-rules', {
      payload: { id: 'session-beta', clear: true },
    })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.ok, true)
    assert.equal(cleared.body.action, 'clear')

    const file = await readJson(env.rulesPath)
    assert.equal(file.sessions['session-beta'], undefined, 'своё правило удалено из файла')
    assert.ok(file.sessions['session-alpha'], 'правило родителя осталось')

    const { body } = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { method: 'GET' })
    assert.equal(rowOf(body, 'session-beta').ruleSource, 'parent', 'наследование снова действует')
    const history = await readHistoryLines(env.historyPath)
    assert.ok(history.some((item) => item.kind === 'session-rule-clear'), 'снятие правила в журнале')
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

test('ownerBlocked и overLimit: бейджи «только владелец» и «лимит» в разборе и проверке', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    boot = await bootPlugin(env)
    // Сессия принадлежит другому устройству: push отсюда её пропустит.
    await callRoute(boot.routes, '/api/dsh-sync/session-rules', {
      payload: { id: 'session-gamma', patch: { ownerDevice: 'device-b', protect: true } },
    })
    // Лог 4 КБ перерос лимит 0.001 МБ — данные для баннера «сессия выросла».
    await callRoute(boot.routes, '/api/dsh-sync/session-rules', {
      payload: { id: 'session-alpha', patch: { maxMb: 0.001, protect: true } },
    })

    const { body } = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { method: 'GET' })
    const gamma = rowOf(body, 'session-gamma')
    assert.equal(gamma.ownerBlocked, true, 'чужая сессия помечена «только владелец»')
    assert.equal(gamma.ownerDevice, 'device-b')
    assert.match(gamma.message ?? '', /только владелец/, 'сообщение правила для бейджа')

    const alpha = rowOf(body, 'session-alpha')
    assert.equal(alpha.overLimit, true, 'лог больше лимита правила')
    assert.ok(alpha.mb > 0, 'размер сессии в мегабайтах посчитан')
    assert.equal(alpha.maxMb, 0.001)
    assert.match(alpha.message ?? '', /выросла|лимит/, 'сообщение «сессия выросла»')
    assert.equal(alpha.suggestion, 'перевести в локальные')

    const { body: report } = await callRoute(boot.routes, '/api/dsh-sync/session-rules/verify', { method: 'GET' })
    assert.equal(report.ok, true)
    assert.deepEqual(report.buckets.ownerBlocked.map((item) => item.id), ['session-gamma'])
    assert.deepEqual(report.buckets.overLimit.map((item) => item.id).sort(), ['session-alpha', 'session-beta'], 'beta унаследовала лимит родителя')
    assert.equal(report.bucketsCounts.protected, 3, 'alpha и gamma защищены, beta наследует защиту')
    assert.equal(report.changes, false)
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

test('GET /session-rules: след последнего запуска — «только владелец» и чужое изменение', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    await mkdir(join(env.home, 'dsh-sync'), { recursive: true })
    await writeFile(join(env.home, 'dsh-sync', 'last-run.json'), JSON.stringify({
      ok: true,
      at: '2026-11-25T10:00:00.000Z',
      action: 'pull',
      rules: {
        ownerBlocked: 1,
        ownerBlockedIds: ['session-beta'],
        foreignChanges: 1,
        foreignChangeIds: ['session-gamma'],
        notifications: ['правило: лог дополнен другим устройством (session-gamma)'],
      },
      conflictDetails: [{
        id: 'session-beta',
        kind: 'rule-owner',
        message: 'правило: только владелец: сессия принадлежит device-b — изменение не применено (session-beta)',
      }],
    }), 'utf8')

    boot = await bootPlugin(env)
    const { body } = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { method: 'GET' })
    assert.equal(body.lastRun.at, '2026-11-25T10:00:00.000Z')
    assert.equal(body.lastRun.ownerBlocked, 1)
    assert.equal(body.lastRun.foreignChanges, 1)
    assert.deepEqual(body.lastRun.ownerBlockedIds, ['session-beta'], 'кого не пропустит push')
    assert.deepEqual(body.lastRun.foreignChangeIds, ['session-gamma'], 'где лог дописало другое устройство')
    assert.ok(body.lastRun.messages.some((line) => line.includes('только владелец')), 'подпись «правило: только владелец»')
    assert.ok(body.lastRun.messages.some((line) => line.includes('лог дополнен')), 'уведомление о чужом дополнении')
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

test('GET /session-rules/verify: только чтение, корзины, источники и конфликты', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    boot = await bootPlugin(env)
    await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: { id: 'session-alpha', preset: 'control' } })
    await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: { id: 'session-gamma', preset: 'archive' } })

    const before = {
      rules: await readFile(env.rulesPath, 'utf8'),
      profile: await readFile(env.profilePath, 'utf8'),
    }
    const first = await callRoute(boot.routes, '/api/dsh-sync/session-rules/verify', { method: 'GET' })
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    assert.equal(first.body.changes, false, 'проверка ничего не меняет')
    assert.match(first.body.note, /ничего не изменила/)
    // Кто защищён от чистки: alpha (control) и beta (наследует), gamma — архив.
    assert.deepEqual(first.body.buckets.protected.map((item) => item.id).sort(), ['session-alpha', 'session-beta', 'session-gamma'])
    // Кто объявлен локальным: archive.
    assert.deepEqual(first.body.buckets.localOnly.map((item) => item.id), ['session-gamma'])
    // Откуда правило: сессия (2) и родитель (1).
    assert.equal(first.body.sources.session, 2)
    assert.equal(first.body.sources.parent, 1)
    assert.ok(Array.isArray(first.body.lines) && first.body.lines.length >= 5, 'строки отчёта для панели')
    assert.ok(first.body.lines.some((line) => /защищено от чистки/.test(line)))

    const second = await callRoute(boot.routes, '/api/dsh-sync/session-rules/verify', { method: 'GET' })
    assert.deepEqual(second.body.conflicts, first.body.conflicts)

    // Файлы не изменились: байты те же (проверка не пишет).
    assert.equal(await readFile(env.rulesPath, 'utf8'), before.rules, 'локальный файл правил не тронут')
    assert.equal(await readFile(env.profilePath, 'utf8'), before.profile, 'копия в профиле не тронута')
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

test('merge profile/session-rules.json: свежее правило применяется, конфликт — в журнал', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    boot = await bootPlugin(env)
    await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: { id: 'session-alpha', preset: 'control' } })
    const local = await readSessionRules(env.home)
    const localAlpha = local.sessions['session-alpha']
    assert.ok(localAlpha)

    // Второе устройство добавило правило с более свежим updatedAt и изменило
    // alpha с тем же временем — это конфликт «равное время, разные данные».
    await writeRulesProfile({
      repoDir: env.mirror,
      rules: {
        version: 1,
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
        sessions: {
          'session-alpha': { ...localAlpha, protect: false, preset: 'keep' },
          'session-delta': { preset: 'keep', protect: true, updatedAt: new Date(Date.now() + 120_000).toISOString() },
        },
      },
    })

    const { body } = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { method: 'GET' })
    const merged = await readSessionRules(env.home)
    assert.equal(merged.sessions['session-delta'].protect, true, 'свежее правило из профиля применено')
    assert.equal(merged.sessions['session-alpha'].protect, true, 'при равном updatedAt побеждает локальное')
    assert.ok(body.profile.conflicts >= 1, 'конфликт виден в сводке')

    const history = await readHistoryLines(env.historyPath)
    const conflict = history.find((item) => item.kind === 'session-rule' && item.winner === 'local')
    assert.ok(conflict, 'конфликт записан в rules-history')
    assert.equal(conflict.id, 'session-alpha')
    assert.match(conflict.reason, /updatedAt/)

    const { body: report } = await callRoute(boot.routes, '/api/dsh-sync/session-rules/verify', { method: 'GET' })
    assert.ok(Array.isArray(report.conflicts) && report.conflicts.length >= 1, 'проверка показывает конфликт')
    assert.equal(report.profile.present, true)
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

test('POST /session-rules без id и без полей — понятная ошибка, а не падение', async () => {
  const env = await makeRulesEnv()
  let boot
  try {
    boot = await bootPlugin(env)
    const noId = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: {} })
    assert.equal(noId.status, 400)
    assert.equal(noId.body.ok, false)
    assert.match(noId.body.message, /идентификатор сессии/)

    const empty = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: { id: 'session-alpha' } })
    assert.equal(empty.status, 400)
    assert.match(empty.body.message, /нечего сохранять/)

    // Явный «none» — это снятие правила, а не пустая запись.
    const none = await callRoute(boot.routes, '/api/dsh-sync/session-rules', { payload: { id: 'session-alpha', preset: 'none' } })
    assert.equal(none.status, 400, 'без patch и без правила сохранять нечего')
  } finally {
    boot?.dispose()
    await env.cleanup()
  }
})

// ===========================================================================
// 2. Клиент: headless-рендер без настоящего React
// ===========================================================================

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

/** Снимок /state для страницы: настроено, без резерва. */
function hostState() {
  return {
    ok: true,
    ready: true,
    mode: 'builtin',
    config: {
      backend: 'git',
      branch: 'main',
      remote: 'https://github.com/user/dsh-sessions.git',
      projectPath: PROJECT_PATH,
      projectId: 'alpha',
      attachments: false,
      useExternal: true,
      secondary: { backend: 'none' },
    },
    secondary: { enabled: false, backend: 'none' },
    checks: [],
    status: { local: 3, mirror: 3, onlyLocal: 0, onlyMirror: 0 },
    external: { found: false },
    lastRun: null,
    history: [],
    backup: null,
    pending: false,
  }
}

/** Снимок /sessions: три сессии (родитель, субагент, архивная). */
function sessionsFixture() {
  return {
    ok: true,
    states: {},
    sessions: [
      { id: 'session-alpha', title: 'Деплой', projectId: 'alpha', path: PROJECT_PATH, mode: 'cloud', badge: 'synced', bytes: 3_355_443, attached: true, parentSession: '' },
      { id: 'session-beta', title: 'Черновик', projectId: 'alpha', path: PROJECT_PATH, mode: 'cloud', badge: 'pending', bytes: 19_293_798, attached: true, parentSession: 'session-alpha' },
      { id: 'session-gamma', title: 'Архивная', projectId: 'alpha', path: PROJECT_PATH, mode: 'cloud', badge: 'synced', bytes: 4096, attached: true, parentSession: '' },
    ],
    groups: { count: 1, subagents: 1, orphans: 0, line: 'групп: 1, субагентов: 1, сирот: 0' },
    modes: { local: 0, cloud: 3 },
    unattached: 0,
    attachAvailable: true,
    localOnly: { count: 0, migration: { count: 0 } },
    workspaces: [],
  }
}

/** Сводка правил: control у alpha, наследование у beta, архив у gamma. */
function rulesFixture(patch = {}) {
  return {
    ok: true,
    deviceId: 'device-a',
    rules: { version: 1, updatedAt: '2026-11-25T10:00:00.000Z', presets: {}, sessions: {}, matches: [] },
    counts: {
      version: 1,
      sessions: 3,
      matches: 0,
      presets: 3,
      rows: 3,
      withRule: 3,
      protected: 3,
      ownerBlocked: 1,
      overLimit: 1,
      forbidFork: 1,
      notify: 1,
      control: 1,
      keep: 0,
      archive: 1,
      custom: 1,
      sources: { session: 2, parent: 1, match: 0, default: 0 },
    },
    sessions: [
      {
        id: 'session-alpha',
        title: 'Деплой',
        shortId: 'alpha',
        preset: 'control',
        presetLabel: 'Контрольная',
        protect: true,
        ownerDevice: '',
        ownerBlocked: false,
        overLimit: false,
        mb: 3.2,
        maxMb: 15,
        limitMb: 15,
        syncMode: undefined,
        forbidFork: true,
        notifyForeignAppend: true,
        autoLocal: false,
        ruleSource: 'session',
        inheritedFrom: '',
        hasRule: true,
      },
      {
        id: 'session-beta',
        title: 'Черновик',
        shortId: 'beta',
        preset: undefined,
        presetLabel: '',
        protect: true,
        ownerDevice: 'device-a',
        ownerBlocked: true,
        overLimit: true,
        mb: 18.4,
        maxMb: 15,
        limitMb: 15,
        forbidFork: false,
        notifyForeignAppend: false,
        autoLocal: false,
        ruleSource: 'parent',
        inheritedFrom: 'session-alpha',
        hasRule: true,
        message: 'сессия выросла до 18.4 МБ, лимит 15',
        suggestion: 'перевести в локальные',
      },
      {
        id: 'session-gamma',
        title: 'Архивная',
        shortId: 'gamma',
        preset: 'archive',
        presetLabel: 'Архив',
        protect: true,
        ownerDevice: '',
        ownerBlocked: false,
        overLimit: false,
        mb: 0.004,
        maxMb: undefined,
        syncMode: 'local',
        forbidFork: false,
        notifyForeignAppend: false,
        autoLocal: false,
        ruleSource: 'session',
        inheritedFrom: '',
        hasRule: true,
      },
    ],
    history: [],
    lastRun: {
      at: '2026-11-25T10:00:00.000Z',
      action: 'pull',
      protected: 2,
      protectedIds: ['session-alpha', 'session-beta'],
      ownerBlocked: 1,
      ownerBlockedIds: ['session-beta'],
      overLimit: 1,
      overLimitIds: ['session-beta'],
      foreignChanges: 1,
      foreignChangeIds: ['session-gamma'],
      messages: ['правило: только владелец: сессия принадлежит device-b — изменение не применено (session-beta)'],
    },
    profile: { present: true, merged: false, conflicts: 0 },
    ...patch,
  }
}

/** Отчёт «Проверить правила»: корзины, источники, конфликты. */
function verifyFixture() {
  return {
    ok: true,
    changes: false,
    note: 'Проверка ничего не изменила: правила только прочитаны.',
    deviceId: 'device-a',
    buckets: {
      protected: [{ id: 'session-alpha', title: 'Деплой' }, { id: 'session-beta', title: 'Черновик' }],
      ownerBlocked: [{ id: 'session-beta', title: 'Черновик' }],
      overLimit: [{ id: 'session-beta', title: 'Черновик' }],
      localOnly: [{ id: 'session-gamma', title: 'Архивная' }],
      forbidFork: [{ id: 'session-alpha', title: 'Деплой' }],
      notify: [{ id: 'session-alpha', title: 'Деплой' }],
    },
    sources: { session: 2, parent: 1, match: 0, default: 0 },
    conflicts: [{ kind: 'session-rule', id: 'session-alpha', winner: 'local', reason: 'equal-updatedAt' }],
    history: [],
    lines: [
      'правил в файле: 3',
      'защищено от чистки: 2',
      'только владелец (push пропустит): 1',
      'переросли лимит: 1',
    ],
    profile: { present: true, conflicts: 1 },
  }
}

/** Загрузить клиент, применить плагин и собрать регистрации слотов. */
function renderClient({ host = hostState(), rules = rulesFixture(), verify = null, sessions = null } = {}) {
  const dictionaries = {}
  const registrations = []
  const calls = []
  const ctx = {
    effect: (fn) => {
      fn()
    },
    locale: {
      bind: (ns) => (key, params) => {
        const raw = dictionaries[ns]?.ru?.[key] ?? key
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
      inject: (name, register) => {
        register()
      },
      register: (options, component) => {
        registrations.push({ options, component })
      },
    },
  }
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    const method = String(init.method ?? 'GET').toUpperCase()
    calls.push({ href, method, body: init.body })
    let payload = {}
    if (href.includes('/session-rules/verify')) payload = verify ?? verifyFixture()
    else if (href.includes('/session-rules')) payload = rules ?? rulesFixture()
    else if (href.includes('/state')) payload = host
    else if (href.includes('/notifications')) payload = { ok: true, notifications: [], cursor: 0 }
    else if (href.includes('/tombstones')) payload = { ok: true, sessions: [] }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    }
  }
  const exported = clientEntry.factory((id) => {
    if (id === 'react') return MiniReact
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`неожиданный require: ${id}`)
  })
  exported.apply(ctx)
  exported.__test.setHostState(host)
  exported.__test.setSessionStates(sessions ?? sessionsFixture())
  exported.__test.setSessionRules(rules)
  exported.__test.setRulesVerify(verify)
  const main = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'dsh-sessions')
  assert.ok(main, 'страница синхронизации зарегистрирована')
  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  assert.ok(menu, 'пункт меню сессии зарегистрирован')
  return { exported, main, menu, registrations, calls }
}

const resolveNode = (node) => {
  let current = node
  for (let step = 0; step < 60; step += 1) {
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

const pageNodes = () => {
  const { main } = renderClient()
  return walk(resolveNode(main.component({})))
}

const pageCss = () => styles.find((text) => typeof text === 'string' && text.includes('.dshs-rules-card'))

test('карточка «Правила» в панели: заголовок, фильтр, щиты, пресеты и лимит', () => {
  const nodes = pageNodes()
  const card = nodes.find((node) => node.type === 'section' && classNameOf(node).includes('dshs-rules-card'))
  assert.ok(card, 'карточка «Правила» внутри «Сессии и режим»')
  const cardText = textOf(card)
  assert.match(cardText, /Правила/, 'заголовок карточки')
  assert.match(cardText, /правил: 3 · защищено: 3/, 'сводка правил')
  assert.match(cardText, /Все \(3\)/, 'фильтр «Все» с количеством')
  assert.match(cardText, /Защищённые \(3\)/, 'фильтр «Защищённые»')
  assert.match(cardText, /Контрольные \(1\)/, 'фильтр «Контрольные»')
  assert.match(cardText, /Архив \(1\)/, 'фильтр «Архив»')
  assert.match(cardText, /Проверить правила/, 'кнопка проверки правил')

  // Список правил с щитами и бейджами — внутри своей прокручиваемой области.
  const list = nodes.find((node) => classNameOf(node) === 'dshs-rules-list')
  assert.ok(list, 'список правил с прокруткой')
  const rows = walk(list).filter((node) => classNameOf(node) === 'dshs-rules-row')
  assert.equal(rows.length, 3, 'три сессии с правилом')
  const rowText = rows.map(textOf).join('\n')
  assert.match(rowText, /Деплой/, 'название сессии с правилом')
  assert.match(rowText, /Контрольная/, 'бейдж пресета')
  assert.match(rowText, /правило: только владелец/, 'бейдж «только владелец»')
  assert.match(rowText, /изменено не владельцем/, 'бейдж чужого изменения')
  assert.match(rowText, /лимит: 18,4\/15 МБ/, 'бейдж «лимит: X/Y МБ»')
  assert.match(rowText, /правило сессии|унаследовано от родителя/, 'источник правила в подписи')

  const shields = walk(list).filter((node) => classNameOf(node) === 'dshs-rules-shield')
  assert.equal(shields.length, 3, 'щит у каждой сессии с правилом')
  assert.equal(shields.filter((node) => node.props['data-protected'] === 'true').length, 3, 'защищённые щиты отмечены')

  // Уведомление из последнего запуска: что правило удержало.
  const notice = nodes.find((node) => classNameOf(node) === 'dshs-rules-notice')
  assert.ok(notice, 'уведомление «только владелец» из summary')
  assert.match(textOf(notice), /правило: только владелец/)
})

test('фильтр «Правила»: все / защищённые / контрольные / архив — чистый помощник', () => {
  const { exported } = renderClient()
  const report = rulesFixture()
  const rows = report.sessions
  const api = exported.__test
  assert.equal(api.rulesFilterRows(rows, 'all').length, 3)
  assert.deepEqual(api.rulesFilterRows(rows, 'protected').map((row) => row.id), ['session-alpha', 'session-beta', 'session-gamma'])
  assert.deepEqual(api.rulesFilterRows(rows, 'control').map((row) => row.id), ['session-alpha'])
  assert.deepEqual(api.rulesFilterRows(rows, 'archive').map((row) => row.id), ['session-gamma'])
  assert.equal(api.rulesFilterRows(rows, 'unknown').length, 3, 'неизвестный фильтр — все')
})

test('отчёт «Проверить правила»: корзины, «ничего не изменила» и конфликты', () => {
  const { exported, main } = renderClient({ verify: verifyFixture() })
  const nodes = walk(resolveNode(main.component({})))
  const report = nodes.find((node) => classNameOf(node) === 'dshs-rules-report')
  assert.ok(report, 'блок отчёта на странице')
  const text = textOf(report)
  assert.match(text, /Проверка ничего не изменила/)
  for (const label of ['Защищены от чистки', 'Только владелец (push пропустит)', 'Переросли лимит', 'Объявлены локальными']) {
    assert.match(text, new RegExp(label.replace(/[()]/g, '\\$&')), `корзина «${label}»`)
  }
  const buckets = walk(report).filter((node) => classNameOf(node) === 'dshs-rules-bucket')
  assert.equal(buckets.length, 6, 'шесть корзин отчёта')
  assert.match(text, /конфликтов слияния: 1/)
  assert.match(text, /Деплой/, 'имена сессий в корзинах')
  assert.equal(exported.__test.readRulesVerify()?.changes, false)
})

test('меню сессии: «Правила сессии…» и модалка с пресетами, полями и кнопками', () => {
  const { exported, menu, registrations } = renderClient()
  const menuNode = resolveNode(menu.component({ sessionId: 'session-alpha', useMenuOpenState: () => [false, () => {}] }))
  const menuText = textOf(menuNode)
  assert.match(menuText, /Правила сессии…/, 'пункт меню сессии')
  assert.match(menuText, /Сделать локальной|Сделать облачной/, 'пункт режима остался в меню')

  const dialog = resolveNode(exported.__test.SessionRulesDialog({ sessionId: 'session-alpha', onClose: () => {} }))
  assert.ok(walk(dialog).some((node) => classNameOf(node) === 'dshs-rules-dialog'), 'модалка правила открыта')
  const dialogText = textOf(dialog)
  for (const label of ['Контрольная', 'Неприкосновенная', 'Архив', 'Обычная']) {
    assert.match(dialogText, new RegExp(label), `пресет «${label}»`)
  }
  for (const label of ['Владелец — этот компьютер', 'Защита: не удалять', 'Лимит лога, МБ', 'Запрет развилки', 'Уведомлять']) {
    assert.match(dialogText, new RegExp(label.replace(/[—()]/g, '.')), `поле «${label}»`)
  }
  const buttons = walk(dialog).filter((node) => node.type === 'button').map((node) => textOf(node).trim())
  assert.ok(buttons.includes('Сохранить'), '«Сохранить» в модалке')
  assert.ok(buttons.includes('Проверить правила'), '«Проверить правила» в модалке')
  assert.ok(buttons.includes('Закрыть'), '«Закрыть» в модалке')
  const chips = walk(dialog).filter((node) => classNameOf(node) === 'dshs-rules-chip')
  assert.deepEqual(chips.map((node) => node.props['data-preset']), ['control', 'keep', 'archive', 'none'], 'чипы пресетов по порядку')
  const active = chips.find((node) => node.props['data-active'] === 'true')
  assert.equal(active?.props['data-preset'], 'control', 'текущий пресет подсвечен')
  assert.equal(active?.props.style.height, 32, 'чип пресета — 32 px')
  assert.equal(active?.props.style.borderRadius, 10)

  // Меню закрывается после клика, поэтому модалку рисует постоянный Host из
  // иконки в левой панели — проверяем именно этот путь.
  const itemButton = walk(menuNode).find((node) => node.type === 'button' && textOf(node).includes('Правила сессии…'))
  assert.ok(itemButton, 'пункт меню — кнопка')
  itemButton.props.onClick()
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  const hostTree = resolveNode(sidebar.component({ size: 16 }))
  assert.ok(walk(hostTree).some((node) => classNameOf(node) === 'dshs-rules-dialog'), 'модалка открывается из меню через постоянный Host')
  exported.__test.closeRulesDialog()
  const closedTree = resolveNode(sidebar.component({ size: 16 }))
  assert.equal(walk(closedTree).some((node) => classNameOf(node) === 'dshs-rules-dialog'), false, 'после «Закрыть» модалки нет')
})

test('сохранение из модалки: POST /session-rules с пресетом, полями и лимитом', async () => {
  const { exported, calls } = renderClient()
  const dialog = resolveNode(exported.__test.SessionRulesDialog({ sessionId: 'session-alpha', onClose: () => {} }))
  const save = walk(dialog).find((node) => node.type === 'button' && textOf(node).trim() === 'Сохранить')
  assert.ok(save, 'кнопка «Сохранить» в дереве')
  assert.equal(save.props.style.height, 36, 'кнопка сохранения — 36 px')
  assert.equal(save.props.style.borderRadius, 10)
  save.props.onClick()

  const call = await waitFor(() => calls.find((item) => item.method === 'POST' && item.href.includes('/session-rules')))
  assert.ok(call, 'клиент отправил POST /session-rules')
  const payload = JSON.parse(String(call.body))
  assert.equal(payload.id, 'session-alpha')
  assert.equal(payload.preset, 'control', 'пресет уходит в запрос')
  assert.equal(payload.patch.protect, true)
  assert.equal(payload.patch.maxMb, 15, 'лимит — числом')
  assert.equal(payload.patch.forbidFork, true)
  assert.equal(payload.patch.notifyForeignAppend, true)
  assert.equal(payload.clear, undefined)

  // Тело запроса из чистого сборщика: «Обычная» без полей — это снятие правила.
  const cleared = exported.__test.buildRulePayload({ sessionId: 'session-alpha', draft: exported.__test.emptyRuleDraft(), deviceId: 'device-a' })
  assert.deepEqual(cleared, { id: 'session-alpha', clear: true })
})

test('список «Сессии и режим»: щит, лимит, «только владелец» и «изменено не владельцем»', () => {
  // Плоский список: субагенты в дереве свёрнуты, а здесь нужны все три строки.
  const flat = sessionsFixture()
  flat.sessions = flat.sessions.map((session) => ({ ...session, parentSession: '' }))
  const { main } = renderClient({ sessions: flat })
  const nodes = walk(resolveNode(main.component({})))
  const rows = nodes.filter((node) => classNameOf(node) === 'dshs-modes-row')
  assert.equal(rows.length, 3, 'строки сессий на месте')
  const rowText = rows.map(textOf).join('\n')
  assert.match(rowText, /лимит: 18,4\/15 МБ/, 'бейдж превышения лимита у сессии')
  assert.match(rowText, /правило: только владелец/, 'бейдж «правило: только владелец»')
  assert.match(rowText, /изменено не владельцем/, 'бейдж чужого изменения')
  const shields = rows.flatMap((row) => walk(row).filter((node) => classNameOf(node) === 'dshs-rules-shield'))
  assert.equal(shields.length, 3, 'щит у каждой сессии с правилом')
  assert.match(String(shields[0].props.title), /Защищена правилом/, 'подсказка щита')
})

test('баннер «Сессия выросла до X МБ — перевести в локальные?» и autoLocal без вопроса', () => {
  const nodes = pageNodes()
  const banner = nodes.find((node) => classNameOf(node) === 'dshs-rules-grow')
  assert.ok(banner, 'баннер превышения лимита на странице')
  const text = textOf(banner)
  assert.match(text, /Сессия выросла до 18,4 МБ — перевести в локальные\?/, 'текст баннера')
  const button = walk(banner).find((node) => node.type === 'button')
  assert.equal(textOf(button).trim(), 'Перевести в локальные', 'кнопка баннера')
  assert.equal(button.props.style.height, 32, 'кнопка баннера — 32 px')

  // autoLocal: правило переводит сессию само — не спрашиваем, только сообщаем.
  const { main } = renderClient({ rules: rulesFixture({
    sessions: rulesFixture().sessions.map((row) => row.id === 'session-beta' ? { ...row, autoLocal: true } : row),
  }) })
  const autoNodes = walk(resolveNode(main.component({})))
  assert.equal(autoNodes.some((node) => classNameOf(node) === 'dshs-rules-grow'), false, 'при autoLocal баннер не показывается')
  assert.match(textOf({ children: autoNodes }), /autoLocal: переведено в локальные автоматически/, 'сообщение об автопереводе')
})

test('адаптив, скролл и кнопки правил — по гайду, без белого на белом', () => {
  const css = pageCss()
  assert.ok(css, 'слой оформления правил внедрён')
  assert.match(css, /\.dshs-rules-card\{[^}]*border-radius:14px/, 'карточка правил — радиус 14')
  assert.match(css, /\.dshs-rules-card\{[^}]*min-width:0/, 'карточка не распирает страницу')
  assert.match(css, /\.dshs-rules-list\{[^}]*max-height:320px/, 'у списка правил ограничена высота')
  assert.match(css, /\.dshs-rules-list\{[^}]*overflow-y:auto/, 'список правил прокручивается внутри')
  assert.match(css, /\.dshs-rules-list\{[^}]*overscroll-behavior:contain/)
  assert.match(css, /\.dshs-rules-row\{[^}]*flex-wrap:wrap/, 'бейджи строки переносятся')
  assert.match(css, /\.dshs-rules-buckets\{[^}]*repeat\(auto-fit,minmax/, 'корзины отчёта — auto-fit')
  assert.match(css, /\.dshs-rules-chip\{[^}]*height:32px/, 'чипы — 32 px')
  assert.match(css, /\.dshs-rules-chip:hover/, 'у чипов есть hover')
  assert.match(css, /\.dshs-rules-chip:focus-visible/, 'у чипов есть focus-visible')
  assert.match(css, /\.dshs-rules-actions button\{[^}]*height:36px/, 'кнопки модалки — 36 px')
  assert.match(css, /\.dshs-rules-actions button\{[^}]*border-radius:10px/)
  assert.match(css, /\.dshs-rules-actions button\{[^}]*font-weight:600/)
  assert.match(css, /\.dshs-rules-dialog\{[^}]*overflow-y:auto/, 'модалка прокручивается')
  assert.match(css, /\.dshs-rules-dialog\{[^}]*max-height:min\(86vh,720px\)/)
  assert.match(css, /@media \(max-width:640px\)\{\.dshs-rules-card/, 'адаптив 640 px для карточки')
  assert.match(css, /\.dshs-rules-actions button\[data-variant="primary"\]\{[^}]*color-mix\(in srgb,var\(--dsw-alias-brand-primary/)
  assert.doesNotMatch(css, /\.dshs-rules-actions button\[data-variant="primary"\]\{[^}]*color:#fff/, 'primary — не белым по белому')
  assert.doesNotMatch(css, /\.dshs-rules-chip\{[^}]*min-width:\d+px/, 'у чипов нет фиксированной min-width')

  // Кнопки страницы остались в системе 36/32 (включая фильтр и проверку).
  const nodes = pageNodes()
  const ruleButtons = nodes.filter((node) => node.type === 'button' && /Правила|Защищённые|Контрольные|Архив|Все/.test(textOf(node)))
  assert.ok(ruleButtons.length >= 5, 'кнопки правил отрисованы')
  for (const button of ruleButtons) {
    assert.ok([32, 36].includes(button.props.style.height), `кнопка правила 32 или 36, а не ${button.props.style.height}`)
    assert.equal(button.props.style.borderRadius, 10)
  }
})

test('чистые помощники правил: Mb, источник, щит и названия', () => {
  const { exported } = renderClient()
  const api = exported.__test
  assert.equal(api.formatMbValue(15), '15')
  assert.equal(api.formatMbValue(18.42), '18,4')
  assert.equal(api.formatMbValue(0.004), '0,004')
  assert.equal(api.formatMbValue(undefined), '—')
  const row = api.rulesRowOf(rulesFixture(), 'session-beta')
  assert.equal(row?.id, 'session-beta')
  assert.equal(api.rulesRowOf(rulesFixture(), 'session-unknown'), undefined)
  assert.equal(api.RULE_PRESETS.control.label, 'Контрольная')
  assert.deepEqual(api.RULE_PRESET_ORDER, ['control', 'keep', 'archive', 'none'])
  assert.deepEqual(api.RULE_FILTERS.map(([key]) => key), ['all', 'protected', 'control', 'archive'])
  assert.equal(api.RULE_SOURCE_LABELS.parent, 'унаследовано от родителя')
  assert.equal(api.RULES_VERIFY_BUCKETS.length, 6)
})
