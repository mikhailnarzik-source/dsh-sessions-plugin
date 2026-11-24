/**
 * История запусков: последний результат плюс журнал из нескольких записей.
 * Журнал показывает, что происходило ночью или час назад, а не только сейчас.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LAST_RUN_FILE = 'last-run.json'
export const HISTORY_FILE = 'history.jsonl'
const HISTORY_LIMIT = 50

/**
 * Виды ошибок синхронизации для панели (контракт с UI: `errorKind` — строка).
 * `unknown` — ошибка есть, но ни к одной категории не подходит.
 */
export const ERROR_KINDS = ['network', 'auth', 'format', 'guard', 'reserve', 'unknown']

// Классификация по тексту ошибки: сообщения приходят из git/HTTP/файловых
// операций и на русском, и на английском, поэтому шаблоны покрывают оба языка.
const AUTH_PATTERN = /(HTTP 40[13]|\b401\b|\b403\b|unauthor|forbidden|authentication|authoriz|permission denied|access denied|bad credentials|\btoken\b|токен|парол|доступ запрещ|отказано в доступе|не удалось авториз)/i
const NETWORK_PATTERN = /(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|network|fetch failed|socket hang up|HTTP 5\d\d|\b50[234]\b|таймаут|timeout|нет соединения|сеть недоступна|не удалось получить|не удалось подключ|connection (refused|reset|closed))/i
const FORMAT_PATTERN = /(формат|LOG_FORMAT|\bformat\b)/i
const GUARD_PATTERN = /(guarded|зеркало не перезаписано|защищ|порог|prune|блокиров|более новый формат|содержимого больше)/i

/**
 * Разобрать ошибку запуска в одну из категорий ERROR_KINDS.
 *
 * Явная отметка `errorKind` в записи сильнее текста. Дальше проверяются
 * признаки каналов: резерв (`secondaryBlocked`/`secondaryError`), блокировка
 * из-за нового формата, защита зеркала (guarded), затем текст сообщения.
 *
 * @param value — строка сообщения или запись запуска ({ ok, message, ... }).
 */
export function classifyErrorKind(value) {
  const source = typeof value === 'string' ? { message: value } : (value ?? {})
  const explicit = typeof source.errorKind === 'string' ? source.errorKind.trim() : ''
  if (ERROR_KINDS.includes(explicit)) return explicit
  if (source.secondaryBlocked !== undefined || source.secondaryError !== undefined) return 'reserve'
  if (source.push?.secondaryBlocked !== undefined || source.push?.secondaryError !== undefined) return 'reserve'
  if (source.ok === false && Number(source.format) > Number(source.supportedFormat ?? -1)) return 'format'
  const message = typeof source.message === 'string' ? source.message : ''
  if (AUTH_PATTERN.test(message)) return 'auth'
  if (NETWORK_PATTERN.test(message)) return 'network'
  if (FORMAT_PATTERN.test(message)) return 'format'
  if (GUARD_PATTERN.test(message)) return 'guard'
  const guarded = source.push?.guarded ?? source.guarded
  if (Array.isArray(guarded) ? guarded.length > 0 : Number(guarded) > 0) return 'guard'
  const readFailure = source.push?.failures?.[0]?.message ?? source.pull?.errors?.[0]?.message
  if (typeof readFailure === 'string' && readFailure !== '') {
    return classifyErrorKind({ message: readFailure })
  }
  return 'unknown'
}

/**
 * Счётчик ошибок для last-run/history: сколько запусков подряд завершились
 * неудачей. Успех сбрасывает счётчик в ноль (контракт с UI: `failures` — число).
 *
 * Повторная запись того же запуска (child → host) не увеличивает счётчик:
 * её видно по одинаковому `runId`. Явная отметка errorKind сохраняется и у
 * успешного запуска — так видно, что основной канал прошёл, а резервный нет.
 *
 * @param record — запись запуска.
 * @param previous — предыдущий last-run (результат readLastRun).
 * @returns {{ failures: number, errorKind: string }}
 */
export function failureState(record = {}, previous = undefined) {
  const ok = record?.ok === true
  const sameRun = typeof record?.runId === 'string' && record.runId !== ''
    && previous?.runId === record.runId
  const previousFailures = Number(previous?.failures)
  const base = Number.isFinite(previousFailures) && previousFailures > 0 ? Math.trunc(previousFailures) : 0
  const failures = ok ? 0 : (sameRun ? base : base + 1)
  const explicit = typeof record?.errorKind === 'string' ? record.errorKind.trim() : ''
  const errorKind = ERROR_KINDS.includes(explicit) ? explicit : (ok ? '' : classifyErrorKind(record))
  return { failures, errorKind }
}

/** Последний запуск из last-run.json; undefined — файла ещё нет. */
export async function readLastRun(home) {
  try {
    return JSON.parse(await readFile(join(home, 'dsh-sync', LAST_RUN_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Дописать запись в журнал, не трогая last-run.json. Нужно для служебных
 * событий вроде сверки резервного канала: они не должны выглядеть как
 * «последняя синхронизация».
 */
export async function recordHistory(home, record) {
  try {
    const dir = join(home, 'dsh-sync')
    await mkdir(dir, { recursive: true })
    const file = join(dir, HISTORY_FILE)
    let lines = []
    try {
      lines = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim() !== '')
    } catch {
      lines = []
    }
    lines.push(JSON.stringify(record))
    await writeFile(file, `${lines.slice(-HISTORY_LIMIT).join('\n')}\n`, 'utf8')
  } catch {
    // история — вспомогательные данные, сбой записи не критичен
  }
}

/**
 * Записать результат запуска: обновляет last-run.json и дописывает журнал.
 *
 * В запись добавляются `failures` (ошибок подряд) и `errorKind` (вид ошибки) —
 * по ним панель показывает состояние синхронизации, не разбирая текст.
 * Повторная запись того же запуска (`runId` совпал с last-run) обновляет
 * last-run, но не дублирует строку в history.jsonl.
 *
 * @param home каталог DSH
 * @param record результат { ok, action, message, ... }
 * @returns запись в том виде, в каком она попала в last-run.json.
 */
export async function recordRun(home, record) {
  const previous = await readLastRun(home)
  const saved = { ...record, ...failureState(record, previous) }
  try {
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', LAST_RUN_FILE), `${JSON.stringify(saved, null, 2)}\n`, 'utf8')
  } catch {
    // последний запуск — вспомогательные данные
  }
  const sameRun = typeof saved.runId === 'string' && saved.runId !== ''
    && previous?.runId === saved.runId
  // Один запуск — одна строка журнала: child пишет результат, host дополняет
  // его сообщением и пишет last-run повторно с тем же runId.
  if (!sameRun) await recordHistory(home, saved)
  return saved
}

/** Последние записи журнала, свежие в конце. */
export async function readHistory(home, limit = 5) {
  try {
    const file = join(home, 'dsh-sync', HISTORY_FILE)
    const lines = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim() !== '')
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Сводка обмена по группам «родитель + субагенты» для журнала.
 *
 * В history.jsonl нужны машиночитаемые цифры: сколько сессий обменяно
 * (`sessions`), сколько из них субагентов (`subagents`) и каких детей не
 * хватило локально (`childrenMissing`) — по ним видно, что группа уехала не
 * целиком, и это не потерялось между запусками.
 *
 * @param result — { pull, push } из движка синхронизации.
 */
export function subagentStats(result = {}) {
  const push = result?.push ?? {}
  const pull = result?.pull ?? {}
  const sessions = (Number(push.sessions ?? 0) || 0) + (Number(pull.sessions ?? 0) || 0)
  const subagents = (Number(push.subagents ?? 0) || 0) + (Number(pull.subagents ?? 0) || 0)
  const childrenMissing = [...new Set([
    ...(Array.isArray(push.childrenMissing) ? push.childrenMissing : []),
    ...(Array.isArray(pull.childrenMissing) ? pull.childrenMissing : []),
  ])].filter(id => typeof id === 'string' && id !== '').slice(0, 100)
  // Сколько субагентов ушло в карантин вместе с родителями: панель показывает
  // это строкой «Вместе с родителями ушли в карантин: N».
  const childrenQuarantined = Number(push.childrenQuarantined ?? 0) || 0
  return { sessions, subagents, childrenMissing, childrenQuarantined }
}

/**
 * Сводка по локальным сессиям, которые обмен не тронул.
 *
 * В history.jsonl нужна одна цифра `skippedLocal`: сколько раз режим
 * «локальная» удержал сессию от отправки, приёма или удаления из зеркала.
 * Дополнительно сохраняются слагаемые: приём, отправка и защита копии в
 * зеркале при prune. Так видно, откуда взялось число, и это не теряется между
 * запусками — панель показывает его строкой «Локальных сессий пропущено: N».
 *
 * @param result — { pull, push } из движка синхронизации.
 */
export function localSkipStats(result = {}) {
  const pull = result?.pull ?? {}
  const push = result?.push ?? {}
  const pullSkippedLocal = Number(pull.localSkipped ?? 0) || 0
  const pushSkippedLocal = Number(push.localSkipped ?? 0) || 0
  const localMirrorProtected = Number(push.localMirrorProtected ?? 0) || 0
  const ids = [
    ...(Array.isArray(pull.localSkippedIds) ? pull.localSkippedIds : []),
    ...(Array.isArray(push.localSkippedIds) ? push.localSkippedIds : []),
    ...(Array.isArray(push.localMirrorProtectedIds) ? push.localMirrorProtectedIds : []),
  ].filter(id => typeof id === 'string' && id !== '')
  return {
    skippedLocal: pullSkippedLocal + pushSkippedLocal,
    pullSkippedLocal,
    pushSkippedLocal,
    localMirrorProtected,
    localSkippedIds: [...new Set(ids)].slice(0, 100),
  }
}

/**
 * Сводка удалений для журнала: причины (reasons) и авторы (by) по кодам.
 *
 * Коды не заменяют человекочитаемый removedReason/removed: журнал остаётся
 * понятным, а машинная часть (manual/prune/expired/replaced и owner/sync)
 * позволяет отличить удаление пользователем от автоочистки.
 *
 * @param result — { pull, push } из движка синхронизации.
 */
export function removalDetails(result = {}) {
  const pullDetails = Array.isArray(result.pull?.deletedDetails) ? result.pull.deletedDetails : []
  const pushDetails = Array.isArray(result.push?.removedDetails) ? result.push.removedDetails : []
  const expiredIds = Array.isArray(result.push?.quarantinePurgedIds) ? result.push.quarantinePurgedIds : []
  const replacedIds = Array.isArray(result.push?.replacedIds) ? result.push.replacedIds : []
  const expired = Number(result.push?.quarantinePurged ?? expiredIds.length) || 0
  const replaced = Number(result.push?.replaced ?? replacedIds.length) || 0

  const reasons = new Set([
    ...(result.pull?.deletedReasons ?? []),
    ...(result.push?.removedReasons ?? []),
  ])
  const by = new Set([
    ...(result.pull?.deletedBy ?? []),
    ...(result.push?.removedBy ?? []),
  ])
  // Деталям верим как источнику: причина «children» (субагент ушёл вместе с
  // родителем) может прийти только в списке деталей, без отдельного массива.
  for (const item of [...pullDetails, ...pushDetails]) {
    if (typeof item?.reason === 'string' && item.reason !== '') reasons.add(item.reason)
    if (typeof item?.by === 'string' && item.by !== '') by.add(item.by)
  }
  if (expired > 0) {
    reasons.add('expired')
    by.add('sync')
  }
  if (replaced > 0) {
    reasons.add('replaced')
    by.add('sync')
  }
  return {
    removedDetails: [...pullDetails, ...pushDetails],
    reasons: [...reasons].filter(code => typeof code === 'string' && code !== ''),
    by: [...by].filter(code => typeof code === 'string' && code !== ''),
    expired,
    expiredIds: expiredIds.slice(0, 100),
    replaced,
    replacedIds: replacedIds.slice(0, 100),
  }
}
