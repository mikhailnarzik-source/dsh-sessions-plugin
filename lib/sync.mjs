/**
 * push/pull: перенос сессий между локальным стором и git-зеркалом.
 *
 * Модель слияния опирается на append-only природу лога: хвост после заголовка
 * у обеих сторон начинается с общих байт, поэтому «один хвост — префикс
 * другого» означает, что одна сторона просто дописала события. Полное
 * расхождение (обе дописали своё) не склеивается: удалённая версия
 * импортируется отдельной сессией, локальная остаётся нетронутой.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { LOG_NAME, canonicalize, isLocked, listLocalSessions, listMirrorSessions, localSessionDir, mirrorLogPath, remapTo, sessionsOfProject, splitLog } from './store.mjs'
import { encodeSegment } from './format.mjs'
import { git } from './git.mjs'
import { createRemote } from './remote.mjs'
import { mergeDevice, readMeta, writeMeta } from './mirror-meta.mjs'
import { pullAttachments, pushAttachments } from './attachments.mjs'
import { markSynced, readLedger, writeLedger } from './ledger.mjs'
import {
  DELETED_AT_FILE,
  QUARANTINE_DAYS,
  QUARANTINE_DIR,
  SESSION_SIDECAR_FILE,
  addTombstone,
  dropTombstone,
  isActiveTombstone,
  markExpired,
  mergePendingManualTombstones,
  pendingManualTombstones,
  quarantinePath,
  readTombstones,
  writeTombstones,
} from './tombstones.mjs'
import { repairLog } from './repair.mjs'
import { writeCatalog } from './catalog.mjs'
import { createNeutralizer } from './neutralize.mjs'
import { pullProfile, pushProfile } from './profile.mjs'
import { pullWorkspace, pushWorkspace } from './workspace.mjs'
import { applyWorkspaceDefaults, normalizeSessionId, resolveGroupModes } from './session-modes.mjs'
import { buildSessionGroups, descendantsOf, orderParentsFirst } from './session-groups.mjs'
import { CHILDREN_REASON, PRUNE_MAX_COUNT, PRUNE_MAX_RATIO, missingChildren, planDeletions } from './deletions.mjs'
import { readSyncState, writeSyncState } from './sync-state.mjs'
import { LOG_FORMAT } from './frames.mjs'

function tailOf(bytes) {
  return splitLog(bytes).tail
}

// --- защита от массового удаления ------------------------------------------

/** Пороги массового удаления: общие для плана и подтверждённого действия. */
export { PRUNE_MAX_COUNT, PRUNE_MAX_RATIO } from './deletions.mjs'
/** Папка карантина и срок хранения — общие для движка и панели «Удалённые». */
export { QUARANTINE_DAYS, QUARANTINE_DIR }
/** Формат лога сессий, который умеет читать эта сборка плагина. */
export { LOG_FORMAT }

/** Сравнить версии вида 1.2.3: >0 если a новее b. Некорректные строки — лексикографически. */
export function compareVersions(a, b) {
  const parse = (value) => String(value).trim().split(/[.+-]/).map(part => Number.parseInt(part, 10))
  const left = parse(a)
  const right = parse(b)
  if (left.every(part => Number.isFinite(part)) && right.every(part => Number.isFinite(part))) {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/**
 * Версия DSH, в котором работает эта сборка плагина. Ищется в окружении
 * (DSH_SYNC_DSH_VERSION ставит host-часть дочернему процессу, DSH_VERSION —
 * сам DSH), затем в package.json из DSH_INSTALL_DIR (внутри app.asar читается
 * только в host-процессе Electron).
 */
export async function detectDshVersion() {
  const env = [process.env.DSH_SYNC_DSH_VERSION, process.env.DSH_VERSION].find(value => typeof value === 'string' && value.trim() !== '')
  if (env !== undefined) return env.trim()
  const dir = process.env.DSH_INSTALL_DIR
  if (typeof dir === 'string' && dir !== '') {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (typeof manifest?.version === 'string' && manifest.version !== '') return manifest.version
    } catch {
      // не удалось прочитать — версию не знаем
    }
  }
  return undefined
}

/**
 * Вычистить из карантина записи старше QUARANTINE_DAYS. Возраст берётся из
 * `deleted-at.json`, который кладётся рядом при переносе: время файловой
 * системы ненадёжно (rename сохраняет старую дату, облако меняет её как хочет).
 *
 * Истёкшая пометка удаления остаётся действующей (чтобы старое устройство не
 * «воскресило» сессию), но получает reason=expired: восстановить её уже нельзя.
 *
 * @returns {Promise<string[]>} id сессий, чей карантин вычищен.
 */
async function purgeExpiredQuarantine(repoDir, projectId, tombstones) {
  const root = join(repoDir, 'sessions', projectId, QUARANTINE_DIR)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const deadline = Date.now() - QUARANTINE_DAYS * 24 * 60 * 60_000
  const purged = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    let at
    try {
      at = Date.parse(JSON.parse(await readFile(join(dir, DELETED_AT_FILE), 'utf8')).at)
    } catch {
      at = Number.NaN // без отметки возраста не трогаем
    }
    if (Number.isFinite(at) && at < deadline) {
      await rm(dir, { recursive: true, force: true })
      let purgedId = entry.name
      for (const sessionId of Object.keys(tombstones?.sessions ?? {})) {
        if (encodeSegment(sessionId) !== entry.name) continue
        markExpired(tombstones, sessionId, { by: 'sync' })
        purgedId = sessionId
      }
      purged.push(purgedId)
    }
  }
  return purged
}

/**
 * Можно ли перезаписать зеркальный лог локальным. Возвращает причину отказа
 * или undefined, если запись безопасна. Локальный лог короче зеркального или
 * расходится с ним — писать нельзя: это потеряло бы события, которые зеркало
 * уже раздало другим устройствам.
 */
function guardPush(existing, canonical, id) {
  let existingTail
  let localTail
  try {
    existingTail = tailOf(existing)
    localTail = tailOf(canonical)
  } catch (error) {
    return { id, message: `зеркальный лог не читается — не перезаписываем (${error instanceof Error ? error.message : String(error)})` }
  }
  if (existingTail.equals(localTail)) return undefined // изменился только заголовок
  if (isPrefix(existingTail, localTail)) return undefined // fast-forward: зеркало — префикс локального
  if (isPrefix(localTail, existingTail)) {
    return { id, message: 'локальный лог короче зеркального — отправка пропущена (в зеркале больше событий)' }
  }
  return { id, message: 'логи разошлись — зеркало не перезаписываем, чтобы не потерять события' }
}

/**
 * Отрезать недописанный хвост: DSH может дописывать сессию в момент чтения, и
 * незавершённый кадр нельзя отправлять другим устройствам — иначе они получат
 * обрезанную историю.
 */
export function sanitizeLog(bytes) {
  const { frameEnd, plain } = splitLog(bytes)
  const tail = bytes.subarray(frameEnd)
  if (tail.length === 0) return { bytes, dropped: 0 }

  if (plain) {
    const lastNewline = tail.lastIndexOf(0x0a)
    if (lastNewline === -1) return { bytes: bytes.subarray(0, frameEnd), dropped: tail.length }
    if (lastNewline === tail.length - 1) return { bytes, dropped: 0 }
    return { bytes: bytes.subarray(0, frameEnd + lastNewline + 1), dropped: tail.length - lastNewline - 1 }
  }

  let lastStart = -1
  for (let i = tail.length - 4; i >= 0; i--) {
    if (tail[i] === 0x28 && tail[i + 1] === 0xb5 && tail[i + 2] === 0x2f && tail[i + 3] === 0xfd) {
      lastStart = i
      break
    }
  }
  if (lastStart < 0) return { bytes, dropped: 0 }

  let complete = false
  try {
    complete = zstdDecompressSync(tail.subarray(lastStart)).length > 0
  } catch {
    complete = false
  }
  if (complete) return { bytes, dropped: 0 }
  return { bytes: bytes.subarray(0, frameEnd + lastStart), dropped: tail.length - lastStart }
}

/**
 * Совпадает ли лог по смыслу: заголовок (без учёта порядка ключей) и хвост.
 * Байты заголовка сравнивать нельзя: разные сборки Node сжимают один и тот же
 * JSON в разные zstd-кадры, и тогда каждый push создавал бы пустой коммит.
 */
function sameLog(a, b) {
  let left
  let right
  try {
    left = splitLog(a)
    right = splitLog(b)
  } catch {
    return false
  }
  if (!left.tail.equals(right.tail)) return false
  const normalize = (header) => JSON.stringify(Object.fromEntries(Object.keys(header).sort().map(key => [key, header[key]])))
  return normalize(left.header) === normalize(right.header)
}

function isPrefix(prefix, whole) {
  return whole.length >= prefix.length && whole.subarray(0, prefix.length).equals(prefix)
}

/**
 * Отношение локального лога к зеркальному по хвосту событий:
 * - `same` — хвосты совпадают (логи равны по смыслу, заголовок не важен);
 * - `localAhead` — зеркало является префиксом локального (отправка допишет);
 * - `cloudAhead` — локальный является префиксом зеркального (приём допишет);
 * - `conflicts` — обе стороны дописали разное (склеить нельзя).
 * Те же правила, что у pull/push: план показывает именно то, что случилось бы.
 */
function relationOf(existing, canonical) {
  let existingTail
  let localTail
  try {
    existingTail = tailOf(existing)
    localTail = tailOf(canonical)
  } catch {
    return 'conflicts'
  }
  if (existingTail.equals(localTail)) return 'same'
  if (isPrefix(existingTail, localTail)) return 'localAhead'
  if (isPrefix(localTail, existingTail)) return 'cloudAhead'
  return 'conflicts'
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function dropCache(home, sessionId) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (existsSync(file)) await rm(file, { force: true })
}

async function backupLog(home, projectId, sessionId, bytes) {
  const dir = join(home, 'dsh-sync', 'backups', stamp())
  const target = join(dir, projectId, `${sessionId}.zstd`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return target
}

function selectedProjects(config, filter) {
  const ids = Object.keys(config.projects)
  if (!filter) return ids.map(id => [id, config.projects[id]])
  if (!config.projects[filter]) throw new Error(`проект не настроен: ${filter} (см. project add)`)
  return [[filter, config.projects[filter]]]
}

// --- группы «родитель + субагенты» -----------------------------------------

/** Разобрать заголовок лога; undefined — лог не читается. */
function headerOf(bytes) {
  if (bytes === undefined) return undefined
  try {
    return splitLog(bytes).header
  } catch {
    return undefined
  }
}

/** Связи «родитель + субагенты» по набору сессий стора или зеркала. */
function groupsOf(sessions) {
  return buildSessionGroups((sessions ?? []).map(session => ({
    id: session.id,
    // Host-часть отдаёт заголовок отдельным полем `parent`, стор — байты лога.
    header: headerOf(session.bytes)
      ?? (typeof session.parent === 'string' && session.parent.trim() !== ''
        ? { id: session.id, parentSession: session.parent.trim() }
        : undefined),
  })))
}

/**
 * Связи в зеркале проекта. Читаются один раз за прогон: по ним видно, каких
 * субагентов нет локально (их нельзя удалять) и кто уйдёт вместе с родителем.
 */
async function mirrorGroups(repoDir, projectId) {
  if (!existsSync(join(repoDir, 'sessions', projectId))) {
    return { parentById: new Map(), childrenByParent: new Map(), sessions: [] }
  }
  const sessions = await listMirrorSessions(repoDir, projectId)
  return { ...groupsOf(sessions), sessions }
}

/**
 * Состояние движка: какие сессии это устройство отправляло, плюс служебные
 * отметки (например, `secondary.initialized` для резервного канала). Само
 * чтение/запись живёт в `sync-state.mjs`: тот же файл нужен плану «Проверить»,
 * а ему не нужно тянуть весь движок синхронизации.
 */
export { readSyncState, writeSyncState }

const readState = readSyncState
const writeState = writeSyncState

export async function push({ home, config, project, prune = true, message, sessions: provided, dshVersion }) {
  // Для git-бэкенда без адреса репозитория пушить некуда: лучше сказать об этом
  // прямо, чем падать на «origin does not appear to be a git repository».
  if (config.backend === 'git' && (config.remote ?? '').length === 0) {
    throw new Error('не задан адрес репозитория — укажите его в настройках плагина или нажмите «Создать репозиторий»')
  }
  // Свежие ручные пометки читаем ДО синхронизации дерева зеркала: панельное
  // удаление пишет tombstones.json сразу, а fetch+reset затёр бы незакоммиченное.
  const pendingManual = pendingManualTombstones(await readTombstones(config.repoDir))
  const remote = await createRemote(config)
  await remote.sync()

  const local = provided === undefined ? await listLocalSessions(home) : []
  // Режимы «локальная / облачная» — настройка этого устройства: локальные
  // сессии не отправляются, не попадают в состояние и не дают надгробий.
  // Новые сессии сначала получают умолчание своего рабочего пространства.
  const modes = (await applyWorkspaceDefaults(home)).modes
  const state = await readState(home)
  const summary = {
    projects: [],
    pushed: 0,
    removed: 0,
    skipped: 0,
    localSkipped: 0,
    // Локальные сессии, у которых в зеркале осталась копия: prune их не
    // трогает, и это считается отдельно — панель показывает, что копии живы.
    localMirrorProtected: 0,
    // Журнал: сколько сессий и субагентов обменяно и каких детей не хватает
    // локально (подробности — в истории, см. history.mjs).
    sessions: 0,
    subagents: 0,
    childrenMissing: [],
  }
  let meta = await readMeta(config.repoDir)
  const tombstones = await readTombstones(config.repoDir)
  let tombstonesDirty = false
  // Перенести ручные пометки, которые не успели попасть в коммит зеркала.
  if (mergePendingManualTombstones(tombstones, pendingManual) > 0) tombstonesDirty = true
  // Снятые пометки (reason=restored) — исторический след: сессия возвращена,
  // удаление больше не действует. Убираем их ближайшей отправкой, чтобы файл не
  // рос; сам факт восстановления остаётся в журнале запусков.
  for (const [sessionId, tombstone] of Object.entries(tombstones.sessions)) {
    if (!isActiveTombstone(tombstone)) {
      delete tombstones.sessions[sessionId]
      tombstonesDirty = true
    }
  }
  const localVersion = dshVersion ?? await detectDshVersion()
  // Зеркало в более новом формате логов: старая сборка не должна писать туда —
  // она не понимает новый формат и может испортить данные.
  const mirrorFormat = typeof meta?.dsh?.format === 'number' ? meta.dsh.format : undefined
  const mirrorFormatNewer = mirrorFormat !== undefined && mirrorFormat > LOG_FORMAT

  // Сводка плана и счётчик отложенных удалений — в журнал последнего запуска:
  // панель показывает «удалений: N (ждёт подтверждения)», ничего не удаляя.
  const planCounts = { onlyLocal: 0, onlyCloud: 0, same: 0, localAhead: 0, cloudAhead: 0, conflicts: 0 }
  let skippedDeletions
  let planDeletionCount = 0
  let knownTotal = 0
  let overCountAny = false
  let overRatioAny = false
  let needsGroupConfirmAny = false

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const allSessions = provided ?? sessionsOfProject(local, entry.path)
    // Единица обмена — группа «родитель + субагенты»: режим «локальная»
    // наследуется детьми, иначе субагент уехал бы в зеркало без родителя.
    const localGroups = groupsOf(allSessions)
    const modeView = resolveGroupModes(modes, allSessions, localGroups)
    const sessions = allSessions.filter(session => !modeView.localIds.has(normalizeSessionId(session.id)))
    const localIds = new Set([...modeView.localIds].map(normalizeSessionId))
    summary.localSkipped += localIds.size
    if (modeView.forcedChildren.length > 0) {
      summary.localForced = modeView.forcedChildren.slice(0, 50)
      summary.localForcedCount = modeView.forcedChildren.length
    }
    const current = new Set(sessions.map(session => session.id))
    const pushedBefore = summary.pushed
    const previous = new Set(state.projects[projectId] ?? [])
    // Если удаление остановлено порогом, состояние проекта не обновляем:
    // иначе следующий (подтверждённый) прогон не увидит кандидатов.
    let deferState = false

    for (const session of sessions) {
      try {
        if (mirrorFormatNewer) {
          summary.guarded ??= []
          summary.guarded.push({ id: session.id, message: `зеркало в более новом формате (v${mirrorFormat}) — отправка пропущена, обновите DSH` })
          continue
        }
        const source = session.bytes
          ?? (session.path !== undefined
            ? await readFile(session.path)
            : await readFile(join(localSessionDir(home, entry.path, session.id), 'session.v4.jsonl.zstd')))
        const safe = sanitizeLog(source)
        if (safe.dropped > 0) {
          summary.truncated = (summary.truncated ?? 0) + 1
        }
        const canonical = canonicalize(safe.bytes, projectId)
        const target = mirrorLogPath(config.repoDir, projectId, session.id)
        await mkdir(dirname(target), { recursive: true })
        const existed = existsSync(target)
        if (existed) {
          // Уже лежит то же самое (возможно, сжатое другой сборкой Node) —
          // не перезаписываем, иначе каждый push делает пустой коммит.
          const existing = await readFile(target)
          // Сводка плана для журнала: что было бы сделано с этой сессией.
          planCounts[relationOf(existing, canonical)] += 1
          if (sameLog(existing, canonical)) {
            summary.skipped += 1
            continue
          }
          // Зеркало могло уехать вперёд (другое устройство дописало события):
          // короткий или разошедшийся локальный лог не перезаписывает его.
          const guarded = guardPush(existing, canonical, session.id)
          if (guarded !== undefined) {
            summary.guarded ??= []
            summary.guarded.push(guarded)
            continue
          }
        }
        await writeFile(target, canonical)
        if (!existed) planCounts.onlyLocal += 1
        summary.pushed += 1
        summary.pushedIds ??= new Set()
        summary.pushedIds.add(session.id)
        // Субагент уехал в том же прогоне, что и родитель.
        if (localGroups.parentById.has(session.id)) summary.subagents += 1
        // Сессия снова существует — её «надгробие» больше не нужно.
        if (dropTombstone(tombstones, session.id)) tombstonesDirty = true
      } catch (error) {
        // Один нечитаемый лог не должен останавливать остальные сессии.
        summary.failures ??= []
        summary.failures.push({
          id: session.id,
          path: session.path ?? '',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Связи в зеркале после отправки: по ним видны субагенты, которых локально
    // нет. Их нельзя удалять из зеркала и нельзя создавать им надгробия —
    // иначе другое устройство потеряло бы детей живого родителя.
    let mirrorView
    try {
      mirrorView = await mirrorGroups(config.repoDir, projectId)
    } catch {
      mirrorView = { parentById: new Map(), childrenByParent: new Map(), sessions: [] }
    }
    const childrenMissing = missingChildren({ allSessions, mirrorView, current, localIds, tombstones })
    if (childrenMissing.length > 0) {
      summary.childrenMissingCount = (summary.childrenMissingCount ?? 0) + childrenMissing.length
      summary.childrenMissing = [...new Set([...(summary.childrenMissing ?? []), ...childrenMissing])].slice(0, 50)
    }
    summary.sessions += summary.pushed - pushedBefore

    // Сессии, которые есть только в зеркале: в план идут как «только в облаке»
    // (кроме копий сессий в режиме «локальная» — они защищены).
    for (const mirrorSession of mirrorView.sessions) {
      if (current.has(mirrorSession.id)) continue
      if (localIds.has(normalizeSessionId(mirrorSession.id))) continue
      planCounts.onlyCloud += 1
    }

    // push никогда не удаляет из зеркала: удаление — отдельное подтверждённое
    // действие («Применить удаления»). Здесь только считаем, что было бы
    // удалено, и не обновляем состояние проекта, чтобы кандидаты не потерялись
    // до подтверждения.
    if (prune) {
      let deletion
      try {
        deletion = planDeletions({
          home,
          config,
          projectId,
          projectPath: entry.path,
          previous,
          current,
          localIds,
          tombstones,
          mirrorView,
          childrenMissing,
        })
      } catch (error) {
        deletion = undefined
        summary.deletionError = error instanceof Error ? error.message : String(error)
      }
      if (deletion !== undefined) {
        // Сессия снова существует — её «надгробие» больше не нужно.
        for (const sessionId of deletion.staleTombstones) {
          if (dropTombstone(tombstones, sessionId)) tombstonesDirty = true
        }
        if (deletion.warning !== undefined) {
          summary.warning = summary.warning === undefined ? deletion.warning : `${summary.warning}; ${deletion.warning}`
        }
        // Локальные сессии в режиме «локальная», у которых в зеркале осталась
        // копия: удаление их не трогает, и это считается отдельно.
        if (deletion.protectedLocalMirror.size > 0) {
          summary.localMirrorProtected += deletion.protectedLocalMirror.size
          summary.localMirrorProtectedIds = [
            ...new Set([...(summary.localMirrorProtectedIds ?? []), ...deletion.protectedLocalMirror]),
          ].slice(0, 100)
        }
        if (deletion.orphansProtected.length > 0) summary.orphansProtected = deletion.orphansProtected
        if (deletion.planned.size > 0) {
          deferState = true
          const groupChildCount = deletion.groups.reduce((total, group) => total + group.children.length, 0)
          planDeletionCount += deletion.planned.size
          knownTotal += deletion.known
          if (deletion.overCount) overCountAny = true
          if (deletion.overRatio) overRatioAny = true
          if (deletion.needsGroupConfirm) needsGroupConfirmAny = true
          skippedDeletions ??= {
            removed: 0,
            ids: [],
            groups: [],
            subagents: 0,
            projects: [],
            reason: 'удаление ждёт подтверждения — «Применить удаления» в карточке «Проверка»',
          }
          skippedDeletions.removed += deletion.planned.size
          skippedDeletions.ids.push(...[...deletion.planned].sort())
          skippedDeletions.groups.push(...deletion.groups)
          skippedDeletions.subagents += groupChildCount
          skippedDeletions.projects.push({ id: projectId, removed: deletion.planned.size })
          const parts = []
          if (deletion.needsGroupConfirm) parts.push(`удаление родителя затронет субагентов: ${groupChildCount}`)
          if (deletion.overCount || deletion.overRatio) {
            parts.push(`удаление ${deletion.planned.size} сессий превышает порог (${PRUNE_MAX_COUNT} сессий или ${Math.round(PRUNE_MAX_RATIO * 100)}% известных)`)
          }
          parts.push('удаление выполняется только по подтверждению')
          const note = parts.join('; ')
          summary.warning = summary.warning === undefined ? note : `${summary.warning}; ${note}`
        }
      }

      // Карантину — 30 дней: записи старше вычищаются при следующем прогоне.
      try {
        const purged = await purgeExpiredQuarantine(config.repoDir, projectId, tombstones)
        if (purged.length > 0) {
          summary.quarantinePurged = purged.length
          summary.quarantinePurgedIds = purged.slice(0, 100)
          tombstonesDirty = true
        }
      } catch {
        // очистка необязательна
      }
    }

    if (!deferState) state.projects[projectId] = [...current]
    meta = mergeDevice(meta, {
      projectId,
      title: entry.title ?? projectId,
      deviceId: config.deviceId,
      path: entry.path,
    })
    // Отметка версии/формата: по ней другая сборка понимает, совместима ли она
    // с зеркалом. Более новый формат не понижаем, более новую версию не
    // затираем — иначе старое приложение «спрятало» бы предупреждение.
    if (mirrorFormat === undefined || mirrorFormat <= LOG_FORMAT) {
      const existingVersion = typeof meta?.dsh?.version === 'string' ? meta.dsh.version : ''
      const keepNewer = existingVersion !== '' && localVersion !== undefined && compareVersions(existingVersion, localVersion) > 0
      meta.dsh = { version: keepNewer ? existingVersion : (localVersion ?? ''), format: LOG_FORMAT }
    }
    summary.projects.push({ id: projectId, path: entry.path, sessions: sessions.length })

    // Человекочитаемое описание зеркала: описание сессий, индекс проекта.
    try {
      await writeCatalog(config.repoDir, new Map([[projectId, sessions.map(s => ({ id: s.id, changed: summary.pushedIds?.has(s.id) === true }))]]), { projectPath: entry.path })
    } catch (error) {
      const catalogError = `описание зеркала не обновлено: ${error instanceof Error ? error.message : String(error)}`
      summary.warning = summary.warning === undefined ? catalogError : `${summary.warning}; ${catalogError}`
    }

    // Отметить отправленное как синхронизированное (кроме тех, что не прочитались).
    const failedIds = new Set((summary.failures ?? []).map(failure => failure.id))
    for (const guarded of summary.guarded ?? []) failedIds.add(guarded.id)
    const ledger = await readLedger(home)
    for (const session of sessions) {
      if (failedIds.has(session.id)) continue
      const path = session.path ?? join(localSessionDir(home, entry.path, session.id), 'session.v4.jsonl.zstd')
      try {
        markSynced(ledger, session.id, await stat(path))
      } catch {
        // файла нет — не отмечаем
      }
    }
    await writeLedger(home, ledger)
  }

  // Сводка плана: сколько сессий в каждой корзине и сколько удалений отложено.
  summary.plan = { counts: planCounts, deletions: planDeletionCount }
  if (skippedDeletions !== undefined) {
    const ids = [...new Set(skippedDeletions.ids)]
    summary.skippedDeletions = {
      ...skippedDeletions,
      ids: ids.slice(0, 100),
      groups: skippedDeletions.groups.slice(0, 20),
      maxCount: PRUNE_MAX_COUNT,
      maxRatio: PRUNE_MAX_RATIO,
      known: knownTotal,
      overCount: overCountAny,
      overRatio: overRatioAny,
      needsConfirmation: overCountAny || overRatioAny || needsGroupConfirmAny,
    }
    // Прежнее поле панель использовала для кнопки подтверждения удаления:
    // оставляем его совместимым по форме, но само удаление теперь идёт
    // отдельным маршрутом /api/dsh-sync/prune.
    summary.requireConfirmation = {
      removed: summary.skippedDeletions.removed,
      known: knownTotal,
      maxCount: PRUNE_MAX_COUNT,
      maxRatio: PRUNE_MAX_RATIO,
      ids: ids.slice(0, 50),
      groups: summary.skippedDeletions.groups,
      size: summary.skippedDeletions.removed,
      subagents: summary.skippedDeletions.subagents,
    }
  }

  await writeMeta(config.repoDir, meta)
  await writeState(home, state)

  if (config.attachments) {
    const attachments = await pushAttachments({ home, repoDir: config.repoDir })
    summary.attachments = attachments
  }

  // Профильный слой и привязка рабочих пространств: отдельные файлы зеркала,
  // сбой любого из них не должен отменять отправку сессий.
  const neutralizer = createNeutralizer({ home: homedir(), dshHome: home })
  if (config.profile?.enabled !== false) {
    try {
      summary.profile = await pushProfile({ home, config, repoDir: config.repoDir, neutralizer })
    } catch (error) {
      summary.profileError = error instanceof Error ? error.message : String(error)
    }
  }
  if (config.workspace?.enabled !== false) {
    try {
      summary.workspace = await pushWorkspace({ home, config, repoDir: config.repoDir, neutralizer })
    } catch (error) {
      summary.workspaceError = error instanceof Error ? error.message : String(error)
    }
  }

  if ((summary.truncated ?? 0) > 0) {
    const truncateWarning = `недописанные хвосты обрезаны: ${summary.truncated}`
    summary.warning = summary.warning === undefined ? truncateWarning : `${summary.warning}; ${truncateWarning}`
  }

  if ((summary.guarded ?? []).length > 0) {
    const guardWarning = `зеркало не перезаписано: ${summary.guarded.length} (${summary.guarded[0].id}: ${summary.guarded[0].message})`
    summary.warning = summary.warning === undefined ? guardWarning : `${summary.warning}; ${guardWarning}`
  }

  if (tombstonesDirty) await writeTombstones(config.repoDir, tombstones)

  const result = await remote.commit(message ?? `dsh-sync: push from ${config.deviceId} (${new Date().toISOString()})`)
  summary.committed = result.committed
  summary.pushedToRemote = result.pushed
  return summary
}

/**
 * Перенести подтверждённые сессии из зеркала в карантин.
 *
 * Удаление — ручное действие владельца: у каждой метки reason=manual (или
 * children для субагента, ушедшего вместе с родителем) и by=owner. Название и
 * объём берутся до переноса, чтобы панель «Удалённые» показывала их без
 * чтения логов. Если rename не удался, сессия удаляется как раньше, но это
 * видно по счётчикам.
 *
 * @returns {Promise<boolean>} были ли изменения в надгробиях.
 */
async function quarantinePlanned({ config, projectId, planned, groupChildren, missing, tombstones, summary }) {
  const reasons = new Set()
  const removedDetails = []
  // Подтверждение владельца: reason=manual/by=owner, размер пачки — size.
  const manualBatch = true
  for (const sessionId of planned) {
    const dir = join(config.repoDir, 'sessions', projectId, encodeSegment(sessionId))
    if (!existsSync(dir)) continue
    const groupParent = groupChildren.get(sessionId)
    const isGroupChild = groupParent !== undefined && planned.has(groupParent)
    const humanReason = isGroupChild
      ? 'удалено вместе с родителем'
      : missing.includes(sessionId) ? 'удалено локально' : 'отметка другого устройства'
    reasons.add(humanReason)
    const existing = tombstones.sessions[sessionId]
    const fromTombstone = existing !== undefined
    // Пометку, уже записанную устройством (например, удаление из панели с
    // reason=manual/by=owner), не перезаписываем — сохраняем причину.
    let reasonCode
    let byCode
    if (fromTombstone) {
      reasonCode = existing.reason ?? 'manual'
      byCode = existing.by ?? 'owner'
    } else if (isGroupChild) {
      reasonCode = CHILDREN_REASON
      byCode = 'owner'
    } else {
      reasonCode = 'manual'
      byCode = 'owner'
    }
    const meta = { reason: reasonCode, by: byCode }
    if (isGroupChild) meta.parent = groupParent
    if (!fromTombstone) meta.size = planned.size
    if (isGroupChild && meta.size === undefined) meta.size = planned.size
    // Название и объём берём до переноса: панель «Удалённые» показывает
    // название, а не только идентификатор.
    try {
      const sidecar = JSON.parse(await readFile(join(dir, SESSION_SIDECAR_FILE), 'utf8'))
      if (typeof sidecar?.title === 'string' && sidecar.title.trim() !== '') meta.title = sidecar.title.trim()
    } catch {
      // описания может не быть — покажем идентификатор
    }
    try {
      meta.bytes = (await stat(join(dir, LOG_NAME))).size
    } catch {
      // размер необязателен
    }
    // Карантин вместо удаления: 30 дней в sessions/<проект>/_deleted/<id>/.
    const target = quarantinePath(config.repoDir, projectId, sessionId)
    const replaced = existsSync(target)
    await mkdir(dirname(target), { recursive: true })
    let quarantined = false
    try {
      await rename(dir, target)
      quarantined = true
    } catch {
      // В карантине могла остаться старая копия этого же id: заменяем её.
      try {
        await rm(target, { recursive: true, force: true })
        await rename(dir, target)
        quarantined = true
      } catch {
        quarantined = false
      }
    }
    if (quarantined) {
      const deletedAt = {
        at: new Date().toISOString(),
        reason: meta.reason,
        reasonLabel: humanReason,
        by: meta.by,
        device: config.deviceId,
      }
      if (meta.title !== undefined) deletedAt.title = meta.title
      if (meta.size !== undefined) deletedAt.size = meta.size
      if (meta.parent !== undefined) deletedAt.parent = meta.parent
      await writeFile(join(target, DELETED_AT_FILE), `${JSON.stringify(deletedAt)}\n`, 'utf8')
    } else {
      // Перенести не вышло — удаляем как раньше, но фиксируем это.
      await rm(dir, { recursive: true, force: true })
    }
    if (fromTombstone) {
      // Дополняем исходную метку недостающими сведениями для панели.
      if (existing.title === undefined && meta.title !== undefined) existing.title = meta.title
      if (existing.bytes === undefined && meta.bytes !== undefined) existing.bytes = meta.bytes
      if (existing.size === undefined && isGroupChild) existing.size = planned.size
      if (replaced) existing.replaced = true
    } else {
      if (replaced) meta.replaced = true
      addTombstone(tombstones, sessionId, config.deviceId, meta)
    }
    summary.removed += 1
    summary.removedIds ??= []
    summary.removedIds.push(sessionId)
    removedDetails.push({ id: sessionId, reason: reasonCode, by: byCode })
    if (isGroupChild) {
      summary.childrenQuarantined = (summary.childrenQuarantined ?? 0) + 1
      summary.childrenQuarantinedIds ??= []
      summary.childrenQuarantinedIds.push(sessionId)
      summary.childrenQuarantinedIds = summary.childrenQuarantinedIds.slice(0, 100)
    }
    if (replaced) {
      summary.replaced = (summary.replaced ?? 0) + 1
      summary.replacedIds ??= []
      summary.replacedIds.push(sessionId)
    }
  }
  if (reasons.size > 0) summary.removedReason = [...reasons].join(', ')
  if (removedDetails.length > 0) {
    summary.removedDetails = removedDetails
    summary.removedReasons = [...new Set(removedDetails.map(item => item.reason))]
    summary.removedBy = [...new Set(removedDetails.map(item => item.by))]
  }
  return removedDetails.length > 0
}

/**
 * «Применить удаления»: перенести в карантин сессии, которые план показал как
 * удалённые. Это единственный путь удаления из зеркала — push ничего не удаляет.
 *
 * Требуется явное подтверждение (`confirm: true`). Старые защиты prune
 * сохраняются: защищённые субагенты живых родителей, осиротевшие копии и
 * локальные сессии не удаляются, пороги массового удаления попадают в отчёт
 * (`overCount`/`overRatio`), а метки получают reason=manual/by=owner.
 *
 * @param home каталог DSH
 * @param config настройки синхронизации
 * @param project фильтр проекта (id) или undefined — все
 * @param confirm должно быть true, иначе возвращается код подтверждения
 * @param ids необязательный список id из плана: удалить только их
 */
export async function applyDeletions({ home, config, project, confirm = false, ids, message, dshVersion }) {
  if (confirm !== true) {
    return {
      ok: false,
      code: 'confirm-required',
      action: 'prune',
      message: 'удаление из зеркала выполняется только с подтверждением (confirm:true)',
    }
  }
  if (config.backend === 'git' && (config.remote ?? '').length === 0) {
    throw new Error('не задан адрес репозитория — укажите его в настройках плагина или нажмите «Создать репозиторий»')
  }
  // Свежие ручные пометки — до синхронизации дерева зеркала (см. push).
  const pendingManual = pendingManualTombstones(await readTombstones(config.repoDir))
  const remote = await createRemote(config)
  await remote.sync()
  const local = await listLocalSessions(home)
  const modes = (await applyWorkspaceDefaults(home)).modes
  const state = await readSyncState(home)
  const tombstones = await readTombstones(config.repoDir)
  let tombstonesDirty = false
  if (mergePendingManualTombstones(tombstones, pendingManual) > 0) tombstonesDirty = true
  const summary = {
    ok: true,
    action: 'prune',
    confirmed: true,
    mode: 'manual',
    projects: [],
    removed: 0,
    removedIds: [],
    removedDetails: [],
    reasons: [],
    by: [],
    groups: 0,
  }
  const requested = Array.isArray(ids)
    ? new Set(ids.filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))
    : undefined

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const allSessions = sessionsOfProject(local, entry.path)
    const localGroups = groupsOf(allSessions)
    const modeView = resolveGroupModes(modes, allSessions, localGroups)
    const sessions = allSessions.filter(session => !modeView.localIds.has(normalizeSessionId(session.id)))
    const current = new Set(sessions.map(session => session.id))
    const localIds = new Set([...modeView.localIds].map(normalizeSessionId))
    const previous = new Set(state.projects[projectId] ?? [])
    let mirrorView
    try {
      mirrorView = await mirrorGroups(config.repoDir, projectId)
    } catch {
      mirrorView = { parentById: new Map(), childrenByParent: new Map(), sessions: [] }
    }
    const childrenMissing = missingChildren({ allSessions, mirrorView, current, localIds, tombstones })
    if (childrenMissing.length > 0) {
      summary.childrenMissing = [...new Set([...(summary.childrenMissing ?? []), ...childrenMissing])].slice(0, 50)
      summary.childrenMissingCount = (summary.childrenMissingCount ?? 0) + childrenMissing.length
    }
    const stats = { id: projectId, path: entry.path, removed: 0, removedIds: [] }
    let deletion
    try {
      deletion = planDeletions({
        home,
        config,
        projectId,
        projectPath: entry.path,
        previous,
        current,
        localIds,
        tombstones,
        mirrorView,
        childrenMissing,
      })
    } catch (error) {
      deletion = undefined
      stats.error = error instanceof Error ? error.message : String(error)
    }
    const removedBefore = summary.removed
    if (deletion !== undefined) {
      // Сессия снова существует — её «надгробие» больше не нужно.
      for (const sessionId of deletion.staleTombstones) {
        if (dropTombstone(tombstones, sessionId)) tombstonesDirty = true
      }
      if (deletion.warning !== undefined) {
        summary.warning = summary.warning === undefined ? deletion.warning : `${summary.warning}; ${deletion.warning}`
      }
      if (deletion.protectedLocalMirror.size > 0) {
        summary.localMirrorProtected = (summary.localMirrorProtected ?? 0) + deletion.protectedLocalMirror.size
      }
      if (deletion.orphansProtected.length > 0) summary.orphansProtected = deletion.orphansProtected
      // Для отчёта: насколько пачка большая относительно порогов и известных.
      summary.known = (summary.known ?? 0) + deletion.known
      if (deletion.overCount) summary.overCount = true
      if (deletion.overRatio) summary.overRatio = true
      summary.groups += deletion.groups.length
      summary.subagents = (summary.subagents ?? 0)
        + deletion.groups.reduce((total, group) => total + group.children.length, 0)
      let planned = deletion.planned
      if (requested !== undefined && requested.size > 0) {
        planned = new Set([...planned].filter(sessionId => requested.has(sessionId)))
      }
      if (planned.size > 0) {
        // Предупреждение для панели: у удаляемого родителя есть дети.
        const parentWithChildren = []
        for (const sessionId of deletion.missing) {
          for (const childId of mirrorView.childrenByParent.get(sessionId) ?? []) {
            if (!parentWithChildren.includes(childId)) parentWithChildren.push(childId)
          }
        }
        const removedChildren = [...deletion.groupChildren.keys()].filter(childId => planned.has(childId))
        if (parentWithChildren.length > 0 || removedChildren.length > 0) {
          summary.parentWithChildren = [...new Set([...parentWithChildren, ...removedChildren])].slice(0, 50)
          const suffix = removedChildren.length > 0
            ? ` (уходят вместе, в карантин: ${removedChildren.length})`
            : ' (их копии остаются в зеркале)'
          summary.warning = `удаляется родитель с субагентами: ${summary.parentWithChildren.length}${suffix}`
        }
        const before = summary.removed
        if (await quarantinePlanned({
          config,
          projectId,
          planned,
          groupChildren: deletion.groupChildren,
          missing: deletion.missing,
          tombstones,
          summary,
        })) {
          tombstonesDirty = true
        }
        stats.removed = summary.removed - before
      }
    }
    // Удалённые сессии больше не считаются отправленными этим устройством,
    // остальные кандидаты остаются в состоянии — иначе следующий план их
    // потеряет и удаление не доедет до подтверждения.
    const projectRemovedIds = (summary.removedIds ?? []).slice(removedBefore)
    const nextState = new Set(previous)
    for (const sessionId of projectRemovedIds) nextState.delete(sessionId)
    state.projects[projectId] = [...nextState]
    stats.removedIds = projectRemovedIds
    summary.projects.push(stats)

    // Карантину — 30 дней: записи старше вычищаются при следующем прогоне.
    try {
      const purged = await purgeExpiredQuarantine(config.repoDir, projectId, tombstones)
      if (purged.length > 0) {
        summary.quarantinePurged = (summary.quarantinePurged ?? 0) + purged.length
        summary.quarantinePurgedIds = [...(summary.quarantinePurgedIds ?? []), ...purged].slice(0, 100)
        tombstonesDirty = true
      }
    } catch {
      // очистка необязательна
    }
  }

  await writeState(home, state)
  if (tombstonesDirty) await writeTombstones(config.repoDir, tombstones)
  summary.reasons = [...new Set(summary.removedDetails.map(item => item.reason))]
  summary.by = [...new Set(summary.removedDetails.map(item => item.by))]
  if (summary.removed === 0) {
    summary.message = 'удалять нечего: кандидатов нет или они защищены'
    return summary
  }
  const result = await remote.commit(message ?? `dsh-sync: prune ${summary.removed} session(s) by owner (${config.deviceId})`)
  summary.committed = result.committed
  summary.pushedToRemote = result.pushed
  summary.message = `в карантин отправлено сессий: ${summary.removed}`
  return summary
}

export async function pull({ home, config, project, dryRun = false, dshVersion }) {
  // Свежие ручные пометки — до синхронизации дерева зеркала (см. push).
  const pendingManual = pendingManualTombstones(await readTombstones(config.repoDir))
  const remote = await createRemote(config)
  const fetched = await remote.sync()
  if (fetched === false && config.remote) {
    // Пустой репозиторий (ещё нет ветки) — это не ошибка: принимать нечего.
    const probe = await git(config.repoDir, ['ls-remote', '--heads', config.remote], { allowFailure: true })
    if (probe.code !== 0 || probe.stdout.trim() !== '') {
      throw new Error('не удалось получить удалённую ветку (проверьте remote и доступ)')
    }
  }

  const local = await listLocalSessions(home)
  // Умолчания рабочих пространств материализуются до решения «принимать или
  // пропустить»: иначе сессия из «локального» пространства приехала бы сюда.
  const modes = (await applyWorkspaceDefaults(home)).modes
  const summary = {
    projects: [],
    imported: 0,
    updated: 0,
    conflicts: 0,
    unchanged: 0,
    ahead: 0,
    locked: 0,
    unknownProjects: [],
    localSkipped: 0,
    // Журнал: сколько сессий и субагентов принято и каких детей не хватает.
    sessions: 0,
    subagents: 0,
    childrenMissing: [],
  }
  const meta = await readMeta(config.repoDir)
  const ledger = await readLedger(home)
  const state = await readState(home)
  const tombstones = await readTombstones(config.repoDir)
  // Вернуть в файл ручные пометки, которые fetch+reset мог затёрть: иначе
  // следующая отправка записала бы удаление как автоматическое (prune/sync).
  const mergedManual = mergePendingManualTombstones(tombstones, pendingManual)
  if (mergedManual > 0 && !dryRun) {
    try {
      await writeTombstones(config.repoDir, tombstones)
    } catch {
      // запись — страховка для следующей отправки, приём продолжается
    }
  }
  summary.mirrorProjects = Object.entries(meta.projects ?? {}).map(([id, info]) => ({ id, title: info?.title ?? id }))

  // Сверка версий: зеркало в более новом формате логов старому приложению
  // отдавать нельзя — такие логи оно не прочитает (или прочитает неверно).
  const localVersion = dshVersion ?? await detectDshVersion()
  const mirrorFormat = typeof meta?.dsh?.format === 'number' ? meta.dsh.format : undefined
  if (mirrorFormat !== undefined && mirrorFormat > LOG_FORMAT) {
    summary.warning = `зеркало использует более новый формат логов (v${mirrorFormat}, поддерживается v${LOG_FORMAT}) — приём пропущен, обновите DSH`
    return summary
  }
  const mirrorVersion = typeof meta?.dsh?.version === 'string' ? meta.dsh.version : ''
  if (mirrorVersion !== '' && localVersion !== undefined && compareVersions(mirrorVersion, localVersion) > 0) {
    summary.warning = `зеркало синхронизировалось более новой версией DSH (${mirrorVersion}, у вас ${localVersion}) — обновите DSH, чтобы не пропустить изменения`
  }
  const configured = new Set(Object.keys(config.projects))
  const mirrorRoot = join(config.repoDir, 'sessions')
  const projectDirs = existsSync(mirrorRoot) ? await readdir(mirrorRoot, { withFileTypes: true }) : []
  for (const entry of projectDirs) {
    if (entry.isDirectory() && !configured.has(entry.name)) summary.unknownProjects.push(entry.name)
  }

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const remoteSessions = await listMirrorSessions(config.repoDir, projectId)
    // Группы «родитель + субагенты»: приём идёт от родителей к детям, а
    // локальные режимы наследуются группой.
    const remoteGroups = groupsOf(remoteSessions)
    const orderedSessions = orderParentsFirst(remoteSessions, remoteGroups)
    const remoteModes = resolveGroupModes(modes, remoteSessions, remoteGroups)
    const stats = {
      id: projectId,
      path: entry.path,
      imported: 0,
      updated: 0,
      conflicts: 0,
      unchanged: 0,
      ahead: 0,
      locked: 0,
      subagents: 0,
      childrenMissing: [],
    }

    // Сессии, которые это устройство раньше отправляло, но локально их уже нет:
    // их удалили, а отправка ещё не прошла. Импортировать обратно нельзя —
    // иначе удаление никогда не доедет, а сессия «воскреснет».
    const tracked = new Set(state.projects?.[projectId] ?? [])
    const projectLocal = sessionsOfProject(local, entry.path)
    const localIds = new Set(projectLocal.map(session => session.id))
    const localGroups = groupsOf(projectLocal)
    const localModes = resolveGroupModes(modes, projectLocal, localGroups)
    // Родители, которые уже приехали (или уже лежат локально): их субагентов
    // нельзя терять из-за ожидания удаления.
    const arrived = new Set()

    for (const remoteSession of orderedSessions) {
      try {
      // Локальная сессия и дети локального родителя не принимаются из зеркала:
      // режим «локальная» — обещание, что данные живут только здесь.
      if (remoteModes.localIds.has(normalizeSessionId(remoteSession.id))) {
        stats.localSkipped = (stats.localSkipped ?? 0) + 1
        continue
      }
      if (tracked.has(remoteSession.id) && !localIds.has(remoteSession.id)) {
        // Исключение — субагент, чей родитель приехал или уже лежит локально:
        // иначе ребёнок «потерялся» бы, хотя родитель жив.
        const parent = remoteGroups.parentById.get(remoteSession.id)
        const parentArrived = parent !== undefined
          && (arrived.has(parent) || localIds.has(parent))
        if (!parentArrived) {
          stats.pendingDeletion = (stats.pendingDeletion ?? 0) + 1
          continue
        }
      }
      const localDir = localSessionDir(home, entry.path, remoteSession.id)
      const localPath = join(localDir, 'session.v4.jsonl.zstd')
      const localBytes = existsSync(localPath) ? await readFile(localPath) : undefined

      if (isLocked(localDir)) {
        stats.locked += 1
        continue
      }

      const write = async (bytes) => {
        if (dryRun) return
        await mkdir(localDir, { recursive: true })
        await writeFile(localPath, bytes)
        await dropCache(home, remoteSession.id)
        try {
          markSynced(ledger, remoteSession.id, await stat(localPath))
        } catch {
          // не удалось отметить — не критично
        }
      }

      if (localBytes === undefined) {
        await write(remapTo(remoteSession.bytes, entry.path))
        stats.imported += 1
        summary.importedIds ??= []
        summary.importedIds.push(remoteSession.id)
        arrived.add(remoteSession.id)
        if (remoteGroups.parentById.has(remoteSession.id)) stats.subagents += 1
        continue
      }

      let localTail
      let remoteTail
      try {
        localTail = tailOf(localBytes)
        remoteTail = tailOf(remoteSession.bytes)
      } catch (error) {
        // Это не конфликт версий, а нечитаемый лог: показываем причину.
        summary.errors ??= []
        summary.errors.push({ id: remoteSession.id, message: error instanceof Error ? error.message : String(error) })
        continue
      }

      if (localTail.equals(remoteTail)) {
        stats.unchanged += 1
        continue
      }
      if (isPrefix(localTail, remoteTail)) {
        if (!dryRun) await backupLog(home, projectId, remoteSession.id, localBytes)
        await write(remapTo(remoteSession.bytes, entry.path))
        stats.updated += 1
        arrived.add(remoteSession.id)
        if (remoteGroups.parentById.has(remoteSession.id)) stats.subagents += 1
        continue
      }
      if (isPrefix(remoteTail, localTail)) {
        stats.ahead += 1
        continue
      }

      // Расхождение: обе стороны дописали разное. Локальная остаётся, удалённая
      // приезжает отдельной сессией с новым id — ничего не теряется.
      const forkId = `session-${randomUUID()}`
      const forkDir = localSessionDir(home, entry.path, forkId)
      if (!dryRun) {
        await mkdir(forkDir, { recursive: true })
        const forkBytes = remapTo(remoteSession.bytes, entry.path, { id: forkId })
        // Копия получает новый id: события внутри должны называть его же, иначе DSH
        // сочтёт лог повреждённым.
        await writeFile(join(forkDir, 'session.v4.jsonl.zstd'), repairLog(forkBytes).bytes)
        try {
          markSynced(ledger, forkId, await stat(join(forkDir, 'session.v4.jsonl.zstd')))
        } catch {
          // отметка необязательна
        }
      }
      stats.conflicts += 1
      summary.conflictDetails ??= []
      summary.conflictDetails.push({ id: remoteSession.id, localTail: localTail.length, remoteTail: remoteTail.length })
      summary.forkIds ??= []
      summary.forkIds.push({ from: remoteSession.id, to: forkId })
      } catch (error) {
        // Любая ошибка по одной сессии не останавливает обработку остальных.
        summary.errors ??= []
        summary.errors.push({ id: remoteSession.id, message: error instanceof Error ? error.message : String(error) })
      }
    }

    // Субагенты, которых не удалось привезти, хотя родитель приехал: пишем в
    // журнал и в панель, чтобы «потерянный ребёнок» не остался незамеченным.
    if (!dryRun) {
      for (const parentId of arrived) {
        for (const childId of remoteGroups.childrenByParent.get(parentId) ?? []) {
          if (localModes.localIds.has(normalizeSessionId(childId))) continue
          if (existsSync(localSessionDir(home, entry.path, childId))) continue
          if (!stats.childrenMissing.includes(childId)) stats.childrenMissing.push(childId)
        }
      }
      if (stats.childrenMissing.length > 0) {
        summary.childrenMissingCount = (summary.childrenMissingCount ?? 0) + stats.childrenMissing.length
        summary.childrenMissing = [...new Set([...(summary.childrenMissing ?? []), ...stats.childrenMissing])].slice(0, 50)
      }
    }

    // Удаления с других устройств: локальную копию переносим в архив и убираем
    // из списка сессий. Данные не исчезают — их можно восстановить вручную или
    // кнопкой «Восстановить» в панели. Локальные сессии отметкой с другого
    // устройства не удаляются, снятые (reason=restored) — тоже.
    // Группа удаляется вместе: метка родителя уносит и его субагентов.
    if (!dryRun) {
      const activeTombstones = new Map()
      for (const [sessionId, tombstone] of Object.entries(tombstones.sessions)) {
        if (!isActiveTombstone(tombstone)) continue
        if (localModes.localIds.has(normalizeSessionId(sessionId))) continue
        activeTombstones.set(sessionId, tombstone)
      }
      const inherited = new Map() // ребёнок → родитель, по чьей метке удаляется
      let queue = [...activeTombstones.keys()]
      for (let pass = 0; pass < 8 && queue.length > 0; pass++) {
        const next = []
        for (const parentId of queue) {
          for (const childId of descendantsOf(localGroups.childrenByParent, parentId)) {
            if (activeTombstones.has(childId) || inherited.has(childId)) continue
            if (localModes.localIds.has(normalizeSessionId(childId))) continue
            inherited.set(childId, parentId)
            next.push(childId)
          }
        }
        queue = next
      }
      const deletedDetails = []
      const removal = [...activeTombstones.entries()].map(([id, tombstone]) => [id, tombstone, false])
      for (const [childId, parentId] of inherited) removal.push([childId, activeTombstones.get(parentId), true])
      for (const [sessionId, tombstone, isChild] of removal) {
        const dir = localSessionDir(home, entry.path, sessionId)
        if (!existsSync(dir)) continue
        // Метка субагента: либо унаследована от родителя, либо записана
        // устройством-источником с причиной `children` и ссылкой `parent`.
        const childTombstone = isChild || (typeof tombstone?.parent === 'string' && tombstone.parent !== '')
        const parentId = isChild ? inherited.get(sessionId) : (childTombstone ? tombstone.parent : undefined)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backup = join(home, 'dsh-sync', 'deleted', stamp, encodeSegment(sessionId))
        try {
          await mkdir(dirname(backup), { recursive: true })
          await rename(dir, backup)
        } catch {
          await rm(dir, { recursive: true, force: true })
        }
        delete ledger.sessions[sessionId]
        summary.deleted = (summary.deleted ?? 0) + 1
        summary.deletedIds ??= []
        summary.deletedIds.push(sessionId)
        summary.deletedReason = 'удалено по отметке другого устройства'
        if (childTombstone) {
          stats.childrenDeleted = (stats.childrenDeleted ?? 0) + 1
          summary.childrenDeleted = (summary.childrenDeleted ?? 0) + 1
          summary.childrenDeletedIds ??= []
          summary.childrenDeletedIds.push(sessionId)
          summary.childrenDeletedIds = summary.childrenDeletedIds.slice(0, 100)
        }
        deletedDetails.push({
          id: sessionId,
          reason: tombstone.reason,
          by: tombstone.by,
          ...(childTombstone ? { parent: parentId, inherited: isChild } : {}),
        })
      }
      if (deletedDetails.length > 0) {
        summary.deletedDetails = deletedDetails
        summary.deletedReasons = [...new Set(deletedDetails.map(item => item.reason))]
        summary.deletedBy = [...new Set(deletedDetails.map(item => item.by))]
      }
    }

    stats.sessions = stats.imported + stats.updated
    summary.sessions += stats.sessions
    summary.subagents += stats.subagents
    summary.imported += stats.imported
    summary.updated += stats.updated
    summary.conflicts += stats.conflicts
    summary.unchanged += stats.unchanged
    summary.ahead += stats.ahead
    summary.locked += stats.locked
    summary.localSkipped += stats.localSkipped ?? 0
    summary.pendingDeletion = (summary.pendingDeletion ?? 0) + (stats.pendingDeletion ?? 0)
    summary.projects.push(stats)
  }

  if (config.attachments) {
    summary.attachments = await pullAttachments({ home, repoDir: config.repoDir })
  }

  // Профильный слой и план привязки рабочих пространств. В отличие от сессий,
  // здесь нечего импортировать в стор DSH «напрямую»: патч и настройки
  // применяются как файлы, а привязку сессий выполняет host через реестр.
  const neutralizer = createNeutralizer({ home: homedir(), dshHome: home })
  if (config.profile?.enabled !== false) {
    try {
      summary.profile = await pullProfile({ home, config, repoDir: config.repoDir, neutralizer, dryRun })
    } catch (error) {
      summary.profileError = error instanceof Error ? error.message : String(error)
    }
  }
  if (config.workspace?.enabled !== false) {
    try {
      summary.workspace = await pullWorkspace({ home, config, repoDir: config.repoDir, neutralizer, dryRun })
    } catch (error) {
      summary.workspaceError = error instanceof Error ? error.message : String(error)
    }
  }

  await writeLedger(home, ledger)
  return summary
}
