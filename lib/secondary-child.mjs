#!/usr/bin/env node
/**
 * Выгрузка резервной копии отдельным процессом.
 *
 * Раньше дубль отправлялся внутри основного цикла синхронизации и обрывался по
 * таймауту: файлы успевали загрузиться, но учёт прогресса не сохранялся, и
 * следующая попытка начинала те же файлы заново. Теперь резерв живёт сам:
 * у него свой лок, свой бюджет времени и своё состояние.
 *
 * Запускается отсоединённым (detached) из sync.mjs и пишет результат одной
 * JSON-строкой в stdout, как остальные дочерние процессы.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig, resolveDshHome } from './config.mjs'
import { secondaryConfig } from './replica.mjs'
import { acquireLock } from './lock.mjs'
import { push } from './sync.mjs'
import { recordRun } from './history.mjs'
import { backupProgress } from './progress.mjs'

const home = resolveDshHome(undefined)
const lockDir = join(home, 'dsh-sync')
const started = Date.now()
const statusFile = join(lockDir, 'secondary-status.json')

async function writeStatus(payload) {
  try {
    await mkdir(lockDir, { recursive: true })
    await writeFile(statusFile, `${JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch {
    // состояние резерва не критично
  }
}

// Свой лок: основной цикл и резерв не должны вытеснять друг друга.
const lock = await acquireLock(join(lockDir, 'secondary'), 'child:secondary')
if (lock === undefined) {
  process.stdout.write(JSON.stringify({ ok: true, skipped: true, action: 'secondary', message: 'дубль уже выгружается' }))
  process.exit(0)
}

try {
  const config = await loadConfig(home)
  const secondary = secondaryConfig(config)
  if (secondary === undefined) {
    await writeStatus({ ok: true, skipped: true, message: 'резервное хранилище не настроено' })
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, action: 'secondary' }))
    process.exit(0)
  }

  // Длинный бюджет: один прогон должен довести крупную сессию до конца.
  const budget = Number(config.secondary?.maxUploadMs ?? 1_800_000)
  const payload = {
    home,
    config: { ...secondary, maxUploadMs: budget },
    sessions: undefined,
    prune: true,
    message: 'резервная копия',
  }

  // Обрыв сети — обычное дело: повторяем с нарастающей паузой, чтобы не ждать
  // следующего цикла автоматики (это до пятнадцати минут).
  const delays = [30_000, 120_000, 300_000]
  const attempts = []
  let result
  let failure = ''
  for (let index = 0; index <= delays.length; index += 1) {
    try {
      result = await push(payload)
      failure = ''
      break
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      attempts.push(failure)
      if (index === delays.length) break
      const wait = delays[index]
      await writeStatus({
        ok: false,
        retryInMs: wait,
        message: `повтор через ${Math.round(wait / 1000)} с: ${failure}`,
      })
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }

  if (result === undefined) {
    const failed = {
      ok: false,
      action: 'secondary',
      message: `резерв не отправлен после ${attempts.length} попыток: ${failure}`,
      attempts: attempts.slice(-2),
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    }
    await writeStatus(failed)
    await recordRun(home, failed)
    process.stdout.write(JSON.stringify(failed))
    process.exitCode = 1
    process.exit(1)
  }

  const progress = await backupProgress(secondary.repoDir)
  const record = {
    ok: true,
    action: 'secondary',
    message: `дубль: отправлено ${result.pushed}, готово ${progress.percent}%`,
    uploaded: result.pushed,
    committed: result.committed === true,
    percent: progress.percent,
    doneFiles: progress.doneFiles,
    totalFiles: progress.totalFiles,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  }
  await writeStatus(record)
  await recordRun(home, record)
  process.stdout.write(JSON.stringify(record))
} catch (error) {
  const record = {
    ok: false,
    action: 'secondary',
    message: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - started,
  }
  await writeStatus(record)
  await recordRun(home, { ...record, at: new Date().toISOString() })
  process.stdout.write(JSON.stringify(record))
  process.exitCode = 1
} finally {
  await lock.release()
}
