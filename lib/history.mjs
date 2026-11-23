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
 * @param home каталог DSH
 * @param record результат { ok, action, message, ... }
 */
export async function recordRun(home, record) {
  try {
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', LAST_RUN_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
    // последний запуск — вспомогательные данные
  }
  await recordHistory(home, record)
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
