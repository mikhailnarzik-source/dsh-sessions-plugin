/**
 * Единый снапшот состояния панели (`/state` и `/sessions`).
 *
 * Раньше оба маршрута собирались независимо: каждый опрос заново читал
 * конфиг, реестр синхронизации и метаданные логов. Теперь один расчёт готовит
 * сразу оба ответа, а повторные вызовы получают готовый снапшот.
 *
 * Гарантии:
 * - single-flight: одновременные вызовы ждут один и тот же расчёт;
 * - TTL: значение моложе `ttlMs` отдаётся без пересчёта, если подпись цела;
 * - подпись: если изменился mtime/размер логов, ledger или надгробий, снапшот
 *   пересобирается сразу, не дожидаясь конца TTL (файлы меняет не только панель);
 * - `invalidate()`: явный сброс после операций (синхронизация, режим,
 *   восстановление, удаления) — панель видит результат сразу;
 * - отдаётся `{ at, value }`: `at` — когда собрано, `value` — что собрано.
 *
 * Модуль ничего не знает о DSH: сборку и подпись передаёт вызывающая сторона,
 * поэтому он тестируется без файловой системы.
 */
import { stat } from 'node:fs/promises'

/** TTL снапшота по умолчанию: столько панель показывает одно состояние. */
export const SNAPSHOT_TTL_MS = 5_000

/**
 * Подпись набора файлов: `путь:mtime:size` каждого. Меняется, когда логи
 * зеркала, ledger, журнал запусков или надгробия правились, — по ней снапшот
 * понимает, что кэш устарел, и не ждёт TTL.
 *
 * @param {string[]} paths файлы и каталоги (отсутствие файла — тоже состояние)
 * @returns {Promise<string>}
 */
export async function fileSignature(paths) {
  const parts = []
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== 'string' || path === '') continue
    try {
      const info = await stat(path)
      parts.push(`${path}:${info.mtimeMs}:${info.size}`)
    } catch {
      parts.push(`${path}:-`)
    }
  }
  return parts.join('|')
}

/**
 * Создать снапшот.
 *
 * @param {object} options
 * @param {() => Promise<any>} options.collect сборка значения (state + sessions)
 * @param {() => Promise<string>} [options.signature] подпись источников данных
 * @param {number} [options.ttlMs] TTL в миллисекундах (0 — пересчёт на каждый вызов)
 * @param {() => number} [options.now] часы (тесты подставляют управляемые)
 * @returns {{
 *   get: (options?: { force?: boolean }) => Promise<{ at: number, value: any }>,
 *   invalidate: (reason?: string) => void,
 *   peek: () => ({ at: number, value: any } | undefined),
 *   stats: () => object,
 *   ttlMs: number,
 * }}
 */
export function createStateSnapshot(options = {}) {
  const collect = options.collect
  if (typeof collect !== 'function') {
    throw new TypeError('createStateSnapshot: нужна функция collect')
  }
  const signature = typeof options.signature === 'function' ? options.signature : null
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0
    ? options.ttlMs
    : SNAPSHOT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** Текущий снапшот: { at, value, signature }. */
  let current = null
  /** Текущий расчёт (single-flight): одновременные вызовы ждут его. */
  let flight = null
  /** Поколение: invalidate во время расчёта не даёт сохранить устаревшее значение. */
  let generation = 0

  const counters = {
    collects: 0,
    hits: 0,
    waits: 0,
    invalidations: 0,
    signatureChecks: 0,
    lastCollectMs: 0,
    lastInvalidationReason: '',
  }

  function view(snapshot) {
    return { at: snapshot.at, value: snapshot.value }
  }

  async function readSignature() {
    if (signature === null) return ''
    counters.signatureChecks += 1
    try {
      const value = await signature()
      return typeof value === 'string' ? value : String(value ?? '')
    } catch {
      // Сломанная подпись не должна ронять панель: считаем, что изменений нет,
      // а TTL всё равно заставит пересобрать состояние.
      return ''
    }
  }

  async function collectSnapshot(generationAtStart) {
    counters.collects += 1
    const startedAt = now()
    const value = await collect()
    const snapshot = {
      at: now(),
      value,
      // Подпись берём ПОСЛЕ сборки: файлы, записанные самой сборкой (режимы,
      // рабочие пространства), не должны тут же объявлять снапшот устаревшим.
      signature: await readSignature(),
    }
    counters.lastCollectMs = Math.max(0, snapshot.at - startedAt)
    // Если за время расчёта случился invalidate — результат уже устарел,
    // в кэш его не кладём (но вызвавшему отдаём: данные всё равно свежие).
    if (generationAtStart === generation) current = snapshot
    return snapshot
  }

  /**
   * Получить снапшот. Одновременные вызовы разделяют один расчёт; при
   * `{ force: true }` значение пересобирается независимо от TTL и подписи.
   */
  async function get(getOptions = {}) {
    const force = getOptions?.force === true
    // single-flight: чужой расчёт уже идёт — ждём его, второй не запускаем.
    if (flight !== null) {
      counters.waits += 1
      return view(await flight)
    }
    if (!force && current !== null) {
      // Подпись проверяется на каждом вызове — она дешёвая (stat + метаданные
      // без чтения логов), зато изменение лога/ledger/надгробий видно сразу.
      const changed = (await readSignature()) !== current.signature
      // Моложе TTL и без изменений — отдаём готовое. Истёк TTL — собираем
      // заново даже при той же подписи: TTL ограничивает максимальную давность.
      if (!changed && now() - current.at < ttlMs) {
        counters.hits += 1
        return view(current)
      }
    }
    const generationAtStart = generation
    const pending = collectSnapshot(generationAtStart)
    flight = pending
    try {
      return view(await pending)
    } finally {
      if (flight === pending) flight = null
    }
  }

  /** Явно сбросить снапшот: следующее обращение соберёт состояние заново. */
  function invalidate(reason = '') {
    generation += 1
    current = null
    counters.invalidations += 1
    counters.lastInvalidationReason = typeof reason === 'string' ? reason : ''
  }

  /** Последнее собранное значение без запуска расчёта (диагностика). */
  function peek() {
    return current === null ? undefined : view(current)
  }

  /** Счётчики кэша: сколько раз собирали и сколько отдали готовое. */
  function stats() {
    return {
      ...counters,
      ttlMs,
      at: current?.at ?? null,
      hasValue: current !== null,
      collecting: flight !== null,
    }
  }

  return { get, invalidate, peek, stats, ttlMs }
}
