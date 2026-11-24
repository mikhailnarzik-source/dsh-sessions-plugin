/**
 * Метаданные зеркала: какой проект как называется и по каким путям он живёт
 * на устройствах. Лежат в репозитории (`projects.json`), чтобы новое
 * устройство могло подхватить проект автоматически, без ввода идентификатора.
 *
 * Формат:
 * {
 *   "version": 1,
 *   "projects": {
 *     "harness": {
 *       "title": "DeepSeek Harness",
 *       "devices": { "device-8a4d5777d969": "E:\\DeepSeek Harness" }
 *     }
 *   }
 * }
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const META_FILE = 'projects.json'

/**
 * Фактический формат зеркала.
 *
 * Новая сборка пишет явную отметку `dsh.format` (LOG_FORMAT на момент отправки).
 * У старых зеркал такой отметки нет — там есть только версия схемы
 * `projects.json` (`version`), поэтому она используется как запасной источник.
 * undefined — формат неизвестен, проверять нечего.
 *
 * @param meta — результат readMeta().
 * @returns число или undefined.
 */
export function readMirrorFormat(meta) {
  const explicit = Number(meta?.dsh?.format)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const schema = Number(meta?.version)
  if (Number.isFinite(schema) && schema > 0) return schema
  return undefined
}

export async function readMeta(repoDir) {
  const path = join(repoDir, META_FILE)
  if (!existsSync(path)) return { version: 1, projects: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.projects !== 'object' || parsed.projects === null) {
      return { version: 1, projects: {} }
    }
    return { version: 1, ...parsed, projects: parsed.projects }
  } catch {
    return { version: 1, projects: {} }
  }
}

/** Записать проект устройства в метаданные; возвращает изменённый объект. */
export function mergeDevice(meta, { projectId, title, deviceId, path }) {
  const projects = { ...(meta.projects ?? {}) }
  const current = projects[projectId] ?? { title: title ?? projectId, devices: {} }
  projects[projectId] = {
    title: current.title ?? title ?? projectId,
    devices: { ...(current.devices ?? {}), [deviceId]: path },
  }
  // Отметка версии/формата DSH не относится к проектам, но терять её нельзя:
  // иначе сверка версий перестанет работать после первого же push.
  return { version: 1, projects, ...(meta?.dsh !== undefined ? { dsh: meta.dsh } : {}) }
}

export async function writeMeta(repoDir, meta) {
  await writeFile(join(repoDir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

/**
 * Сопоставить неизвестный проект из зеркала с локальным путём: сравниваем
 * название проекта и имя последней папки пути без учёта регистра и разделителей.
 */
export function matchProjectPath(projectId, title, candidatePaths) {
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const wanted = [normalize(projectId), normalize(title)].filter(value => value.length > 0)
  let best
  for (const path of candidatePaths) {
    const folder = String(path).split(/[\\/]/).filter(Boolean).pop() ?? ''
    if (wanted.includes(normalize(folder))) {
      if (best === undefined) best = path
    }
  }
  return best
}
