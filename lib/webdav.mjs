/**
 * Бэкенд Яндекс.Диска по WebDAV — без регистрации приложения.
 *
 * Достаточно логина и «пароля приложения» (id.yandex.ru → Безопасность →
 * Пароли приложений → Файлы). WebDAV отдаёт список файлов, размер и дату
 * изменения; этого хватает, чтобы держать локальный кеш в актуальном виде.
 */
import { existsSync } from 'node:fs'

/** Файлы крупнее этого не отправляем в резерв: на WebDAV они не доезжают. */
export const MAX_BACKUP_FILE_BYTES = 1_500_000
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { markUploaded, pruneProgress, readProgress, writeProgress } from './progress.mjs'

const BASE = 'https://webdav.yandex.ru'
const TIMEOUT_MS = 180_000
const TRANSFER_TIMEOUT_MS = 20 * 60_000
/** Загрузка одного файла ограничена 120 с по аудиту. */
const UPLOAD_TIMEOUT_MS = 120_000
/** Сколько раз повторить сетевую ошибку (3–5 по аудиту). */
const NETWORK_RETRIES = 4
const RETRY_BASE_MS = 2_000
/** Потоков отправки по умолчанию: одно соединение упирается в предел провайдера. */
export const DEFAULT_CONCURRENCY = 8
/** Пауза между запросами больше не нужна: ограничивает сам провайдер. */
const MIN_REQUEST_GAP_MS = 20
const MIN_GAP_MS = MIN_REQUEST_GAP_MS
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'

async function walkFiles(dir, base, out) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(absolute, base, out)
    else if (entry.isFile()) out.push({ absolute, rel: relative(base, absolute).split(sep).join('/') })
  }
}

async function mapLimit(items, limit, worker) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        await worker(item)
      }
    }),
  )
}

/** Сетевой ли это сбой: его стоит повторить, обычную ошибку — нет. */
function networkErrorOf(error) {
  const name = error?.name ?? ''
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`
  if (name === 'TimeoutError' || name === 'AbortError') return true
  return /fetch failed|terminated|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|EPROTO|UND_ERR|schannel|SSL|TLS|certificate|socket hang up|network error|operation was aborted/i.test(text)
}

/** Разобрать XML-ответ PROPFIND в плоский список. */
export function parsePropfind(xml, basePath) {  const items = []
  for (const match of xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
    const block = match[1]
    const hrefMatch = /<d:href>([^<]+)<\/d:href>/.exec(block)
    if (hrefMatch === null) continue
    const href = decodeURIComponent(hrefMatch[1])
    const isDir = /<d:collection\s*\/>/.test(block)
    const size = Number(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block)?.[1] ?? 0)
    const modified = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(block)?.[1] ?? ''
    // Служебная запись о корне '/' — не файл: обходить её не нужно.
    if (href === '/' || href === '') continue
    if (href.replace(/\/+$/, '') === basePath.replace(/\/+$/, '')) continue
    items.push({ href: href.replace(/\/+$/, ''), isDir, size, modified })
  }
  return items
}

/**
 * Создать WebDAV-бэкенд.
 * @param config поля: repoDir (локальный кеш), webdavLogin, webdavPassword, webdavPath
 * @param options служебные настройки (retryBaseMs — пауза повторов, для тестов)
 */
export function createWebdavBackend(config, options = {}) {
  const retryBaseMs = Number(options.retryBaseMs ?? RETRY_BASE_MS)
  const login = (config.webdavLogin ?? '').trim()
  // Пароль живёт в хранилище секретов: основной процесс передаёт его
  // дочернему через окружение, чтобы он не попадал в файл настроек.
  const password = (config.webdavPassword ?? process.env.DSH_SYNC_WEBDAV_PASSWORD ?? '').trim()
  const root = `/${(config.webdavPath ?? 'dsh-sync').replace(/^\/+|\/+$/g, '')}`

  const auth = () => `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`

  let lastRequestAt = 0
  const pause = async (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const throttle = async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await pause(wait)
    lastRequestAt = Date.now()
  }

  const request = async (path, init = {}) => {
    if (login === '' || password === '') throw new Error('не заданы логин и пароль приложения Яндекс.Диска')
    const send = () =>
      fetch(`${BASE}${encodeURI(path)}`, {
        ...init,
        headers: { authorization: auth(), ...(init.headers ?? {}) },
        signal: init.signal === undefined ? AbortSignal.timeout(TIMEOUT_MS) : init.signal,
      })

    // Сетевые сбои (обрыв TLS/schannel, таймаут, «fetch failed») повторяются
    // с нарастающей паузой: короткий сбой провайдера не должен срывать
    // синхронизацию целиком. Обычные ошибки (401 и прочее) не повторяем.
    await throttle()
    let response
    try {
      response = await send()
    } catch (error) {
      if (!networkErrorOf(error)) throw error
      for (let attempt = 0; attempt < NETWORK_RETRIES; attempt++) {
        await pause(Math.min(60_000, retryBaseMs * 2 ** attempt))
        await throttle()
        try {
          response = await send()
          break
        } catch (retryError) {
          if (!networkErrorOf(retryError)) throw retryError
          if (attempt === NETWORK_RETRIES - 1) throw retryError
        }
      }
    }

    // Яндекс ограничивает частоту запросов (429) и иногда отвечает 503:
    // повторяем с паузой, уважая Retry-After.
    for (let attempt = 0; attempt < 4 && (response.status === 429 || response.status === 503); attempt++) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0)
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(120_000, 10_000 * (attempt + 1))
      await pause(wait)
      await throttle()
      response = await send()
    }
    return response
  }

  const listRemote = async () => {
    const files = new Map()
    const walk = async (dir) => {
      const response = await request(`${dir}/`, { method: 'PROPFIND', headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY })
      if (response.status === 404) return
      if (response.status === 401) throw new Error('Яндекс.Диск не принял логин или пароль приложения (401)')
      if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): HTTP ${response.status}`)
      const xml = await response.text()
      for (const item of parsePropfind(xml, dir)) {
        if (item.isDir) await walk(item.href)
        else {
          const rel = item.href.replace(`${root}/`, '')
          if (rel !== '') files.set(rel, { size: item.size, modified: item.modified })
        }
      }
    }
    await walk(root)
    return files
  }

  const dirExists = async (path) => {
    const response = await request(`${path}/`, {
      method: 'PROPFIND',
      headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    })
    return response.ok
  }

  const ensureDir = async (relDir) => {
    const parts = relDir.split('/').filter(Boolean)
    let current = root
    // Корень тоже создаём: без него Яндекс отвечает 409 на вложенные MKCOL.
    const targets = [current, ...parts.map(part => {
      current = `${current}/${part}`
      return current
    })]
    for (const target of targets) {
      const response = await request(`${target}/`, { method: 'MKCOL' })
      if (response.ok || response.status === 405) continue
      // 409 бывает и «уже есть», и «нет родителя» — проверяем фактически.
      if (await dirExists(target)) continue
      throw new Error(`Яндекс.Диск (WebDAV): не удалось создать папку ${target} (${response.status})`)
    }
  }

  const download = async (rel) => {
    const response = await request(`/${root.replace(/^\/+/, '')}/${rel}`, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): не удалось скачать ${rel} (${response.status})`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const target = join(config.repoDir, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buffer)
  }

  const upload = async (rel, absolute) => {
    const buffer = await readFile(absolute)
    const response = await request(`/${root.replace(/^\/+/, '')}/${rel}`, { method: 'PUT', body: buffer, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): не удалось загрузить ${rel} (${response.status})`)
  }

  return {
    kind: 'webdav',

    async sync() {
      const remote = await listRemote()
      const toDownload = []
      for (const [rel, meta] of remote) {
        const target = join(config.repoDir, ...rel.split('/'))
        let local = null
        try {
          local = await stat(target)
        } catch {
          local = null
        }
        if (local === null || local.size !== meta.size) toDownload.push(rel)
      }
      await mapLimit(toDownload, Math.max(1, Math.min(16, Number(config.concurrency ?? DEFAULT_CONCURRENCY))), (rel) => download(rel))
      return true
    },

    async commit() {
      const remote = await listRemote()
      const progress = await readProgress(config.repoDir)
      // Прогресс пишем по ходу дела, чтобы интерфейс видел рост, а не только итог.
      let lastSavedAt = 0
      const saveSoon = async () => {
        if (Date.now() - lastSavedAt < 15_000) return
        lastSavedAt = Date.now()
        await writeProgress(config.repoDir, progress)
      }
      const local = []
      await walkFiles(config.repoDir, config.repoDir, local)

      let uploaded = 0
      const dirs = new Set()
      const pending = []
      for (const file of local) {
        const meta = remote.get(file.rel)
        if (meta !== undefined) {
          const info = await stat(file.absolute)
          if (info.size === meta.size) continue
        }
        pending.push(file)
      }

      // Сначала сессии (главное), потом служебные файлы, вложения в конце.
      // Внутри группы — от маленького к большому: крупный файл может не успеть
      // за бюджет, и тогда прогресс всё равно идёт на остальных.
      const priority = (rel) => (rel.startsWith('sessions/') ? 0 : rel.startsWith('attachments/') ? 2 : 1)
      const sizes = new Map()
      for (const file of pending) {
        try {
          sizes.set(file.rel, (await stat(file.absolute)).size)
        } catch {
          sizes.set(file.rel, 0)
        }
      }
      pending.sort((a, b) => priority(a.rel) - priority(b.rel) || (sizes.get(a.rel) ?? 0) - (sizes.get(b.rel) ?? 0))

      // Скорость Яндекса на WebDAV — около 16 КБ/с: файл больше полутора
      // мегабайт не успевает и обрывается. Крупные сессии есть в GitHub.
      const maxFileBytes = Number(config.maxFileBytes ?? MAX_BACKUP_FILE_BYTES)
      const concurrency = Math.max(1, Math.min(16, Number(config.concurrency ?? DEFAULT_CONCURRENCY)))
      let skippedLarge = 0
      let skippedBytes = 0

      const eligible = []
      for (const file of pending) {
        const size = sizes.get(file.rel) ?? 0
        if (size > maxFileBytes) {
          skippedLarge += 1
          skippedBytes += size
          continue
        }
        eligible.push(file)
      }

      // Файлы отправляем параллельно: у Яндекса на каждый уходит два запроса,
      // последовательная отправка сотен файлов занимает часы.
      // Бюджет времени: не держим лок бесконечно, остальное уедет в следующий раз.
      const budget = Number(config.maxUploadMs ?? 720_000)
      const startedAt = Date.now()
      await mapLimit(eligible, concurrency, async (file) => {
        if (Date.now() - startedAt > budget) return
        const dir = file.rel.split('/').slice(0, -1).join('/')
        if (dir !== '' && !dirs.has(dir)) {
          await ensureDir(dir)
          dirs.add(dir)
        }
        await upload(file.rel, file.absolute)
        try {
          markUploaded(progress, file.rel, (await stat(file.absolute)).size)
          await saveSoon()
        } catch {
          // размер не критичен для учёта
        }
        uploaded += 1
      })

      let removed = 0
      // Пустой кеш — почти наверняка сбой чтения, а не «удалили всё».
      if (local.length === 0 && remote.size > 0) return { committed: false, uploaded, removed: 0, warning: 'локальный кеш пуст — удаление на Диске пропущено' }
      const localSet = new Set(local.map(file => file.rel))
      for (const rel of remote.keys()) {
        if (localSet.has(rel)) continue
        const response = await request(`${root}/${rel}`, { method: 'DELETE' })
        if (response.ok || response.status === 404) removed += 1
      }

      // Файлы, которые уже лежат в облаке и совпадают по размеру, сразу
      // считаем выгруженными: прогресс не начинается с нуля после переустановки.
      const localRels = new Set(local.map(file => file.rel))
      for (const [rel, meta] of remote) {
        if (localRels.has(rel) && progress.files[rel] === undefined) markUploaded(progress, rel, meta.size)
      }
      pruneProgress(progress, localRels)
      await writeProgress(config.repoDir, progress)

      return { committed: uploaded > 0 || removed > 0, uploaded, removed, skippedLarge, skippedBytes }
    },
  }
}

/** Проверка доступа к WebDAV. */
export async function probeWebdav(config) {
  try {
    const backend = createWebdavBackend(config)
    await backend.sync()
    return { ok: true, message: 'доступ к Яндекс.Диску подтверждён' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
