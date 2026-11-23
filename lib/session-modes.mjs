/**
 * Режим сессии: облачная (по умолчанию) или локальная.
 *
 * Локальная сессия не уходит в зеркало, не принимается из него и не порождает
 * надгробий: она живёт только на этом устройстве. Режим — это настройка
 * устройства, а не данные сессии, поэтому он хранится не в зеркале, а в
 * `~/.dsh/dsh-sync/session-modes.json`.
 *
 * Формат:
 * {
 *   "version": 1,
 *   "updatedAt": "2026-11-23T18:00:00.000Z",
 *   "sessions": { "session-<id>": "local" }
 * }
 * Облачные сессии в файле не хранятся: отсутствие записи означает облако.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const MODES_FILE = 'session-modes.json'
export const MODE_LOCAL = 'local'
export const MODE_CLOUD = 'cloud'
export const MODES_VERSION = 1

/** Канонический вид идентификатора: DSH всегда хранит его с префиксом. */
export function normalizeSessionId(sessionId) {
  const text = String(sessionId ?? '').trim()
  if (text === '') return ''
  return text.startsWith('session-') ? text : `session-${text}`
}

export function modesPath(home) {
  return join(home, 'dsh-sync', MODES_FILE)
}

/** Прочитать режимы; битый файл — пустая карта, а не падение синхронизации. */
export async function readSessionModes(home) {
  const file = modesPath(home)
  if (!existsSync(file)) return { version: MODES_VERSION, sessions: {} }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.sessions === null || typeof parsed.sessions !== 'object') {
      return { version: MODES_VERSION, sessions: {} }
    }
    const sessions = {}
    for (const [id, mode] of Object.entries(parsed.sessions)) {
      const key = normalizeSessionId(id)
      if (key !== '' && mode === MODE_LOCAL) sessions[key] = MODE_LOCAL
    }
    return { version: MODES_VERSION, sessions }
  } catch {
    return { version: MODES_VERSION, sessions: {} }
  }
}

export async function writeSessionModes(home, modes) {
  const dir = join(home, 'dsh-sync')
  await mkdir(dir, { recursive: true })
  const payload = {
    version: MODES_VERSION,
    updatedAt: new Date().toISOString(),
    sessions: modes?.sessions ?? {},
  }
  await writeFile(modesPath(home), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

/** Локальная ли сессия. */
export function isLocalSession(modes, sessionId) {
  const key = normalizeSessionId(sessionId)
  return key !== '' && modes?.sessions?.[key] === MODE_LOCAL
}

/** Режим сессии: 'local' или 'cloud'. */
export function sessionModeOf(modes, sessionId) {
  return isLocalSession(modes, sessionId) ? MODE_LOCAL : MODE_CLOUD
}

/**
 * Переключить режим группы сессий. Возвращает изменённое количество.
 * @param {string} home каталог DSH
 * @param {string[]} sessionIds идентификаторы
 * @param {'local'|'cloud'} mode целевой режим
 */
export async function setSessionMode(home, sessionIds, mode) {
  const target = mode === MODE_LOCAL ? MODE_LOCAL : MODE_CLOUD
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map(normalizeSessionId).filter(id => id !== ''))]
  const modes = await readSessionModes(home)
  let changed = 0
  for (const id of ids) {
    const current = modes.sessions[id] === MODE_LOCAL ? MODE_LOCAL : MODE_CLOUD
    if (current === target) continue
    if (target === MODE_LOCAL) modes.sessions[id] = MODE_LOCAL
    else delete modes.sessions[id]
    changed += 1
  }
  if (changed > 0) await writeSessionModes(home, modes)
  return { changed, mode: target, ids }
}

/** Сессии, которые можно отправлять (облачные). */
export function cloudSessions(modes, sessions) {
  return sessions.filter(session => !isLocalSession(modes, session.id))
}

/** Сколько локальных сессий в наборе. */
export function countLocal(modes, sessions) {
  return sessions.reduce((total, session) => total + (isLocalSession(modes, session.id) ? 1 : 0), 0)
}

/**
 * Значок состояния сессии для интерфейса.
 * @param {{mode: string, state: string, offline?: boolean, conflict?: boolean, unattached?: boolean}} input
 * @returns {'local'|'synced'|'pending'|'never'|'conflict'|'offline'|'unattached'}
 */
export function sessionBadge(input) {
  const mode = input?.mode === MODE_LOCAL ? MODE_LOCAL : MODE_CLOUD
  if (mode === MODE_LOCAL) return 'local'
  if (input?.conflict === true) return 'conflict'
  if (input?.offline === true) return 'offline'
  if (input?.unattached === true) return 'unattached'
  if (input?.state === 'green') return 'synced'
  if (input?.state === 'orange') return 'pending'
  return 'never'
}
