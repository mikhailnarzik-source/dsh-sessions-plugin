/**
 * Привязка сессий к рабочим пространствам между устройствами.
 *
 * DSH хранит рабочие пространства в `~/.dsh/storages/workspace.json`: это
 * «unit» с таблицей `workspaces` (`path`, `title`, `sessionIds`) и глобальными
 * полями (`defaultWorkspaceId`, `pinnedSessionIds`, `archivedSessionIds`).
 *
 * В зеркало уезжает только переносимая часть: нейтрализованный путь (или
 * идентификатор проекта), название и список сессий. Глобальные поля и
 * идентификаторы рабочих пространств — машинные: на другом устройстве они
 * свои, и возить их нельзя.
 *
 * Приём не пишет в стор DSH: владелец файла — сам DSH, и правка «мимо реестра»
 * разошлась бы с его состоянием. Вместо этого строится план привязки, который
 * host-часть применяет через `workspaceRegistry.attachSession()`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalCwd } from './config.mjs'
import { samePath, normalizePath } from './format.mjs'

export const MIRROR_WORKSPACE_FILE = 'workspace.json'
export const WORKSPACE_STORE = join('storages', 'workspace.json')
export const PENDING_WORKSPACE_FILE = 'workspace-pending.json'
export const MIRROR_WORKSPACE_VERSION = 1

function normalizeIds(value) {
  if (!Array.isArray(value)) return []
  const ids = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') continue
    const id = item.trim()
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Прочитать стор рабочих пространств (только чтение). */
export async function readLocalWorkspaces(home) {
  const file = join(home, WORKSPACE_STORE)
  const empty = { found: false, workspaces: [], global: null }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const table = parsed?.tables?.workspaces
    if (table === null || typeof table !== 'object') return { ...empty, found: true }
    const workspaces = []
    for (const [id, record] of Object.entries(table)) {
      if (record === null || typeof record !== 'object') continue
      if (typeof record.path !== 'string' || record.path === '') continue
      workspaces.push({
        id,
        path: record.path,
        title: typeof record.title === 'string' && record.title !== '' ? record.title : record.path,
        sessionIds: normalizeIds(record.sessionIds),
      })
    }
    return { found: true, workspaces, global: parsed?.global ?? null }
  } catch {
    return empty
  }
}

/** Какие рабочие пространства уже привязаны к этой машине (id сессий). */
export function attachedSessionIds(local) {
  const ids = new Set()
  for (const workspace of local?.workspaces ?? []) {
    for (const id of workspace.sessionIds) ids.add(id)
  }
  return ids
}

/** Идентификатор проекта для пути или undefined. */
export function projectIdForPath(config, path) {
  if (typeof path !== 'string' || path === '') return undefined
  for (const [projectId, entry] of Object.entries(config?.projects ?? {})) {
    if (typeof entry?.path === 'string' && samePath(entry.path, path)) return projectId
  }
  return undefined
}

/** Переносимый путь рабочего пространства для зеркала. */
export function portableWorkspacePath(path, { config, neutralizer }) {
  const projectId = projectIdForPath(config, path)
  if (projectId !== undefined) return { path: canonicalCwd(projectId), projectId }
  return { path: neutralizer.neutralizePath(path) }
}

function entryKey(entry) {
  if (typeof entry?.projectId === 'string' && entry.projectId !== '') return `project:${entry.projectId}`
  return `path:${normalizePath(String(entry?.path ?? ''))}`
}

/** Прочитать зеркало рабочих пространств. */
export async function readWorkspaceMirror(repoDir) {
  const file = join(repoDir, MIRROR_WORKSPACE_FILE)
  const empty = { version: MIRROR_WORKSPACE_VERSION, workspaces: [] }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.workspaces)) return empty
    const workspaces = []
    for (const item of parsed.workspaces) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.path !== 'string' || item.path === '') continue
      workspaces.push({
        path: item.path,
        projectId: typeof item.projectId === 'string' && item.projectId !== '' ? item.projectId : undefined,
        title: typeof item.title === 'string' && item.title !== '' ? item.title : item.path,
        sessionIds: normalizeIds(item.sessionIds),
      })
    }
    return { version: MIRROR_WORKSPACE_VERSION, workspaces }
  } catch {
    return empty
  }
}

/**
 * Собрать зеркало из локальных рабочих пространств и объединить с уже
 * лежащим в зеркале: записи другого устройства не должны потеряться от
 * отправки этого, а идентификаторы сессий объединяются.
 */
export async function pushWorkspace({ home, config, repoDir, neutralizer }) {
  const local = await readLocalWorkspaces(home)
  const existing = await readWorkspaceMirror(repoDir)
  const merged = new Map()
  for (const entry of existing.workspaces) merged.set(entryKey(entry), entry)

  let workspaces = 0
  let added = 0
  for (const workspace of local.workspaces) {
    const portable = portableWorkspacePath(workspace.path, { config, neutralizer })
    const candidate = {
      path: portable.path,
      ...(portable.projectId !== undefined ? { projectId: portable.projectId } : {}),
      title: workspace.title,
      sessionIds: [...workspace.sessionIds],
    }
    const key = entryKey(candidate)
    const previous = merged.get(key)
    const sessionIds = [...new Set([...(previous?.sessionIds ?? []), ...candidate.sessionIds])].sort()
    merged.set(key, { ...previous, ...candidate, sessionIds })
    workspaces += 1
    if (previous === undefined) added += 1
  }

  const value = {
    version: MIRROR_WORKSPACE_VERSION,
    workspaces: [...merged.values()].sort((a, b) => String(a.title).localeCompare(String(b.title))),
  }
  if (!existsSync(repoDir)) return { ok: false, written: false, workspaces, added, reason: 'каталог зеркала недоступен' }
  await writeFile(join(repoDir, MIRROR_WORKSPACE_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { ok: true, written: true, workspaces, added, sessions: value.workspaces.reduce((total, item) => total + item.sessionIds.length, 0) }
}

/** Нормализованное имя последней папки пути. */
function folderName(path) {
  const parts = String(path).split(/[\\/]+/).filter(Boolean)
  return (parts.pop() ?? '').toLowerCase()
}

/**
 * Найти локальное рабочее пространство для записи зеркала.
 * @returns {{by: 'project'|'path'|'folder', workspace: object} | undefined}
 */
export function matchLocalWorkspace(entry, { config, local, neutralizer }) {
  const byPath = (path) => (local?.workspaces ?? []).find(workspace => samePath(workspace.path, path))
  if (typeof entry.projectId === 'string' && entry.projectId !== '') {
    const configured = config?.projects?.[entry.projectId]?.path
    if (typeof configured === 'string' && configured !== '') {
      const hit = byPath(configured)
      if (hit !== undefined) return { by: 'project', workspace: hit }
    }
  }
  const localized = neutralizer.localizePath(entry.path)
  const byExact = byPath(localized)
  if (byExact !== undefined) return { by: 'path', workspace: byExact }
  const wanted = folderName(localized)
  if (wanted === '') return undefined
  const byFolder = (local?.workspaces ?? []).find(workspace => folderName(workspace.path) === wanted)
  return byFolder === undefined ? undefined : { by: 'folder', workspace: byFolder }
}

/**
 * План привязки: что из зеркала уже совпало с локальными рабочими
 * пространствами, какие сессии нужно привязать и какие записи остались без
 * пары (подсказка в панели).
 */
export async function planWorkspace({ home, config, repoDir, neutralizer, local }) {
  const store = local ?? await readLocalWorkspaces(home)
  const mirror = await readWorkspaceMirror(repoDir)
  const matched = []
  const pendingAttach = []
  const hints = []
  for (const entry of mirror.workspaces) {
    const hit = matchLocalWorkspace(entry, { config, local: store, neutralizer })
    if (hit === undefined) {
      hints.push({
        title: entry.title,
        path: neutralizer.localizePath(entry.path),
        projectId: entry.projectId ?? '',
        sessionIds: entry.sessionIds,
        reason: 'нет рабочего пространства с таким путём на этом устройстве',
      })
      continue
    }
    const known = new Set(hit.workspace.sessionIds)
    const fresh = entry.sessionIds.filter(id => !known.has(id))
    matched.push({
      workspaceId: hit.workspace.id,
      path: hit.workspace.path,
      title: hit.workspace.title,
      by: hit.by,
      sessionIds: entry.sessionIds,
    })
    if (fresh.length > 0) {
      pendingAttach.push({
        workspaceId: hit.workspace.id,
        path: hit.workspace.path,
        title: hit.workspace.title,
        sessionIds: fresh,
      })
    }
  }
  return {
    mirrorWorkspaces: mirror.workspaces.length,
    localWorkspaces: store.workspaces.length,
    matched,
    pendingAttach,
    hints,
    missingLocalStore: store.found === false,
  }
}

/** Сохранить план привязки, чтобы host применил его через реестр. */
export async function writeWorkspacePending(home, plan) {
  const file = join(home, 'dsh-sync', PENDING_WORKSPACE_FILE)
  if ((plan?.pendingAttach ?? []).length === 0) {
    await rm(file, { force: true }).catch(() => {})
    return { written: false, pending: 0 }
  }
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  await writeFile(file, `${JSON.stringify({
    version: 1,
    at: new Date().toISOString(),
    pendingAttach: plan.pendingAttach,
    hints: plan.hints,
  }, null, 2)}\n`, 'utf8')
  return { written: true, pending: plan.pendingAttach.length }
}

export async function readWorkspacePending(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'dsh-sync', PENDING_WORKSPACE_FILE), 'utf8'))
    return {
      at: parsed?.at ?? '',
      pendingAttach: Array.isArray(parsed?.pendingAttach) ? parsed.pendingAttach : [],
      hints: Array.isArray(parsed?.hints) ? parsed.hints : [],
    }
  } catch {
    return { at: '', pendingAttach: [], hints: [] }
  }
}

export async function clearWorkspacePending(home) {
  await rm(join(home, 'dsh-sync', PENDING_WORKSPACE_FILE), { force: true }).catch(() => {})
}

/** Приём: посчитать план и сохранить его для host-части. */
export async function pullWorkspace({ home, config, repoDir, neutralizer, dryRun = false }) {
  const plan = await planWorkspace({ home, config, repoDir, neutralizer })
  let pending = { written: false, pending: 0 }
  if (!dryRun) pending = await writeWorkspacePending(home, plan)
  return {
    mirrorWorkspaces: plan.mirrorWorkspaces,
    localWorkspaces: plan.localWorkspaces,
    matched: plan.matched.length,
    toAttach: plan.pendingAttach.reduce((total, item) => total + item.sessionIds.length, 0),
    hints: plan.hints.length,
    pending: pending.pending,
    missingLocalStore: plan.missingLocalStore,
  }
}
