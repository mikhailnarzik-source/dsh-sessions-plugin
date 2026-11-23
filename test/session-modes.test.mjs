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
  isLocalSession,
  readSessionModes,
  sessionBadge,
  sessionModeOf,
  setSessionMode,
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
