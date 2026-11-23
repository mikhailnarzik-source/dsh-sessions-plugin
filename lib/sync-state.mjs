/**
 * Состояние движка синхронизации: какие сессии это устройство отправляло,
 * плюс служебные отметки (например, `secondary.initialized` для резервного
 * канала). Файл общий: его читают push/pull, план «Проверить» и сверка резерва.
 *
 * Вынесено отдельным модулем, чтобы план мог читать состояние, не подтягивая
 * весь движок синхронизации (профиль, вложения, git-бэкенды).
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const STATE_FILE = 'state.json'

/** Пустое состояние: версия и пустая карта проектов. */
export function emptySyncState() {
  return { version: 1, projects: {} }
}

/** Прочитать состояние; битый файл — пустое состояние, а не падение. */
export async function readSyncState(home) {
  const file = join(home, 'dsh-sync', STATE_FILE)
  if (!existsSync(file)) return emptySyncState()
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed?.projects ? parsed : emptySyncState()
  } catch {
    return emptySyncState()
  }
}

/** Записать состояние: список отправленных сессий по проектам. */
export async function writeSyncState(home, state) {
  const dir = join(home, 'dsh-sync')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
