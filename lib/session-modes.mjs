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
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_GROUP_DEPTH, descendantsOf } from './session-groups.mjs'
import { readLocalWorkspaces } from './workspace.mjs'

export const MODES_FILE = 'session-modes.json'
export const MODE_LOCAL = 'local'
export const MODE_CLOUD = 'cloud'
export const MODES_VERSION = 2

// --- «локальная навсегда»: объявление в зеркале ---------------------------
//
// Режим в `session-modes.json` — настройка устройства: другое устройство о ней
// не знает. Поэтому «убрать копию из облака» пишет ещё и объявление в корень
// зеркала — `local-only.json`. Это обещание, которое видят все устройства:
// сессия живёт только там, где её объявили локальной, в облако не отправляется
// и из облака не принимается. Формат (версия 1):
//
// {
//   "version": 1,
//   "updatedAt": "2026-11-24T18:00:00.000Z",
//   "sessions": {
//     "session-<id>": { "declaredBy": "device-a", "at": "...", "reason": "owner" }
//   }
// }
//
// Записи не удаляются «по факту копии»: объявление снимается только явным
// действием «Сделать облачной». Локальный дубль объявлений живёт в
// `~/.dsh/dsh-sync/local-only.json` и переживает fetch+reset зеркала:
// `publishLocalOnly` сливает оба файла по id и пишет обратно.

export const LOCAL_ONLY_FILE = 'local-only.json'
export const LOCAL_ONLY_VERSION = 1
export const LOCAL_ONLY_REASON = 'owner'

/** Путь объявлений в зеркале (корень зеркала) или в домашнем реестре. */
export function localOnlyPath(dir) {
  return join(dir, LOCAL_ONLY_FILE)
}

/** Домашний реестр объявлений (переживает reset зеркала). */
export function localOnlyHomePath(home) {
  return join(home, 'dsh-sync', LOCAL_ONLY_FILE)
}

function emptyLocalOnly() {
  return { version: LOCAL_ONLY_VERSION, updatedAt: '', sessions: {} }
}

function normalizeDeclaredAt(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return undefined
  return Number.isFinite(Date.parse(text)) ? text : undefined
}

/**
 * Привести объявление к каноническому виду. Единственная причина —
 * `owner`: локальность объявляет пользователь, а не движок.
 */
export function normalizeLocalOnlyEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const declaredBy = typeof entry.declaredBy === 'string' ? entry.declaredBy.trim() : ''
  const at = normalizeDeclaredAt(entry.at) ?? new Date().toISOString()
  return {
    declaredBy: declaredBy === '' ? 'device' : declaredBy.slice(0, 80),
    at,
    reason: LOCAL_ONLY_REASON,
  }
}

/** Прочитать объявления из каталога (зеркало или ~/.dsh/dsh-sync). */
export async function readLocalOnly(dir) {
  const base = typeof dir === 'string' ? dir.trim() : ''
  if (base === '') return emptyLocalOnly()
  const file = localOnlyPath(base)
  if (!existsSync(file)) return emptyLocalOnly()
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const sessions = {}
    let updatedAt = ''
    if (parsed !== null && typeof parsed === 'object') {
      updatedAt = normalizeDeclaredAt(parsed.updatedAt) ?? ''
      for (const [id, entry] of Object.entries(parsed.sessions ?? {})) {
        const key = normalizeSessionId(id)
        const normalized = normalizeLocalOnlyEntry(entry)
        if (key === '' || normalized === undefined) continue
        sessions[key] = normalized
      }
    }
    return { version: LOCAL_ONLY_VERSION, updatedAt, sessions }
  } catch {
    // битый файл не должен останавливать синхронизацию: считаем, что объявлений нет
    return emptyLocalOnly()
  }
}

/** Записать объявления; битые входы нормализуются, лишние поля отбрасываются. */
export async function writeLocalOnly(dir, data) {
  const base = typeof dir === 'string' ? dir.trim() : ''
  if (base === '') return emptyLocalOnly()
  const sessions = {}
  for (const [id, entry] of Object.entries(data?.sessions ?? {})) {
    const key = normalizeSessionId(id)
    const normalized = normalizeLocalOnlyEntry(entry)
    if (key === '' || normalized === undefined) continue
    sessions[key] = normalized
  }
  const payload = {
    version: LOCAL_ONLY_VERSION,
    updatedAt: new Date().toISOString(),
    sessions,
  }
  await mkdir(base, { recursive: true })
  await writeFile(localOnlyPath(base), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

/**
 * Слить объявления из нескольких источников по id.
 *
 * Побеждает более позднее `at`: объявление из зеркала могло приехать с другого
 * устройства раньше, чем локальное. При равном времени побеждает первый
 * источник (в `publishLocalOnly` это домашний реестр).
 */
export function mergeLocalOnly(...sources) {
  const sessions = {}
  let updatedAt = ''
  for (const source of sources) {
    if (source === null || source === undefined) continue
    const sourceUpdated = normalizeDeclaredAt(source.updatedAt)
    if (sourceUpdated !== undefined && sourceUpdated > updatedAt) updatedAt = sourceUpdated
    for (const [id, entry] of Object.entries(source.sessions ?? {})) {
      const key = normalizeSessionId(id)
      const normalized = normalizeLocalOnlyEntry(entry)
      if (key === '' || normalized === undefined) continue
      const existing = sessions[key]
      if (existing === undefined || Date.parse(normalized.at) > Date.parse(existing.at)) {
        sessions[key] = normalized
      }
    }
  }
  return { version: LOCAL_ONLY_VERSION, updatedAt, sessions }
}

/**
 * Слить домашний реестр и зеркало с учётом снятия объявления на другом устройстве.
 *
 * Побеждает более позднее `at`. Отдельно разбирается случай «в зеркале записи
 * уже нет, а в домашнем реестре осталась»: если файл зеркала записан позже
 * нашего объявления, значит объявление сняли (или зеркало ушло вперёд) —
 * домашняя копия устарела и не должна воскрешать запись. Обратный случай
 * (reset вернул более старый файл) оставляет объявление: `at` новее `updatedAt`.
 */
export function mergeLocalOnlyState(homeData, mirrorData) {
  const merged = mergeLocalOnly(homeData, mirrorData)
  const mirrorUpdated = Date.parse(normalizeDeclaredAt(mirrorData?.updatedAt) ?? '')
  if (!Number.isFinite(mirrorUpdated)) return merged
  for (const [id, entry] of Object.entries(merged.sessions)) {
    if (mirrorData?.sessions?.[id] !== undefined) continue
    if (homeData?.sessions?.[id] === undefined) continue
    if (Date.parse(entry.at) <= mirrorUpdated) delete merged.sessions[id]
  }
  return merged
}

/** Добавить объявление «локальная навсегда» (merge по id). */
export function declareLocalOnly(data, sessionId, options = {}) {
  const key = normalizeSessionId(sessionId)
  if (key === '') return { declared: false, sessionId: '' }
  const existing = data?.sessions?.[key]
  const entry = normalizeLocalOnlyEntry({
    declaredBy: options.declaredBy,
    at: options.at,
    reason: LOCAL_ONLY_REASON,
  })
  if (existing !== undefined && entry !== undefined && Date.parse(existing.at) > Date.parse(entry.at)) {
    return { declared: true, sessionId: key, entry: existing, kept: true }
  }
  if (data.sessions === undefined) data.sessions = {}
  data.sessions[key] = entry
  return { declared: true, sessionId: key, entry }
}

/**
 * Снять объявление. Возвращает true, если запись действительно была: снятие
 * нужно довести до зеркала и до домашнего реестра.
 */
export function undeclareLocalOnly(data, sessionId) {
  const key = normalizeSessionId(sessionId)
  if (key === '' || data?.sessions?.[key] === undefined) return false
  delete data.sessions[key]
  return true
}

/** Канонические id объявленных сессий. */
export function localOnlyIds(data) {
  return Object.keys(data?.sessions ?? {})
    .map(normalizeSessionId)
    .filter(id => id !== '')
}

/** Объявлена ли сессия «локальной навсегда». */
export function isDeclaredLocalOnly(data, sessionId) {
  const key = normalizeSessionId(sessionId)
  return key !== '' && data?.sessions?.[key] !== undefined
}

/**
 * Опубликовать объявления: домашний реестр + зеркало, объединённые по id.
 *
 * Порядок важен: после fetch+reset файл зеркала может быть затёрт, а домашний
 * реестр — нет. Поэтому источник правды — домашний, а зеркало получает объединение.
 *
 * @param {{home: string, repoDir?: string}} options
 * @returns {{ data, changed: boolean, repoChanged: boolean, homeChanged: boolean }}
 */
export async function publishLocalOnly({ home, repoDir }) {
  const homeDir = join(home, 'dsh-sync')
  const local = await readLocalOnly(homeDir)
  const mirror = typeof repoDir === 'string' && repoDir !== '' ? await readLocalOnly(repoDir) : emptyLocalOnly()
  const data = mergeLocalOnlyState(local, mirror)
  // Домашний файл — снимок этого устройства. Если он записан позже зеркала,
  // значит объявления здесь осознанно меняли (например, сняли фантомные):
  // записи из зеркала, которых нет дома и которые старше нашего снимка, —
  // устаревший мусор и не должны воскресать. Более поздние чужие объявления
  // (at > дом) сохраняем.
  const homeUpdated = Date.parse(normalizeDeclaredAt(local?.updatedAt) ?? '')
  const mirrorUpdated = Date.parse(normalizeDeclaredAt(mirror?.updatedAt) ?? '')
  if (Number.isFinite(homeUpdated) && (!Number.isFinite(mirrorUpdated) || homeUpdated > mirrorUpdated)) {
    for (const [id, entry] of Object.entries(data.sessions ?? {})) {
      if (local.sessions?.[id] !== undefined) continue
      const at = Date.parse(entry?.at ?? '')
      if (Number.isFinite(at) && at <= homeUpdated) delete data.sessions[id]
    }
  }
  const sameSessions = (left, right) => JSON.stringify(left?.sessions ?? {}) === JSON.stringify(right?.sessions ?? {})
  const homeChanged = !sameSessions(local, data)
  const repoChanged = typeof repoDir === 'string' && repoDir !== '' && !sameSessions(mirror, data)
  if (homeChanged) await writeLocalOnly(homeDir, data)
  if (repoChanged) await writeLocalOnly(repoDir, data)
  return { data, changed: homeChanged || repoChanged, repoChanged, homeChanged }
}

/**
 * Зафиксировать в `session-modes.json` локальный режим всех объявленных сессий.
 *
 * Объявление — обещание: даже если на этом устройстве режим успели переключить
 * в облако, отправка/приём такие сессии пропускают. Возвращает изменённое
 * количество и записанные режимы (без записи файла при `persist: false`).
 */
/**
 * Реальные id сессий стора (`~/.dsh/sessions/<bucket>/<id>`).
 * Нужны, чтобы объявление «локальная навсегда» для давно удалённой сессии
 * не создавало фантомный режим и не раздувало счётчики панели.
 */
export async function existingSessionIds(home) {
  const root = join(home, 'sessions')
  const ids = new Set()
  for (const bucket of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!bucket.isDirectory()) continue
    for (const entry of await readdir(join(root, bucket.name), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) ids.add(normalizeSessionId(entry.name))
    }
  }
  return ids
}

export async function applyLocalOnlyModes(home, declaredIds, options = {}) {
  const modes = options.modes ?? await readSessionModes(home)
  const existing = options.existingIds ?? (options.onlyExisting === true ? await existingSessionIds(home) : undefined)
  const changed = []
  for (const id of declaredIds ?? []) {
    const key = normalizeSessionId(id)
    if (key === '') continue
    if (existing !== undefined && !existing.has(key)) continue
    if (modes.sessions[key] === MODE_LOCAL) continue
    modes.sessions[key] = MODE_LOCAL
    changed.push(key)
  }
  if (changed.length > 0 && options.persist !== false) await writeSessionModes(home, modes)
  return { modes, changed }
}

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
