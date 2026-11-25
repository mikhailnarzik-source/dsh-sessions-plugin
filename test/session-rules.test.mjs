/**
 * M6-A: правила сессий (задача 22, этапы 1–2) — Q1–Q8.
 *
 * Проверяется host-слой: хранилище `session-rules.json` (атомарная запись,
 * нормализация, merge по updatedAt, журнал конфликтов), пресеты control/keep/
 * archive, сопоставление по workspace/titlePrefix, наследование правила
 * родителя субагентам и проверки движка:
 *  - Q1 protect — prune/applyDeletions пропускают сессию («защищена правилом»);
 *  - Q2 ownerDevice — push пропускает сессию чужого устройства (rule-owner);
 *  - Q3 чужое изменение в pull — warning + метка конфликта, без перезаписи;
 *  - Q4 maxMb — данные баннера «сессия выросла до X МБ, лимит Y» + autoLocal;
 *  - Q5 forbidFork — развилка не создаётся;
 *  - Q6 наследование preset/protect/maxMb/ownerDevice субагенту;
 *  - Q7 правила переживают «перезапуск» (перечитывание с диска);
 *  - Q8 второе устройство видит правила (merge/profile).
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
import { applyDeletions, pull, push } from '../lib/sync.mjs'
import { readSessionModes } from '../lib/session-modes.mjs'
import {
  clearSessionRule,
  emptyRules,
  formatMb,
  mergeRulesFromProfile,
  mergeSessionRules,
  normalizeRules,
  overLimitOf,
  readRulesHistory,
  readRulesProfile,
  readSessionRules,
  recordRuleConflicts,
  resolveRulesForSession,
  rulesPath,
  rulesProfilePath,
  setSessionRule,
  writeRulesProfile,
  writeSessionRules,
} from '../lib/session-rules.mjs'

// --- helpers ---------------------------------------------------------------

function makeLog(header, events = []) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function appendEvent(bytes, event) {
  return Buffer.concat([bytes, zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))])
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
  const path = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(path, bytes)
  return path
}

async function makeEnvironment({ profile = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m6-rules-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const shared = join(root, 'shared')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(shared, { recursive: true })
  const projectPathA = process.platform === 'win32' ? 'C:\\work\\m6' : '/work/m6'
  const projectPathB = process.platform === 'win32' ? 'D:\\work\\m6' : '/home/user/m6'
  const makeConfig = (home, deviceId, projectPath) => {
    const config = {
      ...defaultConfig(home),
      backend: 'folder',
      deviceId,
      repoDir: shared,
      profile: { enabled: profile },
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

const mirrorLog = (env, id, projectId = 'alpha') => join(env.shared, 'sessions', projectId, id, 'session.v4.jsonl.zstd')
const localLog = (env, home, projectPath, id) => join(localSessionDir(home, projectPath, id), 'session.v4.jsonl.zstd')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

/** Правило одной сессии: писать в файл правил устройства. */
async function saveRule(home, sessionId, fields) {
  const rules = await readSessionRules(home)
  rules.sessions[sessionId] = { ...fields, updatedAt: fields.updatedAt ?? new Date().toISOString() }
  rules.updatedAt = new Date().toISOString()
  await writeSessionRules(home, rules)
  return rules
}

// --- Q1: protect не даёт удалить сессию из зеркала ---------------------------

test('Q1 protect: prune/applyDeletions пропускают сессию и пишут «защищена правилом»', async () => {
  const env = await makeEnvironment()
  try {
    const keepId = `session-${randomUUID()}`
    const deleteId = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, keepId, makeLog(headerFor(env.projectPathA, keepId), [{ seq: 0 }]))
    await writeSession(env.homeA, env.projectPathA, deleteId, makeLog(headerFor(env.projectPathA, deleteId), [{ seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })

    // Правило keep = protect: сессия нужна, удалять её нельзя.
    await saveRule(env.homeA, keepId, { preset: 'keep' })
    await rm(localSessionDir(env.homeA, env.projectPathA, keepId), { recursive: true, force: true })
    await rm(localSessionDir(env.homeA, env.projectPathA, deleteId), { recursive: true, force: true })

    const planned = await push({ home: env.homeA, config: env.configA })
    assert.equal(planned.removed, 0, 'push ничего не удаляет')
    assert.equal(planned.plan.deletions, 1, 'в плане только незащищённая сессия')
    assert.deepEqual(planned.skippedDeletions.ids, [deleteId])
    assert.equal(planned.skippedDeletions.protectedByRule.length, 1)
    assert.equal(planned.skippedDeletions.protectedByRule[0].id, keepId)
    assert.equal(planned.skippedDeletions.protectedByRule[0].label, 'защищена правилом')
    assert.equal(planned.skippedDeletions.protectedByRule[0].protected, true)
    assert.equal(planned.plan.rules.protected, 1)
    assert.deepEqual(planned.plan.rules.protectedIds, [keepId])
    assert.equal(planned.plan.rules.protectedMessage, 'защищена правилом')

    const applied = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(applied.removed, 1, 'удалена только незащищённая')
    assert.deepEqual(applied.removedIds, [deleteId])
    assert.equal(applied.protected, 1)
    assert.deepEqual(applied.protectedIds, [keepId])
    assert.equal(applied.protectedMessage, 'защищена правилом')
    assert.equal(existsSync(mirrorLog(env, keepId)), true, 'защищённая копия осталась в зеркале')
    assert.equal(existsSync(mirrorLog(env, deleteId)), false, 'незащищённая ушла в карантин')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('Q1/Q6 protect наследуется субагентом: группа защищённого родителя не удаляется', async () => {
  const env = await makeEnvironment()
  try {
    const parentId = `session-${randomUUID()}`
    const childId = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, parentId, makeLog(headerFor(env.projectPathA, parentId), [{ seq: 0 }]))
    await writeSession(env.homeA, env.projectPathA, childId, makeLog(headerFor(env.projectPathA, childId, parentId), [{ seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })

    await saveRule(env.homeA, parentId, { preset: 'keep' })
    await rm(localSessionDir(env.homeA, env.projectPathA, parentId), { recursive: true, force: true })
    await rm(localSessionDir(env.homeA, env.projectPathA, childId), { recursive: true, force: true })

    const applied = await applyDeletions({ home: env.homeA, config: env.configA, confirm: true })
    assert.equal(applied.removed, 0, 'защищённый родитель и его ребёнок не удаляются')
    const protectedIds = applied.protectedByRule.map(row => row.id).sort()
    assert.deepEqual(protectedIds, [childId, parentId].sort())
    assert.equal(
      applied.protectedByRule.find(row => row.id === childId).ruleSource,
      'parent',
      'ребёнок защищён унаследованным правилом',
    )
    assert.equal(existsSync(mirrorLog(env, parentId)), true)
    assert.equal(existsSync(mirrorLog(env, childId)), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- Q2: ownerDevice — отправляет только владелец ---------------------------

test('Q2 ownerDevice: push пропускает сессию чужого устройства с причиной rule-owner', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, id, makeLog(headerFor(env.projectPathA, id), [{ seq: 0 }]))
    await saveRule(env.homeA, id, { ownerDevice: 'device-b' })

    const blocked = await push({ home: env.homeA, config: env.configA })
    assert.equal(blocked.pushed, 0, 'чужое устройство сессию не отправляет')
    assert.equal(existsSync(mirrorLog(env, id)), false, 'в зеркале копии нет')
    assert.equal(blocked.plan.rules.ownerBlocked, 1)
    assert.deepEqual(blocked.plan.rules.ownerBlockedIds, [id])
    assert.equal(blocked.plan.rules.ownerReason, 'rule-owner')
    assert.equal(blocked.plan.rules.skipped[0].reason, 'rule-owner')
    assert.equal(blocked.rules.ownerMessage, 'правило: только владелец')
    const field = blocked.ruleFields.find(item => item.id === id)
    assert.equal(field.ownerBlocked, true)
    assert.equal(field.reason, 'rule-owner')
    assert.equal(field.ruleSource, 'session')
    assert.equal(field.ownerDevice, 'device-b')

    // Владелец — это устройство: отправка снова разрешена.
    await saveRule(env.homeA, id, { ownerDevice: 'device-a' })
    const allowed = await push({ home: env.homeA, config: env.configA })
    assert.equal(allowed.pushed, 1)
    assert.equal(existsSync(mirrorLog(env, id)), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- Q2b: archive — правило «только локальная» ------------------------------

test("Q2b archive: syncMode 'local' не пускает сессию в зеркало и не принимает её", async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, id, makeLog(headerFor(env.projectPathA, id), [{ seq: 0 }]))
    await saveRule(env.homeA, id, { preset: 'archive' })

    const pushed = await push({ home: env.homeA, config: env.configA })
    assert.equal(pushed.pushed, 0, 'локальная по правилу сессия не уходит')
    assert.equal(pushed.rules.localSkipped, 1)
    assert.deepEqual(pushed.rules.localSkippedIds, [id])
    assert.equal(pushed.plan.rules.localSkipReason, 'rule-local')
    assert.equal(pushed.plan.rules.skipped[0].reason, 'rule-local')
    assert.equal(existsSync(mirrorLog(env, id)), false)

    // Обратная сторона: сессия уже в зеркале, правило архива не даёт её принять.
    const id2 = `session-${randomUUID()}`
    await writeSession(env.homeB, env.projectPathB, id2, makeLog(headerFor(env.projectPathB, id2), [{ seq: 0 }]))
    await push({ home: env.homeB, config: env.configB })
    await saveRule(env.homeA, id2, { preset: 'archive' })
    const pulled = await pull({ home: env.homeA, config: env.configA })
    assert.equal(pulled.rules.localSkipped, 1)
    assert.deepEqual(pulled.rules.localSkippedIds, [id2])
    assert.equal(existsSync(localLog(env, env.homeA, env.projectPathA, id2)), false, 'локальная по правилу копия не создана')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- Q3: чужое изменение в pull — warning + конфликт, без перезаписи ---------

test('Q3 pull: изменение лога не владельцем — warning и конфликт вместо перезаписи', async () => {
  const env = await makeEnvironment()
  try {
    // Часть 1: A — владелец по правилу, но лог в зеркале дописало устройство B.
    const id = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, id, makeLog(headerFor(env.projectPathA, id), [{ seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    // B дописывает лог (без правила) и отправляет копию в зеркало.
    const pulledByB = await readFile(localLog(env, env.homeB, env.projectPathB, id))
    await writeFile(localLog(env, env.homeB, env.projectPathB, id), appendEvent(pulledByB, { seq: 1 }))
    const pushedByB = await push({ home: env.homeB, config: env.configB })
    assert.equal(pushedByB.pushed, 1, 'B без правила отправляет копию')

    // На A правило: владелец — само A. Чужое изменение не применяем молча.
    await saveRule(env.homeA, id, { ownerDevice: 'device-a' })
    const localBefore = await readFile(localLog(env, env.homeA, env.projectPathA, id))
    const pulled = await pull({ home: env.homeA, config: env.configA })

    assert.equal(pulled.conflicts >= 1, true, 'конфликт зафиксирован')
    assert.equal(pulled.rules.foreignChanges, 1)
    assert.deepEqual(pulled.rules.foreignChangeIds, [id])
    const conflict = pulled.conflictDetails.find(item => item.id === id && item.kind === 'rule-owner')
    assert.ok(conflict, 'метка конфликта rule-owner')
    assert.equal(conflict.ownerDevice, 'device-a')
    assert.match(conflict.message, /не владельцем/)
    assert.match(pulled.warning, /правило:/)
    const localAfter = await readFile(localLog(env, env.homeA, env.projectPathA, id))
    assert.deepEqual(localAfter, localBefore, 'локальный лог не перезаписан')

    // Часть 2: B — не владелец. Владелец A дописывает лог и отправляет; B не
    // применяет изменение молча, сообщение «правило: только владелец».
    const id2 = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, id2, makeLog(headerFor(env.projectPathA, id2), [{ seq: 0 }]))
    await saveRule(env.homeA, id2, { ownerDevice: 'device-a' })
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })
    await saveRule(env.homeB, id2, { ownerDevice: 'device-a' })
    const onBBefore = await readFile(localLog(env, env.homeB, env.projectPathB, id2))

    const onA = await readFile(localLog(env, env.homeA, env.projectPathA, id2))
    await writeFile(localLog(env, env.homeA, env.projectPathA, id2), appendEvent(onA, { seq: 1 }))
    const pushedA = await push({ home: env.homeA, config: env.configA })
    assert.equal(pushedA.pushed, 1, 'владелец отправляет изменение')
    const pulledB = await pull({ home: env.homeB, config: env.configB })
    const conflictB = pulledB.conflictDetails.find(item => item.id === id2 && item.kind === 'rule-owner')
    assert.ok(conflictB, 'B видит конфликт правила владельца')
    assert.match(conflictB.message, /только владелец/)
    const onBAfter = await readFile(localLog(env, env.homeB, env.projectPathB, id2))
    assert.deepEqual(onBAfter, onBBefore, 'локальная копия B не перезаписана')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- Q4: maxMb — данные баннера и autoLocal ---------------------------------

test('Q4 maxMb: размер лога выше лимита даёт данные баннера и предложение локальной', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const big = makeLog(headerFor(env.projectPathA, id), Array.from({ length: 40 }, (_, seq) => ({ seq, text: 'x'.repeat(40) })))
    await writeSession(env.homeA, env.projectPathA, id, big)
    await saveRule(env.homeA, id, { maxMb: 0.001, protect: false })

    const pushed = await push({ home: env.homeA, config: env.configA })
    assert.equal(pushed.pushed, 1, 'без autoLocal сессия всё равно отправляется')
    assert.equal(pushed.rules.overLimit, 1)
    assert.deepEqual(pushed.rules.overLimitIds, [id])
    const field = pushed.ruleFields.find(item => item.id === id)
    assert.equal(field.overLimit, true)
    assert.match(field.message, /^сессия выросла до .* МБ, лимит 0\.001$/)
    assert.equal(field.suggestion, 'перевести в локальные')
    assert.equal(typeof field.mb, 'number')
    assert.equal(pushed.plan.rules.overLimit, 1)
    assert.equal(pushed.plan.rules.limitHint, 'перевести в локальные')
    assert.equal(pushed.plan.rules.overLimitIds.length, 1)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('Q4 maxMb + autoLocal: сессия переводится в локальные и не уходит в зеркало', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const big = makeLog(headerFor(env.projectPathA, id), Array.from({ length: 40 }, (_, seq) => ({ seq, text: 'y'.repeat(40) })))
    await writeSession(env.homeA, env.projectPathA, id, big)
    await saveRule(env.homeA, id, { maxMb: 0.001, autoLocal: true })

    const pushed = await push({ home: env.homeA, config: env.configA })
    assert.equal(pushed.pushed, 0, 'сессия удержана от отправки')
    assert.equal(pushed.rules.autoLocal, 1)
    assert.deepEqual(pushed.rules.autoLocalIds, [id])
    assert.equal(existsSync(mirrorLog(env, id)), false)
    const modes = await readSessionModes(env.homeA)
    assert.equal(modes.sessions[id], 'local', 'режим сессии переключён только при autoLocal')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- Q5: forbidFork — развилка не создаётся --------------------------------

test('Q5 forbidFork: расхождение логов не создаёт копию, конфликт в отчёте', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const base = makeLog(headerFor(env.projectPathA, id), [{ seq: 0 }])
    await writeSession(env.homeA, env.projectPathA, id, base)
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    // Обе стороны дописали разное.
    await writeFile(localLog(env, env.homeA, env.projectPathA, id), appendEvent(base, { seq: 1, from: 'a' }))
    await writeFile(localLog(env, env.homeB, env.projectPathB, id), appendEvent(base, { seq: 1, from: 'b' }))
    await push({ home: env.homeA, config: env.configA })
    await saveRule(env.homeB, id, { forbidFork: true })

    const sessionsDir = join(env.homeB, 'sessions')
    const countBefore = (await readdir(sessionsDir, { recursive: true })).length
    const pulled = await pull({ home: env.homeB, config: env.configB })
    const countAfter = (await readdir(sessionsDir, { recursive: true })).length
    assert.equal(pulled.conflicts >= 1, true, 'конфликт виден в отчёте')
    assert.equal(pulled.rules.forbidFork >= 1, true, 'правило учтено в отчёте')
    assert.deepEqual(pulled.rules.forbidForkIds, [id])
    const conflict = pulled.conflictDetails.find(item => item.id === id && item.kind === 'forbid-fork')
    assert.ok(conflict, 'метка конфликта forbid-fork')
    assert.match(conflict.message, /развилка запрещена/)
    assert.equal(countAfter, countBefore, 'копия (развилка) не создана')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- Q6: наследование и пресеты --------------------------------------------

test('Q6 наследование: ребёнок наследует preset/protect/maxMb/ownerDevice родителя', async () => {
  const env = await makeEnvironment()
  try {
    const parentId = `session-${randomUUID()}`
    const childId = `session-${randomUUID()}`
    const rules = await saveRule(env.homeA, parentId, { preset: 'control', ownerDevice: 'device-b' })
    const groups = {
      parentById: new Map([[childId, parentId]]),
      childrenByParent: new Map([[parentId, [childId]]]),
    }
    const childRule = resolveRulesForSession({ rules, session: { id: childId }, groups, deviceId: 'device-a' })
    assert.equal(childRule.ruleSource, 'parent')
    assert.equal(childRule.inheritedFrom, parentId)
    assert.equal(childRule.protect, true)
    assert.equal(childRule.maxMb, 15)
    assert.equal(childRule.forbidFork, true)
    assert.equal(childRule.notifyForeignAppend, true)
    assert.equal(childRule.ownerDevice, 'device-b')
    assert.equal(childRule.ownerBlocked, true)
    assert.equal(childRule.preset, 'control')

    // Поведение: push с другим устройством не отправляет ни родителя, ни ребёнка.
    await writeSession(env.homeA, env.projectPathA, parentId, makeLog(headerFor(env.projectPathA, parentId), [{ seq: 0 }]))
    await writeSession(env.homeA, env.projectPathA, childId, makeLog(headerFor(env.projectPathA, childId, parentId), [{ seq: 0 }]))
    const pushed = await push({ home: env.homeA, config: env.configA })
    assert.equal(pushed.pushed, 0)
    assert.equal(pushed.plan.rules.ownerBlocked, 2, 'ребёнок унаследовал чужого владельца')

    // Своё правило ребёнка сильнее наследования, но создание даёт предупреждение.
    const setChild = await setSessionRule({ home: env.homeA, id: childId, preset: 'keep', groups })
    assert.ok(setChild.warning, 'предупреждение о правиле субагенту')
    const childOwn = resolveRulesForSession({ rules: setChild.rules, session: { id: childId }, groups, deviceId: 'device-a' })
    assert.equal(childOwn.ruleSource, 'session', 'собственное правило сильнее')
    assert.equal(childOwn.ownerDevice, undefined)
    assert.equal(childOwn.protect, true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('Q6 пресеты и matches: control/keep/archive и сопоставление по workspace/titlePrefix', async () => {
  const rules = emptyRules()
  rules.matches.push({ workspaceId: 'alpha', titlePrefix: 'Деплой', preset: 'control', updatedAt: new Date().toISOString() })
  rules.matches.push({ workspaceId: 'alpha', preset: 'archive', updatedAt: new Date().toISOString() })

  const byTitle = resolveRulesForSession({
    rules,
    session: { id: 'session-x', title: 'Деплой на прод', workspaceId: 'alpha' },
    workspaceId: 'alpha',
  })
  assert.equal(byTitle.ruleSource, 'match')
  assert.equal(byTitle.protect, true)
  assert.equal(byTitle.maxMb, 15)

  const byWorkspace = resolveRulesForSession({
    rules,
    session: { id: 'session-y', title: 'Обычная задача', workspaceId: 'alpha' },
    workspaceId: 'alpha',
  })
  assert.equal(byWorkspace.ruleSource, 'match')
  assert.equal(byWorkspace.syncMode, 'local', 'archive делает сессию локальной')
  assert.equal(byWorkspace.protect, true)

  const outside = resolveRulesForSession({
    rules,
    session: { id: 'session-z', title: 'Деплой на прод', workspaceId: 'beta' },
    workspaceId: 'beta',
  })
  assert.equal(outside.ruleSource, 'default')
  assert.equal(outside.protect, false)

  // Пресет применяется при создании правила: поля раскладываются сразу.
  const created = await setSessionRule({ id: 'session-control', preset: 'control' })
  assert.equal(created.entry.protect, true)
  assert.equal(created.entry.maxMb, 15)
  assert.equal(created.entry.forbidFork, true)
  assert.ok(Number.isFinite(Date.parse(created.entry.updatedAt)))
  assert.equal(formatMb(15), '15')
  assert.equal(overLimitOf({ maxMb: 1 }, 2 * 1024 * 1024).overLimit, true)
  assert.equal(overLimitOf({ maxMb: 1 }, 1024).overLimit, false)
})

// --- Q7: правила переживают перезапуск -------------------------------------

test('Q7 хранилище: атомарная запись, нормализация id, чтение после «перезапуска»', async () => {
  const env = await makeEnvironment()
  try {
    const parentId = `session-${randomUUID()}`
    const shortId = parentId.replace('session-', '')
    await saveRule(env.homeA, shortId, { preset: 'keep' })

    // Файл на месте, временных файлов нет (tmp+rename), формат — версия 1.
    const file = rulesPath(env.homeA)
    assert.equal(existsSync(file), true)
    const raw = await readJson(file)
    assert.equal(raw.version, 1)
    assert.ok(Number.isFinite(Date.parse(raw.updatedAt)))
    assert.equal(Array.isArray(raw.matches), true)
    assert.equal(await existsSync(`${file}.tmp`), false)
    const dshSync = await readdir(join(env.homeA, 'dsh-sync'))
    assert.equal(dshSync.some(name => name.endsWith('.tmp')), false, 'временных файлов не осталось')

    // Короткий id нормализован до session-…: правило найдётся после перечитывания.
    const reread = await readSessionRules(env.homeA)
    assert.equal(reread.sessions[parentId].preset, 'keep')
    const resolved = resolveRulesForSession({ rules: reread, session: { id: parentId } })
    assert.equal(resolved.protect, true, 'preset keep раскрывается в protect при разборе')
    assert.equal(resolved.preset, 'keep')

    // Битый файл — пустые правила, без падения.
    await writeFile(file, '{ не json', 'utf8')
    const broken = await readSessionRules(env.homeA)
    assert.deepEqual(broken.sessions, {})
    assert.equal(broken.presets.control.maxMb, 15, 'встроенные пресеты всегда на месте')

    // Снятие правила возвращает умолчание.
    const rules = normalizeRules({ sessions: { [shortId]: { preset: 'keep' } } })
    const cleared = await clearSessionRule({ home: env.homeA, rules, id: shortId })
    assert.equal(cleared.removed, true)
    assert.equal((await readSessionRules(env.homeA)).sessions[parentId], undefined)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- Q8: второе устройство видит правила (merge/profile) --------------------

test('Q8 merge: свежее правило побеждает, конфликт пишется в rules-history', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const older = new Date(Date.now() - 60_000).toISOString()
    const newer = new Date().toISOString()
    const local = normalizeRules({
      updatedAt: older,
      sessions: { [id]: { preset: 'keep', ownerDevice: 'device-a', updatedAt: older } },
    })
    const incoming = normalizeRules({
      updatedAt: newer,
      sessions: { [id]: { preset: 'control', ownerDevice: 'device-b', updatedAt: newer } },
    })
    const merged = mergeSessionRules(local, incoming)
    assert.equal(merged.changed, true)
    assert.equal(merged.rules.sessions[id].ownerDevice, 'device-b', 'свежее правило побеждает')
    assert.equal(merged.conflicts.length, 1)
    assert.equal(merged.conflicts[0].winner, 'incoming')

    const journal = await recordRuleConflicts(env.homeA, merged.conflicts)
    assert.equal(journal.written, 1)
    const history = await readRulesHistory(env.homeA)
    assert.equal(history.length, 1)
    assert.equal(history[0].id, id)
    assert.equal(history[0].winner, 'incoming')
    assert.equal(history[0].type, 'session-rules')

    // Равное время при разных данных: локальное правило остаётся, конфликт виден.
    const sameAt = new Date().toISOString()
    const tie = mergeSessionRules(
      normalizeRules({ sessions: { [id]: { protect: true, updatedAt: sameAt } } }),
      normalizeRules({ sessions: { [id]: { protect: false, updatedAt: sameAt } } }),
    )
    assert.equal(tie.rules.sessions[id].protect, true)
    assert.equal(tie.conflicts[0].reason, 'equal-updatedAt')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('Q8 профиль: правила уезжают в зеркало и приезжают на второе устройство', async () => {
  const env = await makeEnvironment({ profile: true })
  try {
    const id = `session-${randomUUID()}`
    // Пресет раскладывается в поля при создании правила: копия в зеркале полная.
    await setSessionRule({ home: env.homeA, id, preset: 'control', patch: { ownerDevice: 'device-a' } })
    await push({ home: env.homeA, config: env.configA })

    const profileFile = rulesProfilePath(env.shared)
    assert.equal(existsSync(profileFile), true, 'копия правил в профиле зеркала')
    const mirrorRules = await readRulesProfile({ repoDir: env.shared })
    assert.equal(mirrorRules.sessions[id].preset, 'control')
    assert.equal(mirrorRules.sessions[id].protect, true)
    assert.equal(mirrorRules.sessions[id].maxMb, 15)
    assert.equal(mirrorRules.sessions[id].ownerDevice, 'device-a')

    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.ok(pulled.ruleConflicts === undefined || Array.isArray(pulled.ruleConflicts), 'конфликтов правил нет')
    const onB = await readSessionRules(env.homeB)
    assert.equal(onB.sessions[id].preset, 'control')
    assert.equal(onB.sessions[id].ownerDevice, 'device-a')
    assert.equal(onB.sessions[id].protect, true)
    const resolvedOnB = resolveRulesForSession({ rules: onB, session: { id }, deviceId: 'device-b' })
    assert.equal(resolvedOnB.maxMb, 15)
    assert.equal(resolvedOnB.ownerBlocked, true, 'B видит, что сессией владеет A')

    // Через mergeRulesFromProfile: повторный вызов идемпотентен.
    const again = await mergeRulesFromProfile({ home: env.homeB, repoDir: env.shared })
    assert.equal(again.merged, false, 'одинаковые правила не переписываются')
    assert.equal(again.present, true)
    const localFile = await readJson(rulesPath(env.homeB))
    assert.equal(localFile.version, 1)
    assert.ok(localFile.sessions[id], 'правило второго устройства сохранено')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('Q8 writeRulesProfile/readRulesProfile: копия в зеркале и обратная совместимость', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const rules = normalizeRules({ sessions: { [id]: { preset: 'archive' } } })
    await writeRulesProfile({ repoDir: env.shared, rules })
    const read = await readRulesProfile({ repoDir: env.shared })
    assert.equal(read.sessions[id].preset, 'archive')
    const resolved = resolveRulesForSession({ rules: read, session: { id } })
    assert.equal(resolved.syncMode, 'local', 'archive делает сессию локальной')
    assert.equal(resolved.protect, true)

    // Нет файла — undefined (а не пустые правила): вызывающий отличит «нет данных».
    assert.equal(await readRulesProfile({ repoDir: join(env.root, 'empty') }), undefined)
    // Нет локального файла — пустые правила и встроенные пресеты.
    const empty = await readSessionRules(join(env.root, 'no-home'))
    assert.deepEqual(empty.sessions, {})
    assert.equal(empty.presets.archive.syncMode, 'local')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
