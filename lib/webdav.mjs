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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { markUploaded, pruneProgress, readProgress, writeProgress } from './progress.mjs'

const BASE = 'https://webdav.yandex.ru'
const TIMEOUT_MS = 180_000
/** Таймаут на загрузку в облако — 120 с по аудиту. */
export const FILE_TIMEOUT_MS = 120_000
/**
 * Таймаут на файл при полной сверке резерва (скачивание) — 30 с.
 * Файл сессии небольшой; если он не успел за полминуты, это сбой сети, а не
 * объём: операция идёт дальше, а скачивание продолжится со следующего запуска.
 */
export const SECONDARY_FILE_TIMEOUT_MS = 30_000
/** Бюджет всей операции полной сверки — 15 мин (аудит резервного канала). */
export const SECONDARY_OPERATION_TIMEOUT_MS = 15 * 60_000
/** Сколько файлов полной сверки скачиваются одновременно. */
export const SECONDARY_CONCURRENCY = 8
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

/** Коды ошибок полной сверки: ровно их показывает карточка резерва. */
export const RESERVE_ERROR_CODES = Object.freeze({
  unauthorized: '401',
  forbidden: '403',
  timeout: 'timeout',
  tls: 'tls',
  network: 'network',
  quota: 'quota',
  /** Отмена по кнопке «Отменить» — не сбой, а действие человека. */
  cancelled: 'cancelled',
})

const RESERVE_KNOWN_CODES = new Set(Object.values(RESERVE_ERROR_CODES))
const TLS_PATTERN = /TLS|SSL|certificate|сертификат|schannel|EPROTO|CERT_|UNABLE_TO_VERIFY|self[- ]signed/i
const QUOTA_PATTERN = /507|quota|insufficient storage|not enough space|места на диске|недостаточно места|переполнен/i
const NETWORK_PATTERN = /fetch failed|terminated|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|socket hang up|network error|operation was aborted|other side closed|network timeout/i

/**
 * Подсказка-действие к коду ошибки резерва: что именно сделать человеку.
 * Коды — из `RESERVE_ERROR_CODES`; для неизвестного кода — общий совет.
 */
export function reserveErrorHint(code) {
  switch (String(code ?? '')) {
    case RESERVE_ERROR_CODES.unauthorized:
      return 'Логин или пароль приложения не принят (401). Проверьте логин Яндекс.Диска и пароль приложения «Файлы» (id.yandex.ru → Безопасность → Пароли приложений), сохраните настройки резерва и повторите сверку.'
    case RESERVE_ERROR_CODES.forbidden:
      return 'Яндекс.Диск запретил доступ к папке резерва (403). Проверьте, что папка принадлежит вашему аккаунту и пароль приложения «Файлы» действителен, затем повторите сверку.'
    case RESERVE_ERROR_CODES.timeout:
      return 'Облако не ответило за отведённое время (файл — 30 с, вся операция — 15 мин). Проверьте интернет и повторите: уже скачанное не скачивается заново, сверка продолжится с места остановки.'
    case RESERVE_ERROR_CODES.tls:
      return 'Соединение TLS не установлено: проверьте системные сертификаты и время на компьютере, затем повторите сверку.'
    case RESERVE_ERROR_CODES.quota:
      return 'В облаке закончилось место или превышен лимит запросов. Освободите место на Диске и повторите сверку.'
    case RESERVE_ERROR_CODES.cancelled:
      return 'Сверка отменена. Уже скачанное сохранено: при следующем запуске скачивание продолжится с места остановки.'
    case RESERVE_ERROR_CODES.network:
      return 'Сеть недоступна или соединение оборвалось. Проверьте интернет и повторите: скачивание продолжится с места остановки.'
    default:
      return 'Сверка резерва не удалась. Проверьте интернет и повторите: скачивание продолжится с места остановки.'
  }
}

/**
 * Ошибка резервного канала с кодом, файлом и подсказкой.
 * @param code код из RESERVE_ERROR_CODES
 * @param message человеческий текст
 * @param extra file/errors/totals/cancelled — подробности для панели
 */
export function reserveError(code, message, extra = {}) {
  const normalized = RESERVE_KNOWN_CODES.has(String(code)) ? String(code) : RESERVE_ERROR_CODES.network
  const error = new Error(typeof message === 'string' && message !== '' ? message : reserveErrorHint(normalized))
  error.name = 'ReserveError'
  error.code = normalized
  error.file = typeof extra.file === 'string' ? extra.file : ''
  error.hint = typeof extra.hint === 'string' && extra.hint !== '' ? extra.hint : reserveErrorHint(normalized)
  if (Array.isArray(extra.errors)) error.errors = extra.errors.slice(0, 20)
  if (extra.totals !== null && typeof extra.totals === 'object') error.totals = extra.totals
  if (extra.cancelled === true) error.cancelled = true
  if (extra.cause !== undefined) error.cause = extra.cause
  return error
}

/**
 * Привести любую ошибку скачивания/сверки к контракту панели:
 * `{ code, file, message, hint }`. Коды — 401/403/timeout/tls/network/quota
 * (и `cancelled` для действия «Отменить»).
 */
export function classifyReserveError(error, extra = {}) {
  const explicit = typeof error?.code === 'string' ? error.code : ''
  if (RESERVE_KNOWN_CODES.has(explicit)) {
    const file = typeof extra.file === 'string' && extra.file !== ''
      ? extra.file
      : (typeof error?.file === 'string' ? error.file : '')
    return {
      code: explicit,
      file,
      message: typeof error?.message === 'string' ? error.message : reserveErrorHint(explicit),
      hint: typeof error?.hint === 'string' && error.hint !== '' ? error.hint : reserveErrorHint(explicit),
      totals: error?.totals,
      errors: Array.isArray(error?.errors) ? error.errors : undefined,
      cancelled: error?.cancelled === true,
    }
  }
  const status = Number(error?.status ?? error?.statusCode ?? 0)
  const raw = String(error?.message ?? error ?? '')
  const text = `${raw} ${error?.cause?.message ?? ''} ${error?.cause?.code ?? ''}`
  const file = typeof extra.file === 'string' ? extra.file : (typeof error?.file === 'string' ? error.file : '')
  let code
  if (extra.cancelled === true || error?.cancelled === true || error?.name === 'AbortError' && extra.cancelled === true) {
    code = RESERVE_ERROR_CODES.cancelled
  } else if (status === 401 || /\(401\)|не принял логин|не заданы логин|пароль приложения/i.test(raw)) {
    code = RESERVE_ERROR_CODES.unauthorized
  } else if (status === 403 || /\(403\)|forbidden|доступ запрещ/i.test(raw)) {
    code = RESERVE_ERROR_CODES.forbidden
  } else if (status === 507 || status === 429 || QUOTA_PATTERN.test(text)) {
    code = RESERVE_ERROR_CODES.quota
  } else if (isTimeoutError(error) || /timeout|таймаут|истекло|уложилась|не успел/i.test(raw)) {
    code = RESERVE_ERROR_CODES.timeout
  } else if (TLS_PATTERN.test(text)) {
    code = RESERVE_ERROR_CODES.tls
  } else if (NETWORK_PATTERN.test(text) || error?.name === 'TypeError') {
    code = RESERVE_ERROR_CODES.network
  } else {
    code = RESERVE_ERROR_CODES.network
  }
  const message = code === RESERVE_ERROR_CODES.unauthorized
    ? 'Яндекс.Диск не принял логин или пароль приложения (401)'
    : code === RESERVE_ERROR_CODES.forbidden
      ? 'Яндекс.Диск запретил доступ к папке резерва (403)'
      : code === RESERVE_ERROR_CODES.quota
        ? `в облаке закончилось место или превышен лимит запросов: ${raw}`
        : code === RESERVE_ERROR_CODES.timeout
          ? (raw !== '' ? raw : 'операция сверки не уложилась в отведённое время')
          : code === RESERVE_ERROR_CODES.tls
            ? `соединение TLS не установлено: ${raw}`
            : code === RESERVE_ERROR_CODES.cancelled
              ? 'сверка отменена пользователем'
              : `сеть недоступна или соединение оборвалось: ${raw}`
  return {
    code,
    file,
    message,
    hint: reserveErrorHint(code),
    totals: error?.totals,
    errors: Array.isArray(error?.errors) ? error.errors : undefined,
    cancelled: code === RESERVE_ERROR_CODES.cancelled,
  }
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

/** Хвост незаконченного скачивания: `<файл>.part` в локальном кеше резерва. */
const PART_SUFFIX = '.part'

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
    // Незаконченное скачивание полной сверки (`.part`) — не файл зеркала:
    // его нельзя ни загружать в облако, ни считать готовым.
    else if (entry.isFile() && !entry.name.endsWith(PART_SUFFIX)) out.push({ absolute, rel: relative(base, absolute).split(sep).join('/') })
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

/** Положительное число из настройки или значение по умолчанию. */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** Итоги полной сверки для панели: файлы, байты, скачано/пропущено/ошибки. */
function totalsOf(progress) {
  return {
    files: Number(progress?.filesTotal ?? 0),
    bytes: Number(progress?.bytesTotal ?? 0),
    downloaded: Number(progress?.downloaded ?? 0),
    skipped: Number(progress?.skipped ?? 0),
    resumed: Number(progress?.resumed ?? 0),
    failed: Number(progress?.failed ?? 0),
  }
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
   * Запрос к WebDAV. Третьим аргументом можно задать общий дедлайн (`deadline`),
   * собственный таймаут (`timeoutMs`) и внешний сигнал отмены (`signal`):
   * лёгкая сверка должна укладываться в 10–30 с и не ждать, пока отработают
   * паузы повторов, а полную сверку можно отменить кнопкой.
   */
  const request = async (path, init = {}, requestOptions = {}) => {
    if (login === '' || password === '') throw new Error('не заданы логин и пароль приложения Яндекс.Диска')
    const deadline = Number(requestOptions.deadline ?? 0)
    const requestTimeoutMs = Number(requestOptions.timeoutMs ?? TIMEOUT_MS)
    const externalSignal = init.signal ?? requestOptions.signal
    const remainingMs = () => Math.max(1, deadline - Date.now())
    const deadlineExpired = () => deadline > 0 && Date.now() >= deadline
    /** Сигнал запроса: внешний (отмена/операция) плюс собственный таймаут. */
    const signalOf = (fallback) => {
      if (externalSignal === undefined || externalSignal === null) return AbortSignal.timeout(fallback)
      if (!(fallback > 0) || !Number.isFinite(fallback)) return externalSignal
      // AbortSignal.any отдаёт причину первого сработавшего сигнала: таймаут
      // остаётся TimeoutError, отмена — AbortError внешнего сигнала.
      return AbortSignal.any([externalSignal, AbortSignal.timeout(fallback)])
    }
    const send = () => {
      if (deadlineExpired()) throw timeoutError(`время на запрос к Яндекс.Диску истекло (${Math.round(requestTimeoutMs / 1000)} с)`)
      const fallback = deadline > 0 && requestOptions.timeoutMs === undefined ? remainingMs() : requestTimeoutMs
      return fetch(`${BASE}${encodeURI(path)}`, {
        ...init,
        headers: { authorization: auth(), ...(init.headers ?? {}) },
        signal: signalOf(fallback),
      })
    }

    /** Пауза, которую прерывает сигнал отмены (кнопка «Отменить»). */
    const waitOrAbort = async (ms) => {
      const wait = Math.max(0, Number(ms) || 0)
      if (wait === 0) return
      if (externalSignal === undefined || externalSignal === null) {
        await pause(wait)
        return
      }
      if (externalSignal.aborted === true) return
      await new Promise((resolve) => {
        const timer = setTimeout(done, wait)
        function done() {
          clearTimeout(timer)
          externalSignal.removeEventListener?.('abort', done)
          resolve()
        }
        externalSignal.addEventListener?.('abort', done, { once: true })
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
      if (externalSignal?.aborted === true) throw error
      if (!networkErrorOf(error)) throw error
      for (let attempt = 0; attempt < NETWORK_RETRIES; attempt++) {
        if (externalSignal?.aborted === true) throw error
        if (deadlineExpired()) throw timeoutError('время на запрос к Яндекс.Диску истекло')
        const wait = Math.min(60_000, retryBaseMs * 2 ** attempt)
        await waitOrAbort(deadline > 0 ? Math.min(wait, remainingMs()) : wait)
        if (externalSignal?.aborted === true) throw error
        await throttle()
        try {
          response = await send()
          break
        } catch (retryError) {
          if (externalSignal?.aborted === true) throw retryError
          if (!networkErrorOf(retryError)) throw retryError
          if (attempt === NETWORK_RETRIES - 1) throw retryError
        }
      }
    }

    // Яндекс ограничивает частоту запросов (429) и иногда отвечает 503:
    // повторяем с паузой, уважая Retry-After.
    for (let attempt = 0; attempt < 4 && (response.status === 429 || response.status === 503); attempt++) {
      if (externalSignal?.aborted === true) throw timeoutError('запрос отменён')
      if (deadlineExpired()) throw timeoutError('лёгкая сверка не уложилась в отведённое время')
      const retryAfter = Number(response.headers.get('retry-after') ?? 0)
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(120_000, 10_000 * (attempt + 1))
      await waitOrAbort(deadline > 0 ? Math.min(wait, remainingMs()) : wait)
      if (externalSignal?.aborted === true) throw timeoutError('запрос отменён')
      await throttle()
      response = await send()
    }
    return response
  }

  /** Путь элемента относительно корня зеркала. */
  const relOf = (href) => String(href).replace(`${root}/`, '').replace(/^\/+/, '')

  /**
   * Листинг облака: путь → размер/дата.
   * @param netOptions signal/deadline/timeoutMs — чтобы полную сверку можно было
   *   отменить и уложить в бюджет (лёгкая сверка передаёт туда же свой бюджет)
   */
  const listRemote = async (netOptions = {}) => {
    const files = new Map()
    const walk = async (dir) => {
      const response = await request(
        `${dir}/`,
        { method: 'PROPFIND', headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY },
        netOptions,
      )
      if (response.status === 404) return
      if (response.status === 401) throw new Error('Яндекс.Диск не принял логин или пароль приложения (401)')
      if (response.status === 403) {
        const error = new Error('Яндекс.Диск запретил доступ к папке резерва (403)')
        error.status = 403
        throw error
      }
      if (!response.ok) {
        const error = new Error(`Яндекс.Диск (WebDAV): HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
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

  /**
   * Скачать один файл в локальный кеш резюмируемо.
   *
   * Файл пишется в `<rel>.part` и переименовывается в целевое имя только после
   * сверки размера с облачным листингом. Если предыдущая попытка оборвалась,
   * `.part` остаётся на диске, и следующий запуск докачивает его через
   * `Range: bytes=<уже есть>-` (сервер может проигнорировать Range — тогда
   * файл скачивается заново и `.part` перезаписывается).
   *
   * @param rel путь относительно корня зеркала
   * @param meta { size } из листинга
   * @param plan { part, target, start } от planDownload()
   * @param netOptions { signal, deadline, fileTimeoutMs, file }
   */
  const downloadFile = async (rel, meta, plan, netOptions) => {
    const { part, target, start } = plan
    const signal = netOptions.signal
    const deadline = Number(netOptions.deadline ?? 0)
    const fileTimeoutMs = Number(netOptions.fileTimeoutMs ?? SECONDARY_FILE_TIMEOUT_MS)
    if (signal?.aborted === true) throw reserveError(RESERVE_ERROR_CODES.cancelled, 'сверка отменена пользователем', { file: rel })
    // На файл отведено 30 с и не больше остатка бюджета операции.
    const remaining = deadline > 0 ? Math.max(1, deadline - Date.now()) : fileTimeoutMs
    const budget = Math.max(1, Math.min(fileTimeoutMs, remaining))
    let response
    try {
      response = await request(
        `/${root.replace(/^\/+/, '')}/${rel}`,
        {
          headers: start > 0 ? { range: `bytes=${start}-` } : {},
        },
        { signal, deadline: deadline > 0 ? deadline : Date.now() + budget, timeoutMs: budget },
      )
    } catch (error) {
      // Отмена операции — наверх как есть; таймаут файла — понятным кодом.
      if (signal?.aborted === true) throw error
      if (isTimeoutError(error)) {
        throw reserveError(
          RESERVE_ERROR_CODES.timeout,
          `файл ${rel} не скачался за ${Math.max(1, Math.round(fileTimeoutMs / 1000))} с`,
          { file: rel },
        )
      }
      throw error
    }
    if (response.status === 404) {
      // Файл исчез из облака между листингом и скачиванием — не ошибка.
      return { missing: true, rel }
    }
    if (response.status === 416) {
      // Сервер считает, что `.part` уже полный: проверяем размер и решаем по нему.
      const existing = await stat(part).catch(() => null)
      const expected = Number(meta?.size)
      if (existing !== null && Number.isFinite(expected) && existing.size === expected) {
        await mkdir(dirname(target), { recursive: true })
        await rename(part, target)
        return { missing: false, rel, bytes: existing.size, resumed: true }
      }
      await rm(part, { force: true })
      throw reserveError(RESERVE_ERROR_CODES.network, `файл ${rel}: сервер не отдал остаток скачивания`, { file: rel })
    }
    if (!response.ok) {
      const error = new Error(response.status === 401
        ? 'Яндекс.Диск не принял логин или пароль приложения (401)'
        : `Яндекс.Диск (WebDAV): не удалось скачать ${rel} (${response.status})`)
      error.status = response.status
      error.file = rel
      throw error
    }
    let body
    try {
      body = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      // Обрыв тела ответа: `.part` сохраняет уже полученное.
      if (signal?.aborted === true) throw error
      if (isTimeoutError(error)) {
        throw reserveError(
          RESERVE_ERROR_CODES.timeout,
          `файл ${rel} не скачался за ${Math.max(1, Math.round(fileTimeoutMs / 1000))} с`,
          { file: rel },
        )
      }
      throw reserveError(RESERVE_ERROR_CODES.network, `файл ${rel}: соединение оборвалось при скачивании`, { file: rel, cause: error })
    }
    let bytes = body
    let resumed = false
    if (start > 0 && response.status === 206) {
      // Сервер поддержал Range: дописываем к уже скачанной части.
      const head = await readFile(part).catch(() => Buffer.alloc(0))
      bytes = Buffer.concat([head, body])
      resumed = true
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(part, bytes)
    // Проверка размера: недокачанный или лишний файл не должен стать зеркалом.
    const expected = Number(meta?.size)
    const written = await stat(part)
    if (Number.isFinite(expected) && expected >= 0 && written.size !== expected) {
      const error = reserveError(
        RESERVE_ERROR_CODES.network,
        `файл ${rel}: скачано ${written.size} из ${expected} байт`,
        { file: rel },
      )
      // `.part` оставляем: следующий запуск продолжит с этого места.
      throw error
    }
    await rename(part, target)
    return { missing: false, rel, bytes: written.size, resumed }
  }

  /** Решить, что делать с файлом: пропустить, докачать или скачать заново. */
  const planDownload = async (rel, meta) => {
    const target = join(config.repoDir, ...rel.split('/'))
    const part = `${target}${PART_SUFFIX}`
    const existing = await stat(target).catch(() => null)
    const expected = Number(meta?.size)
    if (existing !== null && existing.isFile() && (!Number.isFinite(expected) || existing.size === expected)) {
      // Уже скачано в прошлый раз (и размер совпал) — не перекачиваем.
      await rm(part, { force: true })
      return { skip: true, bytes: existing.size, target, part, start: 0 }
    }
    const partial = await stat(part).catch(() => null)
    if (partial !== null && partial.isFile() && Number.isFinite(expected) && partial.size > 0 && partial.size < expected) {
      return { skip: false, target, part, start: partial.size }
    }
    if (existing !== null) await rm(target, { force: true }).catch(() => {})
    if (partial !== null) await rm(part, { force: true })
    return { skip: false, target, part, start: 0 }
  }

  /**
   * Убрать осиротевшие `.part`: после успешного прохода все части уже
   * переименованы, остатки относится к файлам, которых больше нет в облаке.
   */
  const cleanupParts = async () => {
    let entries = []
    try {
      entries = await readdir(config.repoDir, { recursive: true, withFileTypes: true })
    } catch {
      return 0
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(PART_SUFFIX)) continue
      const absolute = join(entry.parentPath ?? entry.path, entry.name)
      await rm(absolute, { force: true }).catch(() => {})
      removed += 1
    }
    return removed
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

    /**
     * Забрать облако в локальный кеш — резюмируемо, с прогрессом и отменой.
     *
     * П4/П5 резервного канала: каталог кеша создаётся сразу, файлы пишутся в
     * `<rel>.part`, после сверки размера переименовываются; уже скачанное не
     * перекачивается; максимум `SECONDARY_CONCURRENCY` файлов одновременно;
     * отмена — по AbortSignal. Полная сверка резерва передаёт бюджет
     * (файл 30 с, операция 15 мин); обычный вызов `sync()` без опций работает
     * как раньше — на файл 120 с, без общего лимита.
     *
     * @param syncOptions.signal внешний сигнал отмены (кнопка «Отменить»)
     * @param syncOptions.onProgress(progress) снимок прогресса после каждого файла
     * @param syncOptions.operationTimeoutMs бюджет операции (0 — без лимита)
     * @param syncOptions.fileTimeoutMs таймаут файла (по умолчанию 120 с)
     * @param syncOptions.concurrency число потоков (по умолчанию 8)
     * @returns {Promise<{ ok: true, totals: object, progress: object }>}
     */
    async sync(syncOptions = {}) {
      const startedAt = Date.now()
      const operationTimeoutMs = syncOptions.operationTimeoutMs === undefined
        ? 0
        : positiveNumber(syncOptions.operationTimeoutMs, SECONDARY_OPERATION_TIMEOUT_MS)
      const fileTimeoutMs = positiveNumber(syncOptions.fileTimeoutMs, FILE_TIMEOUT_MS)
      const concurrency = Math.max(1, Math.min(32, positiveNumber(syncOptions.concurrency ?? config.concurrency, SECONDARY_CONCURRENCY)))
      const onProgress = typeof syncOptions.onProgress === 'function' ? syncOptions.onProgress : null
      const repoDir = config.repoDir
      // Каталог кеша создаём сразу: в нём лежат `.part`, и следующая попытка
      // должна найти место, куда продолжить.
      await mkdir(repoDir, { recursive: true })

      const progress = {
        phase: 'listing',
        filesTotal: 0,
        filesDone: 0,
        filesProcessed: 0,
        bytesTotal: 0,
        bytesDone: 0,
        downloaded: 0,
        skipped: 0,
        resumed: 0,
        failed: 0,
        currentFile: '',
        percent: 0,
        startedAt: new Date(startedAt).toISOString(),
        elapsedMs: 0,
      }
      const emit = () => {
        progress.elapsedMs = Date.now() - startedAt
        progress.percent = progress.bytesTotal > 0
          ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
          : progress.filesTotal > 0
            ? Math.min(100, Math.round((progress.filesProcessed / progress.filesTotal) * 100))
            : (progress.phase === 'done' ? 100 : 0)
        if (onProgress !== null) {
          try {
            onProgress({ ...progress })
          } catch {
            // снимок прогресса не должен ронять скачивание
          }
        }
        return progress
      }

      // Отмена: либо внешний сигнал (кнопка), либо собственный бюджет операции.
      const controller = new AbortController()
      let cancelled = false
      let timedOut = false
      const outer = syncOptions.signal
      const onOuterAbort = () => {
        cancelled = true
        controller.abort()
      }
      if (outer !== undefined && outer !== null) {
        if (outer.aborted === true) onOuterAbort()
        else outer.addEventListener?.('abort', onOuterAbort, { once: true })
      }
      const operationDeadline = operationTimeoutMs > 0 ? startedAt + operationTimeoutMs : 0
      const timer = operationTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, operationTimeoutMs)
        : null
      timer?.unref?.()
      const signal = controller.signal
      const budgetText = operationTimeoutMs >= 60_000
        ? `${Math.round(operationTimeoutMs / 60_000)} мин`
        : `${Math.max(1, Math.round(operationTimeoutMs / 1000))} с`
      const operationAbortError = (file = '') => (cancelled
        ? reserveError(RESERVE_ERROR_CODES.cancelled, 'сверка отменена пользователем', { file })
        : reserveError(
            RESERVE_ERROR_CODES.timeout,
            `полная сверка не уложилась в ${budgetText}`,
            { file },
          ))
      const checkAbort = (currentFile = '') => {
        if (signal.aborted) throw operationAbortError(currentFile)
        if (timedOut) throw operationAbortError(currentFile)
        if (operationDeadline > 0 && Date.now() >= operationDeadline) {
          timedOut = true
          controller.abort()
          throw operationAbortError(currentFile)
        }
      }

      const errors = []
      let fatal = null
      try {
        emit()
        checkAbort()
        const remote = await listRemote({ signal, deadline: operationDeadline }).catch((error) => {
          if (signal.aborted) throw operationAbortError()
          throw error
        })
        const rels = [...remote.keys()].sort((left, right) => left.localeCompare(right))
        progress.filesTotal = rels.length
        progress.bytesTotal = rels.reduce((sum, rel) => sum + Math.max(0, Number(remote.get(rel)?.size ?? 0)), 0)
        progress.phase = 'download'
        emit()

        let next = 0
        let stop = false
        const worker = async () => {
          for (;;) {
            if (stop) return
            const index = next
            next += 1
            if (index >= rels.length) return
            const rel = rels[index]
            try {
              checkAbort(rel)
            } catch (error) {
              fatal = fatal ?? error
              stop = true
              return
            }
            progress.currentFile = rel
            emit()
            try {
              const plan = await planDownload(rel, remote.get(rel))
              if (plan.skip) {
                progress.skipped += 1
                progress.filesDone += 1
                progress.filesProcessed += 1
                progress.bytesDone += Math.max(0, Number(plan.bytes ?? 0))
              } else {
                const done = await downloadFile(rel, remote.get(rel), plan, { signal, deadline: operationDeadline, fileTimeoutMs })
                if (done.missing === true) {
                  progress.skipped += 1
                } else {
                  progress.downloaded += 1
                  if (done.resumed === true) progress.resumed += 1
                  progress.bytesDone += Math.max(0, Number(done.bytes ?? 0))
                }
                progress.filesDone += 1
                progress.filesProcessed += 1
              }
            } catch (error) {
              // Отмена и «нет доступа» — не повод продолжать перебор файлов.
              if (signal.aborted) {
                fatal = fatal ?? operationAbortError(rel)
                stop = true
                return
              }
              const described = classifyReserveError(error, { file: rel })
              progress.failed += 1
              progress.filesProcessed += 1
              errors.push(described)
              if (described.code === RESERVE_ERROR_CODES.unauthorized
                || described.code === RESERVE_ERROR_CODES.forbidden
                || described.code === RESERVE_ERROR_CODES.quota
                || described.code === RESERVE_ERROR_CODES.cancelled) {
                fatal = fatal ?? reserveError(described.code, described.message, { file: described.file, hint: described.hint, totals: totalsOf(progress) })
                stop = true
                return
              }
            }
            emit()
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, rels.length)) }, worker))
        if (fatal !== null) throw fatal
        progress.phase = 'done'
        emit()
        // После успешного прохода незаконченных частей не остаётся.
        if (errors.length === 0) await cleanupParts()
        const totals = totalsOf(progress)
        if (errors.length > 0) {
          const first = errors[0]
          throw reserveError(
            first.code,
            errors.length === 1 ? first.message : `${first.message}; не удалось файлов: ${errors.length}`,
            { file: first.file, hint: first.hint, errors, totals },
          )
        }
        return { ok: true, synced: true, totals, progress: { ...progress } }
      } catch (error) {
        if (error?.code !== undefined && RESERVE_KNOWN_CODES.has(String(error.code))) {
          if (error.totals === undefined) error.totals = totalsOf(progress)
          throw error
        }
        const described = classifyReserveError(error, { file: progress.currentFile, cancelled })
        throw reserveError(described.code, described.message, {
          file: described.file,
          hint: described.hint,
          errors: described.errors,
          totals: totalsOf(progress),
          cancelled: described.cancelled === true,
          cause: error,
        })
      } finally {
        clearTimeout(timer)
        outer?.removeEventListener?.('abort', onOuterAbort)
        emit()
      }
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
