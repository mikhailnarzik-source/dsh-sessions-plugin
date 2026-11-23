/**
 * Дублирование синхронизации в два хранилища.
 *
 * Основное хранилище — то, что выбрано в настройках. Резервное указывается
 * отдельным блоком `secondary`: туда уезжают сессии и метаданные, но не
 * вложения (их много, а для восстановления достаточно самих сессий).
 *
 * Резервный канал:
 * - `folder` — папка облачного клиента (OneDrive, Яндекс.Диск, Syncthing):
 *   рекомендуемый вариант «из коробки», без сети и паролей. Зеркало копируется
 *   в локальный кеш `repoDir` и обратно в `folderDir` (как у WebDAV);
 * - `webdav` / `yandex` — сетевые API, выгружаются отдельным процессом;
 * - `git` — отдельный git-репозиторий.
 *
 * Перед первой выгрузкой в резерв обязательна сверка с облаком (флаг
 * `secondary.initialized`): без неё push блокируется и панель говорит
 * «сначала сверка». Приём идёт из основного; если оно недоступно — из резервного.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pull, push } from './sync.mjs'
import { noteSecondaryBlocked, noteSecondaryFailure, noteSecondaryPush, secondaryPushGate } from './secondary-init.mjs'

const BACKENDS = ['git', 'folder', 'yandex', 'webdav']

/**
 * Выбрать каталог кеша резерва, в котором действительно есть файлы.
 * Настройки могли указывать на пустую папку — тогда копия молча показывала нули.
 * @param preferred путь из настроек
 * @param fallback запасной путь рядом
 */
function pickExistingCache(preferred, fallback) {
  const count = (dir) => {
    try {
      let files = 0
      const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name)
          if (entry.isDirectory()) walk(full)
          else files += 1
        }
      }
      walk(dir)
      return files
    } catch {
      return 0
    }
  }
  if (count(preferred) > 0) return preferred
  if (count(fallback) > 0) return fallback
  return preferred
}

/** Настройки резервного хранилища или undefined, если оно выключено. */
export function secondaryConfig(config) {
  const secondary = config?.secondary
  if (secondary === undefined || secondary === null || secondary.enabled === false) return undefined
  if (!BACKENDS.includes(secondary.backend)) return undefined
  const repoDir = typeof secondary.repoDir === 'string' && secondary.repoDir !== ''
    ? secondary.repoDir
    : join(config.repoDir ?? '.', '..', `replica-${secondary.backend}`)

  // Для папки облака явно задаётся `folderDir`; если её нет — старый режим,
  // где сам repoDir и был папкой облака (копировать нечего).
  const folderDir = secondary.backend === 'folder'
    ? (typeof secondary.folderDir === 'string' && secondary.folderDir.trim() !== '' ? secondary.folderDir.trim() : repoDir)
    : undefined

  // Кеш мог остаться в соседней папке от прежних версий: берём тот, где есть файлы.
  // Для папки облака это не нужно: у неё свой явный folderDir.
  const resolved = secondary.backend === 'folder'
    ? repoDir
    : pickExistingCache(repoDir, join(config.repoDir ?? '.', '..', 'webdav-cache'))

  return {
    ...config,
    ...secondary,
    repoDir: resolved,
    ...(folderDir === undefined ? {} : { folderDir }),
    // Бюджет передаём в бэкенд: он решает, сколько файлов успеет отправить.
    maxUploadMs: Number(secondary.maxUploadMs ?? 720_000),
    // Вложения дублировать не нужно: они восстанавливаются из основного.
    attachments: false,
  }
}

/**
 * Отправить изменения в основное хранилище, а резервное — после сверки.
 *
 * Резерв выгружается отдельным процессом только для сетевых бэкендов: у него
 * длинный бюджет времени. Папка и git отправляются сразу — это секунды.
 */
export async function pushReplicated({ home, config, sessions, prune = true, message, confirmPrune = false, dshVersion }) {
  const summary = await push({ home, config, sessions, prune, message, confirmPrune, dshVersion })
  const secondary = secondaryConfig(config)
  if (secondary === undefined) return summary

  // Безопасный первый вход: без сверки с облаком в резерв не заливаем.
  const gate = await secondaryPushGate({ home, secondary })
  if (gate.ok !== true) {
    summary.secondaryBlocked = { code: gate.code, message: gate.message }
    await noteSecondaryBlocked(home, secondary, gate)
    return summary
  }

  // Быстрые хранилища (папка, git) можно отправить прямо здесь: это секунды.
  if (secondary.backend === 'folder' || secondary.backend === 'git') {
    try {
      summary.secondary = await push({ home, config: secondary, sessions, prune, message, confirmPrune, dshVersion })
      await noteSecondaryPush(home, secondary, summary.secondary)
    } catch (error) {
      summary.secondaryError = error instanceof Error ? error.message : String(error)
      await noteSecondaryFailure(home, secondary, error)
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
    const owner = JSON.parse(await readFile(join(home, 'dsh-sync', 'secondary', 'sync.lock', 'owner.json'), 'utf8'))
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
export async function pullReplicated({ home, config, dryRun = false, dshVersion }) {
  try {
    return await pull({ home, config, dryRun, dshVersion })
  } catch (error) {
    const secondary = secondaryConfig(config)
    if (secondary === undefined) throw error
    const result = await pull({ home, config: secondary, dryRun, dshVersion })
    result.viaSecondary = true
    result.primaryError = error instanceof Error ? error.message : String(error)
    return result
  }
}
