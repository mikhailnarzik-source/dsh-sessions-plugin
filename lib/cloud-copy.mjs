/**
 * Облачная копия локальной сессии.
 *
 * Когда сессию перевели в режим «локальная», её копия в зеркале остаётся:
 * движок синхронизации специально не удаляет такие копии, чтобы режим был
 * обещанием «данные живут только здесь» (см. session-modes.mjs). Но копия в
 * облаке — это данные, и у пользователя должно быть отдельное явное действие
 * «Удалить копию из облака»: только зеркальная копия, локальная сессия цела.
 *
 * Здесь — файловая часть действия: найти копию в зеркале, перенести её в
 * карантин 30 дней (`sessions/<проект>/_deleted/<id>/`), записать метку
 * удаления `reason=manual/by=owner`. Отправку в удалённое хранилище делает
 * host-часть (маршрут `/api/dsh-sync/session-cloud-copy`), как и у
 * восстановления: движок не должен сам решать, когда ходить в сеть.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeSegment } from './format.mjs'
import {
  DELETED_AT_FILE,
  SESSION_SIDECAR_FILE,
  addTombstone,
  isActiveTombstone,
  quarantinePath,
  readTombstones,
  writeTombstones,
} from './tombstones.mjs'
import { LOG_NAME } from './store.mjs'
import { isLocalSession, readSessionModes } from './session-modes.mjs'

/** Каталог облачной копии сессии в зеркале. */
export function cloudCopyPath(repoDir, projectId, sessionId) {
  return join(repoDir, 'sessions', projectId, encodeSegment(sessionId))
}

/** Проект зеркала, в котором лежит копия этой сессии (или undefined). */
export function findCloudCopyProject(config, sessionId) {
  for (const projectId of Object.keys(config?.projects ?? {})) {
    if (existsSync(cloudCopyPath(config.repoDir, projectId, sessionId))) return projectId
  }
  return undefined
}

/**
 * Прочитать то, что известно об облачной копии: проект, размер, название.
 * Ничего не меняет — панель показывает подсказку «в облаке есть копия».
 */
export async function inspectCloudCopy({ home, config, sessionId, modes }) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') return { ok: false, code: 'request/invalid', message: 'нужен идентификатор сессии' }
  const sessionModes = modes ?? await readSessionModes(home ?? '')
  if (!isLocalSession(sessionModes, id)) {
    return { ok: false, code: 'not-local', message: 'сессия не в режиме «локальная»: облачная копия — её обычное состояние' }
  }
  const projectId = findCloudCopyProject(config, id)
  if (projectId === undefined) {
    return { ok: false, code: 'no-cloud-copy', message: 'облачной копии нет: сессия уже живёт только здесь' }
  }
  const dir = cloudCopyPath(config.repoDir, projectId, id)
  let bytes
  try {
    bytes = (await stat(join(dir, LOG_NAME))).size
  } catch {
    bytes = undefined
  }
  let title = ''
  try {
    const sidecar = JSON.parse(await readFile(join(dir, SESSION_SIDECAR_FILE), 'utf8'))
    if (typeof sidecar?.title === 'string') title = sidecar.title.trim()
  } catch {
    // описания может не быть
  }
  return { ok: true, projectId, bytes, title, path: dir }
}

/**
 * Удалить только облачную копию локальной сессии: карантин зеркала + метка
 * удаления manual/owner. Локальный лог и запись режима не трогаются.
 *
 * @param home каталог DSH
 * @param config конфигурация плагина (нужны repoDir, projects, deviceId)
 * @param sessionId идентификатор сессии
 * @param options.modes — уже прочитанные режимы (необязательно)
 * @param options.title — название для метки, если sidecar пуст
 * @returns {{ ok: boolean, code?: string, message?: string, projectId?, quarantined?, bytes?, title?, reason?, by? }}
 */
export async function deleteCloudCopy({ home, config, sessionId, options = {} }) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') return { ok: false, code: 'request/invalid', message: 'нужен идентификатор сессии' }
  if (typeof config?.repoDir !== 'string' || config.repoDir === '') {
    return { ok: false, code: 'no-mirror', message: 'зеркало ещё не настроено — удалять нечего' }
  }
  const modes = options.modes ?? await readSessionModes(home)
  // Режим — условие действия: пока сессия облачная, её копия в зеркале нужна.
  if (!isLocalSession(modes, id)) {
    return { ok: false, code: 'not-local', message: 'сессия снова облачная: облачную копию удалять не нужно' }
  }
  const projectId = findCloudCopyProject(config, id)
  if (projectId === undefined) {
    return { ok: false, code: 'no-cloud-copy', message: 'облачной копии нет: сессия уже живёт только здесь' }
  }

  const dir = cloudCopyPath(config.repoDir, projectId, id)
  let bytes
  try {
    bytes = (await stat(join(dir, LOG_NAME))).size
  } catch {
    bytes = undefined
  }
  let title = typeof options.title === 'string' ? options.title.trim() : ''
  try {
    const sidecar = JSON.parse(await readFile(join(dir, SESSION_SIDECAR_FILE), 'utf8'))
    if (title === '' && typeof sidecar?.title === 'string') title = sidecar.title.trim()
  } catch {
    // описания может не быть — метка покажет идентификатор
  }

  // Карантин вместо удаления: 30 дней можно вернуть кнопкой «Восстановить».
  const target = quarantinePath(config.repoDir, projectId, id)
  await mkdir(dirname(target), { recursive: true })
  if (existsSync(target)) await rm(target, { recursive: true, force: true })
  try {
    await rename(dir, target)
  } catch {
    // Перенести не вышло (файл занят): копию придётся удалить без карантина.
    await rm(dir, { recursive: true, force: true })
  }
  const deletedAt = {
    at: new Date().toISOString(),
    reason: 'manual',
    reasonLabel: 'удалено пользователем, локальная копия осталась',
    by: 'owner',
    device: config.deviceId ?? 'device',
    projectId,
  }
  if (title !== '') deletedAt.title = title
  if (bytes !== undefined) deletedAt.bytes = bytes
  try {
    await writeFile(join(target, DELETED_AT_FILE), `${JSON.stringify(deletedAt)}\n`, 'utf8')
  } catch {
    // описание необязательно: метка удаления всё равно останется
  }

  // Метка надёжнее одной папки: другая отправка не «воскресит» сессию, а
  // панель «Удалённые» покажет причину manual и автора owner.
  const tombstones = await readTombstones(config.repoDir)
  const existing = tombstones.sessions[id]
  if (existing === undefined || !isActiveTombstone(existing)) {
    addTombstone(tombstones, id, config.deviceId ?? 'device', {
      reason: 'manual',
      by: 'owner',
      title,
      size: 1,
      bytes,
      projectId,
    })
    await writeTombstones(config.repoDir, tombstones)
  }

  return {
    ok: true,
    projectId,
    quarantined: true,
    bytes,
    title,
    reason: 'manual',
    by: 'owner',
    message: 'облачная копия удалена, локальная сессия осталась',
  }
}
