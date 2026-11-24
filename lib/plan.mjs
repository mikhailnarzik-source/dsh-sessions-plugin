/**
 * План «Проверить»: сравнение локальных сессий с зеркалом без единой записи.
 *
 * Маршрут `/api/dsh-sync/plan` и команда `dsh-sync plan` показывают семь
 * корзин (`onlyLocal`, `onlyCloud`, `same`, `localAhead`, `cloudAhead`,
 * `conflicts`, `duplicates`), размеры и список сессий, которые были бы удалены
 * из зеркала. Корзина «дубли» — копии одной сессии с разными id: по
 * `contentHash`+`lineageKey`, а у старых зеркал без хеша — по паре
 * «столько же событий и размер ±1%». Это только информация: ничего не
 * удаляется и не склеивается.
 * Ничего не скачивается, не отправляется и не удаляется: даже карантин не
 * чистится, а состояние/журнал не пишутся. Сеть тоже не трогается — сравнение
 * идёт с той копией зеркала, которая уже лежит на этом устройстве.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { duplicateGroups } from './catalog.mjs'
import { encodeSegment } from './format.mjs'
import { sessionsOfProject, listLocalSessions, listMirrorSessions, splitLog } from './store.mjs'
import { normalizeSessionId, readSessionModes, resolveGroupModes } from './session-modes.mjs'
import { SESSION_SIDECAR_FILE, readTombstones } from './tombstones.mjs'
import { buildSessionGroups } from './session-groups.mjs'
import { chooseCanonical, deletionReason, missingChildren, planDeletions, rankCandidates, PRUNE_MAX_COUNT, PRUNE_MAX_RATIO } from './deletions.mjs'
import { readSyncState } from './sync-state.mjs'
import { readMeta } from './mirror-meta.mjs'
import { LOG_FORMAT } from './frames.mjs'

/** Корзины плана — в этом порядке их показывает интерфейс. */
export const PLAN_BUCKETS = ['onlyLocal', 'onlyCloud', 'same', 'localAhead', 'cloudAhead', 'conflicts', 'duplicates']

/** Сколько id хранить в каждой корзине (счётчики при этом полные). */
export const PLAN_LIST_LIMIT = 200

/** Сколько групп дублей показывать в подробностях (счётчики полные). */
export const PLAN_DUPLICATE_GROUPS_LIMIT = 50

/** Пустые счётчики по корзинам. */
export function emptyPlanCounts() {
  return { onlyLocal: 0, onlyCloud: 0, same: 0, localAhead: 0, cloudAhead: 0, conflicts: 0, duplicates: 0 }
}

/** Пустые размеры по корзинам (байты). */
function emptyPlanSizes() {
  return { onlyLocal: 0, onlyCloud: 0, same: 0, localAhead: 0, cloudAhead: 0, conflicts: 0, duplicates: 0 }
}

/** Пустые подробности по дублям. */
function emptyDuplicateSummary() {
  return { count: 0, groups: [], byContentHash: 0, byEventsBytes: 0, bytes: 0 }
}

/** Разобрать заголовок лога; undefined — лог не читается. */
function headerOf(bytes) {
  if (bytes === undefined) return undefined
  try {
    return splitLog(bytes).header
  } catch {
    return undefined
  }
}

/** Связи «родитель + субагенты» по набору сессий (стора или зеркала). */
function groupsOf(sessions) {
  return buildSessionGroups((sessions ?? []).map(session => ({
    id: session.id,
    header: headerOf(session.bytes)
      ?? (typeof session.parent === 'string' && session.parent.trim() !== ''
        ? { id: session.id, parentSession: session.parent.trim() }
        : undefined),
  })))
}

/** Дети по id из локальных и зеркальных связей: для канонического id дублей. */
function childrenIndex(localGroups, mirrorGroups) {
  const byId = new Map()
  for (const view of [localGroups, mirrorGroups]) {
    for (const [parentId, children] of view?.childrenByParent ?? []) {
      const list = byId.get(parentId) ?? []
      for (const childId of children) if (!list.includes(childId)) list.push(childId)
      byId.set(parentId, list)
    }
  }
  return byId
}

/**
 * Найти дубли проекта и разложить их по плану: одна запись на лишнюю копию.
 * Канонический id выбирается детерминированно (`chooseCanonical`), поэтому
 * на двух устройствах он совпадёт.
 */
function planDuplicates(projectPlan, projectId, { sessions, mirrorSessions, localGroups, mirrorView, tombstones }) {
  const candidates = [
    ...(sessions ?? []).map(session => ({
      id: session.id,
      side: 'local',
      bytes: session.bytes,
      sizeBytes: Number(session.size ?? session.bytes?.length ?? 0) || 0,
      createdAt: session.createdAt,
    })),
    ...(mirrorSessions ?? []).map(session => {
      const header = headerOf(session.bytes)
      return {
        id: session.id,
        side: 'mirror',
        bytes: session.bytes,
        sizeBytes: Number(session.size ?? 0) || 0,
        createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
      }
    }),
  ]
  if (candidates.length < 2) return
  const childrenById = childrenIndex(localGroups, mirrorView)
  for (const group of duplicateGroups(candidates, { projectId })) {
    if (group.sessions.length < 2) continue
    const ranked = rankCandidates(group.sessions, childrenById)
    const canonical = chooseCanonical(ranked[0], ranked, { childrenById, tombstones })
    const match = group.match
    projectPlan.duplicates[match === 'contentHash' ? 'byContentHash' : 'byEventsBytes'] += 1
    const groupInfo = {
      canonicalId: canonical.canonicalId,
      match,
      sessions: ranked.map(candidate => ({
        id: candidate.id,
        side: candidate.sides !== undefined && candidate.sides.length > 1
          ? 'both'
          : (candidate.side ?? ''),
        sizeBytes: Number(candidate.sizeBytes ?? 0) || 0,
        events: candidate.events ?? 0,
        canonical: candidate.id === canonical.canonicalId,
      })),
    }
    if (group.contentHash !== undefined) groupInfo.contentHash = group.contentHash
    if (group.events !== undefined) groupInfo.events = group.events
    projectPlan.duplicates.groups.push(groupInfo)
    for (const candidate of ranked) {
      if (candidate.id === canonical.canonicalId) continue
      const size = Number(candidate.sizeBytes ?? 0) || 0
      const item = {
        id: candidate.id,
        size,
        canonicalId: canonical.canonicalId,
        match,
        events: candidate.events ?? 0,
      }
      if (group.contentHash !== undefined) item.contentHash = group.contentHash
      addToBucket(projectPlan, projectId, 'duplicates', item)
      projectPlan.duplicates.count += 1
      projectPlan.duplicates.bytes += size
    }
  }
}

/** Отношение локального лога к зеркальному по хвосту событий. */
function relationOf(localBytes, mirrorBytes) {
  let localTail
  let mirrorTail
  try {
    localTail = splitLog(localBytes).tail
    mirrorTail = splitLog(mirrorBytes).tail
  } catch {
    return 'conflicts'
  }
  if (localTail.equals(mirrorTail)) return 'same'
  // Локальный лог — префикс зеркального: в облаке больше событий.
  const localIsPrefix = mirrorTail.length >= localTail.length && mirrorTail.subarray(0, localTail.length).equals(localTail)
  if (localIsPrefix) return 'cloudAhead'
  // Зеркальный лог — префикс локального: локально больше событий.
  const mirrorIsPrefix = localTail.length >= mirrorTail.length && localTail.subarray(0, mirrorTail.length).equals(mirrorTail)
  if (mirrorIsPrefix) return 'localAhead'
  return 'conflicts'
}

/** Проекты для плана: один (с фильтром) или все настроенные. */
function selectedProjects(config, filter) {
  const ids = Object.keys(config.projects ?? {})
  if (!filter) return ids.map(id => [id, config.projects[id]])
  if (config.projects[filter] === undefined) throw new Error(`проект не настроен: ${filter} (см. project add)`)
  return [[filter, config.projects[filter]]]
}

/** Название сессии из `session.json` рядом с логом; пусто, если файла нет. */
async function sessionTitle(dir) {
  try {
    const sidecar = JSON.parse(await readFile(join(dir, SESSION_SIDECAR_FILE), 'utf8'))
    return typeof sidecar?.title === 'string' ? sidecar.title.trim() : ''
  } catch {
    return ''
  }
}

/** Размер лога в зеркале; 0, если файла нет. */
async function mirrorSize(repoDir, projectId, sessionId) {
  try {
    return (await stat(join(repoDir, 'sessions', projectId, encodeSegment(sessionId), 'session.v4.jsonl.zstd'))).size
  } catch {
    return 0
  }
}

/** Добавить сессию в корзину: счётчики полные, списки ограничены. */
function addToBucket(target, projectId, bucket, item) {
  target.counts[bucket] += 1
  target.sizes[bucket] += Number(item.size ?? 0) || 0
  const list = target.buckets[bucket]
  if (list.length < PLAN_LIST_LIMIT) list.push({ ...item, projectId })
}

/**
 * Построить план синхронизации: только чтение.
 *
 * @param home каталог DSH
 * @param config настройки синхронизации
 * @param project фильтр проекта (id) или undefined — все проекты
 * @param dshVersion версия DSH (для предупреждений о формате зеркала)
 * @returns {Promise<object>} план: корзины, размеры, удаления и счётчики
 */
export async function buildPlan({ home, config, project, dshVersion }) {
  const started = Date.now()
  const state = await readSyncState(home)
  const tombstones = await readTombstones(config.repoDir)
  const modes = await readSessionModes(home)
  const local = await listLocalSessions(home)
  const meta = await readMeta(config.repoDir)
  const mirrorFormat = typeof meta?.dsh?.format === 'number' ? meta.dsh.format : undefined
  const localVersion = typeof dshVersion === 'string' ? dshVersion : undefined

  const plan = {
    ok: true,
    action: 'plan',
    readOnly: true,
    mode: 'read-only',
    at: new Date().toISOString(),
    durationMs: 0,
    counts: emptyPlanCounts(),
    sizes: emptyPlanSizes(),
    buckets: Object.fromEntries(PLAN_BUCKETS.map(bucket => [bucket, []])),
    duplicates: emptyDuplicateSummary(),
    duplicateCount: 0,
    deletions: [],
    deletionCount: 0,
    deletionIds: [],
    groups: [],
    subagents: 0,
    known: 0,
    localSkipped: 0,
    projects: [],
    unknownProjects: [],
    warnings: [],
  }
  if (mirrorFormat !== undefined && mirrorFormat > LOG_FORMAT) {
    plan.warnings.push(`зеркало использует более новый формат логов (v${mirrorFormat}, поддерживается v${LOG_FORMAT}) — обновите DSH`)
  }
  if (localVersion !== undefined && typeof meta?.dsh?.version === 'string' && meta.dsh.version !== '') {
    const mirrorVersion = meta.dsh.version
    const parse = (value) => String(value).trim().split(/[.+-]/).map(part => Number.parseInt(part, 10))
    const left = parse(mirrorVersion)
    const right = parse(localVersion)
    if (left.every(Number.isFinite) && right.every(Number.isFinite)) {
      let newer = false
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0)
        if (diff !== 0) {
          newer = diff > 0
          break
        }
      }
      if (newer) plan.warnings.push(`зеркало синхронизировалось более новой версией DSH (${mirrorVersion}, у вас ${localVersion})`)
    }
  }

  // Проекты в зеркале, которых здесь нет: план их не трогает, но покажет.
  try {
    const configured = new Set(Object.keys(config.projects ?? {}))
    const root = join(config.repoDir, 'sessions')
    for (const entry of existsSync(root) ? await readdir(root, { withFileTypes: true }) : []) {
      if (!entry.isDirectory()) continue
      if (!configured.has(entry.name)) plan.unknownProjects.push(entry.name)
    }
  } catch {
    // список проектов — вспомогательная информация
  }

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const projectPlan = {
      id: projectId,
      path: entry?.path ?? '',
      local: 0,
      mirror: 0,
      counts: emptyPlanCounts(),
      sizes: emptyPlanSizes(),
      buckets: Object.fromEntries(PLAN_BUCKETS.map(bucket => [bucket, []])),
      duplicates: emptyDuplicateSummary(),
      deletions: [],
      deletionCount: 0,
      protected: { childrenMissing: 0, orphansProtected: 0, localMirrorProtected: 0 },
      localSkipped: 0,
      warning: undefined,
    }
    try {
      const allSessions = sessionsOfProject(local, entry?.path ?? '')
      const localGroups = groupsOf(allSessions)
      const modeView = resolveGroupModes(modes, allSessions, localGroups)
      // Сессии в режиме «локальная» в обмен не входят: они не отправляются,
      // не принимаются и не удаляются отметкой с другого устройства.
      const sessions = allSessions.filter(session => !modeView.localIds.has(normalizeSessionId(session.id)))
      const current = new Set(sessions.map(session => session.id))
      const localIds = new Set([...modeView.localIds].map(normalizeSessionId))
      projectPlan.local = sessions.length
      projectPlan.localSkipped = localIds.size

      const mirrorSessions = existsSync(join(config.repoDir, 'sessions', projectId))
        ? await listMirrorSessions(config.repoDir, projectId)
        : []
      projectPlan.mirror = mirrorSessions.length
      const mirrorById = new Map(mirrorSessions.map(session => [session.id, session]))
      const mirrorView = { ...groupsOf(mirrorSessions), sessions: mirrorSessions }
      const childrenMissing = missingChildren({ allSessions, mirrorView, current, localIds, tombstones })
      projectPlan.protected.childrenMissing = childrenMissing.length

      // Локальная сторона: exists only local / одинаковые / кто впереди.
      for (const session of sessions) {
        const mirror = mirrorById.get(session.id)
        const size = Number(session.size ?? session.bytes?.length ?? 0) || 0
        if (mirror === undefined) {
          addToBucket(projectPlan, projectId, 'onlyLocal', { id: session.id, size })
          continue
        }
        const relation = relationOf(session.bytes, mirror.bytes)
        addToBucket(projectPlan, projectId, relation, {
          id: session.id,
          size: relation === 'cloudAhead' ? Number(mirror.size ?? 0) || size : size,
        })
      }
      // Зеркальная сторона: то, чего локально нет.
      for (const mirror of mirrorSessions) {
        if (current.has(mirror.id)) continue
        if (localIds.has(normalizeSessionId(mirror.id))) continue
        addToBucket(projectPlan, projectId, 'onlyCloud', { id: mirror.id, size: Number(mirror.size ?? 0) || 0 })
      }

      // Дубли: копии одной сессии с разными id — информация, а не действие.
      planDuplicates(projectPlan, projectId, { sessions, mirrorSessions, localGroups, mirrorView, tombstones })

      // Удаления: только список, никаких изменений.
      const deletion = planDeletions({
        home,
        config,
        projectId,
        projectPath: entry?.path ?? '',
        previous: new Set(state.projects?.[projectId] ?? []),
        current,
        localIds,
        tombstones,
        mirrorView,
        childrenMissing,
      })
      projectPlan.protected.orphansProtected = deletion.orphansProtected.length
      projectPlan.protected.localMirrorProtected = deletion.protectedLocalMirror.size
      if (deletion.warning !== undefined) projectPlan.warning = deletion.warning
      for (const sessionId of [...deletion.planned].sort()) {
        const reason = deletionReason({
          sessionId,
          planned: deletion.planned,
          groupChildren: deletion.groupChildren,
          missing: deletion.missing,
          tombstones,
        })
        const item = {
          id: sessionId,
          projectId,
          size: await mirrorSize(config.repoDir, projectId, sessionId),
          reason: reason.reason,
          humanReason: reason.humanReason,
          groupChild: reason.groupChild,
        }
        if (reason.parent !== undefined) item.parent = reason.parent
        const title = await sessionTitle(join(config.repoDir, 'sessions', projectId, encodeSegment(sessionId)))
        if (title !== '') item.title = title
        projectPlan.deletions.push(item)
      }
      projectPlan.deletionCount = projectPlan.deletions.length
      plan.groups.push(...deletion.groups.map(group => ({ projectId, ...group })))
      plan.subagents += deletion.groups.reduce((total, group) => total + group.children.length, 0)
      plan.known += deletion.known
    } catch (error) {
      projectPlan.warning = `проект не проверен: ${error instanceof Error ? error.message : String(error)}`
    }

    // Свернуть проект в общий план.
    for (const bucket of PLAN_BUCKETS) {
      plan.counts[bucket] += projectPlan.counts[bucket]
      plan.sizes[bucket] += projectPlan.sizes[bucket]
      plan.buckets[bucket].push(...projectPlan.buckets[bucket].slice(0, PLAN_LIST_LIMIT - plan.buckets[bucket].length))
    }
    plan.deletions.push(...projectPlan.deletions)
    plan.deletionCount += projectPlan.deletionCount
    plan.localSkipped += projectPlan.localSkipped
    plan.duplicateCount += projectPlan.duplicates.count
    plan.duplicates.count += projectPlan.duplicates.count
    plan.duplicates.bytes += projectPlan.duplicates.bytes
    plan.duplicates.byContentHash += projectPlan.duplicates.byContentHash
    plan.duplicates.byEventsBytes += projectPlan.duplicates.byEventsBytes
    plan.duplicates.groups.push(...projectPlan.duplicates.groups
      .slice(0, Math.max(0, PLAN_DUPLICATE_GROUPS_LIMIT - plan.duplicates.groups.length))
      .map(group => ({ projectId, ...group })))
    if (projectPlan.warning !== undefined) plan.warnings.push(`${projectId}: ${projectPlan.warning}`)
    plan.projects.push(projectPlan)
  }

  plan.deletions.sort((left, right) => (left.projectId === right.projectId
    ? left.id.localeCompare(right.id)
    : left.projectId.localeCompare(right.projectId)))
  plan.deletionIds = plan.deletions.map(item => item.id).slice(0, 100)
  plan.hasChanges = plan.counts.onlyLocal > 0 || plan.counts.localAhead > 0
    || plan.counts.onlyCloud > 0 || plan.counts.cloudAhead > 0
    || plan.counts.conflicts > 0 || plan.deletionCount > 0
    || plan.counts.duplicates > 0
  if (plan.deletionCount > 0) {
    plan.requireConfirmation = {
      removed: plan.deletionCount,
      count: plan.deletionCount,
      known: plan.known,
      groups: plan.groups.slice(0, 20),
      subagents: plan.subagents,
      maxCount: PRUNE_MAX_COUNT,
      maxRatio: PRUNE_MAX_RATIO,
      overCount: plan.deletionCount > PRUNE_MAX_COUNT,
      overRatio: plan.known > 0 && plan.deletionCount / plan.known > PRUNE_MAX_RATIO,
      needsConfirmation: true,
    }
  }
  plan.message = plan.deletionCount > 0
    ? `Проверка выполнена: удалений ${plan.deletionCount} ждёт подтверждения; ничего не изменено.`
    : 'Проверка выполнена: удалений нет; ничего не изменено.'
  if (plan.duplicateCount > 0) plan.message += ` Дублей: ${plan.duplicateCount} (копии, можно оставить одну).`
  plan.durationMs = Date.now() - started
  return plan
}
