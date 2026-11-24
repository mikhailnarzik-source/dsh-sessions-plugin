/**
 * M1-D: «локальная навсегда» (`local-only.json`) и переключатель режима.
 *
 * L1–L7 проверяют то, что нельзя проверить синтаксисом:
 * - объявление в зеркале + карантин made-local, устойчивость к трём циклам;
 * - чужой push не воскрешает сессию: pull не импортирует, копия снова в карантине;
 * - состояние переживает перезапуск, pull и reset зеркала (домашний реестр);
 * - «Сделать облачной» снимает объявление, метку и отправляет сессию;
 * - офлайн: локальное действие выполнено, коммит — в очереди (outbox);
 * - после reset и pull сессия остаётся локальной;
 * - две сессии независимы: одна локальная навсегда, вторая синхронизируется.
 *
 * UI: регистрация переключателя в шапке сессии, рендер меню, подтверждения,
 * тоста «Отменить» на 10 секунд и кнопки миграции в панели.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import {
  MODE_CLOUD,
  MODE_LOCAL,
  isDeclaredLocalOnly,
  isLocalSession,
  localOnlyPath,
  readLocalOnly,
  readSessionModes,
  setSessionMode,
} from '../lib/session-modes.mjs'
import {
  MADE_LOCAL_REASON,
  cloudCopyPath,
  enforceLocalOnly,
  localOnlyMigrationCandidates,
  makeSessionCloud,
  makeSessionLocal,
} from '../lib/cloud-copy.mjs'
import { DELETED_AT_FILE, quarantinePath, readTombstones } from '../lib/tombstones.mjs'
import { LOG_NAME, localSessionDir } from '../lib/store.mjs'
import { pull, push } from '../lib/sync.mjs'
import { outboxSummary, readOutbox } from '../lib/outbox.mjs'
import { __setRunnerForTest } from '../lib/git.mjs'

const PROJECT = 'alpha'
const PROJECT_PATH = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'

// --- помощники -------------------------------------------------------------

function frameOf(value) {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`))
}

function makeLog(id, { cwd = PROJECT_PATH, createdAt = Date.now(), title = '' } = {}) {
  const header = { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }
  const frames = [frameOf(header)]
  if (title !== '') frames.push(frameOf({ type: 'session/title', seq: 0, time: createdAt + 10, data: { title } }))
  frames.push(frameOf({ type: 'text', seq: 1 }))
  return Buffer.concat(frames)
}

async function writeLocalSession(home, id, bytes, cwd = PROJECT_PATH) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG_NAME), bytes)
  return dir
}

async function writeMirrorCopy(repoDir, id, bytes, { projectId = PROJECT, title = '' } = {}) {
  const dir = cloudCopyPath(repoDir, projectId, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG_NAME), bytes)
  if (title !== '') await writeFile(join(dir, 'session.json'), `${JSON.stringify({ id, title })}\n`, 'utf8')
  return dir
}

async function makeEnvironment({ deviceId = 'device-a', shared = undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m1-local-'))
  const home = join(root, 'home')
  const repoDir = shared ?? join(root, 'mirror')
  await mkdir(home, { recursive: true })
  await mkdir(repoDir, { recursive: true })
  const config = {
    ...defaultConfig(home),
    backend: 'folder',
    repoDir,
    remote: '',
    deviceId,
    profile: { enabled: false },
    workspace: { enabled: false },
    autoSync: { enabled: false },
    projects: { [PROJECT]: { path: PROJECT_PATH, title: PROJECT } },
  }
  await saveConfig(home, config)
  return { root, home, repoDir, config }
}

/** Ответ маршрута host-части без живого DSH. */
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

async function bootPlugin({ home, ctx = {} }) {
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

/** Ссылка на локальный лог сессии (для проверки «не тронут»). */
function localLogPath(home, id) {
  return join(localSessionDir(home, PROJECT_PATH, id), LOG_NAME)
}

// --- L1: убрать копию из облака -------------------------------------------

test('L1: «убрать копию из облака» — объявление, карантин made-local, три цикла', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id, { title: 'Только здесь' })
    const localDir = await writeLocalSession(env.home, id, bytes)
    const localBefore = await readFile(join(localDir, LOG_NAME))

    for (let cycle = 0; cycle < 3; cycle += 1) {
      // Каждый цикл «чужое устройство» снова кладёт копию в зеркало.
      await writeMirrorCopy(env.repoDir, id, bytes, { title: 'Только здесь' })

      const result = await makeSessionLocal({
        home: env.home,
        config: env.config,
        sessionId: id,
        options: { declaredBy: 'device-a' },
      })
      assert.equal(result.ok, true, `цикл ${cycle}: действие выполнено`)
      assert.equal(result.declared, true, 'объявление записано')
      assert.equal(result.quarantined, true, 'копия ушла в карантин')
      assert.equal(existsSync(cloudCopyPath(env.repoDir, PROJECT, id)), false, 'активной копии нет')

      const quarantine = quarantinePath(env.repoDir, PROJECT, id)
      assert.equal(existsSync(quarantine), true, 'копия в карантине')
      const deletedAt = JSON.parse(await readFile(join(quarantine, DELETED_AT_FILE), 'utf8'))
      assert.equal(deletedAt.reason, MADE_LOCAL_REASON, 'карантин: причина made-local')
      assert.equal(deletedAt.by, 'owner')

      const declarations = await readLocalOnly(env.repoDir)
      assert.equal(isDeclaredLocalOnly(declarations, id), true, 'объявление в зеркале')
      assert.equal(declarations.sessions[id].declaredBy, 'device-a')
      assert.equal(declarations.sessions[id].reason, 'owner')
      assert.equal(declarations.version, 1)

      const tombstones = await readTombstones(env.repoDir)
      assert.equal(tombstones.sessions[id].reason, MADE_LOCAL_REASON, 'метка made-local')
      assert.equal(tombstones.sessions[id].by, 'owner')

      const modes = await readSessionModes(env.home)
      assert.equal(isLocalSession(modes, id), true, 'режим локальный')
      assert.deepEqual(await readFile(join(localDir, LOG_NAME)), localBefore, 'локальный лог не тронут')
      // Домашний реестр — источник правды, переживающий reset зеркала.
      const homeDeclarations = await readLocalOnly(join(env.home, 'dsh-sync'))
      assert.equal(isDeclaredLocalOnly(homeDeclarations, id), true, 'объявление в домашнем реестре')
    }
    // После трёх циклов файл объявлений не вырос: одна запись на сессию.
    const finalDeclarations = await readLocalOnly(env.repoDir)
    assert.equal(Object.keys(finalDeclarations.sessions).length, 1, 'объявления объединены по id')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('L1: enforceLocalOnly идемпотентен — три прогона ничего не меняют', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id)
    await writeLocalSession(env.home, id, bytes)
    await makeSessionLocal({ home: env.home, config: env.config, sessionId: id, options: { declaredBy: 'device-a' } })

    const first = await enforceLocalOnly({ home: env.home, config: env.config })
    assert.equal(first.ok, true)
    assert.equal(first.removed, 0, 'копий нет — убирать нечего')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const again = await enforceLocalOnly({ home: env.home, config: env.config })
      assert.equal(again.removed, 0)
      assert.equal(again.tombstoneAdded, 0, 'метка не дублируется')
      assert.equal(again.declaredIds.length, 1)
    }
    // Ровно одна запись в каждом реестре и одна метка.
    assert.equal(Object.keys((await readLocalOnly(env.repoDir)).sessions).length, 1)
    assert.equal(Object.keys((await readLocalOnly(join(env.home, 'dsh-sync'))).sessions).length, 1)
    assert.equal(Object.keys((await readTombstones(env.repoDir)).sessions).length, 1)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('L4: снятое на другом устройстве объявление не воскресает из домашнего реестра', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id)
    await writeLocalSession(env.home, id, bytes)
    await makeSessionLocal({ home: env.home, config: env.config, sessionId: id, options: { declaredBy: 'device-a' } })
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), true)

    // Второе устройство снимает объявление («Сделать облачной»).
    const other = await makeEnvironment({ deviceId: 'device-b', shared: env.repoDir })
    try {
      await makeSessionCloud({ home: other.home, config: other.config, sessionId: id })
    } finally {
      await rm(other.root, { recursive: true, force: true })
    }
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), false, 'в зеркале объявления нет')

    // Наше устройство не должно вернуть запись из своего домашнего реестра.
    const enforced = await enforceLocalOnly({ home: env.home, config: env.config })
    assert.equal(enforced.declaredIds.includes(id), false, 'устаревшее объявление не воскрешено')
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), false)
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(join(env.home, 'dsh-sync')), id), false, 'домашний реестр очищен')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- L2: чужой push не возвращает ----------------------------------------
test('L2: чужой push возвращает копию, но pull её не принимает, а enforce убирает', async () => {
  const env = await makeEnvironment()
  let boot
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id, { title: 'Личная' })
    await writeLocalSession(env.home, id, bytes)
    await writeMirrorCopy(env.repoDir, id, bytes, { title: 'Личная' })
    const declared = await makeSessionLocal({ home: env.home, config: env.config, sessionId: id, options: { declaredBy: 'device-a' } })
    assert.equal(declared.quarantined, true)

    // Второе устройство: та же сессия, режим не локальный — push вернёт копию.
    const other = await makeEnvironment({ deviceId: 'device-b', shared: env.repoDir })
    try {
      await writeLocalSession(other.home, id, bytes)
      const pushed = await push({ home: other.home, config: other.config })
      assert.equal(pushed.pushed, 1, 'чужое устройство отправило сессию')
      assert.equal(existsSync(cloudCopyPath(env.repoDir, PROJECT, id)), true, 'копия появилась в зеркале')
      const tombstones = await readTombstones(env.repoDir)
      assert.equal(tombstones.sessions[id].reason, MADE_LOCAL_REASON, 'метка made-local не снята чужим push')
    } finally {
      await rm(other.root, { recursive: true, force: true })
    }

    // Наше устройство: pull не импортирует сессию, пока метка made-local.
    const localDir = localSessionDir(env.home, PROJECT_PATH, id)
    const pulled = await pull({ home: env.home, config: env.config })
    assert.equal(pulled.imported, 0, 'копия не импортирована')
    assert.equal(existsSync(join(localDir, LOG_NAME)), true, 'локальная сессия цела')

    // После приёма enforce убирает появившуюся копию в карантин.
    const enforced = await enforceLocalOnly({ home: env.home, config: env.config })
    assert.equal(enforced.removed, 1, 'вернувшаяся копия убрана')
    assert.equal(existsSync(cloudCopyPath(env.repoDir, PROJECT, id)), false)

    // Панель: маршрут миграции видит отсутствие кандидатов после уборки.
    boot = await bootPlugin({ home: env.home, ctx: { get: () => undefined } })
    const asked = await boot.call('/api/dsh-sync/local-only-migration', {})
    assert.equal(asked.status, 409, 'без подтверждения — только показ')
    assert.equal(asked.body.code, 'confirm-required')
    assert.equal(asked.body.count, 0, 'копий локальных сессий не осталось')
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- L3: перезапуск и reset ------------------------------------------------

test('L3: состояние переживает перезапуск, pull и reset зеркала', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id)
    await writeLocalSession(env.home, id, bytes)
    await writeMirrorCopy(env.repoDir, id, bytes)
    await makeSessionLocal({ home: env.home, config: env.config, sessionId: id, options: { declaredBy: 'device-a' } })

    // «Перезапуск»: читаем всё заново с диска теми же путями.
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), true)
    assert.equal(isLocalSession(await readSessionModes(env.home), id), true)

    // «pull reset»: reset --hard вернул ветку без наших незакоммиченных файлов.
    await rm(localOnlyPath(env.repoDir), { force: true })
    await rm(join(env.repoDir, 'tombstones.json'), { force: true })
    await writeMirrorCopy(env.repoDir, id, bytes, { title: 'Копия после reset' })

    const restored = await enforceLocalOnly({ home: env.home, config: env.config })
    assert.equal(restored.ok, true)
    assert.equal(restored.declaredIds.includes(id), true, 'объявление восстановлено из домашнего реестра')
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), true, 'объявление снова в зеркале')
    assert.equal((await readTombstones(env.repoDir)).sessions[id].reason, MADE_LOCAL_REASON, 'метка восстановлена')
    assert.equal(restored.removed, 1, 'копия, приехавшая с reset, убрана в карантин')
    assert.equal(existsSync(cloudCopyPath(env.repoDir, PROJECT, id)), false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- L4: «сделать облачной» ------------------------------------------------

test('L4: «сделать облачной» снимает объявление и метку, сессия снова отправляется', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id, { title: 'Вернуть в облако' })
    await writeLocalSession(env.home, id, bytes)
    await writeMirrorCopy(env.repoDir, id, bytes)
    await makeSessionLocal({ home: env.home, config: env.config, sessionId: id, options: { declaredBy: 'device-a' } })

    const result = await makeSessionCloud({ home: env.home, config: env.config, sessionId: id })
    assert.equal(result.ok, true)
    assert.equal(result.mode, MODE_CLOUD)
    assert.equal(result.undeclared, true, 'объявление снято')
    assert.equal(result.tombstoneDropped, true, 'метка made-local снята')

    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), false, 'в зеркале объявления нет')
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(join(env.home, 'dsh-sync')), id), false, 'в домашнем реестре нет')
    assert.equal((await readTombstones(env.repoDir)).sessions[id], undefined, 'метки удаления нет')
    assert.equal(isLocalSession(await readSessionModes(env.home), id), false, 'режим облачный')

    // Сессия снова участвует в обмене: push кладёт копию в зеркало.
    const pushed = await push({ home: env.home, config: env.config })
    assert.equal(pushed.pushed, 1, 'сессия отправлена')
    assert.equal(existsSync(cloudCopyPath(env.repoDir, PROJECT, id)), true)
    assert.equal((await readTombstones(env.repoDir)).sessions[id], undefined, 'push не создаёт метку made-local')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- L5: офлайн → outbox ---------------------------------------------------

test('L5: офлайн — локальное действие выполнено, коммит ждёт в очереди', async () => {
  const env = await makeEnvironment()
  let boot
  try {
    // Зеркало-репозиторий: есть каталог, но git-команды падают (нет сети).
    __setRunnerForTest(async () => ({ code: 1, stdout: '', stderr: 'fatal: unable to access remote: network is unreachable' }))
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id)
    await writeLocalSession(env.home, id, bytes)
    await writeMirrorCopy(env.repoDir, id, bytes)
    env.config.backend = 'git'
    env.config.remote = 'https://github.com/me/sessions.git'
    await saveConfig(env.home, env.config)

    boot = await bootPlugin({ home: env.home, ctx: { get: () => undefined } })
    const response = await boot.call('/api/dsh-sync/session-mode', { id, mode: 'local' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.localOnly.declared, 1, 'объявление записано локально')
    assert.equal(response.body.localOnly.quarantined, 1, 'копия убрана в карантин')
    assert.equal(typeof response.body.warning, 'string', 'сетевой сбой показан понятной строкой')
    assert.match(response.body.warning, /network is unreachable/)

    // Локальные файлы зеркала на месте: следующий коммит их отправит.
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), true)
    assert.equal(existsSync(quarantinePath(env.repoDir, PROJECT, id)), true)
    assert.equal(isLocalSession(await readSessionModes(env.home), id), true)

    // Операция в очереди: повторится, когда сеть вернётся.
    const outbox = await outboxSummary(env.home)
    assert.equal(outbox.count >= 1, true, 'операция в очереди')
    const queue = await readOutbox(env.home)
    const operation = queue.operations.find(item => item.type === 'mode')
    assert.ok(operation, 'смена режима в очереди')
    assert.deepEqual(operation.payload.ids, [id])
    assert.equal(operation.payload.mode, 'local')
    assert.equal(operation.payload.declare, true)
  } finally {
    __setRunnerForTest(null)
    boot?.dispose(); boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- L6: pull после reset --------------------------------------------------

test('L6: после reset и pull сессия остаётся локальной и не приезжает обратно', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id)
    await writeLocalSession(env.home, id, bytes)
    await writeMirrorCopy(env.repoDir, id, bytes)
    await makeSessionLocal({ home: env.home, config: env.config, sessionId: id, options: { declaredBy: 'device-a' } })

    // Reset зеркала, затем чужой push кладёт копию и наш pull её видит.
    await rm(localOnlyPath(env.repoDir), { force: true })
    await rm(join(env.repoDir, 'tombstones.json'), { force: true })
    await writeMirrorCopy(env.repoDir, id, bytes)

    const pulled = await pull({ home: env.home, config: env.config })
    assert.equal(pulled.imported, 0, 'импорта нет: сессия локальная навсегда')
    const enforced = await enforceLocalOnly({ home: env.home, config: env.config })
    assert.equal(enforced.declaredIds.includes(id), true)
    assert.equal(enforced.removed, 1, 'копия убрана после reset')
    assert.equal(isLocalSession(await readSessionModes(env.home), id), true)
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), true)

    // Повторный pull ничего не меняет.
    const again = await pull({ home: env.home, config: env.config })
    assert.equal(again.imported, 0)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- L7: две сессии независимы --------------------------------------------

test('L7: две сессии независимы — одна локальная навсегда, вторая синхронизируется', async () => {
  const env = await makeEnvironment()
  try {
    const localId = `session-${randomUUID()}`
    const cloudId = `session-${randomUUID()}`
    const localBytes = makeLog(localId, { title: 'Личная' })
    const cloudBytes = makeLog(cloudId, { title: 'Общая' })
    await writeLocalSession(env.home, localId, localBytes)
    await writeLocalSession(env.home, cloudId, cloudBytes)
    await writeMirrorCopy(env.repoDir, localId, localBytes)

    await makeSessionLocal({ home: env.home, config: env.config, sessionId: localId, options: { declaredBy: 'device-a' } })
    const pushed = await push({ home: env.home, config: env.config })
    assert.equal(pushed.pushed, 1, 'отправлена только облачная сессия')
    assert.equal(existsSync(cloudCopyPath(env.repoDir, PROJECT, localId)), false, 'локальная не отправлена')
    assert.equal(existsSync(cloudCopyPath(env.repoDir, PROJECT, cloudId)), true, 'облачная отправлена')
    assert.equal(pushed.localSkipped, 1, 'одна локальная пропущена')

    // Другое устройство принимает только облачную сессию.
    const other = await makeEnvironment({ deviceId: 'device-b', shared: env.repoDir })
    try {
      const pulled = await pull({ home: other.home, config: other.config })
      assert.equal(pulled.imported, 1, 'принята одна сессия')
      assert.equal(existsSync(join(localSessionDir(other.home, other.config.projects[PROJECT].path, cloudId), LOG_NAME)), true)
      assert.equal(existsSync(join(localSessionDir(other.home, other.config.projects[PROJECT].path, localId), LOG_NAME)), false, 'локальная не приехала')
    } finally {
      await rm(other.root, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- панель: миграция ------------------------------------------------------

test('L: миграция «убрать облачные копии локальных сессий» — confirm и карантин', async () => {
  const env = await makeEnvironment()
  let boot
  try {
    const first = `session-${randomUUID()}`
    const second = `session-${randomUUID()}`
    for (const id of [first, second]) {
      const bytes = makeLog(id)
      await writeLocalSession(env.home, id, bytes)
      await writeMirrorCopy(env.repoDir, id, bytes)
      // Старая локальная сессия: режим local уже стоит, объявления ещё нет.
      await setSessionMode(env.home, [id], MODE_LOCAL)
    }

    const candidates = await localOnlyMigrationCandidates({ home: env.home, config: env.config })
    assert.equal(candidates.count, 2, 'две локальные сессии с копией в зеркале')

    boot = await bootPlugin({ home: env.home, ctx: { get: () => undefined } })
    const asked = await boot.call('/api/dsh-sync/local-only-migration', {})
    assert.equal(asked.status, 409)
    assert.equal(asked.body.code, 'confirm-required')
    assert.equal(asked.body.count, 2)

    const done = await boot.call('/api/dsh-sync/local-only-migration', { confirm: true })
    assert.equal(done.status, 200)
    assert.equal(done.body.ok, true)
    assert.equal(done.body.action, 'local-only-migration')
    assert.equal(done.body.removed, 2)
    assert.deepEqual(done.body.reasons, ['made-local'])
    for (const id of [first, second]) {
      assert.equal(existsSync(cloudCopyPath(env.repoDir, PROJECT, id)), false, 'копии нет')
      assert.equal(existsSync(quarantinePath(env.repoDir, PROJECT, id)), true, 'копия в карантине')
      assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), true, 'объявление записано')
    }
    // После миграции кандидатов нет, повторный вызов ничего не делает.
    assert.equal((await localOnlyMigrationCandidates({ home: env.home, config: env.config })).count, 0)
    const again = await boot.call('/api/dsh-sync/local-only-migration', { confirm: true })
    assert.equal(again.body.removed, 0)
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

test('L: маршрут режима объявляет локальность и отдаёт объявления в /sessions', async () => {
  const env = await makeEnvironment()
  let boot
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(id)
    await writeLocalSession(env.home, id, bytes)
    await writeMirrorCopy(env.repoDir, id, bytes)

    boot = await bootPlugin({ home: env.home, ctx: { get: () => undefined } })
    const switched = await boot.call('/api/dsh-sync/session-mode', { id, mode: 'local' })
    assert.equal(switched.status, 200)
    assert.equal(switched.body.ok, true)
    assert.equal(switched.body.changed, 1)
    assert.equal(switched.body.localOnly.declared, 1)
    assert.equal(switched.body.localOnly.declarations, 1)

    const states = await boot.call('/api/dsh-sync/sessions', {})
    assert.equal(states.status, 200)
    assert.equal(states.body.localOnly.count, 1, 'панель видит объявление')
    const row = states.body.sessions.find(session => session.id === id)
    assert.ok(row, 'сессия в снимке')
    assert.equal(row.mode, 'local')
    assert.equal(row.declared, true, 'признак «локальная навсегда»')
    assert.equal(row.cloudCopy, false, 'копии нет')
    assert.equal(states.body.localOnly.migration.count, 0)

    // Обратное переключение снимает объявление.
    const back = await boot.call('/api/dsh-sync/session-mode', { id, mode: 'cloud' })
    assert.equal(back.status, 200)
    assert.equal(back.body.localOnly.undeclared, 1)
    assert.equal((await readSessionModes(env.home)).sessions[id], MODE_CLOUD)
    assert.equal(isDeclaredLocalOnly(await readLocalOnly(env.repoDir), id), false)
  } finally {
    boot?.dispose(); boot?.restoreHome()
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- UI: переключатель в шапке сессии --------------------------------------

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
  const toggle = registrations.find(entry => entry.options.name === 'conversation.session.header.actions' && entry.options.id === 'dsh-sync.mode')
  return { exported, registrations, main, toggle }
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

const buttonsIn = (node) => walk(node).filter(child => child.type === 'button')

test('UI: переключатель зарегистрирован в шапке открытой сессии', () => {
  const { toggle } = renderClient()
  assert.ok(toggle, 'слот conversation.session.header.actions занят переключателем')
  assert.equal(toggle.options.order >= 0, true)
  assert.equal(typeof toggle.options.inject, 'function')
  assert.deepEqual(toggle.options.inject('session-abc'), { sessionId: 'session-abc' }, 'слот передаёт sessionId')
})

test('UI: чип режима и меню с объяснением и подтверждением', () => {
  const { exported } = renderClient()
  exported.__test.setSessionStates({
    ok: true,
    sessions: [
      { id: 'session-a', mode: 'cloud', badge: 'synced', declared: false, cloudCopy: false },
      { id: 'session-b', mode: 'local', badge: 'local', declared: true, cloudCopy: true },
    ],
    modes: { local: 1, cloud: 1 },
    localOnly: { count: 1, declaredIds: ['session-b'], migration: { count: 1, ids: ['session-b'] } },
  })

  // Чип «Облачная» у облачной сессии.
  const cloudToggle = walk(resolveNode(exported.__test.SessionModeToggle({ sessionId: 'session-a' })))
  assert.match(cloudToggle.map(textOf).join(' '), /Облачная/, 'чип показывает режим')
  assert.ok(cloudToggle.some(node => node.type === 'button' && node.props['data-mode'] === 'cloud'))

  // Меню облачной сессии: объяснение и «Сделать локальной».
  const cloudMenu = walk(resolveNode(exported.__test.SessionModeMenu({ mode: 'cloud' })))
  const cloudText = cloudMenu.map(textOf).join('\n')
  assert.match(cloudText, /Облачная сессия/)
  assert.match(cloudText, /синхронизируется между устройствами/)
  assert.ok(buttonsIn(cloudMenu[0] ?? cloudMenu).some(button => textOf(button).includes('Сделать локальной')), 'кнопка переключения в локальную')

  // Меню локальной объявленной сессии: предупреждение и возврат в облако.
  const localMenu = walk(resolveNode(exported.__test.SessionModeMenu({ mode: 'local', declared: true })))
  const localText = localMenu.map(textOf).join('\n')
  assert.match(localText, /Локальная сессия/)
  assert.match(localText, /локальная навсегда/)
  assert.ok(buttonsIn(localMenu[0] ?? localMenu).some(button => textOf(button).includes('Сделать облачной')))

  // Подтверждение один раз: «Убрать копию из облака».
  const confirmMenu = walk(resolveNode(exported.__test.SessionModeMenu({ mode: 'cloud', confirm: true })))
  const confirmText = confirmMenu.map(textOf).join('\n')
  assert.match(confirmText, /карантин/)
  assert.ok(buttonsIn(confirmMenu[0] ?? confirmMenu).some(button => textOf(button).includes('Убрать копию из облака')))
  assert.ok(buttonsIn(confirmMenu[0] ?? confirmMenu).some(button => textOf(button).includes('Отмена')))
})

test('UI: тост «Отменить» на 10 секунд', () => {
  const { exported } = renderClient()
  let undone = 0
  let closed = 0
  const toast = walk(resolveNode(exported.__test.LocalOnlyToast({
    text: 'Сессия локальная навсегда',
    seconds: 10,
    onUndo: () => { undone += 1 },
    onClose: () => { closed += 1 },
  })))
  const text = toast.map(textOf).join('\n')
  assert.match(text, /Сессия локальная навсегда/)
  assert.match(text, /10 с/, 'таймер тоста показан')
  const undo = buttonsIn(toast[0] ?? toast).find(button => textOf(button).includes('Отменить'))
  assert.ok(undo, 'кнопка «Отменить»')
  undo.props.onClick()
  assert.equal(undone, 1, 'отмена вызывает возврат режима')
  assert.equal(closed, 0)
})

test('UI: кнопка миграции в панели и подтверждение', () => {
  const { exported, main } = renderClient()
  exported.__test.setSessionStates({
    ok: true,
    sessions: [
      { id: 'session-local', mode: 'local', badge: 'local', declared: false, cloudCopy: true, title: 'Локальная' },
      { id: 'session-cloud', mode: 'cloud', badge: 'synced', declared: false, cloudCopy: false, title: 'Облачная' },
    ],
    modes: { local: 1, cloud: 1 },
    localOnly: { count: 0, declaredIds: [], migration: { count: 1, ids: ['session-local'] } },
  })
  const nodes = walk(resolveNode(main.component({})))
  const text = nodes.map(textOf).join('\n')
  assert.match(text, /Локальные навсегда/)
  const migration = buttonsIn(nodes[0]).find(button => /Убрать облачные копии локальных сессий \(1\)/.test(textOf(button)))
  assert.ok(migration, 'кнопка миграции с количеством')
  // Кнопка не активна без подтверждения, но кликабельна (первый шаг).
  assert.equal(migration.props.disabled, false)
  // Второй шаг: подтверждение и «Отмена».
  const confirmNodes = walk(resolveNode(main.component({})))
  assert.ok(confirmNodes.length > 0)
  assert.ok(injectedStyles.some(css => String(css).includes('.dshs-mode-toggle')), 'стили переключателя внедрены')
  assert.ok(injectedStyles.some(css => String(css).includes('.dshs-mode-toast')), 'стили тоста внедрены')
})
