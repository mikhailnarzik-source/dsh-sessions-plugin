/**
 * Межпроцессный лок синхронизации.
 *
 * Два экземпляра DSH на одной машине, автоматика и ручная кнопка могут
 * запустить синхронизацию одновременно — тогда два процесса пишут в одно
 * git-дерево. Лок создаётся атомарно каталогом и снимается по завершении.
 *
 * Лок живёт на pid + heartbeat: владелец раз в минуту обновляет время в
 * owner.json, а чужой процесс снимает лок автоматически, если владелец умер
 * (pid не существует) или молчит дольше 5 минут.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Порог молчания: дольше — лок считается брошенным и снимается. */
export const LOCK_STALE_MS = 5 * 60_000
/** Интервал heartbeat, пока лок удерживается. */
export const LOCK_HEARTBEAT_MS = 60_000

/**
 * Взять лок.
 * @param dir каталог состояния (~/.dsh/dsh-sync)
 * @param owner подпись владельца для диагностики
 * @param options служебное: staleMs, heartbeatMs, now (для тестов)
 * @returns объект с heartbeat() и release() либо undefined, если лок занят
 */
export async function acquireLock(dir, owner = 'sync', options = {}) {
  const { staleMs = LOCK_STALE_MS, heartbeatMs = LOCK_HEARTBEAT_MS, now = Date.now } = options
  const path = join(dir, 'sync.lock')
  await mkdir(dir, { recursive: true })

  const writeInfo = async () => {
    await writeFile(join(path, 'owner.json'), `${JSON.stringify({ pid: process.pid, at: now(), owner })}\n`, 'utf8')
  }

  const makeHandle = () => {
    // Heartbeat держит лок свежим, пока синхронизация идёт дольше порога
    // (первая выгрузка может занимать минуты). Таймер не мешает процессу
    // завершиться, когда лок уже не нужен.
    const timer = setInterval(() => {
      writeInfo().catch(() => {})
    }, heartbeatMs)
    timer.unref?.()
    return {
      path,
      async heartbeat() {
        await writeInfo()
      },
      async release() {
        clearInterval(timer)
        await rm(path, { recursive: true, force: true }).catch(() => {})
      },
    }
  }

  const tryTake = async () => {
    await mkdir(path)
    await writeInfo()
    return makeHandle()
  }

  try {
    return await tryTake()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  let stale = false
  try {
    const info = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'))
    stale = typeof info?.at !== 'number' || now() - info.at > staleMs
    // Владелец мог быть убит (перезапуск DSH, диспетчер задач): такой лок
    // снимаем сразу, иначе синхронизация простаивает до истечения порога.
    if (!stale && typeof info?.pid === 'number' && info.pid !== process.pid) {
      try {
        process.kill(info.pid, 0)
      } catch {
        stale = true
      }
    }
  } catch {
    stale = true
  }
  if (!stale) return undefined

  // Лок остался от упавшего процесса или замолчал — снимаем и пробуем снова.
  await rm(path, { recursive: true, force: true }).catch(() => {})
  try {
    return await tryTake()
  } catch {
    return undefined
  }
}
