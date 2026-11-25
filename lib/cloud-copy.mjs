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
 *
 * Отдельно — режим «локальная навсегда» (переключение облачная → локальная):
 * `makeSessionLocal` пишет объявление в зеркальный `local-only.json`, уносит
 * облачную копию в карантин с причиной `made-local` и ставит такую же метку
 * удаления. Метка `made-local` не снимается никогда (`lib/sync.mjs`), поэтому
 * копия не воскресает ни при отправке, ни при приёме. Обратное действие
 * `makeSessionCloud` снимает объявление и метку и возвращает режим «облачная».
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeSegment } from './format.mjs'
import {
  DELETED_AT_FILE,
  SESSION_SIDECAR_FILE,
  addTombstone,
  dropTombstone,
  isActiveTombstone,
  quarantinePath,
  readTombstones,
  writeTombstones,
} from './tombstones.mjs'
import { LOG_NAME, localSessionDir } from './store.mjs'
import {
  MODE_CLOUD,
  MODE_LOCAL,
  applyLocalOnlyModes,
  declareLocalOnly,
  existingSessionIds,
  isLocalSession,
  localOnlyIds,
  mergeLocalOnly,
  mergeLocalOnlyState,
  normalizeSessionId,
  pruneSessionModes,
  publishLocalOnly,
  readLocalOnly,
  readSessionModes,
  setSessionMode,
  undeclareLocalOnly,
  writeLocalOnly,
} from './session-modes.mjs'

/** Причина метки удаления для «убрать копию из облака»: локальная навсегда. */
export const MADE_LOCAL_REASON = 'made-local'

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

/** Размер лога и название облачной копии (для карантина и меток). */
async function readCopyInfo(dir, fallbackTitle = '') {
  let bytes
  try {
    bytes = (await stat(join(dir, LOG_NAME))).size
  } catch {
    bytes = undefined
  }
  let title = typeof fallbackTitle === 'string' ? fallbackTitle.trim() : ''
  try {
    const sidecar = JSON.parse(await readFile(join(dir, SESSION_SIDECAR_FILE), 'utf8'))
    if (title === '' && typeof sidecar?.title === 'string') title = sidecar.title.trim()
  } catch {
    // описания может не быть
  }
  return { bytes, title }
}

/**
 * Перенести каталог облачной копии в 30-дневный карантин и записать причину.
 * Возвращает метку `deleted-at.json` (её же видит панель «Удалённые»).
 */
async function quarantineCopy({ config, projectId, sessionId, reason, by = 'owner', title = '', bytes, reasonLabel }) {
  const dir = cloudCopyPath(config.repoDir, projectId, sessionId)
  const target = quarantinePath(config.repoDir, projectId, sessionId)
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
    reason,
    reasonLabel,
    by,
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
  return { target, deletedAt }
}

/**
 * Поставить метку удаления с нужной причиной. `made-local` — обещание, что
 * сессия живёт только здесь: движок такую метку не снимает никогда.
 */
async function ensureTombstone({ config, sessionId, reason, title = '', bytes, projectId, force = false }) {
  const tombstones = await readTombstones(config.repoDir)
  const existing = tombstones.sessions[sessionId]
  const active = existing !== undefined && isActiveTombstone(existing)
  // Уже стоит более специфичная метка (made-local) — не понижаем её до manual.
  if (active && existing.reason === MADE_LOCAL_REASON && reason !== MADE_LOCAL_REASON) return false
  if (active && existing.reason === reason && !force) return false
  addTombstone(tombstones, sessionId, config.deviceId ?? 'device', {
    reason,
    by: 'owner',
    title,
    size: 1,
    bytes,
    projectId,
  })
  await writeTombstones(config.repoDir, tombstones)
  return true
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
  const { bytes, title } = await readCopyInfo(dir, options.title)

  // Карантин вместо удаления: 30 дней можно вернуть кнопкой «Восстановить».
  await quarantineCopy({
    config,
    projectId,
    sessionId: id,
    reason: 'manual',
    by: 'owner',
    title,
    bytes,
    reasonLabel: 'удалено пользователем, локальная копия осталась',
  })

  // Метка надёжнее одной папки: другая отправка не «воскресит» сессию, а
  // панель «Удалённые» покажет причину manual и автора owner.
  await ensureTombstone({ config, sessionId: id, reason: 'manual', title, bytes, projectId })

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

// --- «локальная навсегда»: переключение режима ----------------------------

/** Домашний реестр объявлений (создаётся по требованию). */
async function readRegistries({ home, repoDir }) {
  const local = await readLocalOnly(join(home, 'dsh-sync'))
  const mirror = typeof repoDir === 'string' && repoDir !== ''
    ? await readLocalOnly(repoDir)
    : { version: 1, updatedAt: '', sessions: {} }
  return { local, mirror, data: mergeLocalOnlyState(local, mirror) }
}

/** Записать объявления в домашний реестр и (если есть) в зеркало. */
async function writeRegistries({ home, repoDir, data }) {
  await writeLocalOnly(join(home, 'dsh-sync'), data)
  if (typeof repoDir === 'string' && repoDir !== '') await writeLocalOnly(repoDir, data)
}

/**
 * «Убрать копию из облака»: сессия становится локальной навсегда.
 *
 * Один шаг делает всё, что должно пережить pull, reset и перезапуск:
 * 1) режим `local` в `session-modes.json` (это устройство);
 * 2) объявление в зеркальном `local-only.json` (все устройства);
 * 3) облачная копия — в карантин `_deleted` с причиной `made-local`;
 * 4) метка удаления `made-local` — движок её не снимает никогда.
 *
 * Сеть не трогается: коммит и отправку делает host-часть, при офлайне операция
 * уходит в очередь (`lib/outbox.mjs`).
 *
 * @returns {{ ok: boolean, code?, message?, sessionId?, mode?, declared?, quarantined?, projectId?, bytes?, title?, declarations? }}
 */
export async function makeSessionLocal({ home, config, sessionId, options = {} }) {
  const id = normalizeSessionId(sessionId)
  if (id === '') return { ok: false, code: 'request/invalid', message: 'нужен идентификатор сессии' }
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  // Устаревший запрос из UI (после падения/восстановления) может прийти с id
  // сессии, которой уже нет ни локально, ни в зеркале. Такой id не должен
  // создавать объявление, метку и фантомный режим «локальная».
  const projectPaths = Object.values(config?.projects ?? {})
    .map((entry) => entry?.path)
    .filter((path) => typeof path === 'string' && path !== '')
  const existsLocal = projectPaths.some((projectPath) => existsSync(localSessionDir(home, projectPath, id)))
  const existsMirror = findCloudCopyProject(config, id) !== undefined
  if (!existsLocal && !existsMirror) {
    return { ok: false, code: 'session/not-found', sessionId: id, message: 'сессия не найдена ни локально, ни в зеркале — режим и объявление не созданы' }
  }
  // Режим устройства ставим всегда: даже без зеркала это осмысленное действие.
  const modeResult = await setSessionMode(home, [id], MODE_LOCAL)
  if (repoDir === '') {
    return {
      ok: true,
      sessionId: id,
      mode: MODE_LOCAL,
      declared: false,
      quarantined: false,
      changed: modeResult.changed,
      message: 'сессия локальная; зеркало не настроено — объявлять нечего',
    }
  }

  const { data } = await readRegistries({ home, repoDir })
  const declaration = declareLocalOnly(data, id, {
    declaredBy: typeof options.declaredBy === 'string' && options.declaredBy !== ''
      ? options.declaredBy
      : (config?.deviceId ?? 'device'),
    at: options.at,
  })
  await writeRegistries({ home, repoDir, data })

  const projectId = findCloudCopyProject(config, id)
  let quarantined = false
  let bytes
  let title = typeof options.title === 'string' ? options.title.trim() : ''
  if (projectId !== undefined) {
    const info = await readCopyInfo(cloudCopyPath(repoDir, projectId, id), title)
    bytes = info.bytes
    title = info.title
    await quarantineCopy({
      config,
      projectId,
      sessionId: id,
      reason: MADE_LOCAL_REASON,
      by: 'owner',
      title,
      bytes,
      reasonLabel: 'переведена в локальные: копия убрана из облака',
    })
    quarantined = true
  }
  // Метка нужна и без копии: иначе чужое устройство вернуло бы сессию в облако.
  await ensureTombstone({ config, sessionId: id, reason: MADE_LOCAL_REASON, title, bytes, projectId })

  return {
    ok: true,
    sessionId: id,
    mode: MODE_LOCAL,
    declared: declaration.declared === true,
    declaration: declaration.entry,
    quarantined,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(title !== '' ? { title } : {}),
    changed: modeResult.changed,
    declarations: localOnlyIds(data).length,
    message: quarantined
      ? 'сессия локальная навсегда: облачная копия убрана в карантин'
      : 'сессия локальная навсегда: облачной копии не было',
  }
}

/**
 * «Сделать облачной»: снять объявление и метку `made-local`, вернуть режим
 * `cloud`. Отправку делает host-часть (обычный push): после снятия обещания
 * сессия снова участвует в обмене.
 */
export async function makeSessionCloud({ home, config, sessionId }) {
  const id = normalizeSessionId(sessionId)
  if (id === '') return { ok: false, code: 'request/invalid', message: 'нужен идентификатор сессии' }
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  const { local, mirror, data } = await readRegistries({ home, repoDir })
  const removedHome = undeclareLocalOnly(local, id)
  const removedMirror = undeclareLocalOnly(mirror, id)
  const merged = mergeLocalOnly(local, mirror)
  undeclareLocalOnly(merged, id)
  await writeLocalOnly(join(home, 'dsh-sync'), merged)
  if (repoDir !== '') await writeLocalOnly(repoDir, merged)

  const modeResult = await setSessionMode(home, [id], MODE_CLOUD)

  // Снимаем только своё обещание: чужие причины удаления не трогаем.
  let tombstoneDropped = false
  if (repoDir !== '') {
    const tombstones = await readTombstones(repoDir)
    const existing = tombstones.sessions[id]
    if (existing !== undefined && existing.reason === MADE_LOCAL_REASON) {
      tombstoneDropped = dropTombstone(tombstones, id)
      if (tombstoneDropped) await writeTombstones(repoDir, tombstones)
    }
  }

  return {
    ok: true,
    sessionId: id,
    mode: MODE_CLOUD,
    undeclared: removedHome || removedMirror || data?.sessions?.[id] !== undefined,
    tombstoneDropped,
    changed: modeResult.changed,
    message: 'сессия снова облачная: объявление снято, копия отправится при синхронизации',
  }
}

/**
 * Что предлагает миграция: локальные сессии, у которых в зеркале осталась
 * копия. Это следы прежних версий: режим «локальная» уже стоял, а копию в
 * облаке ещё не убрали.
 *
 * @returns {{ ok: boolean, count: number, sessions: Array<{id, projectId, bytes?, title, declared}> }}
 */
export async function localOnlyMigrationCandidates({ home, config }) {
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  if (repoDir === '') return { ok: true, count: 0, sessions: [] }
  const { data } = await readRegistries({ home, repoDir })
  const modes = await readSessionModes(home)
  const declared = new Set(localOnlyIds(data))
  const ids = new Set(declared)
  for (const [id, mode] of Object.entries(modes.sessions ?? {})) {
    if (mode === MODE_LOCAL) ids.add(normalizeSessionId(id))
  }
  const sessions = []
  for (const id of [...ids].sort()) {
    const projectId = findCloudCopyProject(config, id)
    if (projectId === undefined) continue
    const info = await readCopyInfo(cloudCopyPath(repoDir, projectId, id))
    sessions.push({
      id,
      projectId,
      ...(info.bytes !== undefined ? { bytes: info.bytes } : {}),
      title: info.title,
      declared: declared.has(id),
    })
  }
  return { ok: true, count: sessions.length, sessions }
}

/** Прочитать объявления «локальная навсегда» (домашний реестр + зеркало). */
export async function localOnlyState({ home, config }) {
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  const { data } = await readRegistries({ home, repoDir })
  return { ...data, ids: localOnlyIds(data) }
}

/**
 * Привести зеркало в согласие с объявлениями «локальная навсегда»:
 * - опубликовать объявления (домашний реестр → зеркало), чтобы reset не терял их;
 * - записать локальный режим всем объявленным (push/pull его уже пропускают);
 * - убрать в карантин копии, которые вернуло чужое устройство (made-local);
 * - убедиться, что метка `made-local` стоит.
 *
 * Идемпотентна: повторный вызов ничего не меняет и не создаёт дублей.
 */
export async function enforceLocalOnly({ home, config, modes }) {
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  const published = await publishLocalOnly({ home, repoDir })
  const declared = localOnlyIds(published.data)
  const existingIds = await existingSessionIds(home)
  const modeResult = await applyLocalOnlyModes(home, declared, { modes, existingIds })
  // Фантомные режимы (ids, которых давно нет в сторе) чистим при каждой
  // синхронизации: иначе счётчик «локальных» в панели завышен.
  const prunedModes = await pruneSessionModes(home, { modes: modeResult.modes, existingIds })
  let removed = 0
  let tombstoneAdded = 0
  let repoChanged = published.repoChanged
  const removedIds = []
  for (const id of declared) {
    let projectId
    let bytes
    let title = ''
    if (repoDir !== '') {
      projectId = findCloudCopyProject(config, id)
      if (projectId !== undefined) {
        const info = await readCopyInfo(cloudCopyPath(repoDir, projectId, id))
        bytes = info.bytes
        title = info.title
        await quarantineCopy({
          config,
          projectId,
          sessionId: id,
          reason: MADE_LOCAL_REASON,
          by: 'owner',
          title,
          bytes,
          reasonLabel: 'переведена в локальные: копия убрана из облака',
        })
        removed += 1
        removedIds.push(id)
        repoChanged = true
      }
      if (await ensureTombstone({ config, sessionId: id, reason: MADE_LOCAL_REASON, title, bytes, projectId })) {
        tombstoneAdded += 1
        repoChanged = true
      }
    }
  }
  return {
    ok: true,
    declarations: declared.length,
    declaredIds: declared.slice(0, 100),
    removed,
    removedIds,
    tombstoneAdded,
    modesChanged: modeResult.changed.length,
    changed: published.changed || repoChanged || modeResult.changed.length > 0,
    repoChanged,
  }
}
