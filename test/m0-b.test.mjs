/**
 * M0-B: метка удаления сильнее копии (H3), формат-гард (H7), errorKind и
 * счётчик failures в last-run/history (H9), одна запись запуска (H10).
 *
 * Проверяем контракт с UI: `summary.errorKind` — строка из ERROR_KINDS,
 * `summary.failures` — число (ошибок подряд, успех сбрасывает в ноль).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import {
  ERROR_KINDS,
  classifyErrorKind,
  failureState,
  readHistory,
  readLastRun,
  recordRun,
} from '../lib/history.mjs'
import { readMirrorFormat } from '../lib/mirror-meta.mjs'
import {
  canDropTombstone,
  pull,
  push,
  sessionTimestamp,
  tombstoneBlocksSession,
} from '../lib/sync.mjs'
import { addTombstone, readTombstones, writeTombstones } from '../lib/tombstones.mjs'
import { LOG_NAME, canonicalize, localSessionDir, mirrorLogPath } from '../lib/store.mjs'

// --- helpers ---------------------------------------------------------------

function makeLog(cwd, id, { createdAt = Date.now() } = {}) {
  const header = { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'text', seq: 0 })}\n`)))
  return Buffer.concat(frames)
}

/** Записать сессию; mtime при необходимости состарить (updatedAt для H3). */
async function writeSession(home, cwd, id, bytes, { mtime } = {}) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, LOG_NAME)
  await writeFile(path, bytes)
  if (mtime !== undefined) await utimes(path, new Date(mtime), new Date(mtime))
  return dir
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-m0-b-'))
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

function mirrorSessionDir(shared, id) {
  return join(shared, 'sessions', 'alpha', id)
}

async function addManualTombstone(shared, id, options = {}) {
  const tombstones = await readTombstones(shared)
  addTombstone(tombstones, id, options.device ?? 'device-b', {
    reason: options.reason ?? 'manual',
    by: options.by ?? 'owner',
    ...(options.at === undefined ? {} : { at: options.at }),
  })
  await writeTombstones(shared, tombstones)
}

// --- H3: метка удаления сильнее присутствия копии --------------------------

test('H3: метку можно снять только у сессии новее метки, а made-local — никогда', () => {
  const markAt = Date.now()
  const mark = { at: new Date(markAt).toISOString(), reason: 'manual', by: 'owner', device: 'd' }

  assert.equal(tombstoneBlocksSession(mark, markAt - 1000), true, 'старая копия не снимает метку')
  assert.equal(canDropTombstone(mark, markAt - 1000), false)
  assert.equal(tombstoneBlocksSession(mark, markAt + 1000), false, 'сессия новее метки')
  assert.equal(canDropTombstone(mark, markAt + 1000), true)
  assert.equal(canDropTombstone(mark, undefined), false, 'без времени метка сильнее')
  assert.equal(tombstoneBlocksSession(mark, undefined), true)

  // «Локальная» сессия не воскресает: метку не снимаем даже у новой сессии.
  const madeLocal = { at: new Date(markAt).toISOString(), reason: 'made-local', by: 'owner', device: 'd' }
  assert.equal(tombstoneBlocksSession(madeLocal, markAt + 86_400_000), true)
  assert.equal(canDropTombstone(madeLocal, markAt + 86_400_000), false)

  // Снятая метка (restored) историю не отменяет, но и не действует.
  assert.equal(canDropTombstone({ ...mark, reason: 'restored' }, markAt + 1000), false)

  // Время сессии: учитываются createdAt/updatedAt/mtime.
  assert.equal(sessionTimestamp({ createdAt: markAt, updatedAt: markAt + 50, mtimeMs: markAt + 20 }), markAt + 50)
  assert.equal(sessionTimestamp({}), undefined)
})

test('H3 push: старая копия не снимает метку, новая — снимает', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const oldAt = Date.now() - 3_600_000
    // Старая сессия: заголовок и mtime старше будущей метки удаления.
    await writeSession(env.home, env.projectPath, id, makeLog(env.projectPath, id, { createdAt: oldAt }), { mtime: oldAt })
    await push({ home: env.home, config: env.config })
    assert.equal(existsSync(mirrorLogPath(env.shared, 'alpha', id)), true, 'копия в зеркале')

    // Другое устройство удалило сессию: метка + карантин вместо живой копии.
    await addManualTombstone(env.shared, id)
    await rm(mirrorSessionDir(env.shared, id), { recursive: true, force: true })

    const old = await push({ home: env.home, config: env.config })
    assert.equal(old.pushed, 1, 'старая копия вернулась в зеркало')
    assert.ok((await readTombstones(env.shared)).sessions[id], 'метка удаления не снята старой копией')
    assert.equal(old.errorKind, undefined, 'без ошибок errorKind не выставляется')

    // Сессию создали заново: заголовок новее метки — удаление устарело.
    await writeSession(env.home, env.projectPath, id, makeLog(env.projectPath, id, { createdAt: Date.now() + 60_000 }))
    await push({ home: env.home, config: env.config })
    assert.equal((await readTombstones(env.shared)).sessions[id], undefined, 'новая сессия снимает метку')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('H3: made-local не снимается никогда — локальная сессия не воскресает', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    // Сессия новее метки — обычную метку это бы сняло, made-local — нет.
    await writeSession(env.home, env.projectPath, id, makeLog(env.projectPath, id, { createdAt: Date.now() + 60_000 }))
    await addManualTombstone(env.shared, id, { reason: 'made-local' })

    await push({ home: env.home, config: env.config })
    const pushed = await readTombstones(env.shared)
    assert.ok(pushed.sessions[id], 'метка made-local не снята отправкой')
    assert.equal(pushed.sessions[id].reason, 'made-local', 'причина сохранена')

    // Приём тоже не воскрешает: копия в зеркале новее метки, но локальная
    // сессия остаётся на месте.
    const localDir = localSessionDir(env.home, env.projectPath, id)
    const pulled = await pull({ home: env.home, config: env.config })
    assert.equal(pulled.deleted ?? 0, 0, 'по метке made-local локальные данные не удаляются')
    assert.equal(existsSync(localDir), true, 'локальная копия на месте')
    assert.ok((await readTombstones(env.shared)).sessions[id], 'метка made-local осталась')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('H3 pull: копия с активной меткой не импортируется, пока не станет новее', async () => {
  const env = await makeEnvironment()
  try {
    const staleId = `session-${randomUUID()}`
    const freshId = `session-${randomUUID()}`
    await mkdir(mirrorSessionDir(env.shared, staleId), { recursive: true })
    await writeFile(
      join(mirrorSessionDir(env.shared, staleId), LOG_NAME),
      canonicalize(makeLog(env.projectPath, staleId, { createdAt: Date.now() - 3_600_000 }), 'alpha'),
    )
    await addManualTombstone(env.shared, staleId)
    // Вторая копия появилась позже метки — её приём законен, метка снимается.
    await mkdir(mirrorSessionDir(env.shared, freshId), { recursive: true })
    await writeFile(
      join(mirrorSessionDir(env.shared, freshId), LOG_NAME),
      canonicalize(makeLog(env.projectPath, freshId, { createdAt: Date.now() + 60_000 }), 'alpha'),
    )
    await addManualTombstone(env.shared, freshId)

    const summary = await pull({ home: env.home, config: env.config })
    assert.equal(summary.imported, 1, 'импортируется только сессия новее метки')
    assert.equal(existsSync(localSessionDir(env.home, env.projectPath, staleId)), false, 'старая копия не воскресла')
    assert.equal(existsSync(localSessionDir(env.home, env.projectPath, freshId)), true, 'новая копия приехала')
    assert.equal(summary.pendingDeletion, 1, 'удержанная копия посчитана как ждущая удаления')

    const tombstones = await readTombstones(env.shared)
    assert.ok(tombstones.sessions[staleId], 'метка старой копии сохранена')
    assert.equal(tombstones.sessions[freshId], undefined, 'устаревшая метка снята при приёме')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- H7: формат-гард -------------------------------------------------------

test('H7: формат читается из dsh.format, у старых зеркал — из projects.version', () => {
  assert.equal(readMirrorFormat({ version: 1, projects: {}, dsh: { format: 5 } }), 5)
  assert.equal(readMirrorFormat({ version: 3, projects: {} }), 3)
  assert.equal(readMirrorFormat({ version: 1, projects: {}, dsh: {} }), 1)
  assert.equal(readMirrorFormat({ projects: {} }), undefined)
  assert.equal(readMirrorFormat(undefined), undefined)
})

test('H7 push: более новый формат зеркала блокирует отправку с errorKind=format', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, id, makeLog(env.projectPath, id))
    await writeFile(
      join(env.shared, 'projects.json'),
      `${JSON.stringify({ version: 1, projects: {}, dsh: { version: '9.9.9', format: 5 } }, null, 2)}\n`,
      'utf8',
    )

    const blocked = await push({ home: env.home, config: env.config })
    assert.equal(blocked.ok, false, 'отправка заблокирована')
    assert.equal(blocked.errorKind, 'format')
    assert.equal(blocked.format, 5)
    assert.equal(blocked.supportedFormat, 4)
    assert.match(blocked.message, /более новый формат/)
    assert.equal(blocked.guarded.length, 1, 'удержанная сессия видна панели')
    assert.equal(blocked.pushed, 0)
    assert.equal(existsSync(mirrorLogPath(env.shared, 'alpha', id)), false, 'в новое зеркало ничего не записано')
    const meta = JSON.parse(await readFile(join(env.shared, 'projects.json'), 'utf8'))
    assert.equal(meta.dsh.format, 5, 'отметка формата не понижена')

    // Старое зеркало без dsh.format: версия схемы — тоже признак формата.
    const legacy = await makeEnvironment()
    try {
      const legacyId = `session-${randomUUID()}`
      await writeSession(legacy.home, legacy.projectPath, legacyId, makeLog(legacy.projectPath, legacyId))
      await writeFile(join(legacy.shared, 'projects.json'), `${JSON.stringify({ version: 9, projects: {} })}\n`, 'utf8')
      const legacyBlocked = await push({ home: legacy.home, config: legacy.config })
      assert.equal(legacyBlocked.ok, false)
      assert.equal(legacyBlocked.errorKind, 'format')
      assert.equal(existsSync(mirrorLogPath(legacy.shared, 'alpha', legacyId)), false)
    } finally {
      await rm(legacy.root, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- H9: errorKind и счётчик failures --------------------------------------

test('H9: ошибки классифицируются в категории контракта', () => {
  assert.deepEqual(ERROR_KINDS.slice(0, 5), ['network', 'auth', 'format', 'guard', 'reserve'])
  assert.equal(classifyErrorKind('нет соединения: ENOTFOUND api.github.com'), 'network')
  assert.equal(classifyErrorKind('HTTP 503 Service Unavailable'), 'network')
  assert.equal(classifyErrorKind('HTTP 403: Bad credentials'), 'auth')
  assert.equal(classifyErrorKind('unauthorized: проверьте токен'), 'auth')
  assert.equal(classifyErrorKind('зеркало использует более новый формат логов'), 'format')
  assert.equal(classifyErrorKind('зеркало не перезаписано: 1 (session-x: лог короче)'), 'guard')
  assert.equal(classifyErrorKind({ errorKind: 'reserve', message: 'что угодно' }), 'reserve')
  assert.equal(classifyErrorKind({ message: 'резерв недоступен', secondaryError: 'HTTP 500' }), 'reserve')
  assert.equal(classifyErrorKind('не задан адрес репозитория'), 'unknown')
  assert.equal(classifyErrorKind({ ok: false, message: 'boom', format: 5, supportedFormat: 4 }), 'format')
})

test('H9: failures растёт при ошибках и сбрасывается успехом', () => {
  const first = failureState({ ok: false, message: 'ECONNREFUSED 127.0.0.1:443' })
  assert.equal(first.failures, 1)
  assert.equal(first.errorKind, 'network')

  const second = failureState({ ok: false, message: 'HTTP 401' }, { failures: 1 })
  assert.equal(second.failures, 2)
  assert.equal(second.errorKind, 'auth')

  const success = failureState({ ok: true }, { failures: 7 })
  assert.equal(success.failures, 0)
  assert.equal(success.errorKind, '')

  // Повторная запись того же запуска (child → host) счётчик не увеличивает.
  const sameRun = failureState(
    { ok: false, runId: 'run-1', message: 'boom' },
    { failures: 3, runId: 'run-1' },
  )
  assert.equal(sameRun.failures, 3)

  // Успех основного канала с проблемой резерва сохраняет вид ошибки.
  const degraded = failureState({ ok: true, runId: 'run-2', errorKind: 'reserve' }, { failures: 0 })
  assert.equal(degraded.failures, 0)
  assert.equal(degraded.errorKind, 'reserve')
})

test('H9: last-run и history хранят errorKind/failures, успех их сбрасывает', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-m0-b-history-'))
  try {
    await recordRun(home, { ok: false, action: 'sync', mode: 'child', runId: 'r1', message: 'ECONNREFUSED 127.0.0.1' })
    let last = await readLastRun(home)
    assert.equal(last.failures, 1)
    assert.equal(last.errorKind, 'network')

    await recordRun(home, { ok: false, action: 'sync', mode: 'child', runId: 'r2', message: 'HTTP 403: Bad credentials' })
    last = await readLastRun(home)
    assert.equal(last.failures, 2)
    assert.equal(last.errorKind, 'auth')

    // Host дописывает тот же запуск (тот же runId): счётчик не растёт, журнал
    // не дублируется.
    await recordRun(home, { ok: false, action: 'sync', mode: 'child', runId: 'r2', message: 'HTTP 403: Bad credentials; привязано' })
    last = await readLastRun(home)
    assert.equal(last.failures, 2, 'один запуск — один инкремент')
    assert.equal((await readHistory(home, 10)).length, 2, 'один запуск — одна строка журнала')

    await recordRun(home, { ok: true, action: 'sync', mode: 'child', runId: 'r3', message: 'ok' })
    last = await readLastRun(home)
    assert.equal(last.failures, 0, 'успех сбрасывает счётчик')
    assert.equal(last.errorKind, '', 'у успеха нет вида ошибки')

    const history = await readHistory(home, 10)
    assert.equal(history.length, 3)
    assert.equal(history.at(-1).failures, 0)
    assert.equal(typeof last.failures, 'number')
    assert.equal(typeof last.errorKind, 'string')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// --- H10: одна запись запуска ----------------------------------------------

test('H10: в sync-child.mjs ровно один вызов recordRun', async () => {
  const source = await readFile(fileURLToPath(new URL('../lib/sync-child.mjs', import.meta.url)), 'utf8')
  const calls = source.match(/await\s+recordRun\s*\(/g) ?? []
  assert.equal(calls.length, 1, 'двойная запись запуска убрана — остался один вызов')
})

test('H10: дочерний процесс пишет один запуск — одна строка журнала', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, id, makeLog(env.projectPath, id))
    const script = fileURLToPath(new URL('../lib/sync-child.mjs', import.meta.url))

    const runChild = (action = 'push') => {
      const child = spawnSync(process.execPath, [script, action], {
        env: { ...process.env, DSH_HOME: env.home },
        encoding: 'utf8',
        timeout: 120_000,
      })
      const line = child.stdout.trim().split('\n').filter(part => part.trim().startsWith('{')).pop()
      return { status: child.status, stderr: child.stderr, result: JSON.parse(line) }
    }

    const first = runChild('push')
    assert.equal(first.status, 0, `дочерний процесс завершился: ${first.stderr}`)
    assert.equal(first.result.ok, true)
    assert.equal(typeof first.result.failures, 'number')
    assert.equal(typeof first.result.errorKind, 'string')
    assert.equal(first.result.errorKind, '')

    let last = await readLastRun(env.home)
    assert.equal(last.failures, 0)
    assert.equal(last.errorKind, '')
    assert.equal(typeof last.runId, 'string', 'у запуска есть runId для дедупликации')
    let history = await readHistory(env.home, 10)
    assert.equal(history.length, 1, 'один запуск — одна строка журнала')

    const second = runChild('pull')
    assert.equal(second.status, 0, `дочерний процесс завершился: ${second.stderr}`)
    history = await readHistory(env.home, 10)
    assert.equal(history.length, 2, 'второй запуск добавляет ровно одну строку')
    assert.notEqual(history[0].runId, history[1].runId)

    // Ошибка запуска тоже пишется один раз (и счётчик failures = 1).
    const failing = await makeEnvironment()
    try {
      await saveConfig(failing.home, {
        ...failing.config,
        backend: 'git',
        remote: '',
      })
      const child = spawnSync(process.execPath, [script, 'push'], {
        env: { ...process.env, DSH_HOME: failing.home },
        encoding: 'utf8',
        timeout: 120_000,
      })
      assert.equal(child.status, 1, `ожидалась ошибка: ${child.stderr}`)
      const line = child.stdout.trim().split('\n').filter(part => part.trim().startsWith('{')).pop()
      const failed = JSON.parse(line)
      assert.equal(failed.ok, false)
      const failedLast = await readLastRun(failing.home)
      assert.equal(failedLast.failures, 1)
      assert.equal(typeof failedLast.errorKind, 'string')
      assert.equal((await readHistory(failing.home, 10)).length, 1, 'ошибка записана один раз')
    } finally {
      await rm(failing.root, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
