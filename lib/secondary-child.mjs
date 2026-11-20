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
  const result = await push({
    home,
    config: { ...secondary, maxUploadMs: budget },
    sessions: undefined,
    prune: true,
    message: 'резервная копия',
  })

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
