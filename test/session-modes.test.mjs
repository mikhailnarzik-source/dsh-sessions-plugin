/**
 * Режим «локальная / облачная»: локальные сессии не уходят в зеркало, не
 * принимаются из него, не удаляются удалённой отметкой и показываются
 * отдельным значком.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig } from '../lib/config.mjs'
import { canonicalize, localSessionDir, splitLog } from '../lib/store.mjs'
import { pull, push } from '../lib/sync.mjs'
import {
  MODE_CLOUD,
  MODE_LOCAL,
  MODES_VERSION,
  applyWorkspaceDefaults,
  isLocalSession,
  readSessionModes,
  sessionBadge,
  sessionModeOf,
  setSessionMode,
  setWorkspaceDefaultMode,
  workspaceDefaultMode,
  writeSessionModes,
} from '../lib/session-modes.mjs'

function makeLog(header, events = []) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function headerFor(cwd, id = `session-${randomUUID()}`) {
  return { type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 }
}

async function writeSession(home, cwd, id, bytes) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), bytes)
  return dir
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-modes-'))
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
  return { root, homeA, homeB, shared, configA, configB, projectPathA, projectPathB }
}

test('переключение режима: нормализация id, идемпотентность, облако по умолчанию', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-modes-set-'))
  try {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    const first = await setSessionMode(home, ['abc'], MODE_LOCAL)
    assert.equal(first.changed, 1)
    assert.equal(first.mode, MODE_LOCAL)
    let modes = await readSessionModes(home)
    assert.equal(isLocalSession(modes, 'abc'), true)
    assert.equal(isLocalSession(modes, 'session-abc'), true)
    assert.equal(isLocalSession(modes, 'session-other'), false)
    assert.equal(sessionModeOf(modes, 'session-other'), MODE_CLOUD)

    const again = await setSessionMode(home, ['session-abc', 'abc'], MODE_LOCAL)
    assert.equal(again.changed, 0)

    const cloud = await setSessionMode(home, ['session-abc'], MODE_CLOUD)
    assert.equal(cloud.changed, 1)
    modes = await readSessionModes(home)
    assert.equal(isLocalSession(modes, 'session-abc'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('push: локальная сессия не уходит в зеркало, облачная уходит', async () => {
  const env = await makeEnvironment()
  try {
    const cloudId = `session-${randomUUID()}`
    const localId = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, cloudId, makeLog(headerFor(env.projectPathA, cloudId), [{ type: 'text', seq: 0 }]))
    await writeSession(env.homeA, env.projectPathA, localId, makeLog(headerFor(env.projectPathA, localId), [{ type: 'text', seq: 0 }]))
    await setSessionMode(env.homeA, [localId], MODE_LOCAL)

    const summary = await push({ home: env.homeA, config: env.configA })
    assert.equal(summary.pushed, 1)
    assert.equal(summary.localSkipped, 1)
    assert.equal(existsSync(join(env.shared, 'sessions', 'alpha', cloudId, 'session.v4.jsonl.zstd')), true)
    assert.equal(existsSync(join(env.shared, 'sessions', 'alpha', localId)), false)

    const state = JSON.parse(await readFile(join(env.homeA, 'dsh-sync', 'state.json'), 'utf8'))
    assert.deepEqual(state.projects.alpha, [cloudId], 'локальная сессия не попадает в состояние отправки')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('перевод уже отправленной сессии в локальные не удаляет её из зеркала и не даёт надгробий', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, id, makeLog(headerFor(env.projectPathA, id), [{ type: 'text', seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })
    const mirrorPath = join(env.shared, 'sessions', 'alpha', id, 'session.v4.jsonl.zstd')
    const before = await readFile(mirrorPath)

    await setSessionMode(env.homeA, [id], MODE_LOCAL)
    const summary = await push({ home: env.homeA, config: env.configA })
    assert.equal(summary.removed, 0)
    assert.equal(summary.localSkipped, 1)
    assert.equal(existsSync(mirrorPath), true, 'зеркальная копия остаётся')
    assert.deepEqual(await readFile(mirrorPath), before, 'содержимое зеркала не изменилось')

    const tombstonesFile = join(env.shared, 'tombstones.json')
    const tombstones = existsSync(tombstonesFile) ? JSON.parse(await readFile(tombstonesFile, 'utf8')) : { sessions: {} }
    assert.deepEqual(tombstones.sessions, {}, 'надгробие не создаётся')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: локальная сессия не принимается и не перезаписывается', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const remoteLog = makeLog(headerFor(env.projectPathA, id), [{ type: 'text', seq: 0 }, { type: 'text', seq: 1 }])
    // Зеркало как после отправки с другого устройства.
    const mirrorDir = join(env.shared, 'sessions', 'alpha', id)
    await mkdir(mirrorDir, { recursive: true })
    await writeFile(join(mirrorDir, 'session.v4.jsonl.zstd'), canonicalize(remoteLog, 'alpha'))

    // На устройстве B сессия помечена локальной: приём должен её пропустить.
    await setSessionMode(env.homeB, [id], MODE_LOCAL)
    const summary = await pull({ home: env.homeB, config: env.configB })
    assert.equal(summary.localSkipped, 1)
    assert.equal(summary.imported, 0)
    assert.equal(existsSync(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd')), false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: удалённая отметка не удаляет локальную сессию', async () => {
  const env = await makeEnvironment()
  try {
    const localId = `session-${randomUUID()}`
    const cloudId = `session-${randomUUID()}`
    await writeSession(env.homeB, env.projectPathB, localId, makeLog(headerFor(env.projectPathB, localId), [{ type: 'text', seq: 0 }]))
    await writeSession(env.homeB, env.projectPathB, cloudId, makeLog(headerFor(env.projectPathB, cloudId), [{ type: 'text', seq: 0 }]))
    await setSessionMode(env.homeB, [localId], MODE_LOCAL)
    await writeFile(join(env.shared, 'tombstones.json'), JSON.stringify({
      version: 1,
      sessions: {
        [localId]: { at: new Date().toISOString(), device: 'device-a' },
        [cloudId]: { at: new Date().toISOString(), device: 'device-a' },
      },
    }))
    const summary = await pull({ home: env.homeB, config: env.configB })
    assert.equal(summary.deleted, 1)
    assert.deepEqual(summary.deletedIds, [cloudId])
    assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, localId)), true)
    assert.equal(existsSync(localSessionDir(env.homeB, env.projectPathB, cloudId)), false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('облачные сессии синхронизируются как раньше', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, id, makeLog(headerFor(env.projectPathA, id), [{ type: 'text', seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })
    const summary = await pull({ home: env.homeB, config: env.configB })
    assert.equal(summary.imported, 1)
    assert.equal(summary.localSkipped, 0)
    const imported = await readFile(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd'))
    assert.equal(splitLog(imported).header.cwd, env.projectPathB)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('значок сессии: локальная, синхронизирована, ждёт, конфликт, недоступно, не привязана', () => {
  assert.equal(sessionBadge({ mode: MODE_LOCAL, state: 'green' }), 'local')
  assert.equal(sessionBadge({ mode: MODE_CLOUD, state: 'green' }), 'synced')
  assert.equal(sessionBadge({ mode: MODE_CLOUD, state: 'orange' }), 'pending')
  assert.equal(sessionBadge({ mode: MODE_CLOUD, state: 'red' }), 'never')
  assert.equal(sessionBadge({ mode: MODE_CLOUD, state: 'green', conflict: true }), 'conflict')
  assert.equal(sessionBadge({ mode: MODE_CLOUD, state: 'orange', offline: true }), 'offline')
  assert.equal(sessionBadge({ mode: MODE_CLOUD, state: 'green', unattached: true }), 'unattached')
})

test('битый файл режимов не ломает синхронизацию', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-modes-broken-'))
  try {
    const home = join(root, 'home')
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', 'session-modes.json'), '{битый json')
    const modes = await readSessionModes(home)
    assert.deepEqual(modes.sessions, {})
    await writeSessionModes(home, { sessions: { 'session-x': MODE_LOCAL } })
    const again = await readSessionModes(home)
    assert.equal(isLocalSession(again, 'session-x'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Стор рабочих пространств DSH: только то, что нужно режимам по умолчанию. */
async function writeWorkspaceStore(home, workspaces) {
  const file = join(home, 'storages', 'workspace.json')
  await mkdir(join(home, 'storages'), { recursive: true })
  const table = {}
  for (const [id, record] of Object.entries(workspaces)) {
    table[id] = { path: record.path, title: record.title ?? id, sessionIds: record.sessionIds ?? [] }
  }
  await writeFile(file, JSON.stringify({ version: 1, tables: { workspaces: table } }, null, 2), 'utf8')
}

test('режим по умолчанию рабочего пространства: новые сессии наследуют, явный выбор сильнее', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-modes-ws-'))
  try {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    const first = await setWorkspaceDefaultMode(home, 'ws-alpha', MODE_LOCAL)
    assert.equal(first.changed, 1)
    assert.equal(first.mode, MODE_LOCAL)
    let modes = await readSessionModes(home)
    assert.equal(workspaceDefaultMode(modes, 'ws-alpha'), MODE_LOCAL)
    assert.equal(modes.version, MODES_VERSION)
    assert.deepEqual(modes.workspaces, { 'ws-alpha': MODE_LOCAL })

    // Первая материализация: новая сессия пространства становится локальной.
    const applied = await applyWorkspaceDefaults(home, { workspaceIdBySession: { 'session-new-1': 'ws-alpha', 'session-new-2': 'ws-other' } })
    assert.equal(applied.changed, 1)
    assert.deepEqual(applied.inherited, ['session-new-1'])
    assert.equal(isLocalSession(applied.modes, 'session-new-1'), true)
    assert.equal(isLocalSession(applied.modes, 'session-new-2'), false, 'умолчание «облако» записи не создаёт')
    assert.equal(explicitRecord(applied.modes, 'session-new-2'), undefined)

    // Повторный проход идемпотентен: уже записанную сессию не переписываем.
    const again = await applyWorkspaceDefaults(home, { workspaceIdBySession: { 'session-new-1': 'ws-alpha' } })
    assert.equal(again.changed, 0)

    // Явный выбор «облачная» сильнее умолчания пространства.
    await setSessionMode(home, ['session-new-1'], MODE_CLOUD)
    const afterCloud = await applyWorkspaceDefaults(home, { workspaceIdBySession: { 'session-new-1': 'ws-alpha' } })
    assert.equal(afterCloud.changed, 0)
    assert.equal(sessionModeOf(afterCloud.modes, 'session-new-1'), MODE_CLOUD)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Явная запись режима сессии (внутренний вид файла). */
function explicitRecord(modes, sessionId) {
  return modes.sessions[sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`]
}

test('смена умолчания пространства закрепляет режим существующих сессий', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-modes-pin-'))
  try {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    await setWorkspaceDefaultMode(home, 'ws-1', MODE_LOCAL)
    // В пространстве уже есть две сессии: одна с явной записью, одна без.
    await setSessionMode(home, ['session-explicit'], MODE_LOCAL)
    const shifted = await setWorkspaceDefaultMode(home, 'ws-1', MODE_CLOUD, {
      sessionIds: ['session-explicit', 'session-implicit'],
    })
    assert.equal(shifted.previous, MODE_LOCAL)
    assert.equal(shifted.changed, 1)
    assert.equal(shifted.pinned, 1, 'закреплена только сессия без явной записи')
    const modes = await readSessionModes(home)
    assert.equal(workspaceDefaultMode(modes, 'ws-1'), MODE_CLOUD)
    assert.deepEqual(modes.workspaces, {}, 'облако — встроенное умолчание, запись не нужна')
    assert.equal(sessionModeOf(modes, 'session-implicit'), MODE_LOCAL, 'существующая сессия осталась локальной')
    assert.equal(sessionModeOf(modes, 'session-explicit'), MODE_LOCAL)
    // Новая сессия после смены умолчания — уже облачная.
    const fresh = await applyWorkspaceDefaults(home, { workspaceIdBySession: { 'session-fresh': 'ws-1' } })
    assert.equal(fresh.changed, 0)
    assert.equal(sessionModeOf(fresh.modes, 'session-fresh'), MODE_CLOUD)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('файл версии 1 читается: локальные записи живут, умолчаний нет', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-modes-v1-'))
  try {
    const home = join(root, 'home')
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', 'session-modes.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-11-01T00:00:00.000Z',
      sessions: { 'session-old-local': 'local' },
    }), 'utf8')
    const modes = await readSessionModes(home)
    assert.equal(modes.version, MODES_VERSION)
    assert.equal(isLocalSession(modes, 'session-old-local'), true)
    assert.deepEqual(modes.workspaces, {})
    // Запись сохраняет обе части в формате v2.
    await setWorkspaceDefaultMode(home, 'ws-v1', MODE_LOCAL)
    const saved = JSON.parse(await readFile(join(home, 'dsh-sync', 'session-modes.json'), 'utf8'))
    assert.equal(saved.version, MODES_VERSION)
    assert.equal(saved.sessions['session-old-local'], MODE_LOCAL)
    assert.deepEqual(saved.workspaces, { 'ws-v1': MODE_LOCAL })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('push и pull уважают умолчание рабочего пространства для новых сессий', async () => {
  const env = await makeEnvironment()
  try {
    const cloudId = `session-${randomUUID()}`
    const defaultLocalId = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, cloudId, makeLog(headerFor(env.projectPathA, cloudId), [{ type: 'text', seq: 0 }]))
    await writeSession(env.homeA, env.projectPathA, defaultLocalId, makeLog(headerFor(env.projectPathA, defaultLocalId), [{ type: 'text', seq: 0 }]))
    // Пространство с умолчанием «локальная»: сессия явно не переключалась.
    await writeWorkspaceStore(env.homeA, {
      'ws-alpha': { path: env.projectPathA, title: 'alpha', sessionIds: [defaultLocalId] },
    })
    await setWorkspaceDefaultMode(env.homeA, 'ws-alpha', MODE_LOCAL)

    const summary = await push({ home: env.homeA, config: env.configA })
    assert.equal(summary.pushed, 1, 'в облако ушла только сессия из облачного умолчания')
    assert.equal(summary.localSkipped, 1)
    assert.equal(existsSync(join(env.shared, 'sessions', 'alpha', defaultLocalId)), false)
    const modes = await readSessionModes(env.homeA)
    assert.equal(isLocalSession(modes, defaultLocalId), true, 'новая сессия получила умолчание при отправке')

    // Явное «облако» возвращает сессию в обмен, несмотря на умолчание.
    await setSessionMode(env.homeA, [defaultLocalId], MODE_CLOUD)
    const second = await push({ home: env.homeA, config: env.configA })
    assert.equal(second.pushed, 1)
    assert.equal(second.localSkipped, 0)

    // Устройство B: та же сессия приходит из зеркала, но пространство по
    // умолчанию локальное — приём её пропускает.
    await writeWorkspaceStore(env.homeB, {
      'ws-beta': { path: env.projectPathB, title: 'alpha', sessionIds: [defaultLocalId] },
    })
    await setWorkspaceDefaultMode(env.homeB, 'ws-beta', MODE_LOCAL)
    const pulled = await pull({ home: env.homeB, config: env.configB })
    assert.equal(pulled.localSkipped, 1)
    assert.equal(pulled.imported, 1, 'принимается только облачная сессия')
    assert.equal(existsSync(join(localSessionDir(env.homeB, env.projectPathB, defaultLocalId), 'session.v4.jsonl.zstd')), false)
    assert.equal(existsSync(join(localSessionDir(env.homeB, env.projectPathB, cloudId), 'session.v4.jsonl.zstd')), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
