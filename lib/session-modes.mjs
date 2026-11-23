/**
 * Режим сессии: облачная (по умолчанию) или локальная.
 *
 * Локальная сессия не уходит в зеркало, не принимается из него и не порождает
 * надгробий: она живёт только на этом устройстве. Режим — это настройка
 * устройства, а не данные сессии, поэтому он хранится не в зеркале, а в
 * `~/.dsh/dsh-sync/session-modes.json`.
 *
 * Формат версии 2:
 * {
 *   "version": 2,
 *   "updatedAt": "2026-11-23T18:00:00.000Z",
 *   "sessions": { "session-<id>": "local" | "cloud" },
 *   "workspaces": { "<workspaceId>": "local" | "cloud" }
 * }
 *
 * - `sessions` — явный выбор пользователя для конкретной сессии. Значение
 *   `cloud` теперь тоже записывается: иначе сессию из «локального по умолчанию»
 *   пространства нельзя было бы осознанно вернуть в облако.
 * - `workspaces` — режим по умолчанию для новых сессий рабочего пространства.
 *   Файл версии 1 знал только `local`-записи в `sessions`; он читается как есть.
 *
 * Новые сессии получают режим по умолчанию своего рабочего пространства при
 * первом обнаружении (`applyWorkspaceDefaults`). Уже существующие сессии смена
 * умолчания не трогает: host-часть фиксирует их текущий режим явной записью.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_GROUP_DEPTH, descendantsOf } from './session-groups.mjs'
import { readLocalWorkspaces } from './workspace.mjs'

export const MODES_FILE = 'session-modes.json'
export const MODE_LOCAL = 'local'
export const MODE_CLOUD = 'cloud'
export const MODES_VERSION = 2

/** Канонический вид идентификатора: DSH всегда хранит его с префиксом. */
export function normalizeSessionId(sessionId) {
  const text = String(sessionId ?? '').trim()
  if (text === '') return ''
  return text.startsWith('session-') ? text : `session-${text}`
}

/** Допустимый режим или undefined. */
function normalizeMode(value) {
  if (value === MODE_LOCAL) return MODE_LOCAL
  if (value === MODE_CLOUD) return MODE_CLOUD
  return undefined
}

export function modesPath(home) {
  return join(home, 'dsh-sync', MODES_FILE)
}

/**
 * Прочитать режимы; битый файл — пустая карта, а не падение синхронизации.
 * Формат версии 1 (только локальные записи) читается без миграции на диске.
 */
export async function readSessionModes(home) {
  const empty = { version: MODES_VERSION, sessions: {}, workspaces: {} }
  const file = modesPath(home)
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return empty
    const sessions = {}
    for (const [id, mode] of Object.entries(parsed.sessions ?? {})) {
      const key = normalizeSessionId(id)
      const value = normalizeMode(mode)
      if (key !== '' && value !== undefined) sessions[key] = value
    }
    const workspaces = {}
    for (const [id, mode] of Object.entries(parsed.workspaces ?? {})) {
      const key = typeof id === 'string' ? id.trim() : ''
      const value = normalizeMode(mode)
      // «Облако» — встроенное умолчание: запись не нужна, но если она есть,
      // читаем её как явное значение.
      if (key !== '' && value !== undefined) workspaces[key] = value
    }
    return { version: MODES_VERSION, sessions, workspaces }
  } catch {
    return empty
  }
}

export async function writeSessionModes(home, modes) {
  const dir = join(home, 'dsh-sync')
  await mkdir(dir, { recursive: true })
  const sessions = {}
  for (const [id, mode] of Object.entries(modes?.sessions ?? {})) {
    const key = normalizeSessionId(id)
    const value = normalizeMode(mode)
    if (key !== '' && value !== undefined) sessions[key] = value
  }
  const workspaces = {}
  for (const [id, mode] of Object.entries(modes?.workspaces ?? {})) {
    const key = typeof id === 'string' ? id.trim() : ''
    const value = normalizeMode(mode)
    if (key !== '' && value !== undefined) workspaces[key] = value
  }
  const payload = {
    version: MODES_VERSION,
    updatedAt: new Date().toISOString(),
    sessions,
    workspaces,
  }
  await writeFile(modesPath(home), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

/** Явный выбор пользователя для сессии: 'local' | 'cloud' | undefined. */
export function explicitSessionMode(modes, sessionId) {
  const key = normalizeSessionId(sessionId)
  if (key === '') return undefined
  return normalizeMode(modes?.sessions?.[key])
}

/** Локальная ли сессия по явной записи (без учёта умолчаний пространств). */
export function isLocalSession(modes, sessionId) {
  return explicitSessionMode(modes, sessionId) === MODE_LOCAL
}

/** Режим сессии по явной записи: 'local' или 'cloud'. */
export function sessionModeOf(modes, sessionId) {
  return isLocalSession(modes, sessionId) ? MODE_LOCAL : MODE_CLOUD
}

/** Умолчание рабочего пространства: 'local' или 'cloud'. */
export function workspaceDefaultMode(modes, workspaceId) {
  const key = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (key === '') return MODE_CLOUD
  return modes?.workspaces?.[key] === MODE_LOCAL ? MODE_LOCAL : MODE_CLOUD
}

/** Карта «сессия → рабочее пространство» из стора DSH. */
export async function workspaceSessionMap(home) {
  const local = await readLocalWorkspaces(home).catch(() => ({ workspaces: [] }))
  const map = {}
  for (const workspace of local?.workspaces ?? []) {
    const workspaceId = typeof workspace?.id === 'string' ? workspace.id.trim() : ''
    if (workspaceId === '') continue
    for (const sessionId of workspace.sessionIds ?? []) {
      const key = normalizeSessionId(sessionId)
      if (key !== '' && map[key] === undefined) map[key] = workspaceId
    }
  }
  return map
}

/**
 * Выдать новые сессии умолчаниями их рабочих пространств.
 *
 * «Новая» — сессия без явной записи. Уже переключённые вручную сессии не
 * трогаются, поэтому смена умолчания действует только на новые сессии.
 * Умолчание «облако» — встроенное: запись не создаётся, файл не растёт.
 *
 * @param home каталог DSH
 * @param options.workspaceIdBySession — карта сессия → workspaceId (если уже есть)
 * @param options.persist === false — только посчитать, не писать
 * @returns {{ modes, changed, inherited: string[] }}
 */
export async function applyWorkspaceDefaults(home, options = {}) {
  const modes = options.modes ?? await readSessionModes(home)
  const map = options.workspaceIdBySession ?? await workspaceSessionMap(home)
  const inherited = []
  for (const [sessionId, workspaceId] of Object.entries(map ?? {})) {
    const key = normalizeSessionId(sessionId)
    if (key === '' || modes.sessions[key] !== undefined) continue
    if (workspaceDefaultMode(modes, workspaceId) !== MODE_LOCAL) continue
    modes.sessions[key] = MODE_LOCAL
    inherited.push(key)
  }
  if (inherited.length > 0 && options.persist !== false) await writeSessionModes(home, modes)
  return { modes, changed: inherited.length, inherited }
}

/**
 * Задать умолчание рабочего пространства.
 *
 * `options.sessionIds` — текущие сессии пространства: у них фиксируется
 * прежний режим явной записью, иначе смена умолчания задним числом переключила
 * бы существующие сессии. Новые сессии получат новое значение.
 *
 * @returns {{ changed, mode, workspaceId, pinned, previous }}
 */
export async function setWorkspaceDefaultMode(home, workspaceId, mode, options = {}) {
  const key = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  const target = normalizeMode(mode) ?? MODE_CLOUD
  const modes = await readSessionModes(home)
  if (key === '') {
    return { changed: 0, mode: target, workspaceId: '', pinned: 0, previous: MODE_CLOUD }
  }
  const previous = workspaceDefaultMode(modes, key)
  let pinned = 0
  for (const sessionId of options.sessionIds ?? []) {
    const id = normalizeSessionId(sessionId)
    if (id === '' || modes.sessions[id] !== undefined) continue
    // Прежнее умолчание становится явным режимом существующей сессии.
    modes.sessions[id] = previous
    pinned += 1
  }
  let changed = 0
  if (target !== previous) {
    if (target === MODE_CLOUD) delete modes.workspaces[key]
    else modes.workspaces[key] = MODE_LOCAL
    changed = 1
  }
  if (changed > 0 || pinned > 0) await writeSessionModes(home, modes)
  return { changed, mode: target, workspaceId: key, pinned, previous }
}

/**
 * Переключить режим группы сессий. Возвращает изменённое количество.
 *
 * Группа — единица обмена: если передан `options.groups` (связи родитель/дети),
 * режим родителя переключается и всем его субагентам. Иначе ребёнок локального
 * родителя мог бы уехать в облако один и остаться в зеркале сиротой.
 *
 * @param {string} home каталог DSH
 * @param {string[]} sessionIds идентификаторы
 * @param {'local'|'cloud'} mode целевой режим
 * @param {{groups?: {parentById: Map<string,string>, childrenByParent: Map<string,string[]>}}} [options]
 */
export async function setSessionMode(home, sessionIds, mode, options = {}) {
  const target = mode === MODE_LOCAL ? MODE_LOCAL : MODE_CLOUD
  const requested = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map(normalizeSessionId).filter(id => id !== ''))]
  const expanded = [...requested]
  if (options?.groups !== undefined && options.groups !== null) {
    for (const id of requested) {
      for (const child of descendantsOf(options.groups.childrenByParent, id)) {
        const key = normalizeSessionId(child)
        if (key !== '' && !expanded.includes(key)) expanded.push(key)
      }
    }
  }
  const modes = await readSessionModes(home)
  let changed = 0
  for (const id of expanded) {
    const current = sessionModeOf(modes, id)
    if (current === target) continue
    // Пишем и 'cloud': это осознанный выбор вернуть сессию в облако даже там,
    // где умолчание пространства — «локальная».
    modes.sessions[id] = target
    changed += 1
  }
  if (changed > 0) await writeSessionModes(home, modes)
  return { changed, mode: target, ids: expanded, expanded: expanded.length - requested.length }
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
 * Эффективные режимы группы «родитель + субагенты».
 *
 * Локальность наследуется: если родитель локальный, его субагенты тоже не
 * уезжают в зеркало (иначе там появился бы субагент без родителя). Если ребёнок
 * помечен локальным, сам родитель остаётся облачным, но ребёнок в зеркало не
 * уходит. Возвращает множества канонических id.
 *
 * Умолчания workspace сюда попадают уже материализованными записями
 * (`applyWorkspaceDefaults`): иначе движку синхронизации пришлось бы знать
 * реестр пространств.
 *
 * @param modes — результат readSessionModes
 * @param sessions — [{ id }] или массив id
 * @param groups — { parentById, childrenByParent } из buildSessionGroups
 * @returns {{ localIds: Set<string>, cloudIds: Set<string>, forcedChildren: Array<{id: string, parent: string}> }}
 */
export function resolveGroupModes(modes, sessions, groups = {}) {
  const ids = []
  const seen = new Set()
  for (const item of sessions ?? []) {
    const key = normalizeSessionId(typeof item === 'string' ? item : item?.id)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    ids.push(key)
  }
  const parentById = groups?.parentById ?? new Map()
  const childrenByParent = groups?.childrenByParent ?? new Map()
  const localIds = new Set()

  const isLocalWithAncestors = (id) => {
    if (isLocalSession(modes, id)) return true
    let current = id
    const visited = new Set([current])
    for (let depth = 0; depth < MAX_GROUP_DEPTH; depth++) {
      const parent = parentById.get(current)
      if (parent === undefined || parent === '' || visited.has(parent)) break
      visited.add(parent)
      current = parent
      if (isLocalSession(modes, parent)) return true
    }
    return false
  }

  const forcedChildren = []
  for (const id of ids) {
    if (isLocalWithAncestors(id)) localIds.add(id)
  }
  // Дети уже известной локальной сессии тоже локальные — даже если родитель
  // не попал в набор (например, при приёме он остался на другом устройстве).
  for (const id of [...localIds]) {
    for (const child of descendantsOf(childrenByParent, id)) {
      const key = normalizeSessionId(child)
      if (key === '' || !seen.has(key) || localIds.has(key)) continue
      localIds.add(key)
      forcedChildren.push({ id: key, parent: id })
    }
  }
  const cloudIds = new Set(ids.filter(id => !localIds.has(id)))
  return { localIds, cloudIds, forcedChildren }
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
