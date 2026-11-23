/**
 * Безопасный первый вход к существующему облаку: сверка резерва, приём до
 * отправки, флаг initialized и блокировка push без сверки.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { pushReplicated, pullReplicated, secondaryConfig } from '../lib/replica.mjs'
import {
  initializeSecondaryChannel,
  readSecondaryState,
  readSecondaryStatus,
  resetSecondaryInitialization,
  secondaryPushGate,
} from '../lib/secondary-init.mjs'
import { readHistory } from '../lib/history.mjs'
import { listFolderFiles } from '../lib/folder.mjs'
import { localSessionDir } from '../lib/store.mjs'

function sessionBytes(projectPath, id, seq = 0) {
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: projectPath, isSeeded: false, delegationDepth: 0 }
  return Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ seq, text: `событие ${seq}` })}\n`)),
  ])
}

async function writeSession(home, projectPath, id, seq = 0) {
  const dir = localSessionDir(home, projectPath, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), sessionBytes(projectPath, id, seq))
  return dir
}

function makeConfig({ home, projectPath, primaryDir, cloud, cache, deviceId = 'device-test' }) {
  return {
    version: 1,
    deviceId,
    backend: 'folder',
    repoDir: primaryDir,
    branch: 'main',
    attachments: false,
    profile: { enabled: false },
    workspace: { enabled: false },
    projects: { p: { path: projectPath, title: 'p' } },
    secondary: { enabled: true, backend: 'folder', repoDir: cache, folderDir: cloud },
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('первый push без сверки не заливает резерв и подсказывает «сначала сверка»', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secondary-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const cloud = join(root, 'cloud')
  await mkdir(project, { recursive: true })
  try {
    const id = `session-${randomUUID()}`
    await writeSession(home, project, id)
    const config = makeConfig({ home, projectPath: project, primaryDir: join(root, 'primary'), cloud, cache: join(root, 'cache') })

    const summary = await pushReplicated({ home, config })
    assert.ok(summary.pushed >= 1, 'основное хранилище отработало')
    assert.equal(summary.secondary, undefined, 'в резерв ничего не отправлено')
    assert.ok(summary.secondaryBlocked, 'push в резерв заблокирован')
    assert.match(summary.secondaryBlocked.message, /сверен|сверк/i)

    assert.equal((await listFolderFiles(cloud)).size, 0, 'папка облака пуста — данных не залили')
    const status = await readSecondaryStatus(home)
    assert.equal(status.ok, false)
    assert.equal(status.code, 'secondary/needs-compare')
    assert.notEqual((await readSecondaryState(home))?.initialized, true, 'флага initialized ещё нет')

    const state = await readJson(join(home, 'dsh-sync', 'state.json')).catch(() => undefined)
    assert.notEqual(state?.secondary?.initialized, true, 'в state флаг не поднят')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('после сверки initialized пишется, а pull и push работают', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secondary-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const cloud = join(root, 'cloud')
  await mkdir(project, { recursive: true })
  try {
    const id = `session-${randomUUID()}`
    await writeSession(home, project, id)
    const config = makeConfig({ home, projectPath: project, primaryDir: join(root, 'primary'), cloud, cache: join(root, 'cache') })
    const secondary = secondaryConfig(config)

    const init = await initializeSecondaryChannel({ home, config, secondary })
    assert.equal(init.ok, true)
    assert.equal(init.initialized, true)
    assert.equal(init.plan.local, 1)
    assert.equal(init.plan.cloud, 0, 'облако новое и пустое')
    assert.equal(init.pulled.imported, 0)

    const state = await readSecondaryState(home)
    assert.equal(state.initialized, true, 'флаг initialized в state.json')
    assert.equal(state.backend, 'folder')
    assert.equal(state.plan.local, 1)
    assert.equal(typeof state.at, 'string')

    const history = await readHistory(home, 5)
    const report = history.find(entry => entry.action === 'secondary-init')
    assert.ok(report, 'отчёт о сверке попал в историю')
    assert.match(report.message, /резерв сверен/)
    assert.match(report.message, /локально 1/)
    assert.equal(report.ok, true)

    const gate = await secondaryPushGate({ home, secondary })
    assert.equal(gate.ok, true, 'после сверки push разрешён')

    const summary = await pushReplicated({ home, config })
    assert.ok(summary.secondary, 'резерв задействован')
    assert.ok(summary.secondary.pushed >= 1)
    assert.equal(existsSync(join(cloud, 'sessions', 'p', id, 'session.v4.jsonl.zstd')), true, 'сессия доехала в папку облака')

    const status = await readSecondaryStatus(home)
    assert.equal(status.ok, true)
    assert.equal(status.code, 'secondary/pushed')

    // Приём из резерва после сверки тоже работает (пусть и нечего принимать).
    const pulled = await pullReplicated({ home, config: { ...config, backend: 'git', remote: join(root, 'no-repo.git'), repoDir: join(root, 'broken') } })
    assert.equal(pulled.viaSecondary, true, 'при недоступном основном приём идёт из резерва')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('первый вход к существующему облаку: сначала сверка и приём, затем отправка', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secondary-'))
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const cloud = join(root, 'cloud')
  await mkdir(projectA, { recursive: true })
  await mkdir(projectB, { recursive: true })
  try {
    const kept = `session-${randomUUID()}`
    const extra = `session-${randomUUID()}`
    await writeSession(homeA, projectA, kept)

    const configA = makeConfig({ home: homeA, projectPath: projectA, primaryDir: join(root, 'primary-a'), cloud, cache: join(root, 'cache-a'), deviceId: 'device-a' })
    const initA = await initializeSecondaryChannel({ home: homeA, config: configA, secondary: secondaryConfig(configA) })
    assert.equal(initA.ok, true)
    await pushReplicated({ home: homeA, config: configA })
    assert.equal(existsSync(join(cloud, 'sessions', 'p', kept, 'session.v4.jsonl.zstd')), true, 'облако уже содержит сессию')

    // Второе устройство: своя новая сессия и тот же проект.
    await writeSession(homeB, projectB, extra)
    const configB = makeConfig({ home: homeB, projectPath: projectB, primaryDir: join(root, 'primary-b'), cloud, cache: join(root, 'cache-b'), deviceId: 'device-b' })

    const blocked = await pushReplicated({ home: homeB, config: configB })
    assert.ok(blocked.secondaryBlocked, 'без сверки резерв заблокирован')
    assert.equal(existsSync(join(cloud, 'sessions', 'p', extra, 'session.v4.jsonl.zstd')), false, 'новую сессию не залили')
    assert.equal(existsSync(join(cloud, 'sessions', 'p', kept, 'session.v4.jsonl.zstd')), true, 'существующая копия цела')

    const initB = await initializeSecondaryChannel({ home: homeB, config: configB, secondary: secondaryConfig(configB) })
    assert.equal(initB.ok, true)
    assert.equal(initB.plan.local, 1, 'локально только своя новая сессия')
    assert.equal(initB.plan.cloud, 1, 'в облаке сессия первого устройства')
    assert.equal(initB.plan.onlyCloud, 1)
    assert.equal(initB.plan.onlyLocal, 1)
    assert.equal(initB.pulled.imported, 1, 'сначала приняли облачную сессию')
    assert.equal(
      existsSync(join(localSessionDir(homeB, projectB, kept), 'session.v4.jsonl.zstd')),
      true,
      'облачная сессия импортирована локально до отправки',
    )

    const summary = await pushReplicated({ home: homeB, config: configB })
    assert.ok(summary.secondary, 'после сверки отправка разрешена')
    assert.equal(existsSync(join(cloud, 'sessions', 'p', kept, 'session.v4.jsonl.zstd')), true, 'первая сессия осталась')
    assert.equal(existsSync(join(cloud, 'sessions', 'p', extra, 'session.v4.jsonl.zstd')), true, 'новая сессия доехала вторым устройством')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('новая машина после сверки принимает существующее облако, не заливая пустоту', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secondary-'))
  const projectA = join(root, 'project-a')
  const projectC = join(root, 'project-c')
  const homeA = join(root, 'home-a')
  const homeC = join(root, 'home-c')
  const cloud = join(root, 'cloud')
  await mkdir(projectA, { recursive: true })
  await mkdir(projectC, { recursive: true })
  try {
    const ids = [`session-${randomUUID()}`, `session-${randomUUID()}`]
    for (const id of ids) await writeSession(homeA, projectA, id)
    const configA = makeConfig({ home: homeA, projectPath: projectA, primaryDir: join(root, 'primary-a'), cloud, cache: join(root, 'cache-a'), deviceId: 'device-a' })
    await initializeSecondaryChannel({ home: homeA, config: configA, secondary: secondaryConfig(configA) })
    await pushReplicated({ home: homeA, config: configA })

    const configC = makeConfig({ home: homeC, projectPath: projectC, primaryDir: join(root, 'primary-c'), cloud, cache: join(root, 'cache-c'), deviceId: 'device-c' })
    const initC = await initializeSecondaryChannel({ home: homeC, config: configC, secondary: secondaryConfig(configC) })
    assert.equal(initC.ok, true)
    assert.equal(initC.plan.local, 0)
    assert.equal(initC.plan.cloud, 2, 'облако не пустое')
    assert.equal(initC.pulled.imported, 2, 'обе сессии приняты')

    const summary = await pushReplicated({ home: homeC, config: configC })
    assert.ok(summary.secondary !== undefined || summary.secondaryBlocked === undefined, 'резерв обработан')
    const cloudFiles = await listFolderFiles(cloud)
    for (const id of ids) {
      assert.equal(cloudFiles.has(`sessions/p/${id}/session.v4.jsonl.zstd`), true, `сессия ${id} осталась в облаке`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('приём из резерва доступен и до сверки: данные из облака не блокируются', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secondary-'))
  const projectA = join(root, 'project-a')
  const projectC = join(root, 'project-c')
  const homeA = join(root, 'home-a')
  const homeC = join(root, 'home-c')
  const cloud = join(root, 'cloud')
  await mkdir(projectA, { recursive: true })
  await mkdir(projectC, { recursive: true })
  try {
    const id = `session-${randomUUID()}`
    await writeSession(homeA, projectA, id)
    const configA = makeConfig({ home: homeA, projectPath: projectA, primaryDir: join(root, 'primary-a'), cloud, cache: join(root, 'cache-a'), deviceId: 'device-a' })
    await initializeSecondaryChannel({ home: homeA, config: configA, secondary: secondaryConfig(configA) })
    await pushReplicated({ home: homeA, config: configA })

    // Новое устройство: основное хранилище «сломано», резерв ещё не сверяли.
    const configC = makeConfig({ home: homeC, projectPath: projectC, primaryDir: join(root, 'primary-c'), cloud, cache: join(root, 'cache-c'), deviceId: 'device-c' })
    const pulled = await pullReplicated({
      home: homeC,
      config: { ...configC, backend: 'git', remote: join(root, 'no-repo.git'), repoDir: join(root, 'broken') },
    })
    assert.equal(pulled.viaSecondary, true, 'принято из резерва')
    assert.equal(
      existsSync(join(localSessionDir(homeC, projectC, id), 'session.v4.jsonl.zstd')),
      true,
      'данные из облака доступны без сверки',
    )
    assert.notEqual((await readSecondaryState(homeC))?.initialized, true, 'сверка всё ещё не выполнена')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('изменение настроек резерва требует новой сверки', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secondary-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const cloud = join(root, 'cloud')
  await mkdir(project, { recursive: true })
  try {
    const config = makeConfig({ home, projectPath: project, primaryDir: join(root, 'primary'), cloud, cache: join(root, 'cache') })
    const secondary = secondaryConfig(config)
    await initializeSecondaryChannel({ home, config, secondary })
    assert.equal((await secondaryPushGate({ home, secondary })).ok, true)

    const other = secondaryConfig({ ...config, secondary: { ...config.secondary, folderDir: join(root, 'cloud-other') } })
    const gate = await secondaryPushGate({ home, secondary: other })
    assert.equal(gate.ok, false, 'без сверки нового места push запрещён')
    assert.equal(gate.code, 'secondary/needs-compare')

    await resetSecondaryInitialization(home, 'настройки изменились')
    const reset = await secondaryPushGate({ home, secondary })
    assert.equal(reset.ok, false, 'после сброса сверка снова обязательна')
    assert.equal((await readSecondaryState(home)).initialized, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('сверка без настроенного резерва возвращает понятный код', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secondary-'))
  try {
    const result = await initializeSecondaryChannel({ home: join(root, 'home'), config: { projects: {} }, secondary: undefined })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'secondary/not-configured')
    assert.match(result.message, /не настроен/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
