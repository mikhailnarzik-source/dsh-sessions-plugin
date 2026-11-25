/**
 * Чтение локального стора и зеркала. Все операции с логами — на уровне первого
 * zstd-фрейма: заголовок переписывается, хвост событий остаётся байт-в-байт,
 * поэтому его можно сравнивать побайтово между устройствами.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import {
  encodeSegment,
  headerFrameLength,
  projectKey,
  readHeader,
  rewriteHeader,
  samePath,
} from './format.mjs'
import { canonicalCwd } from './config.mjs'

export const LOG_NAME = 'session.v4.jsonl.zstd'
const SESSION_SUFFIX = '.jsonl.zstd'

/** Заголовок + хвост лога (zstd-фреймы или JSONL без сжатия). */
export function splitLog(bytes) {
  const parsed = readHeader(bytes)
  if (!parsed) {
    const magic = Buffer.isBuffer(bytes) ? bytes.subarray(0, 4).toString('hex') : 'not-a-buffer'
    const zstd = typeof zstdDecompressSync === 'function' ? 'yes' : 'no'
    throw new Error(`не удалось прочитать заголовок лога (magic=${magic}, size=${bytes?.length ?? '?'}, zstd=${zstd})`)
  }
  return { header: parsed.header, frameEnd: parsed.frameEnd, tail: bytes.subarray(parsed.frameEnd), plain: parsed.plain === true }
}

/** Лог в переносимом виде: cwd заменён нейтральным путём проекта. */
export function canonicalize(bytes, projectId) {
  const { header, frameEnd } = splitLog(bytes)
  return rewriteHeader(bytes, { ...header, cwd: canonicalCwd(projectId) }, frameEnd)
}

/** Лог для локального устройства: cwd заменён на локальный путь (и, если нужно, id). */
export function remapTo(bytes, targetPath, options = {}) {
  const { header, frameEnd } = splitLog(bytes)
  const next = { ...header, cwd: targetPath }
  if (options.id) next.id = options.id
  return rewriteHeader(bytes, next, frameEnd)
}

/** Путь файла в зеркале. */
export function mirrorLogPath(repoDir, projectId, sessionId) {
  return join(repoDir, 'sessions', projectId, encodeSegment(sessionId), LOG_NAME)
}

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Все сессии локального стора: id, cwd, байты, путь. */
export async function listLocalSessions(home) {
  const root = join(home, 'sessions')
  const sessions = []
  for (const bucket of await listDir(root)) {
    if (!bucket.isDirectory()) continue
    const bucketDir = join(root, bucket.name)
    for (const entry of await listDir(bucketDir)) {
      if (!entry.isDirectory()) continue
      const dir = join(bucketDir, entry.name)
      const files = (await listDir(dir)).filter(file => file.isFile() && file.name.endsWith(SESSION_SUFFIX))
      const log = files.find(file => file.name === LOG_NAME) ?? files.sort((a, b) => b.name.localeCompare(a.name))[0]
      if (!log) continue
      const path = join(dir, log.name)
      const bytes = await readFile(path)
      const parsed = readHeader(bytes)
      if (!parsed) continue
      sessions.push({
        id: parsed.header.id,
        cwd: parsed.header.cwd,
        createdAt: parsed.header.createdAt,
        bucket: bucket.name,
        dir,
        path,
        size: (await stat(path)).size,
        bytes,
      })
    }
  }
  return sessions
}

// --- метаданные зеркала с кэшем по (path, mtime, size) ----------------------
//
// Панель опрашивает /state каждые 30 секунд. Читать на каждый опрос все логи
// зеркала целиком (десятки сессий × десятки мегабайт) нельзя: для счётчиков
// нужен только заголовок — первый zstd-фрейм в начале файла. Поэтому:
// - заголовок читается префиксом (обычно 512 байт), а не файлом целиком;
// - результат кэшируется по пути, mtime и размеру: пока файл не менялся,
//   заголовок не читается повторно;
// - байты лога доступны по требованию (`session.bytes`) — операции
//   синхронизации получают их лениво, когда лог действительно нужен.

/** Сколько записей метаданных зеркала держим в памяти. */
export const MIRROR_CACHE_LIMIT = 500
/** Пределы чтения префикса при разборе заголовка (растут, пока фрейм не влез). */
const HEADER_READ_STEPS = [512, 8 * 1024, 64 * 1024]

/** Счётчики чтений: тесты и отчёт «сколько читали до/после». */
const storeCounters = {
  mirrorLists: 0,
  mirrorEntries: 0,
  metadataHits: 0,
  metadataMisses: 0,
  metadataEvictions: 0,
  headerReads: 0,
  headerBytes: 0,
  mirrorFullReads: 0,
  mirrorFullBytes: 0,
}

/** Кэш метаданных: ключ — путь к логу зеркала. */
const mirrorCache = new Map()
let mirrorCacheLimit = MIRROR_CACHE_LIMIT

/** Счётчики чтений и размер кэша метаданных. */
export function storeStats() {
  return { ...storeCounters, mirrorCacheSize: mirrorCache.size, mirrorCacheLimit }
}

/** Обнулить счётчики (тесты и замеры). Кэш при этом остаётся. */
export function resetStoreStats() {
  for (const key of Object.keys(storeCounters)) storeCounters[key] = 0
}

/** Сбросить кэш метаданных зеркала (смена устройства/каталога, тесты). */
export function clearMirrorCache() {
  mirrorCache.clear()
}

/** Граница кэша метаданных: меньше — дешевле память (тесты используют малое значение). */
export function setMirrorCacheLimit(limit) {
  if (!Number.isFinite(limit) || limit < 1) return mirrorCacheLimit
  mirrorCacheLimit = Math.trunc(limit)
  trimMirrorCache()
  return mirrorCacheLimit
}

function trimMirrorCache() {
  while (mirrorCache.size > mirrorCacheLimit) {
    const oldest = mirrorCache.keys().next()
    if (oldest.done) break
    mirrorCache.delete(oldest.value)
    storeCounters.metadataEvictions += 1
  }
}

/**
 * Заголовок лога из начала файла: читаем префикс и увеличиваем его, пока
 * первый zstd-фрейм не разберётся. Обычно хватает 512 байт — весь лог не читаем.
 * Если префикс не помог (очень странный лог), дочитываем файл целиком: так
 * список не молча теряет сессию.
 */
async function readMirrorHeader(path, size) {
  const handle = await open(path, 'r')
  try {
    for (const step of HEADER_READ_STEPS) {
      const length = Math.min(size, step)
      if (length <= 0) return undefined
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      storeCounters.headerReads += 1
      storeCounters.headerBytes += length
      const parsed = readHeader(buffer)
      if (parsed !== undefined) return parsed.header
      if (length >= size) break
    }
  } finally {
    await handle.close().catch(() => {})
  }
  const bytes = await readFile(path)
  storeCounters.mirrorFullReads += 1
  storeCounters.mirrorFullBytes += bytes.length
  const parsed = readHeader(bytes)
  return parsed?.header
}

function cacheMirrorEntry(path, entry) {
  // Map помнит порядок вставки: переставляем в конец, чтобы давно не
  // прочитанные записи уходили первыми (простое LRU).
  mirrorCache.delete(path)
  mirrorCache.set(path, entry)
  trimMirrorCache()
}

function mirrorSessionEntry(meta, withBytes) {
  const session = {
    id: meta.id,
    cwd: meta.cwd,
    path: meta.path,
    dir: meta.dir,
    size: meta.size,
    mtimeMs: meta.mtimeMs,
    // Разобранный заголовок: /state считает субагентов без чтения лога.
    header: meta.header,
  }
  if (withBytes) {
    let bytes
    Object.defineProperty(session, 'bytes', {
      enumerable: false,
      configurable: true,
      get() {
        if (bytes === undefined) {
          bytes = readFileSync(meta.path)
          storeCounters.mirrorFullReads += 1
          storeCounters.mirrorFullBytes += bytes.length
        }
        return bytes
      },
    })
  }
  return session
}

async function listMirrorSessionMetadata(repoDir, projectId, withBytes) {
  const root = join(repoDir, 'sessions', projectId)
  const result = []
  storeCounters.mirrorLists += 1
  for (const entry of await listDir(root)) {
    if (!entry.isDirectory()) continue
    // Облачные клиенты создают «конфликтующие копии» при одновременной записи:
    // такие каталоги — мусор, а не сессии.
    if (/конфликт|conflicted copy|conflict copy/i.test(entry.name)) continue
    const dir = join(root, entry.name)
    const path = join(dir, LOG_NAME)
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    let meta = mirrorCache.get(path)
    if (meta === undefined || meta.mtimeMs !== info.mtimeMs || meta.size !== info.size) {
      const header = await readMirrorHeader(path, info.size).catch(() => undefined)
      if (header === undefined || header === null
        || typeof header.id !== 'string' || header.id === ''
        || typeof header.cwd !== 'string') {
        mirrorCache.delete(path)
        continue
      }
      meta = {
        id: header.id,
        cwd: header.cwd,
        header,
        mtimeMs: info.mtimeMs,
        size: info.size,
        path,
        dir,
      }
      storeCounters.metadataMisses += 1
      cacheMirrorEntry(path, meta)
    } else {
      storeCounters.metadataHits += 1
      // LRU: прочитанный элемент снова становится «свежим».
      mirrorCache.delete(path)
      mirrorCache.set(path, meta)
    }
    storeCounters.mirrorEntries += 1
    result.push(mirrorSessionEntry(meta, withBytes))
  }
  return result
}

/**
 * Сессии проекта в зеркале: id, cwd (нейтральный), размер, mtime и заголовок.
 * Байты лога — лениво через `session.bytes`: без обращения к свойству файл
 * не читается. Заголовок перечитывается только при изменении файла
 * (path + mtime + size).
 */
export async function listMirrorSessions(repoDir, projectId, options = {}) {
  return listMirrorSessionMetadata(repoDir, projectId, options.bytes !== false)
}

/**
 * То же, но строго метаданные: без ленивых `bytes`. Для снапшота состояния и
 * подписи кэша, где байты логов заведомо не нужны.
 */
export async function listMirrorSessionsCached(repoDir, projectId) {
  return listMirrorSessionMetadata(repoDir, projectId, false)
}

export function isLocked(sessionDir) {
  return existsSync(join(sessionDir, 'session.lock'))
}

export function sessionsOfProject(sessions, projectPath) {
  return sessions.filter(session => samePath(session.cwd, projectPath))
}

export function localSessionDir(home, cwd, sessionId) {
  return join(home, 'sessions', projectKey(cwd), encodeSegment(sessionId))
}
