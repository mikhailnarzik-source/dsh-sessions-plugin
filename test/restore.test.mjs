/**
 * Метки удаления и восстановление: reason/by в надгробиях и журнале, список
 * «Удалённые», восстановление одной сессии и всех, снятие надгробия и то, что
 * восстановленная сессия не удаляется повторной автоочисткой.
 *
 * Запуск: node --test test/restore.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir, splitLog } from '../lib/store.mjs'
import { applyDeletions, pull, push } from '../lib/sync.mjs'
import { readHistory, recordRun, removalDetails } from '../lib/history.mjs'
import {
  QUARANTINE_DAYS,
  addTombstone,
  isActiveTombstone,
  listTombstones,
  readTombstones,
  restoreTombstones,
  writeTombstones,
} from '../lib/tombstones.mjs'

// --- helpers ---------------------------------------------------------------

function makeLog(header, events = []) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function headerFor(cwd, id = `session-${randomUUID()}`) {
  return { type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 }
}

/** Событие с первым сообщением: из него каталог зеркала берёт название. */
function titleEvent(title) {
  return { type: 'user/message', data: { content: [{ type: 'text', text: title }] } }
}

async function writeSession(home, cwd, id, title = `Сессия ${id.slice(-4)}`) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), makeLog(headerFor(cwd, id), [titleEvent(title), { seq: 0 }]))
  return dir
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-restore-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const shared = join(root, 'shared')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(shared, { recursive: true })
  const projectPathA = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const projectPathB = process.platform === 'win32' ? 'D:\\work\\alpha' : '/home/user/alpha'
  const configA = { ...defaultConfig(homeA), backend: 'folder', deviceId: 'device-a', repoDir: shared, profile: { enabled: false }, workspace: { enabled: false } }
  configA.projects = { alpha: { path: projectPathA, title: 'alpha' } }
  const configB = { ...defaultConfig(homeB), backend: 'folder', deviceId: 'device-b', repoDir: shared, profile: { enabled: false }, workspace: { enabled: false } }
  configB.projects = { alpha: { path: projectPathB, title: 'alpha' } }
  await saveConfig(homeA, configA)
  await saveConfig(homeB, configB)
  return { root, homeA, homeB, shared, configA, configB, projectPathA, projectPathB }
}

const mirrorDir = (config, id) => join(config.repoDir, 'sessions', 'alpha', id)
const quarantineDir = (config, id) => join(config.repoDir, 'sessions', 'alpha', '_deleted', id)

/** Записать надгробие так, как это делает плагин удаления из панели. */
async function writeManualTombstone(repoDir, id, extra = {}) {
  const data = await readTombstones(repoDir)
  addTombstone(data, id, 'device-owner', { reason: 'manual', by: 'owner', projectId: 'alpha', ...extra })
  await writeTombstones(repoDir, data)
}

// --- 1. метки при удалении -------------------------------------------------

test('подтверждённое удаление пишет reason=manual/by=owner с size, старое поле prune не используется', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let index = 0; index < 10; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.homeA, env.projectPathA, id, `Диалог ${index}`)
    }
    await push({ home: env.homeA, config: env.configA })

    // Push удаления не выполняет: одна удалённая из десяти только ждёт
    // подтверждения (раньше проходила сразу как «ниже порога»).
    await rm(localSessionDir(env.homeA, env.projectPathA, ids[0]), { recursive: true, force: true })
    const pending = await push({ home: env.homeA, config: env.configA })
    assert.equal(pending.removed, 0, 'push ничего не удалил')
    assert.equal(pending.skippedDeletions.removed, 1)

    const pruned = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(pruned.removed, 1)
    assert.deepEqual(pruned.removedReasons, ['manual'], 'удаление помечено ручным')
    assert.deepEqual(pruned.removedBy, ['owner'], 'автор — пользователь')
    assert.deepEqual(pruned.removedDetails, [{ id: ids[0], reason: 'manual', by: 'owner' }])

    const afterPrune = await readTombstones(env.configA.repoDir)
    const prunedEntry = afterPrune.sessions[ids[0]]
    assert.equal(prunedEntry.reason, 'manual')
    assert.equal(prunedEntry.by, 'owner')
    assert.equal(typeof prunedEntry.at, 'string')
    assert.equal(prunedEntry.device, 'device-a')
    assert.equal(prunedEntry.title, 'Диалог 0', 'название сохранено для панели')
    assert.ok(prunedEntry.bytes > 0, 'объём удалённого лога сохранён')
    assert.equal(prunedEntry.size, 1, 'в метке есть размер пачки')
    assert.equal(isActiveTombstone(prunedEntry), true)

    const deletedAt = JSON.parse(await readFile(join(quarantineDir(env.configA, ids[0]), 'deleted-at.json'), 'utf8'))
    assert.equal(deletedAt.reason, 'manual')
    assert.equal(deletedAt.by, 'owner')
    assert.equal(deletedAt.device, 'device-a')
    assert.equal(deletedAt.reasonLabel, 'удалено локально', 'человекочитаемая причина сохранена')

    // Три удаления из девяти известных — подтверждённая пачка.
    for (const id of ids.slice(1, 4)) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }
    const blocked = await push({ home: env.homeA, config: env.configA })
    assert.equal(blocked.removed, 0)
    assert.equal(blocked.skippedDeletions.removed, 3)
    assert.equal(blocked.skippedDeletions.overRatio, true, '3 из 9 — выше доли')

    const confirmed = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(confirmed.removed, 3)
    assert.deepEqual(confirmed.removedReasons, ['manual'], 'подтверждённая пачка — ручное удаление')
    assert.deepEqual(confirmed.removedBy, ['owner'], 'автор — пользователь')

    const afterManual = await readTombstones(env.configA.repoDir)
    for (const id of ids.slice(1, 4)) {
      assert.equal(afterManual.sessions[id].reason, 'manual')
      assert.equal(afterManual.sessions[id].by, 'owner')
      assert.equal(afterManual.sessions[id].size, 3, 'в метке есть размер пачки')
    }

    // Список удалённых: название, причина, автор, срок карантина.
    const listed = await listTombstones({ home: env.homeA, repoDir: env.configA.repoDir, projects: env.configA.projects })
    assert.equal(listed.length, 4)
    const manualRow = listed.find(entry => entry.id === ids[1])
    assert.equal(manualRow.title, 'Диалог 1')
    assert.equal(manualRow.reason, 'manual')
    assert.equal(manualRow.by, 'owner')
    assert.equal(manualRow.quarantined, true)
    assert.equal(manualRow.canRestore, true)
    assert.equal(manualRow.remainingDays, QUARANTINE_DAYS, 'карантин — 30 дней')
    assert.equal(typeof manualRow.expiresAt, 'string')
    assert.equal(listed.every(entry => entry.projectId === 'alpha'), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 1б. замена карантинной копии ------------------------------------------

test('повторное удаление заменяет старую карантинную копию: replaced и код в журнале', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let index = 0; index < 10; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.homeA, env.projectPathA, id, `Сессия ${index}`)
    }
    await push({ home: env.homeA, config: env.configA })
    const id = ids[0]

    // Первое удаление: карантинная копия уже заняла место.
    await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(existsSync(quarantineDir(env.configA, id)), true)

    // Сессия «вернулась» на устройство и снова ушла в зеркало (метка снята).
    await writeSession(env.homeA, env.projectPathA, id, 'Сессия 0 — снова')
    await push({ home: env.homeA, config: env.configA })

    // Удаляем её ещё раз: старая карантинная копия того же id заменяется.
    await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    await push({ home: env.homeA, config: env.configA })
    const replaced = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(replaced.removed, 1)
    assert.equal(replaced.replaced, 1, 'замена карантина посчитана')
    assert.deepEqual(replaced.replacedIds, [id])
    const data = await readTombstones(env.configA.repoDir)
    assert.equal(data.sessions[id].replaced, true, 'в метке есть флаг замены')
    const removal = removalDetails({ push: replaced })
    assert.ok(removal.reasons.includes('replaced'), 'код replaced попадает в журнал')
    assert.ok(removal.by.includes('owner'))
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 2. pull: причины удаления и снятые метки ------------------------------

test('pull: удаление по метке пишет reasons/by, метка restored не удаляет копию', async () => {
  const env = await makeEnvironment()
  try {
    const keepId = `session-${randomUUID()}`
    const deletedId = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, keepId, 'Оставить')
    await writeSession(env.homeA, env.projectPathA, deletedId, 'Удалить')
    await push({ home: env.homeA, config: env.configA })
    const imported = await pull({ home: env.homeB, config: env.configB })
    assert.equal(imported.imported, 2)

    const tombstones = await readTombstones(env.configA.repoDir)
    addTombstone(tombstones, deletedId, 'device-owner', { reason: 'manual', by: 'owner', projectId: 'alpha' })
    // Снятая метка: сессию вернули, и приём не должен её удалять.
    addTombstone(tombstones, keepId, 'device-owner', { reason: 'manual', by: 'owner', projectId: 'alpha' })
    tombstones.sessions[keepId].reason = 'restored'
    await writeTombstones(env.configA.repoDir, tombstones)

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.deleted, 1, 'удалена только действующая метка')
    assert.deepEqual(pulled.deletedIds, [deletedId])
    assert.deepEqual(pulled.deletedReasons, ['manual'])
    assert.deepEqual(pulled.deletedBy, ['owner'])
    assert.deepEqual(pulled.deletedDetails, [{ id: deletedId, reason: 'manual', by: 'owner' }])
    assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, deletedId)), false, 'удалённая копия ушла')
    assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, keepId)), true, 'restored-метка ничего не удалила')
    const archives = await readdir(join(env.homeB, 'dsh-sync', 'deleted'))
    assert.ok(archives.length > 0, 'копия удалённой сессии лежит в локальном архиве')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('git: ручная метка удаления не затирается fetch+reset — reason остаётся manual/owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-restore-git-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const mirror = join(root, 'mirror')
  const bare = join(root, 'remote.git')
  try {
    await mkdir(home, { recursive: true })
    await mkdir(project, { recursive: true })
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' })
    const config = {
      backend: 'git',
      branch: 'main',
      remote: bare,
      repoDir: mirror,
      deviceId: 'device-git',
      attachments: false,
      profile: { enabled: false },
      workspace: { enabled: false },
      projects: { p: { id: 'p', title: 'p', path: project } },
    }
    await saveConfig(home, config)

    const ids = []
    for (let index = 0; index < 10; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(home, project, id, `Диалог ${index}`)
    }
    await push({ home, config })

    // Панельное удаление: локальная копия убрана, метка записана в зеркало,
    // но ещё не закоммичена. Фоновый приём перед отправкой делает fetch+reset
    // и раньше затирал бы её.
    const id = ids[0]
    await rm(localSessionDir(home, project, id), { recursive: true, force: true })
    await writeManualTombstone(mirror, id, { projectId: 'p' })
    await pull({ home, config })
    let data = await readTombstones(mirror)
    assert.equal(data.sessions[id]?.reason, 'manual', 'метка пережила приём')
    assert.equal(data.sessions[id]?.by, 'owner')

    const pushed = await push({ home, config })
    assert.equal(pushed.removed, 0, 'push сам ничего не удаляет')
    assert.equal(pushed.skippedDeletions.removed, 1)
    const pruned = await applyDeletions({ home, config, confirm: true })
    assert.equal(pruned.removed, 1)
    assert.deepEqual(pruned.removedReasons, ['manual'], 'подтверждённое удаление сохранило ручную причину')
    assert.deepEqual(pruned.removedBy, ['owner'])
    data = await readTombstones(mirror)
    assert.equal(data.sessions[id].reason, 'manual')
    assert.equal(data.sessions[id].by, 'owner')
    assert.equal(existsSync(join(mirror, 'sessions', 'p', '_deleted', id, 'session.v4.jsonl.zstd')), true, 'копия в карантине')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- 3. восстановление одной сессии ---------------------------------------

test('restore одной сессии: карантин зеркала и локальная копия возвращаются, метка restored', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let index = 0; index < 10; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.homeA, env.projectPathA, id, `Восстановить ${index}`)
    }
    await push({ home: env.homeA, config: env.configA })

    const id = ids[0]
    await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(existsSync(join(quarantineDir(env.configA, id), 'session.v4.jsonl.zstd')), true, 'копия в карантине')
    assert.equal(existsSync(mirrorDir(env.configA, id)), false, 'в зеркале её нет')

    const result = await restoreTombstones({
      home: env.homeA,
      repoDir: env.configA.repoDir,
      projects: env.configA.projects,
      ids: [id],
      deviceId: 'device-a',
    })
    assert.equal(result.restored.length, 1)
    assert.equal(result.restored[0].mirror, true, 'копия вернулась в зеркало')
    assert.equal(result.restored[0].local, true, 'копия вернулась на устройство')
    assert.equal(existsSync(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd')), true)
    assert.equal(existsSync(join(mirrorDir(env.configA, id), 'deleted-at.json')), false, 'отметка карантина убрана')
    const mirrorLog = await readFile(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd'))
    assert.equal(splitLog(mirrorLog).header.cwd, '/dsh-sync/projects/alpha', 'нейтральный путь зеркала')
    const localLog = await readFile(join(localSessionDir(env.homeA, env.projectPathA, id), 'session.v4.jsonl.zstd'))
    assert.equal(splitLog(localLog).header.cwd, env.projectPathA, 'заголовок локальной копии — локальный путь')

    const restoredData = await readTombstones(env.configA.repoDir)
    assert.equal(restoredData.sessions[id].reason, 'restored', 'надгробие помечено restored')
    assert.equal(restoredData.sessions[id].by, 'owner')
    assert.equal(restoredData.sessions[id].restoredFrom, 'manual', 'метка помнит ручное удаление')
    assert.equal(isActiveTombstone(restoredData.sessions[id]), false, 'снятая метка не действует')
    assert.equal((await listTombstones({ home: env.homeA, repoDir: env.configA.repoDir, projects: env.configA.projects })).length, 0, 'снятая метка в списке не остаётся')

    // Повторная отправка не удаляет восстановленную сессию.
    const afterRestore = await push({ home: env.homeA, config: env.configA })
    assert.equal(afterRestore.removed, 0, 'повторный prune ничего не удалил')
    assert.equal(existsSync(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd')), true, 'сессия осталась в зеркале')
    const cleaned = await readTombstones(env.configA.repoDir)
    assert.equal(cleaned.sessions[id], undefined, 'историческая метка вычищена отправкой')

    // Другое устройство принимает восстановленную сессию.
    const pulledB = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulledB.imported, 10, 'на втором устройстве все сессии, включая восстановленную')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 4. восстановить всё ---------------------------------------------------

test('restore всех: возвращаются карантинные копии и локальные, список пустеет', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let index = 0; index < 3; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.homeA, env.projectPathA, id, `Сессия ${index}`)
    }
    await push({ home: env.homeA, config: env.configA })
    for (const id of ids.slice(0, 2)) {
      await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    }
    const removed = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(removed.removed, 2)

    const result = await restoreTombstones({
      home: env.homeA,
      repoDir: env.configA.repoDir,
      projects: env.configA.projects,
      deviceId: 'device-a',
    })
    assert.equal(result.restored.length, 2, 'восстановлены обе удалённые сессии')
    assert.equal(result.mirror, 2)
    assert.equal(result.local, 2, 'локальные копии тоже вернулись')
    for (const id of ids.slice(0, 2)) {
      assert.equal(existsSync(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd')), true)
      assert.equal(existsSync(join(localSessionDir(env.homeA, env.projectPathA, id), 'session.v4.jsonl.zstd')), true)
    }
    assert.deepEqual(
      await listTombstones({ home: env.homeA, repoDir: env.configA.repoDir, projects: env.configA.projects }),
      [],
      'в списке удалённых пусто',
    )

    const again = await restoreTombstones({ home: env.homeA, repoDir: env.configA.repoDir, projects: env.configA.projects })
    assert.equal(again.restored.length, 0, 'повторно восстанавливать нечего')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 5. локальный карантин другого устройства ------------------------------

test('restore возвращает локальную копию из архива устройства и она снова уезжает в зеркало', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, id, 'Общая сессия')
    await push({ home: env.homeA, config: env.configA })
    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.imported, 1)

    // Удаление пришло с другого устройства: сессия уже убрана из зеркала,
    // метка лежит в зеркале — B переносит локальную копию в свой архив.
    await rm(mirrorDir(env.configA, id), { recursive: true, force: true })
    await writeManualTombstone(env.configA.repoDir, id)
    const deletedOnB = await pull({ home: env.homeB, config: env.configB })
    assert.equal(deletedOnB.deleted, 1)
    assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, id)), false)
    const archiveRoot = join(env.homeB, 'dsh-sync', 'deleted')
    const stamps = await readdir(archiveRoot)
    assert.ok(stamps.length > 0, 'копия B в локальном архиве')

    const restored = await restoreTombstones({
      home: env.homeB,
      repoDir: env.configB.repoDir,
      projects: env.configB.projects,
      ids: [id],
      deviceId: 'device-b',
    })
    assert.equal(restored.restored.length, 1)
    assert.equal(restored.restored[0].local, true, 'локальная копия вернулась из архива')
    assert.equal(restored.restored[0].mirror, false, 'в зеркале копии пока нет')
    const localLog = await readFile(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd'))
    assert.equal(splitLog(localLog).header.cwd, env.projectPathB)

    // Отправка с B возвращает сессию в зеркало и снимает историческую метку.
    const pushed = await push({ home: env.homeB, config: env.configB })
    assert.equal(pushed.pushed, 1)
    assert.equal(existsSync(join(mirrorDir(env.configA, id), 'session.v4.jsonl.zstd')), true, 'сессия снова в зеркале')
    const data = await readTombstones(env.configB.repoDir)
    assert.equal(data.sessions[id], undefined)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 6. истёкший карантин --------------------------------------------------

test('истёкший карантин: метка reason=expired, восстановить нельзя, журнал знает причину', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let index = 0; index < 10; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.homeA, env.projectPathA, id, `Сессия ${index}`)
    }
    await push({ home: env.homeA, config: env.configA })
    const id = ids[0]
    await rm(localSessionDir(env.homeA, env.projectPathA, id), { recursive: true, force: true })
    await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    const quarantine = quarantineDir(env.configA, id)
    assert.equal(existsSync(quarantine), true)

    // Состариваем карантин на 40 дней.
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString()
    await writeFile(join(quarantine, 'deleted-at.json'), `${JSON.stringify({ at: old, reason: 'manual', by: 'owner' })}\n`, 'utf8')

    const purged = await push({ home: env.homeA, config: env.configA })
    assert.equal(purged.quarantinePurged, 1, 'карантин вычищен')
    assert.deepEqual(purged.quarantinePurgedIds, [id])
    assert.equal(existsSync(quarantine), false)

    const data = await readTombstones(env.configA.repoDir)
    assert.equal(data.sessions[id].reason, 'expired', 'метка знает, что срок истёк')
    assert.equal(data.sessions[id].by, 'sync')

    const listed = await listTombstones({ home: env.homeA, repoDir: env.configA.repoDir, projects: env.configA.projects })
    const row = listed.find(entry => entry.id === id)
    assert.equal(row.expired, true)
    assert.equal(row.canRestore, false, 'истёкшую сессию вернуть нельзя')
    assert.equal(row.remainingDays, 0)

    const restored = await restoreTombstones({
      home: env.homeA,
      repoDir: env.configA.repoDir,
      projects: env.configA.projects,
      ids: [id],
    })
    assert.equal(restored.restored.length, 0)
    assert.deepEqual(restored.skipped, [id])

    // Журнал: причины и авторы удаления включают expired/sync.
    const removal = removalDetails({ push: purged })
    assert.ok(removal.reasons.includes('expired'))
    assert.ok(removal.by.includes('sync'))
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 7. журнал -------------------------------------------------------------

test('журнал запусков хранит reasons/by рядом с removed и removedIds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-history-'))
  try {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    await recordRun(home, {
      ok: true,
      at: new Date().toISOString(),
      action: 'push',
      message: 'тест',
      removed: 2,
      removedIds: ['session-a', 'session-b'],
      removedReason: 'удалено локально',
      reasons: ['manual', 'expired'],
      by: ['owner', 'sync'],
      removedDetails: [
        { id: 'session-a', reason: 'manual', by: 'owner' },
        { id: 'session-b', reason: 'prune', by: 'sync' },
      ],
    })
    const history = await readHistory(home, 5)
    const last = history[history.length - 1]
    assert.equal(last.removed, 2)
    assert.deepEqual(last.removedIds, ['session-a', 'session-b'])
    assert.deepEqual(last.reasons, ['manual', 'expired'])
    assert.deepEqual(last.by, ['owner', 'sync'])
    assert.deepEqual(last.removedDetails[0], { id: 'session-a', reason: 'manual', by: 'owner' })
    const raw = await readFile(join(home, 'dsh-sync', 'history.jsonl'), 'utf8')
    assert.ok(raw.includes('"reasons"'), 'в файле журнала есть reasons')
    assert.ok(raw.includes('"by"'), 'в файле журнала есть by')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- 7б. удаление из панели ------------------------------------------------

test('удаление из панели пишет метку manual/owner с названием сессии', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-panel-delete-'))
  const home = join(root, 'home')
  const mirror = join(root, 'mirror')
  const projectPath = process.platform === 'win32' ? 'C:\\work\\panel' : '/work/panel'
  const sessionId = `session-${randomUUID()}`
  const previousHome = process.env.DSH_HOME
  try {
    await mkdir(home, { recursive: true })
    await mkdir(mirror, { recursive: true })
    const config = {
      ...defaultConfig(home),
      backend: 'git',
      remote: 'https://example.invalid/dsh-sessions.git',
      repoDir: mirror,
      deviceId: 'device-panel',
      profile: { enabled: false },
      workspace: { enabled: false },
    }
    config.projects = { alpha: { path: projectPath, title: 'alpha' } }
    await saveConfig(home, config)
    // Лог сессии, который плагин удаления стирает вместе с проекцией.
    const logDir = join(root, 'store', 'session')
    await mkdir(logDir, { recursive: true })
    const logPath = join(logDir, 'session.v4.jsonl.zstd')
    await writeFile(logPath, makeLog(headerFor(projectPath, sessionId)))

    process.env.DSH_HOME = home
    const { apply } = await import('../delete/index.js')
    const routes = new Map()
    const ctx = {
      effect: () => {},
      connection: { fetch: { register: (route) => routes.set(route.path, route) } },
      sessionPersistence: {
        stat: async (id) => (id === sessionId
          ? { header: { id, cwd: projectPath }, location: { path: logPath } }
          : undefined),
      },
      workspaceRegistry: {
        list: () => [],
        unpinSession: async () => true,
        unarchiveSession: async () => true,
        delete: async () => true,
      },
      get: (name) => (name === 'sessionQuery'
        ? { readTitle: async () => ({ title: 'Панельная сессия' }) }
        : undefined),
    }
    apply(ctx)
    const call = async (path, payload) => {
      const response = await routes.get(path).fetch(new Request(`http://local${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      }))
      return { status: response.status, body: await response.json() }
    }
    const deleted = await call('/api/session-delete/delete', { sessionId, confirm: 'delete' })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.ok, true)
    assert.equal(deleted.body.markedInMirror, true, 'пометка в зеркале записана')

    const data = await readTombstones(mirror)
    const entry = data.sessions[sessionId]
    assert.ok(entry, 'надгробие создано')
    assert.equal(entry.reason, 'manual', 'причина — ручное удаление')
    assert.equal(entry.by, 'owner', 'автор — пользователь')
    assert.equal(entry.device, 'device-panel')
    assert.equal(entry.title, 'Панельная сессия', 'название сохранено для панели «Удалённые»')
    assert.equal(isActiveTombstone(entry), true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

// --- 8. маршруты панели ----------------------------------------------------

test('маршруты /tombstones и /restore: список, восстановление и запись в журнал', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-routes-'))
  const home = join(root, 'home')
  const shared = join(root, 'mirror')
  const projectPath = process.platform === 'win32' ? 'C:\\work\\routes' : '/work/routes'
  const previousHome = process.env.DSH_HOME
  try {
    await mkdir(home, { recursive: true })
    await mkdir(shared, { recursive: true })
    const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-routes', repoDir: shared, profile: { enabled: false }, workspace: { enabled: false } }
    config.projects = { alpha: { path: projectPath, title: 'alpha' } }
    config.autoSync = { enabled: false }
    await saveConfig(home, config)

    const id = `session-${randomUUID()}`
    const log = makeLog(
      { ...headerFor('/dsh-sync/projects/alpha', id), createdAt: Date.now() },
      [titleEvent('Восстановленный диалог'), { seq: 0 }],
    )
    // Карантинная копия зеркала и описание сессии.
    const quarantine = join(shared, 'sessions', 'alpha', '_deleted', id)
    await mkdir(quarantine, { recursive: true })
    await writeFile(join(quarantine, 'session.v4.jsonl.zstd'), log)
    await writeFile(join(quarantine, 'session.json'), `${JSON.stringify({ id, title: 'Восстановленный диалог' })}\n`, 'utf8')
    await writeFile(join(quarantine, 'deleted-at.json'), `${JSON.stringify({ at: new Date().toISOString(), reason: 'manual', by: 'owner', device: 'device-owner' })}\n`, 'utf8')
    await writeManualTombstone(shared, id, { title: 'Восстановленный диалог' })

    process.env.DSH_HOME = home
    const { apply } = await import('../index.js')
    const routes = new Map()
    const ctx = {
      effect: (fn) => { fn() },
      connection: { fetch: { register: (route) => routes.set(route.path, route) } },
      tools: { register: () => {} },
      get: () => undefined,
    }
    apply(ctx)
    const call = async (path, payload) => {
      const response = await routes.get(path).fetch(new Request(`http://local${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      }))
      return { status: response.status, body: await response.json() }
    }

    assert.ok(routes.has('/api/dsh-sync/tombstones'), 'маршрут списка удалённых')
    assert.ok(routes.has('/api/dsh-sync/restore'), 'маршрут восстановления')

    const listed = await call('/api/dsh-sync/tombstones', {})
    assert.equal(listed.status, 200)
    assert.equal(listed.body.ok, true)
    assert.equal(listed.body.quarantineDays, 30)
    assert.equal(listed.body.count, 1)
    const row = listed.body.sessions[0]
    assert.equal(row.id, id)
    assert.equal(row.title, 'Восстановленный диалог')
    assert.equal(row.reason, 'manual')
    assert.equal(row.by, 'owner')
    assert.equal(row.remainingDays, 30)
    assert.equal(row.quarantined, true)

    const invalid = await call('/api/dsh-sync/restore', {})
    assert.equal(invalid.status, 400, 'без id и all:true — ошибка запроса')

    const restored = await call('/api/dsh-sync/restore', { id })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.ok, true)
    assert.deepEqual(restored.body.restoredIds, [id])
    assert.equal(restored.body.reasons[0], 'restored')
    assert.equal(restored.body.by[0], 'owner')
    assert.equal(existsSync(join(shared, 'sessions', 'alpha', id, 'session.v4.jsonl.zstd')), true, 'копия вернулась в зеркало')
    assert.equal(existsSync(localSessionDir(home, projectPath, id)), true, 'копия вернулась локально')

    const tombstone = await readTombstones(shared)
    assert.equal(tombstone.sessions[id].reason, 'restored')

    const history = await readHistory(home, 5)
    const record = history[history.length - 1]
    assert.equal(record.action, 'restore')
    assert.deepEqual(record.restoredIds, [id])
    assert.deepEqual(record.reasons, ['restored'])
    assert.deepEqual(record.by, ['owner'])

    const listedAfter = await call('/api/dsh-sync/tombstones', {})
    assert.equal(listedAfter.body.count, 0, 'снятая метка в списке не показывается')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
