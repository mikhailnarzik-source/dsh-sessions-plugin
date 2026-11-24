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
import {
  RESERVE_CODES,
  RESERVE_ERROR_CODES,
  SECONDARY_FILE_TIMEOUT_MS,
  SECONDARY_OPERATION_TIMEOUT_MS,
  classifyReserveError,
  normalizeBackend,
  reserveError,
  reserveErrorHint,
} from './webdav.mjs'
import { backupProgress } from './progress.mjs'
import { applyWorkspaceDefaults, isLocalSession } from './session-modes.mjs'
import { recordHistory } from './history.mjs'

export const SECONDARY_STATUS_FILE = 'secondary-status.json'

/** Фазы полной сверки: их показывает полоса прогресса в карточке. */
export const SECONDARY_INIT_PHASES = Object.freeze({
  starting: 'подготовка',
  listing: 'читаем состав облака',
  download: 'скачиваем файлы',
  plan: 'считаем расхождения',
  pull: 'принимаем данные из облака',
  done: 'готово',
})




/** Положительное число из настройки или значение по умолчанию. */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

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
    const totals = parsed.totals !== null && typeof parsed.totals === 'object'
      ? {
          files: Number(parsed.totals.files ?? 0),
          bytes: Number(parsed.totals.bytes ?? 0),
          downloaded: Number(parsed.totals.downloaded ?? 0),
          skipped: Number(parsed.totals.skipped ?? 0),
          resumed: Number(parsed.totals.resumed ?? 0),
          failed: Number(parsed.totals.failed ?? 0),
        }
      : undefined
    return {
      ok: parsed.ok === true,
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      backend: typeof parsed.backend === 'string' ? parsed.backend : undefined,
      message: typeof parsed.message === 'string' ? parsed.message.slice(0, 300) : '',
      at: typeof parsed.at === 'string' ? parsed.at : undefined,
      percent: typeof parsed.percent === 'number' ? parsed.percent : undefined,
      uploaded: typeof parsed.uploaded === 'number' ? parsed.uploaded : undefined,
      // Полная сверка: что именно случилось и что делать человеку.
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
      phase: typeof parsed.phase === 'string' ? parsed.phase : undefined,
      running: parsed.running === true,
      cancelled: parsed.cancelled === true,
      file: typeof parsed.file === 'string' ? parsed.file.slice(0, 300) : '',
      hint: typeof parsed.hint === 'string' ? parsed.hint.slice(0, 500) : '',
      totals,
      progress: parsed.progress !== null && typeof parsed.progress === 'object' ? parsed.progress : undefined,
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

/** Активная полная сверка резерва — одна на процесс (её видит маршрут status). */
let activeInit = null

function emptyInitProgress() {
  return {
    phase: 'starting',
    filesTotal: 0,
    filesDone: 0,
    filesProcessed: 0,
    bytesTotal: 0,
    bytesDone: 0,
    downloaded: 0,
    skipped: 0,
    resumed: 0,
    failed: 0,
    currentFile: '',
    percent: 0,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
  }
}

/**
 * Снимок идущей полной сверки для GET /secondary-init/status и карточки.
 * Пока сверка не идёт, возвращает `{ running: false }`.
 */
export function secondaryInitSnapshot() {
  const active = activeInit
  if (active === null) return { running: false, progress: null }
  return {
    running: true,
    id: active.id,
    backend: active.backend,
    startedAt: active.startedAt,
    cancelRequested: active.cancelRequested === true,
    progress: { ...active.progress },
  }
}

/**
 * Отменить идущую полную сверку. Уже скачанные файлы и `.part` остаются:
 * следующий запуск продолжит с места остановки.
 * @returns {{ ok: boolean, code?: string, message: string }}
 */
export function cancelSecondaryInit(reason = '') {
  const active = activeInit
  if (active === null) {
    return { ok: false, code: 'secondary/not-running', message: 'сверка резерва сейчас не идёт — отменять нечего' }
  }
  active.cancelRequested = true
  active.cancelReason = typeof reason === 'string' ? reason.slice(0, 200) : ''
  active.controller.abort(new Error('secondary-init/cancelled'))
  return {
    ok: true,
    code: 'secondary/cancelling',
    message: 'отмена запрошена: скачивание остановится, уже скачанное останется в кеше',
  }
}

/**
 * Полный статус резерва для GET /secondary-init/status и карточки.
 *
 * Состояния ровно четыре (П6): «не сверен» / «сверяется» / «сверен» / «ошибка».
 * Живой прогресс берётся из памяти, итог — из `secondary-status.json` и
 * `secondary.initialized` в state.json.
 */
export async function readSecondaryInitStatus({ home, secondary } = {}) {
  const active = secondaryInitSnapshot()
  const status = await readSecondaryStatus(home)
  let init
  try {
    init = await readSecondaryState(home)
  } catch {
    init = undefined
  }
  const initialized = init?.initialized === true
  const interrupted = status?.running === true && active.running !== true
  const failedCode = typeof status?.code === 'string' ? status.code : ''
  const cancelledLast = status?.cancelled === true || /cancelled|отмен/i.test(failedCode)
  const failed = status?.ok === false
    && !/needs-compare|not-configured|comparing|not-running/.test(failedCode)
    && !interrupted
    && !cancelledLast
    && !initialized

  let state
  let label
  let message
  if (active.running) {
    state = 'comparing'
    label = 'сверяется'
    message = `полная сверка идёт: ${active.progress.filesDone} из ${active.progress.filesTotal} файлов`
  } else if (interrupted) {
    state = 'not-compared'
    label = 'не сверен'
    message = 'сверка была прервана — повторите «Синхронизировать резерв», уже скачанное сохранено'
  } else if (initialized) {
    state = 'compared'
    label = 'сверен'
    message = status?.message ?? 'состав облака сверен'
  } else if (failed) {
    state = 'error'
    label = 'ошибка'
    message = status?.message ?? 'сверка резерва не удалась'
  } else {
    state = 'not-compared'
    label = 'не сверен'
    message = status?.message ?? 'сначала сверка: отправка в резерв заблокирована'
  }

  const totals = status?.totals ?? (initialized && Number(init?.files ?? 0) >= 0
    ? { files: Number(init?.files ?? 0), bytes: Number(init?.bytes ?? 0) }
    : undefined)
  const code = active.running ? 'secondary/comparing' : status?.code
  return {
    ok: true,
    state,
    label,
    running: active.running === true,
    cancelRequested: active.cancelRequested === true,
    backend: secondary?.backend ?? status?.backend ?? init?.backend,
    initialized,
    phase: active.running ? active.progress.phase : (status?.phase ?? undefined),
    progress: active.running ? active.progress : (status?.progress ?? null),
    totals,
    file: status?.file ?? '',
    hint: status?.hint ?? (state === 'error' ? reserveErrorHint(normalizeStatusCode(code)) : ''),
    code,
    message,
    plan: init?.plan ?? null,
    pulled: init?.pulled ?? null,
    at: active.startedAt ?? status?.at ?? init?.at,
    startedAt: active.startedAt,
    device: init?.device,
  }
}

/** Код панели (401/403/timeout/tls/network/quota) из кода статуса резерва. */
function normalizeStatusCode(code) {
  const text = String(code ?? '')
  if (text === '401' || /unauthorized/.test(text)) return RESERVE_ERROR_CODES.unauthorized
  if (text === '403' || /forbidden/.test(text)) return RESERVE_ERROR_CODES.forbidden
  if (text === 'timeout' || /timeout/.test(text)) return RESERVE_ERROR_CODES.timeout
  if (text === 'tls') return RESERVE_ERROR_CODES.tls
  if (text === 'quota') return RESERVE_ERROR_CODES.quota
  if (text === 'network') return RESERVE_ERROR_CODES.network
  return ''
}

/**
 * Отметить сверку выполненной: флаг initialized, подпись настроек и итоги.
 * `totals` — сколько файлов и байт скачано из облака в кеш резерва.
 */
async function markSecondaryInitialized(home, secondary, plan, pulled, totals) {
  const state = await readSyncState(home)
  state.secondary = {
    initialized: true,
    backend: secondary.backend,
    signature: secondarySignature(secondary),
    at: new Date().toISOString(),
    plan: compactPlan(plan),
    files: Number(totals?.files ?? 0),
    bytes: Number(totals?.bytes ?? 0),
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
 *
 * П4–П7 резервного канала:
 * - полная загрузка резюмируемая: `<файл>.part`, пропуск уже скачанного,
 *   продолжение после обрыва (делает WebDAV-бэкенд в `remote.sync()`);
 * - таймауты: файл — 30 с, вся операция — 15 мин; отмена — `cancelSecondaryInit`;
 * - ошибки: `{ code: '401'|'403'|'timeout'|'tls'|'network'|'quota', file,
 *   message, hint }` — карточка показывает действие, а не HTTP-код;
 * - прогресс `{ filesDone/filesTotal, bytesDone/bytesTotal, currentFile }`
 *   виден через `secondaryInitSnapshot()` и GET /secondary-init/status;
 * - основная синхронизация резерв не ждёт: у операции нет общего лока, она
 *   идёт отдельным запросом и не блокирует push/pull.
 *
 * @returns результат с `totals`: сколько файлов/байт в облаке, скачано,
 *   пропущено и с ошибкой. При отмене — `ok:false, cancelled:true`.
 */
export async function initializeSecondaryChannel({ home, config, secondary, dshVersion, signal, operationTimeoutMs, onProgress } = {}) {
  const started = Date.now()
  if (secondary === undefined) {
    return { ok: false, code: 'secondary/not-configured', message: 'резервный канал не настроен' }
  }
  // Одна полная сверка на процесс: второй запрос не должен запускать
  // параллельное скачивание тех же файлов.
  if (activeInit !== null) {
    return {
      ok: false,
      initializing: true,
      code: 'secondary/busy',
      backend: secondary.backend,
      message: 'полная сверка резерва уже идёт — дождитесь завершения или нажмите «Отменить»',
      hint: 'Прогресс виден в карточке «Резервный канал».',
    }
  }

  const budget = positiveNumber(operationTimeoutMs, SECONDARY_OPERATION_TIMEOUT_MS)
  const startedIso = new Date(started).toISOString()
  const run = {
    id: `secondary-${started}`,
    backend: secondary.backend,
    startedAt: startedIso,
    controller: new AbortController(),
    progress: emptyInitProgress(),
    cancelRequested: false,
    cancelReason: '',
    timedOut: false,
  }
  run.progress.startedAt = startedIso
  activeInit = run
  const updateProgress = (patch = {}) => {
    run.progress = {
      ...run.progress,
      ...patch,
      elapsedMs: Date.now() - started,
      updatedAt: new Date().toISOString(),
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({ ...run.progress })
      } catch {
        // подписчик прогресса не должен ронять сверку
      }
    }
    return run.progress
  }
  const aborted = () => run.controller.signal.aborted
  const budgetText = budget >= 60_000 ? `${Math.round(budget / 60_000)} мин` : `${Math.max(1, Math.round(budget / 1000))} с`
  const cancelError = () => (run.timedOut
    ? reserveError(
        RESERVE_ERROR_CODES.timeout,
        `полная сверка не уложилась в ${budgetText}`,
        { file: run.progress.currentFile },
      )
    : reserveError(
        RESERVE_ERROR_CODES.cancelled,
        'сверка отменена пользователем',
        { file: run.progress.currentFile, cancelled: true },
      ))
  const checkCancelled = () => {
    if (aborted()) throw cancelError()
  }
  const onExternalAbort = () => cancelSecondaryInit('внешний сигнал')
  if (signal !== undefined && signal !== null) {
    if (signal.aborted === true) cancelSecondaryInit('внешний сигнал')
    else signal.addEventListener?.('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => {
    run.timedOut = true
    run.controller.abort(new Error('secondary-init/timeout'))
  }, budget)
  timer.unref?.()

  // Стартовый статус: если процесс упадёт, карточка покажет «сверка прервана»,
  // а не вечное «идёт».
  await writeSecondaryStatus(home, {
    ok: true,
    running: true,
    scope: 'secondary-init',
    code: 'secondary/comparing',
    backend: secondary.backend,
    phase: 'listing',
    message: 'полная сверка резерва идёт: читаем состав облака',
    progress: { ...run.progress },
    at: startedIso,
  })

  let plan
  let lightProbe = null
  let pulled = null
  let totals
  try {
    updateProgress({ phase: 'listing' })
    // Зеркало из облака → локальный кеш. Для папки это копирование файлов,
    // для WebDAV — резюмируемое скачивание, для git — fetch.
    const remote = await createRemote(secondary)
    // Лёгкая сверка до полной загрузки: PROPFIND корня и манифест вместо
    // скачивания логов. Бэкенд без lightProbe — не ошибка, сверяемся полной
    // загрузкой; сама лёгкая сверка ничего не решает и не блокирует.
    if (aborted() !== true) {
      const lightResult = await probeSecondaryChannel({ home, config, secondary, remote, writeStatus: false })
      lightProbe = lightResult?.skipped === true ? null : lightResult
    }
    checkCancelled()
    updateProgress({ phase: 'download', message: 'скачиваем файлы из облака' })
    // Полная загрузка: резюме, пропуск готового, прогресс, отмена, таймауты.
    const remainingBudget = Math.max(1_000, budget - (Date.now() - started))
    const syncResult = await remote.sync({
      signal: run.controller.signal,
      operationTimeoutMs: remainingBudget,
      // Аудит резервного канала: файл — 30 с, вся операция — 15 мин.
      fileTimeoutMs: SECONDARY_FILE_TIMEOUT_MS,
      onProgress: (snapshot) => updateProgress(snapshot),
    })
    checkCancelled()
    totals = syncResult !== null && typeof syncResult === 'object' && syncResult.totals !== undefined
      ? syncResult.totals
      : await replicaTotals(secondary)
    updateProgress({ phase: 'plan', totals, message: 'считаем расхождения' })
    plan = await buildSecondaryPlan({ home, config, secondary })
    checkCancelled()

    // Сначала приём, потом отправка: в облаке могли быть сессии с другого
    // устройства, и они должны оказаться локально до первого push.
    if (plan.cloud > 0) {
      updateProgress({ phase: 'pull', message: 'принимаем данные из облака' })
      pulled = await pull({
        home,
        config: { ...secondary, profile: { enabled: false }, workspace: { enabled: false } },
        dshVersion,
      })
      checkCancelled()
    }

    await markSecondaryInitialized(home, secondary, plan, pulled, totals)
    const accepted = Number(pulled?.imported ?? 0)
    const message = `резерв сверен: ${humanPlan(plan)}; файлов ${totals.files} (${formatMegabytes(totals.bytes)}); принято из облака: ${accepted}`
    updateProgress({ phase: 'done', totals, percent: 100, message })
    await writeSecondaryStatus(home, {
      ok: true,
      running: false,
      scope: 'secondary-init',
      code: 'secondary/initialized',
      backend: secondary.backend,
      phase: 'done',
      totals,
      percent: 100,
      message,
      durationMs: Date.now() - started,
    })
    await recordHistory(home, {
      ok: true,
      action: 'secondary-init',
      mode: 'builtin',
      message,
      plan: compactPlan(plan),
      totals,
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
      totals,
      progress: { ...run.progress },
      probe: lightProbe === null ? undefined : compactProbe(lightProbe),
      pulled: {
        imported: accepted,
        updated: Number(pulled?.updated ?? 0),
        conflicts: Number(pulled?.conflicts ?? 0),
        deleted: Number(pulled?.deleted ?? 0),
      },
      message,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    const described = classifyReserveError(error, { file: run.progress.currentFile })
    const cancelled = described.cancelled === true || (aborted() && run.timedOut !== true)
    const code = cancelled ? RESERVE_ERROR_CODES.cancelled : described.code
    const file = described.file ?? ''
    const phrase = cancelled
      ? 'сверка отменена: уже скачанное осталось в кеше, следующий запуск продолжит с места остановки'
      : `полная сверка резерва не удалась${file !== '' ? ` (файл ${file})` : ''}: ${described.message}`
    updateProgress({ phase: cancelled ? 'cancelled' : 'error', message: phrase, failed: run.progress.failed })
    const finalTotals = described.totals ?? totals ?? totalsOfProgress(run.progress)
    await writeSecondaryStatus(home, {
      ok: false,
      running: false,
      scope: 'secondary-init',
      code,
      backend: secondary.backend,
      phase: run.progress.phase,
      file,
      hint: described.hint,
      totals: finalTotals,
      progress: { ...run.progress },
      cancelled,
      message: phrase,
      durationMs: Date.now() - started,
    })
    await recordHistory(home, {
      ok: false,
      action: 'secondary-init',
      mode: 'builtin',
      code,
      file,
      message: phrase,
      plan: plan === undefined ? undefined : compactPlan(plan),
      totals: finalTotals,
      cancelled,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    })
    return {
      ok: false,
      initialized: false,
      backend: secondary.backend,
      code,
      file,
      message: phrase,
      hint: described.hint,
      totals: finalTotals,
      progress: { ...run.progress },
      plan,
      cancelled,
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onExternalAbort)
    run.progress.elapsedMs = Date.now() - started
    if (activeInit === run) activeInit = null
  }
}

/** Итоги кеша резерва для каналов, которые не считают файлы сами. */
async function replicaTotals(secondary) {
  try {
    const backup = await backupProgress(secondary.repoDir, { maxFileBytes: Number.POSITIVE_INFINITY })
    return {
      files: Number(backup.totalFiles ?? 0),
      bytes: Number(backup.totalBytes ?? 0),
      downloaded: 0,
      skipped: Number(backup.totalFiles ?? 0),
      resumed: 0,
      failed: 0,
    }
  } catch {
    return { files: 0, bytes: 0, downloaded: 0, skipped: 0, resumed: 0, failed: 0 }
  }
}

function totalsOfProgress(progress) {
  return {
    files: Number(progress?.filesTotal ?? 0),
    bytes: Number(progress?.bytesTotal ?? 0),
    downloaded: Number(progress?.downloaded ?? 0),
    skipped: Number(progress?.skipped ?? 0),
    resumed: Number(progress?.resumed ?? 0),
    failed: Number(progress?.failed ?? 0),
  }
}

function formatMegabytes(bytes) {
  return `${(Number(bytes ?? 0) / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`
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
