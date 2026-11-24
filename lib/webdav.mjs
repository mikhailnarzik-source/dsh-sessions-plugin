/**
 * Бэкенд Яндекс.Диска по WebDAV — без регистрации приложения.
 *
 * Достаточно логина и «пароля приложения» (id.yandex.ru → Безопасность →
 * Пароли приложений → Файлы). WebDAV отдаёт список файлов, размер и дату
 * изменения; этого хватает, чтобы держать локальный кеш в актуальном виде.
 *
 * Единый интерфейс резервного канала (H5): любой бэкенд, созданный
 * `createRemote()`, можно привести к одному виду функцией `normalizeBackend()`:
 *
 * - `list()` — что лежит в облаке (пути, размеры, дата изменения);
 * - `sync()` — забрать из облака новое и изменённое в локальный кеш;
 * - `commit()` — выгрузить локальный кеш в облако;
 * - `remove(rel)` — убрать облачную копию; WebDAV уносит её в карантин
 *   `.trash/<метка>/…`, а если сервер не умеет MOVE — ставит операцию в
 *   локальную очередь (интерфейс; сама очередь не роняет синхронизацию);
 * - `capabilities` — какие операции действительно поддержаны;
 * - `lightProbe()` — лёгкая сверка (U3): только PROPFIND и чтение
 *   `profile/manifest.json`, без скачивания логов сессий.
 *
 * Если метод у бэкенда отсутствует, вызов через `normalizeBackend()` даёт
 * понятную ошибку с кодом `reserve/unsupported`, а не `… is not a function`.
 *
 * Сетевые сбои повторяются 4 раза с нарастающей паузой, на один файл отведено
 * 120 с, лёгкая сверка укладывается в 10–30 с.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { markUploaded, pruneProgress, readProgress, writeProgress } from './progress.mjs'

const BASE = 'https://webdav.yandex.ru'
const TIMEOUT_MS = 180_000
/** Таймаут на файл (скачивание и загрузка) — 120 с по аудиту. */
export const FILE_TIMEOUT_MS = 120_000
/** Сколько раз повторить сетевую ошибку (3–4 по аудиту). */
const NETWORK_RETRIES = 4
const RETRY_BASE_MS = 2_000
/** Файлы крупнее этого не отправляем в резерв: на WebDAV они не доезжают. */
export const MAX_BACKUP_FILE_BYTES = 1_500_000
/** Потоков отправки по умолчанию: одно соединение упирается в предел провайдера. */
export const DEFAULT_CONCURRENCY = 8
/** Пауза между запросами больше не нужна: ограничивает сам провайдер. */
const MIN_REQUEST_GAP_MS = 20
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'

/** Каталог карантина облачных копий: его не трогают list/sync/commit. */
export const QUARANTINE_DIR = '.trash'
/** Имя очереди отложенных удалений (лежит рядом с кешем, как upload-progress). */
export const REMOVE_QUEUE_FILE = 'remove-queue.json'
/** Сколько операций держим в очереди удалений, чтобы файл не рос бесконечно. */
export const REMOVE_QUEUE_LIMIT = 200

/** Коды ошибок и результатов резервного канала. */
export const RESERVE_CODES = Object.freeze({
  ok: 'reserve/ok',
  unsupported: 'reserve/unsupported',
  unauthorized: 'reserve/unauthorized',
  timeout: 'reserve/timeout',
  failed: 'reserve/probe-failed',
})

/** Что умеет WebDAV-бэкенд. */
export const WEBDAV_CAPABILITIES = Object.freeze({
  list: true,
  sync: true,
  commit: true,
  remove: true,
  lightProbe: true,
})

/** Методы единого интерфейса бэкендов. */
export const BACKEND_METHODS = Object.freeze(['list', 'sync', 'commit', 'remove', 'lightProbe'])

/** Границы таймаута лёгкой сверки: 10–30 с (по аудиту), по умолчанию 20 с. */
export const LIGHT_PROBE_TIMEOUT_MIN_MS = 10_000
export const LIGHT_PROBE_TIMEOUT_MAX_MS = 30_000
export const LIGHT_PROBE_TIMEOUT_DEFAULT_MS = 20_000

/** Привести таймаут лёгкой сверки к аудиту: 10–30 с. */
export function lightProbeTimeoutMs(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return LIGHT_PROBE_TIMEOUT_DEFAULT_MS
  return Math.min(LIGHT_PROBE_TIMEOUT_MAX_MS, Math.max(LIGHT_PROBE_TIMEOUT_MIN_MS, Math.round(number)))
}

/** Ошибка таймаута: имя совпадает с DOMException от AbortSignal.timeout. */
function timeoutError(message) {
  const error = new Error(message)
  error.name = 'TimeoutError'
  error.code = RESERVE_CODES.timeout
  return error
}

function isTimeoutError(error) {
  const name = error?.name ?? ''
  if (name === 'TimeoutError' || name === 'AbortError') return true
  return error?.code === RESERVE_CODES.timeout
}

/**
 * Понятная ошибка «операция не поддерживается» вместо TypeError.
 * @param method имя метода единого интерфейса
 * @param kind вид бэкенда (webdav, folder, git, yandex…)
 */
export function unsupportedOperation(method, kind = 'backend') {
  const error = new Error(`резервный канал «${kind}» не поддерживает операцию «${method}» (${RESERVE_CODES.unsupported}) — нужна другая настройка резерва`)
  error.code = RESERVE_CODES.unsupported
  error.method = method
  error.kind = kind
  return error
}

/**
 * Возможности бэкенда: заявленные им самим либо выведенные по наличию методов.
 * Ничего не вызывает, поэтому безопасна для бэкендов без единого интерфейса.
 */
export function backendCapabilities(backend) {
  const declared = backend?.capabilities
  const capabilities = {}
  for (const method of BACKEND_METHODS) {
    const fromBackend = declared !== null && typeof declared === 'object' ? declared[method] : undefined
    capabilities[method] = typeof fromBackend === 'boolean' ? fromBackend : typeof backend?.[method] === 'function'
  }
  return capabilities
}

/** Заглушка метода: та же ошибка `reserve/unsupported`, но только при вызове. */
function methodStub(method, kind) {
  return async () => {
    throw unsupportedOperation(method, kind)
  }
}

/**
 * Привести любой бэкенд к единому интерфейсу (H5).
 *
 * Отсутствующие методы не превращаются в TypeError: у бэкенда появляются
 * заглушки, которые при вызове бросают `reserve/unsupported`. Создавать
 * нормализованный бэкенд можно и из `null` (тогда все операции — заглушки).
 *
 * @param backend результат createRemote() или отдельный мок
 * @param options.kind подпись бэкенда для ошибки (по умолчанию backend.kind)
 */
export function normalizeBackend(backend, options = {}) {
  const source = backend !== null && typeof backend === 'object' ? backend : null
  const kind = typeof options.kind === 'string' && options.kind !== ''
    ? options.kind
    : typeof source?.kind === 'string' && source.kind !== '' ? source.kind : 'backend'
  const capabilities = backendCapabilities(source)
  const normalized = { kind, capabilities }
  for (const method of BACKEND_METHODS) {
    const fn = source?.[method]
    normalized[method] = typeof fn === 'function'
      ? (...args) => fn.apply(source, args)
      : methodStub(method, kind)
  }
  // Осторожная проверка «операция точно поддержана»: и заявлена, и реализована.
  normalized.supports = (method) => normalized.capabilities[method] === true && typeof source?.[method] === 'function'
  return normalized
}

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

/** Путь элемента зеркала: без ведущих и хвостовых слэшей. */
export function normalizeRel(rel) {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/** Обратное преобразование сегмента пути (порт encodeSegment). */
export function decodeSegment(raw) {
  return String(raw).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** Разобрать XML-ответ PROPFIND в плоский список. */
export function parsePropfind(xml, basePath) {
  const items = []
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

// --- очередь удалений ------------------------------------------------------

/** Файл очереди отложенных удалений лежит рядом с кешем (как upload-progress). */
export function removeQueuePath(repoDir) {
  return join(repoDir, '..', REMOVE_QUEUE_FILE)
}

/** Прочитать очередь удалений; битый файл считается пустой очередью. */
export async function readRemoveQueue(repoDir) {
  const empty = { version: 1, operations: [] }
  try {
    const parsed = JSON.parse(await readFile(removeQueuePath(repoDir), 'utf8'))
    const operations = Array.isArray(parsed?.operations)
      ? parsed.operations
        .filter(item => item !== null && typeof item === 'object' && typeof item.path === 'string' && item.path !== '')
        .map(item => ({
          path: normalizeRel(item.path),
          at: typeof item.at === 'string' ? item.at : '',
          reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
          attempts: Number.isFinite(item.attempts) ? item.attempts : 0,
        }))
      : []
    return { version: 1, operations }
  } catch {
    return empty
  }
}

/** Записать очередь удалений (вспомогательная структура, ошибки не критичны). */
export async function writeRemoveQueue(repoDir, queue) {
  try {
    const path = removeQueuePath(repoDir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ version: 1, operations: queue?.operations ?? [] }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Поставить удаление в очередь (идемпотентно). Очередь — это интерфейс:
 * синхронизация из-за недоступного облака не падает.
 */
export async function enqueueRemove(repoDir, rel, options = {}) {
  const path = normalizeRel(rel)
  if (path === '') return { ok: false, reason: 'пустой путь' }
  const queue = await readRemoveQueue(repoDir)
  const exists = queue.operations.some(item => item.path === path)
  if (!exists) {
    queue.operations.push({
      path,
      at: typeof options.at === 'string' ? options.at : new Date().toISOString(),
      reason: typeof options.reason === 'string' ? options.reason.slice(0, 200) : '',
      attempts: 0,
    })
    if (queue.operations.length > REMOVE_QUEUE_LIMIT) queue.operations = queue.operations.slice(-REMOVE_QUEUE_LIMIT)
  }
  const saved = await writeRemoveQueue(repoDir, queue)
  return { ok: saved, queued: true, added: !exists, pending: queue.operations.length, path }
}

/** Очистить очередь удалений (после ручного разбора). */
export async function clearRemoveQueue(repoDir) {
  return writeRemoveQueue(repoDir, { version: 1, operations: [] })
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
  const pause = async (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
  const throttle = async () => {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await pause(wait)
    lastRequestAt = Date.now()
  }

  /**
   * Запрос к WebDAV. Третьим аргументом можно задать общий дедлайн (`deadline`)
   * и собственный таймаут (`timeoutMs`): лёгкая сверка должна укладываться
   * в 10–30 с и не ждать, пока отработают паузы повторов.
   */
  const request = async (path, init = {}, requestOptions = {}) => {
    if (login === '' || password === '') throw new Error('не заданы логин и пароль приложения Яндекс.Диска')
    const deadline = Number(requestOptions.deadline ?? 0)
    const requestTimeoutMs = Number(requestOptions.timeoutMs ?? TIMEOUT_MS)
    const remainingMs = () => Math.max(1, deadline - Date.now())
    const deadlineExpired = () => deadline > 0 && Date.now() >= deadline
    const send = () => {
      if (deadlineExpired()) throw timeoutError(`время на запрос к Яндекс.Диску истекло (${Math.round(requestTimeoutMs / 1000)} с)`)
      const fallback = deadline > 0 && requestOptions.timeoutMs === undefined ? remainingMs() : requestTimeoutMs
      return fetch(`${BASE}${encodeURI(path)}`, {
        ...init,
        headers: { authorization: auth(), ...(init.headers ?? {}) },
        signal: init.signal === undefined ? AbortSignal.timeout(fallback) : init.signal,
      })
    }

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
        if (deadlineExpired()) throw timeoutError('лёгкая сверка не уложилась в отведённое время')
        const wait = Math.min(60_000, retryBaseMs * 2 ** attempt)
        await pause(deadline > 0 ? Math.min(wait, remainingMs()) : wait)
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
      if (deadlineExpired()) throw timeoutError('лёгкая сверка не уложилась в отведённое время')
      const retryAfter = Number(response.headers.get('retry-after') ?? 0)
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(120_000, 10_000 * (attempt + 1))
      await pause(deadline > 0 ? Math.min(wait, remainingMs()) : wait)
      await throttle()
      response = await send()
    }
    return response
  }

  /** Путь элемента относительно корня зеркала. */
  const relOf = (href) => String(href).replace(`${root}/`, '').replace(/^\/+/, '')

  const listRemote = async () => {
    const files = new Map()
    const walk = async (dir) => {
      const response = await request(`${dir}/`, { method: 'PROPFIND', headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY })
      if (response.status === 404) return
      if (response.status === 401) throw new Error('Яндекс.Диск не принял логин или пароль приложения (401)')
      if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): HTTP ${response.status}`)
      const xml = await response.text()
      for (const item of parsePropfind(xml, dir)) {
        const rel = relOf(item.href)
        // Карантин удалённых копий живёт в облаке, но синхронизацией не считается:
        // иначе следующий commit удалил бы его как «лишний» файл.
        if (rel === QUARANTINE_DIR || rel.startsWith(`${QUARANTINE_DIR}/`)) continue
        if (item.isDir) await walk(item.href)
        else {
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
    const response = await request(`/${root.replace(/^\/+/, '')}/${rel}`, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): не удалось скачать ${rel} (${response.status})`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const target = join(config.repoDir, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buffer)
  }

  const upload = async (rel, absolute) => {
    const buffer = await readFile(absolute)
    const response = await request(`/${root.replace(/^\/+/, '')}/${rel}`, { method: 'PUT', body: buffer, signal: AbortSignal.timeout(FILE_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): не удалось загрузить ${rel} (${response.status})`)
  }

  /** Дедлайн и сигнал для лёгкой сверки: общий бюджет на все запросы. */
  const lightOptions = (timeoutMs) => {
    const budget = lightProbeTimeoutMs(timeoutMs ?? config.lightProbeTimeoutMs)
    return { timeoutMs: budget, deadline: Date.now() + budget }
  }

  /** PROPFIND поддерева: depth — '1' или 'infinity'. */
  const propfind = async (relDir, depth, budget) => {
    const path = relDir === '' ? `${root}/` : `${root}/${relDir}/`
    return request(path, {
      method: 'PROPFIND',
      headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    }, budget)
  }

  /** Прочитать ответ PROPFIND в список относительно корня зеркала. */
  const readPropfind = async (response, basePath, budget) => {
    if (response.status === 404) return []
    if (response.status === 401) throw new Error('Яндекс.Диск не принял логин или пароль приложения (401)')
    if (!response.ok) {
      const error = new Error(`Яндекс.Диск (WebDAV): HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    const xml = await response.text()
    return parsePropfind(xml, basePath).map(item => ({ ...item, rel: relOf(item.href) }))
  }

  /**
   * Облачные сессии по данным листинга (без скачивания логов).
   * Сначала пробуем один PROPFIND с depth: infinity; если сервер его не
   * поддерживает — обходим корень и папки проектов по depth: 1 (тогда id есть,
   * а размеры — нет).
   */
  const lightListing = async (budget) => {
    const sessions = new Map()
    const add = (rel, size) => {
      const match = /^sessions\/([^/]+)\/([^/]+)\/session\.v4\.jsonl\.zstd$/.exec(rel)
      if (match === null) return
      const id = decodeSegment(match[2])
      const known = sessions.get(id)
      if (known !== undefined) return
      sessions.set(id, {
        id,
        project: match[1],
        sizeBytes: Number.isFinite(size) && size > 0 ? size : undefined,
        path: rel,
      })
    }

    let infinite = null
    try {
      infinite = await propfind('', 'infinity', budget)
    } catch (error) {
      // Сервер против depth: infinity — не повод валить сверку: ниже обход.
      if (!(error?.status === 403 || error?.status === 400 || error?.status === 501 || error?.status === 413 || error?.status === 409)) throw error
      infinite = null
    }
    if (infinite !== null && infinite.ok) {
      // Сервер мог проигнорировать depth и ответить depth: 1 — тогда логов
      // в ответе нет, и ниже сработает пошаговый обход.
      const items = await readPropfind(infinite, root, budget)
      for (const item of items) {
        if (item.isDir) continue
        add(item.rel, item.size)
      }
      if (sessions.size > 0) return { sessions, sizesKnown: true }
    }

    // Пошаговый обход: корень → sessions → папки проектов → папки сессий.
    const rootResponse = await propfind('', '1', budget)
    const rootItems = await readPropfind(rootResponse, root, budget)
    let projectDirs = []
    if (rootItems.some(item => item.isDir && item.rel === 'sessions')) {
      const sessionsResponse = await propfind('sessions', '1', budget)
      const sessionsItems = await readPropfind(sessionsResponse, `${root}/sessions`, budget)
      projectDirs = sessionsItems.filter(item => item.isDir && /^sessions\/[^/]+$/.test(item.rel))
    }
    for (const projectDir of projectDirs) {
      const response = await propfind(projectDir.rel, '1', budget)
      const items = await readPropfind(response, `${root}/${projectDir.rel}`, budget)
      for (const item of items) {
        if (!item.isDir) continue
        const match = /^sessions\/([^/]+)\/([^/]+)$/.exec(item.rel)
        if (match === null) continue
        const id = decodeSegment(match[2])
        if (sessions.has(id)) continue
        sessions.set(id, { id, project: match[1], sizeBytes: undefined, path: `${item.rel}/session.v4.jsonl.zstd` })
      }
    }
    return { sessions, sizesKnown: false }
  }

  /** Прочитать profile/manifest.json (маленький JSON, не блоб). */
  const readCloudManifest = async (budget) => {
    const response = await request(`${root}/profile/manifest.json`, {}, budget)
    if (response.status === 401) throw new Error('Яндекс.Диск не принял логин или пароль приложения (401)')
    if (response.status === 404) return { present: false, device: '', updatedAt: '', files: 0, sessions: new Map(), warning: '' }
    if (!response.ok) return { present: false, device: '', updatedAt: '', files: 0, sessions: new Map(), warning: `manifest.json: HTTP ${response.status}` }
    try {
      const parsed = JSON.parse(await response.text())
      const files = parsed?.files !== null && typeof parsed?.files === 'object' ? Object.keys(parsed.files).length : 0
      return {
        present: true,
        device: typeof parsed?.device === 'string' ? parsed.device : '',
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
        files,
        sessions: manifestSessionIndex(parsed),
        warning: '',
      }
    } catch (error) {
      return { present: false, device: '', updatedAt: '', files: 0, sessions: new Map(), warning: `profile/manifest.json не разобран: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * Удалить облачную копию файла: MOVE в облачный карантин `.trash/<метка>/…`.
   * Если MOVE не поддержан или сеть недоступна — операция встаёт в локальную
   * очередь; наружу это не ошибка, синхронизация не падает.
   */
  const remove = async (rel, removeOptions = {}) => {
    const path = normalizeRel(rel)
    if (path === '') throw new Error('путь для удаления из облака не задан')
    const at = typeof removeOptions.at === 'string' ? removeOptions.at : new Date().toISOString()
    const stamp = at.replace(/[:.]/g, '-')
    const quarantine = `${QUARANTINE_DIR}/${stamp}/${path}`
    const queued = async (reason) => {
      const result = await enqueueRemove(config.repoDir, path, { reason, at })
      return {
        ok: true,
        removed: false,
        quarantined: false,
        queued: result.ok,
        path,
        target: quarantine,
        reason,
        queue: { pending: result.pending ?? 0 },
        at,
        warning: result.ok ? '' : 'не удалось сохранить очередь удалений',
      }
    }
    try {
      await ensureDir(`${QUARANTINE_DIR}/${stamp}`)
      const response = await request(`${root}/${path}`, {
        method: 'MOVE',
        headers: { destination: `${BASE}${encodeURI(`${root}/${quarantine}`)}`, overwrite: 'T' },
      })
      if (response.ok) return { ok: true, removed: true, quarantined: true, queued: false, path, target: quarantine, at }
      if (response.status === 404) return { ok: true, removed: false, quarantined: false, queued: false, missing: true, path, at }
      return queued(`MOVE HTTP ${response.status}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('не заданы логин')) throw error
      return queued(message.slice(0, 200))
    }
  }

  const backend = {
    kind: 'webdav',
    capabilities: WEBDAV_CAPABILITIES,
    timeoutMs: FILE_TIMEOUT_MS,

    /** Что лежит в облаке: пути, размеры, дата изменения. */
    async list() {
      const remote = await listRemote()
      return [...remote.entries()]
        .map(([rel, meta]) => ({ rel, size: meta.size, modified: meta.modified }))
        .sort((left, right) => left.rel.localeCompare(right.rel))
    },

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

    /** Убрать облачную копию: карантин в облаке или очередь операции. */
    remove,

    /**
     * Лёгкая сверка резерва (U3): PROPFIND + profile/manifest.json, без
     * скачивания логов. Возвращает counts/ids и расхождения.
     *
     * @param options.local локальный слепок [{ id, project, events, sizeBytes }]
     * @param options.projects id проектов, которые участвуют в сверке
     * @param options.timeoutMs бюджет 10–30 с (по умолчанию 20 с)
     */
    async lightProbe(probeOptions = {}) {
      const started = Date.now()
      const budget = lightOptions(probeOptions.timeoutMs)
      const local = normalizeProbeLocal(probeOptions.local)
      const projectFilter = Array.isArray(probeOptions.projects) && probeOptions.projects.length > 0
        ? new Set(probeOptions.projects.map(item => String(item)))
        : undefined
      const failure = (code, message, extra = {}) => ({
        ok: false,
        code,
        kind: 'webdav',
        message,
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        timeoutMs: budget.timeoutMs,
        local: { count: local.length, ids: local.map(item => item.id) },
        cloud: { count: 0, ids: [], sizesKnown: false },
        onlyLocal: local.length,
        onlyCloud: 0,
        differ: 0,
        onlyLocalIds: local.map(item => item.id),
        onlyCloudIds: [],
        differIds: [],
        differItems: [],
        manifest: { present: false, device: '', updatedAt: '', files: 0, warning: '' },
        ...extra,
      })
      try {
        const listing = await lightListing(budget)
        const manifest = await readCloudManifest(budget)

        let cloudEntries = [...listing.sessions.values()]
        if (projectFilter !== undefined) cloudEntries = cloudEntries.filter(item => projectFilter.has(item.project))

        // Манифест может (в будущем) отдавать индекс сессий: события и размеры.
        for (const cloudEntry of cloudEntries) {
          const meta = manifest.sessions.get(cloudEntry.id)
          if (meta === undefined) continue
          if (meta.events !== undefined) cloudEntry.events = meta.events
          if (meta.sizeBytes !== undefined && cloudEntry.sizeBytes === undefined) cloudEntry.sizeBytes = meta.sizeBytes
          if (meta.project !== undefined && cloudEntry.project === '') cloudEntry.project = meta.project
        }

        const localById = new Map(local.map(item => [item.id, item]))
        const cloudById = new Map(cloudEntries.map(item => [item.id, item]))
        const onlyLocalIds = [...localById.keys()].filter(id => !cloudById.has(id)).sort()
        const onlyCloudIds = [...cloudById.keys()].filter(id => !localById.has(id)).sort()
        const differItems = []
        for (const [id, localEntry] of localById) {
          const cloudEntry = cloudById.get(id)
          if (cloudEntry === undefined) continue
          const eventsDiffer = localEntry.events !== undefined && cloudEntry.events !== undefined && localEntry.events !== cloudEntry.events
          const sizeDiffer = localEntry.sizeBytes !== undefined && cloudEntry.sizeBytes !== undefined && localEntry.sizeBytes !== cloudEntry.sizeBytes
          if (!eventsDiffer && !sizeDiffer) continue
          differItems.push({
            id,
            project: cloudEntry.project,
            events: eventsDiffer ? { local: localEntry.events, cloud: cloudEntry.events } : undefined,
            sizeBytes: sizeDiffer ? { local: localEntry.sizeBytes, cloud: cloudEntry.sizeBytes } : undefined,
          })
        }
        differItems.sort((left, right) => left.id.localeCompare(right.id))
        const sizes = cloudEntries.filter(item => item.sizeBytes !== undefined).length
        return {
          ok: true,
          code: RESERVE_CODES.ok,
          kind: 'webdav',
          at: new Date().toISOString(),
          durationMs: Date.now() - started,
          timeoutMs: budget.timeoutMs,
          local: { count: localById.size, ids: [...localById.keys()].sort() },
          cloud: { count: cloudById.size, ids: [...cloudById.keys()].sort(), sizesKnown: listing.sizesKnown, sizesCompared: sizes },
          onlyLocal: onlyLocalIds.length,
          onlyCloud: onlyCloudIds.length,
          differ: differItems.length,
          onlyLocalIds,
          onlyCloudIds,
          differIds: differItems.map(item => item.id),
          differItems,
          manifest: { present: manifest.present, device: manifest.device, updatedAt: manifest.updatedAt, files: manifest.files, warning: manifest.warning },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (isTimeoutError(error)) {
          return failure(RESERVE_CODES.timeout, `лёгкая сверка не уложилась в ${Math.round(budget.timeoutMs / 1000)} с: ${message}`)
        }
        if (/принял логин/.test(message)) {
          return failure(RESERVE_CODES.unauthorized, `Яндекс.Диск не принял логин или пароль приложения (401)`)
        }
        return failure(RESERVE_CODES.failed, `лёгкая сверка резерва не удалась: ${message}`)
      }
    },
  }
  return backend
}

/** Нормализовать локальный слепок для lightProbe: только id/events/sizeBytes. */
function normalizeProbeLocal(local) {
  const result = []
  for (const entry of Array.isArray(local) ? local : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    result.push({
      id,
      project: typeof entry.project === 'string' ? entry.project : '',
      events: Number.isFinite(entry.events) ? Number(entry.events) : undefined,
      sizeBytes: Number.isFinite(entry.sizeBytes) ? Number(entry.sizeBytes) : undefined,
    })
  }
  return result
}

/**
 * Индекс сессий из манифеста, если он там есть (заготовка U3: сейчас манифест
 * описывает только файлы профиля, но формат допускает `sessions`).
 * Поддерживаются объект { id: { events, sizeBytes, project } } и массив.
 */
function manifestSessionIndex(manifest) {
  const source = manifest?.sessions ?? manifest?.index?.sessions
  const map = new Map()
  const add = (id, value) => {
    if (typeof id !== 'string' || id === '' || value === null || typeof value !== 'object') return
    map.set(id, {
      events: Number.isFinite(value.events) ? Number(value.events) : undefined,
      sizeBytes: Number.isFinite(value.sizeBytes) ? Number(value.sizeBytes) : undefined,
      project: typeof value.project === 'string' ? value.project : undefined,
    })
  }
  if (Array.isArray(source)) {
    for (const entry of source) add(typeof entry?.id === 'string' ? entry.id : '', entry)
  } else if (source !== null && typeof source === 'object') {
    for (const [id, value] of Object.entries(source)) add(id, value)
  }
  return map
}

/**
 * Проверка доступа к WebDAV без скачивания облака: лёгкая сверка вместо
 * полного sync(). Возвращает ok/message — как раньше, плюс счётчики.
 */
export async function probeWebdav(config) {
  try {
    const backend = createWebdavBackend(config)
    const probe = await backend.lightProbe({ timeoutMs: config?.lightProbeTimeoutMs })
    if (probe.ok !== true) return { ok: false, message: probe.message, probe }
    const message = `доступ к Яндекс.Диску подтверждён: в облаке ${probe.cloud.count} сессий`
    return { ok: true, message, probe }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
