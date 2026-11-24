/**
 * Названия сессий для панели: вместо голого id показываем понятное имя.
 *
 * Цепочка источников (первое непустое побеждает):
 * 1. `session.title` из `sessionPersistence` — заголовок, который DSH уже знает;
 * 2. первое событие `session/title` в логе сессии — читаем только первые 2 МБ
 *    файла, поэтому разбор не зависит от размера лога;
 * 3. `session.json` рядом с копией в зеркале (в том числе в карантине `_deleted`);
 * 4. «Без названия» + короткий id для подсказки.
 *
 * Разбор лога кешируется по пути и `mtime` с размером: панель спрашивает
 * названия на каждый рендер, а лог читать повторно незачем.
 */
import { existsSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { encodeSegment, projectKey } from './format.mjs'
import { LOG_NAME } from './store.mjs'

/** Заголовок «названия нет»: панель показывает его вместо id. */
export const UNTITLED = 'Без названия'
/** Первые мегабайты лога: событие `session/title` всегда идёт в начале. */
export const TITLE_READ_BYTES = 2 * 1024 * 1024
/** Ограничение на распакованный объём при поиске названия. */
const TITLE_DECOMPRESSED_LIMIT = 48 * 1024 * 1024
/** Сколько названий держим в памяти (path → mtime/size/title). */
const TITLE_CACHE_LIMIT = 500
/** Событие лога, из которого берётся название. */
const TITLE_EVENT = 'session/title'

/** Кеш разобранных названий: ключ — путь к логу. */
const titleCache = new Map()

/** Сбросить кеш (тесты и смена источника логов). */
export function clearTitleCache() {
  titleCache.clear()
}

/** Размер кеша — для тестов. */
export function titleCacheSize() {
  return titleCache.size
}

/** Короткий id для подсказки: как в панели — начало и конец. */
export function shortSessionId(sessionId) {
  const id = String(sessionId ?? '').replace(/^session-/, '')
  if (id === '') return ''
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

/** Название для показа: обрезанное или «Без названия». */
export function displayTitle(title) {
  const text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  return text === '' ? UNTITLED : text.slice(0, 120)
}

function isZstdMagic(bytes, offset) {
  return bytes[offset] === 0x28 && bytes[offset + 1] === 0xb5 && bytes[offset + 2] === 0x2f && bytes[offset + 3] === 0xfd
}

/** Позиция следующего zstd-фрейма после `from` или -1. */
function nextFrameOffset(bytes, from) {
  for (let index = from; index + 4 <= bytes.length; index += 1) {
    if (isZstdMagic(bytes, index)) return index
  }
  return -1
}

/** Название из одной строки события лога (JSONL). */
function titleOfEventLine(line) {
  if (!line.includes(TITLE_EVENT)) return ''
  try {
    const event = JSON.parse(line)
    if (event?.type !== TITLE_EVENT) return ''
    const title = event?.data?.title
    return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  } catch {
    return ''
  }
}

/**
 * Название из первых байтов лога.
 *
 * Лог — zstd-фреймы: заголовок сессии, дальше по фрейму на событие. Читаем
 * фреймы подряд и останавливаемся на первом `session/title`. Обрезанный
 * последний фрейм (прочитали не весь файл) просто пропускаем.
 */
export function titleOfLogBytes(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return ''
  const limit = Number.isFinite(options.maxBytes) ? options.maxBytes : TITLE_READ_BYTES
  const view = bytes.length > limit ? bytes.subarray(0, limit) : bytes
  // Лог без сжатия (plain JSONL) тоже бывает: рамки zstd тогда нет.
  if (!isZstdMagic(view, 0)) {
    let latest = ''
    for (const line of view.toString('utf8').split('\n')) {
      const title = titleOfEventLine(line)
      if (title !== '') latest = title
    }
    return latest.slice(0, 160)
  }
  let offset = 0
  let decompressed = 0
  let latest = ''
  while (offset >= 0 && offset + 4 <= view.length) {
    const end = nextFrameOffset(view, offset + 4)
    const frameEnd = end === -1 ? view.length : end
    let text
    try {
      text = zstdDecompressSync(view.subarray(offset, frameEnd)).toString('utf8')
    } catch {
      // Обрезанный хвост или мусор после последнего целого фрейма: отдаём то,
      // что уже нашли (DSH пишет сначала предварительное название, затем
      // настоящее — нужно последнее).
      return latest.slice(0, 160)
    }
    decompressed += text.length
    if (decompressed > TITLE_DECOMPRESSED_LIMIT) return latest.slice(0, 160)
    for (const line of text.split('\n')) {
      const title = titleOfEventLine(line)
      if (title !== '') latest = title
    }
    if (end === -1) break
    offset = end
  }
  return latest.slice(0, 160)
}

/** Прочитать только первые `maxBytes` файла: большие логи не грузим целиком. */
async function readLogPrefix(path, maxBytes = TITLE_READ_BYTES) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const size = Math.min(info.size, Math.max(0, maxBytes))
    const buffer = Buffer.alloc(size)
    if (size > 0) await handle.read(buffer, 0, size, 0)
    return { bytes: buffer, info }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Прочитать хвост файла: там могут быть поздние переименования сессии. */
async function readLogSuffix(path, maxBytes = TITLE_READ_BYTES) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const size = Math.min(info.size, Math.max(0, maxBytes))
    if (size <= 0) return { bytes: Buffer.alloc(0), info }
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, info.size - size)
    return { bytes: buffer, info }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Прочитать диапазон файла [start, end). */
async function readRange(path, start, end) {
  const handle = await open(path, 'r')
  try {
    const length = Math.max(0, end - start)
    if (length === 0) return Buffer.alloc(0)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Последнее название из файла: идём окнами от конца (1, 4, 16, 64 МБ…), пока
 * не найдём событие `session/title`. Так поздние переименования не теряются,
 * а весь большой лог не читается.
 */
async function lastTitleFromTail(path, size) {
  let window = 1024 * 1024
  while (true) {
    const start = Math.max(0, size - window)
    const bytes = await readRange(path, start, size)
    let from = -1
    for (let index = 0; index + 4 <= bytes.length; index += 1) {
      if (isZstdMagic(bytes, index)) { from = index; break }
    }
    const view = from === -1 ? bytes : bytes.subarray(from)
    const title = titleOfLogBytes(view)
    if (title !== '') return title
    if (start === 0) return ''
    window *= 4
  }
}

/**
 * Название из лога сессии с кешем по пути и `mtime`.
 * @returns название или '' (файла нет/названия нет)
 */
export async function titleOfLog(path, options = {}) {
  if (typeof path !== 'string' || path === '') return ''
  const limit = Number.isFinite(options.maxBytes) ? options.maxBytes : TITLE_READ_BYTES
  let info
  try {
    info = await stat(path)
  } catch {
    return ''
  }
  if (info.isDirectory()) return ''
  const cached = titleCache.get(path)
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.title
  }
  let title = ''
  try {
    const prefix = await readLogPrefix(path, limit)
    title = titleOfLogBytes(prefix.bytes, { maxBytes: limit })
    // Поздние переименования могут быть далеко от начала: ищем последнее
    // событие session/title в хвосте (DSH сначала пишет предварительное
    // название — первое сообщение, затем настоящее).
    if (info.size > limit) {
      const tailTitle = await lastTitleFromTail(path, info.size)
      if (tailTitle !== '') title = tailTitle
    }
  } catch {
    title = ''
  }
  if (titleCache.size >= TITLE_CACHE_LIMIT) {
    // Простейшая эвикция: первый добавленный элемент (Map помнит порядок вставки).
    const oldest = titleCache.keys().next()
    if (!oldest.done) titleCache.delete(oldest.value)
  }
  titleCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, title })
  return title
}

/** Название из `session.json` рядом с копией сессии. */
async function titleOfSidecar(dir) {
  if (typeof dir !== 'string' || dir === '') return ''
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    return typeof parsed?.title === 'string' ? parsed.title.replace(/\s+/g, ' ').trim() : ''
  } catch {
    return ''
  }
}

/** Путь лога активной копии в зеркале. */
export function mirrorLogPathOf(repoDir, projectId, sessionId) {
  if (typeof repoDir !== 'string' || repoDir === '' || typeof projectId !== 'string' || projectId === '') return ''
  return join(repoDir, 'sessions', projectId, encodeSegment(sessionId), LOG_NAME)
}

/** Путь лога карантинной копии в зеркале (`_deleted`). */
export function quarantineLogPathOf(repoDir, projectId, sessionId) {
  if (typeof repoDir !== 'string' || repoDir === '' || typeof projectId !== 'string' || projectId === '') return ''
  return join(repoDir, 'sessions', projectId, '_deleted', encodeSegment(sessionId), LOG_NAME)
}

export const QUARANTINE_DIR = '_deleted'

/**
 * Разрешить название сессии по цепочке.
 *
 * @param options.id — id сессии (полный или короткий);
 * @param options.title — `session.title` из sessionPersistence (может быть '');
 * @param options.path — путь к локальному логу, если известен;
 * @param options.repoDir — каталог зеркала (для лога и session.json);
 * @param options.projectId — проект в зеркале;
 * @param options.projectPath — локальный путь проекта (для локального лога);
 * @param options.preferLog — сначала лог, потом переданный title (план/надгробия,
 *   где title пришёл из зеркала, а не из DSH).
 * @returns {{ title: string, rawTitle: string, shortId: string, titleSource: string }}
 */
export async function resolveSessionTitle(options = {}) {
  const id = String(options.id ?? '').trim()
  const shortId = shortSessionId(id)
  const given = typeof options.title === 'string' ? options.title.replace(/\s+/g, ' ').trim() : ''

  const logCandidates = []
  if (typeof options.path === 'string' && options.path !== '') logCandidates.push(options.path)
  if (options.home !== undefined && typeof options.projectPath === 'string' && options.projectPath !== '') {
    logCandidates.push(join(options.home, 'sessions', projectKey(options.projectPath), encodeSegment(id), LOG_NAME))
  }
  const mirrorLog = mirrorLogPathOf(options.repoDir, options.projectId, id)
  if (mirrorLog !== '' && !logCandidates.includes(mirrorLog)) logCandidates.push(mirrorLog)

  const tryLog = async () => {
    for (const candidate of logCandidates) {
      if (!existsSync(candidate)) continue
      const title = await titleOfLog(candidate)
      if (title !== '') return { raw: title, source: 'log' }
    }
    return undefined
  }
  const trySidecar = async () => {
    const dirs = []
    if (typeof options.repoDir === 'string' && options.repoDir !== '' && typeof options.projectId === 'string' && options.projectId !== '') {
      dirs.push(join(options.repoDir, 'sessions', options.projectId, encodeSegment(id)))
    }
    for (const dir of dirs) {
      const title = await titleOfSidecar(dir)
      if (title !== '') return { raw: title, source: 'mirror' }
    }
    return undefined
  }

  // Лог сильнее переданного `session.title`: в логе последнее событие
  // session/title — настоящее название, а `session.title` из окружения часто
  // оказывается предварительным (первое сообщение).
  let hit = await tryLog()
  if (hit === undefined && given !== '') hit = { raw: given, source: 'session' }
  if (hit === undefined) hit = await trySidecar()

  const rawTitle = hit?.raw ?? ''
  return {
    title: displayTitle(rawTitle),
    rawTitle,
    shortId,
    titleSource: hit?.source ?? 'fallback',
  }
}

/**
 * Название удалённой сессии: карантинный лог → сохранённое название →
 * активный лог зеркала → session.json → «Без названия».
 */
export async function resolveTombstoneTitle(options = {}) {
  const id = String(options.sessionId ?? options.id ?? '').trim()
  const shortId = shortSessionId(id)
  const given = typeof options.title === 'string' ? options.title.replace(/\s+/g, ' ').trim() : ''
  const projectId = typeof options.projectId === 'string' ? options.projectId : ''

  const quarantineLog = quarantineLogPathOf(options.repoDir, projectId, id)
  if (quarantineLog !== '' && existsSync(quarantineLog)) {
    const title = await titleOfLog(quarantineLog)
    if (title !== '') return { title: displayTitle(title), rawTitle: title, shortId, titleSource: 'quarantine-log' }
  }
  const quarantineSidecar = await titleOfSidecar(
    join(String(options.repoDir ?? ''), 'sessions', projectId, QUARANTINE_DIR, encodeSegment(id)),
  )
  if (quarantineSidecar !== '') {
    return { title: displayTitle(quarantineSidecar), rawTitle: quarantineSidecar, shortId, titleSource: 'quarantine' }
  }
  if (given !== '') return { title: displayTitle(given), rawTitle: given, shortId, titleSource: 'session' }
  const resolved = await resolveSessionTitle({ ...options, id, title: '', preferLog: true })
  return { ...resolved, shortId }
}
