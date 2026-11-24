/**
 * План «Проверить» и удаления только по подтверждению.
 *
 * Проверяем главное обещание: план читает и сравнивает, но ничего не пишет;
 * push ничего не удаляет из зеркала; удаления идут отдельным действием
 * `applyDeletions({ confirm: true })` и только в карантин с меткой
 * reason=manual/by=owner. Плюс CLI-команды `plan` и `prune --confirm`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

import { canonicalCwd, defaultConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir, splitLog } from '../lib/store.mjs'
import { applyDeletions, push } from '../lib/sync.mjs'
import { buildPlan, PLAN_BUCKETS } from '../lib/plan.mjs'

// --- helpers ---------------------------------------------------------------

function makeLog(header, events) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function appendEvent(bytes, event) {
  return Buffer.concat([bytes, zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))])
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

const mirrorPath = (config, projectId, id) => join(config.repoDir, 'sessions', projectId, id, 'session.v4.jsonl.zstd')
const quarantinePath = (config, projectId, id) => join(config.repoDir, 'sessions', projectId, '_deleted', id)

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-plan-'))
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  await mkdir(home, { recursive: true })
  await mkdir(shared, { recursive: true })
  const projectPath = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-a', repoDir: shared }
  config.projects = { alpha: { path: projectPath, title: 'alpha' } }
  await saveConfig(home, config)
  return { root, home, shared, config, projectPath }
}

/** Слепок каталога: пути + sha256 содержимого. План не должен его менять. */
async function snapshotTree(dir) {
  const entries = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const content = await readFile(full)
      entries.push([relative(dir, full).split('\\').join('/'), createHash('sha256').update(content).digest('hex'), content.length])
    }
  }
  if (existsSync(dir)) await walk(dir)
  return entries.sort((left, right) => left[0].localeCompare(right[0]))
}

/** Запустить CLI плагина и вернуть { code, stdout, stderr }. */
function runCli(args, env = {}) {
  const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// --- план: семь корзин (дубли — M1) ----------------------------------------

test('план: семь корзин, размеры и удаления — и ничего не изменено', async () => {
  const env = await makeEnvironment()
  try {
    const project = 'alpha'
    // session-ids
    const same = `session-${randomUUID()}`
    const ahead = `session-${randomUUID()}`
    const behind = `session-${randomUUID()}`
    const conflict = `session-${randomUUID()}`
    const onlyLocal = `session-${randomUUID()}`
    const onlyCloud = `session-${randomUUID()}`

    const base = (id) => makeLog(headerFor(env.projectPath, id), [{ type: 'text', seq: 0 }])
    await writeSession(env.home, env.projectPath, same, base(same))
    await writeSession(env.home, env.projectPath, ahead, base(ahead))
    await writeSession(env.home, env.projectPath, behind, base(behind))
    await writeSession(env.home, env.projectPath, conflict, base(conflict))
    await push({ home: env.home, config: env.config })
    // onlyLocal: появилась после отправки — в зеркале её нет.
    await writeSession(env.home, env.projectPath, onlyLocal, base(onlyLocal))

    // localAhead: локальный лог длиннее зеркального.
    await writeSession(env.home, env.projectPath, ahead, appendEvent(base(ahead), { type: 'text', seq: 1, from: 'local' }))
    // cloudAhead: зеркало ушло вперёд.
    await writeFile(mirrorPath(env.config, project, behind), appendEvent(base(behind), { type: 'text', seq: 1, from: 'cloud' }))
    // conflicts: обе стороны дописали разное.
    await writeSession(env.home, env.projectPath, conflict, appendEvent(base(conflict), { type: 'text', seq: 1, from: 'local' }))
    await writeFile(mirrorPath(env.config, project, conflict), appendEvent(base(conflict), { type: 'text', seq: 1, from: 'cloud' }))
    // onlyCloud: сессия есть только в зеркале.
    const cloudDir = join(env.config.repoDir, 'sessions', project, onlyCloud)
    await mkdir(cloudDir, { recursive: true })
    await writeFile(join(cloudDir, 'session.v4.jsonl.zstd'), makeLog(headerFor(canonicalCwd(project), onlyCloud), [{ type: 'text', seq: 0 }]))

    // Слепок до плана: план не должен ни одного файла изменить или создать.
    const homeBefore = await snapshotTree(env.home)
    const mirrorBefore = await snapshotTree(env.shared)

    const plan = await buildPlan({ home: env.home, config: env.config })

    assert.equal(plan.ok, true)
    assert.equal(plan.readOnly, true, 'план помечен как read-only')
    assert.deepEqual(plan.warnings, [], 'предупреждений нет')
    assert.deepEqual(plan.counts, {
      onlyLocal: 1,
      onlyCloud: 1,
      same: 1,
      localAhead: 1,
      cloudAhead: 1,
      conflicts: 1,
      duplicates: 0,
    }, 'ровно по одной сессии в каждой корзине; дублей нет')
    for (const bucket of PLAN_BUCKETS) {
      assert.equal(plan.buckets[bucket].length, plan.counts[bucket], `список корзины ${bucket} полный`)
      // «Дубли» — справочная корзина: при нуле она пустая и без размера.
      if (plan.counts[bucket] > 0) assert.ok(plan.sizes[bucket] > 0, `размер корзины ${bucket} посчитан`)
    }
    assert.deepEqual(plan.buckets.onlyLocal.map(item => item.id), [onlyLocal])
    assert.deepEqual(plan.buckets.onlyCloud.map(item => item.id), [onlyCloud])
    assert.deepEqual(plan.buckets.same.map(item => item.id), [same])
    assert.deepEqual(plan.buckets.localAhead.map(item => item.id), [ahead])
    assert.deepEqual(plan.buckets.cloudAhead.map(item => item.id), [behind])
    assert.deepEqual(plan.buckets.conflicts.map(item => item.id), [conflict])
    assert.equal(plan.hasChanges, true)
    assert.equal(plan.deletionCount, 0, 'удалять нечего')
    assert.deepEqual(plan.deletions, [])
    assert.match(plan.message, /ничего не изменено/)

    // Ни одного изменения: ни в сторе, ни в зеркале, ни в журнале.
    assert.deepEqual(await snapshotTree(env.home), homeBefore, 'план не изменил каталог DSH')
    assert.deepEqual(await snapshotTree(env.shared), mirrorBefore, 'план не изменил зеркало')
    assert.equal(existsSync(join(env.home, 'dsh-sync', 'last-run.json')), false, 'last-run не создан')
    assert.equal(existsSync(join(env.home, 'dsh-sync', 'history.jsonl')), false, 'журнал не создан')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('план пустого зеркала: всё локальное, удалений нет, ничего не записано', async () => {
  const env = await makeEnvironment()
  try {
    const first = `session-${randomUUID()}`
    const second = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, first, makeLog(headerFor(env.projectPath, first), [{ seq: 0 }]))
    await writeSession(env.home, env.projectPath, second, makeLog(headerFor(env.projectPath, second), [{ seq: 0 }]))

    const homeBefore = await snapshotTree(env.home)
    const sharedBefore = await snapshotTree(env.shared)
    const plan = await buildPlan({ home: env.home, config: env.config })

    assert.deepEqual(plan.counts, {
      onlyLocal: 2,
      onlyCloud: 0,
      same: 0,
      localAhead: 0,
      cloudAhead: 0,
      conflicts: 0,
      duplicates: 0,
    })
    assert.equal(plan.deletionCount, 0)
    assert.deepEqual(plan.deletionIds, [])
    assert.equal(existsSync(join(env.shared, 'sessions')), false, 'зеркало не создано планом')
    assert.deepEqual(await snapshotTree(env.home), homeBefore)
    assert.deepEqual(await snapshotTree(env.shared), sharedBefore)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- push без удалений ------------------------------------------------------

test('push никогда не удаляет из зеркала: удаление ждёт подтверждения', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let index = 0; index < 10; index += 1) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.home, env.projectPath, id, makeLog(headerFor(env.projectPath, id), [{ seq: 0 }]))
    }
    const first = await push({ home: env.home, config: env.config })
    assert.equal(first.pushed, 10)
    assert.deepEqual(first.plan.counts, {
      onlyLocal: 10,
      onlyCloud: 0,
      same: 0,
      localAhead: 0,
      cloudAhead: 0,
      conflicts: 0,
    }, 'сводка плана попала в результат push')

    const removed = ids[0]
    await rm(localSessionDir(env.home, env.projectPath, removed), { recursive: true, force: true })

    // Одна удалённая из десяти — ниже старых порогов, но push всё равно
    // ничего не удаляет: удаление теперь отдельное подтверждённое действие.
    const second = await push({ home: env.home, config: env.config })
    assert.equal(second.removed, 0, 'push не удалил ничего')
    assert.equal(second.skippedDeletions?.removed, 1, 'удаление показано как отложенное')
    assert.deepEqual(second.skippedDeletions?.ids, [removed])
    assert.equal(second.skippedDeletions?.reason?.includes('подтверждени'), true)
    assert.ok(second.requireConfirmation, 'прежнее поле подтверждения сохранено')
    assert.equal(second.requireConfirmation.removed, 1)
    assert.equal(existsSync(mirrorPath(env.config, 'alpha', removed)), true, 'зеркало не тронуто')
    assert.equal(existsSync(quarantinePath(env.config, 'alpha', removed)), false, 'карантина нет')

    // План показывает кандидата на удаление (раньше, чем push с prune:false
    // обновит состояние проекта и забудет кандидата).
    const plan = await buildPlan({ home: env.home, config: env.config })
    assert.equal(plan.deletionCount, 1)
    assert.deepEqual(plan.deletions.map(item => item.id), [removed])
    assert.equal(plan.deletions[0].humanReason, 'удалено локально')

    // И уж тем более push не удаляет, если план удалений вообще не нужен.
    const third = await push({ home: env.home, config: env.config, prune: false })
    assert.equal(third.removed, 0)
    assert.equal(third.skippedDeletions, undefined, 'prune:false не считает удаления')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- «Применить удаления» ---------------------------------------------------

test('«Применить удаления» без confirm ничего не делает и просит подтверждение', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, id, makeLog(headerFor(env.projectPath, id), [{ seq: 0 }]))
    await push({ home: env.home, config: env.config })
    await rm(localSessionDir(env.home, env.projectPath, id), { recursive: true, force: true })

    const result = await applyDeletions({ home: env.home, config: env.config })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'confirm-required')
    assert.match(result.message, /подтвержд/)
    assert.equal(existsSync(mirrorPath(env.config, 'alpha', id)), true, 'зеркало не тронуто')
    assert.equal(existsSync(quarantinePath(env.config, 'alpha', id)), false, 'карантина нет')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('подтверждённые удаления: карантин, метка manual/owner и журнал', async () => {
  const env = await makeEnvironment()
  try {
    const keep = `session-${randomUUID()}`
    const drop = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, keep, makeLog(headerFor(env.projectPath, keep), [{ seq: 0 }]))
    const dropDir = await writeSession(env.home, env.projectPath, drop, makeLog(headerFor(env.projectPath, drop), [{ seq: 0 }]))
    await push({ home: env.home, config: env.config })
    await rm(dropDir, { recursive: true, force: true })

    const result = await applyDeletions({ home: env.home, config: env.config, confirm: true })
    assert.equal(result.ok, true)
    assert.equal(result.removed, 1)
    assert.deepEqual(result.removedIds, [drop])
    assert.deepEqual(result.reasons, ['manual'], 'причина — ручное удаление')
    assert.deepEqual(result.by, ['owner'], 'автор — владелец')

    // Живой копии нет, карантин и отметка времени на месте.
    assert.equal(existsSync(mirrorPath(env.config, 'alpha', drop)), false)
    const quarantine = quarantinePath(env.config, 'alpha', drop)
    assert.equal(existsSync(join(quarantine, 'session.v4.jsonl.zstd')), true, 'лог в карантине')
    const deletedAt = JSON.parse(await readFile(join(quarantine, 'deleted-at.json'), 'utf8'))
    assert.equal(deletedAt.reason, 'manual')
    assert.equal(deletedAt.by, 'owner')
    assert.equal(existsSync(mirrorPath(env.config, 'alpha', keep)), true, 'остальные сессии целы')

    // Надгробие в зеркале — с той же меткой.
    const tombstones = JSON.parse(await readFile(join(env.config.repoDir, 'tombstones.json'), 'utf8'))
    assert.equal(tombstones.sessions[drop].reason, 'manual')
    assert.equal(tombstones.sessions[drop].by, 'owner')
    // Состояние устройства больше не считает сессию отправленной.
    const state = JSON.parse(await readFile(join(env.home, 'dsh-sync', 'state.json'), 'utf8'))
    assert.equal(state.projects.alpha.includes(drop), false)
    assert.equal(state.projects.alpha.includes(keep), true)

    // Повторный план: удалять больше нечего.
    const plan = await buildPlan({ home: env.home, config: env.config })
    assert.equal(plan.deletionCount, 0)
    assert.equal(plan.counts.onlyCloud, 0, 'карантин не считается зеркальной копией')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('«Применить удаления» с ids из плана удаляет только выбранное', async () => {
  const env = await makeEnvironment()
  try {
    const first = `session-${randomUUID()}`
    const second = `session-${randomUUID()}`
    for (const id of [first, second]) {
      await writeSession(env.home, env.projectPath, id, makeLog(headerFor(env.projectPath, id), [{ seq: 0 }]))
    }
    await push({ home: env.home, config: env.config })
    for (const id of [first, second]) {
      await rm(localSessionDir(env.home, env.projectPath, id), { recursive: true, force: true })
    }
    const plan = await buildPlan({ home: env.home, config: env.config })
    assert.equal(plan.deletionCount, 2)

    const result = await applyDeletions({ home: env.home, config: env.config, confirm: true, ids: [first] })
    assert.equal(result.ok, true)
    assert.equal(result.removed, 1)
    assert.deepEqual(result.removedIds, [first])
    assert.equal(existsSync(quarantinePath(env.config, 'alpha', first)), true, 'выбранная удалена в карантин')
    assert.equal(existsSync(mirrorPath(env.config, 'alpha', second)), true, 'невыбранная осталась')

    // Оставшийся кандидат ждёт подтверждения и виден плану.
    const again = await buildPlan({ home: env.home, config: env.config })
    assert.deepEqual(again.deletions.map(item => item.id), [second])
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- CLI --------------------------------------------------------------------

test('CLI: dsh-sync plan показывает корзины, prune без --confirm не удаляет, с --confirm удаляет', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, id, makeLog(headerFor(env.projectPath, id), [{ seq: 0 }]))

    const planned = await runCli(['plan', '--home', env.home])
    assert.equal(planned.code, 0, planned.stderr)
    assert.match(planned.stdout, /только локально: 1/)
    assert.match(planned.stdout, /удалений нет/)
    assert.match(planned.stdout, /ничего не изменено/)
    assert.equal(existsSync(join(env.shared, 'sessions')), false, 'CLI plan ничего не создал')

    // Старый ключ --dry-run у push теперь ведёт в тот же общий план.
    const dryRun = await runCli(['push', '--dry-run', '--home', env.home])
    assert.equal(dryRun.code, 0, dryRun.stderr)
    assert.match(dryRun.stdout, /только локально: 1/)
    assert.equal(existsSync(join(env.shared, 'sessions')), false, 'push --dry-run ничего не отправил')

    await push({ home: env.home, config: env.config })
    await rm(localSessionDir(env.home, env.projectPath, id), { recursive: true, force: true })

    const notConfirmed = await runCli(['prune', '--home', env.home])
    assert.equal(notConfirmed.code, 2, 'без подтверждения команда отказывается')
    assert.match(notConfirmed.stdout + notConfirmed.stderr, /--confirm/)
    assert.equal(existsSync(mirrorPath(env.config, 'alpha', id)), true, 'зеркало не тронуто')

    const confirmed = await runCli(['prune', '--confirm', '--home', env.home])
    assert.equal(confirmed.code, 0, confirmed.stderr)
    assert.match(confirmed.stdout, /перенесено в карантин: 1/)
    assert.equal(existsSync(quarantinePath(env.config, 'alpha', id)), true, 'CLI удалил в карантин')
    // Журнал CLI: ручное удаление с причиной и автором.
    const history = (await readFile(join(env.home, 'dsh-sync', 'history.jsonl'), 'utf8'))
      .split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
    const last = history[history.length - 1]
    assert.equal(last.action, 'prune')
    assert.equal(last.removed, 1)
    assert.deepEqual(last.reasons, ['manual'])
    assert.deepEqual(last.by, ['owner'])
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
