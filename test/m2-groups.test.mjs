/**
 * M2-A: групповая синхронизация и удаление «везде».
 *
 * Группа «родитель + субагенты» — единица обмена: на приёме сначала родитель,
 * затем дети; ребёнок удалённого родителя не импортируется и уходит в карантин
 * вместе (reason children); сирота импортируется, помечается orphan и не
 * удаляется. Удаление «везде» не воскрешает копии: после pull/сброса активные
 * метки применяются повторно (reconcile), а офлайн-удаление ждёт в outbox
 * одной операцией с payload `ids[]`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir } from '../lib/store.mjs'
import { applyDeletions, pull, push, reconcileLocalDeletions } from '../lib/sync.mjs'
import { expandDeletionIds, orphanChildren, reasonLabel } from '../lib/deletions.mjs'
import { addTombstone, readTombstones, writeTombstones } from '../lib/tombstones.mjs'
import { deletePayloadIds, enqueueDelete, flushOutbox, outboxSummary, readOutbox } from '../lib/outbox.mjs'
import { encodeSegment } from '../lib/format.mjs'

// --- helpers ---------------------------------------------------------------

function makeLog(header, events = []) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function headerFor(cwd, id = `session-${randomUUID()}`, parent = undefined) {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: parent === undefined ? 0 : 1,
  }
  if (parent !== undefined) header.parentSession = parent
  return header
}

async function writeSession(home, cwd, id, bytes) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), bytes)
  return dir
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m2-groups-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const shared = join(root, 'shared')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(shared, { recursive: true })
  const projectPathA = process.platform === 'win32' ? 'C:\\work\\m2' : '/work/m2'
  const projectPathB = process.platform === 'win32' ? 'D:\\work\\m2' : '/home/user/m2'
  const makeConfig = (home, deviceId, projectPath) => {
    const config = {
      ...defaultConfig(home),
      backend: 'folder',
      deviceId,
      repoDir: shared,
      profile: { enabled: false },
      workspace: { enabled: false },
    }
    config.projects = { alpha: { path: projectPath, title: 'alpha' } }
    return config
  }
  const configA = makeConfig(homeA, 'device-a', projectPathA)
  const configB = makeConfig(homeB, 'device-b', projectPathB)
  await saveConfig(homeA, configA)
  await saveConfig(homeB, configB)
  return { root, homeA, homeB, shared, configA, configB, projectPathA, projectPathB }
}

const mirrorDir = (config, id, projectId = 'alpha') => join(config.repoDir, 'sessions', projectId, id)
const quarantineDir = (config, id, projectId = 'alpha') => join(config.repoDir, 'sessions', projectId, '_deleted', id)
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

/** Родитель и трое детей: parent → child-a, child-b; child-a → grandchild. */
function familyIds() {
  return {
    parent: `session-${randomUUID()}`,
    childA: `session-${randomUUID()}`,
    childB: `session-${randomUUID()}`,
    grandchild: `session-${randomUUID()}`,
  }
}

async function writeFamily(home, cwd, ids) {
  await writeSession(home, cwd, ids.parent, makeLog(headerFor(cwd, ids.parent), [{ seq: 0 }]))
  await writeSession(home, cwd, ids.childA, makeLog(headerFor(cwd, ids.childA, ids.parent), [{ seq: 0 }]))
  await writeSession(home, cwd, ids.childB, makeLog(headerFor(cwd, ids.childB, ids.parent), [{ seq: 0 }]))
  await writeSession(home, cwd, ids.grandchild, makeLog(headerFor(cwd, ids.grandchild, ids.childA), [{ seq: 0 }]))
}

async function readArchiveStamps(home) {
  return readdir(join(home, 'dsh-sync', 'deleted')).catch(() => [])
}

// --- 1. единица обмена: группа уезжает и приезжает целиком ------------------

test('группа «родитель + 3 детей» уезжает и приезжает группой', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)

    const pushed = await push({ home: env.homeA, config: env.configA })
    assert.equal(pushed.pushed, 4, 'уехали все четыре сессии')
    assert.equal(pushed.groups, 1, 'это одна группа')
    assert.equal(pushed.children, 3, 'трое из них — дети')
    assert.equal(pushed.subagents, 3)
    assert.equal(pushed.orphans, 0, 'сирот нет: родитель на месте')
    assert.deepEqual(pushed.reasonCounts, { children: 3, orphan: 0 }, 'журнал причин в сводке')

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.imported, 4, 'группа приехала целиком')
    assert.equal(pulled.groups, 1)
    assert.equal(pulled.children, 3)
    assert.equal(pulled.orphans, 0)
    assert.deepEqual(pulled.reasonCounts, { children: 0, orphan: 0 })
    for (const id of Object.values(ids)) {
      assert.equal(
        existsSync(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd')),
        true,
        `на B есть ${id}`,
      )
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 2. удаление родителя убирает группу на втором устройстве ---------------

test('удаление родителя убирает детей на втором устройстве при pull', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    // Владелец удаляет группу локально и подтверждает удаление из зеркала.
    // Запрос — только id родителя: каскад группы достраивает детей сам.
    for (const id of Object.values(ids)) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }
    const pruned = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true, ids: [ids.parent] })
    assert.equal(pruned.removed, 4, 'в карантин ушла вся группа')
    assert.equal(pruned.groupsDeleted, 1)
    assert.equal(pruned.children, 3)
    assert.deepEqual(pruned.reasons.sort(), ['children', 'manual'])
    assert.deepEqual(pruned.reasonCounts, { children: 3, orphan: 0 })

    const marks = await readTombstones(env.configA.repoDir)
    assert.equal(marks.sessions[ids.parent].reason, 'manual')
    for (const childId of [ids.childA, ids.childB, ids.grandchild]) {
      assert.equal(marks.sessions[childId].reason, 'children', 'у ребёнка причина children')
    }

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted, 4, 'на B удалена вся группа')
    assert.equal(pulled.childrenDeleted, 3)
    assert.equal(pulled.groupsDeleted, 1, 'одна удалённая группа')
    assert.deepEqual(pulled.deletedReasons.sort(), ['children', 'manual'])
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, id)), false, `на B нет ${id}`)
      assert.equal(existsSync(quarantineDir(env.configB, id)), true, `карантин зеркала для ${id}`)
    }

    // Карантин на каждую сессию: отдельный каталог с причиной удаления.
    const stamps = await readArchiveStamps(env.homeB)
    assert.equal(stamps.length, 1, 'один прогон архива')
    const parentDeletedAt = await readJson(join(env.homeB, 'dsh-sync', 'deleted', stamps[0], encodeSegment(ids.parent), 'deleted-at.json'))
    const childDeletedAt = await readJson(join(env.homeB, 'dsh-sync', 'deleted', stamps[0], encodeSegment(ids.childB), 'deleted-at.json'))
    assert.equal(parentDeletedAt.reason, 'manual')
    assert.equal(childDeletedAt.reason, 'children')
    assert.equal(childDeletedAt.reasonLabel, 'удалено вместе с родителем')
    assert.equal(childDeletedAt.parent, ids.parent)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 3. «удаление везде» без воскрешения после reset -----------------------

test('resurrect не происходит после reset: метки повторно применяются к копиям зеркала', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    // Копии логов в зеркале — чтобы «сброс» вернул их байт-в-байт.
    const mirrorBytes = new Map()
    for (const id of Object.values(ids)) {
      mirrorBytes.set(id, await readFile(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd')))
    }

    for (const id of Object.values(ids)) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }
    await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    const first = await pull({ home: env.homeB, config: env.configB })
    assert.equal(first.deleted, 4, 'сначала B применил метки к своим копиям')

    // «Reset»: старое устройство снова отправило удалённые копии в зеркало.
    for (const [id, bytes] of mirrorBytes) {
      await mkdir(mirrorDir(env.configA, id), { recursive: true })
      await writeFile(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd'), bytes)
    }

    const second = await pull({ home: env.homeB, config: env.configB })
    assert.equal(second.imported, 0, 'удалённые копии не импортируются')
    assert.equal(second.childrenQuarantined, 3, 'дети удалённого родителя не приняты')
    assert.equal(second.reasonCounts.children, 3)
    assert.equal(second.reconciled?.removed, 4, 'воскресшие копии вернулись в карантин')
    assert.equal(second.reconciled?.groupsDeleted, 1)
    assert.equal(second.groupsDeleted, 1)
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(mirrorDir(env.configA, id)), false, `живой копии ${id} в зеркале нет`)
      assert.equal(existsSync(quarantineDir(env.configA, id)), true, `копия ${id} в карантине`)
      assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, id)), false, `на B нет ${id}`)
    }

    // Повторный приём идемпотентен: карантинить больше нечего.
    const third = await pull({ home: env.homeB, config: env.configB })
    assert.equal(third.imported, 0)
    assert.equal(third.reconciled?.removed ?? 0, 0, 'повторно ничего не удаляется')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 4. reconcile после сброса домашнего каталога --------------------------

test('reconcile: сброс домашнего каталога не воскрешает удалённые копии', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    for (const id of Object.values(ids)) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }
    await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    await pull({ home: env.homeB, config: env.configB })

    // «Сброс» домашнего каталога: копии вернулись из резервной копии.
    await writeFamily(env.homeB, env.projectPathB, ids)
    const reconciled = await reconcileLocalDeletions({ home: env.homeB, config: env.configB })
    assert.equal(reconciled.deleted, 4, 'активные метки применены повторно')
    assert.equal(reconciled.groupsDeleted, 1)
    assert.equal(reconciled.childrenDeleted, 3)
    assert.deepEqual(reconciled.reasons.sort(), ['children', 'manual'])
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, id)), false, `копия ${id} снова удалена`)
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 5. офлайн-удаление через outbox ---------------------------------------

test('офлайн-удаление группы: одна операция delete с ids[], повтор при flush', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    const groupIds = Object.values(ids)
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    // Группа разворачивается из id родителя: потомки входят в запрос.
    const childrenByParent = new Map([
      [ids.parent, [ids.childA, ids.childB].sort()],
      [ids.childA, [ids.grandchild]],
    ])
    const expanded = expandDeletionIds({ childrenByParent, ids: [ids.parent] })
    assert.deepEqual([...expanded.ids].sort(), groupIds.sort(), 'запрос расширен до группы')
    assert.equal(expanded.groups.length, 1)
    assert.equal(expanded.groups[0].size, 4)
    // Удаление ребёнка не поднимается вверх: родитель не затрагивается.
    assert.deepEqual(expandDeletionIds({ childrenByParent, ids: [ids.grandchild] }).ids, [ids.grandchild])

    // Сеть недоступна: удаление группы ложится в очередь одной операцией.
    await enqueueDelete(env.homeA, [ids.parent], { error: 'нет сети', errorKind: 'network' })
    const queued = await enqueueDelete(env.homeA, expanded.ids, { error: 'нет сети', errorKind: 'network' })
    assert.equal(queued.ids.length, 4, 'payload содержит ids[] всей группы')
    const operations = (await readOutbox(env.homeA)).operations.filter(operation => operation.type === 'delete')
    assert.equal(operations.length, 1, 'вторая постановка не размножает операцию')
    assert.deepEqual(deletePayloadIds(operations[0].payload).sort(), groupIds.sort())

    // Повтор, пока сеть лежит: операция остаётся и получает паузу.
    const offline = await flushOutbox(env.homeA, {
      handlers: { delete: async () => { throw new Error('сеть недоступна') } },
    })
    assert.equal(offline.flushed.length, 0)
    assert.equal((await outboxSummary(env.homeA)).count, 1, 'операция ждёт повтора')
    assert.equal(offline.failed.length, 1)

    // Сеть вернулась: операция применяется ко всей группе.
    for (const id of groupIds) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }
    const later = Date.now() + 120_000
    const flushed = await flushOutbox(env.homeA, {
      now: later,
      handlers: {
        delete: async (operation) => {
          const idsToDelete = deletePayloadIds(operation.payload)
          const result = await applyDeletions({
            home: env.homeA,
            config: env.configA,
            confirm: true,
            ids: idsToDelete,
          })
          return { ok: (result.removed ?? 0) > 0, message: result.message }
        },
      },
    })
    assert.equal(flushed.flushed.length, 1, 'операция выполнена при повторе')
    assert.equal((await outboxSummary(env.homeA)).count, 0, 'очередь пуста')

    for (const id of groupIds) {
      assert.equal(existsSync(quarantineDir(env.configA, id)), true, `карантин для ${id}`)
    }
    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted, 4, 'удаление доехало до второго устройства')
    assert.equal(pulled.childrenDeleted, 3)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 6. сирота: импортируется, но не удаляется -----------------------------

test('сирота импортируется с пометкой orphan и не удаляется', async () => {
  const env = await makeEnvironment()
  try {
    const parentId = `session-${randomUUID()}`
    const childId = `session-${randomUUID()}`
    // В зеркале только ребёнок: родителя нет вовсе.
    await mkdir(mirrorDir(env.configA, childId), { recursive: true })
    await writeFile(
      join(mirrorDir(env.configA, childId), 'session.v4.jsonl.zstd'),
      makeLog(headerFor(env.projectPathB, childId, parentId), [{ seq: 0 }]),
    )

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.imported, 1, 'сирота приехала, данные не потеряны')
    assert.equal(pulled.orphans, 1, 'в журнале причина orphan')
    assert.deepEqual(pulled.orphanIds, [childId])
    assert.deepEqual(pulled.importReasons, ['orphan'])
    assert.deepEqual(pulled.reasonCounts, { children: 0, orphan: 1 })
    assert.equal(
      existsSync(join(localSessionDir(env.homeB, env.projectPathB, childId), 'session.v4.jsonl.zstd')),
      true,
    )

    const pushed = await push({ home: env.homeB, config: env.configB })
    assert.equal(pushed.orphans, 1, 'отправка тоже видит сироту и не теряет её')
    assert.deepEqual(pushed.orphanIds, [childId])

    // Локальную копию убрали — ребёнок стал кандидатом, но без родителя его
    // защищают: удаление сироты сломало бы возможность восстановить группу.
    await rm(localSessionDir(env.homeB, env.projectPathB, childId), { recursive: true, force: true })
    const result = await applyDeletions({ home: env.homeB, config: env.configB, confirm: true })
    assert.equal(result.removed, 0, 'сироту не удаляем')
    assert.ok((result.orphansProtected ?? []).includes(childId), 'сирота в защищённых')
    assert.equal(result.orphans, 1)
    assert.ok((result.reasons ?? []).includes('orphan'), 'причина orphan в журнале')
    assert.deepEqual(result.reasonCounts, { children: 0, orphan: 1 })
    assert.equal(existsSync(join(mirrorDir(env.configA, childId), 'session.v4.jsonl.zstd')), true, 'копия в зеркале цела')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 7. сначала родитель, затем дети ---------------------------------------

test('ребёнок не импортируется раньше родителя: ждёт приезда, затем приезжает', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })

    // Родитель занят на B (lock) — ребёнок не должен приехать без него.
    const parentDirB = localSessionDir(env.homeB, env.projectPathB, ids.parent)
    await mkdir(parentDirB, { recursive: true })
    await writeFile(join(parentDirB, 'session.lock'), 'locked')

    const blocked = await pull({ home: env.homeB, config: env.configB })
    assert.equal(blocked.imported, 0, 'пока родителя нет, дети не приезжают')
    assert.equal(blocked.locked, 1)
    assert.equal(blocked.waitingParent, 3, 'дети ждут родителя')
    assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, ids.childA)), false, 'сирота не создана')

    // Блокировка снята — приезжает вся группа.
    await rm(join(parentDirB, 'session.lock'), { force: true })
    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.imported, 4, 'группа приехала вместе')
    assert.equal(pulled.groups, 1)
    assert.equal(pulled.waitingParent ?? 0, 0)
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd')), true)
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 8. чистые помощники: группы и сироты ----------------------------------

test('expandDeletionIds/orphanChildren: каскад группы, сирота и причины', () => {
  const parent = 'session-parent'
  const childA = 'session-child-a'
  const childB = 'session-child-b'
  const grandchild = 'session-grandchild'
  const childrenByParent = new Map([
    [parent, [childA, childB]],
    [childA, [grandchild]],
  ])
  const parentById = new Map([
    [childA, parent],
    [childB, parent],
    [grandchild, childA],
  ])

  const expanded = expandDeletionIds({ childrenByParent, ids: [parent] })
  assert.deepEqual(expanded.requested, [parent])
  assert.deepEqual([...expanded.ids].sort(), [grandchild, childA, childB, parent].sort())
  assert.deepEqual([...expanded.children].sort(), [grandchild, childA, childB].sort())
  assert.deepEqual(expanded.groups[0].children.slice().sort(), [grandchild, childA, childB].sort())

  // Короткий id приводится к каноническому, ребёнок не тянет родителя:
  // его собственное поддерево уходит вместе с ним.
  assert.deepEqual(
    expandDeletionIds({ childrenByParent, ids: ['child-a'] }).ids.sort(),
    ['session-child-a', 'session-grandchild'].sort(),
  )

  assert.deepEqual(
    orphanChildren({ parentById, present: new Set([childA, childB, grandchild]) }),
    [{ id: childA, parent }, { id: childB, parent }],
    'родитель отсутствует — оба его ребёнка сироты; у grandchild родитель на месте',
  )
  assert.deepEqual(orphanChildren({ parentById, present: new Set([parent, childA, childB, grandchild]) }), [])
  // Активная метка удаления сильнее защиты сироты.
  const tombstones = { sessions: {} }
  addTombstone(tombstones, childB, 'device-a', { reason: 'manual', by: 'owner' })
  assert.deepEqual(
    orphanChildren({ parentById, present: new Set([childA, childB, grandchild]), tombstones }).map(item => item.id),
    [childA],
    'метка удаления снимает orphan-защиту',
  )

  assert.equal(reasonLabel('children'), 'удалено вместе с родителем')
  assert.match(reasonLabel('orphan'), /сирота/)
})

// --- 9. метка удаления группы: parent+children -----------------------------

test('метка удаления на группу: parent+children и повторное применение после reset', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })

    // Ручная группа меток, как её пишет локальная команда удаления.
    const tombstones = await readTombstones(env.configA.repoDir)
    addTombstone(tombstones, ids.parent, 'device-a', { reason: 'manual', by: 'owner', size: 4 })
    for (const childId of [ids.childA, ids.childB, ids.grandchild]) {
      addTombstone(tombstones, childId, 'device-a', {
        reason: 'children',
        by: 'owner',
        parent: ids.parent,
        size: 4,
      })
    }
    await writeTombstones(env.configA.repoDir, tombstones)

    // «Сброс» на B: копии группы появились снова — метки применяются повторно.
    await writeFamily(env.homeB, env.projectPathB, ids)
    const reconciled = await reconcileLocalDeletions({ home: env.homeB, config: env.configB })
    assert.equal(reconciled.deleted, 4, 'группа удалена по меткам')
    assert.equal(reconciled.groupsDeleted, 1)
    assert.equal(reconciled.childrenDeleted, 3)
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, id)), false)
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
