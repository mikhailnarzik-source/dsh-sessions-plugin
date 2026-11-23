/**
 * Атомарная синхронизация группы «родитель + субагенты» (пункт 08#14).
 *
 * Проверяется единица обмена: родитель и дети уезжают и приезжают вместе;
 * отсутствующих локально детей не удаляют из зеркала (childrenMissing); prune
 * родителя требует подтверждения и уносит детей в карантин; удаление родителя
 * другой копией убирает и детей; в журнал пишутся sessions/subagents/
 * childrenMissing; режим «локальная» наследуется группой.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir, splitLog } from '../lib/store.mjs'
import { applyDeletions, pull, push } from '../lib/sync.mjs'
import { MODE_CLOUD, MODE_LOCAL, readSessionModes, setSessionMode } from '../lib/session-modes.mjs'
import { buildSessionGroups, descendantsOf, rootOf } from '../lib/session-groups.mjs'
import { recordRun, readHistory, removalDetails, subagentStats } from '../lib/history.mjs'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagents-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const shared = join(root, 'shared')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(shared, { recursive: true })
  const projectPathA = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const projectPathB = process.platform === 'win32' ? 'D:\\work\\alpha' : '/home/user/alpha'
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
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

/** Родитель и два субагента: родитель → ребёнок → внук. */
async function writeFamily(home, cwd, ids) {
  await writeSession(home, cwd, ids.parent, makeLog(headerFor(cwd, ids.parent), [{ seq: 0 }]))
  await writeSession(home, cwd, ids.child, makeLog(headerFor(cwd, ids.child, ids.parent), [{ seq: 0 }]))
  await writeSession(home, cwd, ids.grandchild, makeLog(headerFor(cwd, ids.grandchild, ids.child), [{ seq: 0 }]))
}

function familyIds() {
  return {
    parent: `session-${randomUUID()}`,
    child: `session-${randomUUID()}`,
    grandchild: `session-${randomUUID()}`,
  }
}

// --- единица обмена --------------------------------------------------------

test('push: родитель и субагенты уезжают вместе, связи и корень — в session.json', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)

    const summary = await push({ home: env.homeA, config: env.configA })
    assert.equal(summary.pushed, 3, 'уехали все три сессии одной отправкой')
    assert.equal(summary.sessions, 3)
    assert.equal(summary.subagents, 2, 'двое из них — субагенты')
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd')), true, `в зеркале есть ${id}`)
    }

    const parentSidecar = await readJson(join(mirrorDir(env.configA, ids.parent), 'session.json'))
    const childSidecar = await readJson(join(mirrorDir(env.configA, ids.child), 'session.json'))
    const grandchildSidecar = await readJson(join(mirrorDir(env.configA, ids.grandchild), 'session.json'))
    assert.equal(parentSidecar.parent, '')
    assert.deepEqual(parentSidecar.children, [ids.child])
    assert.equal(parentSidecar.root, ids.parent)
    assert.equal(childSidecar.parent, ids.parent)
    assert.deepEqual(childSidecar.children, [ids.grandchild])
    assert.equal(childSidecar.root, ids.parent)
    assert.equal(grandchildSidecar.parent, ids.child)
    assert.equal(grandchildSidecar.root, ids.parent)

    const index = await readFile(join(env.configA.repoDir, 'sessions', 'alpha', 'index.md'), 'utf8')
    assert.match(index, /субагент/)
    assert.match(index, /\+1/)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('push: ребёнка, которого нет локально, не удаляет из зеркала и не создаёт надгробий', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })

    // Локально удалили детей, родитель жив: детей нет, но родитель на месте.
    await rm(localSessionDir(env.homeA, env.projectPathA, ids.child), { recursive: true, force: true })
    await rm(localSessionDir(env.homeA, env.projectPathA, ids.grandchild), { recursive: true, force: true })
    const result = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })

    assert.equal(result.removed, 0, 'детей живого родителя не удаляем')
    assert.equal(result.childrenMissing.length, 2, 'оба ребёнка отмечены как отсутствующие локально')
    assert.ok(result.childrenMissing.includes(ids.child), 'ребёнок защищён')
    assert.ok(result.childrenMissing.includes(ids.grandchild), 'внук тоже защищён: он потомок живого родителя')
    assert.equal(existsSync(join(mirrorDir(env.configA, ids.child), 'session.v4.jsonl.zstd')), true, 'копия ребёнка в зеркале цела')
    assert.equal(existsSync(join(mirrorDir(env.configA, ids.grandchild), 'session.v4.jsonl.zstd')), true, 'копия внука цела')

    const tombstonesFile = join(env.configA.repoDir, 'tombstones.json')
    const tombstones = existsSync(tombstonesFile) ? await readJson(tombstonesFile) : { sessions: {} }
    assert.equal(tombstones.sessions[ids.child], undefined, 'надгробие ребёнку не создаётся')
    assert.equal(tombstones.sessions[ids.grandchild], undefined, 'надгробие внуку не создаётся')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('prune родителя требует подтверждения и уносит детей в карантин вместе', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })

    // Пользователь удалил группу локально (DSH удаляет субагентов вместе).
    for (const id of Object.values(ids)) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }

    const blocked = await push({ home: env.homeA, config: env.configA })
    assert.equal(blocked.removed, 0, 'без подтверждения ничего не удалено')
    assert.ok(blocked.requireConfirmation, 'есть запрос подтверждения')
    assert.equal(blocked.requireConfirmation.subagents, 2, 'в отчёте видно число субагентов')
    assert.equal(blocked.requireConfirmation.size, 3)
    assert.equal(blocked.requireConfirmation.groups[0].parent, ids.parent)
    assert.deepEqual(blocked.requireConfirmation.groups[0].children.sort(), [ids.child, ids.grandchild].sort())
    assert.match(blocked.warning ?? '', /субагент/)
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd')), true, 'зеркало не тронуто')
    }

    const confirmed = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(confirmed.removed, 3, 'родитель и двое детей ушли в карантин')
    assert.equal(confirmed.childrenQuarantined, 2)
    assert.match(confirmed.removedReason ?? '', /вместе с родителем/)
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(quarantineDir(env.configA, id)), true, `карантин для ${id}`)
      assert.equal(existsSync(join(mirrorDir(env.configA, id))), false, `живой копии ${id} нет`)
    }

    const parentDeletedAt = await readJson(join(quarantineDir(env.configA, ids.parent), 'deleted-at.json'))
    const childDeletedAt = await readJson(join(quarantineDir(env.configA, ids.child), 'deleted-at.json'))
    assert.equal(parentDeletedAt.reason, 'manual')
    assert.equal(parentDeletedAt.size, 3, 'size — вся группа')
    assert.equal(childDeletedAt.reason, 'children')
    assert.equal(childDeletedAt.parent, ids.parent)
    assert.equal(childDeletedAt.reasonLabel, 'удалено вместе с родителем')
    assert.equal(childDeletedAt.size, 3)

    const tombstones = await readJson(join(env.configA.repoDir, 'tombstones.json'))
    assert.equal(tombstones.sessions[ids.parent].reason, 'manual')
    assert.equal(tombstones.sessions[ids.child].reason, 'children')
    assert.equal(tombstones.sessions[ids.child].parent, ids.parent)
    assert.equal(tombstones.sessions[ids.grandchild].parent, ids.child, 'у внука ссылка на своего родителя')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('пул: осиротевшего субагента без родителя в зеркале не удаляют', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })

    // Родитель исчез из зеркала (старое устройство удалило его без метки),
    // локально тоже удалены все: ребёнок в зеркале остаётся сиротой.
    await rm(mirrorDir(env.configA, ids.parent), { recursive: true, force: true })
    for (const id of Object.values(ids)) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }
    const result = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(result.removed, 0, 'осиротевшую копию без родителя не удаляем')
    assert.ok((result.orphansProtected ?? []).includes(ids.child), 'ребёнок защищён как сирота')
    assert.equal(existsSync(join(mirrorDir(env.configA, ids.child), 'session.v4.jsonl.zstd')), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('явная метка удаления ребёнка сильнее защиты детей живого родителя', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })

    // Пользователь удалил только ребёнка: своя метка manual у ребёнка, родитель жив.
    await rm(localSessionDir(env.homeA, env.projectPathA, ids.child), { recursive: true, force: true })
    await writeFile(join(env.configA.repoDir, 'tombstones.json'), JSON.stringify({
      version: 2,
      sessions: {
        [ids.child]: { at: new Date().toISOString(), device: 'device-a', reason: 'manual', by: 'owner' },
      },
    }))
    const result = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(result.removed, 1, 'ребёнка с явной меткой удаляем')
    assert.deepEqual(result.removedIds, [ids.child])
    assert.equal((result.childrenMissing ?? []).length, 0, 'явная метка отменяет защиту childrenMissing')
    assert.equal(existsSync(join(mirrorDir(env.configA, ids.parent), 'session.v4.jsonl.zstd')), true, 'родитель остаётся')
    assert.equal(existsSync(quarantineDir(env.configA, ids.child)), true, 'ребёнок в карантине')
    assert.equal(existsSync(join(mirrorDir(env.configA, ids.child))), false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- приём -----------------------------------------------------------------

test('pull: родитель и субагенты приезжают вместе, ребёнок не теряется с приехавшим родителем', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })

    const first = await pull({ home: env.homeB, config: env.configB })
    assert.equal(first.imported, 3, 'приехала вся группа')
    assert.equal(first.subagents, 2)
    assert.equal(first.sessions, 3)
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd')), true, `на B есть ${id}`)
    }

    // На B ребёнок исчез локально и попал в «ожидание удаления», но родитель
    // приезжает заново — ребёнок не должен потеряться.
    for (const id of Object.values(ids)) {
      await rm(localSessionDir(env.homeB, env.projectPathB, id), { recursive: true, force: true })
    }
    await writeFile(
      join(env.homeB, 'dsh-sync', 'state.json'),
      `${JSON.stringify({ version: 1, projects: { alpha: [ids.child, ids.grandchild] } }, null, 2)}\n`,
      'utf8',
    )
    const second = await pull({ home: env.homeB, config: env.configB })
    assert.equal(second.imported, 3, 'родитель и дети приехали вместе')
    assert.equal(second.pendingDeletion ?? 0, 0, 'ребёнок не остался в ожидании удаления')
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd')), true, `на B снова есть ${id}`)
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: метка родителя уносит локальных субагентов в архив', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    // A удаляет группу: метки родителя (manual) и детей (children) уезжают.
    for (const id of Object.values(ids)) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }
    await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })

    const result = await pull({ home: env.homeB, config: env.configB })
    assert.equal(result.deleted, 3, 'группа удалена на B целиком')
    assert.equal(result.childrenDeleted, 2)
    assert.equal((result.childrenMissing ?? []).length, 0, 'потерянных детей нет')
    for (const id of Object.values(ids)) {
      assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, id)), false, `на B нет ${id}`)
    }
    const archiveRoot = join(env.homeB, 'dsh-sync', 'deleted')
    assert.equal(existsSync(archiveRoot), true, 'архив удалённых создан')
    const details = result.deletedDetails ?? []
    assert.equal(details.length, 3)
    const children = details.filter(item => item.reason === 'children')
    assert.equal(children.length, 2, 'дети удалены по метке «вместе с родителем»')
    assert.equal(children[0].parent !== undefined, true, 'у метки ребёнка есть ссылка на родителя')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: старая метка только родителя всё равно уносит детей (наследование)', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    // Зеркало с группой и единственной старинной меткой родителя.
    await writeSession(env.homeA, env.projectPathA, ids.parent, makeLog(headerFor(env.projectPathA, ids.parent), [{ seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })
    await writeSession(env.homeA, env.projectPathA, ids.child, makeLog(headerFor(env.projectPathA, ids.child, ids.parent), [{ seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })
    await writeFile(join(env.configA.repoDir, 'tombstones.json'), JSON.stringify({
      version: 2,
      sessions: { [ids.parent]: { at: new Date().toISOString(), device: 'device-x', reason: 'manual', by: 'owner' } },
    }))

    // B уже имеет обе сессии локально.
    await writeSession(env.homeB, env.projectPathB, ids.parent, makeLog(headerFor(env.projectPathB, ids.parent), [{ seq: 0 }]))
    await writeSession(env.homeB, env.projectPathB, ids.child, makeLog(headerFor(env.projectPathB, ids.child, ids.parent), [{ seq: 0 }]))

    const result = await pull({ home: env.homeB, config: env.configB })
    assert.equal(result.deleted, 2, 'родитель и ребёнок удалены вместе')
    assert.equal(result.childrenDeleted, 1)
    assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, ids.parent)), false)
    assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, ids.child)), false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- журнал и панель -------------------------------------------------------

test('журнал: sessions/subagents/childrenMissing пишутся в history.jsonl', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)
    const pushed = await push({ home: env.homeA, config: env.configA })
    const stats = subagentStats({ push: pushed })
    assert.equal(stats.sessions, 3)
    assert.equal(stats.subagents, 2)
    assert.deepEqual(stats.childrenMissing, [])

    // Потерянный ребёнок попадает в журнал отдельным полем.
    await recordRun(env.homeA, {
      ok: true,
      at: new Date().toISOString(),
      action: 'push',
      ...subagentStats({
        push: { sessions: 1, subagents: 0, childrenMissing: [ids.child] },
        pull: { sessions: 2, subagents: 1 },
      }),
    })
    const history = await readHistory(env.homeA, 1)
    const last = history[history.length - 1]
    assert.equal(last.sessions, 3)
    assert.equal(last.subagents, 1)
    assert.deepEqual(last.childrenMissing, [ids.child])
    const raw = await readFile(join(env.homeA, 'dsh-sync', 'history.jsonl'), 'utf8')
    assert.ok(raw.includes('"subagents"'), 'в файле есть subagents')
    assert.ok(raw.includes('"childrenMissing"'), 'в файле есть childrenMissing')

    // Причина «вместе с родителем» попадает в общий список причин удаления.
    const removal = removalDetails({ push: { removedDetails: [{ id: ids.child, reason: 'children', by: 'owner' }] } })
    assert.ok(removal.reasons.includes('children'))
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- режимы и помощники ----------------------------------------------------

test('режимы: локальный родитель удерживает детей, переключение уносит группу', async () => {
  const env = await makeEnvironment()
  try {
    const ids = familyIds()
    await writeFamily(env.homeA, env.projectPathA, ids)

    const localSessions = [
      { id: ids.parent },
      { id: ids.child },
      { id: ids.grandchild },
    ]
    const groups = buildSessionGroups(
      await Promise.all(localSessions.map(async (session) => {
        const bytes = await readFile(join(localSessionDir(env.homeA, env.projectPathA, session.id), 'session.v4.jsonl.zstd'))
        return { id: session.id, header: splitLog(bytes).header }
      })),
    )
    assert.deepEqual(descendantsOf(groups.childrenByParent, ids.parent).sort(), [ids.child, ids.grandchild].sort())
    assert.equal(rootOf(groups.parentById, ids.grandchild), ids.parent)

    // Переключили только родителя — в локальные ушли и дети.
    const switched = await setSessionMode(env.homeA, [ids.parent], MODE_LOCAL, { groups })
    assert.equal(switched.changed, 3)
    assert.equal(switched.expanded, 2)
    const modes = await readSessionModes(env.homeA)
    assert.equal(modes.sessions[ids.parent], MODE_LOCAL)
    assert.equal(modes.sessions[ids.child], MODE_LOCAL)
    assert.equal(modes.sessions[ids.grandchild], MODE_LOCAL)

    const localPush = await push({ home: env.homeA, config: env.configA })
    assert.equal(localPush.pushed, 0, 'локальная группа не уходит в зеркало')
    assert.equal(localPush.localSkipped, 3)

    // Вернули родителя в облако — уезжает вся группа.
    await setSessionMode(env.homeA, [ids.parent], MODE_CLOUD, { groups })
    const cloudPush = await push({ home: env.homeA, config: env.configA })
    assert.equal(cloudPush.pushed, 3)
    assert.equal(cloudPush.subagents, 2)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
