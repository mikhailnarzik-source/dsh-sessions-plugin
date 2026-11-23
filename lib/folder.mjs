/**
 * Бэкенд «папка облака»: зеркало лежит в обычной папке, которую синхронизирует
 * клиент облачного диска (Яндекс.Диск, OneDrive, Syncthing, сетевой шар).
 * Сети и токенов нет: плагин копирует файлы между локальным кешем и папкой,
 * а переносом между компьютерами занимается сам клиент облака.
 *
 * Устроено так же, как WebDAV-бэкенд (`lib/webdav.mjs`):
 * - `sync()` — забрать из папки то, чего нет или что изменилось в кеше;
 * - `commit()` — выгрузить изменённое и убрать из папки исчезнувшие файлы;
 * - `compare()` — план сверки: сколько файлов локально, в папке и расходится.
 *
 * Временные ошибки ввода-вывода (файл занят клиентом облака, папка моргнула
 * посреди обхода) повторяются 4 попытки с нарастающей паузой — как сетевые
 * ошибки у WebDAV.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { markUploaded, pruneProgress, readProgress, writeProgress } from './progress.mjs'

/** Сколько всего попыток на одну io-операцию (по аудиту — 3–5). */
export const IO_RETRIES = 4
const RETRY_BASE_MS = 250
/** Потоков копирования: диск не сеть, но и десятки одновременно не нужны. */
export const DEFAULT_CONCURRENCY = 4
/** Служебные и мусорные имена, которые не считаем файлами зеркала. */
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const CONFLICT_DIR = /конфликт|conflicted copy|conflict copy/i
const TEMP_FILE = /\.(dsh-)?tmp(-|$)|^~\$/

/** Временная ли это ошибка ввода-вывода: её стоит повторить. */
export function transientIoError(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`
  if (['EBUSY', 'EAGAIN', 'EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'ETXTBSY', 'EINTR', 'ENOENT', 'ENOTDIR'].includes(code)) return true
  return /EBUSY|EPERM|EACCES|resource busy|being used by another process|operation not permitted|EIO|access is denied/i.test(text)
}

/**
 * Повторить операцию при временной ошибке ввода-вывода.
 * @param operation асинхронная функция
 * @param options retries (всего попыток), baseMs (пауза первой паузы), onRetry
 */
export async function retryIo(operation, options = {}) {
  const attempts = Math.max(1, Number(options.retries ?? IO_RETRIES))
  const baseMs = Math.max(0, Number(options.baseMs ?? RETRY_BASE_MS))
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (!transientIoError(error) || attempt === attempts - 1) throw error
      if (typeof options.onRetry === 'function') options.onRetry(error, attempt + 1)
      if (baseMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(5_000, baseMs * 2 ** attempt)))
    }
  }
  throw lastError
}

function joinRel(root, rel) {
  return join(root, ...rel.split('/'))
}

async function statOrNull(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

/** Список файлов папки: rel (через «/») → { size, mtimeMs }. Нет папки — пусто. */
export async function listFolderFiles(root, options = {}) {
  const files = new Map()
  const retries = options.retries ?? IO_RETRIES
  const baseMs = options.baseMs ?? RETRY_BASE_MS
  // Отсутствие папки — обычная ситуация (облако новое), а не io-сбой:
  // проверяем без повторов и пауз, иначе первый запуск ждёт секунды впустую.
  let info
  try {
    info = await stat(root)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return files
    info = await retryIo(() => stat(root), { retries, baseMs })
  }
  if (!info.isDirectory()) throw new Error(`папка облака не каталог: ${root}`)
  const walk = async (current) => {
    const entries = await retryIo(() => readdir(current, { withFileTypes: true }), { retries, baseMs })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || CONFLICT_DIR.test(entry.name)) continue
        await walk(join(current, entry.name))
        continue
      }
      if (!entry.isFile() || TEMP_FILE.test(entry.name)) continue
      const absolute = join(current, entry.name)
      const info = await retryIo(() => stat(absolute), { retries, baseMs })
      files.set(relative(root, absolute).split(sep).join('/'), { size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  await walk(root)
  return files
}

async function mapLimit(items, limit, worker) {
  const queue = [...items]
  const workers = Math.max(1, Math.min(limit, queue.length))
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        await worker(item)
      }
    }),
  )
}

/**
 * Скопировать файл и убедиться, что размер совпал: клиент облака мог ещё
 * дописывать файл в момент копирования.
 */
async function copyFileChecked(from, to, options = {}) {
  const retries = options.retries ?? IO_RETRIES
  const baseMs = options.baseMs ?? RETRY_BASE_MS
  return retryIo(async () => {
    const source = await stat(from)
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
    const target = await stat(to)
    if (target.size !== source.size) {
      const error = new Error(`размер копии не совпал (${target.size} вместо ${source.size})`)
      error.code = 'EBUSY'
      throw error
    }
    return target
  }, { retries, baseMs })
}

function priorityOf(rel) {
  if (rel.startsWith('sessions/')) return 0
  if (rel.startsWith('attachments/')) return 2
  return 1
}

/**
 * Создать папку-бэкенд.
 * @param config поля: repoDir (локальный кеш), folderDir (папка облака),
 *   maxUploadMs (бюджет выгрузки), concurrency
 * @param options служебные настройки: baseMs/retries — для тестов
 */
export function createFolderBackend(config, options = {}) {
  const folderDir = typeof config.folderDir === 'string' ? config.folderDir.trim() : ''
  if (folderDir === '') throw new Error('не задана папка облака для резервного канала (folderDir)')
  const repoDir = typeof config.repoDir === 'string' && config.repoDir.trim() !== '' ? config.repoDir : ''
  if (repoDir === '') throw new Error('не задан локальный кеш папки-зеркала (repoDir)')

  const retries = Number(options.retries ?? IO_RETRIES)
  const baseMs = Number(options.baseMs ?? RETRY_BASE_MS)
  // Папка облака может совпадать с кешем: так работал старый режим «папка
  // зеркала», где облачный клиент и был хранилищем. Тогда копировать нечего.
  const sameDir = resolve(folderDir) === resolve(repoDir)
  const concurrency = Math.max(1, Math.min(16, Number(config.concurrency ?? DEFAULT_CONCURRENCY)))
  const ioOptions = { retries, baseMs }

  const listRemote = () => listFolderFiles(folderDir, ioOptions)
  const listCache = () => listFolderFiles(repoDir, ioOptions)

  return {
    kind: 'folder',
    folderDir,
    cacheDir: repoDir,
    sameDir,

    /** Забрать из папки облака новые и изменённые файлы в локальный кеш. */
    async sync() {
      if (sameDir) return true
      const remote = await listRemote()
      const pending = []
      for (const [rel, meta] of remote) {
        const target = joinRel(repoDir, rel)
        const local = await statOrNull(target)
        if (local === null || local.size !== meta.size) pending.push(rel)
      }
      await mkdir(repoDir, { recursive: true })
      await mapLimit(pending, concurrency, (rel) => copyFileChecked(joinRel(folderDir, rel), joinRel(repoDir, rel), ioOptions))
      return true
    },

    /** Выгрузить кеш в папку облака и убрать исчезнувшие файлы. */
    async commit() {
      if (sameDir) return { committed: false, uploaded: 0, removed: 0 }
      const remote = await listRemote()
      const local = await listCache()
      const progress = await readProgress(repoDir)
      const pending = []
      for (const [rel, meta] of local) {
        const before = remote.get(rel)
        if (before !== undefined && before.size === meta.size) continue
        pending.push({ rel, size: meta.size })
      }
      // Сначала сессии, внутри группы — от маленького к большому: бюджет может
      // кончиться на крупном файле, а прогресс всё равно пойдёт.
      pending.sort((a, b) => priorityOf(a.rel) - priorityOf(b.rel) || a.size - b.size)

      const budget = Number(config.maxUploadMs ?? 720_000)
      const startedAt = Date.now()
      let uploaded = 0
      await mapLimit(pending, concurrency, async (file) => {
        if (Date.now() - startedAt > budget) return
        await copyFileChecked(joinRel(repoDir, file.rel), joinRel(folderDir, file.rel), ioOptions)
        markUploaded(progress, file.rel, file.size)
        uploaded += 1
      })

      // Пустой кеш — почти наверняка сбой чтения, а не «удалили всё»: файлы
      // в папке облака не трогаем.
      let removed = 0
      if (local.size === 0 && remote.size > 0) {
        await writeProgress(repoDir, progress)
        return { committed: uploaded > 0, uploaded, removed: 0, warning: 'локальный кеш пуст — удаление в папке облака пропущено' }
      }
      for (const rel of remote.keys()) {
        if (local.has(rel)) continue
        await retryIo(() => rm(joinRel(folderDir, rel), { force: true }), ioOptions)
        removed += 1
      }

      // Файлы, уже лежащие в папке и совпадающие по размеру, сразу считаем
      // выгруженными: прогресс не начинается с нуля после переустановки.
      for (const [rel, meta] of remote) {
        if (local.has(rel) && progress.files[rel] === undefined) markUploaded(progress, rel, meta.size)
      }
      pruneProgress(progress, new Set(local.keys()))
      await writeProgress(repoDir, progress)
      return { committed: uploaded > 0 || removed > 0, uploaded, removed }
    },

    /** План сверки: файлы локально / в папке облака / расходятся. */
    async compare() {
      const remote = await listRemote()
      const local = await listCache()
      let differ = 0
      let onlyLocal = 0
      let onlyCloud = 0
      for (const [rel, meta] of local) {
        const before = remote.get(rel)
        if (before === undefined) onlyLocal += 1
        else if (before.size !== meta.size) differ += 1
      }
      for (const rel of remote.keys()) {
        if (!local.has(rel)) onlyCloud += 1
      }
      return { local: local.size, cloud: remote.size, differ, onlyLocal, onlyCloud, sameDir }
    },
  }
}

/** Проверка доступа: папка облака существует или создаётся. */
export async function probeFolder(config) {
  try {
    const folderDir = typeof config.folderDir === 'string' ? config.folderDir.trim() : ''
    if (folderDir === '') return { ok: false, message: 'не задана папка облака (folderDir)' }
    await mkdir(folderDir, { recursive: true })
    const files = await listFolderFiles(folderDir)
    if (existsSync(folderDir)) return { ok: true, message: `папка доступна: ${folderDir} (файлов: ${files.size})` }
    return { ok: false, message: `папка недоступна: ${folderDir}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Проверить, что папка облака — не тот же каталог, что основное зеркало. */
export function sameFolder(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.trim() === '' || b.trim() === '') return false
  return resolve(a.trim()) === resolve(b.trim())
}
