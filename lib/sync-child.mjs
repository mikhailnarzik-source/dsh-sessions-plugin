#!/usr/bin/env node
/**
 * Синхронизация в отдельном процессе: host-процесс DSH может отличаться от
 * обычного Node (другая сборка zlib, ограничения файловой системы), а движку
 * нужны и чтение сторов, и zstd. Дочерний процесс запускается на штатном Node
 * и печатает результат одной JSON-строкой.
 *
 * Использование: node sync-child.mjs <sync|pull|push|plan|prune> [--confirm-prune]
 * Каталог DSH берётся из $DSH_HOME (или ~/.dsh), как у CLI.
 * `plan` только читает и сравнивает (ничего не пишет, журнал не обновляет).
 * `prune` применяет подтверждённые удаления в карантин: список id — в
 * $DSH_SYNC_PRUNE_IDS (JSON-массив), сами удаления без подтверждения не идут.
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadConfig, resolveDshHome } from './config.mjs'
import { pullReplicated, pushReplicated } from './replica.mjs'
import { acquireLock } from './lock.mjs'
import { classifyErrorKind, localSkipStats, recordRun, removalDetails, subagentStats } from './history.mjs'
import { applyDeletions, detectDshVersion } from './sync.mjs'
import { buildPlan } from './plan.mjs'

const ACTIONS = ['sync', 'pull', 'push', 'plan', 'prune']
const action = ACTIONS.includes(process.argv[2]) ? process.argv[2] : 'sync'
const confirmPrune = process.argv.includes('--confirm-prune')
const home = resolveDshHome(undefined)
const started = Date.now()
const dshVersion = await detectDshVersion()

/** Список id, которые план показал для удаления (необязательное сужение). */
function pruneIds() {
  const raw = process.env.DSH_SYNC_PRUNE_IDS
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    const ids = parsed.filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
    return ids.length > 0 ? ids : undefined
  } catch {
    return undefined
  }
}

/**
 * Вид ошибки запуска для панели: явная отметка канала сильнее подсчёта.
 * Порядок: format/auth из сводок → резервный канал → защита зеркала → текст
 * первой ошибки чтения (сеть, доступ и т. п.).
 */
function firstErrorKind(result) {
  const explicit = [result.push?.errorKind, result.pull?.errorKind]
    .find(kind => typeof kind === 'string' && kind !== '')
  if (explicit !== undefined) return explicit
  if (result.push?.secondaryBlocked !== undefined || result.push?.secondaryError !== undefined) return 'reserve'
  if ((result.push?.guarded ?? []).length > 0) return 'guard'
  const firstFailure = result.push?.failures?.[0]?.message ?? result.pull?.errors?.[0]?.message
  if (typeof firstFailure === 'string' && firstFailure !== '') return classifyErrorKind({ message: firstFailure })
  return ''
}

/**
 * Выполнить выбранное действие и вернуть запись запуска.
 * undefined — только для плана: он не пишется ни в last-run, ни в журнал.
 */
async function runAction() {
  const config = await loadConfig(home)

  // План — только чтение: ни last-run, ни журнал не обновляются.
  if (action === 'plan') {
    const plan = await buildPlan({ home, config, dshVersion })
    process.stdout.write(JSON.stringify({
      ...plan,
      mode: 'child',
      durationMs: Date.now() - started,
    }))
    return undefined
  }

  const messages = []
  const result = { pull: null, push: null }

  if (action !== 'push' && action !== 'prune') {
    result.pull = await pullReplicated({ home, config, dshVersion })
    messages.push(`принято: ${result.pull.imported}, обновлено: ${result.pull.updated}, конфликтов: ${result.pull.conflicts}`)
    if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)
    if ((result.pull.deleted ?? 0) > 0) messages.push(`удалено по отметкам других устройств: ${result.pull.deleted}${(result.pull.childrenDeleted ?? 0) > 0 ? ` (субагентов вместе с родителями: ${result.pull.childrenDeleted})` : ''}`)
    if ((result.pull.subagents ?? 0) > 0) messages.push(`субагентов принято: ${result.pull.subagents}`)
    if (result.pull.childrenMissing?.length) messages.push(`субагентов нет локально: ${result.pull.childrenMissing.length} (защищены от удаления)`)
    if ((result.pull.localSkipped ?? 0) > 0) messages.push(`локальных сессий пропущено: ${result.pull.localSkipped}`)
    if (result.pull.warning) messages.push(result.pull.warning)
    if (result.pull.profile?.skipped === true) {
      messages.push(`профиль: ${result.pull.profile.reason}`)
    } else if (result.pull.profile !== undefined) {
      messages.push(`профиль: применено ${result.pull.profile.applied ?? 0}, конфликтов ${result.pull.profile.conflicts ?? 0}`)
      if (result.pull.profile.pendingPlan === true) {
        messages.push(`профиль: план ждёт применения в панели (${result.pull.profile.plan?.files ?? 0} файлов)`)
      }
    }
    if (result.pull.workspace !== undefined) {
      messages.push(`рабочие пространства: совпало ${result.pull.workspace.matched ?? 0}, к привязке ${result.pull.workspace.toAttach ?? 0}`)
    }
  }

  if (action !== 'pull' && action !== 'prune') {
    result.push = await pushReplicated({ home, config, confirmPrune, dshVersion })
    messages.push(`отправлено: ${result.push.pushed}${result.push.committed ? ', коммит создан' : ', изменений нет'}`)
    if (result.push.failures?.length) messages.push(`не прочитано: ${result.push.failures.length} (${result.push.failures[0].id}: ${result.push.failures[0].message})`)
    if ((result.push.removed ?? 0) > 0) messages.push(`удалено из зеркала: ${result.push.removed} — ${result.push.removedReason ?? ''}`)
    if ((result.push.childrenQuarantined ?? 0) > 0) messages.push(`субагентов ушли в карантин вместе с родителями: ${result.push.childrenQuarantined}`)
    if (result.push.childrenMissing?.length) messages.push(`субагентов нет локально: ${result.push.childrenMissing.length} (в зеркале оставлены)`)
    if (result.push.orphansProtected?.length) messages.push(`осиротевших субагентов не удаляем: ${result.push.orphansProtected.length}`)
    if ((result.push.localSkipped ?? 0) > 0) messages.push(`локальных сессий не отправлено: ${result.push.localSkipped}`)
    if ((result.push.localMirrorProtected ?? 0) > 0) messages.push(`в зеркале защищено локальных копий: ${result.push.localMirrorProtected}`)
    const skipped = result.push.skippedDeletions?.removed ?? result.push.requireConfirmation?.removed ?? 0
    if (skipped > 0) messages.push(`удаление ${skipped} сессий ждёт подтверждения (ничего не удалено)`)
    if ((result.push.guarded ?? []).length > 0) messages.push(`зеркало не перезаписано: ${result.push.guarded.length}`)
    if (result.push.message) messages.push(result.push.message)
    if (result.push.warning && result.push.warning !== result.push.message) messages.push(result.push.warning)
    if (result.push.profile !== undefined) {
      messages.push(`профиль: записей ${result.push.profile.patchEntries ?? 0}, конфликтов ${result.push.profile.conflicts ?? 0}`)
    }
    if (result.push.profileError !== undefined) messages.push(`профиль не отправлен: ${result.push.profileError}`)
    if (result.push.workspace !== undefined) {
      messages.push(`рабочие пространства: ${result.push.workspace.workspaces ?? 0}`)
    }
    if (result.push.workspaceError !== undefined) messages.push(`рабочие пространства не отправлены: ${result.push.workspaceError}`)
    if (result.push.secondary !== undefined) {
      messages.push(`дубль: отправлено ${result.push.secondary.pushed}`)
    } else if (result.push.secondaryBlocked !== undefined) {
      messages.push(result.push.secondaryBlocked.message)
    } else if (result.push.secondaryError !== undefined) {
      messages.push(`дубль недоступен: ${result.push.secondaryError}`)
    }
  }

  let prune = null
  if (action === 'prune') {
    // Удаление — только явное действие владельца: confirm:true обязателен.
    prune = await applyDeletions({ home, config, confirm: true, ids: pruneIds(), dshVersion })
    if (prune.ok === true) {
      messages.push(prune.message ?? `удалено в карантин: ${prune.removed}`)
      if (prune.childrenQuarantined > 0) messages.push(`субагентов ушли в карантин вместе с родителями: ${prune.childrenQuarantined}`)
      if (prune.warning) messages.push(prune.warning)
      if (prune.committed === true) messages.push('коммит создан')
    } else {
      messages.push(prune.message ?? 'удаление не выполнено')
    }
  }

  const pullDeletions = result.pull?.deletedIds ?? []
  const pushDeletions = result.push?.removedIds ?? []
  const pruneDeletions = prune?.removedIds ?? []
  const removedIds = [...pullDeletions, ...pushDeletions, ...pruneDeletions]
  const removed = (result.pull?.deleted ?? 0) + (result.push?.removed ?? 0) + (prune?.removed ?? 0)
  const removedReason = [result.pull?.deletedReason, result.push?.removedReason, prune?.removedReason]
    .filter(reason => typeof reason === 'string' && reason !== '')
    .join(', ')
  // Коды причин и авторов удаления: manual/owner — пользователь,
  // prune/expired/replaced/children/sync — автоматика.
  const removal = removalDetails({ ...result, push: prune === null ? result.push : {
    ...(result.push ?? {}),
    removedDetails: [...(result.push?.removedDetails ?? []), ...(prune?.removedDetails ?? [])],
    removedReasons: [...new Set([...(result.push?.removedReasons ?? []), ...(prune?.removedReasons ?? [])])],
    removedBy: [...new Set([...(result.push?.removedBy ?? []), ...(prune?.removedBy ?? [])])],
    childrenQuarantined: (result.push?.childrenQuarantined ?? 0) + (prune?.childrenQuarantined ?? 0),
    quarantinePurged: (result.push?.quarantinePurged ?? 0) + (prune?.quarantinePurged ?? 0),
    quarantinePurgedIds: [...(result.push?.quarantinePurgedIds ?? []), ...(prune?.quarantinePurgedIds ?? [])],
    replaced: (result.push?.replaced ?? 0) + (prune?.replaced ?? 0),
    replacedIds: [...(result.push?.replacedIds ?? []), ...(prune?.replacedIds ?? [])],
  } })
  // sessions/subagents/childrenMissing — единица обмена «родитель + субагенты».
  const groups = subagentStats(result)
  // Сколько локальных сессий удержал режим «локальная» (включая защиту копии
  // в зеркале от удаления) — история и панель показывают это одной цифрой.
  const skipped = localSkipStats(result)
  // Отложенные удаления: план показал, что удалять нужно, но push этого не
  // делает — панель и sync_status показывают «удалений: N (ждёт подтверждения)».
  const skippedDeletions = result.push?.skippedDeletions ?? prune?.skippedDeletions
  // Запуск удался, если не сорвалось ни приём, ни отправка, ни подтверждённое
  // удаление. Блокировка из-за нового формата зеркала — это неудача приёма/отправки.
  const ok = (prune === null || prune.ok === true)
    && result.push?.ok !== false
    && result.pull?.ok !== false
  const errorKind = firstErrorKind(result)

  return {
    ok,
    action,
    mode: 'child',
    message: messages.join('; '),
    durationMs: Date.now() - started,
    // Контракт с UI: errorKind — одна из категорий history.ERROR_KINDS ('' — нет
    // ошибки). failures подставляет recordRun: счётчик ошибок подряд.
    errorKind,
    ...groups,
    ...skipped,
    skippedLocal: skipped.skippedLocal,
    removed,
    removedIds: removedIds.slice(0, 100),
    removedReason,
    reasons: removal.reasons,
    by: removal.by,
    removedDetails: removal.removedDetails,
    expired: removal.expired,
    expiredIds: removal.expiredIds,
    replaced: removal.replaced,
    replacedIds: removal.replacedIds,
    conflictIds: (result.pull?.conflictDetails ?? []).map(item => item.id),
    // Сводка плана из push: счётчики корзин и сколько удалений отложено.
    plan: result.push?.plan,
    skippedDeletions,
    requireConfirmation: result.push?.requireConfirmation,
    guarded: (result.push?.guarded ?? []).length,
    secondaryBlocked: result.push?.secondaryBlocked,
    secondaryError: result.push?.secondaryError,
    prune: prune === null
      ? null
      : {
          removed: prune.removed,
          removedIds: (prune.removedIds ?? []).slice(0, 100),
          committed: prune.committed === true,
          childrenQuarantined: prune.childrenQuarantined ?? 0,
          message: prune.message,
        },
    pull: result.pull
      ? {
          imported: result.pull.imported,
          updated: result.pull.updated,
          conflicts: result.pull.conflicts,
          conflictIds: (result.pull.conflictDetails ?? []).map(item => item.id),
          attachments: result.pull.attachments?.restored ?? 0,
          errors: result.pull.errors?.length ?? 0,
          deleted: result.pull.deleted ?? 0,
          deletedIds: result.pull.deletedIds ?? [],
          skippedLocal: skipped.pullSkippedLocal,
        }
      : null,
    push: result.push
      ? {
          pushed: result.push.pushed,
          committed: result.push.committed,
          attachments: result.push.attachments?.added ?? 0,
          failures: result.push.failures?.length ?? 0,
          skippedLocal: skipped.pushSkippedLocal,
          localMirrorProtected: skipped.localMirrorProtected,
        }
      : null,
  }
}

const lock = await acquireLock(join(home, 'dsh-sync'), `child:${action}`)
if (lock === undefined) {
  // Другая синхронизация уже идёт: это не ошибка, просто пропускаем такт.
  process.stdout.write(JSON.stringify({
    ok: true,
    skipped: true,
    action,
    mode: 'child',
    message: action === 'plan'
      ? 'синхронизация уже выполняется другим процессом — повторите проверку'
      : 'синхронизация уже выполняется другим процессом',
    durationMs: Date.now() - started,
  }))
  process.exit(0)
}

let record
try {
  record = await runAction()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  record = {
    ok: false,
    action,
    mode: 'child',
    message,
    durationMs: Date.now() - started,
    errorKind: classifyErrorKind({ message }),
  }
  process.exitCode = 1
}

try {
  // Единственная запись запуска: и успех, и ошибка пишутся один раз, после
  // try/catch. Раньше здесь было две записи (успех и catch), и сбой после
  // записи успеха перезаписывал last-run вторым результатом.
  if (record !== undefined) {
    const saved = await recordRun(home, {
      ...record,
      // runId отличает запуски друг от друга: host дописывает last-run с тем же
      // runId, и счётчик ошибок не должен расти дважды за один запуск.
      runId: randomUUID(),
      at: new Date().toISOString(),
    })
    process.stdout.write(JSON.stringify(saved))
  }
} finally {
  await lock.release()
}
