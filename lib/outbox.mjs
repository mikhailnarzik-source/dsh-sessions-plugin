/**
 * Очередь невыполненных операций синхронизации (outbox).
 *
 * Назначение: действие пользователя (отправка, удаление, восстановление,
 * смена режима) не должно теряться из-за офлайна. Если операция не удалась —
 * она ложится в `~/.dsh/dsh-sync/outbox.json`, а host-часть повторяет её при
 * старте, по таймеру и при закрытии DSH. Повтор — с нарастающей паузой
 * (backoff), чтобы офлайн не превратился в бесконечные попытки.
 *
 * Здесь только хранение и планирование: сами операции выполняет index.js,
 * передавая обработчики по типу операции.
 *
 * Дополнительно модуль умеет проверять единый интерфейс резервного канала
 * (H5): если у backend нет метода `sync`/`commit`/`remove`, операция не
 * вызывается вслепую, а получает понятное сообщение «резерв не поддерживает
 * операцию X». Сырое «remote.sync is not a function» в панель не попадает.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const OUTBOX_FILE = 'outbox.json'
export const OUTBOX_VERSION = 1
/** Сколько id помещается в одну операцию удаления: группа целиком, но без роста. */
export const OUTBOX_DELETE_IDS_LIMIT = 200
/** Сколько операций держим, чтобы файл не рос бесконечно. */
export const OUTBOX_LIMIT = 100
/** Типы операций: ровно те, что аудит требует в очереди. */
export const OUTBOX_TYPES = Object.freeze(['push', 'delete', 'mode', 'restore'])
/** После стольких попыток пауза выходит на максимум. */
export const OUTBOX_MAX_ATTEMPTS = 12
/** Базовая пауза перед повтором. */
export const OUTBOX_BASE_DELAY_MS = 30_000
/** Максимальная пауза между повторами — час. */
export const OUTBOX_MAX_DELAY_MS = 60 * 60_000
/** Таймаут одной операции по умолчанию (аудит: 5–10 с на закрытие). */
export const OUTBOX_OP_TIMEOUT_MS = 10_000
/** Таймаут flush при закрытии DSH: не держим выход дольше этого. */
export const OUTBOX_SHUTDOWN_TIMEOUT_MS = 8_000

/** Единый интерфейс бэкенда: какие методы обязательны. */
export const BACKEND_METHODS = Object.freeze(['list', 'sync', 'commit', 'remove'])
/** Человекочитаемые названия операций backend для сообщений. */
export const BACKEND_OPERATION_LABELS = Object.freeze({
  list: 'получение списка',
  sync: 'синхронизация',
  commit: 'фиксация изменений',
  remove: 'удаление из резерва',
  lightProbe: 'лёгкая сверка',
})

/** Путь к файлу очереди. */
export function outboxPath(home) {
  return join(home, 'dsh-sync', OUTBOX_FILE)
}

function isoNow(now) {
  const value = now instanceof Date ? now.getTime() : Number(now ?? Date.now())
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString()
}

/** Пауза перед следующей попыткой: 30 с, 60 с, 2 мин … не больше часа. */
export function backoffDelay(attempts, options = {}) {
  const base = Number.isFinite(options.baseMs) ? options.baseMs : OUTBOX_BASE_DELAY_MS
  const max = Number.isFinite(options.maxMs) ? options.maxMs : OUTBOX_MAX_DELAY_MS
  const count = Math.max(1, Math.trunc(Number(attempts) || 1))
  return Math.min(base * 2 ** (count - 1), max)
}

/**
 * Идентификаторы из payload операции удаления: `ids[]` (группа), а для старых
 * записей — одиночный `id`. Дубли и пустые значения отбрасываются.
 */
export function deletePayloadIds(payload) {
  const data = payload !== null && typeof payload === 'object' ? payload : {}
  const raw = Array.isArray(data.ids) ? data.ids : (data.id !== undefined ? [data.id] : [])
  const ids = []
  for (const value of raw) {
    const id = String(value ?? '').trim()
    if (id === '' || ids.includes(id)) continue
    ids.push(id)
    if (ids.length >= OUTBOX_DELETE_IDS_LIMIT) break
  }
  return ids
}

/** Payload операции удаления группы: всегда `ids[]`, прочие поля сохраняются. */
export function deleteOperationPayload(ids, extra = {}) {
  const payload = { ...(extra !== null && typeof extra === 'object' ? extra : {}) }
  const normalized = deletePayloadIds({ ids })
  // `id` мог остаться от старого формата: источник истины — `ids[]`.
  delete payload.id
  if (normalized.length > 0) payload.ids = normalized
  return payload
}

/** Стабильный ключ операции: по нему дубли не размножаются. */
export function operationKey(type, payload) {
  const kind = String(type ?? '').trim()
  if (!OUTBOX_TYPES.includes(kind)) return ''
  const data = payload !== null && typeof payload === 'object' ? payload : {}
  const parts = [kind]
  if (kind === 'push') {
    parts.push(String(data.action ?? 'push'))
    // Отправка в резерв — отдельная операция: не сливаем её с обычным push.
    parts.push(data.secondary === true ? 'secondary' : 'primary')
  }
  if (kind === 'mode') {
    parts.push(String(data.mode ?? 'cloud'))
    parts.push(Array.isArray(data.ids) ? [...data.ids].map(String).sort().join(',') : '')
  }
  if (kind === 'delete') {
    // Удаление облачной копии локальной сессии — отдельный сценарий: не сливаем
    // его с групповым удалением сессий.
    parts.push(data.cloudCopy === true ? 'cloud-copy' : 'group')
    // Одна операция — вся группа: ключ — отсортированный список id.
    parts.push(deletePayloadIds(data).sort().join(','))
  }
  if (kind === 'restore') {
    if (data.all === true) parts.push('all')
    else {
      const ids = Array.isArray(data.ids) ? data.ids : data.id !== undefined ? [data.id] : []
      parts.push([...ids].map(String).sort().join(','))
    }
  }
  return parts.join(':')
}

/** Проверить и нормализовать запись очереди. */
export function normalizeOperation(operation) {
  if (operation === null || typeof operation !== 'object') return undefined
  const type = typeof operation.type === 'string' ? operation.type.trim() : ''
  if (!OUTBOX_TYPES.includes(type)) return undefined
  const payload = operation.payload !== null && typeof operation.payload === 'object' ? { ...operation.payload } : {}
  // Удаление — всегда список id: так групповое удаление (родитель + дети)
  // переживает офлайн одной операцией, а старый формат `{id}` читается.
  if (type === 'delete') {
    const ids = deletePayloadIds(payload)
    if (ids.length > 0) payload.ids = ids
  }
  const attempts = Number(operation.attempts)
  const at = typeof operation.at === 'string' && operation.at !== '' ? operation.at : isoNow()
  const nextAt = typeof operation.nextAt === 'string' ? operation.nextAt : at
  const id = typeof operation.id === 'string' && operation.id !== '' ? operation.id : `${type}-${Date.parse(at) || Date.now()}`
  return {
    id,
    type,
    payload,
    at,
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 0,
    lastError: typeof operation.lastError === 'string' ? operation.lastError.slice(0, 500) : '',
    nextAt,
    ...(typeof operation.errorKind === 'string' && operation.errorKind !== '' ? { errorKind: operation.errorKind } : {}),
  }
}

/** Разобрать содержимое файла очереди: битый JSON — пустая очередь. */
export function parseOutbox(text) {
  if (typeof text !== 'string' || text.trim() === '') return { version: OUTBOX_VERSION, operations: [] }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { version: OUTBOX_VERSION, operations: [] }
  }
  const raw = Array.isArray(parsed?.operations) ? parsed.operations : []
  const operations = []
  const seen = new Set()
  for (const item of raw) {
    const operation = normalizeOperation(item)
    if (operation === undefined) continue
    const key = operationKey(operation.type, operation.payload)
    if (key !== '' && seen.has(key)) continue
    if (key !== '') seen.add(key)
    operations.push(operation)
    if (operations.length >= OUTBOX_LIMIT) break
  }
  return { version: OUTBOX_VERSION, operations }
}

/** Прочитать очередь: отсутствие файла — пустая очередь. */
export async function readOutbox(home) {
  const file = outboxPath(home)
  if (!existsSync(file)) return { version: OUTBOX_VERSION, operations: [] }
  try {
    return parseOutbox(await readFile(file, 'utf8'))
  } catch {
    return { version: OUTBOX_VERSION, operations: [] }
  }
}

/** Записать очередь (атомарность не критична: файл маленький и локальный). */
export async function writeOutbox(home, data) {
  const operations = Array.isArray(data?.operations) ? data.operations.slice(-OUTBOX_LIMIT) : []
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  await writeFile(outboxPath(home), `${JSON.stringify({ version: OUTBOX_VERSION, operations }, null, 2)}\n`, 'utf8')
  return operations.length
}

/**
 * Поставить операцию в очередь (или обновить уже стоящую с тем же ключом).
 * @returns {{ added: boolean, operation: object, count: number }}
 */
export async function enqueueOutbox(home, { type, payload = {}, at = Date.now(), error = '', errorKind = '' } = {}) {
  const operation = normalizeOperation({
    type,
    payload,
    at: isoNow(at),
    nextAt: isoNow(at),
    attempts: 0,
    lastError: error,
    errorKind,
  })
  if (operation === undefined) return { added: false, operation: undefined, count: 0 }
  const data = await readOutbox(home)
  const key = operationKey(operation.type, operation.payload)
  const existing = data.operations.find(item => operationKey(item.type, item.payload) === key)
  if (existing !== undefined) {
    // Операция уже в очереди: не размножаем, только обновляем текст ошибки и
    // возвращаем паузу на «сейчас», чтобы ближайший flush попробовал снова.
    existing.lastError = operation.lastError
    existing.nextAt = isoNow(at)
    existing.at = existing.at ?? operation.at
    if (operation.errorKind !== '') existing.errorKind = operation.errorKind
  } else {
    operation.id = `${operation.type}-${Date.now()}-${data.operations.length + 1}`
    data.operations.push(operation)
  }
  const count = await writeOutbox(home, data)
  return { added: existing === undefined, operation: existing ?? operation, count }
}

/**
 * Поставить в очередь удаление группы сессий (родитель + субагенты).
 *
 * Офлайн-удаление не должно размножать операции: все ещё не выполненные
 * групповые удаления сливаются в одну запись с общим списком `ids[]`, чтобы
 * повтор при flush применил группу целиком. Удаление облачной копии локальной
 * сессии (`payload.cloudCopy`) — отдельный сценарий, его не сливаем.
 *
 * @param home каталог DSH
 * @param ids id сессий группы (могут быть короткими — приводятся к строке)
 * @param options.error/errorKind — почему операция отложена
 * @param options.extra — дополнительные поля payload (например projectId)
 * @returns {{ added: boolean, operation?: object, ids: string[], count: number }}
 */
export async function enqueueDelete(home, ids, { at = Date.now(), error = '', errorKind = '', ...extra } = {}) {
  const data = await readOutbox(home)
  const incoming = deletePayloadIds({ ids })
  if (incoming.length === 0) {
    return { added: false, operation: undefined, ids: [], count: data.operations.length }
  }
  const groupOperations = data.operations.filter(item => item.type === 'delete' && item.payload?.cloudCopy !== true)
  const merged = []
  for (const id of incoming) merged.push(id)
  for (const operation of groupOperations) {
    for (const id of deletePayloadIds(operation.payload)) {
      if (!merged.includes(id)) merged.push(id)
    }
  }
  if (groupOperations.length > 0) {
    data.operations = data.operations.filter(item => !groupOperations.includes(item))
  }
  const operation = normalizeOperation({
    type: 'delete',
    payload: deleteOperationPayload(merged, extra),
    at: isoNow(at),
    nextAt: isoNow(at),
    attempts: 0,
    lastError: error,
    errorKind,
  })
  operation.id = `delete-${Date.now()}-${data.operations.length + 1}`
  data.operations.push(operation)
  const count = await writeOutbox(home, data)
  return {
    added: true,
    operation,
    ids: merged.slice(0, OUTBOX_DELETE_IDS_LIMIT),
    count,
  }
}

/** Убрать операцию из очереди по id. */
export async function removeOutbox(home, id) {
  const data = await readOutbox(home)
  const before = data.operations.length
  data.operations = data.operations.filter(item => item.id !== id)
  if (data.operations.length === before) return false
  await writeOutbox(home, data)
  return true
}

/** Обновить поля операции (attempts/lastError/nextAt). */
export async function updateOutbox(home, id, patch = {}) {
  const data = await readOutbox(home)
  const operation = data.operations.find(item => item.id === id)
  if (operation === undefined) return false
  if (Number.isFinite(patch.attempts)) operation.attempts = Math.trunc(patch.attempts)
  if (typeof patch.lastError === 'string') operation.lastError = patch.lastError.slice(0, 500)
  if (typeof patch.nextAt === 'string') operation.nextAt = patch.nextAt
  await writeOutbox(home, data)
  return true
}

/** Короткая сводка для панели: счётчик «в очереди: N» и последняя ошибка. */
export async function outboxSummary(home) {
  const data = await readOutbox(home)
  const pending = data.operations.map(item => ({
    id: item.id,
    type: item.type,
    attempts: item.attempts,
    at: item.at,
    nextAt: item.nextAt,
    lastError: item.lastError,
    ...(item.errorKind !== undefined ? { errorKind: item.errorKind } : {}),
  }))
  const lastError = pending.length === 0
    ? ''
    : [...pending].reverse().find(item => item.lastError !== '')?.lastError ?? ''
  return { count: pending.length, pending, lastError }
}

// --- единый интерфейс бэкендов (H5) ---------------------------------------

/** Умеет ли backend операцию единого интерфейса. */
export function backendSupports(backend, operation) {
  if (backend === null || backend === undefined) return false
  if (typeof backend[operation] !== 'function') return false
  // Если backend объявил возможности и операция выключена — доверяем ему.
  const capabilities = backend.capabilities
  if (capabilities !== null && typeof capabilities === 'object' && capabilities[operation] === false) return false
  return true
}

/** Сообщение «резерв не поддерживает операцию X». */
export function unsupportedBackendMessage(operation, kind = 'резерв') {
  const label = BACKEND_OPERATION_LABELS[operation] ?? String(operation ?? 'операция')
  return `${kind} не поддерживает операцию «${label}» — данные сохранены, повторим позже`
}

/**
 * Привести ошибку вызова backend к понятному виду.
 *
 * Узнаём три случая: сырое «remote.sync is not a function», явный код
 * `reserve/unsupported` от нового интерфейса и собственную проверку
 * `backendSupports`. Остальные ошибки возвращаем как есть.
 * @returns {{ message: string, code: string, unsupported: boolean }}
 */
export function classifyBackendFailure(error, { operation, kind = 'резерв' } = {}) {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  if (code === 'reserve/unsupported') {
    return { message: raw !== '' ? raw : unsupportedBackendMessage(operation, kind), code, unsupported: true }
  }
  if (/is not a function|is not a constructor/i.test(raw)) {
    return { message: unsupportedBackendMessage(operation, kind), code: 'reserve/unsupported', unsupported: true }
  }
  if (/не поддерживает операцию/i.test(raw)) {
    return { message: raw, code: 'reserve/unsupported', unsupported: true }
  }
  return { message: raw, code, unsupported: false }
}

// --- flush -----------------------------------------------------------------

/** Обернуть промис таймаутом: { timedOut, value }. */
async function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { timedOut: false, value: await promise }
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    timer.unref?.()
  })
  try {
    const result = await Promise.race([promise.then(value => ({ timedOut: false, value })), timeout])
    return result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Выполнить операции, которым пришло время, и обновить файл очереди.
 *
 * @param home каталог DSH
 * @param options.handlers — { push?, delete?, mode?, restore? } функции (op) → boolean|Promise<boolean>
 * @param options.now — текущее время (для тестов)
 * @param options.opTimeoutMs — таймаут одной операции
 * @param options.totalTimeoutMs — общий бюджет цикла (при закрытии — 5–10 с)
 * @param options.max — сколько операций за один цикл
 * @returns {{ flushed: string[], failed: string[], skipped: number, timedOut: boolean, remaining: number, results: object[] }}
 */
export async function flushOutbox(home, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const opTimeoutMs = Number.isFinite(options.opTimeoutMs) ? options.opTimeoutMs : OUTBOX_OP_TIMEOUT_MS
  const totalTimeoutMs = Number.isFinite(options.totalTimeoutMs) ? options.totalTimeoutMs : OUTBOX_OP_TIMEOUT_MS
  const handlers = options.handlers ?? {}
  const max = Number.isFinite(options.max) ? Math.max(1, Math.trunc(options.max)) : 10
  const data = await readOutbox(home)
  const ready = data.operations
    .filter(item => Date.parse(item.nextAt) <= now)
    .slice(0, max)
  const result = { flushed: [], failed: [], skipped: data.operations.length - ready.length, timedOut: false, remaining: data.operations.length, results: [] }
  if (ready.length === 0) return result

  const deadline = Date.now() + totalTimeoutMs
  for (const operation of ready) {
    if (Date.now() >= deadline) {
      result.timedOut = true
      break
    }
    const handler = handlers[operation.type]
    if (typeof handler !== 'function') {
      // Нет обработчика — операция остаётся в очереди, но не считается ошибкой.
      result.skipped += 1
      continue
    }
    let ok = false
    let message = ''
    let timedOut = false
    try {
      const budget = Math.min(opTimeoutMs, Math.max(1, deadline - Date.now()))
      const outcome = await withTimeout(Promise.resolve().then(() => handler(operation)), budget)
      if (outcome.timedOut === true) {
        timedOut = true
        result.timedOut = true
        message = `операция не уложилась в ${Math.round(budget / 1000)} с — повторим позже`
      } else {
        ok = outcome.value === true || outcome.value?.ok === true
        if (!ok) message = typeof outcome.value?.message === 'string' ? outcome.value.message : 'операция не выполнена'
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const fresh = await readOutbox(home)
    const current = fresh.operations.find(item => item.id === operation.id)
    if (current === undefined) {
      // Операцию уже сняли (например, успешный повтор из другого flush).
      result.results.push({ id: operation.id, type: operation.type, ok: true, message: '' })
      result.flushed.push(operation.id)
      continue
    }
    if (ok) {
      fresh.operations = fresh.operations.filter(item => item.id !== operation.id)
      await writeOutbox(home, fresh)
      result.flushed.push(operation.id)
      result.results.push({ id: operation.id, type: operation.type, ok: true, message: '' })
      continue
    }
    const attempts = current.attempts + 1
    current.attempts = attempts
    current.lastError = message.slice(0, 500)
    current.nextAt = isoNow(now + backoffDelay(attempts))
    await writeOutbox(home, fresh)
    result.failed.push(operation.id)
    result.results.push({ id: operation.id, type: operation.type, ok: false, message, timedOut })
    if (timedOut) break
  }
  result.remaining = (await readOutbox(home)).operations.length
  return result
}
