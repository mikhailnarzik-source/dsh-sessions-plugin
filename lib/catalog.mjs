/**
 * «Каталог» зеркала: делает резервную копию понятной человеку.
 *
 * Рядом с каждым логом кладётся `session.json` (название, даты, размер,
 * вложения), в папке проекта — `index.md` со списком сессий, в корне зеркала —
 * `README.md` с описанием структуры и инструкцией по восстановлению вручную.
 * Всё это обычные текстовые файлы, движок их не читает и не ломается от них.
 *
 * Идентичность сессии (M1) живёт здесь же: `contentHash` — sha256
 * нормализованного лога (id→ID, cwd→CWD, порядок кадров сохраняется), по нему
 * находится копия той же сессии с другим id; `lineageKey` — sha1 от
 * createdAt + нормализованного названия + проекта, по нему видно, что две
 * копии — одна и та же линия, а не два независимых пустых диалога.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalCwd } from './config.mjs'
import { normalizePath, readHeader } from './format.mjs'
import { decodeFrame, frameSlices } from './frames.mjs'
import { rootOf } from './session-groups.mjs'

const LOG_NAME = 'session.v4.jsonl.zstd'
const SIDECAR_NAME = 'session.json'

/** Подстановки нормализации лога: свой id и свой абсолютный cwd. */
export const ID_PLACEHOLDER = 'ID'
export const CWD_PLACEHOLDER = 'CWD'
/** Поля идентичности, которые пишутся в `session.json`. */
export const IDENTITY_FIELDS = ['contentHash', 'lineageKey']
/** Допуск «±1%» для поиска дублей по паре events+bytes. */
export const DUPLICATE_SIZE_TOLERANCE = 0.01
/** Идентификатор сессии DSH: `session-` + UUID. */
const SESSION_ID_PATTERN = /session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g

/** ISO-время из числа (эпоха мс) или строки; '' — времени нет. */
function isoOf(value) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value.trim()
  }
  return ''
}

/** Строка в том виде, в каком она лежит внутри JSON-текста лога. */
function jsonEscaped(value) {
  return JSON.stringify(String(value)).slice(1, -1)
}

/** Варианты записи пути: обратные и прямые слэши, со слэшем на конце. */
function pathVariants(cwd) {
  const raw = typeof cwd === 'string' ? cwd : ''
  if (raw === '') return []
  const variants = [raw]
  const slashed = raw.replace(/\\/g, '/')
  if (slashed !== raw) variants.push(slashed)
  const backed = slashed.replace(/\//g, '\\')
  if (backed !== raw) variants.push(backed)
  const trimmed = raw.replace(/[\\/]+$/, '')
  if (trimmed !== '' && trimmed !== raw) variants.push(trimmed)
  return [...new Set(variants)]
}

/**
 * Пары «заменить → на что» для нормализации текста лога. Длинные варианты
 * идут первыми, чтобы экранированный путь не остался наполовину заменённым.
 */
function replacementPairs(id, cwd) {
  const pairs = []
  const seen = new Set()
  const add = (from, to) => {
    if (typeof from !== 'string' || from === '' || seen.has(from)) return
    seen.add(from)
    pairs.push([from, to])
  }
  for (const variant of pathVariants(cwd)) {
    add(jsonEscaped(variant), CWD_PLACEHOLDER)
    add(variant, CWD_PLACEHOLDER)
  }
  add(jsonEscaped(id), ID_PLACEHOLDER)
  add(id, ID_PLACEHOLDER)
  return pairs.sort((left, right) => right[0].length - left[0].length)
}

function normalizeText(text, pairs) {
  let result = text
  for (const [from, to] of pairs) {
    if (result.includes(from)) result = result.split(from).join(to)
  }
  return result
}

/**
 * Заменить любые идентификаторы сессий на ID. Это симметрично для копий:
 * копия, у которой `repairLog` переписал `sessionId` в событиях, и оригинал
 * дают один и тот же текст. Чужие id (родитель субагента) тоже заменяются —
 * для обеих копий одинаково.
 */
function normalizeSessionIds(text) {
  return text.replace(SESSION_ID_PATTERN, ID_PLACEHOLDER)
}

/** Заголовок: id→ID (включая нестандартный id), cwd→CWD. */
function normalizeHeaderText(text, pairs) {
  return normalizeSessionIds(normalizeText(text, pairs))
}

/** Время события (мс): `time`/`at` события или его `data`. */
function eventTime(event) {
  for (const value of [event?.time, event?.at, event?.data?.time, event?.data?.at]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const ms = Date.parse(value)
      if (Number.isFinite(ms)) return ms
    }
  }
  return undefined
}

/**
 * Кусочки лога по порядку кадров: первый — заголовок, остальные — события.
 * Несжатый JSONL разбивается по первой строке. Битые кадры пропускаются.
 */
function logChunks(bytes) {
  const chunks = []
  for (const [start, end] of frameSlices(bytes)) {
    try {
      chunks.push({ text: decodeFrame(bytes, start, end), header: chunks.length === 0 })
    } catch {
      // битый кадр пропускаем: остальные всё равно читаются
    }
  }
  if (chunks.length === 0 && bytes.length > 0) {
    const text = bytes.toString('utf8')
    const newline = text.indexOf('\n')
    if (newline < 0) return [{ text, header: true }]
    return [{ text: text.slice(0, newline), header: true }, { text: text.slice(newline), header: false }]
  }
  return chunks
}

/**
 * Разобрать лог один раз: нормализованный текст (для хеша), число событий,
 * последнее время события, заголовок и название из первого сообщения.
 *
 * Нормализуется заголовок (id→ID, cwd→CWD) и любые id сессий в событиях;
 * остальное содержимое — как есть. У копий одинаковый хвост, поэтому хеш
 * совпадает независимо от пути устройства и от того, переписан ли id.
 */
function analyzeLog(bytes, options = {}) {
  const parsed = readHeader(bytes)
  const header = parsed?.header
  const id = typeof options.id === 'string' ? options.id : (typeof header?.id === 'string' ? header.id : '')
  const cwd = typeof options.cwd === 'string' ? options.cwd : (typeof header?.cwd === 'string' ? header.cwd : '')
  const pairs = replacementPairs(id, cwd)
  const normalizedParts = []
  let first
  let events = 0
  let lastEventAt
  let title = ''
  for (const chunk of logChunks(bytes)) {
    normalizedParts.push(chunk.header ? normalizeHeaderText(chunk.text, pairs) : normalizeSessionIds(chunk.text))
    for (const line of chunk.text.split('\n')) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (first === undefined) {
        first = event
        continue
      }
      events += 1
      const time = eventTime(event)
      if (time !== undefined && (lastEventAt === undefined || time > lastEventAt)) lastEventAt = time
      if (title === '' && event?.type === 'user/message') {
        const value = messageText(event)
        if (typeof value === 'string' && value.trim() !== '' && !isServiceText(value)) {
          title = value.trim().replace(/\s+/g, ' ').slice(0, 80)
        }
      }
    }
  }
  if (first === undefined) first = header
  if (lastEventAt === undefined && typeof first?.createdAt === 'number') lastEventAt = first.createdAt
  return {
    header: first,
    id,
    cwd,
    title,
    events,
    lastEventAt,
    normalized: normalizedParts.join(''),
  }
}

/** sha256 нормализованного лога: копии с разными id/путями дают один хеш. */
function hashOf(normalized) {
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/** Название для lineageKey: без регистра, лишних пробелов и краёв. */
export function normalizeTitleForIdentity(title) {
  return String(title ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * contentHash лога: sha256 нормализованного потока (id→ID, cwd→CWD).
 * `options.id`/`options.cwd` нужны, если заголовок не читается.
 */
export function computeContentHash(bytes, options = {}) {
  const analysis = analyzeLog(bytes, options)
  return hashOf(analysis.normalized)
}

/**
 * lineageKey: одна линия «создана тогда-то, с таким названием, в таком
 * проекте». Копии (даже с разными id) совпадают, независимые диалоги — нет.
 */
export function computeLineageKey({ createdAt, title, cwd, projectId } = {}) {
  const base = typeof projectId === 'string' && projectId !== ''
    ? canonicalCwd(projectId)
    : normalizePath(typeof cwd === 'string' && cwd !== '' ? cwd : '/')
  const seed = `${isoOf(createdAt)}\u0000${normalizeTitleForIdentity(title)}\u0000${base}`
  return createHash('sha1').update(seed, 'utf8').digest('hex')
}

/** Идентичность из уже разобранного лога (без повторного разбора). */
function identityFromAnalysis(analysis, { projectId, title, sizeBytes, createdAt } = {}) {
  const titleValue = title !== undefined ? title : analysis.title
  const created = createdAt ?? analysis.header?.createdAt
  return {
    id: analysis.id,
    contentHash: hashOf(analysis.normalized),
    lineageKey: computeLineageKey({ createdAt: created, title: titleValue, cwd: analysis.cwd, projectId }),
    title: typeof titleValue === 'string' ? titleValue : '',
    createdAt: isoOf(created),
    events: analysis.events,
    lastEventAt: analysis.lastEventAt,
    sizeBytes,
  }
}

/** Идентичность сессии по её логу. */
export function computeSessionIdentity({ bytes, projectId, title, id, cwd, createdAt } = {}) {
  if (bytes === undefined || bytes === null || typeof bytes.length !== 'number') {
    throw new TypeError('computeSessionIdentity: нужны байты лога')
  }
  const analysis = analyzeLog(bytes, { id, cwd })
  return identityFromAnalysis(analysis, { projectId, title, sizeBytes: bytes.length, createdAt })
}

/** Есть ли в `session.json` уже посчитанная идентичность. */
export function hasSessionIdentity(sidecar) {
  const contentOk = typeof sidecar?.contentHash === 'string' && /^[0-9a-f]{64}$/.test(sidecar.contentHash)
  const lineageOk = typeof sidecar?.lineageKey === 'string' && /^[0-9a-f]{40}$/.test(sidecar.lineageKey)
  return contentOk && lineageOk
}

/** Индекс идентичностей: contentHash и lineageKey → записи с id. */
export function identityIndexOf(entries = []) {
  const byContentHash = new Map()
  const byLineageKey = new Map()
  const push = (map, key, entry) => {
    if (key === '') return
    if (!map.has(key)) map.set(key, [])
    const list = map.get(key)
    if (!list.some(item => item.id === entry.id)) list.push(entry)
  }
  for (const item of entries ?? []) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.id !== 'string' || item.id === '') continue
    const entry = { id: item.id, contentHash: item.contentHash ?? '', lineageKey: item.lineageKey ?? '', entry: item }
    push(byContentHash, entry.contentHash, entry)
    push(byLineageKey, entry.lineageKey, entry)
  }
  return { byContentHash, byLineageKey }
}

/**
 * Копия той же сессии с другим id.
 *
 * Сначала ищется совпадение по lineageKey — это надёжно: две независимые
 * сессии с одинаковым содержимым (например, пустые) не схлопнутся. Если
 * lineageKey у кого-то нет, остаётся contentHash — как просит дедупликация.
 */
export function findDuplicate(index, { contentHash, lineageKey, id } = {}) {
  const selfId = typeof id === 'string' ? id : ''
  if (typeof lineageKey === 'string' && lineageKey !== '') {
    const hit = (index?.byLineageKey?.get(lineageKey) ?? []).find(item => item.id !== selfId)
    if (hit !== undefined) return { id: hit.id, match: 'lineageKey', lineageKey, contentHash: hit.contentHash }
  }
  if (typeof contentHash === 'string' && contentHash !== '') {
    const hit = (index?.byContentHash?.get(contentHash) ?? []).find(item => item.id !== selfId)
    if (hit !== undefined) return { id: hit.id, match: 'contentHash', lineageKey: hit.lineageKey, contentHash }
  }
  return undefined
}

/** Только совпадение содержимого (без lineageKey): копия с другим id. */
export function findContentDuplicate(index, { contentHash, id } = {}) {
  if (typeof contentHash !== 'string' || contentHash === '') return undefined
  const selfId = typeof id === 'string' ? id : ''
  const hit = (index?.byContentHash?.get(contentHash) ?? []).find(item => item.id !== selfId)
  return hit === undefined ? undefined : { id: hit.id, match: 'contentHash', contentHash, lineageKey: hit.lineageKey }
}

/**
 * Решение при импорте/pull: если локально уже есть копия этой сессии (другой
 * id), новую не создаём — в журнале это причина `duplicate`.
 *
 * @param {object} options
 * @param {{byContentHash: Map, byLineageKey: Map}} options.index индекс идентичностей локальных сессий
 * @param {{contentHash?: string, lineageKey?: string, id?: string}} options.identity идентичность приезжающей сессии
 * @returns {{ action: 'skip'|'import', reason: 'duplicate'|'', duplicateId?: string, match?: string }}
 */
export function importDecision({ index, identity } = {}) {
  if (index === undefined || index === null || identity === undefined || identity === null) {
    return { action: 'import', reason: '' }
  }
  const duplicate = findDuplicate(index, {
    contentHash: identity.contentHash,
    lineageKey: identity.lineageKey,
    id: identity.id,
  })
  if (duplicate === undefined) return { action: 'import', reason: '' }
  return { action: 'skip', reason: 'duplicate', duplicateId: duplicate.id, match: duplicate.match }
}

/**
 * Найти локальную копию приезжающей сессии прямо по логам (для pull/импорта).
 *
 * Сначала дешёвый предфильтр (число кадров и размер ±5%), и только похожие
 * локальные сессии разбираются целиком. Так импорт не хеширует весь стор.
 *
 * @param {object} options
 * @param {Array<{id: string, bytes?: Buffer}>} [options.sessions] локальные сессии проекта
 * @param {Buffer} [options.bytes] лог приезжающей сессии
 * @param {object} [options.identity] уже посчитанная идентичность приезжающей
 * @param {string} [options.projectId]
 * @param {string} [options.id] id приезжающей сессии (чтобы не найти себя)
 * @returns {{ id: string, match: string, contentHash?: string, lineageKey?: string } | undefined}
 */
export function findDuplicateAmongLogs({ sessions = [], bytes, identity, projectId, id } = {}) {
  let target = identity
  if ((target === undefined || target === null) && bytes !== undefined && bytes !== null) {
    target = computeSessionIdentity({ bytes, projectId })
  }
  if (target === undefined || target === null) return undefined
  const targetBytes = bytes ?? undefined
  const targetFrames = targetBytes !== undefined ? frameSlices(targetBytes).length : undefined
  const targetSize = Number(target.sizeBytes ?? targetBytes?.length ?? 0) || 0
  const candidates = []
  for (const session of sessions ?? []) {
    if (session === null || typeof session !== 'object') continue
    if (typeof session.id !== 'string' || session.id === '') continue
    if (id !== undefined && session.id === id) continue
    const sessionBytes = session.bytes
    // Дешёвый отпечаток: у копии то же число кадров и близкий размер.
    if (targetFrames !== undefined && sessionBytes !== undefined && sessionBytes !== null) {
      if (frameSlices(sessionBytes).length !== targetFrames) continue
      const size = Number(session.size ?? sessionBytes.length) || 0
      const biggest = Math.max(size, targetSize)
      if (Math.abs(size - targetSize) > Math.max(64, biggest * 0.05)) continue
    }
    if (sessionBytes !== undefined && sessionBytes !== null) {
      try {
        candidates.push({ id: session.id, ...computeSessionIdentity({ bytes: sessionBytes, projectId, title: session.title }) })
        continue
      } catch {
        // битый лог — сравним только по готовым полям
      }
    }
    if (typeof session.contentHash === 'string' && session.contentHash !== '') {
      candidates.push({ id: session.id, contentHash: session.contentHash, lineageKey: session.lineageKey ?? '' })
    }
  }
  if (candidates.length === 0) return undefined
  return findDuplicate(identityIndexOf(candidates), target)
}

/** Размер кандидата в байтах: принимаем bytes/sizeBytes/size. */
function candidateSize(candidate) {
  return Number(candidate?.sizeBytes ?? candidate?.bytes ?? candidate?.size ?? 0) || 0
}

/** Число событий: из идентичности или из sidecar. */
function candidateEvents(candidate) {
  return Number(candidate?.events ?? candidate?.eventCount ?? 0) || 0
}

/** Заголовок лога без полного разбора — для дешёвого предфильтра. */
function cheapFingerprint(candidate) {
  const bytes = candidate?.bytes
  if (bytes === undefined || bytes === null || typeof bytes.length !== 'number') return undefined
  return frameSlices(bytes).length
}

/**
 * Найти группы дублей среди сессий (только чтение).
 *
 * Кандидат: `{ id, bytes?, contentHash?, lineageKey?, events?, sizeBytes?, side? }`.
 * - Сильное совпадение — одинаковый contentHash **и** lineageKey (копии с
 *   разными id, у которых совпали и содержимое, и линия). Так не схлопываются
 *   две независимые сессии с одинаковым (например, пустым) содержимым.
 * - Слабое — одинаковое число событий и размер в пределах ±1%: только когда
 *   лога нет и хеш посчитать нечем (одни старые `session.json`). Ложных пар
 *   с доступным логом метод не даёт — там решает точный contentHash.
 *
 * Хеши считаются лениво: сперва дешёвый отпечаток (число кадров + размер
 * ±5%), и только для групп из двух и более кандидатов лог разбирается целиком.
 *
 * @returns {Array<{ match: 'contentHash'|'events+bytes', contentHash?: string,
 *   lineageKey?: string, events?: number, sizeBytes: number, sessions: object[] }>}
 */
export function duplicateGroups(candidates = [], options = {}) {
  const tolerance = Number.isFinite(options.sizeTolerance) && options.sizeTolerance > 0
    ? Number(options.sizeTolerance)
    : DUPLICATE_SIZE_TOLERANCE
  // 1. Один id — одна сессия: локальная и зеркальная копия одного id не дубль.
  const byId = new Map()
  for (const item of candidates ?? []) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.id !== 'string' || item.id === '') continue
    const existing = byId.get(item.id)
    if (existing === undefined) {
      byId.set(item.id, { ...item, sides: item.side !== undefined ? [item.side] : [] })
      continue
    }
    if (item.side !== undefined && !existing.sides.includes(item.side)) existing.sides.push(item.side)
    if (existing.bytes === undefined && item.bytes !== undefined) existing.bytes = item.bytes
    if (existing.contentHash === undefined && item.contentHash !== undefined) existing.contentHash = item.contentHash
    if (existing.lineageKey === undefined && item.lineageKey !== undefined) existing.lineageKey = item.lineageKey
  }
  const list = [...byId.values()]
  const groups = []

  // 2. contentHash: сначала дешёвый предфильтр, чтобы не разбирать весь лог.
  const solved = new Map() // id → { contentHash, lineageKey, events, lastEventAt, createdAt }
  const hashReady = []
  const hashMissing = []
  for (const item of list) {
    if (typeof item.contentHash === 'string' && item.contentHash !== '') {
      solved.set(item.id, {
        contentHash: item.contentHash,
        lineageKey: typeof item.lineageKey === 'string' ? item.lineageKey : '',
        events: candidateEvents(item),
        lastEventAt: item.lastEventAt,
        createdAt: item.createdAt,
      })
      hashReady.push(item)
      continue
    }
    hashMissing.push(item)
  }
  // Дешёвый предфильтр: копии дают одинаковое число кадров и близкий размер.
  const buckets = new Map()
  for (const item of hashMissing) {
    const frames = cheapFingerprint(item)
    if (frames === undefined) continue
    if (!buckets.has(frames)) buckets.set(frames, [])
    buckets.get(frames).push(item)
  }
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const sizeLeft = candidateSize(bucket[left])
        const sizeRight = candidateSize(bucket[right])
        const biggest = Math.max(sizeLeft, sizeRight)
        const close = Math.abs(sizeLeft - sizeRight) <= Math.max(64, biggest * 0.05)
        if (!close) continue
        for (const item of [bucket[left], bucket[right]]) {
          if (solved.has(item.id)) continue
          try {
            const identity = computeSessionIdentity({
              bytes: item.bytes,
              projectId: options.projectId,
              title: item.title,
              createdAt: item.createdAt,
            })
            solved.set(item.id, {
              contentHash: identity.contentHash,
              lineageKey: identity.lineageKey,
              events: identity.events,
              lastEventAt: identity.lastEventAt,
              createdAt: identity.createdAt,
            })
          } catch {
            // лог не читается — останется кандидатом слабого совпадения
          }
        }
      }
    }
  }
  for (const item of hashReady) {
    const known = solved.get(item.id)
    if (known === undefined) continue
    if ((known.lineageKey ?? '') === '' && typeof item.lineageKey === 'string') known.lineageKey = item.lineageKey
  }

  // 3. Группы по contentHash + lineageKey (копии одной линии).
  const strongBuckets = new Map()
  const placed = new Set()
  for (const item of list) {
    const known = solved.get(item.id)
    if (known === undefined || known.contentHash === '') continue
    const key = `${known.contentHash}:${known.lineageKey ?? ''}`
    if (!strongBuckets.has(key)) strongBuckets.set(key, [])
    strongBuckets.get(key).push({ item, known })
  }
  for (const bucket of strongBuckets.values()) {
    if (bucket.length < 2) continue
    for (const { item } of bucket) placed.add(item.id)
    groups.push({
      match: 'contentHash',
      contentHash: bucket[0].known.contentHash,
      lineageKey: bucket[0].known.lineageKey ?? '',
      sizeBytes: bucket.reduce((total, { item }) => total + candidateSize(item), 0),
      sessions: bucket.map(({ item, known }) => ({
        id: item.id,
        side: item.side,
        sides: item.sides,
        sizeBytes: candidateSize(item),
        events: known.events,
        lastEventAt: known.lastEventAt,
        createdAt: known.createdAt ?? item.createdAt,
        contentHash: known.contentHash,
        lineageKey: known.lineageKey ?? '',
      })),
    })
  }

  // 4. Слабое совпадение: одинаковое число событий и размер ±1% (старые
  //    зеркала без contentHash). Только для тех, у кого хеш не посчитался:
  //    если лог есть, точный contentHash решает сам и ложных пар не даёт.
  const weakBuckets = new Map()
  for (const item of list) {
    if (placed.has(item.id)) continue
    if (solved.has(item.id)) continue
    if (item.bytes !== undefined && item.bytes !== null && typeof item.bytes.length === 'number') continue
    const events = candidateEvents(item)
    if (events < 1) continue
    const key = String(events)
    if (!weakBuckets.has(key)) weakBuckets.set(key, [])
    weakBuckets.get(key).push({ item, events, sizeBytes: candidateSize(item) })
  }
  for (const bucket of weakBuckets.values()) {
    if (bucket.length < 2) continue
    bucket.sort((left, right) => left.sizeBytes - right.sizeBytes || (left.item.id < right.item.id ? -1 : 1))
    let cluster = [bucket[0]]
    const flush = () => {
      if (cluster.length < 2) return
      groups.push({
        match: 'events+bytes',
        events: cluster[0].events,
        sizeBytes: cluster.reduce((total, entry) => total + entry.sizeBytes, 0),
        sessions: cluster.map(entry => ({
          id: entry.item.id,
          side: entry.item.side,
          sides: entry.item.sides,
          sizeBytes: entry.sizeBytes,
          events: entry.events,
          lastEventAt: entry.item.lastEventAt,
          createdAt: entry.item.createdAt,
        })),
      })
    }
    for (let index = 1; index < bucket.length; index += 1) {
      const previous = cluster[cluster.length - 1]
      const current = bucket[index]
      const biggest = Math.max(previous.sizeBytes, current.sizeBytes)
      const close = Math.abs(previous.sizeBytes - current.sizeBytes) <= Math.max(1, biggest * tolerance)
      if (close) {
        cluster.push(current)
        continue
      }
      flush()
      cluster = [current]
    }
    flush()
  }
  return groups.sort((left, right) => {
    const leftId = left.sessions[0]?.id ?? ''
    const rightId = right.sessions[0]?.id ?? ''
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
  })
}

/**
 * Прочитать `session.json` рядом с логом и лениво достроить идентичность,
 * если её там ещё нет (старое зеркало). Лог не перезаписывается: хеш только
 * возвращается вызывающему.
 *
 * @returns {Promise<{ sidecar?: object, identity?: object, migrated: boolean, sidecarPath: string }>}
 */
export async function readSessionSidecar(sessionDir, options = {}) {
  const sidecarPath = join(sessionDir, SIDECAR_NAME)
  let sidecar
  try {
    const parsed = JSON.parse(await readFile(sidecarPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) sidecar = parsed
  } catch {
    sidecar = undefined
  }
  if (sidecar === undefined) return { sidecar: undefined, identity: undefined, migrated: false, sidecarPath }
  if (hasSessionIdentity(sidecar)) {
    return {
      sidecar,
      identity: {
        id: sidecar.id,
        contentHash: sidecar.contentHash,
        lineageKey: sidecar.lineageKey,
        title: sidecar.title ?? '',
        createdAt: sidecar.createdAt ?? '',
        events: sidecar.events,
        lastEventAt: sidecar.lastEventAt,
        sizeBytes: sidecar.sizeBytes,
      },
      migrated: false,
      sidecarPath,
    }
  }
  try {
    const bytes = await readFile(join(sessionDir, options.logName ?? LOG_NAME))
    const identity = computeSessionIdentity({
      bytes,
      projectId: options.projectId,
      title: sidecar.title,
      id: sidecar.id,
      createdAt: sidecar.createdAt,
    })
    return { sidecar, identity, migrated: true, sidecarPath }
  } catch {
    return { sidecar, identity: undefined, migrated: false, sidecarPath }
  }
}

const README_LINES = [
  '# Резервная копия сессий DeepSeek Harness',
  '',
  'Эта папка — копия истории работы. Её можно читать и восстанавливать вручную,',
  'без плагина.',
  '',
  '## Что где лежит',
  '',
  '```',
  'sessions/<проект>/<session-идентификатор>/session.v4.jsonl.zstd   сам лог сессии',
  'sessions/<проект>/<session-идентификатор>/session.json            описание сессии',
  'sessions/<проект>/index.md                                        список сессий проекта',
  'sessions/<проект>/_deleted/<session-идентификатор>/               карантин удалённых (30 дней)',
  'attachments/objects/<xx>/<sha256>                                  файлы и картинки из чата',
  'attachments/README.md                                              какие файлы к каким сессиям',
  'projects.json                                                      проекты и пути на устройствах',
  'workspace.json                                                     рабочие пространства и сессии в них',
  'profile/cordis.patch.yml                                          тема, язык, шрифт, MCP (без путей)',
  'profile/bundles.json                                               включённые плагины профиля',
  'profile/settings/<плагин>.json                                    настройки плагинов по белому списку',
  'profile/conflicts.json                                             журнал конфликтов настройек',
  'tombstones.json                                                    какие сессии удалены, когда, кем и почему',
  '```',
  '',
  '- **Папка проекта** (например `sessions/harness`) — это один проект (рабочая',
  '  папка). Название — идентификатор из настроек плагина; человеческое название',
  '  и пути указаны в `projects.json`.',
  '- **Папка сессии** — один диалог. Внутри два файла: сам лог и `session.json`',
  '  с названием, датой, размером и списком вложений.',
  '- **Идентичность сессии** — в `session.json` поля `contentHash` (sha256',
  '  нормализованного лога: id заменён на ID, путь на CWD) и `lineageKey`',
  '  (дата создания + название + проект). По ним видно копии одной сессии',
  '  с разными id, даже если они лежат под разными именами.',
  '- **Связи субагентов** — в `session.json` каждой сессии есть `parent`',
  '  (родитель), `children` (дети) и `root` (верхний родитель). Группа',
  '  «родитель + субагенты» уезжает, восстанавливается и удаляется вместе.',
  '- **Лог** — двоичный поток zstd с JSON-событиями; так его пишет сам DSH.',
  '- **Файлы вложений** адресуются по содержимому (sha256), поэтому один и тот же',
  '  файл хранится один раз, сколько бы сессий его ни использовало.',
  '- **Профиль** — переносимая часть настроек DSH. Пути заменены на `${HOME}` и',
  '  `${DSH_HOME}`, секреты и машинные поля сюда не попадают.',
  '- **Рабочие пространства** — привязка сессий к папкам проекта. Глобальные',
  '  поля DSH (закреплённые, архив, пространство по умолчанию) не переносятся.',
  '',
  '## Как восстановить вручную',
  '',
  '1. Скопировать папку нужной сессии в каталог сессий DSH:',
  '   `%USERPROFILE%/.dsh/sessions/<папка-проекта>/`',
  '   (какая папка соответствует вашему проекту — видно в `projects.json`).',
  '2. Запустить DSH — сессия появится в списке.',
  '3. Вложения: скопировать содержимое `attachments/objects` в',
  '   `%USERPROFILE%/.dsh/attachments/v1/objects/`.',
  '',
  'Удалённая сессия лежит в `sessions/<проект>/_deleted/<id>/`. Чтобы вернуть её',
  'вручную: перенести папку обратно в `sessions/<проект>/<id>/`, удалить в ней',
  '`deleted-at.json` и убрать запись об этой сессии из `tombstones.json`',
  '(`reason` и `by` подскажут, когда, кем и почему она была удалена).',
  '',
  '## Как восстановить автоматически',
  '',
  'Установить плагин `dsh-sync` и указать этот репозиторий как зеркало — он',
  'привезёт сессии сам.',
  '',
]

const README = README_LINES.join('\n')

/** Текст пользовательского сообщения: content — массив блоков. */
function messageText(event) {
  const content = event.data?.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join(' ')
  }
  if (typeof event.data?.text === 'string') return event.data.text
  return ''
}

/** Служебные вставки не годятся в название. */
function isServiceText(text) {
  return /^(Current runtime context|<system-reminder>|Time sampled|A skill is a reusable|Browser time zone|Tokens prefixed)/.test(text.trim())
}

/** Все хеши вложений, на которые ссылается лог. */
function referencedHashes(bytes) {
  const found = new Set()
  for (const [start, end] of frameSlices(bytes)) {
    let text
    try {
      text = decodeFrame(bytes, start, end)
    } catch {
      continue
    }
    for (const match of text.matchAll(/sha256:([0-9a-f]{64})/g)) found.add(match[1])
  }
  return found
}

async function writeIfChanged(path, content) {
  try {
    const current = await readFile(path, 'utf8')
    if (current === content) return false
  } catch {
    // файла нет — пишем
  }
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
  return true
}

/**
 * Обновить человекочитаемое описание зеркала.
 * @param repoDir каталог зеркала
 * @param sessionsByProject Map(projectId → [{ id, changed? }])
 */
export async function writeCatalog(repoDir, sessionsByProject, options = {}) {
  await writeIfChanged(join(repoDir, 'README.md'), README)

  const attachmentIndex = new Map()
  let written = 0

  for (const [projectId, entries] of sessionsByProject) {
    const projectDir = join(repoDir, 'sessions', projectId)
    if (!existsSync(projectDir)) continue

    const rows = []
    for (const entry of entries) {
      const sessionDir = join(projectDir, entry.id)
      if (!existsSync(sessionDir)) continue
      const logPath = join(sessionDir, LOG_NAME)
      if (!existsSync(logPath)) continue
      const sidecarPath = join(sessionDir, SIDECAR_NAME)

      // Неизменившуюся сессию не разбираем заново: берём готовое описание.
      // Старое описание без contentHash/lineageKey (или без родителя) —
      // ленивая миграция: лог читаем один раз, поля достраиваем, сам лог не
      // переписываем — только `session.json` при следующей записи.
      if (entry.changed !== true && existsSync(sidecarPath)) {
        try {
          const saved = JSON.parse(await readFile(sidecarPath, 'utf8'))
          for (const item of saved.attachments ?? []) {
            if (!attachmentIndex.has(item.sha256)) attachmentIndex.set(item.sha256, [])
            attachmentIndex.get(item.sha256).push(entry.id)
          }
          const needsIdentity = !hasSessionIdentity(saved)
          const needsParent = typeof saved.parent !== 'string'
          if (!needsIdentity && !needsParent) {
            rows.push({
              ...saved,
              dir: entry.id,
              parent: saved.parent,
              sidecarPath,
              savedChildren: Array.isArray(saved.children) ? saved.children : undefined,
              savedRoot: typeof saved.root === 'string' ? saved.root : undefined,
            })
            continue
          }
          // Достраиваем идентичность (и родителя) по логу — без записи лога.
          const bytes = entry.bytes ?? await readFile(logPath)
          const analysis = analyzeLog(bytes)
          const title = entry.title
            ?? saved.title
            ?? (analysis.title === '' ? 'Без названия' : analysis.title)
          const identity = identityFromAnalysis(analysis, {
            projectId,
            title,
            sizeBytes: bytes.length,
            createdAt: saved.createdAt,
          })
          const parent = typeof saved.parent === 'string'
            ? saved.parent
            : (typeof analysis.header?.parentSession === 'string' ? analysis.header.parentSession : '')
          rows.push({
            ...saved,
            id: entry.id,
            title,
            contentHash: identity.contentHash,
            lineageKey: identity.lineageKey,
            lastEventAt: saved.lastEventAt ?? (identity.lastEventAt !== undefined ? isoOf(identity.lastEventAt) : ''),
            dir: entry.id,
            parent,
            sidecarPath,
            savedChildren: Array.isArray(saved.children) ? saved.children : undefined,
            savedRoot: typeof saved.root === 'string' ? saved.root : undefined,
            identityMigrated: true,
          })
          continue
        } catch {
          // битый sidecar перезапишем ниже
        }
      }

      const bytes = entry.bytes ?? await readFile(logPath)
      const analysis = analyzeLog(bytes)
      const info = {
        header: analysis.header,
        title: analysis.title === '' ? 'Без названия' : analysis.title,
        events: analysis.events,
      }
      const identity = identityFromAnalysis(analysis, {
        projectId,
        title: entry.title ?? info.title,
        sizeBytes: bytes.length,
      })
      const size = (await stat(logPath)).size
      const hashes = referencedHashes(bytes)
      for (const hash of hashes) {
        if (!attachmentIndex.has(hash)) attachmentIndex.set(hash, [])
        attachmentIndex.get(hash).push(entry.id)
      }

      const sidecar = {
        id: entry.id,
        title: entry.title ?? info.title,
        createdAt: identity.createdAt,
        events: identity.events,
        lastEventAt: identity.lastEventAt !== undefined ? isoOf(identity.lastEventAt) : '',
        contentHash: identity.contentHash,
        lineageKey: identity.lineageKey,
        sizeBytes: size,
        project: projectId,
        path: options.projectPath ?? '',
        attachments: [...hashes].map(hash => ({
          sha256: hash,
          storedAt: `attachments/objects/${hash.slice(0, 2)}/${hash}`,
        })),
        note: 'Лог сессии лежит рядом: session.v4.jsonl.zstd. Восстановление — см. README.md в корне зеркала.',
      }
      written += 1

      rows.push({
        ...sidecar,
        dir: entry.id,
        parent: typeof analysis.header?.parentSession === 'string' ? analysis.header.parentSession : '',
        sidecarPath,
      })
    }

    // Родственные связи субагентов: у сессии указан родитель, у родителя —
    // список детей. Считается по заголовкам логов этого же проекта.
    const parentById = new Map()
    for (const row of rows) {
      row.children = rows
        .filter(other => other.parent === row.id)
        .map(other => other.id)
        .sort()
      if (typeof row.parent === 'string' && row.parent !== '') parentById.set(row.id, row.parent)
    }
    // Корень группы: по нему видно, к какому родителю относится субагент, даже
    // если цепочка длиннее одного уровня. Нужен панели и удалению «вместе».
    for (const row of rows) row.root = rootOf(parentById, row.id)

    for (const row of rows) {
      const childrenChanged = JSON.stringify(row.children) !== JSON.stringify(row.savedChildren ?? [])
      const rootChanged = row.savedRoot === undefined ? row.root !== '' : row.root !== row.savedRoot
      const knownStructure = row.savedChildren !== undefined && row.savedRoot !== undefined
      if (knownStructure && !childrenChanged && !rootChanged && row.identityMigrated !== true) continue
      const { savedChildren, savedRoot, identityMigrated, sidecarPath, dir, bytes: _unused, ...sidecarData } = row
      sidecarData.parent = row.parent ?? ''
      sidecarData.children = row.children
      sidecarData.root = row.root
      await writeFile(sidecarPath, `${JSON.stringify(sidecarData, null, 2)}\n`, 'utf8')
    }

    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    const lines = [
      `# Проект «${projectId}»`,
      '',
      `Путь на этом компьютере: ${options.projectPath ?? 'не указан'}`,
      `Сессий в копии: ${rows.length}`,
      '',
      '| Дата | Название | Блоков | Размер | Связь | Папка |',
      '|---|---|---|---|---|---|',
    ]
    for (const row of rows) {
      const title = String(row.title ?? '').replace(/\|/g, '\\|')
      const sizeMb = (Number(row.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)
      const relation = []
      if (typeof row.parent === 'string' && row.parent !== '') relation.push('субагент')
      if ((row.children ?? []).length > 0) relation.push(`+${row.children.length}`)
      lines.push(`| ${String(row.createdAt ?? '').slice(0, 16).replace('T', ' ')} | ${title} | ${row.events ?? 0} | ${sizeMb} МБ | ${relation.join(' ')} | ${row.dir} |`)
    }
    lines.push(
      '',
      'Связь: «субагент» — сессия вызвана родительской, «+N» — у сессии N субагентов.',
      'Группа «родитель + субагенты» переносится и удаляется вместе.',
      '',
      'Описание каждой сессии — в её папке, файл `session.json`.',
      '',
    )
    await writeIfChanged(join(projectDir, 'index.md'), lines.join('\n'))
  }

  const attachmentLines = [
    '# Вложения',
    '',
    'Файлы хранятся по адресу содержимого: `attachments/objects/<первые два символа>/<sha256>`.',
    'Ниже — какие вложения к каким сессиям относятся.',
    '',
    '| sha256 | сессии |',
    '|---|---|',
  ]
  for (const [hash, sessions] of [...attachmentIndex.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    attachmentLines.push(`| ${hash} | ${[...new Set(sessions)].join(', ')} |`)
  }
  attachmentLines.push('')
  await writeIfChanged(join(repoDir, 'attachments', 'README.md'), attachmentLines.join('\n'))

  return { described: written }
}
