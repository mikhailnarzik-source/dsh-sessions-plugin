#!/usr/bin/env node
/**
 * Синхронизация в отдельном процессе: host-процесс DSH может отличаться от
 * обычного Node (другая сборка zlib, ограничения файловой системы), а движку
 * нужны и чтение сторов, и zstd. Дочерний процесс запускается на штатном Node
 * и печатает результат одной JSON-строкой.
 *
 * Использование: node sync-child.mjs <sync|pull|push> [--confirm-prune]
 * Каталог DSH берётся из $DSH_HOME (или ~/.dsh), как у CLI.
 * `--confirm-prune` снимает порог защиты от массового удаления.
 */
import { join } from 'node:path'
import { loadConfig, resolveDshHome } from './config.mjs'
import { pullReplicated, pushReplicated } from './replica.mjs'
import { acquireLock } from './lock.mjs'
import { recordRun, removalDetails } from './history.mjs'
import { detectDshVersion } from './sync.mjs'

const action = ['sync', 'pull', 'push'].includes(process.argv[2]) ? process.argv[2] : 'sync'
const confirmPrune = process.argv.includes('--confirm-prune')
const home = resolveDshHome(undefined)
const started = Date.now()
const dshVersion = await detectDshVersion()

const lock = await acquireLock(join(home, 'dsh-sync'), `child:${action}`)
if (lock === undefined) {
  // Другая синхронизация уже идёт: это не ошибка, просто пропускаем такт.
  process.stdout.write(JSON.stringify({
    ok: true,
    skipped: true,
    action,
    mode: 'child',
    message: 'синхронизация уже выполняется другим процессом',
    durationMs: Date.now() - started,
  }))
  process.exit(0)
}

try {
  const config = await loadConfig(home)
  const messages = []
  const result = { pull: null, push: null }

  if (action !== 'push') {
    result.pull = await pullReplicated({ home, config, dshVersion })
    messages.push(`принято: ${result.pull.imported}, обновлено: ${result.pull.updated}, конфликтов: ${result.pull.conflicts}`)
    if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)
    if ((result.pull.deleted ?? 0) > 0) messages.push(`удалено по отметкам других устройств: ${result.pull.deleted}`)
    if ((result.pull.localSkipped ?? 0) > 0) messages.push(`локальных сессий пропущено: ${result.pull.localSkipped}`)
    if (result.pull.warning) messages.push(result.pull.warning)
    if (result.pull.profile?.skipped === true) {
      messages.push(`профиль: ${result.pull.profile.reason}`)
    } else if (result.pull.profile !== undefined) {
      messages.push(`профиль: применено ${result.pull.profile.applied ?? 0}, конфликтов ${result.pull.profile.conflicts ?? 0}`)
    }
    if (result.pull.workspace !== undefined) {
      messages.push(`рабочие пространства: совпало ${result.pull.workspace.matched ?? 0}, к привязке ${result.pull.workspace.toAttach ?? 0}`)
    }
  }

  if (action !== 'pull') {
    result.push = await pushReplicated({ home, config, confirmPrune, dshVersion })
    messages.push(`отправлено: ${result.push.pushed}${result.push.committed ? ', коммит создан' : ', изменений нет'}`)
    if (result.push.failures?.length) messages.push(`не прочитано: ${result.push.failures.length} (${result.push.failures[0].id}: ${result.push.failures[0].message})`)
    if ((result.push.removed ?? 0) > 0) messages.push(`удалено из зеркала: ${result.push.removed} — ${result.push.removedReason ?? ''}`)
    if ((result.push.localSkipped ?? 0) > 0) messages.push(`локальных сессий не отправлено: ${result.push.localSkipped}`)
    if (result.push.requireConfirmation !== undefined) messages.push(`удаление ${result.push.requireConfirmation.removed} сессий ждёт подтверждения`)
    if ((result.push.guarded ?? []).length > 0) messages.push(`зеркало не перезаписано: ${result.push.guarded.length}`)
    if (result.push.warning) messages.push(result.push.warning)
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

  const pullDeletions = result.pull?.deletedIds ?? []
  const pushDeletions = result.push?.removedIds ?? []
  const removedIds = [...pullDeletions, ...pushDeletions]
  const removed = (result.pull?.deleted ?? 0) + (result.push?.removed ?? 0)
  const removedReason = [result.pull?.deletedReason, result.push?.removedReason].filter(reason => typeof reason === 'string' && reason !== '').join(', ')
  // Коды причин и авторов удаления: manual/owner — пользователь,
  // prune/expired/replaced/sync — автоматика.
  const removal = removalDetails(result)

  const record = {
    ok: true,
    action,
    mode: 'child',
    message: messages.join('; '),
    durationMs: Date.now() - started,
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
    requireConfirmation: result.push?.requireConfirmation,
    guarded: (result.push?.guarded ?? []).length,
    secondaryBlocked: result.push?.secondaryBlocked,
    secondaryError: result.push?.secondaryError,
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
        }
      : null,
    push: result.push
      ? {
          pushed: result.push.pushed,
          committed: result.push.committed,
          attachments: result.push.attachments?.added ?? 0,
          failures: result.push.failures?.length ?? 0,
        }
      : null,
  }
  await recordRun(home, { ...record, at: new Date().toISOString() })
  process.stdout.write(JSON.stringify(record))
} catch (error) {
  const record = {
    ok: false,
    action,
    mode: 'child',
    message: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  }
  await recordRun(home, record)
  process.stdout.write(JSON.stringify(record))
  process.exitCode = 1
} finally {
  await lock.release()
}
