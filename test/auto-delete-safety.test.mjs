/**
 * M7: предохранители автоудаления сессий (инцидент 25.11).
 *
 * 25.11 после восстановления сессий из архива старое зеркало с метками удаления
 * при первом же pull удалило 18 живых сессий. Тесты проверяют предохранители:
 *   1) «воскрешение»: лог новее метки — не удаляем, метка становится restored;
 *   2) массовая пачка, старая метка и autoApply:false — автоудаление целиком
 *      останавливается и ждёт «Применить удаления»;
 *   3) подтверждённое удаление обходит массовый предохранитель, но не restored;
 *   4) pendingDeletions в плане, revivedIds/deletionsBlocked в сводке;
 *   5) группа «родитель + субагенты» — одна операция удаления;
 *   6) настройки deletions в конфиге и их значения по умолчанию.
 *
 * Запуск: node --import ./test/setup.mjs --test test/auto-delete-safety.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { DELETIONS_DEFAULTS, defaultConfig, deletionsConfig, loadConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir } from '../lib/store.mjs'
import { applyDeletions, pull, push, reconcileLocalDeletions } from '../lib/sync.mjs'
import { addTombstone, markRestored, readTombstones, writeTombstones } from '../lib/tombstones.mjs'
import { deletionGuardViolation, logNewerThanTombstone } from '../lib/deletions.mjs'

// --- helpers ---------------------------------------------------------------

const LOG = 'session.v4.jsonl.zstd'

function makeLog(header, events = []) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function headerFor(cwd, id = `session-${randomUUID()}`, parent = undefined, createdAt = Date.now()) {
  const header = { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: parent === undefined ? 0 : 1 }
  if (parent !== undefined) header.parentSession = parent
  return header
}

async function writeSession(home, cwd, id, bytes) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG), bytes)
  return dir
}

const iso = ms => new Date(ms).toISOString()

/**
 * Устройство A (создаёт и отправляет) и B (принимает): общая папка зеркала,
 * как у backend: folder без облачного кеша.
 */
async function makeEnvironment({ deletions } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-delete-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const shared = join(root, 'shared')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(shared, { recursive: true })
  const pathA = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const pathB = process.platform === 'win32' ? 'D:\\work\\alpha' : '/home/user/alpha'
  const makeConfig = (home, deviceId, projectPath, extra = {}) => {
    const config = {
      ...defaultConfig(home),
      backend: 'folder',
      deviceId,
      repoDir: shared,
      profile: { enabled: false },
      workspace: { enabled: false },
      ...extra,
    }
    config.projects = { alpha: { path: projectPath, title: 'alpha' } }
    return config
  }
  const configA = makeConfig(homeA, 'device-a', pathA)
  const configB = makeConfig(homeB, 'device-b', pathB, deletions === undefined ? {} : { deletions })
  await saveConfig(homeA, configA)
  await saveConfig(homeB, configB)
  return { root, homeA, homeB, shared, pathA, pathB, configA, configB }
}

const localPath = (home, cwd, id) => join(localSessionDir(home, cwd, id), LOG)
const mirrorPath = (config, id) => join(config.repoDir, 'sessions', 'alpha', id, LOG)
const quarantinePath = (config, id) => join(config.repoDir, 'sessions', 'alpha', '_deleted', id, LOG)

/** Записать метки так, как их пишет панельное удаление (без карантина зеркала). */
async function writeMarks(config, entries) {
  const data = await readTombstones(config.repoDir)
  for (const [sessionId, meta] of Object.entries(entries)) {
    addTombstone(data, sessionId, meta.device ?? 'device-a', {
      reason: meta.reason ?? 'manual',
      by: meta.by ?? 'owner',
      ...(meta.at === undefined ? {} : { at: meta.at }),
      ...(meta.parent === undefined ? {} : { parent: meta.parent }),
    })
  }
  await writeTombstones(config.repoDir, data)
}

// --- 1. свежая метка + неизменённый лог → удаляется -------------------------

test('M7: свежая метка и лог без изменений — локальная копия уходит в архив', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeB, env.pathB, id, makeLog(headerFor(env.pathB, id), [{ seq: 0 }]))
    // Метка чуть позже лога: лог не новее метки, автоудаление законно.
    await writeMarks(env.configB, { [id]: { at: Date.now() - 1000 } })

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted, 1, 'копия удалена по метке')
    assert.deepEqual(pulled.deletedIds, [id])
    assert.equal(pulled.deletionsBlocked, undefined, 'предохранитель не сработал')
    assert.equal(existsSync(localPath(env.homeB, env.pathB, id)), false, 'локальной копии нет')
    // Данные не исчезли: копия в локальном архиве (восстановима из панели).
    const stamps = await readdir(join(env.homeB, 'dsh-sync', 'deleted'))
    assert.ok(stamps.length > 0, 'есть архивный прогон')
    assert.equal(existsSync(join(env.homeB, 'dsh-sync', 'deleted', stamps[0], id)), true, 'копия в локальном архиве')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 2. лог новее метки → «воскрешение» ------------------------------------

test('M7: лог новее метки — сессию не удаляют, метка становится restored, revivedIds в сводке', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeB, env.pathB, id, makeLog(headerFor(env.pathB, id), [{ seq: 0 }]))
    // Метка на 5 минут старше свежего лога: сессию восстановили/продолжили.
    await writeMarks(env.configB, { [id]: { at: Date.now() - 5 * 60_000 } })

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted ?? 0, 0, 'ничего не удалено')
    assert.deepEqual(pulled.revivedIds, [id], 'воскрешение посчитано')
    assert.match(pulled.warning ?? '', /лог новее метки/)
    assert.equal(existsSync(localPath(env.homeB, env.pathB, id)), true, 'локальная копия на месте')

    const data = await readTombstones(env.configB.repoDir)
    assert.equal(data.sessions[id].reason, 'restored', 'метка снята как restored')
    assert.equal(data.sessions[id].restoredFrom, 'manual', 'прежняя причина сохранена')

    // Повторный приём не пытается удалить сессию ещё раз.
    const second = await pull({ home: env.homeB, config: env.configB })
    assert.equal(second.deleted ?? 0, 0, 'повторной попытки удаления нет')
    assert.equal(existsSync(localPath(env.homeB, env.pathB, id)), true, 'копия жива')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('M7: воскрешение защищает всю группу «родитель + субагенты»', async () => {
  const env = await makeEnvironment()
  try {
    const parent = `session-${randomUUID()}`
    const child = `session-${randomUUID()}`
    await writeSession(env.homeB, env.pathB, parent, makeLog(headerFor(env.pathB, parent), [{ seq: 0 }]))
    await writeSession(env.homeB, env.pathB, child, makeLog(headerFor(env.pathB, child, parent), [{ seq: 0 }]))
    const oldAt = Date.now() - 5 * 60_000
    await writeMarks(env.configB, {
      [parent]: { at: oldAt },
      [child]: { at: oldAt, reason: 'children', parent },
    })

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted ?? 0, 0, 'группа не удалена')
    assert.deepEqual([...pulled.revivedIds].sort(), [child, parent].sort(), 'оба члена группы защищены')
    assert.equal(existsSync(localSessionDir(env.homeB, env.pathB, parent)), true)
    assert.equal(existsSync(localSessionDir(env.homeB, env.pathB, child)), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 3. массовый предохранитель --------------------------------------------

test('M7: 5 независимых меток при maxAutoRemove=3 — ничего не удалено, deletionsBlocked=mass', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let index = 0; index < 5; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.homeA, env.pathA, id, makeLog(headerFor(env.pathA, id), [{ seq: 0 }]))
    }
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })
    // Панельное удаление на A: метки есть, копии в зеркале живы (карантина нет).
    await writeMarks(env.configA, Object.fromEntries(ids.map(id => [id, { at: Date.now() }])))

    const blocked = await pull({ home: env.homeB, config: env.configB })
    assert.equal(blocked.deleted ?? 0, 0, 'ни одна копия не удалена')
    assert.ok(blocked.deletionsBlocked, 'предохранитель сработал')
    assert.equal(blocked.deletionsBlocked.reason, 'mass')
    assert.equal(blocked.deletionsBlocked.count, 5)
    assert.deepEqual([...blocked.deletionsBlocked.ids].sort(), ids.slice().sort())
    assert.equal(blocked.deletionsBlocked.details.maxAutoRemove, 3)
    assert.equal(blocked.deletionsBlocked.details.rootsCount, 5, 'пять независимых удалений')
    assert.equal(blocked.pendingDeletions.count, 5, 'ждёт подтверждения')
    assert.match(blocked.warning ?? '', /автоудаление остановлено: 5 меток — проверьте „Удаления“/)
    for (const id of ids) {
      assert.equal(existsSync(localPath(env.homeB, env.pathB, id)), true, `копия ${id} осталась на месте`)
    }

    // «Применить удаления» обходит массовый предохранитель.
    const confirmed = await applyDeletions({ home: env.homeB, config: env.configB, confirm: true })
    assert.equal(confirmed.removed, 5, 'подтверждённое удаление выполнено')
    assert.equal(confirmed.guard.bypassed, true)
    assert.equal(confirmed.guard.wouldBlock.reason, 'mass')
    for (const id of ids) {
      assert.equal(existsSync(mirrorPath(env.configB, id)), false, 'живой копии в зеркале нет')
      assert.equal(existsSync(quarantinePath(env.configB, id)), true, 'копия в карантине зеркала')
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('M7: пачка из 4 сессий одной группы — одна операция, предохранитель массы не срабатывает', async () => {
  const env = await makeEnvironment()
  try {
    const parent = `session-${randomUUID()}`
    const childA = `session-${randomUUID()}`
    const childB = `session-${randomUUID()}`
    const grandchild = `session-${randomUUID()}`
    const family = { parent, childA, childB, grandchild }
    for (const [name, id] of Object.entries(family)) {
      const parentId = name === 'childA' || name === 'childB' ? parent : (name === 'grandchild' ? childA : undefined)
      await writeSession(env.homeB, env.pathB, id, makeLog(headerFor(env.pathB, id, parentId), [{ seq: 0 }]))
    }
    const at = Date.now()
    await writeMarks(env.configB, {
      [parent]: { at },
      [childA]: { at, reason: 'children', parent },
      [childB]: { at, reason: 'children', parent },
      [grandchild]: { at, reason: 'children', parent: childA },
    })

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted, 4, 'группа удалена целиком')
    assert.equal(pulled.childrenDeleted, 3)
    assert.equal(pulled.deletionsBlocked, undefined, 'это одна операция, а не массовая пачка')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('M7: метка старше maxTombstoneAgeDays — автоудаление остановлено, deletionsBlocked=stale', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeB, env.pathB, id, makeLog(headerFor(env.pathB, id), [{ seq: 0 }]))
    // Лог последний раз писали до удаления: он не «воскресший», но метка старая.
    const logAge = new Date(Date.now() - 9 * 24 * 60 * 60_000)
    await utimes(localPath(env.homeB, env.pathB, id), logAge, logAge)
    // Метка 8 дней назад: наследие старого зеркала из архива.
    await writeMarks(env.configB, { [id]: { at: Date.now() - 8 * 24 * 60 * 60_000 } })

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted ?? 0, 0)
    assert.ok(pulled.deletionsBlocked, 'предохранитель сработал')
    assert.equal(pulled.deletionsBlocked.reason, 'stale')
    assert.equal(pulled.deletionsBlocked.details.staleCount, 1)
    assert.equal(pulled.deletionsBlocked.details.maxTombstoneAgeDays, 7)
    assert.match(pulled.warning ?? '', /автоудаление остановлено/)
    assert.equal(existsSync(localPath(env.homeB, env.pathB, id)), true, 'копия на месте')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('M7: autoApply=false — автоудаление выключено, deletionsBlocked=disabled', async () => {
  const env = await makeEnvironment({ deletions: { autoApply: false } })
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeB, env.pathB, id, makeLog(headerFor(env.pathB, id), [{ seq: 0 }]))
    await writeMarks(env.configB, { [id]: { at: Date.now() } })

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted ?? 0, 0, 'ничего не удалено')
    assert.equal(pulled.deletionsBlocked.reason, 'disabled')
    assert.equal(pulled.deletionsBlocked.count, 1)
    assert.equal(existsSync(localPath(env.homeB, env.pathB, id)), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('M7: reconcile тоже уважает предохранители (revivedIds и deletionsBlocked)', async () => {
  const env = await makeEnvironment()
  try {
    const freshId = `session-${randomUUID()}`
    const revivedId = `session-${randomUUID()}`
    await writeSession(env.homeB, env.pathB, freshId, makeLog(headerFor(env.pathB, freshId), [{ seq: 0 }]))
    await writeSession(env.homeB, env.pathB, revivedId, makeLog(headerFor(env.pathB, revivedId), [{ seq: 0 }]))
    await writeMarks(env.configB, {
      [freshId]: { at: Date.now() },
      [revivedId]: { at: Date.now() - 5 * 60_000 },
    })

    const reconciled = await reconcileLocalDeletions({ home: env.homeB, config: env.configB })
    assert.equal(reconciled.deleted, 1, 'удалена только копия со свежей меткой')
    assert.deepEqual(reconciled.deletedIds, [freshId])
    assert.deepEqual(reconciled.revivedIds, [revivedId], 'воскрешение видно в сводке reconcile')
    assert.equal(existsSync(localPath(env.homeB, env.pathB, revivedId)), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('M7: остановленную пачку pull не дожимает автопроходом «повторно применить метки»', async () => {
  const env = await makeEnvironment()
  try {
    const createdAt = Date.now() - 30 * 60_000
    const ids = []
    for (let index = 0; index < 5; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      const log = makeLog(headerFor(env.pathA, id, undefined, createdAt), [{ seq: 0 }])
      await writeSession(env.homeA, env.pathA, id, log)
      // Копия на B существует с тем же старым временем: это не «воскрешение».
      await writeSession(env.homeB, env.pathB, id, makeLog(headerFor(env.pathB, id, undefined, createdAt), [{ seq: 0 }]))
      const oldDate = new Date(createdAt)
      await utimes(localPath(env.homeB, env.pathB, id), oldDate, oldDate)
    }
    await push({ home: env.homeA, config: env.configA })
    // Метки на 20 минут назад: старше окна «свежей ручной метки» (15 минут),
    // то есть старый код добавил бы их в автоматический reconcile.
    await writeMarks(env.configA, Object.fromEntries(ids.map(id => [id, { at: createdAt + 10 * 60_000 }])))

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted ?? 0, 0, 'автоудаление остановлено')
    assert.equal(pulled.deletionsBlocked.reason, 'mass')
    assert.equal(pulled.reconciled, undefined, 'автопроход меток не запускался')
    for (const id of ids) {
      assert.equal(existsSync(localPath(env.homeB, env.pathB, id)), true, `локальная копия ${id} цела`)
      assert.equal(existsSync(mirrorPath(env.configB, id)), true, `копия ${id} в зеркале цела`)
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 4. подтверждённое удаление не обходит restored -------------------------

test('M7: applyDeletions(confirm) не удаляет сессию со снятой меткой restored', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeA, env.pathA, id, makeLog(headerFor(env.pathA, id), [{ seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })
    await rm(localSessionDir(env.homeA, env.pathA, id), { recursive: true, force: true })
    // Пользователь удалил, а затем восстановил сессию: метка — исторический след.
    const data = await readTombstones(env.configA.repoDir)
    addTombstone(data, id, 'device-a', { reason: 'manual', by: 'owner' })
    markRestored(data, id, { by: 'owner', at: Date.now() })
    await writeTombstones(env.configA.repoDir, data)

    const confirmed = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(confirmed.removed, 0, 'восстановленную сессию не удаляем')
    assert.equal(confirmed.restoredSkipped, 1, 'снятая метка учтена в отчёте')
    assert.deepEqual(confirmed.restoredSkippedIds, [id])
    assert.equal(existsSync(mirrorPath(env.configA, id)), true, 'копия в зеркале осталась')
    assert.equal(existsSync(quarantinePath(env.configA, id)), false, 'в карантин не попала')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 5. pendingDeletions в плане -------------------------------------------

test('M7: план push отдаёт pendingDeletions{count,ids,reasons} и дублирует в plan', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let index = 0; index < 2; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.homeA, env.pathA, id, makeLog(headerFor(env.pathA, id), [{ seq: 0 }]))
    }
    await push({ home: env.homeA, config: env.configA })
    for (const id of ids) await rm(localSessionDir(env.homeA, env.pathA, id), { recursive: true, force: true })

    const planned = await push({ home: env.homeA, config: env.configA })
    assert.equal(planned.removed, 0, 'push ничего не удаляет')
    assert.equal(planned.skippedDeletions.removed, 2)
    assert.equal(planned.pendingDeletions.count, 2)
    assert.deepEqual([...planned.pendingDeletions.ids].sort(), ids.slice().sort())
    assert.deepEqual(planned.pendingDeletions.reasons, ['prune'], 'причина — локальное удаление')
    assert.deepEqual(planned.plan.pendingDeletions, planned.pendingDeletions, 'то же в plan для last-run/панели')
    // Формат прежних полей не сломан.
    assert.equal(planned.requireConfirmation.removed, 2)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 6. настройки и чистая логика предохранителя ---------------------------

test('M7: deletions по умолчанию и нормализация старого конфига', async () => {
  assert.deepEqual(defaultConfig('/tmp/dsh-home').deletions, DELETIONS_DEFAULTS)
  assert.deepEqual(deletionsConfig({}), DELETIONS_DEFAULTS, 'старый конфиг получает безопасные значения')
  assert.deepEqual(
    deletionsConfig({ deletions: { autoApply: false, maxAutoRemove: 0, maxTombstoneAgeDays: 1 } }),
    { autoApply: false, maxAutoRemove: 0, maxTombstoneAgeDays: 1 },
  )
  // Битые значения не открывают удаление «без ограничений».
  assert.deepEqual(deletionsConfig({ deletions: { autoApply: 'нет', maxAutoRemove: -5, maxTombstoneAgeDays: 'x' } }), DELETIONS_DEFAULTS)

  const home = await mkdtemp(join(tmpdir(), 'dsh-auto-delete-config-'))
  try {
    // Конфиг старой версии: поля deletions ещё нет.
    await writeFile(join(home, 'dsh-sync.json'), `${JSON.stringify({ version: 1, deviceId: 'old', projects: {} }, null, 2)}\n`, 'utf8')
    const loaded = await loadConfig(home)
    assert.deepEqual(loaded.deletions, DELETIONS_DEFAULTS, 'loadConfig подставил предохранители')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('M7: чистая логика — лог новее метки и корни операций удаления', () => {
  const markAt = Date.now()
  const mark = { at: iso(markAt), reason: 'manual', by: 'owner' }
  assert.equal(logNewerThanTombstone(mark, markAt + 30_000), false, 'в пределах минуты — не воскрешение')
  assert.equal(logNewerThanTombstone(mark, markAt + 61_000), true, 'позже окна — воскрешение')
  assert.equal(logNewerThanTombstone(mark, undefined), false, 'без времени лога защиты нет')
  assert.equal(logNewerThanTombstone(undefined, markAt), false, 'без метки удалять нечего')

  const marks = new Map([
    ['session-parent', { at: markAt, reason: 'manual' }],
    ['session-child', { at: markAt, reason: 'children', parent: 'session-parent' }],
    ['session-solo', { at: markAt, reason: 'manual' }],
  ])
  const roots = new Map([
    ['session-parent', 'session-parent'],
    ['session-child', 'session-parent'],
    ['session-solo', 'session-solo'],
  ])
  // Две независимые операции: группа и одиночная сессия.
  assert.equal(deletionGuardViolation({
    candidates: ['session-parent', 'session-child', 'session-solo'],
    rootBySession: roots,
    marks,
    settings: { autoApply: true, maxAutoRemove: 2, maxTombstoneAgeDays: 7 },
    now: markAt + 1000,
  }), undefined)
  // Третья операция при лимите 2 — блокировка.
  const mass = deletionGuardViolation({
    candidates: ['session-parent', 'session-child', 'session-solo', 'session-extra'],
    rootBySession: new Map([...roots, ['session-extra', 'session-extra']]),
    marks: new Map([...marks, ['session-extra', { at: markAt, reason: 'manual' }]]),
    settings: { autoApply: true, maxAutoRemove: 2, maxTombstoneAgeDays: 7 },
    now: markAt + 1000,
  })
  assert.equal(mass.reason, 'mass')
  assert.equal(mass.count, 4, 'count — сессии, решение — по числу операций')
  assert.equal(mass.details.rootsCount, 3)
})
