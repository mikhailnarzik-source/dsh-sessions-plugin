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
 *
 * Захват устойчив к гонке «между mkdir и owner.json» и к перезаписи владельца:
 * - свежий каталог без owner.json (сосед только что создал лок и ещё пишет
 *   владельца) считается занятым, а не брошенным — grace-порог;
 * - файл владельца, который прямо сейчас переписывает heartbeat, читается
 *   несколько раз, а его свежий mtime тоже не даёт снять живой лок;
 * - брошенный лок снимается переименованием каталога: победитель один,
 *   второй писатель не отберёт только что созданный лок.
 *
 * Без этого два процесса могли одновременно решить «лок битый», снять каталог
 * друг у друга и писать в зеркало параллельно (M9-B: ловилось стресс-тестом
 * test/mirror-lock.test.mjs).
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Имя каталога лока внутри `~/.dsh/dsh-sync`. */
export const LOCK_NAME = 'sync.lock'
/** Порог молчания: дольше — лок считается брошенным и снимается. */
export const LOCK_STALE_MS = 5 * 60_000
/** Интервал heartbeat, пока лок удерживается. */
export const LOCK_HEARTBEAT_MS = 60_000
/**
 * Сколько ждём, пока сосед дописывает owner.json, прежде чем считать каталог
 * лока брошенным. Защищает от «отбора» живого лока в момент создания.
 */
export const LOCK_CREATE_GRACE_MS = 5_000

/** Возраст файла/каталога в миллисекундах; undefined — объекта нет. */
async function ageMs(target, now) {
  try {
    const info = await stat(target)
    return Math.max(0, now() - info.mtimeMs)
  } catch {
    return undefined
  }
}

/** Пауза без захвата event loop насовсем (нужна только между перечитываниями). */
function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Взять лок.
 * @param dir каталог состояния (~/.dsh/dsh-sync)
 * @param owner подпись владельца для диагностики
 * @param options служебное: staleMs, heartbeatMs, createGraceMs, now (для тестов)
 * @returns объект с heartbeat() и release() либо undefined, если лок занят
 */
export async function acquireLock(dir, owner = 'sync', options = {}) {
  const {
    staleMs = LOCK_STALE_MS,
    heartbeatMs = LOCK_HEARTBEAT_MS,
    createGraceMs = LOCK_CREATE_GRACE_MS,
    now = Date.now,
  } = options
  const path = join(dir, LOCK_NAME)
  const infoPath = join(path, 'owner.json')
  await mkdir(dir, { recursive: true })

  // Пишем на месте (как раньше): читатель прикрыт grace-порогом. Атомарная
  // подмена через rename оставляла окно, когда owner.json на мгновение нет,
  // а heartbeat на каждом тике делал лишнюю пару файловых операций.
  const writeInfo = async () => {
    await writeFile(infoPath, `${JSON.stringify({ pid: process.pid, at: now(), owner })}\n`, 'utf8')
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
    try {
      await writeInfo()
    } catch (error) {
      // Каталог лока исчез между mkdir и записью владельца — значит, сосед
      // уже забрал лок. Это не ошибка: попробуем на следующем опросе.
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    return makeHandle()
  }

  try {
    return await tryTake()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  /** Прочитать владельца; undefined — файла нет или он сейчас переписывается. */
  const readOwner = async () => {
    try {
      return JSON.parse(await readFile(infoPath, 'utf8'))
    } catch {
      return undefined
    }
  }

  let info = await readOwner()
  if (info === undefined) {
    // Файл владельца ещё не создан (каталог только что создан соседом) или его
    // прямо сейчас переписывает heartbeat. Несколько раз перечитываем, лишь
    // потом принимаем решение: иначе живой лок отбирается на ровном месте.
    for (let attempt = 0; attempt < 3 && info === undefined; attempt += 1) {
      await pause(3)
      info = await readOwner()
    }
  }

  if (info !== undefined) {
    let stale = typeof info?.at !== 'number' || now() - info.at > staleMs
    // Владелец мог быть убит (перезапуск DSH, диспетчер задач): такой лок
    // снимаем сразу, иначе синхронизация простаивает до истечения порога.
    if (!stale && typeof info?.pid === 'number' && info.pid !== process.pid) {
      try {
        process.kill(info.pid, 0)
      } catch {
        stale = true
      }
    }
    if (!stale) return undefined
  } else {
    // Записи владельца нет вовсе: либо сосед как раз создаёт лок (свежий
    // каталог), либо остался мусор от упавшего процесса (старый каталог).
    const age = (await ageMs(infoPath, now)) ?? (await ageMs(path, now))
    if (age !== undefined && age <= createGraceMs) return undefined
  }

  // Лок остался от упавшего процесса или замолчал — снимаем и пробуем снова.
  // Снимаем переименованием: из двух процессов, решивших «лок брошен»,
  // каталог заберёт только один, второй увидит ENOENT и подождёт.
  const backup = `${path}.stale-${process.pid}-${now().toString(36)}`
  try {
    await rename(path, backup)
  } catch {
    // Кто-то уже снял/пересоздал лок — не отбираем, попробуем позже.
    return undefined
  }
  await rm(backup, { recursive: true, force: true }).catch(() => {})
  try {
    return await tryTake()
  } catch {
    return undefined
  }
}
