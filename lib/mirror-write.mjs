/**
 * Единая точка записи в зеркало: один межпроцессный лок для всех писателей.
 *
 * До M9-B лок `sync.lock` брал только дочерний процесс синхронизации
 * (`lib/sync-child.mjs`), а host-часть писала в зеркало напрямую: восстановление,
 * удаление облачной копии, смена режима, дубли, подтверждённые удаления, профиль.
 * Параллельная синхронизация в другом процессе делала `fetch+reset` поверх чужих
 * незакоммиченных надгробий (и роняла git `index.lock`).
 *
 * Теперь все записи идут через `withMirrorLock(home, action, fn)`:
 *
 * - лок — существующий `acquireLock` из `lib/lock.mjs` (pid + heartbeat,
 *   бросок снимается по 5 минутам молчания);
 * - каталог лока тот же, что у child (`<DSH_HOME>/dsh-sync/sync.lock`), поэтому
 *   host и отдельный процесс синхронизации ждут друг друга, а не пишут вместе;
 * - занятый лок не роняет действие: ждём до 30 с (опрос), затем возвращаем
 *   `{ ok: false, busy: true, code: 'mirror/busy', message }` — функция `fn`
 *   при этом не вызывается;
 * - вложенный вызов в том же процессе лок второй раз не берёт (контекст
 *   `AsyncLocalStorage`): обёртки можно наслаивать, deadlock исключён;
 * - исключение внутри `fn` лок всё равно освобождает.
 *
 * Дочерний процесс синхронизации использует тот же `withMirrorLock`, поэтому
 * двойного лока (host + child) нет: host не держит лок, пока ждёт child;
 * лок берёт тот процесс, который в этот момент пишет в зеркало.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, LOCK_NAME, LOCK_STALE_MS, LOCK_HEARTBEAT_MS } from './lock.mjs'

/** Сколько ждём занятый лок, прежде чем честно вернуть busy. */
export const MIRROR_LOCK_WAIT_MS = 30_000
/** Интервал опроса занятого лока. */
export const MIRROR_LOCK_POLL_MS = 150
/** Код «зеркало занято другой операцией» — для панели и тестов. */
export const MIRROR_BUSY_CODE = 'mirror/busy'

/**
 * Лок, который уже держит текущий вызов с его вложенными действиями. Набор
 * каталогов: вложенный `withMirrorLock` по тому же каталогу — это продолжение
 * той же записи, второй лок там был бы deadlock.
 */
const heldLocks = new AsyncLocalStorage()

/** Каталог состояния синхронизации: там же лежит `sync.lock`. */
export function mirrorStateDir(home) {
  const base = typeof home === 'string' && home.trim() !== ''
    ? home.trim()
    : (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh'))
  return join(base, 'dsh-sync')
}

/** Путь каталога лока. */
export function mirrorLockPath(home) {
  return join(mirrorStateDir(home), LOCK_NAME)
}

/**
 * Порог ожидания: тесты и аварийные прогоны могут переопределить окружением.
 * @param {{ waitMs?: number }} [options]
 */
export function mirrorLockWaitMs(options = {}) {
  if (typeof options.waitMs === 'number' && Number.isFinite(options.waitMs) && options.waitMs >= 0) {
    return options.waitMs
  }
  const raw = Number(process.env.DSH_SYNC_MIRROR_LOCK_WAIT_MS)
  if (Number.isFinite(raw) && raw >= 0) return raw
  return MIRROR_LOCK_WAIT_MS
}

/** Результат «занято»: действие не выполнялось, падать и бросать не нужно. */
export function mirrorBusyResult(action, details = {}) {
  const owner = typeof details.owner === 'string' && details.owner !== '' ? details.owner : ''
  const who = owner === '' ? 'другая операция' : `операция ${owner}`
  return {
    ok: false,
    busy: true,
    skipped: true,
    code: MIRROR_BUSY_CODE,
    action,
    waitedMs: Number(details.waitedMs ?? 0) || 0,
    message: details.message ?? `зеркало занято: ${who} выполняется, повторите через минуту`,
  }
}

/** Возвращает true, если текущий вызов уже держит лок этого каталога. */
export function isMirrorLockHeld(home) {
  const store = heldLocks.getStore()
  return store !== undefined && store.has(mirrorStateDir(home))
}

/**
 * Прочитать владельца лока, не меняя его. `undefined` — лока нет или файл
 * владельца ещё не записан (тогда лок считается свободным: его снимет
 * `acquireLock` как брошенный).
 *
 * @returns {Promise<{ dir: string, path: string, owner: string, pid: number, at: number, stale: boolean } | undefined>}
 */
export async function readMirrorLock(home, options = {}) {
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const path = mirrorLockPath(home)
  let info
  try {
    info = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'))
  } catch {
    return undefined
  }
  const at = typeof info?.at === 'number' ? info.at : 0
  const pid = typeof info?.pid === 'number' ? info.pid : 0
  const owner = typeof info?.owner === 'string' ? info.owner : ''
  let stale = !(now() - at <= staleMs)
  // Владелец мог быть убит (перезапуск DSH, диспетчер задач) — такой лок
  // `acquireLock` снимет сразу; для быстрой проверки он тоже не «занят».
  if (!stale && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0)
    } catch {
      stale = true
    }
  }
  return { dir: mirrorStateDir(home), path, owner, pid, at, stale }
}

/**
 * Быстрая проверка «зеркало занято?» без взятия лока и без ожидания.
 * Нужна действиям, которые запускают дочерний процесс синхронизации: второго
 * child не спавним, если лок уже держит другой писатель (child всё равно
 * подождёт и вернёт `skipped`, но это лишний процесс и лишние 30 с).
 *
 * @returns {Promise<{ owner: string, pid: number, at: number } | undefined>}
 */
export async function mirrorLockBusy(home, options = {}) {
  const info = await readMirrorLock(home, options)
  if (info === undefined || info.stale) return undefined
  return { owner: info.owner, pid: info.pid, at: info.at }
}

/** Пауза опроса. Таймер держит процесс: ожидание лока — это работа, а не фон. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Выполнить запись в зеркало под единым межпроцессным локом.
 *
 * @param {string} home каталог DSH (`DSH_HOME`)
 * @param {string} action подпись операции для `owner.json` и отчёта
 * @param {() => Promise<any>} fn что выполнить; вызывается только если лок взят
 * @param {{ waitMs?: number, pollMs?: number, owner?: string, staleMs?: number, heartbeatMs?: number, now?: () => number }} [options]
 *   waitMs — сколько ждать занятый лок (по умолчанию 30 с, окружение
 *   DSH_SYNC_MIRROR_LOCK_WAIT_MS), pollMs — интервал опроса, owner — подпись
 *   владельца, остальное уходит в `acquireLock` (тесты).
 * @returns {Promise<any>} результат `fn` либо `mirrorBusyResult`.
 */
export async function withMirrorLock(home, action, fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('withMirrorLock: нужна функция действия')
  const dir = mirrorStateDir(home)
  const store = heldLocks.getStore()
  if (store !== undefined && store.has(dir)) {
    // Вложенная запись той же операции: лок уже наш, второй раз не берём.
    return fn()
  }

  const waitMs = mirrorLockWaitMs(options)
  const pollMs = Math.max(1, Number(options.pollMs ?? MIRROR_LOCK_POLL_MS) || MIRROR_LOCK_POLL_MS)
  const owner = typeof options.owner === 'string' && options.owner !== '' ? options.owner : `host:${action}`
  const lockOptions = {}
  if (typeof options.staleMs === 'number') lockOptions.staleMs = options.staleMs
  if (typeof options.heartbeatMs === 'number') lockOptions.heartbeatMs = options.heartbeatMs
  if (typeof options.now === 'function') lockOptions.now = options.now

  const started = Date.now()
  const deadline = started + Math.max(0, waitMs)
  for (;;) {
    const lock = await acquireLock(dir, owner, lockOptions)
    if (lock !== undefined) {
      const next = new Set(store ?? [])
      next.add(dir)
      try {
        return await heldLocks.run(next, fn)
      } finally {
        // Освобождение — в finally: исключение внутри записи лок не оставляет.
        await lock.release().catch(() => {})
      }
    }
    const now = Date.now()
    if (now >= deadline) {
      const holder = await readMirrorLock(home, { staleMs: options.staleMs, now: options.now }).catch(() => undefined)
      return mirrorBusyResult(action, {
        owner: holder?.owner,
        waitedMs: Date.now() - started,
      })
    }
    await sleep(Math.min(pollMs, deadline - now))
  }
}

/** Heartbeat и stale пробрасываются для тестов таймаутов. */
export { LOCK_STALE_MS, LOCK_HEARTBEAT_MS }
