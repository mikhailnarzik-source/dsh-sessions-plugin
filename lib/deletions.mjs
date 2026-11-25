/**
 * Кандидаты на удаление сессий из зеркала — только чтение.
 *
 * Удаление из зеркала — отдельное подтверждённое действие: push ничего не
 * удаляет, а план «Проверить» показывает, что было бы удалено. Здесь общая
 * логика отбора: что удалять, кого защитить (локальные копии, субагенты живых
 * родителей, осиротевшие дети) и какие группы «родитель + субагенты» уйдут
 * вместе. Функции модуля не пишут на диск — их вызывают и план, и
 * подтверждённое удаление.
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeSegment, projectKey } from './format.mjs'
import { DELETED_AT_FILE, QUARANTINE_DIR, isActiveTombstone, quarantinePath } from './tombstones.mjs'
import { LOG_NAME, splitLog } from './store.mjs'
import { depthOf, descendantsOf } from './session-groups.mjs'
import { normalizeSessionId } from './session-modes.mjs'
import { PROTECTED_RULE_LABEL, normalizeRuleId, resolveRulesForSessions } from './session-rules.mjs'

/** Больше этого числа удалений за прогон — повод показать предупреждение. */
export const PRUNE_MAX_COUNT = 5
/** Больше этой доли известных сессий за прогон — повод показать предупреждение. */
export const PRUNE_MAX_RATIO = 0.2
/** Код причины удаления для субагента, ушедшего вместе с родителем. */
export const CHILDREN_REASON = 'children'
/** Код причины для копии, проигравшей восстановлению. */
export const SUPERSEDED_REASON = 'superseded'
/**
 * Код причины «сирота»: ребёнок, у которого в источнике нет родителя.
 * Такая сессия импортируется/остаётся, но не удаляется — иначе копия
 * потерялась бы без возможности восстановить группу.
 */
export const ORPHAN_REASON = 'orphan'
/** Больше стольких id группа за один раз не разворачивается. */
export const GROUP_DELETION_LIMIT = 500
/** Метка в имени каталога карантина: не путается с обычным карантином. */
export const SUPERSEDED_TAG = '.superseded-'

/**
 * Человекочитаемая причина по коду.
 *
 * Код причины хранится в надгробиях и deleted-at.json, а человеку нужно
 * объяснение: панель «Удалённые» и локальный архив показывают подпись.
 */
export function reasonLabel(reason) {
  switch (reason) {
    case CHILDREN_REASON: return 'удалено вместе с родителем'
    case ORPHAN_REASON: return 'сирота: родителя нет в источнике'
    case SUPERSEDED_REASON: return 'копия уступила восстановлению'
    case 'made-local': return 'оставлена только на этом устройстве'
    case 'duplicate': return 'дубль сессии'
    case 'expired': return 'срок карантина истёк'
    case 'replaced': return 'заменено более новой версией'
    case 'restored': return 'восстановлено'
    default: return 'удалено по отметке'
  }
}

/**
 * Развернуть запрошенные id в группы «родитель + субагенты».
 *
 * Локальная команда удаления и очередь операций передают id, которые выбрал
 * пользователь. Если это родитель, вместе с ним уходят метки всем потомкам —
 * иначе на другом устройстве остались бы сироты. Если это ребёнок, группа не
 * поднимается вверх: удаление субагента не должно удалять живого родителя.
 *
 * @param childrenByParent карта «id → дети» (источник: стор или зеркало)
 * @param ids id, которые запросили к удалению (могут быть короткими)
 * @returns {{ requested: string[], ids: string[], children: string[],
 *   groups: Array<{parent: string, children: string[], size: number}> }}
 */
export function expandDeletionIds({ childrenByParent, ids = [] } = {}) {
  const requested = []
  const members = new Set()
  const children = new Set()
  const groups = []
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = normalizeSessionId(raw)
    if (id === '') continue
    if (!requested.includes(id)) requested.push(id)
    if (members.size >= GROUP_DELETION_LIMIT) break
    const descendants = descendantsOf(childrenByParent, id)
    members.add(id)
    for (const childId of descendants) {
      members.add(childId)
      children.add(childId)
    }
    if (descendants.length > 0) {
      groups.push({ parent: id, children: descendants.slice().sort(), size: 1 + descendants.length })
    }
  }
  return { requested, ids: [...members], children: [...children], groups }
}

/**
 * Дети без родителя в наборе-источнике: id такой сессии и её родитель.
 *
 * `buildSessionGroups` помнит ссылку `parentSession` даже когда самого
 * родителя в наборе нет, поэтому сироту видно по заголовку. Явная активная
 * метка удаления сильнее: такую сессию удаляют, а не защищают.
 *
 * @param parentById карта «ребёнок → родитель»
 * @param present id сессий, которые есть в источнике
 * @param tombstones надгробия (необязательно)
 * @returns {Array<{id: string, parent: string}>}
 */
export function orphanChildren({ parentById, present, tombstones } = {}) {
  const presentIds = present instanceof Set ? present : new Set(Array.isArray(present) ? present : [])
  const result = []
  for (const [childId, parentId] of parentById ?? []) {
    if (parentId === '' || parentId === childId) continue
    if (presentIds.has(parentId)) continue
    if (presentIds.size > 0 && !presentIds.has(childId)) continue
    if (isActiveTombstone(tombstones?.sessions?.[childId])) continue
    result.push({ id: childId, parent: parentId })
  }
  return result.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Каталог локального архива удалённых: отдельный каталог на каждую сессию.
 *
 * Локальный архив не заменяет карантин зеркала (тот нужен другому устройству),
 * но без него удаление по метке уничтожало бы данные на этом устройстве.
 */
export function localQuarantineDir(home, sessionId, now = Date.now()) {
  const stamp = new Date(Number.isFinite(now) ? now : Date.now()).toISOString().replace(/[:.]/g, '-')
  return join(home, 'dsh-sync', 'deleted', stamp, encodeSegment(canonicalRestoreId(sessionId)))
}

/**
 * Перенести локальную копию сессии в локальный архив (обратимо).
 *
 * Рядом с логом пишется deleted-at.json с причиной: без него «Удалённые» не
 * объяснят, почему сессия исчезла, и через 30 дней её не найти в карантине.
 * Если rename не удался (файл занят), копия удаляется как раньше, а вызывающий
 * видит `quarantined: false`.
 *
 * @returns {{ quarantined: boolean, code: string, dir: string, reason: string }}
 */
export async function quarantineLocalCopy({
  home,
  sessionDir,
  sessionId,
  reason = 'manual',
  parent = '',
  title = '',
  deviceId = 'device',
  by = 'sync',
  now = Date.now(),
  dryRun = false,
} = {}) {
  const target = localQuarantineDir(home, sessionId, now)
  if (dryRun) return { quarantined: false, code: 'dry-run', dir: target, reason }
  let bytes
  try {
    bytes = (await stat(join(sessionDir, LOG_NAME))).size
  } catch {
    // размер необязателен
  }
  await mkdir(dirname(target), { recursive: true })
  let quarantined = false
  try {
    await rename(sessionDir, target)
    quarantined = true
  } catch {
    // В архиве могла остаться копия того же id — заменяем её.
    try {
      await rm(target, { recursive: true, force: true })
      await rename(sessionDir, target)
      quarantined = true
    } catch {
      quarantined = false
    }
  }
  if (!quarantined) {
    await rm(sessionDir, { recursive: true, force: true })
    return { quarantined: false, code: 'removed', dir: target, reason }
  }
  const record = {
    at: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    reason,
    reasonLabel: reasonLabel(reason),
    by,
    device: deviceId,
  }
  if (typeof title === 'string' && title.trim() !== '') record.title = title.trim().slice(0, 160)
  if (Number.isFinite(bytes) && bytes > 0) record.bytes = Math.trunc(bytes)
  if (typeof parent === 'string' && parent !== '') record.parent = parent
  try {
    await writeFile(join(target, DELETED_AT_FILE), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // подпись необязательна: каталог уже в архиве
  }
  return { quarantined: true, code: 'quarantined', dir: target, reason }
}

// --- детерминированный рейтинг кандидатов (M1, D4) ------------------------
//
// Одна и та же сессия может существовать несколькими копиями: локальная,
// зеркальная, fork после конфликта, копия из карантина. Какая из них главная,
// должно решаться одинаково на любом устройстве и в любом порядке обхода.
// Порядок критериев (больше — главнее):
//   1. lastEventAt — когда реально дописали последнее событие;
//   2. events      — сколько событий;
//   3. bytes       — размер лога;
//   4. children    — есть ли субагенты (родитель важнее копии-ребёнка);
//   5. createdAt   — меньше значит раньше создана (она и есть оригинала);
//   6. id          — меньше значит лексикографически первее (стабильный добор).

/** Время в мс из числа (эпоха), ISO-строки или Date; 0 — времени нет. */
function rankTime(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

/** Размер кандидата в байтах: bytes/sizeBytes/size. */
function rankSize(candidate) {
  return Number(candidate?.bytes ?? candidate?.sizeBytes ?? candidate?.size ?? 0) || 0
}

/** Число детей: массив, число или карта `childrenById`. */
function rankChildren(candidate, childrenById) {
  if (childrenById instanceof Map) {
    const value = childrenById.get(candidate?.id)
    if (Array.isArray(value)) return value.length
    if (Number.isFinite(value)) return Number(value)
  }
  if (Array.isArray(candidate?.children)) return candidate.children.length
  if (Number.isFinite(candidate?.children)) return Number(candidate.children)
  return 0
}

/** Числовые ключи рейтинга одного кандидата — для тестов и отладки. */
export function candidateRankKey(candidate, childrenById) {
  return {
    lastEventAt: rankTime(candidate?.lastEventAt ?? candidate?.updatedAt ?? candidate?.createdAt),
    events: Number(candidate?.events ?? candidate?.eventCount ?? 0) || 0,
    bytes: rankSize(candidate),
    children: rankChildren(candidate, childrenById),
    createdAt: rankTime(candidate?.createdAt),
    id: String(candidate?.id ?? ''),
  }
}

/** Сравнить двух кандидатов: <0 — левый главнее. */
export function compareCandidates(left, right, childrenById) {
  const a = candidateRankKey(left, childrenById)
  const b = candidateRankKey(right, childrenById)
  if (a.lastEventAt !== b.lastEventAt) return b.lastEventAt - a.lastEventAt
  if (a.events !== b.events) return b.events - a.events
  if (a.bytes !== b.bytes) return b.bytes - a.bytes
  if (a.children !== b.children) return b.children - a.children
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * Отсортировать кандидатов от главного к проигравшим.
 *
 * Результат зависит только от набора кандидатов, а не от порядка в массиве:
 * два устройства получат один и тот же список. Исходный массив не меняется.
 *
 * @param {Array<{id: string, lastEventAt?, events?, bytes?, sizeBytes?,
 *   children?, createdAt?}>} candidates
 * @param {Map<string, string[]>} [childrenById] карта «id → дети»
 */
export function rankCandidates(candidates, childrenById) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate !== null && typeof candidate === 'object')
  return list.slice().sort((left, right) => compareCandidates(left, right, childrenById))
}

/** Список кандидатов из разных форм второго аргумента chooseCanonical. */
function candidateList(value) {
  if (Array.isArray(value)) {
    if (value.every(item => typeof item === 'string')) return { children: value, candidates: [] }
    return { children: undefined, candidates: value.filter(item => item !== null && typeof item === 'object' && typeof item.id === 'string') }
  }
  if (value instanceof Map) return { children: undefined, candidates: [], childrenById: value }
  if (value !== null && typeof value === 'object' && typeof value.id === 'string') return { children: undefined, candidates: [value] }
  return { children: undefined, candidates: [] }
}

/**
 * Выбрать канонический id сессии и проигравших копий.
 *
 * Канонический id — id победителя рейтинга; если у победителя детей нет, а у
 * кого-то из кандидатов есть, канонический id берётся у лучшего из «родителей»:
 * субагенты должны остаться при живом родителе, а не при пустой копии.
 *
 * @param {object} winner победитель рейтинга (объект с id)
 * @param {Array<object>|Array<string>|Map} [candidates] копии той же сессии;
 *   массив строк или `children` — дети победителя, Map — карта «id → дети»
 * @param {object} [options]
 * @param {Map<string, string[]>} [options.childrenById] карта «id → дети»
 * @param {string[]} [options.children] дети победителя
 * @param {string} [options.restoredFrom] причина восстановления (если уже известна)
 * @param {object} [options.tombstones] надгробия зеркала (откуда взять restoredFrom)
 * @returns {{ canonicalId: string, winnerId: string, canonical: object,
 *   winner: object, ranked: object[], restoredFrom: string,
 *   superseded: Array<{id: string, reason: string, canonicalId: string, winnerId: string}>,
 *   supersededIds: string[], children: number, reason: string }}
 */
export function chooseCanonical(winner, candidates = [], options = {}) {
  const parsed = candidateList(candidates)
  const childrenById = parsed.childrenById ?? options.childrenById
  const winnerChildren = options.children ?? parsed.children
  let list = parsed.candidates
  const winnerObject = winner !== null && typeof winner === 'object' && typeof winner.id === 'string' ? winner : undefined
  if (winnerObject !== undefined && !list.some(candidate => candidate.id === winnerObject.id)) {
    list = [winnerObject, ...list]
  }
  const ranked = rankCandidates(list, childrenById)
  const actualWinner = winnerObject ?? ranked[0]
  if (actualWinner === undefined) {
    return {
      canonicalId: '',
      winnerId: '',
      canonical: undefined,
      winner: undefined,
      ranked: [],
      restoredFrom: '',
      superseded: [],
      supersededIds: [],
      children: 0,
      reason: '',
    }
  }
  const childCount = (candidate) => {
    if (candidate === actualWinner && Array.isArray(winnerChildren)) return winnerChildren.length
    return rankChildren(candidate, childrenById)
  }
  // Канонический id: у победителя дети есть — он и есть; нет — ищем лучшего
  // из тех, у кого дети есть (иначе субагенты остались бы без родителя).
  let canonical = actualWinner
  if (childCount(actualWinner) === 0) {
    for (const candidate of ranked) {
      if (childCount(candidate) > 0) {
        canonical = candidate
        break
      }
    }
  }
  const canonicalId = String(canonical.id)
  const winnerId = String(actualWinner.id)
  const superseded = ranked
    .filter(candidate => String(candidate.id) !== canonicalId)
    .map(candidate => ({
      id: String(candidate.id),
      reason: SUPERSEDED_REASON,
      canonicalId,
      winnerId,
    }))
  const fromTombstones = (id) => (options.tombstones === undefined ? '' : restoredFromOf(options.tombstones, id))
  const restoredFrom = typeof options.restoredFrom === 'string' && options.restoredFrom !== ''
    ? options.restoredFrom
    : (typeof actualWinner.restoredFrom === 'string' && actualWinner.restoredFrom !== '' ? actualWinner.restoredFrom
      : (typeof canonical.restoredFrom === 'string' && canonical.restoredFrom !== '' ? canonical.restoredFrom
        : (fromTombstones(canonicalId) || fromTombstones(winnerId) || '')))
  return {
    canonicalId,
    winnerId,
    canonical,
    winner: actualWinner,
    ranked,
    restoredFrom,
    superseded,
    supersededIds: superseded.map(item => item.id),
    children: childCount(canonical),
    reason: superseded.length > 0 ? SUPERSEDED_REASON : '',
  }
}

/** Есть ли каталог сессии в зеркале: только такие сессии можно переносить. */
export function mirrorHasSession(repoDir, projectId, sessionId) {
  return existsSync(join(repoDir, 'sessions', projectId, encodeSegment(sessionId)))
}

/**
 * Субагенты живых родителей, которых локально нет. Их нельзя удалять из
 * зеркала и нельзя создавать им надгробия — иначе другое устройство потеряло
 * бы детей живого родителя.
 */
export function missingChildren({ allSessions, mirrorView, current, localIds, tombstones }) {
  const childrenMissing = []
  for (const session of allSessions) {
    for (const childId of descendantsOf(mirrorView.childrenByParent, session.id)) {
      if (current.has(childId) || localIds.has(normalizeSessionId(childId))) continue
      // Явная метка удаления сильнее защиты: пользователь удалил этого
      // ребёнка сам, и зеркало должно с ним расстаться.
      if (isActiveTombstone(tombstones.sessions[childId])) continue
      if (!childrenMissing.includes(childId)) childrenMissing.push(childId)
    }
  }
  return childrenMissing
}

/** Пустой результат: кандидатов нет, но структура полей та же. */
function emptyResult({ previous, protectedLocalMirror }) {
  return {
    candidates: new Set(),
    planned: new Set(),
    missing: [],
    groups: [],
    groupChildren: new Map(),
    known: previous.size,
    overCount: false,
    overRatio: false,
    needsGroupConfirm: false,
    manualParent: new Set(),
    protectedLocalMirror,
    orphansProtected: [],
    // Сессии, которые план хотел удалить, но их защищает правило (session-rules).
    protectedByRule: [],
    staleTombstones: [],
    warning: undefined,
    blocked: false,
  }
}

/**
 * Посчитать кандидатов на удаление из зеркала для одного проекта.
 *
 * @param home каталог DSH (нужен, чтобы понять, доступен ли каталог сессий)
 * @param config настройки синхронизации (repoDir)
 * @param projectId идентификатор проекта в зеркале
 * @param projectPath локальный путь проекта
 * @param previous id сессий, отправленных этим устройством раньше (state.json)
 * @param current id сессий, которые существуют локально и участвуют в обмене
 * @param localIds id сессий в режиме «локальная» (нормализованные)
 * @param tombstones прочитанные надгробия зеркала
 * @param mirrorView { parentById, childrenByParent, sessions } зеркала
 * @param childrenMissing результат missingChildren() для этого проекта
 * @param rules правила сессий (session-rules.mjs): `protect` защищает сессию от
 *   удаления. Не переданы — защиты по правилам нет (прежнее поведение).
 */
export function planDeletions({
  home,
  config,
  projectId,
  projectPath,
  previous,
  current,
  localIds,
  tombstones,
  mirrorView,
  childrenMissing = [],
  rules,
}) {
  const repoDir = config.repoDir
  const projectDir = join(repoDir, 'sessions', projectId)
  const protectedLocalMirror = new Set()
  const staleTombstones = []
  const sessionsTombstones = tombstones?.sessions ?? {}

  // Кандидаты: сессии, которые это устройство отправляло раньше, но локально
  // их больше нет, плюс сессии с надгробием, которые ещё лежат в зеркале.
  const missing = [...previous].filter(id => !current.has(id) && !localIds.has(id))
  const candidates = new Set(missing)
  for (const sessionId of Object.keys(sessionsTombstones)) {
    // Локальная сессия не даёт надгробий и не удаляется: она просто живёт на
    // этом устройстве и в зеркале её может не быть вовсе.
    if (localIds.has(sessionId)) {
      if (mirrorHasSession(repoDir, projectId, sessionId)) protectedLocalMirror.add(sessionId)
      continue
    }
    if (current.has(sessionId)) {
      // Сессия снова существует — отметка больше не нужна.
      staleTombstones.push(sessionId)
      continue
    }
    if (mirrorHasSession(repoDir, projectId, sessionId)) candidates.add(sessionId)
  }

  const base = emptyResult({ previous, protectedLocalMirror })
  base.missing = missing
  base.staleTombstones = staleTombstones
  if (candidates.size === 0) return base

  // Каталог сессий или каталог именно этого проекта недоступен: это почти
  // наверняка сломанный доступ, а не «удалили всё» — удаление пропускаем.
  const root = join(home, 'sessions')
  const projectBucket = join(root, projectKey(projectPath ?? ''))
  if (!existsSync(root) || !existsSync(projectBucket)) {
    return { ...base, blocked: true, warning: 'каталог сессий проекта недоступен — удаление из зеркала пропущено' }
  }

  // 1. Переносить в карантин можно только то, что реально лежит в зеркале.
  const planned = new Set([...candidates].filter(id => mirrorHasSession(repoDir, projectId, id)))
  // 2. Дети живого родителя, которых локально нет, защищены.
  for (const childId of childrenMissing) planned.delete(childId)
  // 3. Родитель уносит с собой детей, которых локально уже нет.
  for (const parentId of [...planned]) {
    for (const childId of descendantsOf(mirrorView.childrenByParent, parentId)) {
      if (current.has(childId)) continue
      if (localIds.has(normalizeSessionId(childId))) {
        if (mirrorHasSession(repoDir, projectId, childId)) protectedLocalMirror.add(childId)
        continue
      }
      if (childrenMissing.includes(childId)) continue // ребёнок живого родителя защищён
      if (!mirrorHasSession(repoDir, projectId, childId)) continue
      planned.add(childId)
    }
  }
  // 4. Субагент без родителя в зеркале — осиротевшая копия: без родителя не
  //    удаляем (кроме случая явной метки удаления). Защита идёт по поддереву.
  const mirrorIds = new Set(mirrorView.sessions.map(session => session.id))
  const orphanRoots = []
  for (const id of planned) {
    const parent = mirrorView.parentById.get(id)
    if (parent === undefined || parent === '') continue
    if (planned.has(parent)) continue
    if (current.has(parent) || localIds.has(normalizeSessionId(parent))) continue // живой родитель
    if (mirrorIds.has(parent)) continue // родитель жив в зеркале
    if (isActiveTombstone(sessionsTombstones[id])) continue // удаление подтверждено меткой
    orphanRoots.push(id)
  }
  const orphans = [...orphanRoots]
  for (const rootId of orphanRoots) {
    for (const descendant of descendantsOf(mirrorView.childrenByParent, rootId)) {
      if (planned.has(descendant) && !orphans.includes(descendant)) orphans.push(descendant)
    }
  }
  for (const id of orphans) planned.delete(id)

  // 4.5. Правила сессий: `protect` сильнее плана — сессия остаётся в зеркале,
  //      а в план попадает строка «защищена правилом». Наследование идёт по
  //      связям зеркала: ребёнок защищённого родителя тоже защищён. Защита
  //      считается после групп и сирот, чтобы ни один путь удаления её не обошёл.
  const protectedByRule = []
  if (rules !== undefined && rules !== null && planned.size > 0) {
    const resolved = resolveRulesForSessions({
      rules,
      sessions: mirrorView.sessions,
      groups: mirrorView,
      workspaceId: projectId,
    })
    for (const sessionId of [...planned]) {
      const rule = resolved.get(normalizeRuleId(sessionId))
      if (rule === undefined || rule.protect !== true) continue
      planned.delete(sessionId)
      protectedByRule.push({
        id: sessionId,
        protected: true,
        ownerBlocked: rule.ownerBlocked === true,
        overLimit: false,
        ruleSource: rule.ruleSource,
        preset: rule.preset,
        inheritedFrom: rule.inheritedFrom,
        label: PROTECTED_RULE_LABEL,
      })
    }
    protectedByRule.sort((left, right) => left.id.localeCompare(right.id))
  }

  // 5. Группы: родитель и его потомки, которые уходят в этом же прогоне.
  //    Группа — верхний родитель без удаляемого предка (вложенные уровни
  //    входят в неё же, без двойного счёта).
  const hasPlannedAncestor = (id) => {
    const seen = new Set([id])
    let parent = mirrorView.parentById.get(id)
    while (parent !== undefined && parent !== '' && !seen.has(parent)) {
      if (planned.has(parent)) return true
      seen.add(parent)
      parent = mirrorView.parentById.get(parent)
    }
    return false
  }
  const groups = []
  for (const parent of planned) {
    if (hasPlannedAncestor(parent)) continue
    const children = descendantsOf(mirrorView.childrenByParent, parent).filter(child => planned.has(child))
    if (children.length > 0) groups.push({ parent, children: children.sort(), size: 1 + children.length })
  }
  // Ближайший удаляемый родитель каждого ребёнка — для метки и карантина.
  const groupChildren = new Map()
  const plannedDeepFirst = [...planned].sort(
    (left, right) => depthOf(mirrorView.parentById, right) - depthOf(mirrorView.parentById, left),
  )
  for (const parentId of plannedDeepFirst) {
    for (const childId of descendantsOf(mirrorView.childrenByParent, parentId)) {
      if (planned.has(childId) && !groupChildren.has(childId)) groupChildren.set(childId, parentId)
    }
  }

  // Явная ручная метка родителя — это уже подтверждённое удаление: повторно
  // спрашивать пользователя не нужно.
  const manualParent = new Set()
  for (const id of planned) {
    const entry = sessionsTombstones[id]
    if (entry !== undefined && isActiveTombstone(entry) && entry.by === 'owner'
      && (entry.reason === 'manual' || entry.reason === CHILDREN_REASON)) {
      manualParent.add(id)
    }
  }

  const known = previous.size
  return {
    candidates,
    planned,
    missing,
    groups,
    groupChildren,
    known,
    overCount: planned.size > PRUNE_MAX_COUNT,
    overRatio: known > 0 && planned.size / known > PRUNE_MAX_RATIO,
    needsGroupConfirm: groups.some(group => !manualParent.has(group.parent)),
    manualParent,
    protectedLocalMirror,
    orphansProtected: orphans.slice(0, 50),
    protectedByRule,
    staleTombstones,
    warning: undefined,
    blocked: false,
  }
}

/**
 * Человекочитаемая причина удаления для одной сессии плана.
 * @returns {{ reason: string, humanReason: string, parent?: string, groupChild: boolean }}
 */
export function deletionReason({ sessionId, planned, groupChildren, missing, tombstones }) {
  const groupParent = groupChildren.get(sessionId)
  if (groupParent !== undefined && planned.has(groupParent)) {
    return { reason: CHILDREN_REASON, humanReason: 'удалено вместе с родителем', parent: groupParent, groupChild: true }
  }
  const entry = tombstones?.sessions?.[sessionId]
  if (entry !== undefined && isActiveTombstone(entry)) {
    return { reason: entry.reason ?? 'prune', humanReason: 'отметка другого устройства', groupChild: false }
  }
  if (missing.includes(sessionId)) return { reason: 'prune', humanReason: 'удалено локально', groupChild: false }
  return { reason: 'prune', humanReason: 'отметка другого устройства', groupChild: false }
}

// --- восстановление: тот же id и карантин проигравшей копии (H4) -----------

/**
 * Канонический id восстановления: DSH всегда хранит id с префиксом `session-`,
 * поэтому короткий id приводится к полному. Без этого восстановление создало бы
 * копию под «новым» id.
 */
export function canonicalRestoreId(sessionId) {
  return normalizeSessionId(sessionId)
}

/** Сопоставить канонические id и ключи надгробий (записи могли писаться иначе). */
export function resolveTombstoneIds({ tombstones, ids = [], all = false }) {
  const entries = tombstones?.sessions ?? {}
  const byCanonical = new Map()
  for (const [storedId, entry] of Object.entries(entries)) {
    if (entry === null || typeof entry !== 'object') continue
    byCanonical.set(normalizeSessionId(storedId), { storedId, entry })
  }
  const requested = all
    ? [...byCanonical.values()]
        .filter(({ entry }) => isActiveTombstone(entry))
        .map(({ storedId }) => storedId)
    : ids
  const canonical = []
  const stored = []
  const missing = []
  for (const id of requested) {
    const key = normalizeSessionId(id)
    if (key === '') continue
    const hit = byCanonical.get(key)
    if (hit === undefined) {
      missing.push(key)
      continue
    }
    if (!canonical.includes(key)) canonical.push(key)
    if (!stored.includes(hit.storedId)) stored.push(hit.storedId)
  }
  return { canonical, stored, missing }
}

/** Каталог карантина проигравшей копии: рядом с обычным, но с меткой. */
export function supersededQuarantineDir(repoDir, projectId, sessionId, now = Date.now()) {
  const stamp = new Date(Number.isFinite(now) ? now : Date.now()).toISOString().replace(/[:.]/g, '-')
  return join(repoDir, 'sessions', projectId, QUARANTINE_DIR, `${encodeSegment(sessionId)}${SUPERSEDED_TAG}${stamp}`)
}

/**
 * Проект, в карантине которого лежит сессия: для записей надгробий без
 * `projectId` и для восстановления по короткому id.
 */
export function findQuarantineProject(repoDir, sessionId) {
  const id = canonicalRestoreId(sessionId)
  if (repoDir === '' || id === '') return ''
  try {
    for (const entry of readdirSync(join(repoDir, 'sessions'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(repoDir, 'sessions', entry.name, QUARANTINE_DIR, encodeSegment(id), LOG_NAME))) {
        return entry.name
      }
    }
  } catch {
    return ''
  }
  return ''
}

/** Найти карантин проигравшей копии, если он уже есть. */
export function findSupersededQuarantine(repoDir, projectId, sessionId) {
  const root = join(repoDir, 'sessions', projectId, QUARANTINE_DIR)
  try {
    const prefix = `${encodeSegment(sessionId)}${SUPERSEDED_TAG}`
    let found
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(prefix)) continue
      found = join(root, entry.name)
    }
    return found
  } catch {
    return undefined
  }
}

/**
 * Живая копия в зеркале конфликтует с карантинной (восстанавливаемой) копией:
 * переносим живую в карантин с причиной `superseded`, чтобы восстановление
 * вернуло именно удалённую версию, а ничего не потерялось.
 *
 * Ничего не делает, если живой копии нет, карантина нет или содержимое логов
 * совпадает (это та же копия — перезаписывать нечего).
 *
 * @returns {{ superseded: boolean, code: string, dir?: string }}
 */
export async function quarantineSupersededCopy({
  repoDir,
  projectId,
  sessionId,
  deviceId = 'device',
  now = Date.now(),
} = {}) {
  if (typeof repoDir !== 'string' || repoDir === '' || typeof projectId !== 'string' || projectId === '') {
    return { superseded: false, code: 'no-project' }
  }
  const id = canonicalRestoreId(sessionId)
  const liveDir = join(repoDir, 'sessions', projectId, encodeSegment(id))
  if (!existsSync(join(liveDir, LOG_NAME))) return { superseded: false, code: 'no-live-copy' }
  const quarantine = quarantinePath(repoDir, projectId, id)
  if (!existsSync(join(quarantine, LOG_NAME))) return { superseded: false, code: 'no-quarantine-copy' }

  let same = false
  try {
    const liveBytes = await readFile(join(liveDir, LOG_NAME))
    const quarantineBytes = await readFile(join(quarantine, LOG_NAME))
    same = splitLog(liveBytes).tail.equals(splitLog(quarantineBytes).tail)
  } catch {
    same = false
  }
  if (same) return { superseded: false, code: 'same-copy' }

  const target = supersededQuarantineDir(repoDir, projectId, id, now)
  try {
    await mkdir(dirname(target), { recursive: true })
    await rename(liveDir, target)
    await writeFile(
      join(target, 'deleted-at.json'),
      `${JSON.stringify({
        at: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
        reason: SUPERSEDED_REASON,
        by: 'sync',
        device: deviceId,
        keptFor: 'restore',
      }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    return { superseded: false, code: 'rename-failed' }
  }
  return { superseded: true, code: SUPERSEDED_REASON, dir: target }
}

/**
 * Причина, по которой пометка удаления была снята: для журнала восстановлений
 * нужен `restoredFrom` (manual/prune/expired/replaced/children…).
 */
export function restoredFromOf(tombstones, sessionId) {
  const key = normalizeSessionId(sessionId)
  const entries = tombstones?.sessions ?? {}
  for (const [storedId, entry] of Object.entries(entries)) {
    if (normalizeSessionId(storedId) !== key) continue
    const from = typeof entry?.restoredFrom === 'string' ? entry.restoredFrom : entry?.reason
    return typeof from === 'string' ? from : ''
  }
  return ''
}
