/**
 * Группы сессий «родитель + субагенты».
 *
 * В заголовке лога субагент ссылается на родителя (`parentSession`), поэтому
 * связь восстанавливается по одним заголовкам — без чтения событий. Группа —
 * единица обмена: родитель и его дети уезжают и приезжают вместе, а удаление
 * родителя не оставляет в зеркале сирот.
 *
 * Модуль чистый (без файлового доступа): те же функции используют движок
 * синхронизации, каталог зеркала и режимы «локальная/облачная».
 */

/** Максимальная глубина цепочки родителей: защита от битых/циклических ссылок. */
export const MAX_GROUP_DEPTH = 32
/** Максимальное число потомков одной сессии: защита от «дерева-монстра». */
export const MAX_GROUP_SIZE = 500

/**
 * Родитель из заголовка сессии. Пустая строка — корень группы.
 * Ссылка на саму себя родителем не считается.
 */
export function parentOfHeader(header) {
  const parent = typeof header?.parentSession === 'string' ? header.parentSession.trim() : ''
  if (parent === '') return ''
  if (typeof header?.id === 'string' && parent === header.id) return ''
  return parent
}

/**
 * Построить связи по заголовкам сессий.
 * @param {Array<{id?: string, header?: object}>} entries заголовки (или записи с header)
 * @returns {{ parentById: Map<string, string>, childrenByParent: Map<string, string[]> }}
 */
export function buildSessionGroups(entries = []) {
  const parentById = new Map()
  const childrenByParent = new Map()
  for (const entry of entries ?? []) {
    const header = entry?.header
    const id = typeof entry?.id === 'string' && entry.id !== ''
      ? entry.id
      : typeof header?.id === 'string' ? header.id : ''
    if (id === '') continue
    const parent = parentOfHeader(header)
    if (parent === '') continue
    // Первый заголовок главнее: лог мог быть прочитан дважды (зеркало и стор).
    if (parentById.has(id)) continue
    parentById.set(id, parent)
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
    const children = childrenByParent.get(parent)
    if (!children.includes(id)) children.push(id)
  }
  for (const children of childrenByParent.values()) children.sort()
  return { parentById, childrenByParent }
}

/**
 * Все потомки сессии (дети, внуки и т. д.) в порядке обхода.
 * Циклы и самоссылки отсекаются, глубина и размер ограничены.
 */
export function descendantsOf(childrenByParent, sessionId) {
  const result = []
  const seen = new Set([sessionId])
  const queue = [sessionId]
  while (queue.length > 0 && result.length < MAX_GROUP_SIZE) {
    const current = queue.shift()
    for (const child of childrenByParent?.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      result.push(child)
      queue.push(child)
      if (result.length >= MAX_GROUP_SIZE) break
    }
  }
  return result
}

/**
 * Корень группы: верхний родитель сессии (сама сессия, если родителя нет).
 * Используется, чтобы собрать группу при импорте/удалении с любой стороны.
 */
export function rootOf(parentById, sessionId) {
  let current = sessionId
  const seen = new Set([current])
  for (let depth = 0; depth < MAX_GROUP_DEPTH; depth++) {
    const parent = parentById?.get(current)
    if (parent === undefined || parent === '' || seen.has(parent)) break
    seen.add(parent)
    current = parent
  }
  return current
}

/** Глубина сессии в дереве: 0 — родитель, 1 — субагент первого уровня. */
export function depthOf(parentById, sessionId) {
  let depth = 0
  let current = sessionId
  const seen = new Set([current])
  while (depth < MAX_GROUP_DEPTH) {
    const parent = parentById?.get(current)
    if (parent === undefined || parent === '' || seen.has(parent)) break
    seen.add(parent)
    current = parent
    depth += 1
  }
  return depth
}

/**
 * Разложить сессии так, чтобы родители шли раньше детей: иначе ребёнок может
 * приехать и «потеряться» раньше, чем станет известен его родитель.
 * Порядок внутри одного уровня — по createdAt, затем по id (стабильный).
 */
export function orderParentsFirst(entries = [], groups = {}) {
  const parentById = groups?.parentById ?? new Map()
  return [...(entries ?? [])]
    .map((entry, index) => ({ entry, index, depth: depthOf(parentById, entry?.id) }))
    .sort((left, right) => left.depth - right.depth
      || String(left.entry?.createdAt ?? '').localeCompare(String(right.entry?.createdAt ?? ''))
      || String(left.entry?.id ?? '').localeCompare(String(right.entry?.id ?? ''))
      || left.index - right.index)
    .map(item => item.entry)
}

/**
 * Единица обмена: сессия и все её потомки.
 * @returns {{ id: string, descendants: string[] }}
 */
export function groupOf(childrenByParent, sessionId) {
  return { id: sessionId, descendants: descendantsOf(childrenByParent, sessionId) }
}

/** Сессия — субагент (у неё есть родитель). */
export function isSubagent(parentById, sessionId) {
  const parent = parentById?.get(sessionId)
  return typeof parent === 'string' && parent !== ''
}
