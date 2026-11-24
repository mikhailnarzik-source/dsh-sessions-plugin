/**
 * Безопасный первый вход в существующее облако.
 *
 * Резервный канал — второе место, куда уезжают сессии. Если включить его на
 * новом устройстве, в облаке уже может лежать чужая (старая) копия: слепая
 * отправка залила бы поверх неё локальное состояние. Поэтому перед первой
 * выгрузкой обязательна сверка:
 *
 * 1. забрать зеркало из облака в локальный кеш (`remote.sync()`);
 * 2. посчитать план: сколько сессий локально, в облаке и расходятся;
 * 3. принять данные из облака (`pull` из резерва) — сначала приём, потом отправка;
 * 4. записать отчёт в журнал и поднять флаг `secondary.initialized` в
 *    `~/.dsh/dsh-sync/state.json`.
 *
 * Перед полной загрузкой зеркала по возможности выполняется лёгкая сверка
 * (U3, `lightProbe()` у бэкенда): PROPFIND корня и чтение
 * `profile/manifest.json` без скачивания логов. Полный `sync()` остаётся для
 * загрузки данных; лёгкая сверка только показывает расхождения и не заменяет
 * сверку.
 *
 * Пока сверка не выполнена, `secondaryPushGate` блокирует выгрузку в резерв:
 * панель показывает «сначала сверка».
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRemote } from './remote.mjs'
import { pull, readSyncState, writeSyncState } from './sync.mjs'
import { canonicalize, listLocalSessions, listMirrorSessions, sessionsOfProject, splitLog } from './store.mjs'
import { frameSlices } from './frames.mjs'
import { normalizeBackend, RESERVE_CODES } from './webdav.mjs'
import { applyWorkspaceDefaults, isLocalSession } from './session-modes.mjs'
import { recordHistory } from './history.mjs'

export const SECONDARY_STATUS_FILE = 'secondary-status.json'

/** Подпись настроек резерва: при их изменении сверку нужно повторить. */
export function secondarySignature(secondary) {
  return [
    secondary?.backend ?? '',
    secondary?.folderDir ?? '',
    secondary?.webdavPath ?? '',
    secondary?.remote ?? '',
  ].join('|')
}

/** Короткая версия плана для состояния и журнала. */
function compactPlan(plan) {
  return {
    local: plan.local,
    cloud: plan.cloud,
    differ: plan.differ,
    onlyLocal: plan.onlyLocal,
    onlyCloud: plan.onlyCloud,
    aheadLocal: plan.aheadLocal,
    aheadCloud: plan.aheadCloud,
    conflicts: plan.conflicts,
  }
}

function humanPlan(plan) {
  return `локально ${plan.local}, в облаке ${plan.cloud}, расходятся ${plan.differ}`
}

/** Записать последний результат по резерву — его показывает панель. */
export async function writeSecondaryStatus(home, payload) {
  try {
    const dir = join(home, 'dsh-sync')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, SECONDARY_STATUS_FILE),
      `${JSON.stringify({ ...payload, at: payload.at ?? new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // состояние резерва не критично
  }
}

/** Прочитать последний результат по резерву. */
export async function readSecondaryStatus(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'dsh-sync', SECONDARY_STATUS_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    return {
      ok: parsed.ok === true,
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      backend: typeof parsed.backend === 'string' ? parsed.backend : undefined,
      message: typeof parsed.message === 'string' ? parsed.message.slice(0, 300) : '',
      at: typeof parsed.at === 'string' ? parsed.at : undefined,
      percent: typeof parsed.percent === 'number' ? parsed.percent : undefined,
      uploaded: typeof parsed.uploaded === 'number' ? parsed.uploaded : undefined,
    }
  } catch {
    return undefined
  }
}

/** Состояние резерва из state.json (флаг initialized и отчёт сверки). */
export async function readSecondaryState(home) {
  const state = await readSyncState(home)
  return state?.secondary ?? undefined
}

/** Сбросить флаг сверки: настройки резерва изменились. */
export async function resetSecondaryInitialization(home, reason = '') {
  try {
    const state = await readSyncState(home)
    state.secondary = {
      initialized: false,
      resetAt: new Date().toISOString(),
      reason: typeof reason === 'string' ? reason.slice(0, 200) : '',
    }
    await writeSyncState(home, state)
  } catch {
    // состояние — вспомогательные данные
  }
}

async function markSecondaryInitialized(home, secondary, plan, pulled) {
  const state = await readSyncState(home)
  state.secondary = {
    initialized: true,
    backend: secondary.backend,
    signature: secondarySignature(secondary),
    at: new Date().toISOString(),
    plan: compactPlan(plan),
    pulled: {
      imported: Number(pulled?.imported ?? 0),
      updated: Number(pulled?.updated ?? 0),
      conflicts: Number(pulled?.conflicts ?? 0),
      deleted: Number(pulled?.deleted ?? 0),
    },
  }
  await writeSyncState(home, state)
}

/** Готов ли резерв к выгрузке (сверка выполнена и настройки не менялись). */
export async function secondaryPushGate({ home, secondary }) {
  if (secondary === undefined) return { ok: true, skipped: true }
  const init = await readSecondaryState(home)
  if (init?.initialized === true && init.signature === secondarySignature(secondary)) {
    return { ok: true, initialized: true, at: init.at, plan: init.plan }
  }
  return {
    ok: false,
    code: 'secondary/needs-compare',
    message: 'резервный канал ещё не сверен с облаком — сначала сверка: нажмите «Сверить» в карточке «Резервный канал», затем повторите отправку',
  }
}

/**
 * План сверки: сравнить локальные сессии с тем, что лежит в зеркале резерва.
 * К этому моменту зеркало уже забрано из облака в кеш (`remote.sync()`).
 */
export async function buildSecondaryPlan({ home, config, secondary }) {
  const local = await listLocalSessions(home)
  // Новые сессии получают умолчание своего рабочего пространства и в резервном
  // канале: «локальная» не должна появиться в облаке ни при каком пути.
  const modes = (await applyWorkspaceDefaults(home)).modes
  const plan = {
    local: 0,
    cloud: 0,
    differ: 0,
    onlyLocal: 0,
    onlyCloud: 0,
    aheadLocal: 0,
    aheadCloud: 0,
    conflicts: 0,
    skippedLocal: 0,
    projects: [],
  }
  for (const [projectId, entry] of Object.entries(config.projects ?? {})) {
    const stats = {
      id: projectId,
      local: 0,
      cloud: 0,
      differ: 0,
      onlyLocal: 0,
      onlyCloud: 0,
      aheadLocal: 0,
      aheadCloud: 0,
      conflicts: 0,
    }
    const localSessions = sessionsOfProject(local, entry.path).filter(session => !isLocalSession(modes, session.id))
    const localById = new Map(localSessions.map(session => [session.id, session]))
    let cloudSessions = []
    try {
      cloudSessions = await listMirrorSessions(secondary.repoDir, projectId)
    } catch {
      cloudSessions = []
    }
    stats.local = localSessions.length
    plan.local += localSessions.length

    const cloudIds = new Set()
    for (const remoteSession of cloudSessions) {
      if (isLocalSession(modes, remoteSession.id)) {
        plan.skippedLocal += 1
        continue
      }
      cloudIds.add(remoteSession.id)
      const localSession = localById.get(remoteSession.id)
      if (localSession === undefined) {
        stats.onlyCloud += 1
        plan.onlyCloud += 1
        continue
      }
      let localTail
      let remoteTail
      try {
        localTail = splitLog(localSession.bytes).tail
        remoteTail = splitLog(remoteSession.bytes).tail
      } catch {
        stats.differ += 1
        plan.differ += 1
        continue
      }
      if (localTail.equals(remoteTail)) continue
      stats.differ += 1
      plan.differ += 1
      const localExtends = localTail.length > remoteTail.length && localTail.subarray(0, remoteTail.length).equals(remoteTail)
      const cloudExtends = remoteTail.length > localTail.length && remoteTail.subarray(0, localTail.length).equals(localTail)
      if (localExtends) {
        stats.aheadLocal += 1
        plan.aheadLocal += 1
      } else if (cloudExtends) {
        stats.aheadCloud += 1
        plan.aheadCloud += 1
      } else {
        stats.conflicts += 1
        plan.conflicts += 1
      }
    }
    for (const localSession of localSessions) {
      if (cloudIds.has(localSession.id)) continue
      stats.onlyLocal += 1
      plan.onlyLocal += 1
    }
    stats.cloud = cloudIds.size
    plan.cloud += cloudIds.size
    plan.projects.push(stats)
  }
  return plan
}

/**
 * Локальный слепок для лёгкой сверки (U3): id, число событий и размер
 * канонического лога — такой же, как лежит в облаке. Ничего не скачивает:
 * читается только локальный стор. Локальные (режим «локальная») сессии не
 * участвуют — они и не должны появляться в облаке.
 *
 * @returns [{ id, project, events, sizeBytes }]
 */
export async function collectLocalProbeEntries({ home, config }) {
  const local = await listLocalSessions(home)
  let modes = {}
  try {
    modes = (await applyWorkspaceDefaults(home)).modes
  } catch {
    // режимы недоступны — считаем, что локальных сессий нет
  }
  const entries = []
  for (const [projectId, entry] of Object.entries(config?.projects ?? {})) {
    for (const session of sessionsOfProject(local, entry?.path)) {
      if (isLocalSession(modes, session.id)) continue
      let events = 0
      let sizeBytes
      try {
        // Число кадров минус кадр-заголовок — дешёвая оценка числа событий.
        events = Math.max(0, frameSlices(session.bytes).length - 1)
        sizeBytes = canonicalize(session.bytes, projectId).length
      } catch {
        events = 0
        sizeBytes = session.size
      }
      entries.push({ id: session.id, project: projectId, events, sizeBytes })
    }
  }
  entries.sort((left, right) => left.id.localeCompare(right.id))
  return entries
}

/** Короткая версия результата лёгкой сверки для состояния и журнала. */
function compactProbe(probe) {
  if (probe === null || probe === undefined) return undefined
  return {
    ok: probe.ok === true,
    code: probe.code,
    backend: probe.backend,
    local: Number(probe.local?.count ?? 0),
    cloud: Number(probe.cloud?.count ?? 0),
    onlyLocal: Number(probe.onlyLocal ?? 0),
    onlyCloud: Number(probe.onlyCloud ?? 0),
    differ: Number(probe.differ ?? 0),
    durationMs: Number(probe.durationMs ?? 0),
    message: typeof probe.message === 'string' ? probe.message : '',
  }
}

/**
 * Лёгкая сверка резерва (U3) без скачивания логов.
 *
 * Если бэкенд не умеет `lightProbe` (папка, git, Яндекс REST), возвращается
 * `{ ok: false, skipped: true, code: 'reserve/unsupported' }` — это не ошибка:
 * для таких каналов сверка идёт полной загрузкой. Методы единого интерфейса
 * отсутствовать не должны: `normalizeBackend()` даёт заглушки, которые бросают
 * понятную ошибку с кодом `reserve/unsupported`, а не TypeError.
 */
export async function probeSecondaryChannel({ home, config = {}, secondary, remote, local, timeoutMs, writeStatus = true } = {}) {
  if (secondary === undefined) {
    return { ok: false, code: 'secondary/not-configured', message: 'резервный канал не настроен' }
  }
  let backend
  try {
    backend = normalizeBackend(remote ?? await createRemote(secondary), { kind: secondary.backend })
  } catch (error) {
    const message = `лёгкая сверка резерва не удалась: ${error instanceof Error ? error.message : String(error)}`
    if (writeStatus) await writeSecondaryStatus(home, { ok: false, code: RESERVE_CODES.failed, backend: secondary.backend, message })
    return { ok: false, code: RESERVE_CODES.failed, backend: secondary.backend, message }
  }
  if (backend.capabilities.lightProbe !== true || backend.supports('lightProbe') !== true) {
    return {
      ok: false,
      skipped: true,
      code: RESERVE_CODES.unsupported,
      backend: backend.kind,
      message: `резервный канал «${backend.kind}» не поддерживает лёгкую сверку (${RESERVE_CODES.unsupported}) — нужна полная сверка с загрузкой`,
    }
  }
  const entries = Array.isArray(local) ? local : await collectLocalProbeEntries({ home, config })
  let probe
  try {
    probe = await backend.lightProbe({ local: entries, projects: Object.keys(config?.projects ?? {}), timeoutMs })
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : RESERVE_CODES.failed
    const message = `лёгкая сверка резерва не удалась: ${error instanceof Error ? error.message : String(error)}`
    if (writeStatus) await writeSecondaryStatus(home, { ok: false, code, backend: backend.kind, message })
    return { ok: false, code, backend: backend.kind, message }
  }
  const ok = probe?.ok === true
  const message = ok
    ? `лёгкая сверка: локально ${probe.local.count}, в облаке ${probe.cloud.count}, только локально ${probe.onlyLocal}, только в облаке ${probe.onlyCloud}, расходятся ${probe.differ}`
    : (typeof probe?.message === 'string' && probe.message !== '' ? probe.message : 'лёгкая сверка не удалась')
  if (writeStatus) await writeSecondaryStatus(home, { ok, code: probe?.code, backend: backend.kind, message })
  return { ...probe, backend: backend.kind, message }
}

/**
 * Выполнить безопасный первый вход: сверка, приём из облака и флаг initialized.
 * Без успешного выполнения выгрузка в резерв заблокирована (secondaryPushGate).
 */
export async function initializeSecondaryChannel({ home, config, secondary, dshVersion }) {
  const started = Date.now()
  if (secondary === undefined) {
    return { ok: false, code: 'secondary/not-configured', message: 'резервный канал не настроен' }
  }
  let plan
  let lightProbe = null
  try {
    // Зеркало из облака → локальный кеш. Для папки это копирование файлов,
    // для WebDAV — скачивание изменённого, для git — fetch.
    const remote = await createRemote(secondary)
    // Лёгкая сверка до полной загрузки: PROPFIND корня и манифест вместо
    // скачивания логов. Бэкенд без lightProbe — не ошибка, сверяемся полной
    // загрузкой; сама лёгкая сверка ничего не решает и не блокирует.
    const lightResult = await probeSecondaryChannel({ home, config, secondary, remote, writeStatus: false })
    lightProbe = lightResult?.skipped === true ? null : lightResult
    await remote.sync()
    plan = await buildSecondaryPlan({ home, config, secondary })
  } catch (error) {
    const message = `сверка резерва не удалась: ${error instanceof Error ? error.message : String(error)}`
    await writeSecondaryStatus(home, { ok: false, code: 'secondary/compare-failed', backend: secondary.backend, message })
    await recordHistory(home, {
      ok: false,
      action: 'secondary-init',
      mode: 'builtin',
      message,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    })
    return { ok: false, code: 'secondary/compare-failed', backend: secondary.backend, message }
  }

  // Сначала приём, потом отправка: в облаке могли быть сессии с другого
  // устройства, и они должны оказаться локально до первого push.
  let pulled = null
  if (plan.cloud > 0) {
    try {
      pulled = await pull({
        home,
        config: { ...secondary, profile: { enabled: false }, workspace: { enabled: false } },
        dshVersion,
      })
    } catch (error) {
      const message = `сверка выполнена (${humanPlan(plan)}), но принять данные из облака не удалось: ${error instanceof Error ? error.message : String(error)}`
      await writeSecondaryStatus(home, { ok: false, code: 'secondary/pull-failed', backend: secondary.backend, message })
      await recordHistory(home, {
        ok: false,
        action: 'secondary-init',
        mode: 'builtin',
        message,
        plan: compactPlan(plan),
        durationMs: Date.now() - started,
        at: new Date().toISOString(),
      })
      return { ok: false, code: 'secondary/pull-failed', backend: secondary.backend, plan, message }
    }
  }

  await markSecondaryInitialized(home, secondary, plan, pulled)
  const accepted = Number(pulled?.imported ?? 0)
  const message = `резерв сверен: ${humanPlan(plan)}; принято из облака: ${accepted}`
  await writeSecondaryStatus(home, {
    ok: true,
    code: 'secondary/initialized',
    backend: secondary.backend,
    message,
  })
  await recordHistory(home, {
    ok: true,
    action: 'secondary-init',
    mode: 'builtin',
    message,
    plan: compactPlan(plan),
    probe: compactProbe(lightProbe),
    pulled: { imported: accepted, updated: Number(pulled?.updated ?? 0), conflicts: Number(pulled?.conflicts ?? 0) },
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  })
  return {
    ok: true,
    initialized: true,
    code: 'secondary/initialized',
    backend: secondary.backend,
    plan,
    probe: lightProbe === null ? undefined : compactProbe(lightProbe),
    pulled: {
      imported: accepted,
      updated: Number(pulled?.updated ?? 0),
      conflicts: Number(pulled?.conflicts ?? 0),
      deleted: Number(pulled?.deleted ?? 0),
    },
    message,
  }
}

/** Записать, что выгрузка в резерв заблокирована до сверки. */
export async function noteSecondaryBlocked(home, secondary, gate) {
  const message = gate?.message ?? 'резервный канал ещё не сверен с облаком'
  await writeSecondaryStatus(home, {
    ok: false,
    code: gate?.code ?? 'secondary/needs-compare',
    backend: secondary?.backend,
    message,
  })
}

/** Записать успешную выгрузку в резерв (для панели). */
export async function noteSecondaryPush(home, secondary, result) {
  const uploaded = Number(result?.pushed ?? result?.uploaded ?? 0)
  const message = `резерв: отправлено ${uploaded}`
  await writeSecondaryStatus(home, {
    ok: true,
    code: 'secondary/pushed',
    backend: secondary?.backend,
    uploaded,
    message,
  })
  try {
    const state = await readSyncState(home)
    if (state.secondary !== undefined && state.secondary !== null) {
      state.secondary.lastPushAt = new Date().toISOString()
      state.secondary.lastPushOk = true
      state.secondary.lastPushUploaded = uploaded
      await writeSyncState(home, state)
    }
  } catch {
    // отметка в состоянии — вспомогательная
  }
}

/** Записать неудачную выгрузку в резерв (для панели). */
export async function noteSecondaryFailure(home, secondary, error) {
  await writeSecondaryStatus(home, {
    ok: false,
    code: 'secondary/push-failed',
    backend: secondary?.backend,
    message: `резерв не отправлен: ${error instanceof Error ? error.message : String(error)}`,
  })
  try {
    const state = await readSyncState(home)
    if (state.secondary !== undefined && state.secondary !== null) {
      state.secondary.lastPushAt = new Date().toISOString()
      state.secondary.lastPushOk = false
      state.secondary.lastPushMessage = error instanceof Error ? error.message : String(error)
      await writeSyncState(home, state)
    }
  } catch {
    // отметка в состоянии — вспомогательная
  }
}
