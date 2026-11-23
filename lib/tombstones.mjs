/**
 * «Надгробия»: отметки об удалённых сессиях, чтобы удаление доехало до других
 * устройств и чтобы его можно было отменить.
 *
 * Файл `tombstones.json` лежит в зеркале и попадает в тот же коммит, что и
 * удаление. У каждой метки есть:
 *
 *   reason — почему удалено: manual (пользователь), prune (автоочистка при
 *            отправке), expired (истёк 30-дневный карантин), replaced
 *            (карантинная копия заменена новой), restored (удаление отменено);
 *   by     — кто удалил: owner (пользователь) или sync (синхронизация);
 *   at     — когда;
 *   device — с какого устройства.
 *
 * Удаление на устройстве не стирает данные мгновенно: локальная копия
 * переносится в ~/.dsh/dsh-sync/deleted/<время>/, а копия в зеркале — в
 * sessions/<проект>/_deleted/<id>/. Оттуда сессию можно вернуть кнопкой
 * «Восстановить» (30 дней, пока карантин не вычищен).
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeSegment } from './format.mjs'
import { LOG_NAME, localSessionDir, remapTo } from './store.mjs'

export const TOMBSTONES_FILE = 'tombstones.json'
/** Версия формата: во второй появились reason/by и прочие метки. */
export const TOMBSTONES_VERSION = 2
/** Папка карантина внутри проекта зеркала. */
export const QUARANTINE_DIR = '_deleted'
/** Сколько дней удалённая сессия лежит в карантине зеркала. */
export const QUARANTINE_DAYS = 30
/** Файл рядом с карантинной копией: когда и почему удалена. */
export const DELETED_AT_FILE = 'deleted-at.json'
/** Описание сессии (название и т. п.), которое кладёт каталог зеркала. */
export const SESSION_SIDECAR_FILE = 'session.json'

/** Допустимые причины удаления. */
export const TOMBSTONE_REASONS = ['manual', 'prune', 'expired', 'replaced', 'restored']
/** Допустимые авторы удаления. */
export const TOMBSTONE_BY = ['owner', 'sync']

const DAY_MS = 24 * 60 * 60_000

function isoNow(now) {
  const value = now instanceof Date ? now.getTime() : Number(now ?? Date.now())
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString()
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Старые метки знали только at/device: достраиваем обязательные поля. */
function normalizeEntry(entry, fallbackAt) {
  const source = entry !== null && typeof entry === 'object' ? entry : {}
  const normalized = { ...source }
  normalized.at = text(source.at) !== '' ? source.at : (fallbackAt ?? isoNow())
  normalized.device = text(source.device)
  normalized.reason = TOMBSTONE_REASONS.includes(source.reason) ? source.reason : 'manual'
  normalized.by = TOMBSTONE_BY.includes(source.by) ? source.by : 'owner'
  return normalized
}

/** Прочитать надгробия; битый или отсутствующий файл — пустое состояние. */
export async function readTombstones(repoDir) {
  try {
    const parsed = JSON.parse(await readFile(join(repoDir, TOMBSTONES_FILE), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.sessions !== null && typeof parsed.sessions === 'object') {
      const sessions = {}
      for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
        if (typeof sessionId !== 'string' || sessionId === '') continue
        sessions[sessionId] = normalizeEntry(entry)
      }
      return { version: TOMBSTONES_VERSION, sessions }
    }
  } catch {
    // файла ещё нет
  }
  return { version: TOMBSTONES_VERSION, sessions: {} }
}

/** Записать надгробия с нормализованными полями. */
export async function writeTombstones(repoDir, data) {
  const sessions = {}
  for (const [sessionId, entry] of Object.entries(data?.sessions ?? {})) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    sessions[sessionId] = normalizeEntry(entry)
  }
  await mkdir(repoDir, { recursive: true })
  await writeFile(
    join(repoDir, TOMBSTONES_FILE),
    `${JSON.stringify({ version: TOMBSTONES_VERSION, sessions }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Действует ли пометка: «снятая» (reason=restored) больше не удаляет сессию —
 * она оставлена в истории как след отмены.
 */
export function isActiveTombstone(entry) {
  return entry !== null && entry !== undefined && typeof entry === 'object' && entry.reason !== 'restored'
}

/**
 * Добавить метку удаления.
 *
 * @param data — надгробия (результат readTombstones).
 * @param sessionId — удалённая сессия.
 * @param deviceId — устройство, где произошло удаление.
 * @param meta — { reason, by, title, size, bytes, replaced, projectId }.
 */
export function addTombstone(data, sessionId, deviceId, meta = {}) {
  const entry = {
    at: isoNow(meta.at),
    device: typeof deviceId === 'string' && deviceId !== '' ? deviceId : 'device',
    reason: TOMBSTONE_REASONS.includes(meta.reason) ? meta.reason : 'manual',
    by: TOMBSTONE_BY.includes(meta.by) ? meta.by : 'owner',
  }
  const title = text(meta.title).trim()
  if (title !== '') entry.title = title.slice(0, 160)
  if (Number.isFinite(meta.size) && meta.size > 0) entry.size = Math.trunc(meta.size)
  if (Number.isFinite(meta.bytes) && meta.bytes > 0) entry.bytes = Math.trunc(meta.bytes)
  if (meta.replaced === true) entry.replaced = true
  if (text(meta.projectId) !== '') entry.projectId = meta.projectId
  data.sessions[sessionId] = entry
  return data
}

/** Убрать пометку совсем. */
export function dropTombstone(data, sessionId) {
  if (data.sessions[sessionId] !== undefined) {
    delete data.sessions[sessionId]
    return true
  }
  return false
}

/**
 * Снять пометку удаления в git-состоянии: пометить restored.
 *
 * Такая запись остаётся в файле как история, но приём и отправка её больше не
 * применяют: сессия возвращена. Ближайшая отправка вычистит исторические
 * пометки, поэтому файл не растёт.
 */
export function markRestored(data, sessionId, meta = {}) {
  const entry = data.sessions[sessionId]
  if (entry === undefined) return undefined
  entry.restoredFrom = entry.reason
  entry.reason = 'restored'
  entry.by = TOMBSTONE_BY.includes(meta.by) ? meta.by : 'owner'
  entry.restoredAt = isoNow(meta.at)
  entry.restoredBy = entry.by
  if (text(meta.device) !== '') entry.restoredDevice = meta.device
  return entry
}

/** Отметить истёкший карантин: восстановить уже нельзя, пометка остаётся. */
export function markExpired(data, sessionId, meta = {}) {
  const entry = data.sessions[sessionId]
  if (entry === undefined || !isActiveTombstone(entry)) return undefined
  entry.reason = 'expired'
  entry.by = TOMBSTONE_BY.includes(meta.by) ? meta.by : 'sync'
  entry.expiredAt = isoNow(meta.at)
  entry.expiredBy = entry.by
  return entry
}

/**
 * Свежие ручные пометки, которые ещё не попали в коммит зеркала.
 *
 * Панельное удаление пишет `tombstones.json` сразу, а перед отправкой
 * git-зеркало приводится к удалённой ветке (`fetch` + `reset --hard`) — без
 * этого переноса только что записанная пометка была бы затёрта и удаление
 * стало бы «автоматическим» (prune/sync). Берём только manual/owner не старше
 * 15 минут: старые записи уже не «свежие изменения», а история.
 *
 * @param data — надгробия, прочитанные до синхронизации рабочего дерева.
 * @param options.now — текущее время, maxAgeMs — окно свежести.
 * @returns объект сессия → метка.
 */
export function pendingManualTombstones(data, { now = Date.now(), maxAgeMs = 15 * 60_000 } = {}) {
  const result = {}
  const current = Number.isFinite(now) ? now : Date.now()
  for (const [sessionId, entry] of Object.entries(data?.sessions ?? {})) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.reason !== 'manual' || entry.by !== 'owner') continue
    const atMs = Date.parse(text(entry.at))
    if (!Number.isFinite(atMs) || current - atMs > maxAgeMs) continue
    result[sessionId] = { ...entry }
  }
  return result
}

/**
 * Добавить свежие ручные пометки, которых нет в прочитанных после
 * синхронизации надгробиях.
 * @returns сколько пометок перенесено.
 */
export function mergePendingManualTombstones(data, pending) {
  let merged = 0
  for (const [sessionId, entry] of Object.entries(pending ?? {})) {
    if (data.sessions[sessionId] !== undefined) continue
    data.sessions[sessionId] = { ...entry }
    merged += 1
  }
  return merged
}

/** Путь карантинной копии сессии в зеркале. */
export function quarantinePath(repoDir, projectId, sessionId) {
  return join(repoDir, 'sessions', projectId, QUARANTINE_DIR, encodeSegment(sessionId))
}

async function readJsonSafe(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

async function projectDirs(repoDir) {
  try {
    const entries = await readdir(join(repoDir, 'sessions'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

/** Найти карантинную копию сессии в зеркале (проект может быть неизвестен). */
async function findMirrorQuarantine(repoDir, sessionId, projectHint) {
  const ordered = []
  if (text(projectHint) !== '') ordered.push(projectHint)
  for (const projectId of await projectDirs(repoDir)) {
    if (!ordered.includes(projectId)) ordered.push(projectId)
  }
  for (const projectId of ordered) {
    const dir = quarantinePath(repoDir, projectId, sessionId)
    if (existsSync(dir)) return { projectId, dir }
  }
  return undefined
}

/** Найти активную копию сессии в зеркале. */
async function findMirrorSession(repoDir, sessionId, projectHint) {
  const ordered = []
  if (text(projectHint) !== '') ordered.push(projectHint)
  for (const projectId of await projectDirs(repoDir)) {
    if (!ordered.includes(projectId)) ordered.push(projectId)
  }
  for (const projectId of ordered) {
    const dir = join(repoDir, 'sessions', projectId, encodeSegment(sessionId))
    if (existsSync(join(dir, LOG_NAME))) return { projectId, dir }
  }
  return undefined
}

/** Найти локальный архив удалённой сессии: ~/.dsh/dsh-sync/deleted/<время>/<id>. */
async function findLocalQuarantine(home, sessionId) {
  const root = join(home, 'dsh-sync', 'deleted')
  const segment = encodeSegment(sessionId)
  let stamps = []
  try {
    stamps = (await readdir(root)).sort().reverse()
  } catch {
    return undefined
  }
  for (const stamp of stamps) {
    const dir = join(root, stamp, segment)
    if (existsSync(dir)) return { dir, stamp }
  }
  return undefined
}

/** Название сессии из описания рядом с карантинной копией. */
async function titleOfQuarantine(dir) {
  const sidecar = await readJsonSafe(join(dir, SESSION_SIDECAR_FILE))
  const title = text(sidecar?.title).trim()
  return title
}

/**
 * Список удалённых сессий для панели.
 *
 * @param options.home — каталог DSH (там локальный архив удалённых копий).
 * @param options.repoDir — каталог зеркала.
 * @param options.projects — projects из конфигурации (id → { path, title }).
 * @param options.now — текущее время в мс (для тестов).
 * @returns массив меток, свежие сверху; снятые (restored) не показываются.
 */
export async function listTombstones({ home, repoDir, projects = {}, now = Date.now() } = {}) {
  const data = await readTombstones(repoDir)
  const current = Number.isFinite(now) ? now : Date.now()
  const result = []
  for (const [sessionId, entry] of Object.entries(data.sessions)) {
    if (!isActiveTombstone(entry)) continue
    const quarantine = await findMirrorQuarantine(repoDir, sessionId, entry.projectId)
    const local = home === undefined ? undefined : await findLocalQuarantine(home, sessionId)
    const projectId = quarantine?.projectId ?? text(entry.projectId)
    const liveInMirror = projectId === '' ? undefined : existsSync(join(repoDir, 'sessions', projectId, encodeSegment(sessionId), LOG_NAME))
    const title = quarantine === undefined ? text(entry.title).trim() : await titleOfQuarantine(quarantine.dir)
    const atMs = Date.parse(text(entry.at))
    const expiresMs = Number.isFinite(atMs) ? atMs + QUARANTINE_DAYS * DAY_MS : undefined
    const rawDays = expiresMs === undefined ? QUARANTINE_DAYS : Math.max(0, Math.ceil((expiresMs - current) / DAY_MS))
    const expired = entry.reason === 'expired'
      || (quarantine === undefined && local === undefined && !liveInMirror && rawDays === 0)
    const remainingDays = expired ? 0 : rawDays
    result.push({
      id: sessionId,
      title: title !== '' ? title.slice(0, 120) : '',
      at: entry.at,
      device: entry.device ?? '',
      reason: entry.reason,
      by: entry.by,
      projectId,
      projectTitle: text(projects?.[projectId]?.title),
      size: entry.size,
      bytes: entry.bytes,
      quarantined: quarantine !== undefined,
      localQuarantined: local !== undefined,
      liveInMirror: liveInMirror === true,
      expiresAt: expiresMs === undefined ? undefined : new Date(expiresMs).toISOString(),
      remainingDays,
      expired,
      canRestore: entry.reason !== 'expired',
    })
  }
  result.sort((left, right) => String(right.at).localeCompare(String(left.at)))
  return result
}

/**
 * Вернуть локальную копию из архива: заголовок переписывается на локальный путь.
 * @returns true, если копия восстановлена.
 */
async function restoreLocalFromArchive(sourceDir, targetDir, projectPath) {
  try {
    await mkdir(targetDir, { recursive: true })
    const logPath = join(sourceDir, LOG_NAME)
    if (existsSync(logPath)) {
      const bytes = await readFile(logPath)
      await writeFile(join(targetDir, LOG_NAME), remapTo(bytes, projectPath))
    } else {
      for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name !== DELETED_AT_FILE) {
          await copyFile(join(sourceDir, entry.name), join(targetDir, entry.name))
        }
      }
    }
    await rm(sourceDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Вернуть локальную копию из лога зеркала (архива на этом устройстве нет). */
async function restoreLocalFromMirror(mirrorDir, targetDir, projectPath) {
  try {
    const bytes = await readFile(join(mirrorDir, LOG_NAME))
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, LOG_NAME), remapTo(bytes, projectPath))
    return true
  } catch {
    return false
  }
}

/**
 * Восстановить удалённые сессии.
 *
 * Для каждой метки: карантинная копия зеркала возвращается на своё место, а
 * локальная копия — из архива этого устройства (или из лога зеркала), если
 * проект настроен. Пометка удаления становится restored.
 *
 * @param options.home — каталог DSH.
 * @param options.repoDir — каталог зеркала.
 * @param options.ids — конкретные сессии; не задано — все активные пометки.
 * @param options.projects — projects из конфигурации.
 * @param options.deviceId — устройство, выполняющее восстановление.
 * @param options.by — owner или sync.
 * @param options.now — время для тестов.
 */
export async function restoreTombstones({ home, repoDir, ids, projects = {}, deviceId = 'device', by = 'owner', now = Date.now() } = {}) {
  const data = await readTombstones(repoDir)
  const requested = Array.isArray(ids) && ids.length > 0
    ? [...new Set(ids.filter(id => typeof id === 'string' && id !== ''))]
    : Object.keys(data.sessions).filter(sessionId => isActiveTombstone(data.sessions[sessionId]))
  const result = { restored: [], restoredIds: [], skipped: [], failed: [], mirror: 0, local: 0 }
  let dirty = false

  for (const sessionId of requested) {
    const entry = data.sessions[sessionId]
    if (entry === undefined || !isActiveTombstone(entry)) {
      result.skipped.push(sessionId)
      continue
    }
    if (entry.reason === 'expired') {
      // Карантин вычищен: восстановить уже нечего, но пометку оставляем как
      // защиту от «воскрешения» сессии старым устройством.
      result.skipped.push(sessionId)
      continue
    }
    try {
      const quarantine = await findMirrorQuarantine(repoDir, sessionId, entry.projectId)
      const projectId = quarantine?.projectId ?? text(entry.projectId)
      const projectPath = projectId !== '' && typeof projects?.[projectId]?.path === 'string' ? projects[projectId].path : ''
      let mirrorRestored = false

      if (quarantine !== undefined && projectId !== '') {
        const target = join(repoDir, 'sessions', projectId, encodeSegment(sessionId))
        if (existsSync(join(target, LOG_NAME))) {
          mirrorRestored = true // копия уже вернулась
        } else {
          await mkdir(dirname(target), { recursive: true })
          await rename(quarantine.dir, target)
          await rm(join(target, DELETED_AT_FILE), { force: true })
          mirrorRestored = true
        }
      }

      let localRestored = false
      if (home !== undefined && projectPath !== '') {
        const localDir = localSessionDir(home, projectPath, sessionId)
        if (existsSync(localDir)) {
          localRestored = true
        } else {
          const archive = await findLocalQuarantine(home, sessionId)
          if (archive !== undefined) {
            localRestored = await restoreLocalFromArchive(archive.dir, localDir, projectPath)
          } else if (mirrorRestored) {
            localRestored = await restoreLocalFromMirror(
              join(repoDir, 'sessions', projectId, encodeSegment(sessionId)),
              localDir,
              projectPath,
            )
          }
        }
      }

      if (!mirrorRestored && !localRestored) {
        // Карантина нет: возможно, сессия уже вернулась в зеркало другим путём.
        const live = await findMirrorSession(repoDir, sessionId, entry.projectId)
        if (live === undefined) {
          result.failed.push({ id: sessionId, message: 'карантин не найден — восстанавливать нечего' })
          continue
        }
        mirrorRestored = true
      }

      markRestored(data, sessionId, { by, device: deviceId, at: now })
      dirty = true
      result.restored.push({ id: sessionId, projectId, mirror: mirrorRestored, local: localRestored })
      result.restoredIds.push(sessionId)
      if (mirrorRestored) result.mirror += 1
      if (localRestored) result.local += 1
    } catch (error) {
      result.failed.push({ id: sessionId, message: error instanceof Error ? error.message : String(error) })
    }
  }

  if (dirty) await writeTombstones(repoDir, data)
  result.ok = result.failed.length === 0
  return result
}
