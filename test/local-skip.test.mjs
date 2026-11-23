/**
 * skippedLocal в истории и статусе: режим «локальная» удерживает сессии от
 * отправки, приёма и удаления из зеркала, и это видно одной цифрой в журнале
 * (`history.jsonl` / `last-run.json`), а не только в человекочитаемом тексте.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { localSkipStats } from '../lib/history.mjs'
import { quarantinePath, readTombstones, writeTombstones, addTombstone } from '../lib/tombstones.mjs'
import { pull, push } from '../lib/sync.mjs'
import { MODE_LOCAL, readSessionModes, setSessionMode } from '../lib/session-modes.mjs'
import { LOG_NAME, localSessionDir, mirrorLogPath } from '../lib/store.mjs'

function makeLog(cwd, id, events = [{ type: 'text', seq: 0 }]) {
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 }
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

async function writeSession(home, cwd, id, bytes = makeLog(cwd, id)) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG_NAME), bytes)
  return dir
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-skip-'))
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  await mkdir(home, { recursive: true })
  await mkdir(shared, { recursive: true })
  const projectPath = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const config = {
    ...defaultConfig(home),
    backend: 'folder',
    repoDir: shared,
    remote: '',
    deviceId: 'device-a',
    profile: { enabled: false },
    workspace: { enabled: false },
    projects: { alpha: { path: projectPath, title: 'alpha' } },
  }
  await saveConfig(home, config)
  return { root, home, shared, projectPath, config }
}

test('localSkipStats: одна цифра skippedLocal и слагаемые', () => {
  const stats = localSkipStats({
    pull: { localSkipped: 2, localSkippedIds: ['session-a', 'session-b'] },
    push: { localSkipped: 3, localSkippedIds: ['session-b', 'session-c'], localMirrorProtected: 1, localMirrorProtectedIds: ['session-d'] },
  })
  assert.equal(stats.skippedLocal, 5)
  assert.equal(stats.pullSkippedLocal, 2)
  assert.equal(stats.pushSkippedLocal, 3)
  assert.equal(stats.localMirrorProtected, 1)
  assert.deepEqual(stats.localSkippedIds, ['session-a', 'session-b', 'session-c', 'session-d'])

  const empty = localSkipStats({})
  assert.equal(empty.skippedLocal, 0)
  assert.deepEqual(empty.localSkippedIds, [])
})

test('push: skippedLocal и защита зеркальной копии локальной сессии от prune', async () => {
  const env = await makeEnvironment()
  try {
    const cloudId = `session-${randomUUID()}`
    const localId = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, cloudId)
    await writeSession(env.home, env.projectPath, localId)
    const first = await push({ home: env.home, config: env.config })
    assert.equal(first.pushed, 2)
    assert.equal(first.localSkipped, 0)
    assert.equal(existsSync(mirrorLogPath(env.shared, 'alpha', localId)), true)

    // Сессию перевели в локальные: зеркальная копия остаётся защищённой.
    await setSessionMode(env.home, [localId], MODE_LOCAL)
    const protectedStats = localSkipStats({ push: first })
    assert.equal(protectedStats.skippedLocal, 0, 'до prune-кандидатов пропусков нет')

    // Другое устройство пометило её удалённой: при отправке локальная копия
    // не удаляется, надгробие не перезаписывается.
    const tombstones = await readTombstones(env.shared)
    addTombstone(tombstones, localId, 'device-b', { reason: 'manual', by: 'owner' })
    await writeTombstones(env.shared, tombstones)

    const second = await push({ home: env.home, config: env.config })
    assert.equal(second.removed, 0, 'локальная сессия не удаляется из зеркала')
    assert.equal(second.localSkipped, 1)
    assert.equal(second.localMirrorProtected, 1, 'копия в зеркале защищена от prune')
    assert.deepEqual(second.localMirrorProtectedIds, [localId])
    assert.equal(existsSync(mirrorLogPath(env.shared, 'alpha', localId)), true)
    assert.equal(existsSync(quarantinePath(env.shared, 'alpha', localId)), false)

    const stats = localSkipStats({ push: second })
    assert.equal(stats.skippedLocal, 1)
    assert.equal(stats.localMirrorProtected, 1)
    assert.deepEqual(stats.localSkippedIds, [localId])
    const modes = await readSessionModes(env.home)
    assert.equal(modes.sessions[localId], MODE_LOCAL)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('sync-child пишет skippedLocal в last-run.json и history.jsonl', async () => {
  const env = await makeEnvironment()
  try {
    const cloudId = `session-${randomUUID()}`
    const localId = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, cloudId)
    await writeSession(env.home, env.projectPath, localId)
    await setSessionMode(env.home, [localId], MODE_LOCAL)

    const script = fileURLToPath(new URL('../lib/sync-child.mjs', import.meta.url))
    const child = spawnSync(process.execPath, [script, 'push'], {
      env: { ...process.env, DSH_HOME: env.home },
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(child.status, 0, `дочерний процесс завершился: ${child.stderr}`)
    const result = JSON.parse(child.stdout.trim().split('\n').pop())
    assert.equal(result.ok, true)
    assert.equal(result.skippedLocal, 1, 'в ответе процесса есть skippedLocal')
    assert.equal(result.push?.skippedLocal, 1)
    assert.equal(result.pull, null)

    const lastRun = JSON.parse(await readFile(join(env.home, 'dsh-sync', 'last-run.json'), 'utf8'))
    assert.equal(lastRun.skippedLocal, 1, 'last-run.json хранит skippedLocal')
    assert.equal(lastRun.push?.skippedLocal, 1)
    const history = (await readFile(join(env.home, 'dsh-sync', 'history.jsonl'), 'utf8'))
      .split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
    const last = history[history.length - 1]
    assert.equal(last.skippedLocal, 1, 'history.jsonl хранит skippedLocal')
    assert.match(last.message, /локальных сессий не отправлено: 1/)
    assert.equal(existsSync(mirrorLogPath(env.shared, 'alpha', cloudId)), true)
    assert.equal(existsSync(mirrorLogPath(env.shared, 'alpha', localId)), false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: локальная сессия не принимается и попадает в skippedLocal', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const dir = join(env.shared, 'sessions', 'alpha', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, LOG_NAME), makeLog(env.projectPath, id))
    await setSessionMode(env.home, [id], MODE_LOCAL)
    const summary = await pull({ home: env.home, config: env.config })
    assert.equal(summary.localSkipped, 1)
    assert.equal(summary.imported, 0)
    const stats = localSkipStats({ pull: summary })
    assert.equal(stats.skippedLocal, 1)
    assert.equal(stats.pullSkippedLocal, 1)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
