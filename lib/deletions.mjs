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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { encodeSegment, projectKey } from './format.mjs'
import { isActiveTombstone } from './tombstones.mjs'
import { depthOf, descendantsOf } from './session-groups.mjs'
import { normalizeSessionId } from './session-modes.mjs'

/** Больше этого числа удалений за прогон — повод показать предупреждение. */
export const PRUNE_MAX_COUNT = 5
/** Больше этой доли известных сессий за прогон — повод показать предупреждение. */
export const PRUNE_MAX_RATIO = 0.2
/** Код причины удаления для субагента, ушедшего вместе с родителем. */
export const CHILDREN_REASON = 'children'

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
