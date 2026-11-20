/**
 * Дублирование синхронизации в два хранилища.
 *
 * Основное хранилище — то, что выбрано в настройках. Резервное указывается
 * отдельным блоком `secondary`: туда уезжают сессии и метаданные, но не
 * вложения (их много, а для восстановления достаточно самих сессий).
 *
 * Приём идёт из основного; если оно недоступно — из резервного.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pull, push } from './sync.mjs'

const BACKENDS = ['git', 'folder', 'yandex', 'webdav']

/** Настройки резервного хранилища или undefined, если оно выключено. */
export function secondaryConfig(config) {
  const secondary = config?.secondary
  if (secondary === undefined || secondary === null || secondary.enabled === false) return undefined
  if (!BACKENDS.includes(secondary.backend)) return undefined
  const repoDir = typeof secondary.repoDir === 'string' && secondary.repoDir !== ''
    ? secondary.repoDir
    : join(config.repoDir ?? '.', '..', `replica-${secondary.backend}`)

  return {
    ...config,
    ...secondary,
    repoDir,
    // Бюджет передаём в бэкенд: он решает, сколько файлов успеет отправить.
    maxUploadMs: Number(secondary.maxUploadMs ?? 720_000),
    // Вложения дублировать не нужно: они восстанавливаются из основного.
    attachments: false,
  }
}

/**
 * Отправить изменения в основное хранилище, а резервное поставить в очередь.
 *
 * Резерв выгружается отдельным процессом: у него длинный бюджет времени,
 * поэтому крупная сессия доезжает целиком, а основной цикл не ждёт.
 */
export async function pushReplicated({ home, config, sessions, prune = true, message }) {
  const summary = await push({ home, config, sessions, prune, message })
  const secondary = secondaryConfig(config)
  if (secondary === undefined) return summary

  // Быстрые хранилища (папка, git) можно отправить прямо здесь: это секунды.
  if (secondary.backend === 'folder' || secondary.backend === 'git') {
    try {
      summary.secondary = await push({ home, config: secondary, sessions, prune, message })
    } catch (error) {
      summary.secondaryError = error instanceof Error ? error.message : String(error)
    }
    return summary
  }

  // Медленные (WebDAV, Яндекс.Диск API) — в отдельный процесс: у него свой
  // бюджет времени, и оборванная выгрузка больше не теряет прогресс.
  summary.secondaryQueued = await queueSecondaryPush(home)
  return summary
}

/** Запустить отсоединённую выгрузку резерва (если она ещё не идёт). */
async function queueSecondaryPush(home) {
  try {
    const owner = JSON.parse(await readFile(join(home, 'dsh-sync', 'secondary', 'owner.json'), 'utf8'))
    if (typeof owner?.pid === 'number') {
      try {
        process.kill(owner.pid, 0)
        return false // предыдущая выгрузка ещё работает
      } catch {
        // владелец мёртв — запускаем новую
      }
    }
  } catch {
    // лока ещё нет
  }

  try {
    const childPath = fileURLToPath(new URL('./secondary-child.mjs', import.meta.url))
    const child = spawn(process.execPath, [childPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DSH_HOME: home },
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Принять из основного, а при его недоступности — из резервного. */
export async function pullReplicated({ home, config, dryRun = false }) {
  try {
    return await pull({ home, config, dryRun })
  } catch (error) {
    const secondary = secondaryConfig(config)
    if (secondary === undefined) throw error
    const result = await pull({ home, config: secondary, dryRun })
    result.viaSecondary = true
    result.primaryError = error instanceof Error ? error.message : String(error)
    return result
  }
}
