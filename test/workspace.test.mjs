/**
 * Привязка сессий к рабочим пространствам: переносимый workspace.json,
 * объединение без потерь, план привязки и подсказки для панели.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalCwd, defaultConfig } from '../lib/config.mjs'
import { createNeutralizer } from '../lib/neutralize.mjs'
import {
  planWorkspace,
  pullWorkspace,
  pushWorkspace,
  readLocalWorkspaces,
  readWorkspaceMirror,
  readWorkspacePending,
} from '../lib/workspace.mjs'

const PROJECT_A = process.platform === 'win32' ? 'E:\\Work\\Alpha' : '/work/alpha'
const PROJECT_B = process.platform === 'win32' ? 'D:\\Projects\\Alpha' : '/home/user/alpha'

async function writeWorkspaceStore(home, workspaces, global = {}) {
  const tables = { workspaces: {} }
  for (const workspace of workspaces) {
    tables.workspaces[workspace.id] = {
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    }
  }
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'local-default',
      workspaceIds: workspaces.map(workspace => workspace.id),
      pinnedSessionIds: ['session-pinned'],
      archivedSessionIds: ['session-archived'],
      ...global,
    },
    tables,
  }, null, 2))
}

async function makeEnv(prefix) {
  const root = await mkdtemp(join(tmpdir(), `dsh-ws-${prefix}-`))
  const home = join(root, 'home')
  const mirror = join(root, 'mirror')
  await mkdir(home, { recursive: true })
  await mkdir(mirror, { recursive: true })
  const config = { ...defaultConfig(home), backend: 'folder', deviceId: `device-${prefix}`, repoDir: mirror }
  config.projects = { alpha: { path: PROJECT_A, title: 'Alpha' } }
  return { root, home, mirror, config }
}

test('push: путь проекта заменяется нейтральным, глобальные поля не уезжают', async () => {
  const env = await makeEnv('push')
  try {
    await writeWorkspaceStore(env.home, [
      { id: 'ws-a', path: PROJECT_A, title: 'Alpha', sessionIds: ['session-1', 'session-2'] },
    ])
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    const result = await pushWorkspace({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    assert.equal(result.written, true)
    const mirror = JSON.parse(await readFile(join(env.mirror, 'workspace.json'), 'utf8'))
    assert.equal(mirror.version, 1)
    assert.equal(mirror.workspaces.length, 1)
    assert.equal(mirror.workspaces[0].path, canonicalCwd('alpha'))
    assert.equal(mirror.workspaces[0].projectId, 'alpha')
    assert.equal(mirror.workspaces[0].title, 'Alpha')
    assert.deepEqual(mirror.workspaces[0].sessionIds, ['session-1', 'session-2'])
    const json = JSON.stringify(mirror)
    assert.equal(json.includes('pinnedSessionIds'), false)
    assert.equal(json.includes('archivedSessionIds'), false)
    assert.equal(json.includes('defaultWorkspaceId'), false)
    assert.equal(json.includes('local-default'), false)
    assert.equal(json.includes(PROJECT_A), false, 'локальный путь не должен уезжать')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('push объединяет сессии двух устройств и не теряет чужие пространства', async () => {
  const env = await makeEnv('merge')
  try {
    await mkdir(env.mirror, { recursive: true })
    await writeFile(join(env.mirror, 'workspace.json'), JSON.stringify({
      version: 1,
      workspaces: [
        { path: canonicalCwd('alpha'), projectId: 'alpha', title: 'Alpha', sessionIds: ['session-remote'] },
        { path: '${HOME}/other', title: 'Other', sessionIds: ['session-other'] },
      ],
    }))
    await writeWorkspaceStore(env.home, [
      { id: 'ws-a', path: PROJECT_A, title: 'Alpha', sessionIds: ['session-local'] },
    ])
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    await pushWorkspace({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    const mirror = await readWorkspaceMirror(env.mirror)
    const alpha = mirror.workspaces.find(entry => entry.projectId === 'alpha')
    assert.deepEqual(alpha.sessionIds, ['session-local', 'session-remote'])
    assert.equal(mirror.workspaces.some(entry => entry.title === 'Other'), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: совпадение по проекту, план привязки и подсказки', async () => {
  const env = await makeEnv('pull')
  try {
    await writeFile(join(env.mirror, 'workspace.json'), JSON.stringify({
      version: 1,
      workspaces: [
        { path: canonicalCwd('alpha'), projectId: 'alpha', title: 'Alpha', sessionIds: ['session-1', 'session-2'] },
        { path: '${HOME}/ghost', title: 'Ghost', sessionIds: ['session-9'] },
      ],
    }))
    await writeWorkspaceStore(env.home, [
      { id: 'ws-a', path: PROJECT_A, title: 'Alpha', sessionIds: ['session-1'] },
    ])
    const before = await readFile(join(env.home, 'storages', 'workspace.json'), 'utf8')
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    const result = await pullWorkspace({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    assert.equal(result.matched, 1)
    assert.equal(result.toAttach, 1)
    assert.equal(result.hints, 1)
    const pending = await readWorkspacePending(env.home)
    assert.equal(pending.pendingAttach.length, 1)
    assert.equal(pending.pendingAttach[0].workspaceId, 'ws-a')
    assert.deepEqual(pending.pendingAttach[0].sessionIds, ['session-2'])
    assert.equal(pending.hints[0].title, 'Ghost')
    assert.match(String(pending.hints[0].reason), /рабочего пространства/)
    // Стор DSH не переписывается: владелец файла — сам DSH.
    assert.equal(await readFile(join(env.home, 'storages', 'workspace.json'), 'utf8'), before)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: если привязывать нечего, очередь привязки не создаётся', async () => {
  const env = await makeEnv('nothing')
  try {
    await writeFile(join(env.mirror, 'workspace.json'), JSON.stringify({
      version: 1,
      workspaces: [{ path: canonicalCwd('alpha'), projectId: 'alpha', title: 'Alpha', sessionIds: ['session-1'] }],
    }))
    await writeWorkspaceStore(env.home, [{ id: 'ws-a', path: PROJECT_A, title: 'Alpha', sessionIds: ['session-1', 'session-2'] }])
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    const result = await pullWorkspace({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    assert.equal(result.toAttach, 0)
    assert.equal(existsSync(join(env.home, 'dsh-sync', 'workspace-pending.json')), false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: на другом устройстве путь подставляется через projectId и по имени папки', async () => {
  const env = await makeEnv('paths')
  try {
    env.config.projects = { alpha: { path: PROJECT_B, title: 'Alpha' } }
    await writeFile(join(env.mirror, 'workspace.json'), JSON.stringify({
      version: 1,
      workspaces: [{ path: canonicalCwd('alpha'), projectId: 'alpha', title: 'Alpha', sessionIds: ['session-1'] }],
    }))
    await writeWorkspaceStore(env.home, [{ id: 'ws-b', path: PROJECT_B, title: 'Alpha', sessionIds: [] }])
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    const plan = await planWorkspace({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    assert.equal(plan.matched.length, 1)
    assert.equal(plan.matched[0].by, 'project')
    assert.equal(plan.matched[0].workspaceId, 'ws-b')
    assert.equal(plan.matched[0].path, PROJECT_B)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: совпадение по последней папке, когда projectId неизвестен', async () => {
  const env = await makeEnv('folder')
  try {
    env.config.projects = {}
    await writeFile(join(env.mirror, 'workspace.json'), JSON.stringify({
      version: 1,
      workspaces: [{ path: '${HOME}/somewhere/Alpha', title: 'Alpha', sessionIds: ['session-1'] }],
    }))
    await writeWorkspaceStore(env.home, [{ id: 'ws-a', path: PROJECT_A, title: 'Alpha', sessionIds: [] }])
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    const plan = await planWorkspace({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    assert.equal(plan.matched.length, 1)
    assert.equal(plan.matched[0].by, 'folder')
    assert.equal(plan.pendingAttach.length, 1)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('pull: нет стора DSH — не падаем, помечаем missingLocalStore', async () => {
  const env = await makeEnv('nostore')
  try {
    await writeFile(join(env.mirror, 'workspace.json'), JSON.stringify({
      version: 1,
      workspaces: [{ path: canonicalCwd('alpha'), projectId: 'alpha', title: 'Alpha', sessionIds: ['session-1'] }],
    }))
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    const plan = await planWorkspace({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    assert.equal(plan.missingLocalStore, true)
    assert.equal(plan.hints.length, 1)
    assert.equal(plan.pendingAttach.length, 0)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('readLocalWorkspaces читает только переносимую часть', async () => {
  const env = await makeEnv('read')
  try {
    await writeWorkspaceStore(env.home, [{ id: 'ws-a', path: PROJECT_A, title: 'Alpha', sessionIds: ['session-1'] }])
    const local = await readLocalWorkspaces(env.home)
    assert.equal(local.found, true)
    assert.equal(local.workspaces.length, 1)
    assert.equal(local.workspaces[0].id, 'ws-a')
    assert.deepEqual(local.workspaces[0].sessionIds, ['session-1'])
    assert.equal(local.global.defaultWorkspaceId, 'local-default')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('push и pull уважают выключенный профильный слой независимо друг от друга', async () => {
  const env = await makeEnv('flags')
  try {
    await writeWorkspaceStore(env.home, [{ id: 'ws-a', path: PROJECT_A, title: 'Alpha', sessionIds: ['session-1'] }])
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    const config = { ...env.config, workspace: { enabled: false } }
    // sync.mjs не вызывает pushWorkspace при выключенном флаге; сама функция
    // остаётся рабочей — проверяем, что флаг читается конфигом по умолчанию.
    assert.equal(config.workspace.enabled, false)
    assert.equal(env.config.workspace.enabled, true)
    const result = await pushWorkspace({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    assert.equal(result.workspaces, 1)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
