/**
 * Самопроверка версии dsh-sessions.
 *
 * Плагин ставится из GitHub и pnpm закрепляет конкретный коммит. Этот модуль
 * сравнивает его с текущим `main` и, по явному действию пользователя, просит
 * штатный менеджер плагинов переустановить пакет. Сам себя он не обновляет.
 *
 * Установка из папки проекта (`link:`) не обновляется автоматически: свежий код
 * уже на месте, поэтому проверка честно сообщает «локальная установка».
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Репозиторий, из которого ставится плагин. */
export const UPDATE_REPOSITORY = 'mikhailnarzik-source/dsh-sessions-plugin'
/** Спека установки — единственная, которую разрешено применять. */
export const UPDATE_SPEC = `github:${UPDATE_REPOSITORY}`
/** Имя пакета в профиле. */
export const UPDATE_NAME = 'dsh-sessions'

const BRANCH = 'main'
const MAX_LOCK_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 8_000
/** Файл, в который host-часть пишет установленную версию пакета. */
const VERSION_FILE = 'installed-version.json'
/** Возможные имена коммита в installed-version.json. */
const COMMIT_KEYS = ['installedCommit', 'commit', 'sha', 'revision']

let state = {
  status: 'unknown',
  installed: null,
  latest: null,
  version: null,
  message: '',
  date: '',
  detail: '',
}
let scheduled = false

/** Короткая форма коммита. */
function short(sha) {
  return sha === null || sha === undefined || sha === '' ? '?' : String(sha).slice(0, 7)
}

/** Версия в виде «v1.0.66»; пустая строка, если версия неизвестна. */
function versionLabel(version) {
  return typeof version === 'string' && version.trim() !== '' ? `v${version.trim()}` : ''
}

/** Подпись «версия + короткий коммит» для интерфейса. */
function installedLabel(version = state.version, commit = state.installed) {
  const value = versionLabel(version)
  const sha = commit === null || commit === undefined || commit === '' ? '' : short(commit)
  if (value !== '' && sha !== '') return `${value} (${sha})`
  if (value !== '') return value
  return sha
}

/** Текущее состояние проверки. */
export function updateState() {
  return state
}

/** Строка для карточки: версия и короткий коммит видны в каждом статусе. */
export function describeUpdate() {
  if (state.status === 'current') return `обновление не требуется: ${installedLabel()}`
  if (state.status === 'local') return `локальная установка — автообновление не применяется: ${installedLabel()}`
  if (state.status === 'behind') return `доступно обновление: ${installedLabel()} → ${short(state.latest)}`
  if (state.status === 'error') return `проверка не удалась: ${state.detail}`
  if (state.detail !== '') return `проверка ещё не выполнялась: ${state.detail}`
  return 'проверка ещё не выполнялась'
}

/** DSH home: та же папка, что у CLI и host-части. */
function homeDir() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return path.join(os.homedir(), '.dsh')
}

/** Путь к lockfile профиля рядом с этим пакетом. */
function lockfilePath() {
  try {
    const here = fileURLToPath(import.meta.url)
    const packageDir = path.dirname(path.dirname(here))
    const profileDir = path.dirname(path.dirname(packageDir))
    const candidate = path.join(profileDir, 'pnpm-lock.yaml')
    if (fs.existsSync(candidate)) return candidate
  } catch {
    // переход к запасному пути
  }
  const fallback = path.join(homeDir(), 'profiles', 'desktop', 'pnpm-lock.yaml')
  return fs.existsSync(fallback) ? fallback : undefined
}

/** JSON-файл или null: битый файл не должен ронять проверку версии. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Отметка установленной версии, которую пишет host-часть:
 * `<DSH home>/dsh-sync/installed-version.json`.
 */
function installedVersionInfo() {
  return readJson(path.join(homeDir(), 'dsh-sync', VERSION_FILE))
}

/** Версия установленного пакета: package.json, затем отметка host-части. */
function installedVersion() {
  try {
    const here = fileURLToPath(import.meta.url)
    const manifest = path.join(path.dirname(path.dirname(here)), 'package.json')
    const parsed = readJson(manifest)
    const version = parsed?.version
    if (typeof version === 'string' && version.trim() !== '') return version.trim()
  } catch {
    // остаётся отметка host-части
  }
  const info = installedVersionInfo()
  const fallback = info?.version
  return typeof fallback === 'string' && fallback.trim() !== '' ? fallback.trim() : null
}

/** Установлен ли пакет ссылкой на локальную папку. */
function isLinkedInstall() {
  try {
    const lock = lockfilePath()
    if (lock === undefined) return false
    const profileDir = path.dirname(lock)
    const manifest = path.join(profileDir, 'package.json')
    if (!fs.existsSync(manifest)) return false
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    const spec = parsed?.dependencies?.[UPDATE_NAME]
    return typeof spec === 'string' && spec.startsWith('link:')
  } catch {
    return false
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Коммит, закреплённый pnpm за этим пакетом в lockfile профиля. */
function lockfileCommit() {
  const lock = lockfilePath()
  if (lock === undefined) return null
  try {
    const stat = fs.statSync(lock)
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return null
    const text = fs.readFileSync(lock, 'utf8')
    // Якорь по началу строки/пробелу: имя пакета не должно находиться как
    // хвост другой зависимости (`foo-dsh-sessions`).
    const pattern = new RegExp(
      `(?:^|[\\s])${escapeRegExp(UPDATE_NAME)}:[\\s\\S]{0,240}?codeload\\.github\\.com/${escapeRegExp(UPDATE_REPOSITORY)}/tar\\.gz/([0-9a-f]{40})`,
    )
    const match = pattern.exec(text)
    return match === null ? null : match[1]
  } catch {
    return null
  }
}

/**
 * Установленный коммит: сначала lockfile профиля, затем отметка host-части
 * (`installedCommit`/`commit` в installed-version.json — её пишут при обновлении).
 */
function installedCommit() {
  const fromLock = lockfileCommit()
  if (fromLock !== null) return fromLock
  const info = installedVersionInfo()
  for (const key of COMMIT_KEYS) {
    const value = info?.[key]
    if (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim())) return value.trim()
  }
  return null
}

/**
 * Сравнить установленный коммит с `main`.
 * @param resolveToken - необязательный провайдер токена GitHub.
 * @returns новое состояние.
 */
export async function checkForUpdate(resolveToken) {
  const version = installedVersion()
  try {
    const installed = installedCommit()
    if (installed === null) {
      // Плагин подключён ссылкой на локальную папку: обновлять нечего, свежий
      // код уже на месте. Проверка версии в этом случае бессмысленна.
      state = isLinkedInstall()
        ? { status: 'local', installed: null, latest: null, version, message: '', date: '', detail: 'локальная установка: обновление идёт из папки проекта' }
        : { status: 'unknown', installed: null, latest: null, version, message: '', date: '', detail: 'коммит не найден в lockfile' }
      return state
    }
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-sessions/update-check' }
    const token = typeof resolveToken === 'function' ? await resolveToken() : undefined
    if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`

    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPOSITORY}/commits/${BRANCH}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      state = { ...state, status: 'error', installed, version, detail: `HTTP ${response.status}` }
      return state
    }
    const data = await response.json()
    const latest = data.sha
    const message = String(data.commit?.message ?? '').split('\n')[0].slice(0, 120)
    const date = String(data.commit?.committer?.date ?? '')
    state = latest === installed
      ? { status: 'current', installed, latest, version, message, date, detail: '' }
      : { status: 'behind', installed, latest, version, message, date, detail: '' }
    return state
  } catch (error) {
    state = { ...state, status: 'error', version, detail: String(error?.message ?? error).slice(0, 160) }
    return state
  }
}

/**
 * Запросить переустановку через штатный менеджер плагинов.
 *
 * Плагин при этом снимается, поэтому работа планируется после ответа: сначала
 * уходит HTTP-ответ, затем пакет удаляется и ставится заново.
 * @param ctx - контекст плагина.
 * @returns `{ started, reason }`.
 */
export function applyUpdate(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined) return { started: false, reason: 'менеджер плагинов недоступен' }
  if (scheduled) return { started: false, reason: 'обновление уже запущено' }
  if (state.status !== 'behind') return { started: false, reason: 'обновление не требуется' }

  scheduled = true
  setTimeout(() => {
    void (async () => {
      try {
        await manager.removeBundle(UPDATE_NAME)
        await manager.installBundle(UPDATE_SPEC, { enabled: true })
      } catch (error) {
        console.error('[dsh-sessions] self-update failed:', error?.message ?? error)
      }
    })()
  }, 150)

  return { started: true, reason: 'обновление запущено' }
}
