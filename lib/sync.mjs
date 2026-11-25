/**
 * push/pull: перенос сессий между локальным стором и git-зеркалом.
 *
 * Модель слияния опирается на append-only природу лога: хвост после заголовка
 * у обеих сторон начинается с общих байт, поэтому «один хвост — префикс
 * другого» означает, что одна сторона просто дописала события. Полное
 * расхождение (обе дописали своё) не склеивается: удалённая версия
 * импортируется отдельной сессией, локальная остаётся нетронутой.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { LOG_NAME, canonicalize, isLocked, listLocalSessions, listMirrorSessions, localSessionDir, mirrorLogPath, remapTo, sessionsOfProject, splitLog } from './store.mjs'
import { encodeSegment } from './format.mjs'
import { git } from './git.mjs'
import { createRemote } from './remote.mjs'
import { mergeDevice, readMeta, readMirrorFormat, writeMeta } from './mirror-meta.mjs'
import { pullAttachments, pushAttachments } from './attachments.mjs'
import { markSynced, readLedger, writeLedger } from './ledger.mjs'
import {
  DELETED_AT_FILE,
  QUARANTINE_DAYS,
  QUARANTINE_DIR,
  SESSION_SIDECAR_FILE,
  addTombstone,
  dropTombstone,
  isActiveTombstone,
  markExpired,
  markRestored,
  mergePendingManualTombstones,
  pendingManualTombstones,
  quarantinePath,
  readTombstones,
  writeTombstones,
} from './tombstones.mjs'
import { repairLog } from './repair.mjs'
import { computeSessionIdentity, duplicateGroups, findDuplicateAmongLogs, writeCatalog } from './catalog.mjs'
import { createNeutralizer } from './neutralize.mjs'
import { appendJournal, pullProfile, pushProfile } from './profile.mjs'
import { pullWorkspace, pushWorkspace } from './workspace.mjs'
import { applyWorkspaceDefaults, isLocalSession, normalizeSessionId, publishLocalOnly, readSessionModes, resolveGroupModes, setSessionMode } from './session-modes.mjs'
import { buildSessionGroups, orderParentsFirst, rootOf } from './session-groups.mjs'
import {
  CHILDREN_REASON,
  ORPHAN_REASON,
  PRUNE_MAX_COUNT,
  PRUNE_MAX_RATIO,
  chooseCanonical,
  deletionGuardViolation,
  deletionReasonsOf,
  deletionRootOf,
  deletionsBlockedMessage,
  expandDeletionIds,
  logNewerThanTombstone,
  missingChildren,
  orphanChildren,
  planDeletions,
  quarantineLocalCopy,
  rankCandidates,
  supersededQuarantineDir,
} from './deletions.mjs'
import {
  LIMIT_RULE_HINT,
  OWNER_RULE_MESSAGE,
  PROTECTED_RULE_LABEL,
  RULES_PROFILE_RELATIVE,
  mergeRulesFromProfile,
  mergeSessionRules,
  normalizeRuleId,
  overLimitOf,
  readRulesProfile,
  readSessionRules,
  resolveRulesForSessions,
  ruleFields,
  rulesCounts,
  writeRulesProfile,
} from './session-rules.mjs'
import { readSyncState, writeSyncState } from './sync-state.mjs'
import { deletionsConfig } from './config.mjs'
import { LOG_FORMAT } from './frames.mjs'

function tailOf(bytes) {
  return splitLog(bytes).tail
}

/**
 * Окно «свежей» ручной метки: она ещё может быть не закоммичена в зеркало.
 * Совпадает с окном `pendingManualTombstones` (tombstones.mjs).
 */
const PENDING_MANUAL_WINDOW_MS = 15 * 60_000

// --- защита от массового удаления ------------------------------------------

/** Пороги массового удаления: общие для плана и подтверждённого действия. */
export { PRUNE_MAX_COUNT, PRUNE_MAX_RATIO } from './deletions.mjs'
/** Папка карантина и срок хранения — общие для движка и панели «Удалённые». */
export { QUARANTINE_DAYS, QUARANTINE_DIR }
/** Формат лога сессий, который умеет читать эта сборка плагина. */
export { LOG_FORMAT }

/** Сравнить версии вида 1.2.3: >0 если a новее b. Некорректные строки — лексикографически. */
export function compareVersions(a, b) {
  const parse = (value) => String(value).trim().split(/[.+-]/).map(part => Number.parseInt(part, 10))
  const left = parse(a)
  const right = parse(b)
  if (left.every(part => Number.isFinite(part)) && right.every(part => Number.isFinite(part))) {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/**
 * Версия DSH, в котором работает эта сборка плагина. Ищется в окружении
 * (DSH_SYNC_DSH_VERSION ставит host-часть дочернему процессу, DSH_VERSION —
 * сам DSH), затем в package.json из DSH_INSTALL_DIR (внутри app.asar читается
 * только в host-процессе Electron).
 */
export async function detectDshVersion() {
  const env = [process.env.DSH_SYNC_DSH_VERSION, process.env.DSH_VERSION].find(value => typeof value === 'string' && value.trim() !== '')
  if (env !== undefined) return env.trim()
  const dir = process.env.DSH_INSTALL_DIR
  if (typeof dir === 'string' && dir !== '') {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (typeof manifest?.version === 'string' && manifest.version !== '') return manifest.version
    } catch {
      // не удалось прочитать — версию не знаем
    }
  }
  return undefined
}

/**
 * Время сессии для сверки с меткой удаления.
 *
 * Заголовок лога даёт `createdAt` (момент создания) и, если есть, `updatedAt`;
 * для локального файла сюда же добавляется время последней записи (mtime) —
 * это и есть «когда сессию реально дописали». undefined — времени нет.
 */
export function sessionTimestamp(session) {
  const values = []
  const put = (value) => {
    const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
    if (Number.isFinite(ms)) values.push(ms)
  }
  put(session?.createdAt)
  put(session?.updatedAt)
  if (Number.isFinite(session?.mtimeMs)) values.push(session.mtimeMs)
  return values.length === 0 ? undefined : Math.max(...values)
}

/**
 * Время локальной сессии: заголовок плюс mtime файла лога.
 * @param session — сессия из listLocalSessions.
 */
async function localSessionTimestamp(session) {
  const headerTime = sessionTimestamp(session)
  if (typeof session?.path !== 'string' || session.path === '') return headerTime
  try {
    const fileTime = (await stat(session.path)).mtimeMs
    if (!Number.isFinite(fileTime)) return headerTime
    return headerTime === undefined ? fileTime : Math.max(headerTime, fileTime)
  } catch {
    return headerTime
  }
}

/**
 * Метка удаления сильнее копии, когда сессия не новее самой метки.
 *
 * Присутствие файла ничего не доказывает: устройство могло просто не успеть
 * применить чужую метку. Снимаем/обходим метку только если сессия реально
 * новее времени удаления. Причина `made-local` — обещание, что сессия живёт
 * только на этом устройстве: такую метку не снимаем никогда, иначе она
 * «воскресла» бы из зеркала.
 *
 * @param tombstone — запись из tombstones.sessions.
 * @param sessionTime — время сессии в мс (sessionTimestamp).
 */
export function tombstoneBlocksSession(tombstone, sessionTime) {
  if (tombstone === undefined || tombstone === null || !isActiveTombstone(tombstone)) return false
  if (tombstone.reason === 'made-local') return true
  const markAt = Date.parse(String(tombstone.at ?? ''))
  if (!Number.isFinite(markAt)) return true
  if (!Number.isFinite(sessionTime)) return true
  // Метка хранит время с точностью до миллисекунды: сессия, созданная в ту же
  // миллисекунду, уже не «старее метки» (иначе повторное создание в том же
  // тике не сняло бы метку).
  return sessionTime < markAt
}

/** Можно ли снять метку: сессия новее метки и это не `made-local`. */
export function canDropTombstone(tombstone, sessionTime) {
  return tombstone !== undefined && tombstone !== null
    && isActiveTombstone(tombstone)
    && !tombstoneBlocksSession(tombstone, sessionTime)
}

/** Человекочитаемое сообщение о блокировке из-за более нового формата зеркала. */
function newerFormatMessage(mirrorFormat) {
  return `зеркало использует более новый формат логов (v${mirrorFormat}, поддерживается v${LOG_FORMAT}) — отправка заблокирована, обновите DSH`
}

function newerFormatGuardMessage(mirrorFormat) {
  return `зеркало в более новом формате (v${mirrorFormat}) — отправка пропущена, обновите DSH`
}

/**
 * Сводка заблокированной отправки: в зеркало более нового формата писать
 * нельзя, но панель должна увидеть причину и список удержанных сессий.
 */
async function blockedPushSummary({ home, config, project, mirrorFormat, sessions: provided }) {
  // Режимы читаем без материализации умолчаний: блокировка ничего не меняет.
  const sessionModes = await readSessionModes(home)
  const local = provided === undefined ? await listLocalSessions(home) : []
  const guarded = new Map()
  for (const [, entry] of selectedProjects(config, project)) {
    const allSessions = provided ?? sessionsOfProject(local, entry.path)
    for (const session of allSessions) {
      if (isLocalSession(sessionModes, session.id)) continue
      guarded.set(session.id, { id: session.id, message: newerFormatGuardMessage(mirrorFormat) })
    }
  }
  const message = newerFormatMessage(mirrorFormat)
  return {
    ok: false,
    errorKind: 'format',
    format: mirrorFormat,
    supportedFormat: LOG_FORMAT,
    message,
    warning: message,
    projects: [],
    pushed: 0,
    removed: 0,
    skipped: 0,
    localSkipped: 0,
    localMirrorProtected: 0,
    sessions: 0,
    subagents: 0,
    childrenMissing: [],
    guarded: [...guarded.values()],
  }
}

/**
 * Вычистить из карантина записи старше QUARANTINE_DAYS. Возраст берётся из
 * `deleted-at.json`, который кладётся рядом при переносе: время файловой
 * системы ненадёжно (rename сохраняет старую дату, облако меняет её как хочет).
 *
 * Истёкшая пометка удаления остаётся действующей (чтобы старое устройство не
 * «воскресило» сессию), но получает reason=expired: восстановить её уже нельзя.
 *
 * @returns {Promise<string[]>} id сессий, чей карантин вычищен.
 */
async function purgeExpiredQuarantine(repoDir, projectId, tombstones) {
  const root = join(repoDir, 'sessions', projectId, QUARANTINE_DIR)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const deadline = Date.now() - QUARANTINE_DAYS * 24 * 60 * 60_000
  const purged = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    let at
    try {
      at = Date.parse(JSON.parse(await readFile(join(dir, DELETED_AT_FILE), 'utf8')).at)
    } catch {
      at = Number.NaN // без отметки возраста не трогаем
    }
    if (Number.isFinite(at) && at < deadline) {
      await rm(dir, { recursive: true, force: true })
      let purgedId = entry.name
      for (const sessionId of Object.keys(tombstones?.sessions ?? {})) {
        if (encodeSegment(sessionId) !== entry.name) continue
        markExpired(tombstones, sessionId, { by: 'sync' })
        purgedId = sessionId
      }
      purged.push(purgedId)
    }
  }
  return purged
}

/**
 * Можно ли перезаписать зеркальный лог локальным. Возвращает причину отказа
 * или undefined, если запись безопасна. Локальный лог короче зеркального или
 * расходится с ним — писать нельзя: это потеряло бы события, которые зеркало
 * уже раздало другим устройствам.
 */
function guardPush(existing, canonical, id) {
  let existingTail
  let localTail
  try {
    existingTail = tailOf(existing)
    localTail = tailOf(canonical)
  } catch (error) {
    return { id, message: `зеркальный лог не читается — не перезаписываем (${error instanceof Error ? error.message : String(error)})` }
  }
  if (existingTail.equals(localTail)) return undefined // изменился только заголовок
  if (isPrefix(existingTail, localTail)) return undefined // fast-forward: зеркало — префикс локального
  if (isPrefix(localTail, existingTail)) {
    return { id, message: 'локальный лог короче зеркального — отправка пропущена (в зеркале больше событий)' }
  }
  return { id, message: 'логи разошлись — зеркало не перезаписываем, чтобы не потерять события' }
}

/**
 * Отрезать недописанный хвост: DSH может дописывать сессию в момент чтения, и
 * незавершённый кадр нельзя отправлять другим устройствам — иначе они получат
 * обрезанную историю.
 */
export function sanitizeLog(bytes) {
  const { frameEnd, plain } = splitLog(bytes)
  const tail = bytes.subarray(frameEnd)
  if (tail.length === 0) return { bytes, dropped: 0 }

  if (plain) {
    const lastNewline = tail.lastIndexOf(0x0a)
    if (lastNewline === -1) return { bytes: bytes.subarray(0, frameEnd), dropped: tail.length }
    if (lastNewline === tail.length - 1) return { bytes, dropped: 0 }
    return { bytes: bytes.subarray(0, frameEnd + lastNewline + 1), dropped: tail.length - lastNewline - 1 }
  }

  let lastStart = -1
  for (let i = tail.length - 4; i >= 0; i--) {
    if (tail[i] === 0x28 && tail[i + 1] === 0xb5 && tail[i + 2] === 0x2f && tail[i + 3] === 0xfd) {
      lastStart = i
      break
    }
  }
  if (lastStart < 0) return { bytes, dropped: 0 }

  let complete = false
  try {
    complete = zstdDecompressSync(tail.subarray(lastStart)).length > 0
  } catch {
    complete = false
  }
  if (complete) return { bytes, dropped: 0 }
  return { bytes: bytes.subarray(0, frameEnd + lastStart), dropped: tail.length - lastStart }
}

/**
 * Совпадает ли лог по смыслу: заголовок (без учёта порядка ключей) и хвост.
 * Байты заголовка сравнивать нельзя: разные сборки Node сжимают один и тот же
 * JSON в разные zstd-кадры, и тогда каждый push создавал бы пустой коммит.
 */
function sameLog(a, b) {
  let left
  let right
  try {
    left = splitLog(a)
    right = splitLog(b)
  } catch {
    return false
  }
  if (!left.tail.equals(right.tail)) return false
  const normalize = (header) => JSON.stringify(Object.fromEntries(Object.keys(header).sort().map(key => [key, header[key]])))
  return normalize(left.header) === normalize(right.header)
}

function isPrefix(prefix, whole) {
  return whole.length >= prefix.length && whole.subarray(0, prefix.length).equals(prefix)
}

/**
 * Отношение локального лога к зеркальному по хвосту событий:
 * - `same` — хвосты совпадают (логи равны по смыслу, заголовок не важен);
 * - `localAhead` — зеркало является префиксом локального (отправка допишет);
 * - `cloudAhead` — локальный является префиксом зеркального (приём допишет);
 * - `conflicts` — обе стороны дописали разное (склеить нельзя).
 * Те же правила, что у pull/push: план показывает именно то, что случилось бы.
 */
function relationOf(existing, canonical) {
  let existingTail
  let localTail
  try {
    existingTail = tailOf(existing)
    localTail = tailOf(canonical)
  } catch {
    return 'conflicts'
  }
  if (existingTail.equals(localTail)) return 'same'
  if (isPrefix(existingTail, localTail)) return 'localAhead'
  if (isPrefix(localTail, existingTail)) return 'cloudAhead'
  return 'conflicts'
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function dropCache(home, sessionId) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (existsSync(file)) await rm(file, { force: true })
}

async function backupLog(home, projectId, sessionId, bytes) {
  const dir = join(home, 'dsh-sync', 'backups', stamp())
  const target = join(dir, projectId, `${sessionId}.zstd`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return target
}

function selectedProjects(config, filter) {
  const ids = Object.keys(config.projects)
  if (!filter) return ids.map(id => [id, config.projects[id]])
  if (!config.projects[filter]) throw new Error(`проект не настроен: ${filter} (см. project add)`)
  return [[filter, config.projects[filter]]]
}

// --- группы «родитель + субагенты» -----------------------------------------

/** Разобрать заголовок лога; undefined — лог не читается. */
function headerOf(bytes) {
  if (bytes === undefined) return undefined
  try {
    return splitLog(bytes).header
  } catch {
    return undefined
  }
}

/** Связи «родитель + субагенты» по набору сессий стора или зеркала. */
function groupsOf(sessions) {
  return buildSessionGroups((sessions ?? []).map(session => ({
    id: session.id,
    // Host-часть отдаёт заголовок отдельным полем `parent`, стор — байты лога.
    header: headerOf(session.bytes)
      ?? (typeof session.parent === 'string' && session.parent.trim() !== ''
        ? { id: session.id, parentSession: session.parent.trim() }
        : undefined),
  })))
}

/**
 * Связи в зеркале проекта. Читаются один раз за прогон: по ним видно, каких
 * субагентов нет локально (их нельзя удалять) и кто уйдёт вместе с родителем.
 */
async function mirrorGroups(repoDir, projectId) {
  if (!existsSync(join(repoDir, 'sessions', projectId))) {
    return { parentById: new Map(), childrenByParent: new Map(), sessions: [] }
  }
  const sessions = await listMirrorSessions(repoDir, projectId)
  return { ...groupsOf(sessions), sessions }
}

// --- удаление «везде»: каскад группы и повторное применение меток -----------

/** Сгруппировать id по корню группы: сколько групп и кто в них. */
function groupRoots(parentById, ids) {
  const roots = new Map()
  for (const id of ids ?? []) {
    const root = rootOf(parentById, id)
    const members = roots.get(root) ?? []
    if (!members.includes(id)) members.push(id)
    roots.set(root, members)
  }
  return roots
}

/**
 * Активные метки удаления, которые применяются на этом устройстве.
 *
 * `made-local` — обещание, что сессия живёт только здесь: по такой метке
 * локальные данные не удаляются, и она никогда не снимается.
 */
function activeDeletionMarks(tombstones, skipSessionId = () => false) {
  const marks = new Map()
  for (const [sessionId, mark] of Object.entries(tombstones?.sessions ?? {})) {
    if (!isActiveTombstone(mark)) continue
    if (mark.reason === 'made-local') continue
    if (skipSessionId(sessionId)) continue
    marks.set(sessionId, mark)
  }
  return marks
}

/**
 * Каскад удаления по группе: ребёнок наследует метку ближайшего удалённого
 * предка. Без этого старая метка только родителя оставляла бы детей сиротами.
 *
 * @returns {Map<string, string>} ребёнок → id предка, по чьей метке он удаляется
 */
function groupDeletionCascade(childrenByParent, marks, skip = () => false) {
  const owners = new Map()
  const claimed = new Set(marks.keys())
  const queue = [...marks.keys()]
  while (queue.length > 0) {
    const parentId = queue.shift()
    const owner = marks.has(parentId) ? parentId : owners.get(parentId)
    for (const childId of childrenByParent?.get(parentId) ?? []) {
      if (claimed.has(childId) || skip(childId)) continue
      claimed.add(childId)
      owners.set(childId, owner)
      queue.push(childId)
    }
  }
  return owners
}

/** Дописать сообщение в warning сводки, не теряя прежние. */
function addWarning(summary, message) {
  if (typeof message !== 'string' || message === '') return
  summary.warning = summary.warning === undefined ? message : `${summary.warning}; ${message}`
}

/**
 * Слить сведения о заблокированном автоудалении (по проектам) в одно поле
 * сводки: панель и last-run видят и общий счётчик, и причину.
 */
function mergeDeletionsBlocked(accumulated, blocked, projectId) {
  const next = accumulated ?? {
    count: 0,
    ids: [],
    reason: blocked.reason,
    reasons: [],
    projects: [],
  }
  next.count += Number(blocked.count) || 0
  next.ids = [...new Set([...next.ids, ...(blocked.ids ?? [])])].slice(0, 100)
  if (!next.reasons.includes(blocked.reason)) next.reasons.push(blocked.reason)
  if (next.reason !== blocked.reason) next.reason = next.reasons.length === 1 ? next.reasons[0] : 'mixed'
  next.projects.push({
    id: projectId,
    count: Number(blocked.count) || 0,
    reason: blocked.reason,
    details: blocked.details,
  })
  // Подробности оставляем и на верхнем уровне (по первой/самой большой пачке):
  // панель показывает лимиты, не разбирая projects.
  next.details ??= blocked.details
  next.message = deletionsBlockedMessage(next.count)
  return next
}

/** Слить pendingDeletions по проектам: сколько ждёт подтверждения и почему. */
function mergePendingDeletions(accumulated, pending) {
  if (pending === undefined) return accumulated
  const next = accumulated ?? { count: 0, ids: [], reasons: [] }
  next.count += Number(pending.count) || 0
  next.ids = [...new Set([...next.ids, ...(pending.ids ?? [])])].slice(0, 100)
  next.reasons = [...new Set([...next.reasons, ...(pending.reasons ?? [])])].sort()
  return next
}

// --- правила сессий: поля сводки для UI -------------------------------------

/** Пустая сводка правил: одинаковая форма у push и pull. */
function emptyRuleSummary() {
  return {
    count: 0,
    protected: 0,
    ownerBlocked: 0,
    overLimit: 0,
    localSkipped: 0,
    autoLocal: 0,
    forbidFork: 0,
    notified: 0,
    protectedIds: [],
    ownerBlockedIds: [],
    overLimitIds: [],
    localSkippedIds: [],
    autoLocalIds: [],
    forbidForkIds: [],
    foreignAppendIds: [],
    notifications: [],
    skipped: [],
    sources: { session: 0, parent: 0, match: 0, default: 0 },
    ownerMessage: OWNER_RULE_MESSAGE,
    ownerBlockedCode: 'rule-owner',
    localSkipCode: 'rule-local',
    protectedMessage: PROTECTED_RULE_LABEL,
    limitHint: LIMIT_RULE_HINT,
  }
}

/** Добавить id в список без дублей и с ограничением длины. */
function pushUnique(list, value, limit = 100) {
  if (typeof value !== 'string' || value === '') return
  if (list.includes(value) || list.length >= limit) return
  list.push(value)
}

/** Добавить короткое сообщение правила (для подсказки в панели). */
function pushRuleMessage(bucket, message, limit = 20) {
  if (typeof message !== 'string' || message === '') return
  if (bucket.notifications.length >= limit || bucket.notifications.includes(message)) return
  bucket.notifications.push(message)
}

/**
 * Записать поля правила в сводку (protected/ownerBlocked/overLimit/ruleSource)
 * и вернуть их. В отчёт попадают только сессии с осмысленным правилом: без
 * правила поля не нужны и не раздувают summary.
 */
function noteRuleField(summary, rule, { bytes, deviceId } = {}) {
  if (rule === undefined || rule === null) return undefined
  const field = ruleFields(rule, { bytes, deviceId })
  if (field.ruleSource === 'default' && !field.overLimit && !field.ownerBlocked) return field
  const bucket = summary.rules
  bucket.count += 1
  bucket.sources[field.ruleSource] = (bucket.sources[field.ruleSource] ?? 0) + 1
  if (field.protected) bucket.protected += 1
  if (field.ownerBlocked) {
    bucket.ownerBlocked += 1
    pushUnique(bucket.ownerBlockedIds, field.id)
  }
  if (field.overLimit) {
    bucket.overLimit += 1
    pushUnique(bucket.overLimitIds, field.id)
    pushRuleMessage(bucket, field.message)
  }
  if (field.forbidFork) {
    bucket.forbidFork += 1
    pushUnique(bucket.forbidForkIds, field.id)
  }
  summary.ruleFields.push(field)
  return field
}

/** Отметить защиту правилом в плане удаления (строка «защищена правилом»). */
function noteProtectedRules(summary, rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return
  summary.rules.protected += list.length
  for (const row of list) pushUnique(summary.rules.protectedIds, row.id)
}

/**
 * Применить активные метки к локальным копиям: каждая сессия уходит в
 * отдельный каталог локального архива `dsh-sync/deleted/<stamp>/<id>/`.
 *
 * Это и есть повторное применение метки после приёма или сброса домашнего
 * каталога: иначе «воскресшая» копия жила бы до ручной чистки. Группа
 * удаляется целиком: метка родителя уносит и субагентов.
 *
 * Предохранители M7 (инцидент 25.11):
 *   - лог новее метки больше чем на минуту — сессию (и её группу) не удаляем, а
 *     метку помечаем reason=restored, чтобы повторный проход не пытался снова;
 *   - больше maxAutoRemove независимых удалений, метка старше
 *     maxTombstoneAgeDays или autoApply=false — не удаляем ничего, отдаём
 *     deletionsBlocked для сводки и last-run (удаление — только «Применить
 *     удаления»).
 *
 * @returns {{ deleted: number, deletedIds: string[], deletedDetails: object[],
 *   childrenDeleted: number, childrenDeletedIds: string[],
 *   groupsDeleted: number, roots: string[], reasons: string[], by: string[],
 *   revivedIds: string[], revivedDetails: object[],
 *   restoredMarks: Map<string, object>, tombstonesChanged: boolean,
 *   deletionsBlocked?: object, pendingDeletions?: {count: number, ids: string[], reasons: string[]} }}
 */
async function applyLocalTombstones({
  home,
  config,
  projectPath,
  groups,
  localModes,
  tombstones,
  now = Date.now(),
  dryRun = false,
  // «Применить удаления»: подтверждение обходит массовый предохранитель, но не
  // «воскрешение», не restored и не локальные режимы.
  bypassGuard = false,
  // Ограничить проход конкретными id (подтверждённое удаление по запросу).
  onlyIds = undefined,
  // Удалять только сессии со своей меткой: унаследованный каскад группы в
  // подтверждённом проходе оставляем плану зеркала (как было до M7).
  ownMarksOnly = false,
}) {
  const result = {
    deleted: 0,
    deletedIds: [],
    deletedDetails: [],
    childrenDeleted: 0,
    childrenDeletedIds: [],
    groupsDeleted: 0,
    roots: [],
    reasons: [],
    by: [],
    quarantineDirs: [],
    // «Воскрешение»: сессии, чей лог новее метки (восстановили или продолжили).
    revivedIds: [],
    revivedDetails: [],
    // Метки, которые в этом проходе стали restored: pull запишет их после
    // fetch+reset, иначе сброс дерева зеркала стёр бы защиту.
    restoredMarks: new Map(),
    tombstonesChanged: false,
    deletionsBlocked: undefined,
    pendingDeletions: undefined,
  }
  const skip = sessionId => localModes?.localIds?.has(normalizeSessionId(sessionId)) === true
  const marks = activeDeletionMarks(tombstones, skip)
  if (marks.size === 0) return result
  const owners = groupDeletionCascade(groups?.childrenByParent, marks, skip)

  // 1. Собрать кандидатов: у кого реально есть локальная копия. Для каждой
  //    сессии запоминаем метку-корень операции (группа — одна операция).
  const plans = []
  const candidates = new Set()
  const rootBySession = new Map()
  for (const sessionId of [...marks.keys(), ...owners.keys()]) {
    if (skip(sessionId)) continue
    const hasOwnMark = marks.has(sessionId)
    const ownerId = hasOwnMark ? sessionId : owners.get(sessionId)
    const mark = marks.get(ownerId)
    if (mark === undefined) continue
    const dir = localSessionDir(home, projectPath, sessionId)
    if (!existsSync(dir)) continue
    if (onlyIds !== undefined) {
      // Подтверждённый запрос по id: берём только его группу, чужие метки не трогаем.
      const requested = onlyIds.has(sessionId) || onlyIds.has(ownerId) || onlyIds.has(deletionRootOf(marks, ownerId))
      if (!requested) continue
    }
    let mtimeMs
    try {
      mtimeMs = (await stat(join(dir, LOG_NAME))).mtimeMs
    } catch {
      // Лог не прочитался как файл: время неизвестно, защита не сработает.
    }
    const root = deletionRootOf(marks, ownerId)
    candidates.add(sessionId)
    rootBySession.set(sessionId, root)
    plans.push({ sessionId, mark, ownerId, hasOwnMark, childTombstone: !hasOwnMark || (typeof mark.parent === 'string' && mark.parent !== ''), dir, mtimeMs, root })
  }
  if (plans.length === 0) return result

  // 2. «Воскрешение»: лог новее метки — это восстановленная/продолженная сессия.
  //    Защищаем всю операцию целиком: иначе метка родителя удалила бы группу, из
  //    которой вернули только одного ребёнка.
  const revivedRoots = new Set()
  for (const plan of plans) {
    if (!logNewerThanTombstone(marks.get(plan.root), plan.mtimeMs)) continue
    revivedRoots.add(plan.root)
    result.revivedIds.push(plan.sessionId)
    result.revivedDetails.push({
      id: plan.sessionId,
      root: plan.root,
      reason: typeof plan.mark.reason === 'string' ? plan.mark.reason : 'manual',
      markAt: typeof plan.mark.at === 'string' ? plan.mark.at : '',
      logMtime: new Date(plan.mtimeMs).toISOString(),
    })
  }
  if (revivedRoots.size > 0 && !dryRun) {
    for (const rootId of revivedRoots) {
      const entry = tombstones?.sessions?.[rootId]
      if (entry === undefined || !isActiveTombstone(entry)) continue
      markRestored(tombstones, rootId, { by: 'sync', at: now, device: config.deviceId })
      result.restoredMarks.set(rootId, { ...tombstones.sessions[rootId] })
      result.tombstonesChanged = true
    }
  }
  result.revivedIds = [...new Set(result.revivedIds)].slice(0, 100)

  // 3. Массовый предохранитель: считается по независимым операциям удаления.
  //    Подтверждённое удаление (bypassGuard) его обходит — это и есть ручное
  //    подтверждение «Применить удаления». «Воскрешение» выше обходится нельзя.
  const autoCandidates = [...candidates].filter((sessionId) => {
    if (revivedRoots.has(rootBySession.get(sessionId))) return false
    if (ownMarksOnly !== true) return true
    return plans.find(plan => plan.sessionId === sessionId)?.hasOwnMark === true
  })
  if (autoCandidates.length > 0 && bypassGuard !== true) {
    const violation = deletionGuardViolation({
      candidates: autoCandidates,
      rootBySession,
      marks,
      settings: deletionsConfig(config),
      now,
    })
    if (violation !== undefined) {
      result.deletionsBlocked = { ...violation, details: { ...violation.details, projectPath } }
      result.pendingDeletions = {
        count: autoCandidates.length,
        ids: [...autoCandidates].sort().slice(0, 100),
        reasons: deletionReasonsOf(autoCandidates, marks),
      }
      // Ничего не удаляем: ни одну метку из пачки, даже «свежую».
      return result
    }
  }

  // 4. Удаление разрешено: переносим в локальный архив только не-восставших.
  const roots = new Set()
  for (const plan of plans) {
    const { sessionId, mark, childTombstone, dir } = plan
    if (revivedRoots.has(plan.root)) continue
    if (ownMarksOnly === true && plan.hasOwnMark !== true) continue
    const reason = childTombstone
      ? CHILDREN_REASON
      : (typeof mark.reason === 'string' && mark.reason !== '' ? mark.reason : 'manual')
    const parent = childTombstone ? (owners.get(sessionId) ?? mark.parent ?? '') : ''
    const moved = await quarantineLocalCopy({
      home,
      sessionDir: dir,
      sessionId,
      reason,
      parent,
      by: typeof mark.by === 'string' && mark.by !== '' ? mark.by : 'sync',
      deviceId: config.deviceId,
      now,
      dryRun,
    })
    result.deleted += 1
    result.deletedIds.push(sessionId)
    roots.add(rootOf(groups?.parentById, sessionId))
    if (moved.quarantined === true) result.quarantineDirs.push(moved.dir)
    if (childTombstone) {
      result.childrenDeleted += 1
      result.childrenDeletedIds.push(sessionId)
    }
    if (typeof mark.by === 'string' && mark.by !== '') result.by.push(mark.by)
    result.reasons.push(reason)
    result.deletedDetails.push({
      id: sessionId,
      reason,
      by: mark.by,
      ...(childTombstone ? { parent, inherited: !plan.hasOwnMark } : {}),
    })
  }
  result.groupsDeleted = roots.size
  result.roots = [...roots]
  result.childrenDeletedIds = result.childrenDeletedIds.slice(0, 100)
  result.reasons = [...new Set(result.reasons)]
  result.by = [...new Set(result.by)]
  return result
}

/**
 * Записать метки reason=restored после приёма/повторного применения.
 *
 * Пишем отдельным проходом ПОСЛЕ fetch+reset (в pull он сбрасывает дерево
 * зеркала): иначе защита от повторного автоудаления терялась бы сразу же.
 * Уже неактивную метку не трогаем, отсутствующую — создаём: запись остаётся
 * историей до ближайшей отправки, которая вычищает снятые метки.
 *
 * @param restored карта id метки-корня → запись (как после markRestored).
 * @returns сколько меток записано.
 */
async function persistRestoredMarks({ config, restored, now = Date.now() }) {
  if (!(restored instanceof Map) || restored.size === 0) return 0
  let data
  try {
    data = await readTombstones(config.repoDir)
  } catch {
    return 0
  }
  let written = 0
  for (const sessionId of restored.keys()) {
    const entry = data.sessions[sessionId]
    if (entry !== undefined && !isActiveTombstone(entry)) continue
    if (entry !== undefined) {
      markRestored(data, sessionId, { by: 'sync', at: now, device: config.deviceId })
    } else {
      addTombstone(data, sessionId, config.deviceId, { reason: 'restored', by: 'sync', at: now })
    }
    written += 1
  }
  if (written > 0) {
    try {
      await writeTombstones(config.repoDir, data)
    } catch {
      // запись — страховка: приём уже выполнен
    }
  }
  return written
}

/**
 * Повторно применить активные метки удаления к локальным копиям (reconcile).
 *
 * Нужен после сброса/восстановления домашнего каталога и как самостоятельное
 * действие: метка уже принята, а копия сессии появилась позже. `made-local` не
 * трогаем — сессия обещана только этому устройству. Предохранители M7 те же,
 * что и в pull: «воскрешение» и массовая пачка ждут подтверждения.
 *
 * @returns сводка: deleted/deletedIds/groupsDeleted/childrenDeleted/reasons/by,
 *   revivedIds, deletionsBlocked, pendingDeletions, warning.
 */
export async function reconcileLocalDeletions({ home, config, project, dryRun = false, now = Date.now() }) {
  const local = await listLocalSessions(home)
  const modes = (await applyWorkspaceDefaults(home)).modes
  const tombstones = await readTombstones(config.repoDir)
  const summary = {
    ok: true,
    action: 'reconcile',
    deleted: 0,
    deletedIds: [],
    deletedDetails: [],
    groupsDeleted: 0,
    childrenDeleted: 0,
    childrenDeletedIds: [],
    reasons: [],
    by: [],
    projects: [],
    // M7: что не удалено и почему.
    revivedIds: [],
    revivedDetails: [],
    deletionsBlocked: undefined,
    pendingDeletions: undefined,
    restoredMarks: new Map(),
  }
  for (const [projectId, entry] of selectedProjects(config, project)) {
    const projectLocal = sessionsOfProject(local, entry.path)
    const groups = groupsOf(projectLocal)
    const localModes = resolveGroupModes(modes, projectLocal, groups)
    const deleted = await applyLocalTombstones({
      home,
      config,
      projectPath: entry.path,
      groups,
      localModes,
      tombstones,
      now,
      dryRun,
    })
    // M7: что осталось живым и почему — независимо от того, было ли удаление.
    for (const [sessionId, entryMark] of deleted.restoredMarks ?? []) summary.restoredMarks.set(sessionId, entryMark)
    if (deleted.revivedIds.length > 0) {
      summary.revivedIds = [...new Set([...summary.revivedIds, ...deleted.revivedIds])].slice(0, 100)
      summary.revivedDetails = [...summary.revivedDetails, ...deleted.revivedDetails].slice(0, 100)
    }
    if (deleted.deletionsBlocked !== undefined) {
      summary.deletionsBlocked = mergeDeletionsBlocked(summary.deletionsBlocked, deleted.deletionsBlocked, projectId)
      summary.pendingDeletions = mergePendingDeletions(summary.pendingDeletions, deleted.pendingDeletions)
    }
    if (deleted.deleted === 0) continue
    summary.deleted += deleted.deleted
    summary.deletedIds.push(...deleted.deletedIds)
    summary.deletedDetails.push(...deleted.deletedDetails)
    summary.groupsDeleted += deleted.groupsDeleted
    summary.childrenDeleted += deleted.childrenDeleted
    summary.childrenDeletedIds.push(...deleted.childrenDeletedIds)
    summary.reasons.push(...deleted.reasons)
    summary.by.push(...deleted.by)
    summary.projects.push({ id: projectId, deleted: deleted.deleted, groupsDeleted: deleted.groupsDeleted })
  }
  summary.deletedIds = summary.deletedIds.slice(0, 100)
  summary.childrenDeletedIds = summary.childrenDeletedIds.slice(0, 100)
  summary.reasons = [...new Set(summary.reasons)]
  summary.by = [...new Set(summary.by)]
  // Метки restored пишем отдельно (Map в отчёт не отдаём: это служебные данные).
  const restoredMarks = summary.restoredMarks instanceof Map ? summary.restoredMarks : new Map()
  delete summary.restoredMarks
  if (!dryRun && restoredMarks.size > 0) await persistRestoredMarks({ config, restored: restoredMarks, now })
  if (summary.deletionsBlocked !== undefined) {
    addWarning(summary, deletionsBlockedMessage(summary.deletionsBlocked.count))
  } else if (summary.revivedIds.length > 0) {
    addWarning(summary, `метки удаления сняты (лог новее метки): ${summary.revivedIds.length}`)
  }
  summary.message = summary.deleted > 0
    ? `повторно применены метки удаления: ${summary.deleted}`
    : (summary.deletionsBlocked !== undefined
      ? 'автоудаление остановлено предохранителем — нужно подтверждение'
      : 'удалять нечего: активных меток нет или копий уже нет')
  return summary
}


// --- дубли: импорт без копий и корзина «Дубли» (M1) ------------------------

/** Заголовок лога родителя: ссылка `parentSession` — часть идентичности копии. */
function parentOf(bytes) {
  const value = headerOf(bytes)?.parentSession
  return typeof value === 'string' ? value : ''
}

/**
 * Настоящая ли это копия сессии с другим id (а не просто похожая сессия).
 *
 * Совпадения по `lineageKey` мало: у группы «родитель + субагенты» линия одна,
 * а сессии разные, и лог ребёнка после нормализации id может совпасть с логом
 * внука. Поэтому требуем одинаковый `contentHash` и ту же ссылку на родителя:
 * у копии одной сессии эти поля совпадают, у разных детей — нет.
 *
 * @param {object} localSession локальная сессия с `bytes`
 * @param {object} identity идентичность приезжающей сессии
 * @param {string} projectId проект для нормализации пути
 * @returns {boolean}
 */
function sameSessionCopy(localSession, identity, remoteBytes, projectId) {
  if (localSession?.bytes === undefined || localSession.bytes === null) return false
  let local
  try {
    local = computeSessionIdentity({ bytes: localSession.bytes, projectId, title: localSession.title })
  } catch {
    return false
  }
  if (local.contentHash !== identity.contentHash) return false
  if (local.lineageKey !== identity.lineageKey) return false
  return parentOf(localSession.bytes) === parentOf(remoteBytes)
}

/** Сколько групп дублей отдаём подробно (счётчики при этом полные). */
export const DUPLICATE_REPORT_GROUP_LIMIT = 100

/**
 * Карантинные копии зеркала проекта: удалённые (`_deleted/<id>/`) и
 * проигравшие восстановление (`_deleted/<id>.superseded-<время>/`).
 *
 * @returns {Promise<Array<{id: string, cwd?: string, createdAt?: number,
 *   path: string, dir: string, bytes: Buffer, size: number,
 *   side: 'quarantine', quarantined: true}>>}
 */
export async function listQuarantineSessions(repoDir, projectId) {
  const root = join(repoDir, 'sessions', projectId, QUARANTINE_DIR)
  const result = []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const path = join(dir, LOG_NAME)
    if (!existsSync(path)) continue
    let bytes
    try {
      bytes = await readFile(path)
    } catch {
      continue
    }
    const header = headerOf(bytes)
    if (header === undefined) continue
    result.push({
      id: header.id,
      cwd: header.cwd,
      createdAt: header.createdAt,
      path,
      dir,
      bytes,
      size: bytes.length,
      side: 'quarantine',
      quarantined: true,
    })
  }
  return result
}

/** Связи «родитель + субагенты» по нескольким наборам сессий (стор + зеркало). */
function mergeChildren(...views) {
  const byId = new Map()
  for (const view of views) {
    for (const [parentId, children] of view?.childrenByParent ?? []) {
      const list = byId.get(parentId) ?? []
      for (const childId of children) if (!list.includes(childId)) list.push(childId)
      byId.set(parentId, list)
    }
  }
  return byId
}

/**
 * «Найти дубли»: группы копий одной сессии среди локального стора, зеркала и
 * карантина. Только чтение — ничего не пишет, не удаляет и не отправляет.
 *
 * Канонический id каждой группы выбирается детерминированно
 * (`rankCandidates` + `chooseCanonical`): больше событий → больше размер →
 * больше детей → раньше создана → меньше id. Если у победителя детей нет, а у
 * копии есть, канонической становится копия с детьми — субагенты не теряются.
 *
 * @param {object} options
 * @param {string} options.home каталог DSH
 * @param {object} options.config настройки синхронизации
 * @param {string} [options.project] фильтр проекта
 * @returns {Promise<object>} отчёт: группы, счётчики и сообщение
 */
export async function collectDuplicateGroups({ home, config, project } = {}) {
  const started = Date.now()
  const local = await listLocalSessions(home)
  const tombstones = await readTombstones(config.repoDir)
  const groups = []
  let totalSessions = 0
  let totalBytes = 0
  let duplicates = 0
  for (const [projectId, entry] of selectedProjects(config, project)) {
    const projectLocal = sessionsOfProject(local, entry?.path ?? '')
    const mirror = existsSync(join(config.repoDir, 'sessions', projectId))
      ? await listMirrorSessions(config.repoDir, projectId)
      : []
    const quarantine = await listQuarantineSessions(config.repoDir, projectId)
    if (projectLocal.length + mirror.length + quarantine.length < 2) continue
    const candidates = [
      ...projectLocal.map(session => ({
        id: session.id,
        side: 'local',
        bytes: session.bytes,
        sizeBytes: Number(session.size ?? session.bytes?.length ?? 0) || 0,
        createdAt: session.createdAt,
      })),
      ...mirror.map(session => ({
        id: session.id,
        side: 'mirror',
        bytes: session.bytes,
        sizeBytes: Number(session.size ?? 0) || 0,
        createdAt: headerOf(session.bytes)?.createdAt,
      })),
      ...quarantine.map(session => ({
        id: session.id,
        side: 'quarantine',
        bytes: session.bytes,
        sizeBytes: session.size,
        createdAt: session.createdAt,
      })),
    ]
    if (candidates.length < 2) continue
    const localGroups = groupsOf(projectLocal)
    const mirrorView = { ...groupsOf(mirror), sessions: mirror }
    const childrenById = mergeChildren(localGroups, mirrorView)
    for (const group of duplicateGroups(candidates, { projectId })) {
      if (group.sessions.length < 2) continue
      const ranked = rankCandidates(group.sessions, childrenById)
      // Канонической не может быть копия из карантина, когда есть живая: иначе
      // действие оставило бы «удалённую» копию, а видимую сессию убрало.
      // Исключение — карантинная копия с детьми: при восстановлении субагенты
      // должны остаться при ней (канонический id с детьми).
      const isLive = (candidate) => (Array.isArray(candidate.sides) ? candidate.sides : [candidate.side])
        .some(side => side === 'local' || side === 'mirror')
      const liveRanked = ranked.filter(isLive)
      const globalWinner = ranked[0]
      const liveWinner = liveRanked[0]
      let poolWinner = globalWinner
      if (liveWinner !== undefined && !isLive(globalWinner)) {
        const childCount = (candidate) => (childrenById.get(candidate.id) ?? []).length
        if (childCount(globalWinner) <= childCount(liveWinner)) poolWinner = liveWinner
      }
      const canonical = chooseCanonical(poolWinner, ranked, { childrenById, tombstones })
      const groupBytes = ranked.reduce((total, candidate) => total + (Number(candidate.sizeBytes ?? 0) || 0), 0)
      const sessions = ranked.map(candidate => ({
        id: candidate.id,
        side: candidate.sides !== undefined && candidate.sides.length > 1 ? 'both' : (candidate.side ?? ''),
        sides: Array.isArray(candidate.sides) ? candidate.sides : (candidate.side === undefined ? [] : [candidate.side]),
        sizeBytes: Number(candidate.sizeBytes ?? 0) || 0,
        events: Number(candidate.events ?? 0) || 0,
        live: isLive(candidate),
        canonical: candidate.id === canonical.canonicalId,
      }))
      const losers = sessions.filter(item => item.canonical !== true)
      // В карантин уходят только живые копии: карантинные уже убраны, их не
      // считаем в числе лишних для действия.
      const liveLosers = losers.filter(item => item.live === true).map(item => item.id)
      const alreadyQuarantined = losers.filter(item => item.live !== true).length
      const record = {
        projectId,
        match: group.match,
        canonicalId: canonical.canonicalId,
        winnerId: canonical.winnerId,
        children: canonical.children,
        supersededIds: losers.map(item => item.id),
        liveSupersededIds: liveLosers,
        alreadyQuarantined,
        sessions,
        sizeBytes: groupBytes,
      }
      const events = ranked.reduce((total, candidate) => total + (Number(candidate.events ?? 0) || 0), 0)
      if (events > 0) record.events = events
      if (group.contentHash !== undefined) record.contentHash = group.contentHash
      if (group.lineageKey !== undefined && group.lineageKey !== '') record.lineageKey = group.lineageKey
      groups.push(record)
      totalSessions += sessions.length
      totalBytes += groupBytes
      duplicates += liveLosers.length
    }
  }
  groups.sort((left, right) => (left.projectId === right.projectId
    ? left.canonicalId.localeCompare(right.canonicalId)
    : left.projectId.localeCompare(right.projectId)))
  const limited = groups.slice(0, DUPLICATE_REPORT_GROUP_LIMIT)
  return {
    ok: true,
    action: 'duplicates',
    readOnly: true,
    mode: 'read-only',
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    // count — групп; duplicates — лишних копий, которые уйдут в карантин.
    count: groups.length,
    groups: limited,
    truncated: groups.length > limited.length,
    duplicates,
    sessions: totalSessions,
    bytes: totalBytes,
    reasons: duplicates > 0 ? ['duplicate'] : [],
    message: duplicates > 0
      ? `Найдено дублей: ${duplicates} (групп: ${groups.length}). Лишние копии можно убрать в карантин на 30 дней, каноническая останется.`
      : groups.length > 0
        ? `Групп с копиями: ${groups.length}, но лишние копии уже в карантине — убирать нечего.`
        : 'Дублей нет: копий одной сессии с разными id не найдено.',
  }
}

/**
 * Перенести копии сессий в карантин с указанной причиной.
 *
 * Зеркальная копия уезжает в `sessions/<проект>/_deleted/<id>/`, локальная — в
 * `~/.dsh/dsh-sync/deleted/<время>/<id>/`, и ставится метка с причиной
 * (`duplicate` для лишних копий, `superseded` для проигравших восстановление).
 * Ничего не удаляется безвозвратно.
 *
 * @returns {Promise<{moved: number, movedIds: string[], skipped: Array<{id: string, reason: string}>, bytes: number}>}
 */
export async function quarantineSessionCopies({
  home,
  config,
  projectId,
  projectPath = '',
  ids = [],
  reason = 'duplicate',
  by = 'sync',
  tombstones,
} = {}) {
  const data = tombstones ?? await readTombstones(config.repoDir)
  const summary = { moved: 0, movedIds: [], skipped: [], bytes: 0 }
  const archiveStamp = stamp()
  const seen = new Set()
  for (const raw of ids) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const sessionId = raw.trim()
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    const mirrorDir = join(config.repoDir, 'sessions', projectId, encodeSegment(sessionId))
    const mirrorLog = join(mirrorDir, LOG_NAME)
    const hasMirror = existsSync(mirrorLog)
    const localDir = projectPath === '' ? '' : localSessionDir(home, projectPath, sessionId)
    const hasLocal = localDir !== '' && existsSync(localDir)
    if (!hasMirror && !hasLocal) {
      summary.skipped.push({ id: sessionId, reason: 'not-found' })
      continue
    }
    let size = 0
    let title = ''
    let movedAny = false
    if (hasMirror) {
      try {
        size = (await stat(mirrorLog)).size
      } catch {
        size = 0
      }
      try {
        const sidecar = JSON.parse(await readFile(join(mirrorDir, SESSION_SIDECAR_FILE), 'utf8'))
        if (typeof sidecar?.title === 'string') title = sidecar.title.trim()
      } catch {
        title = ''
      }
      const target = quarantinePath(config.repoDir, projectId, sessionId)
      try {
        await mkdir(dirname(target), { recursive: true })
        // В карантине могла остаться копия этого же id: не затираем её молча,
        // а переносим лишнюю рядом с меткой `.superseded-`.
        if (existsSync(join(target, LOG_NAME))) {
          await rename(target, supersededQuarantineDir(config.repoDir, projectId, sessionId))
        }
        await rename(mirrorDir, target)
        const deletedAt = {
          at: new Date().toISOString(),
          reason,
          by,
          device: config.deviceId,
          keptFor: 'restore',
        }
        if (title !== '') deletedAt.title = title
        if (size > 0) deletedAt.size = size
        await writeFile(join(target, DELETED_AT_FILE), `${JSON.stringify(deletedAt)}\n`, 'utf8')
        movedAny = true
      } catch {
        summary.skipped.push({ id: sessionId, reason: 'mirror-rename-failed' })
      }
    }
    if (hasLocal) {
      const archive = join(home, 'dsh-sync', 'deleted', archiveStamp, encodeSegment(sessionId))
      try {
        await mkdir(dirname(archive), { recursive: true })
        await rename(localDir, archive)
        movedAny = true
      } catch {
        summary.skipped.push({ id: sessionId, reason: 'local-rename-failed' })
      }
      await dropCache(home, sessionId)
    }
    if (!movedAny) continue
    addTombstone(data, sessionId, config.deviceId, { reason, by, ...(size > 0 ? { size } : {}), ...(title !== '' ? { title } : {}) })
    summary.moved += 1
    summary.movedIds.push(sessionId)
    summary.bytes += size
  }
  return summary
}

/**
 * «Убрать дубли в карантин»: лишние копии групп уходят в карантин с причиной
 * `duplicate`, каноническая копия каждой группы остаётся нетронутой.
 *
 * Требует явного подтверждения. Сначала зеркало по возможности обновляется, но
 * сетевой сбой локальное действие не отменяет: файлы переносятся, метки
 * пишутся, а отправка повторится из очереди (это делает host-часть).
 *
 * @param {object} options
 * @param {string[]} [options.ids] ограничить действие группами/копиями
 * @param {boolean} [options.confirm] должно быть true
 */
export async function quarantineDuplicates({ home, config, project, ids, confirm = false, message } = {}) {
  if (confirm !== true) {
    return {
      ok: false,
      code: 'confirm-required',
      action: 'duplicates',
      message: 'убрать дубли в карантин можно только с подтверждением (confirm:true): каноническая копия останется',
    }
  }
  if (config.backend === 'git' && (config.remote ?? '').length === 0) {
    throw new Error('не задан адрес репозитория — укажите его в настройках плагина или нажмите «Создать репозиторий»')
  }
  const report = await collectDuplicateGroups({ home, config, project })
  const requested = Array.isArray(ids)
    ? new Set(ids.filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))
    : undefined
  const tombstones = await readTombstones(config.repoDir)
  const summary = {
    ok: true,
    action: 'duplicates',
    confirmed: true,
    mode: 'manual',
    groups: 0,
    quarantined: 0,
    quarantinedIds: [],
    kept: 0,
    keptIds: [],
    skipped: [],
    bytes: 0,
    reasons: ['duplicate'],
    by: ['sync'],
  }
  for (const group of report.groups) {
    const projectId = group.projectId
    const projectPath = typeof config.projects?.[projectId]?.path === 'string' ? config.projects[projectId].path : ''
    // Действие трогает только живые копии: карантинные уже убраны.
    const losers = (group.liveSupersededIds ?? group.supersededIds ?? [])
      .filter(id => requested === undefined || requested.has(id) || requested.has(group.canonicalId))
    if (losers.length === 0) {
      if (requested === undefined || group.sessions.some(item => requested.has(item.id))) {
        summary.kept += 1
        summary.keptIds.push(group.canonicalId)
      }
      continue
    }
    const moved = await quarantineSessionCopies({
      home,
      config,
      projectId,
      projectPath,
      ids: losers,
      reason: 'duplicate',
      by: 'sync',
      tombstones,
    })
    summary.bytes += moved.bytes
    if (moved.moved > 0) {
      summary.groups += 1
      summary.quarantined += moved.moved
      summary.quarantinedIds.push(...moved.movedIds)
      summary.kept += 1
      summary.keptIds.push(group.canonicalId)
    }
    for (const item of moved.skipped) summary.skipped.push({ ...item, projectId })
  }
  // Файл меток трогаем только когда что-то реально убрали: пустой карантин не
  // должен менять зеркало.
  if (summary.quarantined > 0) await writeTombstones(config.repoDir, tombstones)
  summary.message = summary.quarantined > 0
    ? `в карантин убрано лишних копий: ${summary.quarantined}; канонических оставлено: ${summary.kept}`
    : 'убирать нечего: лишних копий не найдено (канонические не тронуты)'
  // Очередь/повтор отправки — забота вызывающей стороны: локальные файлы уже
  // перенесены, метки записаны, коммит можно повторить.
  return summary
}

/**
 * Состояние движка: какие сессии это устройство отправляло, плюс служебные
 * отметки (например, `secondary.initialized` для резервного канала). Само
 * чтение/запись живёт в `sync-state.mjs`: тот же файл нужен плану «Проверить»,
 * а ему не нужно тянуть весь движок синхронизации.
 */
export { readSyncState, writeSyncState }

const readState = readSyncState
const writeState = writeSyncState

export async function push({ home, config, project, prune = true, message, sessions: provided, dshVersion }) {
  // Для git-бэкенда без адреса репозитория пушить некуда: лучше сказать об этом
  // прямо, чем падать на «origin does not appear to be a git repository».
  if (config.backend === 'git' && (config.remote ?? '').length === 0) {
    throw new Error('не задан адрес репозитория — укажите его в настройках плагина или нажмите «Создать репозиторий»')
  }
  // Свежие ручные пометки читаем ДО синхронизации дерева зеркала: панельное
  // удаление пишет tombstones.json сразу, а fetch+reset затёр бы незакоммиченное.
  const pendingManual = pendingManualTombstones(await readTombstones(config.repoDir))
  const remote = await createRemote(config)
  await remote.sync()

  // Зеркало — производная домашних реестров. После fetch+reset возвращаем в
  // него объявления «локальная навсегда» из дома: иначе в зеркале останется
  // устаревший набор с другого устройства — и снова размножит локальные режимы
  // (инцидент 25.11: 11 фантомных объявлений). Ошибка не блокирует отправку.
  try {
    await publishLocalOnly({ home, repoDir: config.repoDir })
  } catch {
    // объявления не критичны для отправки сессий
  }

  // Зеркало в более новом формате логов: старая сборка не понимает новый формат
  // и не должна писать туда (иначе данные на другом устройстве испортятся).
  // Формат читается из фактических метаданных зеркала после fetch: projects.json
  // → dsh.format, а у старых зеркал — projects.version.
  let meta = await readMeta(config.repoDir)
  const mirrorFormat = readMirrorFormat(meta)
  if (mirrorFormat !== undefined && mirrorFormat > LOG_FORMAT) {
    return blockedPushSummary({ home, config, project, mirrorFormat, sessions: provided })
  }

  // Правила сессий (задача 22): protect/ownerDevice/maxMb/syncMode. Перед
  // отправкой вливаем копию правил из зеркала профиля — правила, заданные на
  // другом устройстве, не теряются. Ошибка правил не блокирует отправку.
  let rulesStore = await readSessionRules(home)
  let ruleConflicts = []
  if (config.profile?.enabled !== false) {
    try {
      const mergedRules = await mergeRulesFromProfile({ home, repoDir: config.repoDir })
      rulesStore = mergedRules.rules
      ruleConflicts = mergedRules.conflicts ?? []
    } catch {
      // файл правил в зеркале может быть недоступен — работаем с локальными
    }
  }

  const local = provided === undefined ? await listLocalSessions(home) : []
  // Режимы «локальная / облачная» — настройка этого устройства: локальные
  // сессии не отправляются, не попадают в состояние и не дают надгробий.
  // Новые сессии сначала получают умолчание своего рабочего пространства.
  const modes = (await applyWorkspaceDefaults(home)).modes
  const state = await readState(home)
  const summary = {
    projects: [],
    pushed: 0,
    removed: 0,
    skipped: 0,
    localSkipped: 0,
    // Локальные сессии, у которых в зеркале осталась копия: prune их не
    // трогает, и это считается отдельно — панель показывает, что копии живы.
    localMirrorProtected: 0,
    // Журнал: сколько сессий и субагентов обменяно и каких детей не хватает
    // локально (подробности — в истории, см. history.mjs).
    sessions: 0,
    subagents: 0,
    childrenMissing: [],
    // Группы «родитель + субагенты»: сколько групп уехало, сколько в них детей
    // и сколько детей уехало без родителя (сирота в источнике — не удаляем).
    groups: 0,
    children: 0,
    orphans: 0,
    // Правила сессий: поля для UI (protected/ownerBlocked/overLimit/ruleSource)
    // и счётчики удержаний (чужой владелец, «только локальная», лимит размера).
    ruleFields: [],
    rules: emptyRuleSummary(),
  }
  const tombstones = await readTombstones(config.repoDir)
  let tombstonesDirty = false
  // Перенести ручные пометки, которые не успели попасть в коммит зеркала.
  if (mergePendingManualTombstones(tombstones, pendingManual) > 0) tombstonesDirty = true
  // Снятые пометки (reason=restored) — исторический след: сессия возвращена,
  // удаление больше не действует. Убираем их ближайшей отправкой, чтобы файл не
  // рос; сам факт восстановления остаётся в журнале запусков.
  for (const [sessionId, tombstone] of Object.entries(tombstones.sessions)) {
    if (!isActiveTombstone(tombstone)) {
      delete tombstones.sessions[sessionId]
      tombstonesDirty = true
    }
  }
  const localVersion = dshVersion ?? await detectDshVersion()

  // Сводка плана и счётчик отложенных удалений — в журнал последнего запуска:
  // панель показывает «удалений: N (ждёт подтверждения)», ничего не удаляя.
  const planCounts = { onlyLocal: 0, onlyCloud: 0, same: 0, localAhead: 0, cloudAhead: 0, conflicts: 0 }
  let skippedDeletions
  let planDeletionCount = 0
  let knownTotal = 0
  let overCountAny = false
  let overRatioAny = false
  let needsGroupConfirmAny = false
  // M7: pendingDeletions — что именно ждёт подтверждения и по какой причине.
  const pendingDeletionIds = []
  const pendingDeletionReasons = new Set()

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const allSessions = provided ?? sessionsOfProject(local, entry.path)
    // Единица обмена — группа «родитель + субагенты»: режим «локальная»
    // наследуется детьми, иначе субагент уехал бы в зеркало без родителя.
    const localGroups = groupsOf(allSessions)
    const modeView = resolveGroupModes(modes, allSessions, localGroups)
    const sessions = allSessions.filter(session => !modeView.localIds.has(normalizeSessionId(session.id)))
    const localIds = new Set([...modeView.localIds].map(normalizeSessionId))
    summary.localSkipped += localIds.size
    if (modeView.forcedChildren.length > 0) {
      summary.localForced = modeView.forcedChildren.slice(0, 50)
      summary.localForcedCount = modeView.forcedChildren.length
    }
    const current = new Set(sessions.map(session => session.id))
    const pushedBefore = summary.pushed
    const previous = new Set(state.projects[projectId] ?? [])
    // Локальные сессии по id: нужны, чтобы сравнить время сессии с меткой
    // удаления (метка сильнее простого присутствия файла).
    const localById = new Map(allSessions.map(session => [session.id, session]))
    // Если удаление остановлено порогом, состояние проекта не обновляем:
    // иначе следующий (подтверждённый) прогон не увидит кандидатов.
    let deferState = false
    // Источник (локальный стор) для группы: сирота — ребёнок, чьего родителя
    // здесь нет. Его отправляем, но не удаляем ни здесь, ни из зеркала.
    const sourceIds = new Set(allSessions.map(session => session.id))
    const localOrphans = new Set(orphanChildren({
      parentById: localGroups.parentById,
      present: sourceIds,
      tombstones,
    }).map(item => item.id))
    const pushRoots = new Set()
    const pushedChildren = new Set()
    const pushedOrphans = new Set()
    // Правила проекта: наследование считается по локальным группам, чтобы
    // субагент без своего правила вёл себя как родитель (в т.ч. ownerDevice).
    const resolvedRules = resolveRulesForSessions({
      rules: rulesStore,
      sessions: allSessions,
      groups: localGroups,
      workspaceId: projectId,
      deviceId: config.deviceId,
    })

    for (const session of sessions) {
      // Поля правила — в отчёт сразу: панель показывает бейджи даже у
      // сессий, которые правило удержало от отправки.
      const rule = resolvedRules.get(normalizeRuleId(session.id))
      const ruleField = noteRuleField(summary, rule, {
        bytes: Number.isFinite(session.size) ? session.size : undefined,
        deviceId: config.deviceId,
      })
      // «Только владелец»: чужое устройство сессию не отправляет, иначе правило
      // ownerDevice обходилось бы обычным push. Причина — rule-owner.
      if (ruleField?.ownerBlocked === true) {
        if (summary.rules.skipped.length < 100) {
          summary.rules.skipped.push({
            id: session.id,
            reason: 'rule-owner',
            ownerDevice: rule.ownerDevice,
            message: OWNER_RULE_MESSAGE,
          })
        }
        continue
      }
      // archive: правило объявило сессию локальной — в зеркало она не уходит.
      if (rule?.syncMode === 'local') {
        summary.rules.localSkipped += 1
        pushUnique(summary.rules.localSkippedIds, session.id)
        if (summary.rules.skipped.length < 100) {
          summary.rules.skipped.push({ id: session.id, reason: 'rule-local', message: 'правило: только локальная' })
        }
        continue
      }
      try {
        const source = session.bytes
          ?? (session.path !== undefined
            ? await readFile(session.path)
            : await readFile(join(localSessionDir(home, entry.path, session.id), 'session.v4.jsonl.zstd')))
        // maxMb: лог перерос лимит правила — строка в отчёте и предложение
        // перевести в локальные. Авто-переключение — только при autoLocal.
        const ruleLimit = overLimitOf(rule, source.length)
        if (ruleLimit.overLimit && ruleField?.overLimit !== true) {
          if (ruleField !== undefined) {
            Object.assign(ruleField, {
              overLimit: true,
              bytes: ruleLimit.bytes,
              mb: ruleLimit.mb,
              message: ruleLimit.message,
              suggestion: ruleLimit.suggestion,
            })
          }
          summary.rules.overLimit += 1
          pushUnique(summary.rules.overLimitIds, session.id)
          pushRuleMessage(summary.rules, ruleLimit.message)
        }
        if (ruleLimit.overLimit && rule?.autoLocal === true) {
          try {
            await setSessionMode(home, [session.id], 'local', { groups: localGroups })
            summary.rules.autoLocal += 1
            pushUnique(summary.rules.autoLocalIds, session.id)
            pushRuleMessage(summary.rules, `${session.id}: ${ruleLimit.message} — переведена в локальные`)
            continue
          } catch (error) {
            addWarning(summary, `не удалось перевести сессию в локальные: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const safe = sanitizeLog(source)
        if (safe.dropped > 0) {
          summary.truncated = (summary.truncated ?? 0) + 1
        }
        const canonical = canonicalize(safe.bytes, projectId)
        const target = mirrorLogPath(config.repoDir, projectId, session.id)
        await mkdir(dirname(target), { recursive: true })
        const existed = existsSync(target)
        if (existed) {
          // Уже лежит то же самое (возможно, сжатое другой сборкой Node) —
          // не перезаписываем, иначе каждый push делает пустой коммит.
          const existing = await readFile(target)
          // Сводка плана для журнала: что было бы сделано с этой сессией.
          planCounts[relationOf(existing, canonical)] += 1
          if (sameLog(existing, canonical)) {
            summary.skipped += 1
            continue
          }
          // Зеркало могло уехать вперёд (другое устройство дописало события):
          // короткий или разошедшийся локальный лог не перезаписывает его.
          const guarded = guardPush(existing, canonical, session.id)
          if (guarded !== undefined) {
            summary.guarded ??= []
            summary.guarded.push(guarded)
            continue
          }
        }
        await writeFile(target, canonical)
        if (!existed) planCounts.onlyLocal += 1
        summary.pushed += 1
        summary.pushedIds ??= new Set()
        summary.pushedIds.add(session.id)
        // Субагент уехал в том же прогоне, что и родитель.
        if (localGroups.parentById.has(session.id)) {
          summary.subagents += 1
          pushedChildren.add(session.id)
        }
        pushRoots.add(rootOf(localGroups.parentById, session.id))
        if (localOrphans.has(session.id)) pushedOrphans.add(session.id)
        // Сессия снова существует — её «надгробие» можно снять, но только если
        // сессия реально новее метки. Присутствие копии само по себе ничего не
        // доказывает: устройство могло просто не успеть применить удаление.
        const mark = tombstones.sessions[session.id]
        if (mark !== undefined && canDropTombstone(mark, await localSessionTimestamp(session))) {
          if (dropTombstone(tombstones, session.id)) tombstonesDirty = true
        }
      } catch (error) {
        // Один нечитаемый лог не должен останавливать остальные сессии.
        summary.failures ??= []
        summary.failures.push({
          id: session.id,
          path: session.path ?? '',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Связи в зеркале после отправки: по ним видны субагенты, которых локально
    // нет. Их нельзя удалять из зеркала и нельзя создавать им надгробия —
    // иначе другое устройство потеряло бы детей живого родителя.
    let mirrorView
    try {
      mirrorView = await mirrorGroups(config.repoDir, projectId)
    } catch {
      mirrorView = { parentById: new Map(), childrenByParent: new Map(), sessions: [] }
    }
    const childrenMissing = missingChildren({ allSessions, mirrorView, current, localIds, tombstones })
    if (childrenMissing.length > 0) {
      summary.childrenMissingCount = (summary.childrenMissingCount ?? 0) + childrenMissing.length
      summary.childrenMissing = [...new Set([...(summary.childrenMissing ?? []), ...childrenMissing])].slice(0, 50)
    }
    summary.sessions += summary.pushed - pushedBefore
    // Счётчики групп: группа — верхний родитель; одиночная сессия тоже группа
    // размера 1, поэтому groups = число разных корней среди отправленного.
    summary.groups += pushRoots.size
    summary.children += pushedChildren.size
    if (pushedOrphans.size > 0) {
      summary.orphans += pushedOrphans.size
      summary.orphanIds = [...new Set([...(summary.orphanIds ?? []), ...pushedOrphans])].slice(0, 100)
    }

    // Сессии, которые есть только в зеркале: в план идут как «только в облаке»
    // (кроме копий сессий в режиме «локальная» — они защищены).
    for (const mirrorSession of mirrorView.sessions) {
      if (current.has(mirrorSession.id)) continue
      if (localIds.has(normalizeSessionId(mirrorSession.id))) continue
      planCounts.onlyCloud += 1
    }

    // push никогда не удаляет из зеркала: удаление — отдельное подтверждённое
    // действие («Применить удаления»). Здесь только считаем, что было бы
    // удалено, и не обновляем состояние проекта, чтобы кандидаты не потерялись
    // до подтверждения.
    if (prune) {
      let deletion
      try {
        deletion = planDeletions({
          home,
          config,
          projectId,
          projectPath: entry.path,
          previous,
          current,
          localIds,
          tombstones,
          mirrorView,
          childrenMissing,
          rules: rulesStore,
        })
      } catch (error) {
        deletion = undefined
        summary.deletionError = error instanceof Error ? error.message : String(error)
      }
      if (deletion !== undefined) {
        // Сессия снова существует — её «надгробие» можно снять, если сессия
        // новее метки (см. H3: присутствие копии слабее метки).
        for (const sessionId of deletion.staleTombstones) {
          const mark = tombstones.sessions[sessionId]
          if (mark === undefined) continue
          const sessionInfo = localById.get(sessionId)
          if (!canDropTombstone(mark, await localSessionTimestamp(sessionInfo))) continue
          if (dropTombstone(tombstones, sessionId)) tombstonesDirty = true
        }
        if (deletion.warning !== undefined) {
          summary.warning = summary.warning === undefined ? deletion.warning : `${summary.warning}; ${deletion.warning}`
        }
        // Защищённые правилом сессии в план удаления не попадают, но в плане
        // остаётся строка «защищена правилом» — иначе исчезновение кандидата
        // выглядело бы ошибкой.
        const protectedRows = deletion.protectedByRule ?? []
        if (protectedRows.length > 0) {
          noteProtectedRules(summary, protectedRows)
          skippedDeletions ??= {
            removed: 0,
            ids: [],
            groups: [],
            subagents: 0,
            projects: [],
            reason: 'удаление ждёт подтверждения — «Применить удаления» в карточке «Проверка»',
          }
          skippedDeletions.protectedByRule = [
            ...(skippedDeletions.protectedByRule ?? []),
            ...protectedRows,
          ].slice(0, 100)
          skippedDeletions.protectedMessage = PROTECTED_RULE_LABEL
        }
        // Локальные сессии в режиме «локальная», у которых в зеркале осталась
        // копия: удаление их не трогает, и это считается отдельно.
        if (deletion.protectedLocalMirror.size > 0) {
          summary.localMirrorProtected += deletion.protectedLocalMirror.size
          summary.localMirrorProtectedIds = [
            ...new Set([...(summary.localMirrorProtectedIds ?? []), ...deletion.protectedLocalMirror]),
          ].slice(0, 100)
        }
        if (deletion.orphansProtected.length > 0) summary.orphansProtected = deletion.orphansProtected
        if (deletion.planned.size > 0) {
          deferState = true
          const groupChildCount = deletion.groups.reduce((total, group) => total + group.children.length, 0)
          planDeletionCount += deletion.planned.size
          knownTotal += deletion.known
          if (deletion.overCount) overCountAny = true
          if (deletion.overRatio) overRatioAny = true
          if (deletion.needsGroupConfirm) needsGroupConfirmAny = true
          skippedDeletions ??= {
            removed: 0,
            ids: [],
            groups: [],
            subagents: 0,
            projects: [],
            reason: 'удаление ждёт подтверждения — «Применить удаления» в карточке «Проверка»',
          }
          skippedDeletions.removed += deletion.planned.size
          skippedDeletions.ids.push(...[...deletion.planned].sort())
          skippedDeletions.groups.push(...deletion.groups)
          skippedDeletions.subagents += groupChildCount
          skippedDeletions.projects.push({ id: projectId, removed: deletion.planned.size })
          // M7: причины и полный список для pendingDeletions.
          for (const sessionId of deletion.planned) {
            pendingDeletionIds.push(sessionId)
            const mark = tombstones.sessions[sessionId]
            pendingDeletionReasons.add(
              isActiveTombstone(mark) && typeof mark.reason === 'string' && mark.reason !== '' ? mark.reason : 'prune',
            )
          }
          const parts = []
          if (deletion.needsGroupConfirm) parts.push(`удаление родителя затронет субагентов: ${groupChildCount}`)
          if (deletion.overCount || deletion.overRatio) {
            parts.push(`удаление ${deletion.planned.size} сессий превышает порог (${PRUNE_MAX_COUNT} сессий или ${Math.round(PRUNE_MAX_RATIO * 100)}% известных)`)
          }
          parts.push('удаление выполняется только по подтверждению')
          const note = parts.join('; ')
          summary.warning = summary.warning === undefined ? note : `${summary.warning}; ${note}`
        }
      }

      // Карантину — 30 дней: записи старше вычищаются при следующем прогоне.
      try {
        const purged = await purgeExpiredQuarantine(config.repoDir, projectId, tombstones)
        if (purged.length > 0) {
          summary.quarantinePurged = purged.length
          summary.quarantinePurgedIds = purged.slice(0, 100)
          tombstonesDirty = true
        }
      } catch {
        // очистка необязательна
      }
    }

    if (!deferState) state.projects[projectId] = [...current]
    meta = mergeDevice(meta, {
      projectId,
      title: entry.title ?? projectId,
      deviceId: config.deviceId,
      path: entry.path,
    })
    // Отметка версии/формата: по ней другая сборка понимает, совместима ли она
    // с зеркалом. Более новый формат не понижаем, более новую версию не
    // затираем — иначе старое приложение «спрятало» бы предупреждение.
    if (mirrorFormat === undefined || mirrorFormat <= LOG_FORMAT) {
      const existingVersion = typeof meta?.dsh?.version === 'string' ? meta.dsh.version : ''
      const keepNewer = existingVersion !== '' && localVersion !== undefined && compareVersions(existingVersion, localVersion) > 0
      meta.dsh = { version: keepNewer ? existingVersion : (localVersion ?? ''), format: LOG_FORMAT }
    }
    summary.projects.push({ id: projectId, path: entry.path, sessions: sessions.length })

    // Человекочитаемое описание зеркала: описание сессий, индекс проекта.
    try {
      await writeCatalog(config.repoDir, new Map([[projectId, sessions.map(s => ({ id: s.id, changed: summary.pushedIds?.has(s.id) === true }))]]), { projectPath: entry.path })
    } catch (error) {
      const catalogError = `описание зеркала не обновлено: ${error instanceof Error ? error.message : String(error)}`
      summary.warning = summary.warning === undefined ? catalogError : `${summary.warning}; ${catalogError}`
    }

    // Отметить отправленное как синхронизированное (кроме тех, что не прочитались).
    const failedIds = new Set((summary.failures ?? []).map(failure => failure.id))
    for (const guarded of summary.guarded ?? []) failedIds.add(guarded.id)
    const ledger = await readLedger(home)
    for (const session of sessions) {
      if (failedIds.has(session.id)) continue
      const path = session.path ?? join(localSessionDir(home, entry.path, session.id), 'session.v4.jsonl.zstd')
      try {
        markSynced(ledger, session.id, await stat(path))
      } catch {
        // файла нет — не отмечаем
      }
    }
    await writeLedger(home, ledger)
  }

  // Сводка плана: сколько сессий в каждой корзине и сколько удалений отложено.
  summary.plan = { counts: planCounts, deletions: planDeletionCount }
  // Правила сессий идут отдельным блоком: панель показывает «защищено правилом»,
  // «только владелец» и «перерос лимит» без разбора текста warning.
  summary.plan.rules = {
    protected: summary.rules.protected,
    ownerBlocked: summary.rules.ownerBlocked,
    overLimit: summary.rules.overLimit,
    localSkipped: summary.rules.localSkipped,
    protectedIds: summary.rules.protectedIds.slice(0, 50),
    ownerBlockedIds: summary.rules.ownerBlockedIds.slice(0, 50),
    overLimitIds: summary.rules.overLimitIds.slice(0, 50),
    localSkippedIds: summary.rules.localSkippedIds.slice(0, 50),
    protectedMessage: PROTECTED_RULE_LABEL,
    ownerMessage: OWNER_RULE_MESSAGE,
    ownerReason: 'rule-owner',
    localSkipReason: 'rule-local',
    limitHint: LIMIT_RULE_HINT,
    skipped: summary.rules.skipped.slice(0, 50),
  }
  if (skippedDeletions !== undefined) {
    const ids = [...new Set(skippedDeletions.ids)]
    summary.skippedDeletions = {
      ...skippedDeletions,
      ids: ids.slice(0, 100),
      groups: skippedDeletions.groups.slice(0, 20),
      maxCount: PRUNE_MAX_COUNT,
      maxRatio: PRUNE_MAX_RATIO,
      known: knownTotal,
      overCount: overCountAny,
      overRatio: overRatioAny,
      needsConfirmation: overCountAny || overRatioAny || needsGroupConfirmAny,
    }
    // Прежнее поле панель использовала для кнопки подтверждения удаления:
    // оставляем его совместимым по форме, но само удаление теперь идёт
    // отдельным маршрутом /api/dsh-sync/prune.
    summary.requireConfirmation = {
      removed: summary.skippedDeletions.removed,
      known: knownTotal,
      maxCount: PRUNE_MAX_COUNT,
      maxRatio: PRUNE_MAX_RATIO,
      ids: ids.slice(0, 50),
      groups: summary.skippedDeletions.groups,
      size: summary.skippedDeletions.removed,
      subagents: summary.skippedDeletions.subagents,
    }
    // M7: единый список «что удалилось бы» — для панели и last-run.
    // Формат существующих полей не меняется, pendingDeletions добавляется рядом.
    const pendingIds = [...new Set(pendingDeletionIds)]
    summary.pendingDeletions = {
      count: pendingIds.length,
      ids: pendingIds.slice(0, 100),
      reasons: [...pendingDeletionReasons].sort(),
    }
    summary.plan.pendingDeletions = summary.pendingDeletions
  }

  await writeMeta(config.repoDir, meta)
  await writeState(home, state)

  if (config.attachments) {
    const attachments = await pushAttachments({ home, repoDir: config.repoDir, retentionDays: config.attachmentsRetentionDays ?? 30 })
    summary.attachments = attachments
  }

  // Профильный слой и привязка рабочих пространств: отдельные файлы зеркала,
  // сбой любого из них не должен отменять отправку сессий.
  const neutralizer = createNeutralizer({ home: homedir(), dshHome: home })
  if (config.profile?.enabled !== false) {
    try {
      summary.profile = await pushProfile({ home, config, repoDir: config.repoDir, neutralizer })
    } catch (error) {
      summary.profileError = error instanceof Error ? error.message : String(error)
    }
  }
  if (config.workspace?.enabled !== false) {
    try {
      summary.workspace = await pushWorkspace({ home, config, repoDir: config.repoDir, neutralizer })
    } catch (error) {
      summary.workspaceError = error instanceof Error ? error.message : String(error)
    }
  }

  // Копия правил сессий в зеркало профиля: второе устройство увидит их при
  // pull. Файл пишется после pushProfile — в манифест профиля он не входит и
  // применяется отдельным слиянием (mergeRulesFromProfile).
  if (config.profile?.enabled !== false && rulesStore.updatedAt !== '') {
    try {
      await writeRulesProfile({ repoDir: config.repoDir, rules: rulesStore })
      summary.rulesProfile = { synced: true, counts: rulesCounts(rulesStore) }
    } catch (error) {
      summary.rulesProfile = { synced: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (ruleConflicts.length > 0) {
    summary.ruleConflicts = ruleConflicts.slice(0, 50)
    if (config.profile?.enabled !== false) {
      try {
        const entries = ruleConflicts.map(conflict => ({
          file: RULES_PROFILE_RELATIVE,
          reason: `правило сессии: ${conflict.kind ?? 'session-rule'} ${conflict.id ?? ''} — свежее побеждает`,
          kind: 'session-rules',
          id: conflict.id,
          winner: conflict.winner,
        }))
        summary.ruleConflictsJournal = await appendJournal(config.repoDir, entries, config.deviceId)
      } catch {
        // журнал профиля необязателен: конфликты уже записаны локально
      }
    }
  }

  if ((summary.truncated ?? 0) > 0) {
    const truncateWarning = `недописанные хвосты обрезаны: ${summary.truncated}`
    summary.warning = summary.warning === undefined ? truncateWarning : `${summary.warning}; ${truncateWarning}`
  }

  if ((summary.guarded ?? []).length > 0) {
    const guardWarning = `зеркало не перезаписано: ${summary.guarded.length} (${summary.guarded[0].id}: ${summary.guarded[0].message})`
    summary.warning = summary.warning === undefined ? guardWarning : `${summary.warning}; ${guardWarning}`
  }

  if (tombstonesDirty) await writeTombstones(config.repoDir, tombstones)

  const result = await remote.commit(message ?? `dsh-sync: push from ${config.deviceId} (${new Date().toISOString()})`)
  summary.committed = result.committed
  summary.pushedToRemote = result.pushed
  // Журнал причин: дети в составе групп и сироты, уехавшие без родителя.
  summary.reasonCounts = {
    children: summary.children ?? 0,
    orphan: summary.orphans ?? 0,
  }
  return summary
}

/**
 * Перенести подтверждённые сессии из зеркала в карантин.
 *
 * Удаление — ручное действие владельца: у каждой метки reason=manual (или
 * children для субагента, ушедшего вместе с родителем) и by=owner. Название и
 * объём берутся до переноса, чтобы панель «Удалённые» показывала их без
 * чтения логов. Если rename не удался, сессия удаляется как раньше, но это
 * видно по счётчикам.
 *
 * @returns {Promise<boolean>} были ли изменения в надгробиях.
 */
async function quarantinePlanned({ config, projectId, planned, groupChildren, missing, tombstones, summary }) {
  const reasons = new Set()
  const removedDetails = []
  // Подтверждение владельца: reason=manual/by=owner, размер пачки — size.
  const manualBatch = true
  for (const sessionId of planned) {
    const dir = join(config.repoDir, 'sessions', projectId, encodeSegment(sessionId))
    if (!existsSync(dir)) continue
    const groupParent = groupChildren.get(sessionId)
    const isGroupChild = groupParent !== undefined && planned.has(groupParent)
    const humanReason = isGroupChild
      ? 'удалено вместе с родителем'
      : missing.includes(sessionId) ? 'удалено локально' : 'отметка другого устройства'
    reasons.add(humanReason)
    const existing = tombstones.sessions[sessionId]
    const fromTombstone = existing !== undefined
    // Пометку, уже записанную устройством (например, удаление из панели с
    // reason=manual/by=owner), не перезаписываем — сохраняем причину.
    let reasonCode
    let byCode
    if (fromTombstone) {
      reasonCode = existing.reason ?? 'manual'
      byCode = existing.by ?? 'owner'
    } else if (isGroupChild) {
      reasonCode = CHILDREN_REASON
      byCode = 'owner'
    } else {
      reasonCode = 'manual'
      byCode = 'owner'
    }
    const meta = { reason: reasonCode, by: byCode }
    if (isGroupChild) meta.parent = groupParent
    if (!fromTombstone) meta.size = planned.size
    if (isGroupChild && meta.size === undefined) meta.size = planned.size
    // Название и объём берём до переноса: панель «Удалённые» показывает
    // название, а не только идентификатор.
    try {
      const sidecar = JSON.parse(await readFile(join(dir, SESSION_SIDECAR_FILE), 'utf8'))
      if (typeof sidecar?.title === 'string' && sidecar.title.trim() !== '') meta.title = sidecar.title.trim()
    } catch {
      // описания может не быть — покажем идентификатор
    }
    try {
      meta.bytes = (await stat(join(dir, LOG_NAME))).size
    } catch {
      // размер необязателен
    }
    // Карантин вместо удаления: 30 дней в sessions/<проект>/_deleted/<id>/.
    const target = quarantinePath(config.repoDir, projectId, sessionId)
    const replaced = existsSync(target)
    await mkdir(dirname(target), { recursive: true })
    let quarantined = false
    try {
      await rename(dir, target)
      quarantined = true
    } catch {
      // В карантине могла остаться старая копия этого же id: заменяем её.
      try {
        await rm(target, { recursive: true, force: true })
        await rename(dir, target)
        quarantined = true
      } catch {
        quarantined = false
      }
    }
    if (quarantined) {
      const deletedAt = {
        at: new Date().toISOString(),
        reason: meta.reason,
        reasonLabel: humanReason,
        by: meta.by,
        device: config.deviceId,
      }
      if (meta.title !== undefined) deletedAt.title = meta.title
      if (meta.size !== undefined) deletedAt.size = meta.size
      if (meta.parent !== undefined) deletedAt.parent = meta.parent
      await writeFile(join(target, DELETED_AT_FILE), `${JSON.stringify(deletedAt)}\n`, 'utf8')
    } else {
      // Перенести не вышло — удаляем как раньше, но фиксируем это.
      await rm(dir, { recursive: true, force: true })
    }
    if (fromTombstone) {
      // Дополняем исходную метку недостающими сведениями для панели.
      if (existing.title === undefined && meta.title !== undefined) existing.title = meta.title
      if (existing.bytes === undefined && meta.bytes !== undefined) existing.bytes = meta.bytes
      if (existing.size === undefined && isGroupChild) existing.size = planned.size
      if (replaced) existing.replaced = true
    } else {
      if (replaced) meta.replaced = true
      addTombstone(tombstones, sessionId, config.deviceId, meta)
    }
    summary.removed += 1
    summary.removedIds ??= []
    summary.removedIds.push(sessionId)
    removedDetails.push({ id: sessionId, reason: reasonCode, by: byCode })
    if (isGroupChild) {
      summary.childrenQuarantined = (summary.childrenQuarantined ?? 0) + 1
      summary.childrenQuarantinedIds ??= []
      summary.childrenQuarantinedIds.push(sessionId)
      summary.childrenQuarantinedIds = summary.childrenQuarantinedIds.slice(0, 100)
    }
    if (replaced) {
      summary.replaced = (summary.replaced ?? 0) + 1
      summary.replacedIds ??= []
      summary.replacedIds.push(sessionId)
    }
  }
  if (reasons.size > 0) summary.removedReason = [...reasons].join(', ')
  if (removedDetails.length > 0) {
    summary.removedDetails = removedDetails
    summary.removedReasons = [...new Set(removedDetails.map(item => item.reason))]
    summary.removedBy = [...new Set(removedDetails.map(item => item.by))]
  }
  return removedDetails.length > 0
}

/**
 * «Применить удаления»: перенести в карантин сессии, которые план показал как
 * удалённые. Это единственный путь удаления из зеркала — push ничего не удаляет.
 *
 * Требуется явное подтверждение (`confirm: true`). Старые защиты prune
 * сохраняются: защищённые субагенты живых родителей, осиротевшие копии и
 * локальные сессии не удаляются, пороги массового удаления попадают в отчёт
 * (`overCount`/`overRatio`), а метки получают reason=manual/by=owner.
 *
 * @param home каталог DSH
 * @param config настройки синхронизации
 * @param project фильтр проекта (id) или undefined — все
 * @param confirm должно быть true, иначе возвращается код подтверждения
 * @param ids необязательный список id из плана: удалить только их
 */
export async function applyDeletions({ home, config, project, confirm = false, ids, message, dshVersion }) {
  if (confirm !== true) {
    return {
      ok: false,
      code: 'confirm-required',
      action: 'prune',
      message: 'удаление из зеркала выполняется только с подтверждением (confirm:true)',
    }
  }
  if (config.backend === 'git' && (config.remote ?? '').length === 0) {
    throw new Error('не задан адрес репозитория — укажите его в настройках плагина или нажмите «Создать репозиторий»')
  }
  // Свежие ручные пометки — до синхронизации дерева зеркала (см. push).
  const pendingManual = pendingManualTombstones(await readTombstones(config.repoDir))
  const remote = await createRemote(config)
  await remote.sync()
  const local = await listLocalSessions(home)
  const modes = (await applyWorkspaceDefaults(home)).modes
  const state = await readSyncState(home)
  const tombstones = await readTombstones(config.repoDir)
  let tombstonesDirty = false
  if (mergePendingManualTombstones(tombstones, pendingManual) > 0) tombstonesDirty = true
  // Правила сессий: `protect` не даёт удалить сессию из зеркала. Копию из
  // профиля зеркала вливаем до плана — иначе prune на этом устройстве не знал
  // бы о защите, заданной на другом. Ошибка правил не блокирует удаление.
  let rulesStore = await readSessionRules(home)
  if (config.profile?.enabled !== false) {
    try {
      rulesStore = (await mergeRulesFromProfile({ home, repoDir: config.repoDir })).rules
    } catch {
      // работаем с локальными правилами
    }
  }
  const deletionsSettings = deletionsConfig(config)
  const summary = {
    ok: true,
    action: 'prune',
    confirmed: true,
    mode: 'manual',
    projects: [],
    removed: 0,
    removedIds: [],
    removedDetails: [],
    reasons: [],
    by: [],
    groups: 0,
    // Групповые счётчики удаления: сколько групп убрано, сколько в них детей и
    // сколько осиротевших копий защищено от удаления.
    groupsDeleted: 0,
    children: 0,
    orphans: 0,
    // Защита правилом: сессии не удалены, в отчёте строка «защищена правилом».
    protected: 0,
    protectedIds: [],
    protectedByRule: [],
    protectedMessage: PROTECTED_RULE_LABEL,
    // M7: подтверждённое удаление обходит массовый предохранитель, но не
    // «воскрешение»/restored и не локальные режимы. Эти поля показывают, что
    // именно было удержано и какой предохранитель пришлось обойти.
    blocked: false,
    blockedProjects: [],
    revivedIds: [],
    revivedDetails: [],
    restoredSkipped: 0,
    restoredSkippedIds: [],
    // Локальные копии, подтверждённо убранные в архив этим действием (то, что
    // остановил бы предохранитель автоудаления, если бы не подтверждение).
    localRemoved: 0,
    localRemovedIds: [],
    localRemovedDetails: [],
    localChildrenRemoved: 0,
    guard: {
      bypassed: true,
      autoApply: deletionsSettings.autoApply,
      maxAutoRemove: deletionsSettings.maxAutoRemove,
      maxTombstoneAgeDays: deletionsSettings.maxTombstoneAgeDays,
      wouldBlock: undefined,
    },
  }
  const requested = Array.isArray(ids)
    ? new Set(ids.filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))
    : undefined

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const allSessions = sessionsOfProject(local, entry.path)
    const localGroups = groupsOf(allSessions)
    const modeView = resolveGroupModes(modes, allSessions, localGroups)
    const sessions = allSessions.filter(session => !modeView.localIds.has(normalizeSessionId(session.id)))
    const current = new Set(sessions.map(session => session.id))
    const localIds = new Set([...modeView.localIds].map(normalizeSessionId))
    const previous = new Set(state.projects[projectId] ?? [])
    let mirrorView
    try {
      mirrorView = await mirrorGroups(config.repoDir, projectId)
    } catch {
      mirrorView = { parentById: new Map(), childrenByParent: new Map(), sessions: [] }
    }
    const childrenMissing = missingChildren({ allSessions, mirrorView, current, localIds, tombstones })
    // Связи группы и запрошенные id: команда удаления присылает id родителя,
    // а метки и карантин нужны всей группе — потомки входят в запрос.
    const mergedParentById = new Map([...(mirrorView.parentById ?? []), ...(localGroups.parentById ?? [])])
    const expandedRequest = requested === undefined || requested.size === 0
      ? undefined
      : expandDeletionIds({ childrenByParent: mergeChildren(mirrorView, localGroups), ids: [...requested] })
    // M7: подтверждённое «Применить удаления» сначала дожимает локальные копии —
    // именно их останавливал предохранитель в pull. Массовый предохранитель
    // обойдён подтверждением, но «воскрешение», restored и локальные режимы
    // остаются защищёнными (bypassGuard не отключает их проверки).
    const localApplied = await applyLocalTombstones({
      home,
      config,
      projectPath: entry.path,
      groups: localGroups,
      localModes: modeView,
      tombstones,
      bypassGuard: true,
      ownMarksOnly: true,
      onlyIds: expandedRequest === undefined ? undefined : new Set(expandedRequest.ids),
    })
    if (localApplied.tombstonesChanged) tombstonesDirty = true
    if (localApplied.deleted > 0) {
      // Локальной копии больше нет — план зеркала увидит её как удалённую.
      for (const sessionId of localApplied.deletedIds) current.delete(sessionId)
      summary.localRemoved += localApplied.deleted
      summary.localRemovedIds = [...summary.localRemovedIds, ...localApplied.deletedIds].slice(0, 100)
      summary.localRemovedDetails = [...summary.localRemovedDetails, ...localApplied.deletedDetails].slice(0, 100)
      summary.localChildrenRemoved += localApplied.childrenDeleted
    }
    if (localApplied.revivedIds.length > 0) {
      summary.revivedIds = [...new Set([...summary.revivedIds, ...localApplied.revivedIds])].slice(0, 100)
      summary.revivedDetails = [...summary.revivedDetails, ...localApplied.revivedDetails].slice(0, 100)
    }
    if (childrenMissing.length > 0) {
      summary.childrenMissing = [...new Set([...(summary.childrenMissing ?? []), ...childrenMissing])].slice(0, 50)
      summary.childrenMissingCount = (summary.childrenMissingCount ?? 0) + childrenMissing.length
    }
    // Локальные сессии по id — для сверки времени сессии с меткой удаления.
    const localById = new Map(allSessions.map(session => [session.id, session]))
    const stats = { id: projectId, path: entry.path, removed: 0, removedIds: [] }
    let deletion
    try {
      deletion = planDeletions({
        home,
        config,
        projectId,
        projectPath: entry.path,
        previous,
        current,
        localIds,
        tombstones,
        mirrorView,
        childrenMissing,
        rules: rulesStore,
      })
    } catch (error) {
      deletion = undefined
      stats.error = error instanceof Error ? error.message : String(error)
    }
    const removedBefore = summary.removed
    if (deletion !== undefined) {
      // Сессия снова существует — её «надгробие» можно снять, если сессия
      // новее метки (присутствие копии само по себе слабее метки).
      for (const sessionId of deletion.staleTombstones) {
        const mark = tombstones.sessions[sessionId]
        if (mark === undefined) continue
        if (!canDropTombstone(mark, await localSessionTimestamp(localById.get(sessionId)))) continue
        if (dropTombstone(tombstones, sessionId)) tombstonesDirty = true
      }
      // Защищённые правилом сессии не удаляются: строка «защищена правилом» в
      // отчёте, иначе кандидат просто исчез бы из плана без объяснения.
      const protectedRows = deletion.protectedByRule ?? []
      if (protectedRows.length > 0) {
        summary.protected += protectedRows.length
        for (const row of protectedRows) pushUnique(summary.protectedIds, row.id)
        summary.protectedByRule = [...summary.protectedByRule, ...protectedRows].slice(0, 100)
        stats.protected = protectedRows.length
        addWarning(summary, `защищено правилом: ${protectedRows.length}`)
      }
      if (deletion.warning !== undefined) {
        summary.warning = summary.warning === undefined ? deletion.warning : `${summary.warning}; ${deletion.warning}`
      }
      // M7: план заблокирован (каталог сессий недоступен) — поле в отчёте.
      if (deletion.blocked === true) {
        summary.blocked = true
        summary.blockedProjects.push({ id: projectId, reason: 'catalog-unavailable', warning: deletion.warning })
      }
      if (deletion.protectedLocalMirror.size > 0) {
        summary.localMirrorProtected = (summary.localMirrorProtected ?? 0) + deletion.protectedLocalMirror.size
      }
      if (deletion.orphansProtected.length > 0) {
        summary.orphansProtected = deletion.orphansProtected
        // Осиротевшие копии в зеркале защищены от удаления — причина в журнале.
        summary.orphans = (summary.orphans ?? 0) + deletion.orphansProtected.length
        summary.orphanIds = [
          ...new Set([...(summary.orphanIds ?? []), ...deletion.orphansProtected]),
        ].slice(0, 100)
      }
      // Для отчёта: насколько пачка большая относительно порогов и известных.
      summary.known = (summary.known ?? 0) + deletion.known
      if (deletion.overCount) summary.overCount = true
      if (deletion.overRatio) summary.overRatio = true
      summary.groups += deletion.groups.length
      summary.subagents = (summary.subagents ?? 0)
        + deletion.groups.reduce((total, group) => total + group.children.length, 0)
      let planned = deletion.planned
      if (expandedRequest !== undefined) {
        // Запрос расширен до группы: удаление родителя уносит и субагентов,
        // иначе на другом устройстве остались бы сироты.
        const requestedIds = new Set(expandedRequest.ids)
        planned = new Set([...planned].filter(sessionId => requestedIds.has(sessionId)))
        if (expandedRequest.groups.length > 0) {
          summary.requestedGroups = expandedRequest.groups.slice(0, 20)
        }
      }
      // M7: какое автоудаление остановил бы предохранитель. Подтверждённое
      // действие его обходит, но факт остаётся в отчёте — панель объясняет,
      // почему удалять пришлось вручную.
      const guardMarks = activeDeletionMarks(tombstones)
      const guardRoots = new Map([...planned].map(sessionId => [sessionId, deletionRootOf(guardMarks, sessionId)]))
      const wouldBlock = deletionGuardViolation({
        candidates: [...planned],
        rootBySession: guardRoots,
        marks: guardMarks,
        settings: deletionsConfig(config),
      })
      if (wouldBlock !== undefined) {
        summary.guard.wouldBlock = { reason: wouldBlock.reason, count: wouldBlock.count, details: wouldBlock.details }
      }
      // Подтверждение не обходит «воскрешение» и снятые метки: сессию с логом
      // новее удаления (и метку restored) не трогаем даже по явному запросу.
      for (const sessionId of [...planned]) {
        const mark = tombstones.sessions[sessionId]
        if (mark !== undefined && !isActiveTombstone(mark)) {
          planned.delete(sessionId)
          summary.restoredSkipped += 1
          pushUnique(summary.restoredSkippedIds, sessionId)
          continue
        }
        const localSession = current.has(sessionId) ? localById.get(sessionId) : undefined
        if (localSession === undefined) continue
        const sessionTime = await localSessionTimestamp(localSession)
        if (!logNewerThanTombstone(mark, sessionTime)) continue
        planned.delete(sessionId)
        pushUnique(summary.revivedIds, sessionId)
        summary.revivedDetails.push({
          id: sessionId,
          reason: 'newer-log',
          markAt: typeof mark?.at === 'string' ? mark.at : '',
          logMtime: new Date(sessionTime).toISOString(),
        })
        // Метку снимаем: иначе следующий pull снова попытался бы удалить сессию.
        if (mark !== undefined && isActiveTombstone(mark)) {
          markRestored(tombstones, sessionId, { by: 'sync', at: Date.now(), device: config.deviceId })
          tombstonesDirty = true
        }
      }
      summary.revivedDetails = summary.revivedDetails.slice(0, 100)
      if (planned.size > 0) {
        // Предупреждение для панели: у удаляемого родителя есть дети.
        const parentWithChildren = []
        for (const sessionId of deletion.missing) {
          for (const childId of mirrorView.childrenByParent.get(sessionId) ?? []) {
            if (!parentWithChildren.includes(childId)) parentWithChildren.push(childId)
          }
        }
        const removedChildren = [...deletion.groupChildren.keys()].filter(childId => planned.has(childId))
        if (parentWithChildren.length > 0 || removedChildren.length > 0) {
          summary.parentWithChildren = [...new Set([...parentWithChildren, ...removedChildren])].slice(0, 50)
          const suffix = removedChildren.length > 0
            ? ` (уходят вместе, в карантин: ${removedChildren.length})`
            : ' (их копии остаются в зеркале)'
          summary.warning = `удаляется родитель с субагентами: ${summary.parentWithChildren.length}${suffix}`
        }
        const before = summary.removed
        if (await quarantinePlanned({
          config,
          projectId,
          planned,
          groupChildren: deletion.groupChildren,
          missing: deletion.missing,
          tombstones,
          summary,
        })) {
          tombstonesDirty = true
        }
        stats.removed = summary.removed - before
      }
    }
    // Удалённые сессии больше не считаются отправленными этим устройством,
    // остальные кандидаты остаются в состоянии — иначе следующий план их
    // потеряет и удаление не доедет до подтверждения.
    const projectRemovedIds = (summary.removedIds ?? []).slice(removedBefore)
    const nextState = new Set(previous)
    for (const sessionId of projectRemovedIds) nextState.delete(sessionId)
    state.projects[projectId] = [...nextState]
    stats.removedIds = projectRemovedIds
    summary.projects.push(stats)
    // Групповые счётчики: сколько разных групп ушло в карантин и сколько в них
    // было субагентов. Причина `children` остаётся в removedDetails.
    if (projectRemovedIds.length > 0) {
      summary.groupsDeleted += new Set(projectRemovedIds.map(sessionId => rootOf(mergedParentById, sessionId))).size
      summary.children += projectRemovedIds.filter(sessionId => mergedParentById.has(sessionId)).length
    }

    // Карантину — 30 дней: записи старше вычищаются при следующем прогоне.
    try {
      const purged = await purgeExpiredQuarantine(config.repoDir, projectId, tombstones)
      if (purged.length > 0) {
        summary.quarantinePurged = (summary.quarantinePurged ?? 0) + purged.length
        summary.quarantinePurgedIds = [...(summary.quarantinePurgedIds ?? []), ...purged].slice(0, 100)
        tombstonesDirty = true
      }
    } catch {
      // очистка необязательна
    }
  }

  await writeState(home, state)
  if (tombstonesDirty) await writeTombstones(config.repoDir, tombstones)
  const localDetails = summary.localRemovedDetails ?? []
  summary.reasons = [...new Set([
    ...summary.removedDetails.map(item => item.reason),
    ...localDetails.map(item => item.reason),
    ...(summary.orphans > 0 ? [ORPHAN_REASON] : []),
  ])]
  summary.by = [...new Set([
    ...summary.removedDetails.map(item => item.by),
    ...localDetails.map(item => item.by),
  ].filter(Boolean))]
  // Журнал причин: сколько детей ушло вместе с родителем и сколько сирот
  // защищено. Коды те же, что в removedDetails, — панель не разбирает текст.
  summary.reasonCounts = {
    children: summary.children ?? 0,
    orphan: summary.orphans ?? 0,
  }
  if (summary.removed === 0) {
    if ((summary.localRemoved ?? 0) > 0) {
      summary.message = `в локальный архив убрано сессий: ${summary.localRemoved}`
      return summary
    }
    summary.message = 'удалять нечего: кандидатов нет или они защищены'
    return summary
  }
  const result = await remote.commit(message ?? `dsh-sync: prune ${summary.removed} session(s) by owner (${config.deviceId})`)
  summary.committed = result.committed
  summary.pushedToRemote = result.pushed
  summary.message = `в карантин отправлено сессий: ${summary.removed}`
    + ((summary.localRemoved ?? 0) > 0 ? `; локально убрано: ${summary.localRemoved}` : '')
  return summary
}

export async function pull({ home, config, project, dryRun = false, dshVersion }) {
  // Свежие ручные пометки — до синхронизации дерева зеркала (см. push).
  const pendingManual = pendingManualTombstones(await readTombstones(config.repoDir))
  const remote = await createRemote(config)
  const fetched = await remote.sync()
  if (fetched === false && config.remote) {
    // Пустой репозиторий (ещё нет ветки) — это не ошибка: принимать нечего.
    const probe = await git(config.repoDir, ['ls-remote', '--heads', config.remote], { allowFailure: true })
    if (probe.code !== 0 || probe.stdout.trim() !== '') {
      throw new Error('не удалось получить удалённую ветку (проверьте remote и доступ)')
    }
  }

  const local = await listLocalSessions(home)
  // Умолчания рабочих пространств материализуются до решения «принимать или
  // пропустить»: иначе сессия из «локального» пространства приехала бы сюда.
  const modes = (await applyWorkspaceDefaults(home)).modes
  const summary = {
    projects: [],
    imported: 0,
    updated: 0,
    conflicts: 0,
    unchanged: 0,
    ahead: 0,
    locked: 0,
    unknownProjects: [],
    localSkipped: 0,
    // Журнал: сколько сессий и субагентов принято и каких детей не хватает.
    sessions: 0,
    subagents: 0,
    childrenMissing: [],
    // Групповые счётчики приёма: сколько групп приехало, сколько в них детей,
    // сколько групп убрано по меткам и сколько детей осталось без родителя.
    groups: 0,
    children: 0,
    groupsDeleted: 0,
    childrenDeleted: 0,
    orphans: 0,
    childrenQuarantined: 0,
    // M7: «воскрешение» (лог новее метки) и остановленное автоудаление.
    revivedIds: [],
    revivedDetails: [],
    deletionsBlocked: undefined,
    pendingDeletions: undefined,
    // Правила сессий: что приём не стал применять молча (ownerDevice,
    // forbidFork), что объявлено локальным и что переросло лимит maxMb.
    ruleFields: [],
    rules: emptyRuleSummary(),
  }
  const meta = await readMeta(config.repoDir)
  const ledger = await readLedger(home)
  const state = await readState(home)
  const tombstones = await readTombstones(config.repoDir)
  let tombstonesDirty = false
  // Вернуть в файл ручные пометки, которые fetch+reset мог затёрть: иначе
  // следующая отправка записала бы удаление как автоматическое (prune/sync).
  const mergedManual = mergePendingManualTombstones(tombstones, pendingManual)
  if (mergedManual > 0 && !dryRun) {
    try {
      await writeTombstones(config.repoDir, tombstones)
    } catch {
      // запись — страховка для следующей отправки, приём продолжается
    }
  }
  summary.mirrorProjects = Object.entries(meta.projects ?? {}).map(([id, info]) => ({ id, title: info?.title ?? id }))

  // Сверка версий: зеркало в более новом формате логов старому приложению
  // отдавать нельзя — такие логи оно не прочитает (или прочитает неверно).
  // Формат берём из фактических метаданных: dsh.format или projects.version.
  const localVersion = dshVersion ?? await detectDshVersion()
  const mirrorFormat = readMirrorFormat(meta)
  if (mirrorFormat !== undefined && mirrorFormat > LOG_FORMAT) {
    summary.ok = false
    summary.errorKind = 'format'
    summary.format = mirrorFormat
    summary.supportedFormat = LOG_FORMAT
    summary.message = `зеркало использует более новый формат логов (v${mirrorFormat}, поддерживается v${LOG_FORMAT}) — приём пропущен, обновите DSH`
    summary.warning = summary.message
    return summary
  }
  const mirrorVersion = typeof meta?.dsh?.version === 'string' ? meta.dsh.version : ''
  if (mirrorVersion !== '' && localVersion !== undefined && compareVersions(mirrorVersion, localVersion) > 0) {
    summary.warning = `зеркало синхронизировалось более новой версией DSH (${mirrorVersion}, у вас ${localVersion}) — обновите DSH, чтобы не пропустить изменения`
  }

  // Правила сессий (задача 22): приём решает по ним, что нельзя перезаписывать
  // молча (ownerDevice, forbidFork), что объявлено локальным (syncMode) и что
  // переросло maxMb. Копию из зеркала профиля вливаем до решений: правило,
  // заданное на другом устройстве, должно действовать и здесь. На dry-run
  // ничего не пишем — только читаем и сливаем в памяти.
  let rulesStore = await readSessionRules(home)
  let ruleConflicts = []
  if (config.profile?.enabled !== false) {
    if (dryRun) {
      try {
        const incoming = await readRulesProfile({ repoDir: config.repoDir })
        if (incoming !== undefined) {
          const merged = mergeSessionRules(rulesStore, incoming)
          rulesStore = merged.rules
          ruleConflicts = merged.conflicts
        }
      } catch {
        // правила необязательны: приём продолжается с локальными
      }
    } else {
      try {
        const merged = await mergeRulesFromProfile({ home, repoDir: config.repoDir })
        rulesStore = merged.rules
        ruleConflicts = merged.conflicts ?? []
      } catch {
        // работаем с локальными правилами
      }
    }
  }

  const configured = new Set(Object.keys(config.projects))
  const mirrorRoot = join(config.repoDir, 'sessions')
  const projectDirs = existsSync(mirrorRoot) ? await readdir(mirrorRoot, { withFileTypes: true }) : []
  for (const entry of projectDirs) {
    if (entry.isDirectory() && !configured.has(entry.name)) summary.unknownProjects.push(entry.name)
  }
  // Копии удалённых сессий, снова появившиеся в зеркале: их вернём в карантин
  // после приёма (иначе «удаление везде» не доедет до других устройств).
  const resurrected = new Set()
  // Метки, ставшие restored из-за «воскрешения»: пишем их после fetch+reset,
  // иначе сброс дерева зеркала стёр бы защиту от повторного автоудаления.
  const restoredMarks = new Map()
  // Что остановил предохранитель: эти id не отправляем на автоматическое
  // «повторно применить метки» — иначе guard обходился бы внутри того же pull.
  const blockedDeletionIds = new Set()

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const remoteSessions = await listMirrorSessions(config.repoDir, projectId)
    // Группы «родитель + субагенты»: приём идёт от родителей к детям, а
    // локальные режимы наследуются группой.
    const remoteGroups = groupsOf(remoteSessions)
    const orderedSessions = orderParentsFirst(remoteSessions, remoteGroups)
    const remoteModes = resolveGroupModes(modes, remoteSessions, remoteGroups)
    // Правила приёма: наследование идёт по связям зеркала, чтобы ребёнок без
    // своего правила вёл себя как родитель (в т.ч. ownerDevice и syncMode).
    const resolvedRules = resolveRulesForSessions({
      rules: rulesStore,
      sessions: remoteSessions,
      groups: remoteGroups,
      workspaceId: projectId,
      deviceId: config.deviceId,
    })
    const stats = {
      id: projectId,
      path: entry.path,
      imported: 0,
      updated: 0,
      conflicts: 0,
      unchanged: 0,
      ahead: 0,
      locked: 0,
      subagents: 0,
      childrenMissing: [],
      groups: 0,
      children: 0,
      orphans: 0,
      childrenQuarantined: 0,
      childrenQuarantinedIds: [],
    }

    // Сессии, которые это устройство раньше отправляло, но локально их уже нет:
    // их удалили, а отправка ещё не прошла. Импортировать обратно нельзя —
    // иначе удаление никогда не доедет, а сессия «воскреснет».
    const tracked = new Set(state.projects?.[projectId] ?? [])
    const projectLocal = sessionsOfProject(local, entry.path)
    const localIds = new Set(projectLocal.map(session => session.id))
    const localGroups = groupsOf(projectLocal)
    const localModes = resolveGroupModes(modes, projectLocal, localGroups)
    // Родители, которые уже приехали (или уже лежат локально): их субагентов
    // нельзя терять из-за ожидания удаления.
    const arrived = new Set()
    const remoteIds = new Set(remoteSessions.map(session => session.id))
    const isRemoteLocal = sessionId => remoteModes.localIds.has(normalizeSessionId(sessionId))
    // Свои метки и каскад по группе: ребёнок удалённого родителя не
    // импортируется — он уходит в карантин вместе с родителем (reason children).
    const deletionMarks = activeDeletionMarks(tombstones, isRemoteLocal)
    const inheritedDeletion = groupDeletionCascade(remoteGroups.childrenByParent, deletionMarks, isRemoteLocal)
    const importedRoots = new Set()
    const quarantineRoots = new Set()
    // «Воскрешение»: копия удалённой сессии снова лежит в зеркале — её вернут
    // в карантин отдельным подтверждённым проходом после приёма.
    const mirrorIds = remoteIds

    for (const remoteSession of orderedSessions) {
      try {
      // Локальная сессия и дети локального родителя не принимаются из зеркала:
      // режим «локальная» — обещание, что данные живут только здесь.
      if (remoteModes.localIds.has(normalizeSessionId(remoteSession.id))) {
        stats.localSkipped = (stats.localSkipped ?? 0) + 1
        continue
      }
      // archive-пресет объявляет сессию локальной правилом: копия в зеркале на
      // этом устройстве не применяется (данные должны жить только здесь).
      const rule = resolvedRules.get(normalizeRuleId(remoteSession.id))
      if (rule?.syncMode === 'local') {
        stats.ruleLocalSkipped = (stats.ruleLocalSkipped ?? 0) + 1
        summary.rules.localSkipped += 1
        pushUnique(summary.rules.localSkippedIds, remoteSession.id)
        continue
      }
      const parentId = remoteGroups.parentById.get(remoteSession.id) ?? ''
      const parentInSource = parentId !== '' && mirrorIds.has(parentId)
      const parentHere = parentId !== '' && (arrived.has(parentId) || localIds.has(parentId))
      // Унаследованная метка родителя: импорт не нужен, ребёнок удалён группой.
      const inheritedOwner = inheritedDeletion.get(remoteSession.id)
      if (inheritedOwner !== undefined) {
        stats.childrenQuarantined = (stats.childrenQuarantined ?? 0) + 1
        if (stats.childrenQuarantinedIds.length < 100) stats.childrenQuarantinedIds.push(remoteSession.id)
        quarantineRoots.add(rootOf(remoteGroups.parentById, inheritedOwner))
        summary.pendingDeletion = (summary.pendingDeletion ?? 0) + 1
        continue
      }
      if (tracked.has(remoteSession.id) && !localIds.has(remoteSession.id)) {
        // Исключение — субагент, чей родитель приехал или уже лежит локально:
        // иначе ребёнок «потерялся» бы, хотя родитель жив.
        if (!parentHere) {
          stats.pendingDeletion = (stats.pendingDeletion ?? 0) + 1
          continue
        }
      }
      // Метка удаления сильнее присутствия копии: принимать сессию можно,
      // только если она реально новее метки. `made-local` не воскресает никогда:
      // сессия обещана этому устройству и из зеркала обратно не приезжает.
      const mark = tombstones.sessions[remoteSession.id]
      if (mark !== undefined && isActiveTombstone(mark)) {
        const remoteCreatedAt = headerOf(remoteSession.bytes)?.createdAt
        if (!canDropTombstone(mark, sessionTimestamp({ createdAt: remoteCreatedAt }))) {
          stats.pendingDeletion = (stats.pendingDeletion ?? 0) + 1
          // Метка субагента (children + parent): это удаление группы, а не
          // одиночная удержанная копия.
          if (typeof mark.parent === 'string' && mark.parent !== '') {
            stats.childrenQuarantined = (stats.childrenQuarantined ?? 0) + 1
            if (stats.childrenQuarantinedIds.length < 100) stats.childrenQuarantinedIds.push(remoteSession.id)
            quarantineRoots.add(rootOf(remoteGroups.parentById, mark.parent))
          }
          continue
        }
        // Сессия новее метки — удаление устарело, пометку снимаем.
        if (!dryRun && dropTombstone(tombstones, remoteSession.id)) tombstonesDirty = true
      }
      // Ребёнка не импортируем без родителя: порядок «сначала родитель, затем
      // дети» обязателен. Родителя нет в источнике — это сирота: импортируем и
      // помечаем orphan, чтобы её не удалили как потерянную.
      const orphan = parentId !== '' && !parentInSource && !parentHere
      if (parentId !== '' && !parentHere && parentInSource) {
        // Родитель есть в зеркале, но пока не приехал (занят/ошибка/ждёт
        // удаления): не создаём локальную сироту, повторим в следующий приём.
        stats.waitingParent = (stats.waitingParent ?? 0) + 1
        stats.waitingParentIds ??= []
        if (stats.waitingParentIds.length < 100) stats.waitingParentIds.push(remoteSession.id)
        continue
      }
      const localDir = localSessionDir(home, entry.path, remoteSession.id)
      const localPath = join(localDir, 'session.v4.jsonl.zstd')
      const localBytes = existsSync(localPath) ? await readFile(localPath) : undefined

      if (isLocked(localDir)) {
        stats.locked += 1
        continue
      }

      const write = async (bytes) => {
        if (dryRun) return
        await mkdir(localDir, { recursive: true })
        await writeFile(localPath, bytes)
        await dropCache(home, remoteSession.id)
        try {
          markSynced(ledger, remoteSession.id, await stat(localPath))
        } catch {
          // не удалось отметить — не критично
        }
      }

      if (localBytes === undefined) {
        // D2: дедупликация при импорте. Если копия этой сессии уже лежит
        // локально под другим id — вторую не создаём, в журнале причина
        // `duplicate`. Ошибка чтения лога не отменяет обычный импорт.
        let duplicate
        try {
          const identity = computeSessionIdentity({ bytes: remoteSession.bytes, projectId })
          const found = findDuplicateAmongLogs({
            sessions: projectLocal,
            identity,
            projectId,
            id: remoteSession.id,
          })
          if (found !== undefined) {
            const localCopy = projectLocal.find(session => session.id === found.id)
            if (localCopy !== undefined && sameSessionCopy(localCopy, identity, remoteSession.bytes, projectId)) {
              duplicate = { id: found.id, match: 'contentHash' }
            }
          }
        } catch {
          duplicate = undefined
        }
        if (duplicate !== undefined) {
          stats.duplicatesSkipped = (stats.duplicatesSkipped ?? 0) + 1
          stats.duplicateIds ??= []
          stats.duplicateIds.push(remoteSession.id)
          summary.duplicatesSkipped = (summary.duplicatesSkipped ?? 0) + 1
          summary.duplicateIds ??= []
          if (summary.duplicateIds.length < 100) {
            summary.duplicateIds.push({
              id: remoteSession.id,
              duplicateOf: duplicate.id,
              match: duplicate.match,
              projectId,
            })
          }
          summary.duplicateReasons = ['duplicate']
          // Копия родителя уже есть локально под другим id: его дети не
          // должны ждать вечно «неприехавшего» родителя.
          arrived.add(remoteSession.id)
          continue
        }
        // Поля правила — в отчёт: владелец/лимит видны и у принятой копии.
        noteRuleField(summary, rule, { bytes: remoteSession.size, deviceId: config.deviceId })
        await write(remapTo(remoteSession.bytes, entry.path))
        stats.imported += 1
        summary.importedIds ??= []
        summary.importedIds.push(remoteSession.id)
        arrived.add(remoteSession.id)
        importedRoots.add(rootOf(remoteGroups.parentById, remoteSession.id))
        if (orphan) {
          stats.orphans = (stats.orphans ?? 0) + 1
          stats.orphanIds ??= []
          if (stats.orphanIds.length < 100) stats.orphanIds.push(remoteSession.id)
        }
        if (remoteGroups.parentById.has(remoteSession.id)) stats.subagents += 1
        continue
      }

      let localTail
      let remoteTail
      try {
        localTail = tailOf(localBytes)
        remoteTail = tailOf(remoteSession.bytes)
      } catch (error) {
        // Это не конфликт версий, а нечитаемый лог: показываем причину.
        summary.errors ??= []
        summary.errors.push({ id: remoteSession.id, message: error instanceof Error ? error.message : String(error) })
        continue
      }

      if (localTail.equals(remoteTail)) {
        stats.unchanged += 1
        continue
      }
      // Правило ownerDevice: в зеркале появилось изменение, которого нет в
      // локальной копии (remoteChanged), а писатель — не владелец (или это
      // устройство не владелец). Молча не перезаписываем — warning + метка
      // конфликта: панель покажет, что копия в зеркале изменена чужой.
      const remoteChanged = !isPrefix(remoteTail, localTail)
      if (rule?.ownerDevice !== undefined && rule.ownerDevice !== '' && remoteChanged) {
        noteRuleField(summary, rule, { bytes: remoteSession.size, deviceId: config.deviceId })
        const message = rule.ownerDevice === config.deviceId
          ? `правило: лог изменён не владельцем — изменение не применено (${remoteSession.id})`
          : `${OWNER_RULE_MESSAGE}: сессия принадлежит ${rule.ownerDevice} — изменение не применено (${remoteSession.id})`
        stats.ruleConflicts = (stats.ruleConflicts ?? 0) + 1
        summary.conflicts += 1
        summary.rules.foreignChanges = (summary.rules.foreignChanges ?? 0) + 1
        summary.rules.foreignChangeIds ??= []
        pushUnique(summary.rules.foreignChangeIds, remoteSession.id)
        pushRuleMessage(summary.rules, message)
        summary.conflictDetails ??= []
        summary.conflictDetails.push({
          id: remoteSession.id,
          kind: 'rule-owner',
          ownerDevice: rule.ownerDevice,
          ruleSource: rule.ruleSource,
          message,
          localTail: localTail.length,
          remoteTail: remoteTail.length,
        })
        addWarning(summary, message)
        continue
      }
      // notifyForeignAppend (пресет control): чужое дополнение лога не
      // блокируем, но сообщаем — это не «изменение владельцем».
      if (rule?.notifyForeignAppend === true && isPrefix(localTail, remoteTail)) {
        const message = `правило: лог дополнен другим устройством (${remoteSession.id})`
        summary.rules.notified += 1
        pushUnique(summary.rules.foreignAppendIds, remoteSession.id)
        pushRuleMessage(summary.rules, message)
      }
      if (isPrefix(localTail, remoteTail)) {
        noteRuleField(summary, rule, { bytes: remoteSession.size, deviceId: config.deviceId })
        if (!dryRun) await backupLog(home, projectId, remoteSession.id, localBytes)
        await write(remapTo(remoteSession.bytes, entry.path))
        stats.updated += 1
        arrived.add(remoteSession.id)
        importedRoots.add(rootOf(remoteGroups.parentById, remoteSession.id))
        if (orphan) {
          stats.orphans = (stats.orphans ?? 0) + 1
          stats.orphanIds ??= []
          if (stats.orphanIds.length < 100) stats.orphanIds.push(remoteSession.id)
        }
        if (remoteGroups.parentById.has(remoteSession.id)) stats.subagents += 1
        continue
      }
      if (isPrefix(remoteTail, localTail)) {
        stats.ahead += 1
        continue
      }

      // Расхождение: обе стороны дописали разное. Правило forbidFork запрещает
      // создавать копию (развилку) — фиксируем конфликт и оставляем локальную
      // версию нетронутой, вместо тихого размножения сессий.
      if (rule?.forbidFork === true) {
        noteRuleField(summary, rule, { bytes: remoteSession.size, deviceId: config.deviceId })
        const message = `правило: развилка запрещена — копия не создана (${remoteSession.id})`
        stats.ruleForbidFork = (stats.ruleForbidFork ?? 0) + 1
        summary.rules.forbidFork += 1
        summary.rules.forbidForkIds ??= []
        pushUnique(summary.rules.forbidForkIds, remoteSession.id)
        summary.conflicts += 1
        summary.conflictDetails ??= []
        summary.conflictDetails.push({
          id: remoteSession.id,
          kind: 'forbid-fork',
          ruleSource: rule.ruleSource,
          message,
          localTail: localTail.length,
          remoteTail: remoteTail.length,
        })
        pushRuleMessage(summary.rules, message)
        addWarning(summary, message)
        continue
      }

      // Развилка создаётся один раз: если точная копия удалённого лога уже
      // импортирована (даже под другим id), вторую не плодим — иначе каждый
      // синк при расхождении добавлял бы новую сессию в список.
      const remoteIdentity = computeSessionIdentity({ bytes: remoteSession.bytes, projectId })
      const alreadyImported = findDuplicateAmongLogs({
        sessions: projectLocal,
        identity: remoteIdentity,
        projectId,
        id: remoteSession.id,
      })
      if (alreadyImported !== undefined) {
        stats.conflicts += 1
        summary.conflictDetails ??= []
        summary.conflictDetails.push({
          id: remoteSession.id,
          localTail: localTail.length,
          remoteTail: remoteTail.length,
          forkExists: alreadyImported.id,
        })
        summary.forkSkipped = (summary.forkSkipped ?? 0) + 1
        continue
      }

      // Расхождение: обе стороны дописали разное. Локальная остаётся, удалённая
      // приезжает отдельной сессией с новым id — ничего не теряется.
      const forkId = `session-${randomUUID()}`
      const forkDir = localSessionDir(home, entry.path, forkId)
      if (!dryRun) {
        await mkdir(forkDir, { recursive: true })
        const forkBytes = remapTo(remoteSession.bytes, entry.path, { id: forkId })
        // Копия получает новый id: события внутри должны называть его же, иначе DSH
        // сочтёт лог повреждённым.
        await writeFile(join(forkDir, 'session.v4.jsonl.zstd'), repairLog(forkBytes).bytes)
        try {
          markSynced(ledger, forkId, await stat(join(forkDir, 'session.v4.jsonl.zstd')))
        } catch {
          // отметка необязательна
        }
      }
      stats.conflicts += 1
      summary.conflictDetails ??= []
      summary.conflictDetails.push({ id: remoteSession.id, localTail: localTail.length, remoteTail: remoteTail.length })
      summary.forkIds ??= []
      summary.forkIds.push({ from: remoteSession.id, to: forkId })
      } catch (error) {
        // Любая ошибка по одной сессии не останавливает обработку остальных.
        summary.errors ??= []
        summary.errors.push({ id: remoteSession.id, message: error instanceof Error ? error.message : String(error) })
      }
    }

    // Субагенты, которых не удалось привезти, хотя родитель приехал: пишем в
    // журнал и в панель, чтобы «потерянный ребёнок» не остался незамеченным.
    if (!dryRun) {
      for (const parentId of arrived) {
        for (const childId of remoteGroups.childrenByParent.get(parentId) ?? []) {
          if (localModes.localIds.has(normalizeSessionId(childId))) continue
          if (existsSync(localSessionDir(home, entry.path, childId))) continue
          if (!stats.childrenMissing.includes(childId)) stats.childrenMissing.push(childId)
        }
      }
      if (stats.childrenMissing.length > 0) {
        summary.childrenMissingCount = (summary.childrenMissingCount ?? 0) + stats.childrenMissing.length
        summary.childrenMissing = [...new Set([...(summary.childrenMissing ?? []), ...stats.childrenMissing])].slice(0, 50)
      }
    }

    // Удаления с других устройств: локальную копию переносим в локальный архив
    // (каталог на сессию) и убираем из списка. Данные не исчезают — их можно
    // вернуть из архива или кнопкой «Восстановить» в панели. Локальные сессии
    // отметкой с другого устройства не удаляются, снятые (restored) — тоже.
    // Группа удаляется вместе: метка родителя уносит и его субагентов.
    if (!dryRun) {
      const localDeletions = await applyLocalTombstones({
        home,
        config,
        projectPath: entry.path,
        groups: localGroups,
        localModes,
        tombstones,
      })
      // M7: «воскрешение» и предохранители — в сводку приёма.
      for (const [sessionId, entryMark] of localDeletions.restoredMarks ?? []) restoredMarks.set(sessionId, entryMark)
      if (localDeletions.revivedIds.length > 0) {
        summary.revivedIds = [...new Set([...(summary.revivedIds ?? []), ...localDeletions.revivedIds])].slice(0, 100)
        summary.revivedDetails = [...(summary.revivedDetails ?? []), ...localDeletions.revivedDetails].slice(0, 100)
      }
      if (localDeletions.deletionsBlocked !== undefined) {
        summary.deletionsBlocked = mergeDeletionsBlocked(summary.deletionsBlocked, localDeletions.deletionsBlocked, projectId)
        summary.pendingDeletions = mergePendingDeletions(summary.pendingDeletions, localDeletions.pendingDeletions)
        for (const sessionId of localDeletions.deletionsBlocked.ids ?? []) blockedDeletionIds.add(sessionId)
      }
      if (localDeletions.deleted > 0) {
        summary.deleted = (summary.deleted ?? 0) + localDeletions.deleted
        summary.deletedIds = [...(summary.deletedIds ?? []), ...localDeletions.deletedIds]
        summary.deletedReason = 'удалено по отметке другого устройства'
        summary.deletedDetails = [...(summary.deletedDetails ?? []), ...localDeletions.deletedDetails]
        summary.deletedReasons = [...new Set((summary.deletedDetails ?? []).map(item => item.reason))]
        summary.deletedBy = [...new Set((summary.deletedDetails ?? []).map(item => item.by).filter(Boolean))]
        summary.childrenDeleted = (summary.childrenDeleted ?? 0) + localDeletions.childrenDeleted
        summary.childrenDeletedIds = [
          ...(summary.childrenDeletedIds ?? []),
          ...localDeletions.childrenDeletedIds,
        ].slice(0, 100)
        summary.groupsDeleted = (summary.groupsDeleted ?? 0) + localDeletions.groupsDeleted
        stats.childrenDeleted = (stats.childrenDeleted ?? 0) + localDeletions.childrenDeleted
        for (const sessionId of localDeletions.deletedIds) delete ledger.sessions[sessionId]
      }

      // «Воскрешение»: другое устройство (или старая сборка) снова отправило
      // копию удалённой сессии в зеркало. Вернуть её в карантин без метки
      // нельзя, поэтому запоминаем id и применяем метки отдельным проходом.
      //
      // Свежая ручная метка без карантина — ещё не подтверждённое удаление
      // (панельное удаление пишет метку, а карантин делает «Применить
      // удаления»): такую копию не трогаем, иначе подтверждение обходилось бы.
      const nowMs = Date.now()
      for (const [sessionId, mark] of activeDeletionMarks(tombstones, sessionId => localModes.localIds.has(normalizeSessionId(sessionId)))) {
        if (!mirrorIds.has(sessionId)) continue
        // Остановленное предохранителем удаление не обходим автопроходом:
        // такие метки ждут явного «Применить удаления».
        if (blockedDeletionIds.has(sessionId)) continue
        const hasQuarantine = existsSync(join(quarantinePath(config.repoDir, projectId, sessionId), LOG_NAME))
        const markAt = Date.parse(String(mark.at ?? ''))
        const confirmed = !Number.isFinite(markAt) || nowMs - markAt > PENDING_MANUAL_WINDOW_MS
        if (hasQuarantine || confirmed) resurrected.add(sessionId)
      }
    }

    stats.sessions = stats.imported + stats.updated
    stats.groups = importedRoots.size
    stats.children = stats.subagents
    if (stats.orphans > 0) {
      summary.orphans += stats.orphans
      summary.orphanIds = [
        ...new Set([...(summary.orphanIds ?? []), ...(stats.orphanIds ?? [])]),
      ].slice(0, 100)
    }
    if (stats.childrenQuarantined > 0) {
      summary.childrenQuarantined += stats.childrenQuarantined
      summary.childrenQuarantinedIds = [
        ...new Set([...(summary.childrenQuarantinedIds ?? []), ...(stats.childrenQuarantinedIds ?? [])]),
      ].slice(0, 100)
      summary.groupsQuarantined = (summary.groupsQuarantined ?? 0) + quarantineRoots.size
    }
    if (stats.waitingParent > 0) {
      summary.waitingParent = (summary.waitingParent ?? 0) + stats.waitingParent
      summary.waitingParentIds = [
        ...new Set([...(summary.waitingParentIds ?? []), ...(stats.waitingParentIds ?? [])]),
      ].slice(0, 100)
    }
    summary.groups += stats.groups
    summary.children += stats.children
    summary.sessions += stats.sessions
    summary.subagents += stats.subagents
    summary.imported += stats.imported
    summary.updated += stats.updated
    summary.conflicts += stats.conflicts
    summary.unchanged += stats.unchanged
    summary.ahead += stats.ahead
    summary.locked += stats.locked
    summary.localSkipped += stats.localSkipped ?? 0
    summary.pendingDeletion = (summary.pendingDeletion ?? 0) + (stats.pendingDeletion ?? 0)
    summary.projects.push(stats)
  }

  // Снятые при приёме метки (сессия оказалась новее удаления) возвращаем в
  // зеркало: иначе другие устройства продолжали бы считать сессию удалённой.
  if (tombstonesDirty && !dryRun) {
    try {
      await writeTombstones(config.repoDir, tombstones)
    } catch {
      // запись — страховка для следующей отправки, приём уже выполнен
    }
  }

  // Повторно применить активные метки к «воскресшим» копиям зеркала: это и есть
  // удаление «везде» без воскрешения. Проход подтверждённый (метки уже есть),
  // карантин — на каждую сессию, дети уходят вместе с родителем (reason children).
  // Идёт до профильного слоя: applyDeletions сам делает fetch+reset, и файлы,
  // записанные приёмом профиля, не должны попасть под этот сброс.
  if (!dryRun && resurrected.size > 0) {
    try {
      const reconciled = await applyDeletions({
        home,
        config,
        project,
        confirm: true,
        ids: [...resurrected],
        message: `dsh-sync: повторно применены метки удаления (${config.deviceId})`,
        dshVersion,
      })
      summary.reconciled = {
        removed: reconciled.removed ?? 0,
        removedIds: (reconciled.removedIds ?? []).slice(0, 100),
        groupsDeleted: reconciled.groupsDeleted ?? 0,
        children: reconciled.children ?? 0,
        message: reconciled.message,
      }
      if ((reconciled.removed ?? 0) > 0) {
        summary.groupsDeleted = (summary.groupsDeleted ?? 0) + (reconciled.groupsDeleted ?? 0)
        addWarning(summary, `повторно применены метки удаления: ${reconciled.removed}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      summary.reconciled = { removed: 0, error: message }
      addWarning(summary, `метки удаления не применены повторно: ${message}`)
    }
  }

  // «Воскрешение»: сессии с логом новее метки не удалены, их метки помечены
  // restored. Пишем их после fetch+reset и после повторного применения меток,
  // иначе дерево зеркала сбросилось бы и защита пропала.
  if (!dryRun && restoredMarks.size > 0) {
    const written = await persistRestoredMarks({ config, restored: restoredMarks })
    if (written > 0) {
      summary.revivedMarksWritten = written
      addWarning(summary, `метки удаления сняты (лог новее метки): ${summary.revivedIds.length}`)
    }
  }
  if (summary.deletionsBlocked !== undefined) {
    // Строка в last-run/панель: автоудаление остановлено, разбираться вручную.
    addWarning(summary, deletionsBlockedMessage(summary.deletionsBlocked.count))
    summary.deletionsBlocked.message = deletionsBlockedMessage(summary.deletionsBlocked.count)
  }

  if (config.attachments) {
    summary.attachments = await pullAttachments({ home, repoDir: config.repoDir })
  }

  // Профильный слой и план привязки рабочих пространств. В отличие от сессий,
  // здесь нечего импортировать в стор DSH «напрямую»: патч и настройки
  // применяются как файлы, а привязку сессий выполняет host через реестр.
  const neutralizer = createNeutralizer({ home: homedir(), dshHome: home })
  if (config.profile?.enabled !== false) {
    try {
      summary.profile = await pullProfile({ home, config, repoDir: config.repoDir, neutralizer, dryRun })
    } catch (error) {
      summary.profileError = error instanceof Error ? error.message : String(error)
    }
  }
  if (config.workspace?.enabled !== false) {
    try {
      summary.workspace = await pullWorkspace({ home, config, repoDir: config.repoDir, neutralizer, dryRun })
    } catch (error) {
      summary.workspaceError = error instanceof Error ? error.message : String(error)
    }
  }

  // Правила сессий: конфликты слияния (свежее побеждает) — в журнал профиля
  // зеркала, чтобы расхождение правил на устройствах не терялось и было видно
  // в диагностике. Локальная копия журнала уже записана mergeRulesFromProfile.
  if (ruleConflicts.length > 0) {
    summary.ruleConflicts = ruleConflicts.slice(0, 50)
    if (!dryRun && config.profile?.enabled !== false) {
      try {
        const entries = ruleConflicts.map(conflict => ({
          file: RULES_PROFILE_RELATIVE,
          reason: `правило сессии: ${conflict.kind ?? 'session-rule'} ${conflict.id ?? ''} — свежее побеждает`,
          kind: 'session-rules',
          id: conflict.id,
          winner: conflict.winner,
        }))
        summary.ruleConflictsJournal = await appendJournal(config.repoDir, entries, config.deviceId)
      } catch {
        // журнал профиля необязателен
      }
    }
  }

  // Журнал причин приёма: `children` — дети, ушедшие вместе с удалённым
  // родителем (локальный архив или непринятые копии), `orphan` — сироты,
  // которых импортировали и защитили от удаления.
  summary.importReasons = summary.orphans > 0 ? [ORPHAN_REASON] : []
  summary.reasonCounts = {
    children: (summary.childrenQuarantined ?? 0) + (summary.childrenDeleted ?? 0),
    orphan: summary.orphans ?? 0,
  }

  await writeLedger(home, ledger)
  return summary
}
