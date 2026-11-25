/**
 * M9-B: единый межпроцессный лок всех писателей зеркала.
 *
 * Что проверяем:
 * - `lib/mirror-write.mjs`: `withMirrorLock(home, action, fn)` выполняет действие
 *   под локом `~/.dsh/dsh-sync/sync.lock`, а после — освобождает его;
 * - занятый лок не роняет действие: ждёт до порога (30 с по умолчанию, в тестах
 *   короче) и возвращает `{ ok:false, busy:true, code:'mirror/busy' }`, не
 *   вызывая `fn`;
 * - после освобождения лока следующая операция проходит;
 * - вложенный вызов в той же операции лок второй раз не берёт (нет deadlock);
 * - исключение внутри записи лок не оставляет;
 * - два РАЗНЫХ процесса-писателя не перемешивают строки зеркала (лок общий,
 *   межпроцессный);
 * - host не держит лок, пока ждёт child-процесс: cross-process сценарий
 *   «child пишет → host ждёт → host пишет» завершается без deadlock;
 * - маршруты restore/mode/duplicates/cloud-copy/local-only-migration/prune/run
 *   при занятом локе отвечают busy и не начинают действие;
 * - статическая сверка: все перечисленные писатели в `index.js` обёрнуты
 *   `mirrorWrite`/`withMirrorLock`, а `lib/sync-child.mjs` использует тот же
 *   `withMirrorLock` без сырого `acquireLock`.
 *
 * Запуск: node --import ./test/setup.mjs --test test/mirror-lock.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { acquireLock } from '../lib/lock.mjs'
import {
  MIRROR_BUSY_CODE,
  MIRROR_LOCK_WAIT_MS,
  isMirrorLockHeld,
  mirrorLockBusy,
  mirrorStateDir,
  readMirrorLock,
  withMirrorLock,
} from '../lib/mirror-write.mjs'

// --- helpers ---------------------------------------------------------------

const MIRROR_MODULE = pathToFileURL(fileURLToPath(new URL('../lib/mirror-write.mjs', import.meta.url))).href

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function makeHome(prefix = 'dsh-mirror-lock-') {
  return mkdtemp(join(tmpdir(), prefix))
}

const lockDirOf = (home) => join(home, 'dsh-sync', 'sync.lock')

/** Записать owner.json так, как это делает acquireLock (для «чужого» лока). */
async function writeLockOwner(home, { pid = process.pid, at = Date.now(), owner = 'test-holder' } = {}) {
  const dir = lockDirOf(home)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'owner.json'), `${JSON.stringify({ pid, at, owner })}\n`, 'utf8')
  return dir
}

/** Убитый pid: запускаем короткий процесс и дожидаемся выхода. */
async function deadPid() {
  const result = await runNode(['-e', 'process.exit(0)'])
  assert.equal(result.code, 0)
  return result.pid
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const pid = child.pid
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: -1, pid, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => resolve({ code, pid, stdout, stderr }))
  })
}

async function waitForFile(file, needle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const text = await readFile(file, 'utf8')
      if (text.includes(needle)) return text
    } catch {
      // файла ещё нет — ждём
    }
    if (Date.now() >= deadline) throw new Error(`не дождались «${needle}» в ${file}`)
    await sleep(25)
  }
}

// --- 1. базовый контракт withMirrorLock ------------------------------------

test('лок: действие выполняется под локом и лок освобождается', async () => {
  const home = await makeHome()
  try {
    const inside = {}
    const result = await withMirrorLock(home, 'restore', async () => {
      inside.lockExists = existsSync(lockDirOf(home))
      inside.owner = JSON.parse(await readFile(join(lockDirOf(home), 'owner.json'), 'utf8'))
      return { ok: true, value: 42 }
    })
    assert.deepEqual(result, { ok: true, value: 42 })
    assert.equal(inside.lockExists, true, 'пока действие идёт, лок существует')
    assert.equal(inside.owner.owner, 'host:restore', 'в owner.json — подпись операции')
    assert.equal(inside.owner.pid, process.pid)
    assert.equal(existsSync(lockDirOf(home)), false, 'после действия лок снят')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('лок: занятый лок — ждём до порога, затем busy без выполнения действия', async () => {
  const home = await makeHome()
  const holder = await acquireLock(mirrorStateDir(home), 'child:push')
  assert.notEqual(holder, undefined, 'тестовый владелец взял лок')
  try {
    let ran = 0
    const started = Date.now()
    const result = await withMirrorLock(home, 'restore', async () => {
      ran += 1
      return { ok: true }
    }, { waitMs: 180, pollMs: 20 })
    const elapsed = Date.now() - started

    assert.equal(ran, 0, 'действие не выполнялось')
    assert.equal(result.busy, true)
    assert.equal(result.ok, false)
    assert.equal(result.code, MIRROR_BUSY_CODE)
    assert.match(result.message, /занят/)
    assert.match(result.message, /child:push/, 'в сообщении видно, кто держит лок')
    assert.ok(elapsed >= 150, `ждали не меньше порога: ${elapsed} мс`)
    assert.ok(elapsed < 5000, `не зависли: ${elapsed} мс`)
  } finally {
    await holder.release()
    await rm(home, { recursive: true, force: true })
  }
})

test('лок: пока первый писатель работает, второй ждёт и выполняется после', async () => {
  const home = await makeHome()
  try {
    const order = []
    const first = withMirrorLock(home, 'push', async () => {
      order.push('first-start')
      await sleep(180)
      order.push('first-end')
      return 'first'
    }, { waitMs: 5000, pollMs: 15 })
    await sleep(20)
    const second = withMirrorLock(home, 'restore', async () => {
      order.push('second')
      return 'second'
    }, { waitMs: 5000, pollMs: 15 })

    assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
    assert.deepEqual(order, ['first-start', 'first-end', 'second'], 'второй писатель не пересекается с первым')
    assert.equal(existsSync(lockDirOf(home)), false, 'лок освобождён')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('лок: следующая операция проходит после освобождения (ожидание, а не busy)', async () => {
  const home = await makeHome()
  try {
    const holder = await acquireLock(mirrorStateDir(home), 'child:sync')
    const waiting = withMirrorLock(home, 'mode', async () => 'done', { waitMs: 5000, pollMs: 15 })
    await sleep(250)
    await holder.release()
    assert.equal(await waiting, 'done', 'дождались освобождения и выполнили действие')
    assert.equal(existsSync(lockDirOf(home)), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('лок: вложенный вызов в той же операции не берёт лок второй раз (нет deadlock)', async () => {
  const home = await makeHome()
  try {
    assert.equal(isMirrorLockHeld(home), false, 'вне действия лок не удерживается')
    const result = await withMirrorLock(home, 'mode', async () => {
      assert.equal(isMirrorLockHeld(home), true, 'внутри действия лок удерживается')
      const inner = await withMirrorLock(home, 'local-only', async () => {
        // Если бы вложенный вызов ждал лок, короткий порог дал бы busy.
        return withMirrorLock(home, 'profile', async () => 'deep', { waitMs: 40 })
      }, { waitMs: 40 })
      return inner
    }, { waitMs: 2000 })
    assert.equal(result, 'deep')
    assert.equal(isMirrorLockHeld(home), false, 'после действия лок не удерживается')
    assert.equal(existsSync(lockDirOf(home)), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('лок: исключение внутри действия не оставляет лок и не ломает следующую операцию', async () => {
  const home = await makeHome()
  try {
    await assert.rejects(
      withMirrorLock(home, 'restore', async () => { throw new Error('boom') }),
      /boom/,
    )
    assert.equal(existsSync(lockDirOf(home)), false, 'лок снят в finally')
    assert.equal(await withMirrorLock(home, 'restore', async () => 'next', { waitMs: 500 }), 'next')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('лок: порог по умолчанию — 30 с, брошенный лок не блокирует писателя', async () => {
  assert.equal(MIRROR_LOCK_WAIT_MS, 30_000)
  const home = await makeHome()
  try {
    // Лок от убитого процесса: pid не существует — владелец не считается живым.
    const pid = await deadPid()
    await writeLockOwner(home, { pid, at: Date.now(), owner: 'child:push' })
    assert.equal(await mirrorLockBusy(home), undefined, 'мёртвый владелец не считается занятостью')
    const info = await readMirrorLock(home)
    assert.equal(info.stale, true)
    assert.equal(await withMirrorLock(home, 'restore', async () => 'ok', { waitMs: 1000 }), 'ok')
    assert.equal(existsSync(lockDirOf(home)), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('лок: mirrorLockBusy видит живой чужой лок, не меняя его', async () => {
  const home = await makeHome()
  try {
    await writeLockOwner(home, { pid: process.pid, owner: 'child:push' })
    const busy = await mirrorLockBusy(home)
    assert.equal(busy.owner, 'child:push')
    assert.equal(busy.pid, process.pid)
    // Проверка только читает: владелец на месте, файл не переписан.
    const info = JSON.parse(await readFile(join(lockDirOf(home), 'owner.json'), 'utf8'))
    assert.equal(info.owner, 'child:push')
    // Просроченный лок (старше 5 минут) занятостью не считается.
    await writeLockOwner(home, { pid: process.pid, owner: 'child:push', at: Date.now() - 6 * 60_000 })
    assert.equal(await mirrorLockBusy(home), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('лок: одновременные захваты не отбирают лок друг у друга', async () => {
  const home = await makeHome()
  const dir = mirrorStateDir(home)
  try {
    // Каталог лока без owner.json — сосед между mkdir и записью владельца.
    const path = join(dir, 'sync.lock')
    await mkdir(path, { recursive: true })
    assert.equal(await acquireLock(dir, 'second'), undefined, 'свежий лок не отбираем')
    // Такой же каталог, но старый, — мусор от упавшего процесса: снимаем.
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    const lock = await acquireLock(dir, 'second', { createGraceMs: 1000 })
    assert.ok(lock, 'брошенный каталог без владельца снимается')
    await lock.release()

    // Шесть одновременных захватов: лок берёт ровно один, остальные ждут.
    const locks = await Promise.all(Array.from({ length: 6 }, (_, index) => acquireLock(dir, `writer-${index}`)))
    const taken = locks.filter((handle) => handle !== undefined)
    assert.equal(taken.length, 1, 'лок достался только одному писателю')
    await taken[0].release()
    assert.equal(existsSync(path), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// --- 2. межпроцессные писатели --------------------------------------------

/**
 * Скрипт писателя: пишет строку зеркала В ДВА ПРИЁМА с паузой. Без общего лока
 * строки двух процессов перемешались бы — файл зеркала стал бы битым.
 */
const WRITER_SCRIPT = `
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withMirrorLock } from ${JSON.stringify(MIRROR_MODULE)}

const [home, name, countRaw] = process.argv.slice(2)
const count = Number(countRaw)
const file = join(home, 'mirror.jsonl')
await mkdir(home, { recursive: true })
const pad = 'x'.repeat(400)
for (let index = 0; index < count; index += 1) {
  const outcome = await withMirrorLock(home, 'push', async () => {
    await appendFile(file, name + '|' + index + '|')
    await new Promise((resolve) => setTimeout(resolve, 3))
    await appendFile(file, pad + '\\n')
  }, { waitMs: 20000, pollMs: 10 })
  if (outcome?.busy === true) {
    console.error('busy: ' + outcome.message)
    process.exit(3)
  }
}
process.exit(0)
`

test('два процесса-писателя: общий лок сериализует, зеркало не портится', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mirror-lock-proc-'))
  try {
    const home = join(root, 'home')
    const script = join(root, 'writer.mjs')
    await writeFile(script, WRITER_SCRIPT, 'utf8')

    const [first, second] = await Promise.all([
      runNode([script, home, 'A', '8']),
      runNode([script, home, 'B', '8']),
    ])
    assert.equal(first.code, 0, `писатель A: ${first.stderr}`)
    assert.equal(second.code, 0, `писатель B: ${second.stderr}`)

    const lines = (await readFile(join(home, 'mirror.jsonl'), 'utf8')).split('\n').filter((line) => line !== '')
    assert.equal(lines.length, 16, 'каждая запись осталась одной строкой')
    const counts = { A: 0, B: 0 }
    for (const line of lines) {
      const match = /^(A|B)\|(\d+)\|x{400}$/.exec(line)
      assert.ok(match, `строка не перемешана: ${JSON.stringify(line.slice(0, 48))}`)
      counts[match[1]] += 1
    }
    assert.deepEqual(counts, { A: 8, B: 8 }, 'оба писателя выполнили все записи')

    assert.equal(existsSync(lockDirOf(home)), false, 'лок освобождён после обоих процессов')
    assert.equal(await withMirrorLock(home, 'prune', async () => 'ok', { waitMs: 1000 }), 'ok')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Скрипт «child-пути»: держит лок, пока пишет события, затем отпускает.
 * Host в это время не держит лок и ждёт child — так работает runSync.
 */
const CHILD_HOLDER_SCRIPT = `
import { appendFile } from 'node:fs/promises'
import { withMirrorLock } from ${JSON.stringify(MIRROR_MODULE)}

const [home, events] = process.argv.slice(2)
await withMirrorLock(home, 'sync', async () => {
  await appendFile(events, 'child-start\\n')
  await new Promise((resolve) => setTimeout(resolve, 400))
  await appendFile(events, 'child-done\\n')
}, { waitMs: 10000, pollMs: 10 })
process.exit(0)
`

test('нет deadlock с child-путём: host ждёт child, затем пишет сам', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mirror-lock-child-'))
  try {
    const home = join(root, 'home')
    const events = join(root, 'events.log')
    const script = join(root, 'holder.mjs')
    await writeFile(script, CHILD_HOLDER_SCRIPT, 'utf8')

    const child = runNode([script, home, events])
    await waitForFile(events, 'child-start')
    // Host не берёт лок заранее: он дождётся child и только потом запишет сам.
    const started = Date.now()
    const result = await withMirrorLock(home, 'sync-host', async () => {
      await appendFile(events, 'parent\n')
      return 'parent-done'
    }, { waitMs: 8000, pollMs: 20 })
    const elapsed = Date.now() - started
    assert.equal(result, 'parent-done')
    assert.ok(elapsed >= 300, `host дождался child: ${elapsed} мс`)
    assert.ok(elapsed < 8000, `без deadlock: ${elapsed} мс`)

    const finished = await child
    assert.equal(finished.code, 0, `child завершился: ${finished.stderr}`)
    const order = (await readFile(events, 'utf8')).trim().split('\n')
    assert.deepEqual(order, ['child-start', 'child-done', 'parent'], 'child отпустил лок до записи host')
    assert.equal(existsSync(lockDirOf(home)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- 3. маршруты host-части под локом --------------------------------------

/** Минимальная host-часть плагина поверх фейкового ctx (как в M3-тестах). */
async function bootPlugin({ home, config }) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  await saveConfig(home, config)
  const { apply } = await import('../index.js')
  const routes = new Map()
  const cleanups = []
  const ctx = {
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    tools: { register: () => {} },
    get: (name) => (name === 'sessionPersistence' ? { list: async () => [] } : undefined),
  }
  apply(ctx)
  const call = async (path, payload) => {
    const route = routes.get(path)
    assert.notEqual(route, undefined, `маршрут ${path} зарегистрирован`)
    const response = await route.fetch(new Request(`http://local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }))
    return { status: response.status, body: await response.json() }
  }
  return {
    call,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          // таймеры уже сняты
        }
      }
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

async function makeRouteEnv() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mirror-lock-routes-'))
  const home = join(root, 'home')
  const projectPath = join(root, 'work', 'alpha')
  const repoDir = join(root, 'mirror')
  await mkdir(home, { recursive: true })
  await mkdir(projectPath, { recursive: true })
  await mkdir(repoDir, { recursive: true })
  const config = {
    ...defaultConfig(home),
    backend: 'folder',
    repoDir,
    deviceId: 'device-lock',
    profile: { enabled: false, autoApply: false },
    workspace: { enabled: false },
    autoSync: { ...defaultConfig(home).autoSync, enabled: false },
  }
  config.projects = { alpha: { path: projectPath, title: 'alpha' } }
  return { root, home, config }
}

test('маршруты-писатели: занятый лок — busy без начала действия, освободился — проходят', async () => {
  const env = await makeRouteEnv()
  const previousWait = process.env.DSH_SYNC_MIRROR_LOCK_WAIT_MS
  let boot
  try {
    // Короткий порог: тест не должен ждать 30 с на каждом маршруте.
    process.env.DSH_SYNC_MIRROR_LOCK_WAIT_MS = '60'
    boot = await bootPlugin({ home: env.home, config: env.config })
    const holder = await acquireLock(mirrorStateDir(env.home), 'child:push')
    try {
      const busyExpected = [
        ['/api/dsh-sync/restore', { ids: ['session-lock-1'] }, 409],
        ['/api/dsh-sync/session-mode', { id: 'session-lock-1', mode: 'cloud' }, 200],
        ['/api/dsh-sync/session-cloud-copy', { id: 'session-lock-1', confirm: true }, 409],
        ['/api/dsh-sync/duplicates/quarantine', { confirm: true }, 409],
        ['/api/dsh-sync/local-only-migration', { confirm: true }, 409],
        ['/api/dsh-sync/profile/apply', { action: 'apply' }, 409],
        ['/api/dsh-sync/prune', { confirm: true }, 500],
        ['/api/dsh-sync/plan', { action: 'plan' }, 200],
      ]
      for (const [path, payload, status] of busyExpected) {
        const result = await boot.call(path, payload)
        assert.equal(result.body?.busy, true, `${path}: busy`)
        assert.equal(result.body?.code, MIRROR_BUSY_CODE, `${path}: код busy`)
        assert.equal(result.body?.ok, false, `${path}: действие не выполнено`)
        assert.equal(result.status, status, `${path}: статус ${result.status}`)
        assert.match(String(result.body?.message ?? ''), /занят|выполняется/, `${path}: понятный текст`)
      }
      // Синхронизация не спавнит второй child: сразу busy и «пропущено».
      const started = Date.now()
      const run = await boot.call('/api/dsh-sync/run', { action: 'push' })
      assert.equal(run.body?.busy, true, 'run: busy')
      assert.equal(run.body?.skipped, true, 'run: такт пропущен, а не ошибка')
      assert.ok(Date.now() - started < 3000, 'run не ждал спавна child')
      assert.equal(existsSync(lockDirOf(env.home)), true, 'чужой лок остался на месте')
    } finally {
      await holder.release()
    }

    // После освобождения те же маршруты проходят (busy больше не отдаётся).
    const restore = await boot.call('/api/dsh-sync/restore', {})
    assert.equal(restore.body?.busy, undefined, 'restore: busy нет')
    assert.equal(restore.status, 400, 'restore: дошёл до проверки id')
    assert.deepEqual(
      [restore.body?.ok, restore.body?.code],
      [false, 'request/invalid'],
      'восстановление без id — обычная ошибка запроса, не busy',
    )
    const mode = await boot.call('/api/dsh-sync/session-mode', { id: 'session-lock-1', mode: 'cloud' })
    assert.equal(mode.body?.busy, undefined, 'mode: busy нет')
    assert.equal(mode.body?.ok, true, 'mode: действие выполнено после освобождения лока')
    assert.equal(existsSync(lockDirOf(env.home)), false, 'лок после маршрутов снят')
  } finally {
    boot?.dispose()
    if (previousWait === undefined) delete process.env.DSH_SYNC_MIRROR_LOCK_WAIT_MS
    else process.env.DSH_SYNC_MIRROR_LOCK_WAIT_MS = previousWait
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- 4. статическая сверка писателей ---------------------------------------

test('index.js: все писатели зеркала идут через mirrorWrite/withMirrorLock', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const wrapped = [
    "mirrorWrite('restore'",
    "mirrorWrite('cloud-copy'",
    "mirrorWrite('mode'",
    "mirrorWrite('duplicates'",
    "mirrorWrite('prune'",
    "mirrorWrite('profile'",
    "mirrorWrite('sync-host'",
  ]
  for (const pattern of wrapped) {
    assert.ok(source.includes(pattern), `есть обёртка ${pattern}`)
  }
  // «Локальная навсегда» — подготовка, сверка и миграция: минимум три записи.
  assert.ok((source.match(/mirrorWrite\('local-only'/g) ?? []).length >= 3, 'local-only обёрнут')

  // Host не держит лок, пока ждёт child: в runSync вызов runViaChild идёт
  // раньше единственной обёртки host-пути. Иначе child ждал бы наш лок.
  const runSyncStart = source.indexOf('async function runSync(')
  const runSyncEnd = source.indexOf('async function runSyncInHost(')
  assert.ok(runSyncStart > 0 && runSyncEnd > runSyncStart)
  const runSyncSource = source.slice(runSyncStart, runSyncEnd)
  const childCall = runSyncSource.indexOf('await runViaChild(')
  const hostLock = runSyncSource.indexOf("mirrorWrite('sync-host'")
  assert.ok(childCall > 0, 'runSync запускает child')
  assert.ok(hostLock > childCall, 'лок host-пути берётся только после child-пути')
})

test('sync-child: тот же withMirrorLock, без сырого acquireLock и двойного лока', async () => {
  const source = await readFile(new URL('../lib/sync-child.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ withMirrorLock \} from '\.\/mirror-write\.mjs'/)
  assert.equal(source.includes('acquireLock('), false, 'сырой acquireLock в child больше не используется')
  assert.equal((source.match(/withMirrorLock\(/g) ?? []).length, 1, 'лок берётся один раз')
  assert.match(source, /withMirrorLock\(home, action, runAction, \{ owner: `child:\$\{action\}` \}\)/)
  assert.match(source, /record\?\.busy === true/, 'child переводит busy в skipped')
})

test('lock: общий каталог лока у host и child — <DSH_HOME>/dsh-sync', async () => {
  const home = join(tmpdir(), 'dsh-mirror-lock-dir')
  assert.equal(mirrorStateDir(home), join(home, 'dsh-sync'))
  assert.equal(join(mirrorStateDir(home), 'sync.lock'), join(home, 'dsh-sync', 'sync.lock'))
})
