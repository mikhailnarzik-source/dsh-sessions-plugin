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
import { encodeSegment, projectKey } from './format.mjs'
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
import { isLocalSession, readSessionModes } from './session-modes.mjs'

function tailOf(bytes) {
  return splitLog(bytes).tail
}

// --- защита от массового удаления ------------------------------------------

/** Больше этого числа удалений за прогон без явного подтверждения нельзя. */
export const PRUNE_MAX_COUNT = 5
/** Больше этой доли известных сессий за прогон без подтверждения нельзя. */
export const PRUNE_MAX_RATIO = 0.2
/** Папка карантина и срок хранения — общие для движка и панели «Удалённые». */
export { QUARANTINE_DAYS, QUARANTINE_DIR }
/** Формат лога сессий, который умеет читать эта сборка плагина. */
export const LOG_FORMAT = 4

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

/**
 * Какие сессии это устройство отправляло в прошлый раз. Нужен, чтобы удаление
 * распространялось только на «свои» сессии: чужие (ещё не притянутые) сессии
 * из зеркала нельзя удалять — устройство их просто не видело.
 */
/**
 * Состояние движка: какие сессии это устройство отправляло, плюс служебные
 * отметки (например, `secondary.initialized` для резервного канала). Файл
 * общий: его читают и push/pull, и сверка резерва.
 */
export async function readSyncState(home) {
  const file = join(home, 'dsh-sync', 'state.json')
  if (!existsSync(file)) return { version: 1, projects: {} }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed?.projects ? parsed : { version: 1, projects: {} }
  } catch {
    return { version: 1, projects: {} }
  }
}

export async function writeSyncState(home, state) {
  const dir = join(home, 'dsh-sync')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

const readState = readSyncState
const writeState = writeSyncState

export async function push({ home, config, project, prune = true, message, sessions: provided, confirmPrune = false, dshVersion }) {
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
  const modes = await readSessionModes(home)
  const state = await readState(home)
  const summary = { projects: [], pushed: 0, removed: 0, skipped: 0, localSkipped: 0 }
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

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const allSessions = provided ?? sessionsOfProject(local, entry.path)
    const sessions = allSessions.filter(session => !isLocalSession(modes, session.id))
    const localIds = new Set(allSessions.filter(session => isLocalSession(modes, session.id)).map(session => session.id))
    summary.localSkipped += localIds.size
    const current = new Set(sessions.map(session => session.id))
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
        if (existsSync(target)) {
          // Уже лежит то же самое (возможно, сжатое другой сборкой Node) —
          // не перезаписываем, иначе каждый push делает пустой коммит.
          const existing = await readFile(target)
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
        summary.pushed += 1
        summary.pushedIds ??= new Set()
        summary.pushedIds.add(session.id)
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

    // Удаляем только те сессии, которые это устройство отправляло раньше и
    // которых больше нет локально. Чужие (из другого устройства) не трогаем.
    if (prune) {
      const root = join(home, 'sessions')
      const projectBucket = join(root, projectKey(entry.path))

      // Кандидаты на удаление: сессии, которые это устройство отправляло
      // раньше, но локально их больше нет, плюс сессии с надгробием, которые
      // ещё лежат в зеркале.
      const missing = [...previous].filter(id => !current.has(id) && !localIds.has(id))
      const candidates = new Set(missing)
      for (const sessionId of Object.keys(tombstones.sessions)) {
        // Локальная сессия не даёт надгробий и не удаляется: она просто живёт
        // на этом устройстве и в зеркале её может не быть вовсе.
        if (localIds.has(sessionId)) continue
        if (current.has(sessionId)) {
          // Сессия снова существует — отметка больше не нужна.
          if (dropTombstone(tombstones, sessionId)) tombstonesDirty = true
          continue
        }
        if (existsSync(join(config.repoDir, 'sessions', projectId, encodeSegment(sessionId)))) {
          candidates.add(sessionId)
        }
      }

      if (candidates.size === 0) {
        // удалять нечего
      } else if (!existsSync(root) || !existsSync(projectBucket)) {
        // Каталог сессий или каталог именно этого проекта недоступен: это
        // почти наверняка сломанный доступ, а не «удалили всё» — удаление
        // из зеркала пропускаем.
        summary.warning = 'каталог сессий проекта недоступен — удаление из зеркала пропущено'
      } else {
        const known = previous.size
        const overCount = candidates.size > PRUNE_MAX_COUNT
        const overRatio = known > 0 && candidates.size / known > PRUNE_MAX_RATIO
        if (!confirmPrune && (overCount || overRatio)) {
          // Массовое удаление останавливаем: без явного подтверждения оно
          // не должно доехать до других устройств.
          deferState = true
          summary.requireConfirmation = {
            removed: candidates.size,
            known,
            maxCount: PRUNE_MAX_COUNT,
            maxRatio: PRUNE_MAX_RATIO,
            ids: [...candidates].slice(0, 50),
          }
          summary.removedReason = 'требуется подтверждение — удаление остановлено'
          summary.warning = `удаление ${candidates.size} сессий превышает порог (${PRUNE_MAX_COUNT} сессий или ${Math.round(PRUNE_MAX_RATIO * 100)}% известных) — запустите отправку с подтверждением`
        } else {
          // Удаляющий родителя с субагентами: предупреждаем, но не блокируем.
          if (missing.length > 0) {
            try {
              const mirrored = await listMirrorSessions(config.repoDir, projectId)
              const parents = new Set(missing)
              const orphans = []
              for (const item of mirrored) {
                let parent
                try {
                  parent = splitLog(item.bytes).header.parentSession
                } catch {
                  parent = undefined
                }
                if (typeof parent === 'string' && parent !== '' && parents.has(parent)) orphans.push(item.id)
              }
              if (orphans.length > 0) {
                summary.parentWithChildren = orphans.slice(0, 50)
                summary.warning = `удаляется родитель с субагентами: ${orphans.length}`
              }
            } catch {
              // предупреждение необязательно — удаление продолжается
            }
          }

          const reasons = new Set()
          const removedDetails = []
          // Явное подтверждение пачки — это ручное удаление: reason=manual,
          // by=owner и size (сколько сессий было в пачке).
          const manualBatch = confirmPrune === true
          for (const sessionId of candidates) {
            const dir = join(config.repoDir, 'sessions', projectId, encodeSegment(sessionId))
            if (!existsSync(dir)) continue
            const humanReason = missing.includes(sessionId) ? 'удалено локально' : 'отметка другого устройства'
            reasons.add(humanReason)
            const existing = tombstones.sessions[sessionId]
            const fromTombstone = existing !== undefined
            // Пометку, уже записанную устройством (например, удаление из панели
            // с reason=manual/by=owner), не перезаписываем — сохраняем причину.
            const reasonCode = fromTombstone ? (existing.reason ?? 'prune') : (manualBatch ? 'manual' : 'prune')
            const byCode = fromTombstone ? (existing.by ?? 'sync') : (manualBatch ? 'owner' : 'sync')
            const meta = { reason: reasonCode, by: byCode }
            if (!fromTombstone && manualBatch) meta.size = candidates.size
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
              await writeFile(join(target, DELETED_AT_FILE), `${JSON.stringify(deletedAt)}\n`, 'utf8')
            } else {
              // Перенести не вышло — удаляем как раньше, но фиксируем это.
              await rm(dir, { recursive: true, force: true })
            }
            if (fromTombstone) {
              // Дополняем исходную метку недостающими сведениями для панели.
              if (existing.title === undefined && meta.title !== undefined) existing.title = meta.title
              if (existing.bytes === undefined && meta.bytes !== undefined) existing.bytes = meta.bytes
              if (replaced) existing.replaced = true
            } else {
              if (replaced) meta.replaced = true
              addTombstone(tombstones, sessionId, config.deviceId, meta)
            }
            tombstonesDirty = true
            summary.removed += 1
            summary.removedIds ??= []
            summary.removedIds.push(sessionId)
            removedDetails.push({ id: sessionId, reason: reasonCode, by: byCode })
            if (replaced) {
              summary.replaced = (summary.replaced ?? 0) + 1
              summary.replacedIds ??= []
              summary.replacedIds.push(sessionId)
            }
          }
          summary.removedReason = [...reasons].join(', ')
          if (removedDetails.length > 0) {
            summary.removedDetails = removedDetails
            summary.removedReasons = [...new Set(removedDetails.map(item => item.reason))]
            summary.removedBy = [...new Set(removedDetails.map(item => item.by))]
          }
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
  const modes = await readSessionModes(home)
  const summary = { projects: [], imported: 0, updated: 0, conflicts: 0, unchanged: 0, ahead: 0, locked: 0, unknownProjects: [], localSkipped: 0 }
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
    const stats = { id: projectId, path: entry.path, imported: 0, updated: 0, conflicts: 0, unchanged: 0, ahead: 0, locked: 0 }

    // Сессии, которые это устройство раньше отправляло, но локально их уже нет:
    // их удалили, а отправка ещё не прошла. Импортировать обратно нельзя —
    // иначе удаление никогда не доедет, а сессия «воскреснет».
    const tracked = new Set(state.projects?.[projectId] ?? [])
    const localIds = new Set((await listLocalSessions(home)).filter(session => session.cwd === entry.path).map(session => session.id))

    for (const remoteSession of remoteSessions) {
      try {
      // Локальная сессия не принимается из зеркала и не перезаписывается:
      // режим «локальная» — обещание, что данные живут только здесь.
      if (isLocalSession(modes, remoteSession.id)) {
        stats.localSkipped = (stats.localSkipped ?? 0) + 1
        continue
      }
      if (tracked.has(remoteSession.id) && !localIds.has(remoteSession.id)) {
        stats.pendingDeletion = (stats.pendingDeletion ?? 0) + 1
        continue
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

    // Удаления с других устройств: локальную копию переносим в архив и убираем
    // из списка сессий. Данные не исчезают — их можно восстановить вручную или
    // кнопкой «Восстановить» в панели. Локальные сессии отметкой с другого
    // устройства не удаляются, снятые (reason=restored) — тоже.
    if (!dryRun) {
      const deletedDetails = []
      for (const [sessionId, tombstone] of Object.entries(tombstones.sessions)) {
        if (!isActiveTombstone(tombstone)) continue
        if (isLocalSession(modes, sessionId)) continue
        const dir = localSessionDir(home, entry.path, sessionId)
        if (!existsSync(dir)) continue
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
        deletedDetails.push({ id: sessionId, reason: tombstone.reason, by: tombstone.by })
      }
      if (deletedDetails.length > 0) {
        summary.deletedDetails = deletedDetails
        summary.deletedReasons = [...new Set(deletedDetails.map(item => item.reason))]
        summary.deletedBy = [...new Set(deletedDetails.map(item => item.by))]
      }
    }

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
