/**
 * Учёт прогресса выгрузки в резервное хранилище.
 *
 * Между запусками помним, какие файлы уже загружены и их размер. Это позволяет
 * показать человеку процент готовности, не опрашивая облако каждый раз.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FILE_NAME = 'upload-progress.json'

function progressPath(repoDir) {
  return join(repoDir, '..', FILE_NAME)
}

/** Прочитать ранее сохранённый прогресс. */
export async function readProgress(repoDir) {
  try {
    const parsed = JSON.parse(await readFile(progressPath(repoDir), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.files !== null && typeof parsed.files === 'object') {
      return parsed
    }
  } catch {
    // файла ещё нет
  }
  return { version: 1, files: {} }
}

/** Записать прогресс. */
export async function writeProgress(repoDir, progress) {
  try {
    await writeFile(progressPath(repoDir), `${JSON.stringify(progress, null, 2)}\n`, 'utf8')
  } catch {
    // учёт прогресса не критичен
  }
}

/** Отметить файл как выгруженный. */
export function markUploaded(progress, rel, size) {
  progress.files[rel] = size
}

/** Убрать из учёта файлы, которых больше нет локально. */
export function pruneProgress(progress, localRels) {
  for (const rel of Object.keys(progress.files)) {
    if (!localRels.has(rel)) delete progress.files[rel]
  }
}

/**
 * Посчитать процент готовности.
 * @param progress сохранённый прогресс
 * @param localSizes Map(rel → размер) всех локальных файлов
 */
export function summarize(progress, localSizes) {
  let totalBytes = 0
  for (const size of localSizes.values()) totalBytes += size
  let doneBytes = 0
  let doneFiles = 0
  for (const [rel, size] of localSizes) {
    if (progress.files[rel] !== undefined) {
      doneBytes += size
      doneFiles += 1
    }
  }
  return {
    totalBytes,
    doneBytes,
    totalFiles: localSizes.size,
    doneFiles,
    percent: totalBytes === 0 ? 100 : Math.min(100, Math.round((doneBytes / totalBytes) * 100)),
    at: new Date().toISOString(),
  }
}

export { progressPath as uploadProgressPath }

/**
 * Готовность резервной копии: сколько уже выгружено из того, что лежит в кеше.
 * @param repoDir каталог кеша резервного хранилища
 */
export async function backupProgress(repoDir) {
  const localSizes = new Map()
  try {
    const entries = await readdir(repoDir, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const absolute = join(entry.parentPath ?? entry.path, entry.name)
      const rel = absolute.slice(repoDir.length + 1).split('\\').join('/')
      try {
        const info = await stat(absolute)
        localSizes.set(rel, info.size)
      } catch {
        // файл исчез во время обхода
      }
    }
  } catch {
    // каталога ещё нет
  }
  const progress = await readProgress(repoDir)
  pruneProgress(progress, new Set(localSizes.keys()))
  return summarize(progress, localSizes)
}
