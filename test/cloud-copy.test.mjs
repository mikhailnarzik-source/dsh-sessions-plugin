/**
 * «Удалить копию из облака»: удаляется только зеркальная копия локальной
 * сессии, локальный лог и режим остаются. Метка и журнал — manual/owner,
 * копия уходит в 30-дневный карантин зеркала и восстанавливается оттуда.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { MODE_LOCAL, isLocalSession, readSessionModes, setSessionMode } from '../lib/session-modes.mjs'
import { LOG_NAME, localSessionDir } from '../lib/store.mjs'
import { cloudCopyPath, deleteCloudCopy, findCloudCopyProject, inspectCloudCopy } from '../lib/cloud-copy.mjs'
import { DELETED_AT_FILE, quarantinePath, readTombstones } from '../lib/tombstones.mjs'

function makeLog(header, events = []) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function headerFor(cwd, id) {
  return { type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 }
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cloud-copy-'))
  const home = join(root, 'home')
  const mirror = join(root, 'mirror')
  const localProject = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  await mkdir(home, { recursive: true })
  await mkdir(mirror, { recursive: true })
  const config = {
    ...defaultConfig(home),
    backend: 'folder',
    repoDir: mirror,
    remote: '',
    deviceId: 'device-test',
    profile: { enabled: false },
    workspace: { enabled: false },
    projects: { alpha: { path: localProject, title: 'alpha' } },
  }
  await saveConfig(home, config)
  return { root, home, mirror, localProject, config }
}

async function writeLocalSession(home, cwd, id, bytes) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG_NAME), bytes)
  return dir
}

async function writeMirrorCopy(mirror, projectId, id, bytes, title = '') {
  const dir = cloudCopyPath(mirror, projectId, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG_NAME), bytes)
  if (title !== '') await writeFile(join(dir, 'session.json'), JSON.stringify({ id, title }), 'utf8')
  return dir
}

test('inspectCloudCopy: копия видна только у локальной сессии', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(headerFor(env.localProject, id), [{ type: 'text', seq: 0 }])
    await writeLocalSession(env.home, env.localProject, id, bytes)
    await writeMirrorCopy(env.mirror, 'alpha', id, bytes, 'Локальная работа')
    assert.equal(findCloudCopyProject(env.config, id), 'alpha')

    // Пока сессия облачная — зеркальная копия нормальна, действия нет.
    const cloud = await inspectCloudCopy({ home: env.home, config: env.config, sessionId: id })
    assert.equal(cloud.ok, false)
    assert.equal(cloud.code, 'not-local')

    await setSessionMode(env.home, [id], MODE_LOCAL)
    const local = await inspectCloudCopy({ home: env.home, config: env.config, sessionId: id })
    assert.equal(local.ok, true)
    assert.equal(local.projectId, 'alpha')
    assert.equal(local.title, 'Локальная работа')
    assert.equal(local.bytes, (await stat(join(cloudCopyPath(env.mirror, 'alpha', id), LOG_NAME))).size)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('deleteCloudCopy: удаляет только зеркальную копию, локальная остаётся (manual/owner, карантин)', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(headerFor(env.localProject, id), [{ type: 'text', seq: 0 }])
    const localDir = await writeLocalSession(env.home, env.localProject, id, bytes)
    await writeMirrorCopy(env.mirror, 'alpha', id, bytes, 'Нужная локально')
    await setSessionMode(env.home, [id], MODE_LOCAL)
    const localBefore = await readFile(join(localDir, LOG_NAME))

    const result = await deleteCloudCopy({ home: env.home, config: env.config, sessionId: id })
    assert.equal(result.ok, true)
    assert.equal(result.projectId, 'alpha')
    assert.equal(result.reason, 'manual')
    assert.equal(result.by, 'owner')
    assert.equal(result.quarantined, true)

    // Зеркальной копии больше нет, но она в карантине 30 дней.
    assert.equal(existsSync(cloudCopyPath(env.mirror, 'alpha', id)), false)
    const quarantine = quarantinePath(env.mirror, 'alpha', id)
    assert.equal(existsSync(quarantine), true, 'копия лежит в карантине')
    const deletedAt = JSON.parse(await readFile(join(quarantine, DELETED_AT_FILE), 'utf8'))
    assert.equal(deletedAt.reason, 'manual')
    assert.equal(deletedAt.by, 'owner')
    assert.equal(deletedAt.title, 'Нужная локально')

    // Метка удаления — manual/owner: другие устройства и панель «Удалённые»
    // видят осознанное действие пользователя.
    const tombstones = await readTombstones(env.mirror)
    assert.equal(tombstones.sessions[id].reason, 'manual')
    assert.equal(tombstones.sessions[id].by, 'owner')
    assert.equal(tombstones.sessions[id].title, 'Нужная локально')

    // Локальная сессия и её режим целы.
    assert.equal(existsSync(join(localDir, LOG_NAME)), true)
    assert.deepEqual(await readFile(join(localDir, LOG_NAME)), localBefore)
    const modes = await readSessionModes(env.home)
    assert.equal(isLocalSession(modes, id), true)

    // Повторное удаление — понятный отказ, а не ошибка файловой системы.
    const again = await deleteCloudCopy({ home: env.home, config: env.config, sessionId: id })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'no-cloud-copy')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('deleteCloudCopy: отказы для облачной сессии, без копии и с пустым id', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const bytes = makeLog(headerFor(env.localProject, id), [{ type: 'text', seq: 0 }])
    await writeLocalSession(env.home, env.localProject, id, bytes)

    const empty = await deleteCloudCopy({ home: env.home, config: env.config, sessionId: '  ' })
    assert.equal(empty.code, 'request/invalid')

    const notLocal = await deleteCloudCopy({ home: env.home, config: env.config, sessionId: id })
    assert.equal(notLocal.code, 'not-local')

    await setSessionMode(env.home, [id], MODE_LOCAL)
    const noCopy = await deleteCloudCopy({ home: env.home, config: env.config, sessionId: id })
    assert.equal(noCopy.code, 'no-cloud-copy')
    assert.equal(noCopy.ok, false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
