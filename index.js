/**
 * Host half of `dsh-sync`: проверка окружения, настройки и запуск синхронизации
 * из интерфейса DSH.
 *
 * Плагин работает поверх готового движка из `lib/` (тот же, что у CLI):
 * карточка в настройках читает состояние через `ctx.connection.fetch`,
 * сохраняет параметры в `~/.dsh/dsh-sync.json` и запускает `pull`/`push`.
 * Токены нигде не хранятся: git использует штатный credential helper.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLACEHOLDER, WEBDAV_SECRET, hasSecret, readSecret, writeSecret } from './lib/secrets.mjs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { readFile as readFileText } from 'node:fs/promises'

import { defaultConfig, loadConfig, saveConfig, canonicalCwd } from './lib/config.mjs'
import { encodeSegment, projectKey, samePath } from './lib/format.mjs'
import { collectDiagnostics } from './lib/diagnostics.mjs'
import { readHistory, localSkipStats, recordRun, removalDetails, subagentStats } from './lib/history.mjs'
import { readLedger, sessionState } from './lib/ledger.mjs'
import { probeYandex } from './lib/yandex.mjs'
import { probeWebdav } from './lib/webdav.mjs'
import { sameFolder } from './lib/folder.mjs'
import { backupProgress } from './lib/progress.mjs'
import { apply as applyDeletePlugin } from './delete/index.js'
import { matchProjectPath } from './lib/mirror-meta.mjs'
import { listLocalSessions, listMirrorSessions, localSessionDir, remapTo, sessionsOfProject, splitLog } from './lib/store.mjs'
import { canonicalRestoreId, chooseCanonical, findQuarantineProject, quarantineSupersededCopy, rankCandidates, resolveTombstoneIds, restoredFromOf } from './lib/deletions.mjs'
import { resolveSessionTitle, resolveTombstoneTitle } from './lib/titles.mjs'
import { collectDuplicateGroups, quarantineDuplicates, quarantineSessionCopies } from './lib/sync.mjs'
import {
  classifyBackendFailure,
  backendSupports,
  enqueueOutbox,
  flushOutbox,
  outboxSummary,
  unsupportedBackendMessage,
  OUTBOX_SHUTDOWN_TIMEOUT_MS,
} from './lib/outbox.mjs'
import { buildSessionGroups } from './lib/session-groups.mjs'
import { pullReplicated, pushReplicated, secondaryConfig } from './lib/replica.mjs'
import {
  initializeSecondaryChannel,
  readSecondaryState,
  readSecondaryStatus,
  resetSecondaryInitialization,
} from './lib/secondary-init.mjs'
import { applyUpdate, checkForUpdate, describeUpdate, updateState } from './lib/update.js'
import {
  MODE_LOCAL,
  applyWorkspaceDefaults,
  normalizeSessionId,
  readSessionModes,
  sessionBadge,
  sessionModeOf,
  setSessionMode,
  setWorkspaceDefaultMode,
  workspaceDefaultMode,
} from './lib/session-modes.mjs'
import { clearWorkspacePending, planWorkspace, readLocalWorkspaces, readWorkspacePending } from './lib/workspace.mjs'
import { applyPendingProfile, clearPendingBrowserSettings, discardProfilePlan, readJournal, readPendingBrowserSettings, readProfileStatus, refreshProfilePlan, writeBrowserSettings } from './lib/profile.mjs'
import { QUARANTINE_DAYS, listTombstones, readTombstones, restoreTombstones, writeTombstones } from './lib/tombstones.mjs'
import {
  cloudCopyPath,
  deleteCloudCopy,
  enforceLocalOnly,
  inspectCloudCopy,
  localOnlyMigrationCandidates,
  localOnlyState,
  makeSessionCloud,
  makeSessionLocal,
} from './lib/cloud-copy.mjs'
import { createRemote } from './lib/remote.mjs'
import { hasChanges } from './lib/git.mjs'

export const name = 'dsh-sync'
// sessionPersistence даёт список сессий с путями к логам: обходим каталог
// приходится только как запасной вариант.
export const inject = ['connection', 'tools', 'sessionPersistence', 'workspaceRegistry']

const STATE_PATH = '/api/dsh-sync/state'
const CONFIG_PATH = '/api/dsh-sync/config'
const RUN_PATH = '/api/dsh-sync/run'
// План «Проверить»: только чтение, ничего не меняет.
const PLAN_PATH = '/api/dsh-sync/plan'
// Подтверждённые удаления: единственный путь удаления из зеркала.
const PRUNE_PATH = '/api/dsh-sync/prune'
const CREATE_REPO_PATH = '/api/dsh-sync/create-repo'
const DIAG_PATH = '/api/dsh-sync/diagnostics'
const SESSIONS_PATH = '/api/dsh-sync/sessions'
const NOTIFICATIONS_PATH = '/api/dsh-sync/notifications'
const ACK_UPDATE_PATH = '/api/dsh-sync/ack-update'
const YANDEX_CHECK_PATH = '/api/dsh-sync/yandex-check'
const SESSION_MODE_PATH = '/api/dsh-sync/session-mode'
// Удаление только облачной копии локальной сессии (локальная остаётся).
const SESSION_CLOUD_COPY_PATH = '/api/dsh-sync/session-cloud-copy'
// «Убрать облачные копии локальных сессий»: миграция режима «локальная навсегда».
const LOCAL_ONLY_MIGRATION_PATH = '/api/dsh-sync/local-only-migration'
const PROFILE_PATH = '/api/dsh-sync/profile'
// «Сначала показать, потом применить»: отдельный маршрут применения плана.
const PROFILE_APPLY_PATH = '/api/dsh-sync/profile/apply'
const BROWSER_SETTINGS_PATH = '/api/dsh-sync/browser-settings'
const TOMBSTONES_PATH = '/api/dsh-sync/tombstones'
const RESTORE_PATH = '/api/dsh-sync/restore'
// «Найти дубли»: только чтение — группы копий одной сессии и канонические id.
const DUPLICATES_PATH = '/api/dsh-sync/duplicates'
// «Убрать дубли в карантин»: подтверждённое действие, канонические не трогаются.
const DUPLICATES_QUARANTINE_PATH = '/api/dsh-sync/duplicates/quarantine'
// Сверка резервного канала: сравнить локальное с облаком и разрешить выгрузку.
const SECONDARY_INIT_PATH = '/api/dsh-sync/secondary-init'

// --- уведомления -----------------------------------------------------------
// Кольцевой буфер: клиент забирает всё, что появилось после его курсора, и
// показывает всплывающие карточки. Так ошибки и обновления видно без захода
// в карточку плагина.
const NOTICE_LIMIT = 50
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
const notices = []
let noticeSeq = 0
let announcedVersion = null
const noticeDedupe = new Map()

/** Токен GitHub из хранилища DSH (или окружения) — для git и обновлений. */
async function resolveGitHubToken(ctx) {
  const fromEnv = (process.env.GITHUB_TOKEN ?? '').trim()
  if (fromEnv !== '') return fromEnv
  try {
    const credentials = ctx?.get?.('credentials')
    const hit = await credentials?.resolve?.('GITHUB_TOKEN')
    return typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : ''
  } catch {
    return ''
  }
}

function pushNotice(kind, text) {
  const key = `${kind}:${text}`
  const last = noticeDedupe.get(key) ?? 0
  if (Date.now() - last < 10 * 60_000) return
  noticeDedupe.set(key, Date.now())
  noticeSeq += 1
  notices.push({ id: noticeSeq, at: Date.now(), kind, text })
  if (notices.length > NOTICE_LIMIT) notices.shift()
}
const UPDATE_PATH = '/api/dsh-sync/update'
const UPDATE_APPLY_PATH = '/api/dsh-sync/update/apply'

/** Инструменты возвращают текст: DSH требует явное описание вывода. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const LAST_RUN_FILE = 'last-run.json'
const PLUGIN_STATUS_FILE = 'plugin-status.json'
const INSTALLED_VERSION_FILE = 'installed-version.json'
const PENDING_UPDATE_FILE = 'pending-update.json'

// Версия, с которой плагин обновился при этом запуске (для окна «что нового»).
let updatedFromVersion
let packageVersion

/** Состояние фоновой синхронизации (в памяти процесса). */
const automation = {
  enabled: false,
  running: false,
  flushing: false,
  lastPullAt: 0,
  lastPushAt: 0,
  lastTickAt: 0,
  lastError: '',
  fingerprint: '',
  lastPullOk: true,
  lastPushOk: true,
  timer: null,
}

/** Кеш сетевого опроса зеркала (ls-remote дорогой). */
const REMOTE_PROBE_TTL_MS = 60_000
let remoteProbe = null

/** Известные сторонние плагины синхронизации сессий (проверяются в профиле). */
const KNOWN_SYNC_PLUGINS = [
  'dsh-session-sync',
  '@perrylink/dsh-session-sync',
  'dsh-cloud-sync',
  'dsh-sessions-sync',
]

/** Имена сервисов, через которые сторонний плагин может отдавать API. */
const EXTERNAL_SERVICES = ['session-sync', 'dsh-session-sync', 'sessionSync']

function looksLikeSyncPackage(name) {
  const lower = String(name).toLowerCase()
  if (lower === 'dsh-sync') return false
  if (KNOWN_SYNC_PLUGINS.includes(lower)) return true
  return /(session|sessions)[-_]?sync/.test(lower) && !/^@deepseek-ai\//.test(lower)
}

function looksLikeSyncService(value) {
  return value !== null
    && typeof value === 'object'
    && (typeof value.push === 'function' || typeof value.pull === 'function' || typeof value.sync === 'function')
}

/**
 * Найти установленный сторонний плагин синхронизации.
 *
 * Сначала ищем живой сервис в cordis (тогда синхронизацию можно провести через
 * него), затем — запись в профиле: установлен ли пакет и задан ли у него
 * репозиторий. Код стороннего плагина не вызывается, если он не опубликовал
 * сервис с методами pull/push/sync.
 */
async function discoverExternal(ctx) {
  for (const name of EXTERNAL_SERVICES) {
    let service
    try {
      service = ctx?.get?.(name)
    } catch {
      service = undefined
    }
    if (looksLikeSyncService(service)) {
      return {
        found: true,
        callable: true,
        name,
        source: 'service',
        configured: true,
        methods: ['push', 'pull', 'sync'].filter(method => typeof service[method] === 'function'),
        service,
      }
    }
  }

  const profilesRoot = join(dshHome(), 'profiles')
  let profiles = []
  try {
    profiles = await (await import('node:fs/promises')).readdir(profilesRoot, { withFileTypes: true })
  } catch {
    profiles = []
  }

  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const dir = join(profilesRoot, entry.name)
    let manifest
    try {
      manifest = JSON.parse(await readFileText(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const dependencies = Object.keys(manifest?.dependencies ?? {})
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    const installed = [...new Set([...dependencies, ...bundles])]
      .filter(packageName => looksLikeSyncPackage(packageName))

    for (const name of installed) {
      let configured = false
      try {
        const patch = await readFileText(join(dir, 'cordis.patch.yml'), 'utf8')
        const block = patch.split(/\n(?=- insert:)/).find(part => part.includes(name))
        configured = block !== undefined && /\n\s+remote:\s*\S+/.test(block)
      } catch {
        configured = false
      }
      return { found: true, callable: false, name, source: `profile:${entry.name}`, configured, methods: [] }
    }
  }

  return { found: false, callable: false, name: null, source: null, configured: false, methods: [] }
}

/** DSH home: та же папка, что использует CLI. */
function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') return process.env.DSH_HOME.trim()
  return join(homedir(), '.dsh')
}

/**
 * Запуск команды с захватом вывода через временные файлы: так одинаково
 * работает и в обычном процессе, и под ограничениями, где нельзя открыть pipe.
 */
async function runCapture(command, args, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-env-'))
  const outPath = join(dir, 'out')
  const errPath = join(dir, 'err')
  const out = await open(outPath, 'w')
  const err = await open(errPath, 'w')
  try {
    const code = await new Promise((resolvePromise) => {
      const child = spawn(command, args, {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env },
        stdio: ['ignore', out.fd, err.fd],
        windowsHide: true,
        shell: false,
      })
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            try {
              child.kill()
            } catch {
              // уже завершился
            }
            resolvePromise({ code: -2, message: 'timeout' })
          }, options.timeoutMs)
      child.on('error', (error) => {
        if (timer !== undefined) clearTimeout(timer)
        resolvePromise({ code: -1, message: String(error.message) })
      })
      child.on('close', (exitCode) => {
        if (timer !== undefined) clearTimeout(timer)
        resolvePromise({ code: exitCode })
      })
    })
    const [stdout, stderr] = await Promise.all([readFileText(outPath, 'utf8'), readFileText(errPath, 'utf8')])
    return { code: code.code, stdout, stderr: code.message ?? stderr }
  } finally {
    await out.close().catch(() => {})
    await err.close().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Проверка окружения: node, git, remote, путь проекта. */
async function checkEnvironment(config) {
  const checks = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const nodeMinor = Number(process.versions.node.split('.')[1] ?? 0)
  checks.push({
    id: 'node',
    title: 'Node.js',
    ok: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 15),
    detail: `v${process.versions.node}`,
    hint: 'Нужен Node.js 22.15 или новее. В DSH уже есть встроенный рантайм — обновите приложение.',
  })

  const gitVersion = await runCapture('git', ['--version'])
  const gitOk = gitVersion.code === 0
  checks.push({
    id: 'git',
    title: 'git',
    ok: gitOk,
    detail: gitOk ? gitVersion.stdout.trim().replace(/^git version\s*/, '') : 'не найден',
    hint: 'Установите Git for Windows (git-scm.com) — без него зеркало не обновить.',
  })

  const projectPath = config?.projects?.[Object.keys(config?.projects ?? {})[0]]?.path
  const projectOk = typeof projectPath === 'string' && projectPath.length > 0 && existsSync(projectPath)
  checks.push({
    id: 'project',
    title: 'Папка проекта',
    ok: projectOk,
    detail: projectPath ?? 'не указана',
    hint: 'Укажите путь к проекту ниже — папка должна существовать.',
  })

  // Для папки облака проверяем саму папку: git и сеть не нужны вовсе.
  if (config?.backend === 'yandex') {
    const token = (config.yandexToken ?? process.env.YANDEX_DISK_TOKEN ?? '').trim()
    checks.push({
      id: 'remote',
      title: 'Яндекс.Диск (API)',
      ok: token.length > 0,
      detail: token.length > 0 ? `папка /${config.yandexPath ?? 'dsh-sync'}` : 'токен не задан',
      hint: 'Вставьте OAuth-токен с доступом к Диску — инструкция в README плагина.',
    })
    return checks
  }

  if (config?.backend === 'webdav') {
    const login = (config.webdavLogin ?? '').trim()
    const pass = (config.webdavPassword ?? '').trim()
    const ready = login !== '' && pass !== ''
    checks.push({
      id: 'remote',
      title: 'Яндекс.Диск (WebDAV)',
      ok: ready,
      detail: ready ? `папка /${config.webdavPath ?? 'dsh-sync'}` : 'не заданы логин или пароль приложения',
      hint: 'Пароль приложения создаётся на id.yandex.ru → Безопасность → Пароли приложений (тип «Файлы»).',
    })
    return checks
  }

  if (config?.backend === 'folder') {
    const folder = config.repoDir ?? ''
    let ok = false
    let detail = 'не задана'
    if (folder !== '') {
      try {
        const info = await stat(folder)
        ok = info.isDirectory()
        detail = ok ? 'папка доступна' : 'это не папка'
      } catch {
        detail = 'папки нет'
      }
    }
    checks.push({
      id: 'remote',
      title: 'Папка облачного диска',
      ok,
      detail,
      hint: 'Укажите папку, которую синхронизирует Яндекс.Диск (обычно C:\\Users\\вы\\YandexDisk\\dsh-sync).',
    })
    return checks
  }

  const remote = config?.remote ?? ''
  if (remote.length > 0 && gitOk) {
    // Сетевой опрос кешируем: карточка перерисовывается часто, а ls-remote
    // занимает секунды.
    const cached = remoteProbe
    const fresh = cached !== null && cached.remote === remote && Date.now() - cached.at < REMOTE_PROBE_TTL_MS
    const reachable = fresh ? cached.ok : (await runCapture('git', ['ls-remote', '--heads', remote])).code === 0
    if (!fresh) remoteProbe = { remote, at: Date.now(), ok: reachable }
    checks.push({
      id: 'remote',
      title: 'Репозиторий зеркала',
      ok: reachable,
      detail: reachable ? 'доступен' : 'нет доступа',
      hint: 'Проверьте адрес и войдите в GitHub один раз в терминале: git ls-remote <адрес>',
    })
  } else {
    checks.push({
      id: 'remote',
      title: 'Репозиторий зеркала',
      ok: false,
      detail: remote.length === 0 ? 'не задан' : 'проверка недоступна без git',
      hint: 'Укажите https-адрес приватного репозитория для сессий.',
    })
  }

  return checks
}

/** Текущее состояние: окружение, настройки, счётчики и последний запуск. */
async function readState(ctx) {
  const home = dshHome()
  let config
  try {
    config = await loadConfig(home)
  } catch (error) {
    return {
      ok: false,
      message: `Не удалось прочитать конфигурацию: ${error instanceof Error ? error.message : String(error)}`,
      checks: [],
      config: null,
      status: null,
    }
  }

  const projectEntries = Object.entries(config.projects ?? {})
  const [projectId, project] = projectEntries[0] ?? [undefined, undefined]
  const checks = await checkEnvironment(config)

  let local = 0
  let mirror = 0
  let onlyLocal = 0
  let onlyMirror = 0
  let subagents = 0
  let subagentsAvailable = 0
  let scanned = 0
  let scanError = ''
  const cwds = new Set()

  const located = await localSessionsFor(ctx, home, project?.path ?? '')
  scanned = located.total
  scanError = located.error
  for (const session of located.sessions) cwds.add(session.cwd)

  try {
    const mine = located.sessions
    local = mine.length
    if (projectId && existsSync(config.repoDir)) {
      const mirrored = await listMirrorSessions(config.repoDir, projectId)
      mirror = mirrored.length
      const localIds = new Set(mine.map(session => session.id))
      const mirrorIds = new Set(mirrored.map(session => session.id))
      onlyLocal = mine.filter(session => !mirrorIds.has(session.id)).length
      onlyMirror = mirrored.filter(session => !localIds.has(session.id)).length
      // Субагенты: сессии с родителем в заголовке. «Доступны» — те, что уже
      // лежат локально.
      subagents = 0
      subagentsAvailable = 0
      for (const item of mirrored) {
        let parent
        try {
          parent = splitLog(item.bytes).header.parentSession
        } catch {
          parent = undefined
        }
        if (typeof parent === 'string' && parent !== '') {
          subagents += 1
          if (localIds.has(item.id)) subagentsAvailable += 1
        }
      }
    }
  } catch {
    // счётчики — вспомогательная информация, карточка работает и без них
  }

  let lastRun = null
  try {
    lastRun = JSON.parse(await readFile(join(home, 'dsh-sync', LAST_RUN_FILE), 'utf8'))
  } catch {
    lastRun = null
  }
  const history = await readHistory(home, 5)

  const external = await discoverExternal(ctx)
  // Итог пишем в журнал: при сбое видно, что и когда запускалось.
  const preferExternal = config.useExternal !== false
  const mode = external.found && external.callable && preferExternal ? 'external' : 'builtin'

  const pendingUpdate = await readPendingUpdate()
  const backup = await readBackupProgress(config)
  const backupStatus = await readSecondaryStatus(home)
  const secondaryState = await readSecondaryState(home)
  // H6: очередь невыполненных операций — счётчик «в очереди: N» для панели.
  const outbox = await outboxSummary(home)
  const currentFingerprint = await computeFingerprint(ctx)
  const pending = automation.fingerprint !== '' && currentFingerprint !== '' && currentFingerprint !== automation.fingerprint

  // Подсказка для папки облака: ищем установленный клиент Яндекс.Диска.
  const suggestedFolder = (() => {
    const names = ['YandexDisk', 'Яндекс.Диск', 'Yandex.Disk', 'OneDrive']
    for (const name of names) {
      const candidate = join(homedir(), name)
      if (existsSync(candidate)) return join(candidate, 'dsh-sync')
    }
    return ''
  })()
  // Резерв по умолчанию — отдельная папка рядом с основным зеркалом облака.
  const suggestedSecondaryFolder = (() => {
    if (suggestedFolder === '') return ''
    const parent = suggestedFolder.replace(/[\\/]dsh-sync$/, '')
    return parent === suggestedFolder ? '' : join(parent, 'dsh-sync-backup')
  })()

  // Диагностика расхождения счётчиков: если локальных сессий не видно, а в
  // зеркале они есть, сохраняем, что именно просканировано.
  if (local === 0 && mirror > 0) {
    void writeStatus({ debug: { home, sessionsScanned: scanned, cwds: [...cwds], projectPath: project?.path ?? '' } })
  }

  // Профильный слой и рабочие пространства: краткая сводка для панели.
  let profile = null
  let workspace = null
  try {
    profile = await profileStatus(ctx)
    workspace = profile.workspace
  } catch (error) {
    profile = { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  let modes = { local: 0, cloud: 0 }
  try {
    // Новые сессии получают умолчание своего рабочего пространства и здесь:
    // иначе сводка «локальных/облачных» отставала бы от списка сессий.
    const sessionModes = (await applyWorkspaceDefaults(home)).modes
    // Явные записи теперь бывают и 'cloud': локальными считаем только 'local'.
    const localModes = Object.values(sessionModes.sessions).filter(mode => mode === MODE_LOCAL).length
    modes = { local: localModes, cloud: Math.max(0, local - localModes) }
  } catch {
    // режимы — вспомогательные данные
  }

  return {
    ok: true,
    deviceId: config.deviceId,
    mode,
    preferExternal,
    external: {
      found: external.found,
      callable: external.callable,
      name: external.name,
      source: external.source,
      configured: external.configured,
      methods: external.methods,
    },
    config: {
      remote: config.remote ?? '',
      backend: config.backend ?? 'git',
      branch: config.branch ?? 'main',
      repoDir: config.repoDir,
      attachments: config.attachments === true,
      useExternal: config.useExternal !== false,
      // Автоочистка зеркала: по умолчанию выключена, удаления — только по
      // подтверждённой кнопке «Применить удаления».
      sync: { autoPrune: config.sync?.autoPrune === true },
      profile: config.profile ?? { enabled: true },
      workspace: config.workspace ?? { enabled: true },
      projectId: projectId ?? '',
      projectPath: project?.path ?? '',
      // Резерв без секретов: пароль приложения в браузер не отдаём.
      secondary: config.secondary === undefined || config.secondary === null
        ? undefined
        : {
            backend: config.secondary.backend ?? 'none',
            folderDir: config.secondary.folderDir ?? '',
            webdavLogin: config.secondary.webdavLogin ?? '',
            webdavPath: config.secondary.webdavPath ?? '',
            remote: config.secondary.remote ?? '',
          },
    },
    checks,
    ready: checks.every(check => check.ok),
    status: { local, mirror, onlyLocal, onlyMirror, subagents, subagentsAvailable },
    modes,
    profile,
    workspace,
    suggestedFolder,
    version: packageVersion,
    updatedFrom: pendingUpdate?.to === packageVersion ? pendingUpdate.from : updatedFromVersion,
    backup,
    backupStatus,
    // Очередь операций: count — «в очереди: N», pending — последние ошибки.
    outbox,
    outboxCount: outbox.count,
    suggestedSecondaryFolder,
    // Резервный канал: выбранный бэкенд, статус сверки и последней выгрузки.
    secondary: {
      enabled: config?.secondary !== undefined && config?.secondary !== null && config?.secondary.enabled !== false,
      backend: config?.secondary?.backend ?? 'none',
      folderDir: config?.secondary?.folderDir ?? '',
      webdavPath: config?.secondary?.webdavPath ?? '',
      recommended: 'folder',
      initialized: secondaryState?.initialized === true,
      compare: secondaryState?.plan ?? null,
      initializedAt: secondaryState?.at,
      pulled: secondaryState?.pulled ?? null,
      lastPushAt: secondaryState?.lastPushAt ?? null,
      lastPushOk: secondaryState?.lastPushOk,
      lastPushUploaded: secondaryState?.lastPushUploaded ?? 0,
      lastPushMessage: secondaryState?.lastPushMessage ?? '',
      status: backupStatus,
    },
    // Тип резервного хранилища без секретов: по нему карточка подписывает полосу.
    secondaryBackend: config?.secondary?.backend ?? 'none',
    // Пароль в настройках не хранится: карточка показывает только факт.
    secondaryPasswordStored: await hasSecret(ctx),
    pending,
    history,
    automation: {
      enabled: automation.enabled,
      running: automation.running,
      lastPullAt: automation.lastPullAt === 0 ? null : new Date(automation.lastPullAt).toISOString(),
      lastPushAt: automation.lastPushAt === 0 ? null : new Date(automation.lastPushAt).toISOString(),
      lastError: automation.lastError,
      settings: config.autoSync ?? {},
    },
    debug: { home, sessionsScanned: scanned, cwds: [...cwds], projectPath: project?.path ?? '', scanError, source: located.source },
    lastRun,
  }
}

/**
 * Сессии проекта так, как их видит сам DSH: через `sessionPersistence`, который
 * отдаёт и заголовок, и путь к логу. Обход каталога — запасной путь: в
 * host-процессе `readdir` может быть недоступен, а чтение известного файла — нет.
 */
async function localSessionsFor(ctx, home, projectPath) {
  const persistence = ctx?.get?.('sessionPersistence')
  if (persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list()
      const sessions = []
      let total = 0
      for (const snapshot of snapshots ?? []) {
        const header = snapshot?.header
        const path = snapshot?.location?.path
        if (header === null || header === undefined || typeof header.id !== 'string' || typeof header.cwd !== 'string') continue
        total += 1
        if (typeof path !== 'string') continue
        if (projectPath === '' || !samePath(header.cwd, projectPath)) continue
        sessions.push({
          id: header.id,
          cwd: header.cwd,
          path,
          parent: header.parentSession ?? '',
          // Заголовок сессии может прийти от презентационного слоя DSH; если
          // его нет, панель покажет короткий идентификатор.
          title: typeof snapshot.title === 'string'
            ? snapshot.title
            : typeof snapshot.displayTitle === 'string'
              ? snapshot.displayTitle
              : '',
        })
      }
      return { sessions, total, source: 'persistence', error: '' }
    } catch (error) {
      // падаем в следующий источник
    }
  }

  // Второй источник: реестр workspace — он знает id сессий каждого проекта,
  // а путь к логу вычисляется из id без чтения каталога.
  const registry = ctx?.get?.('workspaceRegistry')
  if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
    try {
      const sessions = []
      for (const workspace of registry.list() ?? []) {
        const workspacePath = workspace?.path ?? workspace?.record?.path
        if (typeof workspacePath !== 'string' || (projectPath !== '' && !samePath(workspacePath, projectPath))) continue
        for (const id of workspace?.sessionIds ?? []) {
          if (typeof id !== 'string') continue
          sessions.push({
            id,
            cwd: workspacePath,
            path: join(home, 'sessions', projectKey(workspacePath), encodeSegment(id), 'session.v4.jsonl.zstd'),
          })
        }
      }
      if (sessions.length > 0) return { sessions, total: sessions.length, source: 'registry', error: '' }
    } catch {
      // падаем в файловый обход
    }
  }

  {
    const fsSessions = await listLocalSessions(home).catch(() => [])
    return {
      sessions: projectPath === '' ? fsSessions : sessionsOfProject(fsSessions, projectPath),
      total: fsSessions.length,
      source: 'fs',
      error: '',
    }
  }
}

/** Сохранить параметры, введённые в карточке. */
async function saveSettings(ctx, payload) {
  const home = dshHome()
  const config = existsSync(join(home, 'dsh-sync.json'))
    ? await loadConfig(home)
    : { ...defaultConfig(home) }
  // Настройки резерва менялись? Тогда сверка с облаком снова обязательна.
  const previousSecondaryJson = JSON.stringify(config.secondary ?? null)

  // Перед изменением сохраняем копию: настройки содержат адреса и пароли
  // приложений, и случайная перезапись не должна их терять.
  try {
    if (existsSync(join(home, 'dsh-sync.json'))) {
      await writeFile(join(home, 'dsh-sync.json.bak-last'), await readFile(join(home, 'dsh-sync.json'), 'utf8'), 'utf8')
    }
  } catch {
    // копия — страховка, не критично
  }

  const remote = typeof payload.remote === 'string' ? payload.remote.trim() : config.remote
  const folder = typeof payload.repoDir === 'string' ? payload.repoDir.trim() : config.repoDir
  const projectIdRaw = typeof payload.projectId === 'string' ? payload.projectId.trim() : ''
  const projectPath = typeof payload.projectPath === 'string' ? payload.projectPath.trim() : ''
  const projectId = (projectIdRaw || 'default').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  config.backend = ['folder', 'yandex', 'webdav'].includes(payload.backend) ? payload.backend : 'git'
  if (config.backend === 'folder') {
    if (folder !== '') config.repoDir = folder
  } else if (config.backend === 'yandex') {
    // Для API-бэкенда локальный каталог — это кеш, а не git-зеркало.
    const cacheDefault = join(home, 'dsh-sync', 'yandex-cache')
    config.repoDir = folder !== '' && folder !== join(home, 'dsh-sync', 'repo') ? folder : cacheDefault
    const token = typeof payload.yandexToken === 'string' ? payload.yandexToken.trim() : ''
    if (token !== '') config.yandexToken = token
    const yandexPath = typeof payload.yandexPath === 'string' ? payload.yandexPath.trim() : ''
    if (yandexPath !== '') config.yandexPath = yandexPath
  } else if (config.backend === 'webdav') {
    const cacheDefault = join(home, 'dsh-sync', 'webdav-cache')
    config.repoDir = folder !== '' && folder !== join(home, 'dsh-sync', 'repo') ? folder : cacheDefault
    const login = typeof payload.webdavLogin === 'string' ? payload.webdavLogin.trim() : ''
    if (login !== '') config.webdavLogin = login
    const pass = typeof payload.webdavPassword === 'string' ? payload.webdavPassword.trim() : ''
    if (pass !== '' && pass !== PLACEHOLDER) {
      // Пароль в файл не пишем: только в хранилище секретов профиля.
      const saved = await writeSecret(ctx, pass)
      if (saved) delete config.webdavPassword
      else config.webdavPassword = pass
    } else {
      delete config.webdavPassword
    }
    config.webdavPasswordStored = await hasSecret(ctx)
    const wpath = typeof payload.webdavPath === 'string' ? payload.webdavPath.trim() : ''
    if (wpath !== '') config.webdavPath = wpath
  } else if (remote !== '') {
    config.remote = remote
  }
  config.attachments = payload.attachments === true
  config.autoUpdate = payload.autoUpdate === true
  // Удаления из зеркала выполняются только подтверждённым действием
  // «Применить удаления»; автоочистка (sync.autoPrune) по умолчанию выключена
  // и push её не использует.
  config.sync = { ...(config.sync ?? {}), autoPrune: typeof payload.autoPrune === 'boolean' ? payload.autoPrune : config.sync?.autoPrune === true }

  // Резервное хранилище: туда дублируются сессии (без вложений).
  if (typeof payload.secondaryBackend === 'string' && payload.secondaryBackend !== '') {
    const kind = payload.secondaryBackend.trim()
    if (kind === '' || kind === 'none') {
      delete config.secondary
    } else if (['git', 'folder', 'yandex', 'webdav'].includes(kind)) {
      const previous = config.secondary
      // При смене типа резерва кеш начинается заново: старые файлы чужого
      // бэкенда в новом кеше только мешают прогрессу.
      const switching = previous?.backend !== kind
      const repoDir = switching || typeof previous?.repoDir !== 'string' || previous.repoDir === ''
        ? join(home, 'dsh-sync', `replica-${kind}`)
        : previous.repoDir
      const secondary = { enabled: true, backend: kind, repoDir }
      if (kind === 'git') {
        secondary.remote = typeof payload.secondaryRemote === 'string' ? payload.secondaryRemote.trim() : previous?.remote
      }
      if (kind === 'folder') {
        // Папка облачного клиента: рекомендуемый резерв «из коробки»
        // (OneDrive, Яндекс.Диск, Syncthing). Путь обязателен и полный.
        const requested = typeof payload.secondaryFolder === 'string' ? payload.secondaryFolder.trim() : ''
        const folderDir = requested !== '' ? requested : (previous?.folderDir ?? '')
        if (folderDir === '') {
          throw new Error('Укажите папку облака для резервного канала — в неё будет дублироваться зеркало.')
        }
        if (!isAbsolute(folderDir)) {
          throw new Error('Папка облака должна быть указана полным путём, например C:\\Users\\me\\OneDrive\\dsh-sync-backup.')
        }
        if (sameFolder(folderDir, config.repoDir)) {
          throw new Error('Папка резерва совпадает с основным хранилищем — выберите отдельную папку.')
        }
        if (sameFolder(folderDir, repoDir)) {
          // Папка облака = кеш: локальную копию выносим в служебный каталог.
          secondary.repoDir = join(home, 'dsh-sync', `replica-${kind}`)
        }
        // Сменилась папка облака — нужен новый кеш: иначе старые файлы другого
        // облака смешаются с новыми и сверка покажет ложные расхождения.
        if (previous?.backend === 'folder' && (previous.folderDir ?? '') !== folderDir) {
          const digest = createHash('sha256').update(folderDir.toLowerCase()).digest('hex').slice(0, 8)
          secondary.repoDir = join(home, 'dsh-sync', `replica-folder-${digest}`)
        }
        secondary.folderDir = folderDir
      }
      if (kind === 'webdav') {
        const login = typeof payload.secondaryLogin === 'string' ? payload.secondaryLogin.trim() : ''
        const password = typeof payload.secondaryPassword === 'string' ? payload.secondaryPassword.trim() : ''
        if (login !== '') secondary.webdavLogin = login
        else if (previous?.webdavLogin) secondary.webdavLogin = previous.webdavLogin
        if (password !== '' && password !== PLACEHOLDER) {
          const saved = await writeSecret(ctx, password)
          if (saved === false) secondary.webdavPassword = password
          secondary.passwordStored = saved
        } else {
          secondary.passwordStored = await hasSecret(ctx)
        }
        if (previous?.webdavPassword !== undefined && secondary.webdavPassword === undefined) {
          // Старое значение из файла переносим в хранилище и убираем из файла.
          const savedOld = await writeSecret(ctx, previous.webdavPassword)
          if (savedOld) secondary.passwordStored = true
          else secondary.webdavPassword = previous.webdavPassword
        }
        secondary.webdavPath = typeof payload.secondaryPath === 'string' && payload.secondaryPath.trim() !== ''
          ? payload.secondaryPath.trim()
          : previous?.webdavPath ?? 'dsh-sync'
      }
      config.secondary = secondary
    }
  }
  if (typeof payload.useExternal === 'boolean') config.useExternal = payload.useExternal
  // Профильный слой: авто-применение по умолчанию выключено (ручной режим).
  if (typeof payload.autoApplyProfile === 'boolean') {
    config.profile = { ...(config.profile ?? { enabled: true }), enabled: true, autoApply: payload.autoApplyProfile }
  }
  config.projects = { [projectId]: { path: projectPath, title: projectId } }
  await saveConfig(home, config)
  // Резерв настроен заново или изменён — старый отчёт сверки больше не
  // относится к делу: push в резерв снова требует «Сверить».
  if (JSON.stringify(config.secondary ?? null) !== previousSecondaryJson) {
    await resetSecondaryInitialization(home, 'настройки резервного канала изменились')
  }
  return readState(ctx)
}

/** Node с рабочим zstd: host-процесс DSH может быть собран иначе. */
let cachedNode

async function resolveNodeWithZstd() {
  if (cachedNode !== undefined) return cachedNode
  const probeCode = "process.exit(typeof require('node:zlib').zstdDecompressSync==='function'?0:1)"
  const candidates = []

  if (process.env.DSH_SYNC_NODE) candidates.push({ path: process.env.DSH_SYNC_NODE, env: {} })

  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources.length > 0) {
    candidates.push({ path: join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'), env: {} })
    candidates.push({ path: join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node'), env: {} })
  }

  // Запасной путь к встроенному рантайму, если resourcesPath недоступен.
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    candidates.push({
      path: join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
      env: {},
    })
  }

  candidates.push({ path: 'node', env: {} })
  // Electron в режиме Node: свой исполняемый файл запускается как Node.
  candidates.push({ path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })

  for (const candidate of candidates) {
    const probe = await runCapture(candidate.path, ['-e', probeCode], { env: candidate.env, timeoutMs: 15_000 })
    if (probe.code === 0) {
      cachedNode = candidate
      return candidate
    }
  }
  cachedNode = null
  return null
}

/**
 * Выполнить синхронизацию в отдельном процессе на штатном Node: там доступны и
 * полный файловый обход, и zstd. Возвращает undefined, если подходящего Node нет.
 * extraEnv дополняет окружение дочернего процесса (токен GitHub и т. п.);
 * options.confirmPrune — прежний признак подтверждения (совместимость);
 * options.ids — сузить подтверждённые удаления списком из плана;
 * options.record=false — не писать last-run и уведомления (для плана: он
 * только читает).
 */
async function runViaChild(action, extraEnv = {}, options = {}) {
  const node = await resolveNodeWithZstd()
  if (node === null) return undefined
  const childPath = fileURLToPath(new URL('./lib/sync-child.mjs', import.meta.url))
  const args = [childPath, action]
  if (options?.confirmPrune === true) args.push('--confirm-prune')
  // Версия DSH читается из app.asar только в host-процессе: дочернему Node
  // она передаётся через окружение, чтобы сверка версий работала и там.
  const versionEnv = { ...(extraEnv ?? {}) }
  const dshVersion = await hostDshVersion()
  if (dshVersion !== undefined) versionEnv.DSH_SYNC_DSH_VERSION = dshVersion
  if (Array.isArray(options?.ids) && options.ids.length > 0) {
    versionEnv.DSH_SYNC_PRUNE_IDS = JSON.stringify(options.ids)
  }

  const started = Date.now()
  const result = await runCapture(node.path, args, { env: { ...node.env, ...versionEnv }, timeoutMs: 600_000 })
  const line = result.stdout.trim().split('\n').filter(part => part.trim().startsWith('{')).pop()

  let parsed
  try {
    parsed = line === undefined ? undefined : JSON.parse(line)
  } catch {
    parsed = undefined
  }

  const record = parsed === undefined
    ? {
        ok: false,
        at: new Date().toISOString(),
        action,
        mode: 'child',
        message: `дочерний процесс не ответил (код ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
        durationMs: Date.now() - started,
      }
    : { ...parsed, at: new Date().toISOString(), nodePath: node.path, durationMs: parsed.durationMs ?? Date.now() - started }

  if (options?.record === false) return record
  await writeLastRun(record)
  if (record.ok !== true) {
    pushNotice('error', `Синхронизация не удалась: ${record.message}`)
  } else {
    if ((record.pull?.imported ?? 0) > 0) {
      pushNotice('sync', `Принято новых сессий: ${record.pull.imported}. Откройте DSH заново, чтобы увидеть их в списке.`)
    }
    if ((record.prune?.removed ?? 0) > 0) {
      pushNotice('sync', `Удалено в карантин: ${record.prune.removed}. Вернуть можно в карточке «Удалённые».`)
    }
  }
  return record
}

/**
 * Что умеет резервный backend. `secondary-init`/`webdav` обещают единый
 * интерфейс, но старые конфигурации могут указать backend без метода: тогда
 * операцию не вызываем вслепую (H5), а объясняем и ставим в очередь (H6).
 */
const SECONDARY_BACKEND_METHODS = {
  folder: ['list', 'sync', 'commit'],
  git: ['sync', 'commit'],
  webdav: ['list', 'sync', 'commit', 'remove'],
  yandex: ['list', 'sync', 'commit'],
}

function secondaryOperationSupported(config, operation) {
  const secondary = config?.secondary
  if (secondary === undefined || secondary === null || secondary.enabled === false) return { ok: true }
  const backend = typeof secondary.backend === 'string' ? secondary.backend : ''
  const methods = SECONDARY_BACKEND_METHODS[backend]
  if (methods === undefined) {
    return { ok: false, message: unsupportedBackendMessage(operation, `резерв «${backend || 'не задан'}»`) }
  }
  if (!methods.includes(operation)) {
    return { ok: false, message: unsupportedBackendMessage(operation, `резерв «${backend}»`) }
  }
  return { ok: true }
}

/** Положить неудачную операцию в очередь, не ломая основной сценарий. */
async function queueFailedOperation(home, { type, payload, error = '', errorKind = '' }) {
  try {
    const result = await enqueueOutbox(home, { type, payload, error, errorKind })
    return result.count > 0
  } catch {
    return false
  }
}

/**
 * Предварительная проверка бэкенда перед вызовом методов единого интерфейса.
 * Возвращает понятное сообщение вместо сырого TypeError (H5).
 */
function backendGuard(backend, operation, kind = 'хранилище') {
  if (backendSupports(backend, operation)) return { ok: true }
  return { ok: false, code: 'reserve/unsupported', message: unsupportedBackendMessage(operation, kind) }
}

/** Короткое имя backend для сообщений. */
function backendLabel(backend, config) {
  const kind = typeof backend?.kind === 'string' && backend.kind !== '' ? backend.kind : (config?.backend ?? '')
  return kind === '' ? 'хранилище' : `хранилище «${kind}»`
}

/** Запустить синхронизацию: pull → push (или что-то одно). */
/**
 * Подставить пароль WebDAV из хранилища секретов.
 *
 * В файле настроек пароля больше нет — он приходит из хранилища. Дочерние
 * процессы получают его через переменную окружения, поэтому на диск секрет
 * не попадает.
 */
/**
 * Один раз перенести пароль из файла настроек в хранилище секретов.
 *
 * Нужно для профилей, где пароль ещё лежит открытым текстом: после переноса
 * файл перезаписывается без него.
 */
async function migrateSecret(ctx) {
  try {
    const home = dshHome()
    const configPath = join(home, 'dsh-sync.json')
    if (!existsSync(configPath)) return
    const config = await loadConfig(home)
    const values = [config.webdavPassword, config.secondary?.webdavPassword]
      .filter((value) => typeof value === 'string' && value !== '')
    if (values.length === 0) return
    for (const value of values) {
      if ((await writeSecret(ctx, value)) === false) return
    }
    if (config.webdavPassword !== undefined) {
      delete config.webdavPassword
      config.webdavPasswordStored = true
    }
    if (config.secondary?.webdavPassword !== undefined) {
      const { webdavPassword, ...rest } = config.secondary
      config.secondary = { ...rest, passwordStored: true }
    }
    await saveConfig(home, config)
    console.log('[dsh-sync] пароль перенесён в хранилище секретов')
  } catch (error) {
    console.warn('[dsh-sync] не удалось перенести пароль:', error)
  }
}

async function applySecret(ctx, config) {
  const stored = await readSecret(ctx)
  if (stored === undefined) return config
  try {
    process.env.DSH_SYNC_WEBDAV_PASSWORD = stored
  } catch {
    // окружение менять нельзя — останется только конфиг в памяти
  }
  if (config.secondary !== undefined) {
    config.secondary = { ...config.secondary, webdavPassword: stored }
  }
  if (config.backend === 'webdav') config.webdavPassword = stored
  return config
}


/** Записать событие в общий журнал плагина. */
async function appendLog(kind, ok, text) {
  try {
    const dir = join(dshHome(), 'dsh-sessions')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), plugin: 'dsh-sessions', kind, ok, text }) + '\n', 'utf8')
  } catch {
    // журнал необязателен
  }
}

async function runSync(ctx, action, options = {}) {
  const home = dshHome()
  const confirmPrune = options?.confirmPrune === true
  const config = await applySecret(ctx, await loadConfig(home))
  const githubToken = await resolveGitHubToken(ctx)
  if (githubToken !== '') process.env.GITHUB_TOKEN = githubToken
  const projectEntries = Object.keys(config.projects ?? {})
  if (projectEntries.length === 0) {
    return { ok: false, message: 'Сначала укажите проект в настройках плагина.' }
  }

  const external = await discoverExternal(ctx)
  void appendLog('sync-start', true, `запуск: ${action}`)
  if (external.found && external.callable && config.useExternal !== false) {
    return runViaExternal(external, action)
  }

  // Основной путь — отдельный процесс: в host-процессе DSH файловый обход и
  // разбор логов могут вести себя иначе, чем в обычном Node.
  // До запуска публикуем объявления «локальная навсегда»: дочерний процесс
  // прочитает их из зеркала, а режимы уже стоят локальными — push/pull такие
  // сессии пропускают.
  await prepareLocalOnlyState(home, config)
  const viaChild = await runViaChild(action, githubToken === '' ? {} : { GITHUB_TOKEN: githubToken }, { confirmPrune })
  if (viaChild !== undefined) {
    // Приём выполняет дочерний процесс, а привязать новые сессии к рабочему
    // пространству может только host-часть: у неё есть реестр.
    if (action !== 'push' && viaChild.ok === true) {
      try {
        const attached = await attachAllProjects(ctx, config)
        if (attached > 0) {
          viaChild.message = `${viaChild.message}; привязано к рабочему пространству: ${attached}`
          // H10: запуск уже записан дочерним путём — обновляем только last-run,
          // журнал дублями не засоряем.
          await updateLastRun({ ...viaChild })
        }
        const queued = await applyWorkspacePending(ctx, config)
        if (queued > 0) {
          viaChild.message = `${viaChild.message}; привязано из зеркала: ${queued}`
          await updateLastRun({ ...viaChild })
        }
        const deletedIds = viaChild.pull?.deletedIds ?? []
        if (deletedIds.length > 0) {
          const detached = await detachSessions(ctx, deletedIds)
          viaChild.message = `${viaChild.message}; убрано из пространств: ${detached}`
          await updateLastRun({ ...viaChild })
        }
      } catch {
        // привязка — вспомогательный шаг, синхронизация уже прошла
      }
    }
    invalidateSessionStates()
    if (viaChild.ok !== true && action !== 'pull') {
      // H6: неудачная отправка не теряется — ждёт в очереди и повторится.
      await queueFailedOperation(home, {
        type: 'push',
        payload: { action: action === 'push' ? 'push' : 'sync' },
        error: typeof viaChild.message === 'string' ? viaChild.message : '',
        errorKind: viaChild.errorKind ?? '',
      })
    }
    if (viaChild.ok === true && typeof viaChild.secondaryError === 'string' && viaChild.secondaryError !== '') {
      const failure = classifyBackendFailure(viaChild.secondaryError, { operation: 'sync' })
      viaChild.secondaryError = failure.message
      if (failure.unsupported) {
        viaChild.message = `${viaChild.message}; ${failure.message}`
        await queueFailedOperation(home, {
          type: 'push',
          payload: { action: 'push', secondary: true },
          error: failure.message,
          errorKind: 'reserve',
        })
      }
    }
    if (viaChild.ok === true) {
      // Объявления «локальная навсегда»: чужое устройство могло вернуть копию
      // в зеркало — убираем её в карантин и коммитим. Ошибка не отменяет sync.
      // Журнал не дублируем: запуск уже записан дочерним процессом (H10).
      const localOnly = await reconcileLocalOnlyState(ctx, home, config)
      if (localOnly.ok === true) {
        viaChild.localOnly = localOnlySummary(localOnly)
        if (localOnly.removed > 0) {
          viaChild.message = `${viaChild.message}; облачных копий локальных сессий убрано: ${localOnly.removed}`
        }
        if (typeof localOnly.warning === 'string' && localOnly.warning !== '') {
          viaChild.message = `${viaChild.message}; ${localOnly.warning}`
        }
      }
    }
    return viaChild
  }

  const started = Date.now()
  const result = { pull: null, push: null }
  const messages = []
  try {
    const dshVersion = await hostDshVersion()
    if (action !== 'push') {
      result.pull = await pull({ home, config, dshVersion })
      messages.push(`принято: ${result.pull.imported}, обновлено: ${result.pull.updated}, конфликтов: ${result.pull.conflicts}`)
      if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)
      if ((result.pull.deleted ?? 0) > 0) messages.push(`удалено по отметкам других устройств: ${result.pull.deleted}${(result.pull.childrenDeleted ?? 0) > 0 ? ` (субагентов вместе с родителями: ${result.pull.childrenDeleted})` : ''}`)
      if ((result.pull.subagents ?? 0) > 0) messages.push(`субагентов принято: ${result.pull.subagents}`)
      if (result.pull.childrenMissing?.length) messages.push(`субагентов нет локально: ${result.pull.childrenMissing.length} (защищены от удаления)`)
      if (result.pull.warning) messages.push(result.pull.warning)

      // В зеркале могут быть проекты, которых здесь ещё нет: подхватываем по имени.
      const adopted = await adoptMirrorProjects(ctx, config, result.pull)
      if (adopted > 0) {
        result.pull = await pullReplicated({ home, config, dshVersion })
        messages.push(`подхвачено проектов из зеркала: ${adopted}; принято: ${result.pull.imported}`)
        if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)
      }

      // Привязать к рабочему пространству и импортированное, и то, что уже
      // лежало на диске после прошлых синхронизаций.
      const attached = await attachAllProjects(ctx, config)
      if (attached > 0) messages.push(`привязано к рабочему пространству: ${attached}`)
      const queued = await applyWorkspacePending(ctx, config)
      if (queued > 0) messages.push(`привязано из зеркала: ${queued}`)
      if ((result.pull.localSkipped ?? 0) > 0) messages.push(`локальных сессий пропущено: ${result.pull.localSkipped}`)
      // D2: копия уже была локально — второй не создавали, причина `duplicate`.
      if ((result.pull.duplicatesSkipped ?? 0) > 0) messages.push(`пропущено копий-дублей при импорте: ${result.pull.duplicatesSkipped}`)
      if (result.pull.profile !== undefined && result.pull.profile.skipped !== true) {
        messages.push(`профиль: применено ${result.pull.profile.applied ?? 0}, конфликтов ${result.pull.profile.conflicts ?? 0}`)
        if (result.pull.profile.pendingPlan === true) {
          messages.push(`профиль: план ждёт применения в панели (${result.pull.profile.plan?.files ?? 0} файлов)`)
        }
      }
      if (result.pull.workspace !== undefined) {
        messages.push(`рабочие пространства: к привязке ${result.pull.workspace.toAttach ?? 0}`)
      }
      const deletedIds = result.pull?.deletedIds ?? []
      if (deletedIds.length > 0) {
        const detached = await detachSessions(ctx, deletedIds)
        messages.push(`удалено по отметкам других устройств: ${deletedIds.length}; убрано из пространств: ${detached}`)
      }
    }
    if (action !== 'pull') {
      // H5: резерв не умеет операцию — не зовём метод, объясняем и в очередь.
      const secondaryCheck = secondaryOperationSupported(config, 'sync')
      if (secondaryCheck.ok !== true) {
        messages.push(secondaryCheck.message)
        await queueFailedOperation(home, {
          type: 'push',
          payload: { action: 'push', secondary: true },
          error: secondaryCheck.message,
          errorKind: 'reserve',
        })
      }
      const entry = Object.values(config.projects ?? {})[0]
      const located = await localSessionsFor(ctx, home, entry?.path ?? '')
      result.push = await pushReplicated({ home, config, sessions: located.sessions, confirmPrune, dshVersion })
      messages.push(`отправлено: ${result.push.pushed}${result.push.committed ? ', коммит создан' : ', изменений нет'}`)
      if (result.push.failures?.length) {
        const first = result.push.failures[0]
        messages.push(`не прочитано: ${result.push.failures.length} (${first.id}: ${first.message})`)
      }
      if ((result.push.removed ?? 0) > 0) messages.push(`удалено из зеркала: ${result.push.removed} — ${result.push.removedReason ?? ''}`)
      if ((result.push.childrenQuarantined ?? 0) > 0) messages.push(`субагентов ушли в карантин вместе с родителями: ${result.push.childrenQuarantined}`)
      if (result.push.childrenMissing?.length) messages.push(`субагентов нет локально: ${result.push.childrenMissing.length} (в зеркале оставлены)`)
      if (result.push.orphansProtected?.length) messages.push(`осиротевших субагентов не удаляем: ${result.push.orphansProtected.length}`)
      if ((result.push.localSkipped ?? 0) > 0) messages.push(`локальных сессий не отправлено: ${result.push.localSkipped}`)
      if ((result.push.localMirrorProtected ?? 0) > 0) messages.push(`в зеркале защищено локальных копий: ${result.push.localMirrorProtected}`)
      if (result.push.profile !== undefined) messages.push(`профиль: записей ${result.push.profile.patchEntries ?? 0}`)
      if (result.push.profileError !== undefined) messages.push(`профиль не отправлен: ${result.push.profileError}`)
      if (result.push.workspace !== undefined) messages.push(`рабочие пространства: ${result.push.workspace.workspaces ?? 0}`)
      if (result.push.requireConfirmation !== undefined) {
        messages.push(`удаление ${result.push.skippedDeletions?.removed ?? result.push.requireConfirmation.removed} сессий ждёт подтверждения — ничего не удалено`)
      }
      if (result.push.secondary !== undefined) messages.push(`резерв (${config.secondary?.backend ?? 'дубль'}): отправлено ${result.push.secondary.pushed}`)
      if (result.push.secondaryBlocked !== undefined) messages.push(result.push.secondaryBlocked.message)
      if (result.push.secondaryError !== undefined) {
        // H5: сырое «remote.sync is not a function» до панели не доводим.
        const failure = classifyBackendFailure(result.push.secondaryError, { operation: 'sync' })
        result.push.secondaryError = failure.message
        messages.push(`резерв недоступен: ${failure.message}`)
        if (failure.unsupported) {
          await queueFailedOperation(home, {
            type: 'push',
            payload: { action: 'push', secondary: true },
            error: failure.message,
            errorKind: 'reserve',
          })
        }
      }
      if (result.push.warning) messages.push(result.push.warning)
    }
  } catch (error) {
    // H5: ошибка единого интерфейса превращается в понятное сообщение.
    const failure = classifyBackendFailure(error, { operation: 'sync' })
    const message = failure.unsupported ? failure.message : (error instanceof Error ? error.message : String(error))
    const record = {
      ok: false,
      at: new Date().toISOString(),
      action,
      mode: 'builtin',
      message,
      ...(failure.unsupported ? { errorKind: 'reserve' } : {}),
      durationMs: Date.now() - started,
    }
    await writeLastRun(record)
    if (action !== 'pull') {
      // H6: не теряем операцию из-за офлайна — повторим из очереди.
      await queueFailedOperation(home, {
        type: 'push',
        payload: { action },
        error: message,
        errorKind: failure.unsupported ? 'reserve' : '',
      })
    }
    pushNotice('error', `Синхронизация не удалась: ${message}`)
    return record
  }

  const pullDeletions = result.pull?.deletedIds ?? []
  const pushDeletions = result.push?.removedIds ?? []
  const removedIds = [...pullDeletions, ...pushDeletions]
  const removed = (result.pull?.deleted ?? 0) + (result.push?.removed ?? 0)
  const removedReason = [result.pull?.deletedReason, result.push?.removedReason].filter(reason => typeof reason === 'string' && reason !== '').join(', ')
  // Коды причин и авторов удаления — отдельно от человекочитаемого текста:
  // по ним видно, удалил пользователь (manual/owner) или автоочистка (prune/sync).
  const removal = removalDetails(result)
  // Единица обмена «родитель + субагенты»: сколько сессий и субагентов
  // обменяно и каких детей не хватило локально (см. history.jsonl).
  const groups = subagentStats(result)
  // Сводка «локальная» для журнала и панели: skippedLocal + защита копий.
  const skipped = localSkipStats(result)
  // D2: импорт-дубли — сколько копий не создали и какие id пропущены.
  const duplicatesSkipped = Number(result.pull?.duplicatesSkipped ?? 0) || 0
  const duplicateIds = Array.isArray(result.pull?.duplicateIds) ? result.pull.duplicateIds.slice(0, 100) : []
  // «Локальная навсегда»: после обмена объявления могли вернуть копию в
  // зеркало — убираем её в карантин и коммитим (идемпотентно).
  const localOnlyResult = await reconcileLocalOnlyState(ctx, home, config)
  const localOnly = localOnlyResult.ok === true ? localOnlySummary(localOnlyResult) : localOnlySummary({})
  if (localOnlyResult.ok === true && localOnlyResult.removed > 0) {
    messages.push(`облачных копий локальных сессий убрано: ${localOnlyResult.removed}`)
  }
  if (typeof localOnlyResult.warning === 'string' && localOnlyResult.warning !== '') {
    messages.push(`объявления локальности: ${localOnlyResult.warning}`)
  }

  const record = {
    ok: true,
    at: new Date().toISOString(),
    action,
    mode: 'host',
    ...groups,
    ...skipped,
    duplicatesSkipped,
    duplicateIds,
    localOnly,
    message: `дочерний Node не найден, работал host-процесс. ${messages.join('; ')}`,
    durationMs: Date.now() - started,
    removed,
    removedIds: removedIds.slice(0, 100),
    removedReason,
    reasons: duplicatesSkipped > 0 ? [...new Set([...removal.reasons, 'duplicate'])] : removal.reasons,
    by: removal.by,
    removedDetails: removal.removedDetails,
    expired: removal.expired,
    expiredIds: removal.expiredIds,
    replaced: removal.replaced,
    replacedIds: removal.replacedIds,
    conflictIds: (result.pull?.conflictDetails ?? []).map(item => item.id),
    // Сводка плана и отложенные удаления — в журнал последнего запуска:
    // панель и sync_status показывают «удалений: N (ждёт подтверждения)».
    plan: result.push?.plan,
    skippedDeletions: result.push?.skippedDeletions,
    requireConfirmation: result.push?.requireConfirmation,
    guarded: (result.push?.guarded ?? []).length,
    secondaryBlocked: result.push?.secondaryBlocked,
    secondaryError: result.push?.secondaryError,
    secondary: result.push?.secondary === undefined
      ? null
      : { pushed: result.push.secondary.pushed, committed: result.push.secondary.committed === true },
    pull: result.pull
      ? { imported: result.pull.imported, updated: result.pull.updated, conflicts: result.pull.conflicts, attachments: result.pull.attachments?.restored ?? 0, skippedLocal: skipped.pullSkippedLocal, duplicatesSkipped }
      : null,
    push: result.push
      ? { pushed: result.push.pushed, committed: result.push.committed, attachments: result.push.attachments?.added ?? 0, skippedLocal: skipped.pushSkippedLocal, localMirrorProtected: skipped.localMirrorProtected }
      : null,
  }
  await writeLastRun(record)
  invalidateSessionStates()
  return record
}

/**
 * H2: подставить названия в план «Проверить» (удаления и корзины).
 * В плане title пришёл из `session.json` зеркала, поэтому лог сильнее
 * (`preferLog: true`): событие `session/title` — исходное название.
 */
export async function decoratePlanTitles(plan, { home, config } = {}) {
  if (plan === null || typeof plan !== 'object') return plan
  const projects = config?.projects ?? {}
  const decorate = async (item) => {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id === '') return
    const projectId = typeof item.projectId === 'string' ? item.projectId : ''
    const projectPath = typeof projects?.[projectId]?.path === 'string' ? projects[projectId].path : ''
    const resolved = await resolveSessionTitle({
      id: item.id,
      title: '',
      preferLog: true,
      repoDir: config?.repoDir,
      projectId,
      home,
      projectPath,
    })
    if (resolved.titleSource === 'fallback') {
      // Удалённая сессия лежит в карантине `_deleted`: активного лога нет.
      const fromTombstone = await resolveTombstoneTitle({
        sessionId: item.id,
        title: '',
        repoDir: config?.repoDir,
        projectId,
        home,
        projectPath,
      })
      if (fromTombstone.titleSource !== 'fallback') Object.assign(resolved, fromTombstone)
    }
    item.title = resolved.title
    item.shortId = resolved.shortId
    item.titleSource = resolved.titleSource
  }
  for (const item of Array.isArray(plan.deletions) ? plan.deletions : []) await decorate(item)
  for (const items of Object.values(plan.buckets ?? {})) {
    if (!Array.isArray(items)) continue
    for (const item of items) await decorate(item)
  }
  return plan
}

/**
 * План «Проверить»: только чтение.
 *
 * Сравнивает локальные сессии с зеркалом по id и хвостам логов и возвращает
 * шесть корзин плюс список сессий, которые были бы удалены. Ничего не пишет:
 * ни last-run, ни состояние, ни карантин.
 */
async function runPlan(ctx) {
  const home = dshHome()
  const config = await applySecret(ctx, await loadConfig(home))
  if (Object.keys(config.projects ?? {}).length === 0) {
    return { ok: false, action: 'plan', message: 'Сначала укажите проект в настройках плагина.' }
  }
  const githubToken = await resolveGitHubToken(ctx)
  if (githubToken !== '') process.env.GITHUB_TOKEN = githubToken
  const viaChild = await runViaChild(
    'plan',
    githubToken === '' ? {} : { GITHUB_TOKEN: githubToken },
    { record: false },
  )
  if (viaChild !== undefined) {
    // Синхронизация уже идёт другим процессом — это не план, а отказ.
    if (viaChild.skipped === true) return { ok: false, action: 'plan', message: viaChild.message }
    // H2: названия вместо id — в списке удалений и корзинах плана.
    await decoratePlanTitles(viaChild, { home, config })
    return viaChild
  }

  // Запасной путь без отдельного Node: host-процесс тоже умеет читать zstd,
  // если сборка это позволяет.
  const started = Date.now()
  try {
    const { buildPlan } = await import('./lib/plan.mjs')
    const plan = await buildPlan({ home, config, dshVersion: await hostDshVersion() })
    await decoratePlanTitles(plan, { home, config })
    return { ...plan, mode: 'host', durationMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      action: 'plan',
      message: `план не построен: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * «Применить удаления (N)»: подтверждённое удаление из зеркала в карантин.
 * Без `confirm: true` ничего не делает и просит подтверждение.
 */
async function runPrune(ctx, payload = {}) {
  const home = dshHome()
  if (payload?.confirm !== true) {
    return {
      ok: false,
      action: 'prune',
      code: 'confirm-required',
      message: 'удаление из зеркала выполняется только с подтверждением: нажмите «Применить удаления» и подтвердите',
    }
  }
  const config = await applySecret(ctx, await loadConfig(home))
  if (Object.keys(config.projects ?? {}).length === 0) {
    return { ok: false, action: 'prune', message: 'Сначала укажите проект в настройках плагина.' }
  }
  const githubToken = await resolveGitHubToken(ctx)
  if (githubToken !== '') process.env.GITHUB_TOKEN = githubToken
  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
    : undefined
  const viaChild = await runViaChild(
    'prune',
    githubToken === '' ? {} : { GITHUB_TOKEN: githubToken },
    { record: true, ids },
  )
  if (viaChild !== undefined) {
    invalidateSessionStates()
    if (viaChild.skipped === true) return { ok: false, action: 'prune', message: viaChild.message }
    return viaChild
  }

  const started = Date.now()
  try {
    const { applyDeletions } = await import('./lib/sync.mjs')
    const summary = await applyDeletions({ home, config, confirm: true, ids, dshVersion: await hostDshVersion() })
    const record = {
      ok: true,
      at: new Date().toISOString(),
      action: 'prune',
      mode: 'host',
      message: summary.message ?? `удалено в карантин: ${summary.removed}`,
      removed: summary.removed,
      removedIds: summary.removedIds ?? [],
      removedReason: summary.removedReason ?? '',
      reasons: summary.reasons ?? ['manual'],
      by: summary.by ?? ['owner'],
      removedDetails: summary.removedDetails ?? [],
      committed: summary.committed === true,
      skippedDeletions: summary.skippedDeletions,
      durationMs: Date.now() - started,
    }
    await writeLastRun(record)
    invalidateSessionStates()
    if (record.removed > 0) pushNotice('sync', `Удалено в карантин: ${record.removed}. Вернуть можно в карточке «Удалённые».`)
    return record
  } catch (error) {
    const record = {
      ok: false,
      at: new Date().toISOString(),
      action: 'prune',
      mode: 'host',
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    }
    await writeLastRun(record)
    pushNotice('error', `Удаление не выполнено: ${record.message}`)
    return record
  }
}

/**
 * Синхронизация через сторонний плагин: вызываем только опубликованные им
 * методы и не заглядываем внутрь. Ошибки внешнего плагина не роняют карточку —
 * они попадают в отчёт.
 */
async function runViaExternal(external, action) {
  const service = external.service
  const started = Date.now()
  const calls = []
  try {
    if (action !== 'push' && typeof service.pull === 'function') {
      await service.pull()
      calls.push('pull')
    }
    if (action !== 'pull' && typeof service.push === 'function') {
      await service.push()
      calls.push('push')
    }
    if (calls.length === 0 && typeof service.sync === 'function') {
      await service.sync()
      calls.push('sync')
    }
    const record = {
      ok: true,
      at: new Date().toISOString(),
      action,
      mode: 'external',
      external: external.name,
      message: `синхронизация выполнена через ${external.name} (${calls.join(' + ')})`,
      durationMs: Date.now() - started,
      pull: null,
      push: null,
    }
    await writeLastRun(record)
    return record
  } catch (error) {
    const record = {
      ok: false,
      at: new Date().toISOString(),
      action,
      mode: 'external',
      external: external.name,
      message: `внешний плагин ${external.name} вернул ошибку: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - started,
    }
    await writeLastRun(record)
    return record
  }
}

/** Готовность резервной копии; считается не чаще раза в 10 секунд. */
let backupProgressCache = { at: 0, key: '', value: undefined }

async function readBackupProgress(config) {
  const secondary = config?.secondary
  if (secondary === undefined || secondary === null || secondary.enabled === false) return undefined
  const repoDir = secondary.repoDir
  if (typeof repoDir !== 'string' || repoDir === '') return undefined

  const key = `${repoDir}:${secondary.backend}`
  if (backupProgressCache.value !== undefined && backupProgressCache.key === key && Date.now() - backupProgressCache.at < 10_000) {
    return backupProgressCache.value
  }
  try {
    // Для папки облака крупные сессии тоже доезжают: локальное копирование
    // не ограничено «полутора мегабайтами» WebDAV.
    const value = await backupProgress(repoDir, {
      maxFileBytes: secondary.backend === 'folder' ? Number.POSITIVE_INFINITY : Number(secondary.maxFileBytes ?? 1_500_000),
    })
    backupProgressCache = { at: Date.now(), key, value }
    return value
  } catch {
    return backupProgressCache.value
  }
}

/** Запомнить версию пакета и вернуть предыдущую, если она изменилась. */
async function noteInstalledVersion() {
  try {
    const manifest = fileURLToPath(new URL('./package.json', import.meta.url))
    const current = JSON.parse(await readFile(manifest, 'utf8')).version
    packageVersion = current
    const file = join(dshHome(), 'dsh-sync', INSTALLED_VERSION_FILE)
    let previous
    try {
      previous = JSON.parse(await readFile(file, 'utf8')).version
    } catch {
      previous = undefined
    }
    await mkdir(join(dshHome(), 'dsh-sync'), { recursive: true })
    await writeFile(file, `${JSON.stringify({ version: current, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')

    if (typeof previous !== 'string' || previous === current) return undefined
    // Отметку об обновлении храним на диске: окно должно появиться и после
    // перезапуска DSH, а не только в том процессе, где менялась версия.
    await writeFile(
      join(dshHome(), 'dsh-sync', PENDING_UPDATE_FILE),
      `${JSON.stringify({ from: previous, to: current }, null, 2)}\n`,
      'utf8',
    )
    return previous
  } catch {
    return undefined
  }
}

/** Незакрытая отметка об обновлении (если окно ещё не подтвердили). */
async function readPendingUpdate() {
  try {
    return JSON.parse(await readFile(join(dshHome(), 'dsh-sync', PENDING_UPDATE_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

/** Убрать отметку об обновлении: пользователь нажал «Готово». */
async function clearPendingUpdate() {
  try {
    await rm(join(dshHome(), 'dsh-sync', PENDING_UPDATE_FILE), { force: true })
  } catch {
    // файла нет — и хорошо
  }
}

async function writeLastRun(record) {
  await recordRun(dshHome(), record)
}

/**
 * Обновить только `last-run.json`, не дописывая журнал.
 *
 * Нужно для «доводки» результата дочернего процесса (привязка к рабочим
 * пространствам): запуск уже записан один раз, и повторные `recordRun` давали
 * бы дубли в истории (H10).
 */
export async function updateLastRun(record) {
  try {
    await mkdir(join(dshHome(), 'dsh-sync'), { recursive: true })
    await writeFile(
      join(dshHome(), 'dsh-sync', LAST_RUN_FILE),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // last-run — вспомогательные данные
  }
}

/**
 * Версия DSH, в котором работает host-часть. Читается из package.json пакета
 * `@deepseek-ai/dsh` по DSH_INSTALL_DIR (внутри app.asar доступно только
 * host-процессу Electron); дочернему процессу передаётся через окружение.
 */
async function hostDshVersion() {
  const env = [process.env.DSH_VERSION, process.env.DSH_SYNC_DSH_VERSION].find(value => typeof value === 'string' && value.trim() !== '')
  if (env !== undefined) return env.trim()
  const dir = process.env.DSH_INSTALL_DIR
  if (typeof dir === 'string' && dir !== '') {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (typeof manifest?.version === 'string' && manifest.version !== '') return manifest.version
    } catch {
      // версию не знаем — предупреждения не будет
    }
  }
  return undefined
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function body(request) {
  try {
    return (await request.json()) ?? {}
  } catch {
    return {}
  }
}

/**
 * Отпечаток локального стора: меняется, когда в сессиях появляются события.
 * Берётся у сервиса сессий, поэтому не зависит от доступа к каталогу.
 */
async function computeFingerprint(ctx) {
  const persistence = ctx?.get?.('sessionPersistence')
  if (persistence === undefined || persistence === null || typeof persistence.list !== 'function') return ''
  try {
    const list = await persistence.list()
    return (list ?? [])
      .map(snapshot => `${snapshot?.header?.id ?? '?'}:${snapshot?.sizeBytes ?? 0}`)
      .sort()
      .join('|')
  } catch {
    return ''
  }
}

/**
 * Один такт фоновой синхронизации: приём по расписанию и отправка при
 * изменениях, но не чаще заданного окна.
 */
async function autoTick(ctx) {
  if (automation.running) return
  automation.lastTickAt = Date.now()

  const home = dshHome()
  let config
  try {
    config = await loadConfig(home)
  } catch {
    return
  }
  const options = config.autoSync ?? {}
  if (options.enabled === false || Object.keys(config.projects ?? {}).length === 0) return

  automation.running = true
  try {
    const now = Date.now()
    const pullEvery = Math.max(60_000, (options.pullIntervalMinutes ?? 15) * 60_000)
    const pushEvery = Math.max(0, (options.pushMinIntervalMinutes ?? 5) * 60_000)
    const retryMs = 60_000

    // Приём: при старте — всегда (если не выключен), дальше по интервалу.
    // Неудачная попытка повторяется через минуту, а не через четверть часа.
    const pullDue = automation.lastPullAt === 0
      ? options.pullOnStart !== false
      : now - automation.lastPullAt >= (automation.lastPullOk ? pullEvery : retryMs)

    if (pullDue) {
      const record = await runSync(ctx, 'pull')
      automation.lastPullAt = Date.now()
      automation.lastPullOk = record?.ok === true
      if (record?.ok !== true) automation.lastError = String(record?.message ?? '')
    } else if (automation.lastPullAt === 0) {
      automation.lastPullAt = Date.now()
    }

    if (options.pushOnChange !== false) {
      const fingerprint = await computeFingerprint(ctx)
      const changed = fingerprint !== '' && fingerprint !== automation.fingerprint
      const pushDue = now - automation.lastPushAt >= (automation.lastPushOk === false ? retryMs : pushEvery)

      // Удаление сессии плагином удаления не меняет размер логов, зато сразу
      // уменьшает список сессий рабочего пространства — отправляем без задержки.
      const workspaceCount = countWorkspaceSessions(ctx)
      const shrunk = automation.workspaceCount !== undefined && workspaceCount < automation.workspaceCount
      automation.workspaceCount = workspaceCount

      if ((changed && pushDue) || shrunk) {
        const record = await runSync(ctx, 'push')
        automation.lastPushAt = Date.now()
        automation.lastPushOk = record?.ok === true
        automation.lastError = record?.ok === true ? '' : String(record?.message ?? '')
        if (record?.ok === true) automation.fingerprint = fingerprint
      }
    }
  } catch (error) {
    automation.lastError = error instanceof Error ? error.message : String(error)
  } finally {
    automation.running = false
  }
}

/** Пути всех workspace, которые видит DSH. */
function workspacePaths(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
      return (registry.list() ?? [])
        .map(workspace => workspace?.path ?? workspace?.record?.path)
        .filter(path => typeof path === 'string' && path.length > 0)
    }
  } catch {
    // реестр недоступен — работаем без него
  }
  return []
}

/** Имена репозиториев, которые имеет смысл искать в аккаунте. */
const REPO_CANDIDATES = ['dsh-sessions', 'dsh-sync-sessions', 'dsh-sync']

/**
 * Найти репозиторий зеркала по токену GitHub из хранилища DSH. Только чтение:
 * запрашиваем логин и наличие репозитория с ожидаемым именем.
 */
async function discoverRepository(ctx) {
  let token
  try {
    const credentials = ctx?.get?.('credentials')
    const hit = await credentials?.resolve?.('GITHUB_TOKEN')
    token = typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  } catch {
    token = undefined
  }
  if (token === undefined) return undefined

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-sync',
    'x-github-api-version': '2022-11-28',
  }

  try {
    const me = await fetch('https://api.github.com/user', { headers })
    if (!me.ok) return undefined
    const login = (await me.json())?.login
    if (typeof login !== 'string' || login.length === 0) return undefined

    for (const name of REPO_CANDIDATES) {
      const response = await fetch(`https://api.github.com/repos/${login}/${name}`, { headers })
      if (!response.ok) continue
      const repo = await response.json()
      if (typeof repo?.clone_url === 'string') return repo.clone_url
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Если проекты не настроены, взять первый workspace из DSH: путь и id
 * подставляются сами. Если не задан репозиторий — попробовать найти его в
 * аккаунте GitHub по сохранённому токену.
 */
async function ensureProjectDefaults(ctx) {
  const home = dshHome()
  const config = await loadConfig(home)
  let changed = false

  if (Object.keys(config.projects ?? {}).length === 0) {
    const paths = workspacePaths(ctx)
    const path = paths[0]
    if (typeof path === 'string' && path.length > 0) {
      const folder = path.split(/[\\/]/).filter(Boolean).pop() ?? 'default'
      const id = folder.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
      config.projects = { [id]: { path, title: folder } }
      changed = true
    }
  }

  if ((config.remote ?? '').length === 0) {
    const remote = await discoverRepository(ctx)
    if (remote !== undefined) {
      config.remote = remote
      changed = true
    }
  }

  if (changed) await saveConfig(home, config)
  return config
}

/**
 * Создать приватный репозиторий для зеркала и прописать его в настройках.
 * Токен читается из хранилища DSH и в браузер не возвращается.
 */
async function createRepository(ctx) {
  const home = dshHome()
  const config = await loadConfig(home)

  let token
  try {
    const credentials = ctx?.get?.('credentials')
    const hit = await credentials?.resolve?.('GITHUB_TOKEN')
    token = typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  } catch {
    token = undefined
  }
  if (token === undefined) {
    return {
      ok: false,
      code: 'no-token',
      message: 'В хранилище DSH нет токена GitHub. Создайте приватный репозиторий вручную и вставьте его HTTPS-адрес в поле выше.',
    }
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-sync',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  }
  const repoName = 'dsh-sessions'

  try {
    const me = await fetch('https://api.github.com/user', { headers })
    if (!me.ok) {
      return { ok: false, code: 'unauthorized', message: `GitHub не принял токен (${me.status}). Обновите токен в настройках DSH.` }
    }
    const login = (await me.json())?.login
    if (typeof login !== 'string' || login.length === 0) {
      return { ok: false, code: 'no-login', message: 'Не удалось определить владельца токена на GitHub.' }
    }

    const existing = await fetch(`https://api.github.com/repos/${login}/${repoName}`, { headers })
    if (existing.ok) {
      const repo = await existing.json()
      const remote = typeof repo?.clone_url === 'string' ? repo.clone_url : ''
      if (remote !== '') {
        config.remote = remote
        await saveConfig(home, config)
        return { ok: true, created: false, remote, message: `Репозиторий уже существует: ${login}/${repoName}` }
      }
    }

    const created = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: 'Зеркало сессий DeepSeek Harness (dsh-sync)',
        auto_init: false,
      }),
    })
    if (!created.ok) {
      const detail = await created.text().catch(() => '')
      return {
        ok: false,
        code: 'create-failed',
        message: `GitHub ответил ${created.status}: ${detail.slice(0, 200)}. Создайте приватный репозиторий вручную и вставьте адрес в поле.`,
      }
    }
    const repo = await created.json()
    const remote = typeof repo?.clone_url === 'string' ? repo.clone_url : ''
    if (remote === '') {
      return { ok: false, code: 'no-url', message: 'Репозиторий создан, но GitHub не вернул адрес. Скопируйте HTTPS-адрес вручную.' }
    }
    config.remote = remote
    await saveConfig(home, config)
    return { ok: true, created: true, remote, message: `Создан приватный репозиторий ${login}/${repoName}` }
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      message: `Не удалось связаться с GitHub: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Состояние каждой сессии для индикатора в списке: зелёный — совпадает с
 * зеркалом, оранжевый — есть неотправленные изменения, красный — ещё не
 * уезжала, серый — локальная (не синхронизируется). Дополнительно панель
 * получает режим, признак привязки к рабочему пространству и сведения о
 * последнем запуске. Результат кэшируется на несколько секунд: список
 * перерисовывается часто.
 */
let sessionStatesCache = { at: 0, value: undefined }

/** Все сессии, привязанные к рабочим пространствам (или undefined без реестра). */
function workspaceAttachedIds(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return undefined
    const ids = new Set()
    for (const workspace of registry.list() ?? []) {
      for (const id of workspace?.sessionIds ?? []) {
        if (typeof id === 'string') ids.add(id)
      }
    }
    return ids
  } catch {
    return undefined
  }
}

/**
 * Рабочие пространства и карта «сессия → пространство».
 *
 * Источник — реестр DSH (он знает живые пространства), запасной — стор
 * `storages/workspace.json`. Карта нужна двум вещам: привязке (уже была) и
 * умолчанию режима для новых сессий каждого пространства.
 */
async function workspaceDirectory(ctx, home) {
  const workspaces = []
  const sessionWorkspace = {}
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
      for (const workspace of registry.list() ?? []) {
        const id = typeof workspace?.id === 'string' ? workspace.id.trim() : ''
        if (id === '') continue
        const path = typeof workspace?.path === 'string'
          ? workspace.path
          : typeof workspace?.record?.path === 'string' ? workspace.record.path : ''
        const title = typeof workspace?.title === 'string' && workspace.title.trim() !== ''
          ? workspace.title.trim()
          : typeof workspace?.record?.title === 'string' && workspace.record.title.trim() !== ''
            ? workspace.record.title.trim()
            : path
        const sessionIds = (Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [])
          .filter(sessionId => typeof sessionId === 'string' && sessionId !== '')
        workspaces.push({ id, title, path, sessionIds })
        for (const sessionId of sessionIds) {
          if (sessionWorkspace[sessionId] === undefined) sessionWorkspace[sessionId] = id
        }
      }
    }
  } catch {
    // реестр недоступен — берём стор
  }
  if (workspaces.length === 0) {
    try {
      const local = await readLocalWorkspaces(home)
      for (const workspace of local?.workspaces ?? []) {
        const id = typeof workspace?.id === 'string' ? workspace.id.trim() : ''
        if (id === '') continue
        const sessionIds = (workspace?.sessionIds ?? []).filter(sessionId => typeof sessionId === 'string')
        workspaces.push({ id, title: workspace.title ?? workspace.path, path: workspace.path, sessionIds })
        for (const sessionId of sessionIds) {
          if (sessionWorkspace[sessionId] === undefined) sessionWorkspace[sessionId] = id
        }
      }
    } catch {
      // стора ещё нет — пространств нет
    }
  }
  return { workspaces, sessionWorkspace }
}

/** Запись реестра синхронизации для сессии (реестр хранит числовой `at`). */
function ledgerEntry(ledger, sessionId) {
  const key = typeof sessionId === 'string' && sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`
  return ledger.sessions[key] ?? ledger.sessions[sessionId]
}

/** Последний запуск синхронизации из журнала. */
async function readLastRunInfo(home) {
  try {
    return JSON.parse(await readFile(join(home, 'dsh-sync', LAST_RUN_FILE), 'utf8'))
  } catch {
    return null
  }
}

async function sessionStates(ctx) {
  if (sessionStatesCache.value !== undefined && Date.now() - sessionStatesCache.at < 5_000) {
    return sessionStatesCache.value
  }

  const home = dshHome()
  const config = await loadConfig(home)
  const ledger = await readLedger(home)
  const directory = await workspaceDirectory(ctx, home)
  const attached = Object.keys(directory.sessionWorkspace).length > 0
    ? new Set(Object.keys(directory.sessionWorkspace))
    : workspaceAttachedIds(ctx)
  // Новые сессии получают умолчание своего рабочего пространства до того, как
  // индикатор решит, облачная она или локальная.
  const modes = (await applyWorkspaceDefaults(home, { workspaceIdBySession: directory.sessionWorkspace })).modes
  // Объявления «локальная навсегда» (зеркало + домашний реестр): панель
  // показывает бейдж «локальная навсегда» и предлагает миграцию остатка копий.
  const localOnly = await localOnlyState({ home, config }).catch(() => ({ ids: [] }))
  const declaredIds = new Set((Array.isArray(localOnly.ids) ? localOnly.ids : []).map(id => normalizeSessionId(id)))
  const lastRun = await readLastRunInfo(home)
  const offline = lastRun !== null && lastRun.ok === false
  const conflictIds = new Set(Array.isArray(lastRun?.conflictIds) ? lastRun.conflictIds : [])
  const syncing = automation.running === true
  const states = {}
  const sessions = []

  for (const [projectId, entry] of Object.entries(config.projects ?? {})) {
    const projectPath = typeof entry?.path === 'string' ? entry.path : ''
    if (projectPath === '') continue
    let located
    try {
      located = await localSessionsFor(ctx, home, projectPath)
    } catch {
      continue
    }
    for (const session of located.sessions) {
      if (typeof session.path !== 'string') continue
      let info
      try {
        info = await stat(session.path)
      } catch {
        info = undefined
      }
      const baseState = sessionState(session.id, info, ledger)
      const mode = sessionModeOf(modes, session.id)
      const unattached = attached !== undefined && !attached.has(session.id)
      const badge = sessionBadge({
        mode,
        state: baseState,
        offline,
        conflict: conflictIds.has(session.id),
        unattached,
      })
      // «В облаке есть копия»: у локальной сессии копия зеркала защищена от
      // prune, и панель предлагает удалить её отдельным действием.
      let cloudCopy = false
      let cloudCopyBytes
      if (mode === MODE_LOCAL) {
        const copyDir = cloudCopyPath(config.repoDir, projectId, session.id)
        if (existsSync(copyDir)) {
          cloudCopy = true
          try {
            cloudCopyBytes = (await stat(join(copyDir, 'session.v4.jsonl.zstd'))).size
          } catch {
            cloudCopyBytes = undefined
          }
        }
      }
      const ledgerRecord = ledgerEntry(ledger, session.id)
      states[session.id] = badge
      // H2: вместо голого id — название по цепочке (session.title → событие
      // session/title в логе → session.json зеркала → «Без названия»). Короткий
      // id остаётся для подсказки.
      const resolvedTitle = await resolveSessionTitle({
        id: session.id,
        title: session.title,
        path: session.path,
        repoDir: config.repoDir,
        projectId,
      })
      sessions.push({
        id: session.id,
        title: resolvedTitle.title,
        rawTitle: resolvedTitle.rawTitle,
        shortId: resolvedTitle.shortId,
        titleSource: resolvedTitle.titleSource,
        projectId,
        path: projectPath,
        workspaceId: directory.sessionWorkspace[session.id] ?? '',
        mode,
        state: baseState,
        badge,
        attached: attached === undefined ? null : !unattached,
        // Подсказка индикатора: дата последней синхронизации и размер лога.
        bytes: info?.size ?? (typeof ledgerRecord?.size === 'number' ? ledgerRecord.size : undefined),
        syncedAt: typeof ledgerRecord?.at === 'number' && Number.isFinite(ledgerRecord.at)
          ? new Date(ledgerRecord.at).toISOString()
          : null,
        cloudCopy,
        // Объявление «локальная навсегда»: сессия не уходит и не принимается
        // ни на одном устройстве, пока объявление не снимут «Сделать облачной».
        declared: declaredIds.has(normalizeSessionId(session.id)),
        ...(cloudCopyBytes !== undefined ? { cloudCopyBytes } : {}),
      })
    }
  }

  const localCount = sessions.filter(session => session.mode === MODE_LOCAL).length
  const unattached = sessions.filter(session => session.badge === 'unattached').length
  // Миграция: локальные сессии, у которых в зеркале осталась копия. Для них
  // панель показывает «Убрать облачные копии локальных сессий».
  const migrationIds = sessions
    .filter(session => session.mode === MODE_LOCAL && session.cloudCopy === true)
    .map(session => session.id)
  const undeclaredLocal = sessions.filter(session => session.mode === MODE_LOCAL && session.declared !== true)
  const value = {
    ok: true,
    states,
    sessions,
    modes: { local: localCount, cloud: sessions.length - localCount },
    localOnly: {
      count: declaredIds.size,
      declaredIds: [...declaredIds].slice(0, 100),
      // Локальные сессии без объявления: ещё не «навсегда», но уже не в облаке.
      undeclared: undeclaredLocal.length,
      migration: { count: migrationIds.length, ids: migrationIds.slice(0, 100) },
    },
    workspaces: directory.workspaces.map(workspace => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessions: workspace.sessionIds.length,
      // Умолчание режима для новых сессий этого пространства.
      defaultMode: workspaceDefaultMode(modes, workspace.id),
    })),
    unattached,
    syncing,
    cloud: {
      offline,
      at: lastRun?.at ?? null,
      ok: lastRun === null ? true : lastRun.ok !== false,
      message: lastRun?.message ?? '',
      skippedLocal: Number(lastRun?.skippedLocal ?? 0) || 0,
      localMirrorProtected: Number(lastRun?.localMirrorProtected ?? 0) || 0,
    },
    attachAvailable: attached !== undefined,
    // H6: счётчик очереди невыполненных операций — «в очереди: N».
    outbox: await outboxSummary(home),
  }
  sessionStatesCache = { at: Date.now(), value }
  return value
}

/** Сбросить кеш состояний: после смены режима значки должны обновиться сразу. */
export function invalidateSessionStates() {
  sessionStatesCache = { at: 0, value: undefined }
}

/**
 * Применить очередь привязки из workspace.json через реестр DSH.
 * Очередь строится в `lib/workspace.mjs` при приёме зеркала.
 */
async function applyWorkspacePending(ctx, config) {
  const pending = await readWorkspacePending(dshHome())
  if (pending.pendingAttach.length === 0) return 0
  let attached = 0
  for (const item of pending.pendingAttach) {
    if (typeof item.path !== 'string' || !Array.isArray(item.sessionIds)) continue
    attached += await attachSessions(ctx, item.path, item.sessionIds)
  }
  if (attached > 0) {
    await clearWorkspacePending(dshHome())
    invalidateSessionStates()
  }
  return attached
}

/** Заметки профильного слоя для главной карточки: статус и план привязки. */
async function profileStatus(ctx) {
  const home = dshHome()
  const config = await loadConfig(home)
  const profile = await readProfileStatus({ home, config })
  let workspace = { mirrorWorkspaces: 0, localWorkspaces: 0, matched: 0, toAttach: 0, hints: [], pending: 0 }
  try {
    const { createNeutralizer } = await import('./lib/neutralize.mjs')
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: home })
    const plan = await planWorkspace({ home, config, repoDir: config.repoDir, neutralizer })
    const pending = await readWorkspacePending(home)
    workspace = {
      mirrorWorkspaces: plan.mirrorWorkspaces,
      localWorkspaces: plan.localWorkspaces,
      matched: plan.matched.length,
      toAttach: plan.pendingAttach.reduce((total, item) => total + item.sessionIds.length, 0),
      hints: plan.hints.slice(0, 20),
      pending: pending.pendingAttach.length,
    }
  } catch (error) {
    workspace.error = error instanceof Error ? error.message : String(error)
  }
  const journal = typeof config.repoDir === 'string' && config.repoDir !== '' ? await readJournal(config.repoDir) : { entries: [] }
  return { ok: true, profile, workspace, journal: journal.entries.slice(-20) }
}

/**
 * Привязать сессии всех настроенных проектов к их рабочим пространствам. */
async function attachAllProjects(ctx, config) {
  let attached = 0
  for (const entry of Object.values(config.projects ?? {})) {
    const path = typeof entry?.path === 'string' ? entry.path : ''
    if (path === '') continue
    try {
      const located = await localSessionsFor(ctx, dshHome(), path)
      const ids = located.sessions.filter(session => !session.parent).map(session => session.id)
      attached += await attachSessions(ctx, path, ids)
    } catch {
      // один проект не должен мешать остальным
    }
  }
  return attached
}

/** Убрать удалённые сессии из рабочих пространств, чтобы они исчезли из списка. */
async function detachSessions(ctx, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return 0
  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch {
    return 0
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return 0

  const wanted = new Set(sessionIds)
  let detached = 0
  for (const workspace of registry.list() ?? []) {
    let known
    try {
      known = new Set(Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [])
    } catch {
      continue
    }
    for (const id of wanted) {
      if (!known.has(id)) continue
      try {
        await workspace.detachSession(id)
        detached += 1
      } catch {
        // уже отвязана
      }
    }
  }
  return detached
}

/** Сколько всего сессий числится за рабочими пространствами. */
function countWorkspaceSessions(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return 0
    let total = 0
    for (const workspace of registry.list() ?? []) {
      total += Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Привязать сессии к рабочему пространству проекта.
 *
 * DSH выполняет bootstrap реестра только при первой инициализации: сессии,
 * добавленные позже (нашим плагином или вручную), на диске есть, но в списке
 * не появляются. `attachSession` идемпотентен, поэтому повторный вызов дешёвый.
 */
async function attachSessions(ctx, projectPath, sessionIds) {
  if (typeof projectPath !== 'string' || projectPath.length === 0 || sessionIds.length === 0) return 0

  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch {
    registry = undefined
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return 0

  let workspace
  try {
    for (const candidate of registry.list() ?? []) {
      const path = candidate?.path ?? candidate?.record?.path
      if (typeof path === 'string' && samePath(path, projectPath)) {
        workspace = candidate
        break
      }
    }
  } catch {
    return 0
  }
  if (workspace === undefined || typeof workspace.attachSession !== 'function') return 0

  let attached = 0
  let known = new Set()
  try {
    known = new Set(Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
  } catch {
    known = new Set()
  }
  for (const id of sessionIds.slice(0, 1000)) {
    if (known.has(id)) continue
    try {
      await workspace.attachSession(id)
      attached += 1
    } catch {
      // уже привязана, либо cwd не совпал — не повод ронять синхронизацию
    }
  }
  return attached
}

/** Подхватить проекты из метаданных зеркала, сопоставив их с локальными путями. */
async function adoptMirrorProjects(ctx, config, pullResult) {
  const projects = pullResult?.mirrorProjects ?? []
  if (projects.length === 0) return 0
  const paths = workspacePaths(ctx)
  if (paths.length === 0) return 0

  let added = 0
  for (const project of projects) {
    if (config.projects?.[project.id] !== undefined) continue
    const path = matchProjectPath(project.id, project.title, paths)
    if (path === undefined) continue
    config.projects[project.id] = { path, title: project.title }
    added += 1
  }
  if (added > 0) await saveConfig(dshHome(), config)
  return added
}

/** Включить фоновую синхронизацию: первый такт через 10 с, дальше раз в минуту. */
/** Проект из надгробий по каноническому id (записи могли писаться коротко). */
function tombstoneProjectId(tombstones, sessionId) {
  const canonical = normalizeSessionId(sessionId)
  for (const [storedId, entry] of Object.entries(tombstones?.sessions ?? {})) {
    if (normalizeSessionId(storedId) !== canonical) continue
    return typeof entry?.projectId === 'string' ? entry.projectId : ''
  }
  return ''
}

/**
 * H4: привести восстановленную копию к каноническому id.
 *
 * - каталог, созданный под коротким id, переименовывается в `session-…`;
 * - заголовок лога получает канонический id, иначе DSH показал бы «новую»
 *   сессию вместо восстановленной.
 * @returns список выполненных исправлений (для журнала)
 */
async function canonicalizeRestoredCopy({ home, config, item, canonical }) {
  const fixed = []
  const storedId = typeof item?.id === 'string' && item.id !== '' ? item.id : canonical
  const projectId = typeof item?.projectId === 'string' ? item.projectId : ''
  const projectPath = projectId !== '' && typeof config.projects?.[projectId]?.path === 'string'
    ? config.projects[projectId].path
    : ''
  const mirrorDirs = []
  const localDirs = []

  if (projectId !== '') {
    const from = join(config.repoDir, 'sessions', projectId, encodeSegment(storedId))
    const to = join(config.repoDir, 'sessions', projectId, encodeSegment(canonical))
    if (from !== to) {
      try {
        if (existsSync(from) && !existsSync(to)) {
          await rename(from, to)
          fixed.push('mirror-dir')
        }
      } catch {
        // переименование — вспомогательный шаг
      }
    }
    mirrorDirs.push(to)
  }
  if (projectPath !== '') {
    const from = localSessionDir(home, projectPath, storedId)
    const to = localSessionDir(home, projectPath, canonical)
    if (from !== to) {
      try {
        if (existsSync(from) && !existsSync(to)) {
          await rename(from, to)
          fixed.push('local-dir')
        }
      } catch {
        // переименование — вспомогательный шаг
      }
    }
    localDirs.push(to)
  }

  const fixHeader = async (dir, cwd) => {
    const logPath = join(dir, 'session.v4.jsonl.zstd')
    if (!existsSync(logPath)) return
    try {
      const bytes = await readFile(logPath)
      const { header } = splitLog(bytes)
      if (header?.id === canonical) return
      const next = remapTo(bytes, typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : cwd, { id: canonical })
      await writeFile(logPath, next)
      fixed.push('header-id')
    } catch {
      // битый лог не трогаем: восстановление уже состоялось
    }
  }
  for (const dir of mirrorDirs) await fixHeader(dir, canonicalCwd(projectId))
  for (const dir of localDirs) await fixHeader(dir, projectPath)
  return fixed
}

// --- M1: «Найти дубли» и карантин лишних копий -----------------------------

/**
 * «Найти дубли»: группы копий одной сессии среди локального стора, зеркала и
 * карантина. Только чтение: ничего не меняет, сеть и журнал не трогает.
 *
 * @returns {Promise<object>} отчёт с группами, каноническими id и счётчиками
 */
async function runDuplicatesScan(ctx, payload = {}) {
  const home = dshHome()
  const config = await applySecret(ctx, await loadConfig(home))
  if (Object.keys(config.projects ?? {}).length === 0) {
    return { ok: false, action: 'duplicates', message: 'Сначала укажите проект в настройках плагина.' }
  }
  const project = typeof payload.project === 'string' && payload.project.trim() !== '' ? payload.project.trim() : undefined
  return collectDuplicateGroups({ home, config, project })
}

/**
 * «Убрать дубли в карантин»: лишние копии групп уходят в `_deleted` с причиной
 * `duplicate`, канонические не трогаются. Требует `confirm:true` (второй клик).
 *
 * Если зеркало недоступно, локальное действие всё равно выполняется: файлы
 * переносятся и метки пишутся, а повторная отправка уходит в очередь (H6).
 *
 * @returns {{ status: number, body: object }}
 */
async function runDuplicatesQuarantine(ctx, payload = {}) {
  const home = dshHome()
  const config = await applySecret(ctx, await loadConfig(home))
  if (Object.keys(config.projects ?? {}).length === 0) {
    return { status: 400, body: { ok: false, action: 'duplicates', message: 'Сначала укажите проект в настройках плагина.' } }
  }
  if (payload.confirm !== true) {
    return {
      status: 409,
      body: {
        ok: false,
        action: 'duplicates',
        code: 'confirm-required',
        message: 'убрать дубли в карантин можно только с подтверждением (confirm:true): каноническая копия останется',
      },
    }
  }
  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
    : undefined
  const project = typeof payload.project === 'string' && payload.project.trim() !== '' ? payload.project.trim() : undefined
  // Свежее зеркало — чтобы не утащить в карантин копию, которой уже нет.
  let warning = ''
  let remote
  try {
    remote = await createRemote(config)
  } catch (error) {
    warning = classifyBackendFailure(error, { operation: 'sync' }).message
  }
  if (remote !== undefined) {
    const syncGuard = backendGuard(remote, 'sync', backendLabel(remote, config))
    if (syncGuard.ok !== true) {
      warning = `${syncGuard.message}; действие выполнено локально, отправка уйдёт при следующей синхронизации`
    } else {
      try {
        await remote.sync()
      } catch (error) {
        const failure = classifyBackendFailure(error, { operation: 'sync' })
        warning = `${failure.message}; действие выполнено локально, отправка уйдёт при следующей синхронизации`
      }
    }
  }
  let summary
  try {
    summary = await quarantineDuplicates({ home, config, project, ids, confirm: true })
  } catch (error) {
    const failure = classifyBackendFailure(error, { operation: 'sync' })
    if (failure.unsupported) {
      await queueFailedOperation(home, {
        type: 'push',
        payload: { action: 'push' },
        error: failure.message,
        errorKind: 'reserve',
      })
      return { status: 409, body: { ok: false, code: failure.code, message: `${failure.message}; действие сохранено в очереди`, queued: true } }
    }
    throw error
  }
  let committed = false
  if (summary.quarantined > 0 && remote !== undefined) {
    const commitGuard = backendGuard(remote, 'commit', backendLabel(remote, config))
    if (commitGuard.ok !== true) {
      warning = warning === '' ? commitGuard.message : `${warning}; ${commitGuard.message}`
    } else {
      try {
        const commit = await remote.commit(`dsh-sync: quarantine ${summary.quarantined} duplicate copy(ies) (${config.deviceId})`)
        committed = commit.committed === true
      } catch (error) {
        const failure = classifyBackendFailure(error, { operation: 'commit' })
        warning = warning === '' ? failure.message : `${warning}; ${failure.message}`
      }
    }
  }
  if (warning !== '') {
    // H6: отправку повторим из очереди — карантин уже состоялся.
    await queueFailedOperation(home, {
      type: 'push',
      payload: { action: 'push' },
      error: warning,
      errorKind: 'reserve',
    })
  }
  const message = summary.quarantined > 0
    ? `в карантин убрано лишних копий: ${summary.quarantined}; канонических оставлено: ${summary.kept}${warning !== '' ? `; ${warning}` : ''}`
    : summary.message
  const record = {
    ok: true,
    at: new Date().toISOString(),
    action: 'duplicates',
    mode: 'host',
    message,
    quarantined: summary.quarantined,
    quarantinedIds: (summary.quarantinedIds ?? []).slice(0, 100),
    kept: summary.kept,
    keptIds: (summary.keptIds ?? []).slice(0, 100),
    skipped: summary.skipped ?? [],
    bytes: summary.bytes ?? 0,
    reasons: summary.quarantined > 0 ? ['duplicate'] : [],
    by: summary.quarantined > 0 ? ['sync'] : [],
    committed,
    ...(warning !== '' ? { warning } : {}),
  }
  await writeLastRun(record)
  invalidateSessionStates()
  if (summary.quarantined > 0) {
    pushNotice('sync', `Дубли в карантине: ${summary.quarantined}. Лишние копии можно вернуть в карточке «Удалённые».`)
  }
  return { status: 200, body: record }
}

/**
 * H4: восстановление возвращает тот же id.
 *
 * - запрошенный id приводится к каноническому (`session-…`), иначе копия
 *   создалась бы под «новым» id;
 * - живая копия в зеркале, конфликтующая с карантинной, переносится в карантин
 *   с причиной `superseded` — ничего не теряется и не перезаписывается;
 * - `restoredFrom` (прежняя причина удаления) попадает в метку и журнал;
 * - метка становится `reason: 'restored'` (снимается restoreTombstones).
 *
 * @returns {{ status: number, body: object }} — готовый ответ маршрута
 */
async function restoreSessions(ctx, payload = {}) {
  const home = dshHome()
  const config = await loadConfig(home)
  const all = payload.all === true
  const requestedRaw = Array.isArray(payload.ids)
    ? payload.ids.filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
    : typeof payload.id === 'string' && payload.id.trim() !== ''
      ? [payload.id.trim()]
      : []
  if (!all && requestedRaw.length === 0) {
    return { status: 400, body: { ok: false, code: 'request/invalid', message: 'нужен id сессии или all:true' } }
  }

  const tombstonesBefore = await readTombstones(config.repoDir)
  const resolved = resolveTombstoneIds({ tombstones: tombstonesBefore, ids: requestedRaw, all })
  const canonicalRequested = resolved.canonical.length > 0
    ? resolved.canonical
    : requestedRaw.map(canonicalRestoreId).filter(id => id !== '')
  const storedIds = resolved.stored.length > 0 ? resolved.stored : canonicalRequested
  const queuePayload = all ? { all: true } : { ids: canonicalRequested.length > 0 ? canonicalRequested : storedIds }
  const queueRestore = async (message, errorKind = '') => {
    await queueFailedOperation(home, { type: 'restore', payload: queuePayload, error: message, errorKind })
  }

  // Сначала актуализируем зеркало (только если в git-дереве нет
  // несохранённых изменений — иначе затёрли бы, например, свежее надгробие).
  const remote = await createRemote(config)
  const syncGuard = backendGuard(remote, 'sync', backendLabel(remote, config))
  if (syncGuard.ok !== true) {
    // H5+H6: метод недоступен — понятное сообщение и операция в очереди.
    await queueRestore(syncGuard.message, 'reserve')
    return {
      status: 409,
      body: {
        ok: false,
        code: syncGuard.code,
        message: `${syncGuard.message}; восстановление сохранено в очереди`,
        queued: true,
      },
    }
  }
  let canSync = true
  if (config.backend === 'git' && existsSync(config.repoDir)) {
    canSync = !(await hasChanges(config.repoDir))
  }
  if (canSync) {
    try {
      const synced = await remote.sync()
      if (synced === false) {
        const message = 'не удалось получить зеркало — восстановление отменено, повторите после синхронизации'
        await queueRestore(message, 'network')
        return { status: 409, body: { ok: false, code: 'remote/unavailable', message, queued: true } }
      }
    } catch (error) {
      const failure = classifyBackendFailure(error, { operation: 'sync', kind: backendLabel(remote, config) })
      const message = `не удалось получить зеркало — восстановление отменено: ${failure.message}`
      await queueRestore(message, failure.unsupported ? 'reserve' : 'network')
      return {
        status: 409,
        body: { ok: false, code: failure.unsupported ? 'reserve/unsupported' : 'remote/unavailable', message, queued: true },
      }
    }
  }

  // D4: канонический id восстановления — по рейтингу среди копий одной сессии
  // (`rankCandidates` + `chooseCanonical`), а не просто по префиксу `session-`.
  // Если в группе дублей есть запрошенная копия, в отчёт попадут канонический id
  // (у него могут быть дети) и проигравшие копии.
  const restoreRank = []
  try {
    const requestedKeys = new Set([...canonicalRequested, ...storedIds].map(id => canonicalRestoreId(id)))
    const report = await collectDuplicateGroups({ home, config })
    for (const group of report.groups ?? []) {
      const members = (group.sessions ?? []).map(item => item.id)
      const hit = members.filter(id => requestedKeys.has(id))
      if (hit.length === 0) continue
      restoreRank.push({
        requested: hit,
        canonicalId: group.canonicalId,
        winnerId: group.winnerId ?? group.canonicalId,
        children: group.children ?? 0,
        match: group.match,
        projectId: group.projectId,
        // В карантин уходят только живые копии; уже карантинные не трогаем.
        superseded: (group.liveSupersededIds ?? group.supersededIds ?? []).filter(id => id !== group.canonicalId),
      })
    }
  } catch {
    // подбор канонического id — вспомогательный шаг, восстановление продолжается
  }

  // Защита от «новых копий»: если восстановление уже частично прошло, restore
  // не трогает существующие копии. Конфликтующая живая копия уйдёт в карантин
  // с причиной superseded, а удалённая вернётся на её место.
  const superseded = []
  for (const id of all ? canonicalRequested : (canonicalRequested.length > 0 ? canonicalRequested : storedIds)) {
    const canonical = canonicalRestoreId(id)
    const projectId = tombstoneProjectId(tombstonesBefore, canonical) || findQuarantineProject(config.repoDir, canonical)
    if (projectId === '') continue
    try {
      const moved = await quarantineSupersededCopy({
        repoDir: config.repoDir,
        projectId,
        sessionId: canonical,
        deviceId: config.deviceId,
      })
      if (moved.superseded) superseded.push({ id: canonical, projectId, dir: moved.dir, reason: 'superseded' })
    } catch {
      // карантин проигравшей копии — вспомогательный шаг
    }
  }

  const result = await restoreTombstones({
    home,
    repoDir: config.repoDir,
    projects: config.projects ?? {},
    ids: all ? undefined : storedIds,
    deviceId: config.deviceId,
    by: 'owner',
  })

  // Тот же id: канонизируем каталог и заголовок каждой восстановленной копии.
  const canonicalRestored = []
  const idFixed = []
  for (const item of result.restored ?? []) {
    const canonical = canonicalRestoreId(item.id)
    if (!canonicalRestored.includes(canonical)) canonicalRestored.push(canonical)
    const fixed = await canonicalizeRestoredCopy({ home, config, item, canonical })
    if (fixed.length > 0) idFixed.push(canonical)
  }
  result.restoredIds = canonicalRestored
  if (result.restored !== undefined) {
    result.restored = result.restored.map(item => ({ ...item, id: canonicalRestoreId(item.id) }))
  }

  // Проигравшие копии групп дублей: живая копия уезжает в карантин с причиной
  // `superseded` (каноническая остаётся), чтобы восстановление не оставило
  // рядом с восстановленной сессией её же копию под другим id.
  if (restoreRank.length > 0) {
    const restoredSet = new Set(canonicalRestored)
    const tombstonesForLosers = await readTombstones(config.repoDir)
    let losersMoved = 0
    for (const rank of restoreRank) {
      if (!restoredSet.has(rank.canonicalId)) continue
      const losers = (rank.superseded ?? []).filter(id => !restoredSet.has(id))
      if (losers.length === 0) continue
      const projectId = rank.projectId
      const projectPath = typeof config.projects?.[projectId]?.path === 'string' ? config.projects[projectId].path : ''
      try {
        const moved = await quarantineSessionCopies({
          home,
          config,
          projectId,
          projectPath,
          ids: losers,
          reason: 'superseded',
          by: 'sync',
          tombstones: tombstonesForLosers,
        })
        losersMoved += moved.moved
        for (const id of moved.movedIds) {
          superseded.push({ id, projectId, reason: 'superseded', canonicalId: rank.canonicalId })
        }
      } catch {
        // карантин проигравшей копии — вспомогательный шаг, восстановление уже сделано
      }
    }
    // Метки проигравших копий — в тот же tombstones.json, что и restored.
    if (losersMoved > 0) await writeTombstones(config.repoDir, tombstonesForLosers)
  }

  let committed = false
  let warning = ''
  const commitGuard = backendGuard(remote, 'commit', backendLabel(remote, config))
  if (commitGuard.ok !== true) {
    warning = `изменения сохранены в зеркале, но ${commitGuard.message}`
  } else {
    try {
      const commit = await remote.commit(`dsh-sync: restore sessions (${config.deviceId})`)
      committed = commit.committed === true
    } catch (error) {
      const failure = classifyBackendFailure(error, { operation: 'commit', kind: backendLabel(remote, config) })
      warning = failure.unsupported
        ? failure.message
        : `изменения сохранены в зеркале, но отправить их не удалось: ${failure.message}`
    }
  }
  if (warning !== '') {
    // H6: отправку повторим из очереди, восстановление уже сделано.
    await queueFailedOperation(home, {
      type: 'push',
      payload: { action: 'push' },
      error: warning,
      errorKind: 'reserve',
    })
  }

  // restoredFrom: прежняя причина удаления — в журнал рядом с restoredIds.
  const tombstonesAfter = await readTombstones(config.repoDir)
  const restoredFrom = {}
  for (const id of canonicalRestored) restoredFrom[id] = restoredFromOf(tombstonesAfter, id)

  const restored = result.restored?.length ?? 0
  const notes = []
  if (result.failed.length > 0) notes.push(`не удалось: ${result.failed.length}`)
  if (superseded.length > 0) notes.push(`конфликтующих копий в карантин (superseded): ${superseded.length}`)
  if (idFixed.length > 0) notes.push(`id приведён к каноническому: ${idFixed.length}`)
  const message = restored > 0
    ? `восстановлено сессий: ${restored}${notes.length > 0 ? `, ${notes.join(', ')}` : ''}`
    : result.failed.length > 0
      ? `не удалось восстановить: ${result.failed.length} (${result.failed[0].message})`
      : result.skipped.length > 0
        ? 'восстанавливать нечего: карантин истёк или метка уже снята'
        : 'восстанавливать нечего'
  const record = {
    ok: true,
    at: new Date().toISOString(),
    action: 'restore',
    mode: 'host',
    message,
    restored,
    restoredIds: canonicalRestored,
    restoredFrom,
    // D4: рейтинг копий и канонический id с детьми — в журнале восстановления.
    ...(restoreRank.length > 0
      ? {
          restoreRank: restoreRank.map(item => ({
            requested: item.requested,
            canonicalId: item.canonicalId,
            winnerId: item.winnerId,
            children: item.children,
            match: item.match,
          })),
          canonicalIds: [...new Set(restoreRank.map(item => item.canonicalId))],
        }
      : {}),
    skippedIds: result.skipped,
    failed: result.failed,
    // H4: метка удаления снята (restored), проигравшие копии — superseded.
    reasons: ['restored', ...(superseded.length > 0 ? ['superseded'] : [])],
    by: ['owner', ...(superseded.length > 0 ? ['sync'] : [])],
    ...(superseded.length > 0 ? { superseded: superseded.map(item => item.id), supersededDetails: superseded } : {}),
    ...(idFixed.length > 0 ? { idFixed } : {}),
    committed,
    ...(warning !== '' ? { warning } : {}),
  }
  await recordRun(home, record)
  invalidateSessionStates()
  return { status: 200, body: { ok: true, ...record } }
}

/**
 * Удаление копии локальной сессии из облака (H5: проверка интерфейса backend).
 * @returns {{ status: number, body: object }}
 */
async function deleteCloudCopyAction(ctx, payload = {}) {
  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  const home = dshHome()
  const config = await loadConfig(home)
  const modes = await readSessionModes(home)
  if (payload.confirm !== true) {
    const inspected = await inspectCloudCopy({ home, config, sessionId: id, modes })
    const message = inspected.ok === true
      ? 'в облаке есть копия этой локальной сессии; подтвердите удаление — локальная сессия останется'
      : inspected.message
    return { status: 409, body: { ...inspected, ok: false, code: inspected.ok === true ? 'confirm-required' : inspected.code, message } }
  }
  // Удаление должно доехать до облака: иначе копия вернётся следующим
  // приёмом. Сначала приводим зеркало к удалённой ветке (как и
  // восстановление), и только потом переносим копию в карантин: иначе
  // fetch+reset затёр бы незакоммиченные изменения. Сетевой сбой не
  // отменяет локальное удаление — метка manual ляжет в коммит при
  // следующей успешной отправке.
  let remote
  let warning = ''
  try {
    remote = await createRemote(config)
  } catch (error) {
    const failure = classifyBackendFailure(error, { operation: 'sync', kind: backendLabel(undefined, config) })
    warning = failure.message
  }
  if (remote !== undefined) {
    const syncGuard = backendGuard(remote, 'sync', backendLabel(remote, config))
    if (syncGuard.ok !== true) {
      warning = `${syncGuard.message}; удаление уйдёт при следующей синхронизации`
    } else {
      try {
        await remote.sync()
      } catch (error) {
        const failure = classifyBackendFailure(error, { operation: 'sync', kind: backendLabel(remote, config) })
        const cloudWarning = `${failure.message}; удаление уйдёт при следующей синхронизации`
        warning = warning === '' ? cloudWarning : `${warning}; ${cloudWarning}`
      }
    }
  }
  const result = await deleteCloudCopy({ home, config, sessionId: id, modes })
  if (result.ok !== true) {
    return { status: result.code === 'no-cloud-copy' ? 404 : 409, body: result }
  }
  let committed = false
  if (remote !== undefined) {
    const commitGuard = backendGuard(remote, 'commit', backendLabel(remote, config))
    if (commitGuard.ok !== true) {
      const commitWarning = `${commitGuard.message}; удаление уйдёт при следующей синхронизации`
      warning = warning === '' ? commitWarning : `${warning}; ${commitWarning}`
    } else {
      try {
        const commit = await remote.commit(`dsh-sync: delete cloud copy of local session ${id} (${config.deviceId})`)
        committed = commit.committed === true
      } catch (error) {
        const failure = classifyBackendFailure(error, { operation: 'commit', kind: backendLabel(remote, config) })
        const commitWarning = `${failure.message}; удаление уйдёт при следующей синхронизации`
        warning = warning === '' ? commitWarning : `${warning}; ${commitWarning}`
      }
    }
  }
  if (warning !== '') {
    // H6: удаление копии повторим из очереди.
    await queueFailedOperation(home, {
      type: 'delete',
      payload: { id, cloudCopy: true },
      error: warning,
      errorKind: 'reserve',
    })
  }
  const record = {
    ok: true,
    at: new Date().toISOString(),
    action: 'cloud-copy-delete',
    mode: 'host',
    message: `${result.message}${warning !== '' ? `; ${warning}` : ''}`,
    projectId: result.projectId,
    removed: 1,
    removedIds: [id],
    reasons: ['manual'],
    by: ['owner'],
    quarantined: result.quarantined === true,
    bytes: result.bytes,
    committed,
    ...(warning !== '' ? { warning } : {}),
  }
  await recordRun(home, record)
  invalidateSessionStates()
  return { status: 200, body: record }
}

/**
 * Бест-эффорт коммит зеркала для действий режима: локальное действие уже
 * сделано, сеть не должна его отменять. Ошибка возвращается строкой и уходит
 * в очередь, а не превращается в исключение.
 */
async function commitMirrorChanges(config, message) {
  let remote
  try {
    remote = await createRemote(config)
  } catch (error) {
    return { committed: false, warning: classifyBackendFailure(error, { operation: 'commit', kind: backendLabel(undefined, config) }).message }
  }
  const guard = backendGuard(remote, 'commit', backendLabel(remote, config))
  if (guard.ok !== true) return { committed: false, warning: guard.message }
  try {
    const result = await remote.commit(message)
    return { committed: result?.committed === true, warning: '' }
  } catch (error) {
    return { committed: false, warning: classifyBackendFailure(error, { operation: 'commit', kind: backendLabel(remote, config) }).message }
  }
}

/** Запись действия режима в журнал (одна точка, чтобы не дублировать запуск). */
async function recordModeAction(home, record) {
  return recordRun(home, record)
}

/** Сводка «локальная навсегда» для журнала и панели. */
function localOnlySummary(result) {
  return {
    declarations: Number(result?.declarations ?? 0) || 0,
    declaredIds: Array.isArray(result?.declaredIds) ? result.declaredIds.slice(0, 100) : [],
    removed: Number(result?.removed ?? 0) || 0,
    removedIds: Array.isArray(result?.removedIds) ? result.removedIds.slice(0, 100) : [],
    modesChanged: Number(result?.modesChanged ?? 0) || 0,
    tombstoneAdded: Number(result?.tombstoneAdded ?? 0) || 0,
  }
}

/**
 * Перед синхронизацией: опубликовать объявления в зеркале и поставить
 * локальный режим объявленным сессиям. После этого push/pull уже пропускают их
 * (движок читает `session-modes.json` и метку `made-local`).
 */
async function prepareLocalOnlyState(home, config) {
  try {
    return await enforceLocalOnly({ home, config })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * После синхронизации: если чужое устройство вернуло копию объявленной сессии
 * в зеркало — снова в карантин, метка made-local и коммит. Идемпотентно:
 * без объявлений ничего не пишет.
 */
async function reconcileLocalOnlyState(ctx, home, config) {
  const result = await prepareLocalOnlyState(home, config)
  if (result.ok !== true) return result
  if (result.changed === true) {
    const commit = await commitMirrorChanges(config, `dsh-sync: local-only sessions (${config.deviceId})`)
    result.committed = commit.committed
    if (commit.warning !== '') {
      result.warning = commit.warning
      await queueFailedOperation(home, {
        type: 'push',
        payload: { action: 'push', localOnly: true },
        error: commit.warning,
      })
    }
  }
  return result
}

/**
 * Режим «локальная / облачная» вместе с объявлением «локальная навсегда».
 *
 * Облачная → локальная: режим, объявление в зеркале, карантин копии с
 * причиной made-local и метка той же причины. Локальная → облачная: снять
 * объявление и метку, вернуть режим cloud (отправка — отдельным push).
 */
async function switchSessionMode(ctx, payload = {}) {
  const home = dshHome()
  const mode = payload.mode === MODE_LOCAL ? MODE_LOCAL : 'cloud'
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : ''
  if (workspaceId !== '') {
    // Умолчание пространства: существующим сессиям фиксируется прежний
    // режим, чтобы смена умолчания не переключала их задним числом.
    const directory = await workspaceDirectory(ctx, home)
    const workspace = directory.workspaces.find(item => item.id === workspaceId)
    const sessionIds = workspace?.sessionIds ?? Object.keys(directory.sessionWorkspace)
      .filter(sessionId => directory.sessionWorkspace[sessionId] === workspaceId)
    const result = await setWorkspaceDefaultMode(home, workspaceId, mode, { sessionIds })
    invalidateSessionStates()
    return { ok: true, scope: 'workspace', ...result }
  }
  const ids = Array.isArray(payload.ids) ? payload.ids : payload.id !== undefined ? [payload.id] : []
  // Режим группы: вместе с родителем переключаются его субагенты, иначе
  // ребёнок уехал бы в зеркало без родителя. Связи берём из заголовков
  // сессий (host-часть отдаёт `parent` без чтения логов).
  const located = await localSessionsFor(ctx, home, '')
  const groups = buildSessionGroups(located.sessions.map((session) => ({
    id: session.id,
    header: typeof session.parent === 'string' && session.parent !== ''
      ? { id: session.id, parentSession: session.parent }
      : undefined,
  })))
  const result = await setSessionMode(home, ids, mode, { groups })
  const config = await loadConfig(home)
  const affected = Array.isArray(result.ids) ? result.ids : []
  let declared = 0
  let undeclared = 0
  let quarantined = 0
  const removedIds = []
  for (const id of affected) {
    if (mode === MODE_LOCAL) {
      const local = await makeSessionLocal({ home, config, sessionId: id, options: { declaredBy: config.deviceId } })
      if (local.declared === true) declared += 1
      if (local.quarantined === true) {
        quarantined += 1
        removedIds.push(normalizeSessionId(id))
      }
    } else {
      const cloud = await makeSessionCloud({ home, config, sessionId: id })
      if (cloud.undeclared === true || cloud.tombstoneDropped === true) undeclared += 1
    }
  }
  let committed = false
  let warning = ''
  if (affected.length > 0) {
    const commit = await commitMirrorChanges(config, `dsh-sync: session mode ${mode} (${config.deviceId})`)
    committed = commit.committed
    warning = commit.warning
    if (warning !== '') {
      await queueFailedOperation(home, {
        type: 'mode',
        payload: { ids: affected, mode, declare: mode === MODE_LOCAL },
        error: warning,
      })
    }
  }
  // «Сделать облачной» отправляет сессию сразу, не дожидаясь автопушка.
  if (mode !== MODE_LOCAL && payload.push === true && affected.length > 0) {
    try {
      const record = await runSync(ctx, 'push')
      if (typeof record?.message === 'string') warning = warning === '' ? record.message : `${warning}; ${record.message}`
    } catch (error) {
      const pushWarning = error instanceof Error ? error.message : String(error)
      warning = warning === '' ? pushWarning : `${warning}; ${pushWarning}`
    }
  }
  invalidateSessionStates()
  const body = {
    ok: true,
    ...result,
    localOnly: {
      mode,
      declared,
      undeclared,
      quarantined,
      removedIds,
      declarations: (await localOnlyState({ home, config })).ids.length,
    },
    committed,
    ...(warning !== '' ? { warning } : {}),
  }
  if (mode === MODE_LOCAL) {
    body.message = quarantined > 0
      ? `сессии локальные навсегда: облачных копий убрано ${quarantined}`
      : 'сессии локальные навсегда: облачных копий не было'
  } else {
    body.message = undeclared > 0
      ? 'сессии снова облачные: объявление локальности снято'
      : 'сессии облачные'
  }
  return body
}

/**
 * «Убрать облачные копии локальных сессий»: миграция старых локальных сессий,
 * у которых в зеркале осталась копия. Без confirm:true — только показывает
 * найденное (409), с подтверждением — карантин made-local и коммит.
 */
async function runLocalOnlyMigration(ctx, payload = {}) {
  const home = dshHome()
  const config = await loadConfig(home)
  const inspected = await localOnlyMigrationCandidates({ home, config })
  if (payload.confirm !== true) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'confirm-required',
        count: inspected.count,
        sessions: inspected.sessions,
        message: inspected.count === 0
          ? 'облачных копий локальных сессий нет — убирать нечего'
          : `в облаке остались копии локальных сессий: ${inspected.count}; подтвердите удаление копий — сами сессии останутся`,
      },
    }
  }
  const removedIds = []
  const projects = new Set()
  for (const candidate of inspected.sessions) {
    const result = await makeSessionLocal({ home, config, sessionId: candidate.id, options: { declaredBy: config.deviceId } })
    if (result.quarantined === true) {
      removedIds.push(candidate.id)
      if (candidate.projectId !== undefined) projects.add(candidate.projectId)
    }
  }
  // Коммит и повторная проверка остатка — так же, как после переключения режима.
  const reconcile = await reconcileLocalOnlyState(ctx, home, config)
  const message = removedIds.length > 0
    ? `облачных копий убрано: ${removedIds.length}; сессии остались локальными`
    : 'убирать нечего: облачных копий локальных сессий нет'
  const record = {
    ok: true,
    at: new Date().toISOString(),
    action: 'local-only-migration',
    mode: 'host',
    message: `${message}${reconcile.warning !== undefined ? `; ${reconcile.warning}` : ''}`,
    removed: removedIds.length,
    removedIds,
    projects: [...projects],
    reasons: ['made-local'],
    by: ['owner'],
    quarantined: removedIds.length,
    declarations: Number(reconcile.declarations ?? 0) || 0,
    committed: reconcile.committed === true,
    ...(reconcile.warning !== undefined ? { warning: reconcile.warning } : {}),
  }
  await recordModeAction(home, record)
  invalidateSessionStates()
  return { status: 200, body: record }
}

/**
 * H6: цикл разбора очереди. Обработчики повторяют операции теми же путями, что
 * и кнопки панели; таймаут короткий, чтобы закрытие DSH не ждало сеть.
 */
export async function flushOutboxCycle(ctx, options = {}) {
  const home = dshHome()
  if (automation.flushing) {
    return { skipped: true, remaining: (await outboxSummary(home)).count }
  }
  automation.flushing = true
  try {
    const summary = await outboxSummary(home)
    if (summary.count === 0) return { skipped: false, flushed: 0, failed: 0, remaining: 0 }
    const config = await loadConfig(home)
    const handlers = {
      push: async (operation) => {
        // H5: резерв без метода не зовём — сообщаем и оставляем в очереди.
        // Проверяем только операции про резерв: обычный push идёт в зеркало.
        if (operation?.payload?.secondary === true) {
          const secondaryCheck = secondaryOperationSupported(config, 'sync')
          if (secondaryCheck.ok !== true) return { ok: false, message: secondaryCheck.message }
        }
        const record = await runSync(ctx, 'push')
        return { ok: record?.ok === true, message: typeof record?.message === 'string' ? record.message : '' }
      },
      delete: async (operation) => {
        const payload = { ...(operation.payload ?? {}), confirm: true }
        if (payload.cloudCopy === true) {
          const result = await deleteCloudCopyAction(ctx, { id: payload.id, confirm: true })
          return { ok: result.body?.ok === true, message: result.body?.message ?? '' }
        }
        const record = await runPrune(ctx, payload)
        return { ok: record?.ok === true, message: typeof record?.message === 'string' ? record.message : '' }
      },
      restore: async (operation) => {
        const result = await restoreSessions(ctx, operation.payload ?? {})
        return { ok: result.body?.ok === true, message: result.body?.message ?? '' }
      },
      mode: async (operation) => {
        // Повтор смены режима идёт тем же путём, что и кнопка: объявление,
        // карантин копии и коммит. Идемпотентно — дублей не создаёт.
        const body = await switchSessionMode(ctx, operation.payload ?? {})
        return { ok: body?.ok === true, message: typeof body?.message === 'string' ? body.message : '' }
      },
    }
    const outcome = await flushOutbox(home, {
      handlers,
      opTimeoutMs: options.opTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
    })
    if (outcome.flushed.length > 0 || outcome.failed.length > 0) {
      invalidateSessionStates()
    }
    return outcome
  } catch (error) {
    return { skipped: false, flushed: 0, failed: 0, remaining: (await outboxSummary(home)).count, message: error instanceof Error ? error.message : String(error) }
  } finally {
    automation.flushing = false
  }
}

function startAutomation(ctx) {
  automation.enabled = true
  void ensureProjectDefaults(ctx).catch(() => {})
  ctx.effect(() => {
    const initial = setTimeout(() => {
      void autoTick(ctx)
    }, 3_000)
    initial.unref?.()
    const timer = setInterval(() => {
      void autoTick(ctx)
    }, 60_000)
    timer.unref?.()

    // H6: очередь невыполненных операций разбираем при старте и по таймеру.
    const outboxStart = setTimeout(() => {
      void flushOutboxCycle(ctx, { opTimeoutMs: 20_000, totalTimeoutMs: 30_000 })
    }, 12_000)
    outboxStart.unref?.()
    const outboxTimer = setInterval(() => {
      void flushOutboxCycle(ctx, { opTimeoutMs: 60_000, totalTimeoutMs: 90_000 })
    }, 90_000)
    outboxTimer.unref?.()

    // Быстрый сторож удалений: плагин удаления сессий убирает её из рабочего
    // пространства, а список меняется сразу. Проверяем каждые 5 секунд, чтобы
    // удаление уезжало в зеркало почти мгновенно, без ожидания минуты.
    automation.workspaceCount = countWorkspaceSessions(ctx)
    const watcher = setInterval(() => {
      if (automation.running) return
      const now = countWorkspaceSessions(ctx)
      if (automation.workspaceCount !== undefined && now < automation.workspaceCount) {
        automation.workspaceCount = now
        if (!automation.workspacePushPending) {
          automation.workspacePushPending = true
          void runSync(ctx, 'push')
            .catch(() => {})
            .finally(() => {
              automation.workspacePushPending = false
            })
        }
      } else {
        automation.workspaceCount = now
      }
    }, 5_000)
    watcher.unref?.()

    automation.timer = timer
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
      clearInterval(watcher)
      clearTimeout(outboxStart)
      clearInterval(outboxTimer)
      automation.enabled = false
      // Последний разбор очереди при закрытии: короткий таймаут (5–10 с),
      // выход DSH не блокируем — операция останется в файле до следующего старта.
      void Promise.race([
        flushOutboxCycle(ctx, {
          opTimeoutMs: OUTBOX_SHUTDOWN_TIMEOUT_MS,
          totalTimeoutMs: OUTBOX_SHUTDOWN_TIMEOUT_MS,
        }),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, OUTBOX_SHUTDOWN_TIMEOUT_MS + 500)
          timer.unref?.()
        }),
      ])
    }
  }, 'dsh-sync: automation')
}

/** Периодическая проверка обновлений: первая через полминуты, дальше раз в 6 часов. */
function startUpdateWatch(ctx) {
  ctx.effect(() => {
    let stopped = false
    let timer
    const tick = async () => {
      if (stopped) return
      try {
        const fresh = await checkForUpdate(() => resolveGitHubToken(ctx))
        if (fresh.status === 'behind' && fresh.latest !== announcedVersion) {
          announcedVersion = fresh.latest
          pushNotice('update', `Доступна новая версия dsh-sessions (${String(fresh.latest).slice(0, 7)}). Обновить можно в карточке плагина.`)
          pushNotice('update', 'Новая версия установится автоматически после короткой паузы.')
          setTimeout(() => {
            try {
              applyUpdate(ctx)
            } catch {
              // менеджер плагинов может быть недоступен — не критично
            }
          }, 120_000).unref?.()
        }
      } catch (error) {
        pushNotice('error', `Проверка обновлений не удалась: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), UPDATE_CHECK_INTERVAL_MS)
        timer.unref?.()
      }
    }
    const first = setTimeout(() => void tick(), 30_000)
    first.unref?.()
    return () => {
      stopped = true
      clearTimeout(first)
      clearTimeout(timer)
    }
  }, 'dsh-sync: update watch')
}

export function apply(ctx) {
  void migrateSecret(ctx)

  void noteInstalledVersion().then((from) => {
    updatedFromVersion = from
  })

  // Встроенный плагин удаления: свой код, свои маршруты, своя область отказа.
  try {
    applyDeletePlugin(ctx)
  } catch (error) {
    console.error('[dsh-sessions] удаление сессий недоступно:', error)
  }

  const failures = []

  const route = (label, path, handler) => {
    try {
      ctx.effect(() => ctx.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      }), `dsh-sync: ${label}`)
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  route('state', STATE_PATH, async () => json(await readState(ctx)))

  // Самопроверка версии: сравнивает закреплённый коммит с `main` в репозитории
  // и по явному нажатию просит менеджер плагинов переустановить пакет.
  const resolveUpdateToken = async () => {
    try {
      const credentials = ctx.get('credentials')
      const hit = await credentials?.resolve('GITHUB_TOKEN')
      return hit?.value
    } catch {
      return undefined
    }
  }

  void checkForUpdate(resolveUpdateToken)

  route('update', UPDATE_PATH, async () => json({ ok: true, ...updateState(), description: describeUpdate() }))

  route('update-apply', UPDATE_APPLY_PATH, async () => {
    const fresh = await checkForUpdate(resolveUpdateToken)
    const result = applyUpdate(ctx)
    return json({
      ok: result.started,
      code: result.started ? 'scheduled' : 'no-op',
      message: result.reason,
      status: fresh.status,
      installed: fresh.installed,
      latest: fresh.latest,
    })
  })

  route('config', CONFIG_PATH, async (request) => {
    try {
      return json(await saveSettings(ctx, await body(request)))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // Сверка резервного канала: сравнить локальное с облаком, принять облачные
  // сессии до первой отправки и поднять флаг secondary.initialized.
  route('secondary-init', SECONDARY_INIT_PATH, async () => {
    try {
      const home = dshHome()
      const config = await loadConfig(home)
      const result = await initializeSecondaryChannel({
        home,
        config,
        secondary: secondaryConfig(config),
        dshVersion: await hostDshVersion(),
      })
      if (result.ok === true) {
        // Принятые из облака сессии привязываем к рабочим пространствам — так же,
        // как после обычного приёма.
        try {
          const attached = await attachAllProjects(ctx, config)
          if (attached > 0) result.attached = attached
        } catch {
          // привязка — вспомогательный шаг
        }
        try {
          const queued = await applyWorkspacePending(ctx, config)
          if (queued > 0) result.workspaceAttached = queued
        } catch {
          // привязка из зеркала — вспомогательный шаг
        }
        invalidateSessionStates()
      }
      return json(result)
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('run', RUN_PATH, async (request) => {
    const payload = await body(request)
    const action = ['sync', 'pull', 'push'].includes(payload.action) ? payload.action : 'sync'
    try {
      return json(await runSync(ctx, action, { confirmPrune: payload.confirmPrune === true }))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // «Проверить»: план обмена, только чтение. Ничего не удаляет, не пишет и не
  // трогает журнал — интерфейс показывает корзины и подпись «ничего не изменено».
  route('plan', PLAN_PATH, async () => {
    try {
      return json(await runPlan(ctx))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // «Применить удаления (N)»: единственный путь удаления из зеркала.
  // Без confirm:true маршрут возвращает 409 и просит подтверждение.
  route('prune', PRUNE_PATH, async (request) => {
    try {
      const payload = await body(request)
      const result = await runPrune(ctx, payload)
      const status = result?.code === 'confirm-required' ? 409 : result?.ok === false ? 500 : 200
      return json(result, status)
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('create-repo', CREATE_REPO_PATH, async () => {
    try {
      return json(await createRepository(ctx))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('diagnostics', DIAG_PATH, async () => {
    try {
      const probe = await runCapture('git', ['--version'])
      const gitVersion = probe.code === 0 ? probe.stdout.trim().replace(/^git version\s*/, '') : 'не найден'
      const report = await collectDiagnostics(dshHome(), { gitVersion })
      return json({ ok: true, report })
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('sessions', SESSIONS_PATH, async () => {
    try {
      return json(await sessionStates(ctx))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // «Удалённые»: список надгробий зеркала — что, когда, кем и почему удалено,
  // сколько дней осталось до конца 30-дневного карантина.
  route('tombstones', TOMBSTONES_PATH, async () => {
    try {
      const home = dshHome()
      const config = await loadConfig(home)
      const sessions = await listTombstones({
        home,
        repoDir: config.repoDir,
        projects: config.projects ?? {},
      })
      // H2: «Удалённые» тоже показывают название, а не только id.
      for (const row of sessions) {
        const resolved = await resolveTombstoneTitle({
          sessionId: row.id,
          title: row.title,
          repoDir: config.repoDir,
          projectId: row.projectId,
          home,
          projectPath: config.projects?.[row.projectId]?.path,
        })
        row.title = resolved.title
        row.rawTitle = resolved.rawTitle
        row.shortId = resolved.shortId
        row.titleSource = resolved.titleSource
      }
      return json({
        ok: true,
        quarantineDays: QUARANTINE_DAYS,
        count: sessions.length,
        sessions,
      })
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // «Найти дубли»: группы копий одной сессии (локально + зеркало + карантин).
  // Только чтение — как и «Проверить», ничего не меняет и в журнал не пишет.
  route('duplicates', DUPLICATES_PATH, async (request) => {
    try {
      const payload = await body(request)
      return json(await runDuplicatesScan(ctx, payload))
    } catch (error) {
      return json({ ok: false, action: 'duplicates', message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // «Убрать дубли в карантин»: без confirm:true маршрут отвечает 409.
  route('duplicates-quarantine', DUPLICATES_QUARANTINE_PATH, async (request) => {
    try {
      const result = await runDuplicatesQuarantine(ctx, await body(request))
      return json(result.body, result.status)
    } catch (error) {
      return json({ ok: false, action: 'duplicates', message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // Восстановление: снять надгробие (пометить restored), вернуть карантинную
  // копию зеркала и локальную копию из архива, затем закоммитить зеркало.
  route('restore', RESTORE_PATH, async (request) => {
    try {
      const result = await restoreSessions(ctx, await body(request))
      return json(result.body, result.status)
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // Режим «локальная / облачная»: одна сессия или группа (массово).
  // payload.workspaceId — умолчание рабочего пространства для новых сессий.
  // «Локальная» = локальная навсегда: объявление в зеркале, карантин копии,
  // метка made-local. «Облачная» снимает объявление и возвращает режим cloud.
  route('session-mode', SESSION_MODE_PATH, async (request) => {
    let requestPayload = {}
    try {
      const payload = await body(request)
      requestPayload = payload
      return json(await switchSessionMode(ctx, payload))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // H6: смена режима не теряется — повторим из очереди.
      const ids = Array.isArray(requestPayload?.ids)
        ? requestPayload.ids
        : requestPayload?.id !== undefined ? [requestPayload.id] : []
      await queueFailedOperation(dshHome(), {
        type: 'mode',
        payload: {
          ids,
          mode: requestPayload?.mode === MODE_LOCAL ? MODE_LOCAL : 'cloud',
          declare: requestPayload?.mode === MODE_LOCAL,
        },
        error: message,
      })
      return json({ ok: false, message, queued: true }, 500)
    }
  })

  // «Убрать облачные копии локальных сессий»: миграция режима «локальная
  // навсегда». Без confirm:true — 409 и список найденного, с confirm — карантин.
  route('local-only-migration', LOCAL_ONLY_MIGRATION_PATH, async (request) => {
    try {
      const result = await runLocalOnlyMigration(ctx, await body(request))
      return json(result.body, result.status)
    } catch (error) {
      return json({ ok: false, action: 'local-only-migration', message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // «Удалить копию из облака»: только у локальной сессии, только зеркальная
  // копия, локальный лог цел. Без confirm:true маршрут показывает, что найдено,
  // и просит подтверждение (окно-подтверждение в панели — клиентская часть).
  route('session-cloud-copy', SESSION_CLOUD_COPY_PATH, async (request) => {
    try {
      const result = await deleteCloudCopyAction(ctx, await body(request))
      return json(result.body, result.status)
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('profile', PROFILE_PATH, async (request) => {
    try {
      const payload = await body(request)
      const action = typeof payload.action === 'string' ? payload.action : 'status'
      const home = dshHome()
      if (action === 'attach') {
        // «Привязать»: добираем сессии, которых нет ни в одном пространстве.
        const config = await loadConfig(home)
        const attachedTotal = await attachAllProjects(ctx, config)
        const queued = await applyWorkspacePending(ctx, config)
        invalidateSessionStates()
        return json({ ok: true, attached: attachedTotal, queued })
      }
      if (action === 'attach-workspace') {
        const config = await loadConfig(home)
        const projectId = typeof payload.projectId === 'string' ? payload.projectId : ''
        const requested = typeof payload.path === 'string' ? payload.path : ''
        // Запись из зеркала может ссылаться на проект, путь которого здесь
        // другой: привязываем к локальному пути проекта, а не к пути из зеркала.
        const configured = projectId !== '' ? config.projects?.[projectId]?.path : undefined
        const path = typeof configured === 'string' && configured !== '' ? configured : requested
        const ids = Array.isArray(payload.sessionIds) ? payload.sessionIds.filter(id => typeof id === 'string') : []
        if (path === '' || ids.length === 0) return json({ ok: false, message: 'нужен путь и список сессий' }, 400)
        const attached = await attachSessions(ctx, path, ids)
        await applyWorkspacePending(ctx, config)
        invalidateSessionStates()
        return json({ ok: true, attached })
      }
      if (action === 'apply-pending') {
        const queued = await applyWorkspacePending(ctx, await loadConfig(home))
        return json({ ok: true, queued })
      }
      if (action === 'journal') {
        const config = await loadConfig(home)
        const journal = await readJournal(config.repoDir)
        return json({ ok: true, entries: journal.entries.slice(-50) })
      }
      if (action === 'plan') {
        // Перестроить план приёма вручную (например, после обновления зеркала
        // другим устройством) — локальные файлы не меняются.
        const config = await loadConfig(home)
        const { createNeutralizer } = await import('./lib/neutralize.mjs')
        const neutralizer = createNeutralizer({ home: homedir(), dshHome: home })
        return json(await refreshProfilePlan({ home, config, neutralizer }))
      }
      if (action === 'auto-apply') {
        // Ручной режим по умолчанию; авто-применение — только явным включением.
        const config = await loadConfig(home)
        config.profile = { ...(config.profile ?? { enabled: true }), enabled: true, autoApply: payload.enabled === true }
        await saveConfig(home, config)
        return json({ ok: true, autoApply: config.profile.autoApply === true })
      }
      return json(await profileStatus(ctx))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // Применение плана профиля: «сначала показать, потом применить».
  // action=apply — применить отложенный план, discard — отменить, plan — перестроить.
  route('profile-apply', PROFILE_APPLY_PATH, async (request) => {
    try {
      const payload = await body(request)
      const action = typeof payload.action === 'string' ? payload.action : 'apply'
      const home = dshHome()
      if (action === 'discard') {
        return json(await discardProfilePlan(home))
      }
      const config = await loadConfig(home)
      const { createNeutralizer } = await import('./lib/neutralize.mjs')
      const neutralizer = createNeutralizer({ home: homedir(), dshHome: home })
      if (action === 'plan') {
        return json(await refreshProfilePlan({ home, config, neutralizer }))
      }
      const result = await applyPendingProfile({ home, config, neutralizer })
      if (result.ok === true && (result.applied ?? 0) > 0) {
        pushNotice('sync', `Профиль обновлён: применено файлов ${result.applied}`)
        invalidateSessionStates()
      }
      return json(result)
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // Браузерные настройки (dsh-polish, dsh-cards): localStorage не виден host-части,
  // поэтому клиент приносит значения сам и забирает очередь после приёма.
  route('browser-settings', BROWSER_SETTINGS_PATH, async (request) => {
    try {
      const payload = await body(request)
      const home = dshHome()
      if (payload.applied === true) {
        await clearPendingBrowserSettings(home)
        return json({ ok: true, applied: true })
      }
      if (payload.current !== undefined) {
        await writeBrowserSettings(home, payload.current)
      }
      const pending = await readPendingBrowserSettings(home)
      return json({ ok: true, stored: payload.current !== undefined, pending })
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('yandex-check', YANDEX_CHECK_PATH, async (request) => {
    try {
      const payload = await body(request)
      const config = await loadConfig(dshHome())
      const token = typeof payload.yandexToken === 'string' && payload.yandexToken.trim() !== ''
        ? payload.yandexToken.trim()
        : config.yandexToken
      const backend = payload.backend === 'webdav' ? 'webdav' : 'yandex'
      const result = backend === 'webdav'
        ? await probeWebdav({
            repoDir: config.repoDir,
            webdavLogin: typeof payload.webdavLogin === 'string' && payload.webdavLogin.trim() !== '' ? payload.webdavLogin.trim() : config.webdavLogin,
            webdavPassword: typeof payload.webdavPassword === 'string' && payload.webdavPassword.trim() !== '' ? payload.webdavPassword.trim() : config.webdavPassword,
            webdavPath: typeof payload.webdavPath === 'string' && payload.webdavPath.trim() !== '' ? payload.webdavPath.trim() : config.webdavPath,
          })
        : await probeYandex({
        backend: 'yandex',
        repoDir: config.repoDir,
        yandexToken: token,
        yandexPath: typeof payload.yandexPath === 'string' && payload.yandexPath.trim() !== '' ? payload.yandexPath.trim() : config.yandexPath,
      })
      return json(result)
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('ack-update', ACK_UPDATE_PATH, async () => {
    await clearPendingUpdate()
    return json({ ok: true })
  })

  route('notifications', NOTIFICATIONS_PATH, async (request) => {
    const payload = await body(request)
    const since = Number(payload?.since ?? 0)
    return json({ ok: true, items: notices.filter(item => item.id > since), cursor: noticeSeq })
  })

  const tool = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      failures.push(`tool ${definition.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  tool({
    name: 'sync_status',
    description: 'Показать состояние синхронизации сессий DSH: окружение, настройки, счётчики и последний запуск. Вызывайте перед любой операцией синхронизации.',
    parameters: { type: 'object', properties: {} },
    output: TEXT_OUTPUT,
    async execute() {
      const state = await readState(ctx)
      const lines = []
      lines.push(`устройство: ${state.deviceId ?? '?'}`)
      lines.push(`репозиторий: ${state.config?.remote || 'не задан'}`)
      lines.push(`проект: ${state.config?.projectId || '?'} → ${state.config?.projectPath || '?'}`)
      lines.push(`режим: ${state.mode === 'external' ? `через внешний плагин ${state.external.name}` : 'встроенный движок'}`)
      if (state.external?.found && !state.external.callable) {
        lines.push(`внимание: установлен ${state.external.name}, но без программного интерфейса — активен встроенный движок`)
      }
      for (const check of state.checks) {
        lines.push(`${check.ok ? 'OK' : 'НЕТ'} ${check.title}: ${check.detail}`)
      }
      if (state.status) {
        lines.push(`сессий локально: ${state.status.local}, в зеркале: ${state.status.mirror}`)
      }
      if (state.modes) {
        lines.push(`режимы сессий: локальных ${state.modes.local}, облачных ${state.modes.cloud}`)
      }
      if (state.profile?.profile !== undefined) {
        const profile = state.profile.profile
        lines.push(`профиль: ${profile.available ? profile.profileDir : 'каталог профиля не найден'}`)
        if (profile.available) {
          lines.push(`  патч: ${(profile.patch?.entries ?? []).join(', ') || 'нет безопасных записей'}; плагинов: ${profile.bundles?.count ?? 0}; конфликтов: ${profile.conflictCount ?? 0}`)
          lines.push(`  доп. данные: расходов ${profile.extras?.expenses ?? 0}, задач ${profile.extras?.schedule ?? 0}, «Входящие»: настроек ${profile.extras?.inbox ?? 0}`)
          lines.push(`  применение профиля: ${profile.autoApply ? 'авто без конфликтов' : 'вручную (кнопка «Применить»)'}; ${profile.plan?.present ? `план ждёт применения: ${profile.plan.files} файлов` : 'плана нет'}`)
        }
      }
      if (state.workspace?.hints?.length > 0) {
        lines.push(`не привязано рабочих пространств: ${state.workspace.hints.length}`)
      }
      if (state.lastRun) {
        lines.push(`последний запуск: ${state.lastRun.at} — ${state.lastRun.ok ? 'успешно' : 'ошибка'}: ${state.lastRun.message}`)
        const skippedLocal = Number(state.lastRun.skippedLocal ?? 0) || 0
        if (skippedLocal > 0) {
          lines.push(`  локальных сессий пропущено: ${skippedLocal}${(state.lastRun.localMirrorProtected ?? 0) > 0 ? ` (копий в зеркале защищено: ${state.lastRun.localMirrorProtected})` : ''}`)
        }
        // D2: импорт-дубли — копии не создавались, причина `duplicate`.
        const duplicatesSkipped = Number(state.lastRun.duplicatesSkipped ?? 0) || 0
        if (duplicatesSkipped > 0) {
          lines.push(`  копий-дублей при импорте пропущено: ${duplicatesSkipped}`)
        }
        // Отложенные удаления: push их не выполняет, нужно отдельное
        // подтверждённое действие «Применить удаления».
        const pendingDeletions = Number(state.lastRun.skippedDeletions?.removed ?? 0) || 0
        if (pendingDeletions > 0) {
          lines.push(`  удалений: ${pendingDeletions} (ждёт подтверждения)`)
        }
        const plan = state.lastRun.plan
        if (plan?.counts !== undefined) {
          lines.push(`  план: только локально ${plan.counts.onlyLocal ?? 0}, только в зеркале ${plan.counts.onlyCloud ?? 0}, локально новее ${plan.counts.localAhead ?? 0}, в зеркале новее ${plan.counts.cloudAhead ?? 0}, конфликтов ${plan.counts.conflicts ?? 0}, дублей ${plan.counts.duplicates ?? 0}, удалений ${plan.deletions ?? 0}`)
        }
      }
      if (state.automation) {
        const auto = state.automation
        lines.push(`автосинхронизация: ${auto.enabled ? 'вкл' : 'выкл'}${auto.running ? ' (выполняется)' : ''}`)
        lines.push(`  приём: ${auto.lastPullAt ?? 'ещё не было'}, отправка: ${auto.lastPushAt ?? 'ещё не было'}${auto.lastError ? `, ошибка: ${auto.lastError}` : ''}`)
      }
      return lines.join('\n')
    },
  })

  tool({
    name: 'sync_run',
    description: 'Синхронизировать сессии DSH с зеркалом: принять удалённые изменения и отправить локальные. Требует настроенного плагина dsh-sync.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['sync', 'pull', 'push'],
          description: 'sync — принять и отправить (по умолчанию), pull — только принять, push — только отправить.',
        },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = ['sync', 'pull', 'push'].includes(args?.action) ? args.action : 'sync'
      const record = await runSync(ctx, action)
      return `${record.ok ? 'OK' : 'ОШИБКА'}: ${record.message}`
    },
  })

  startAutomation(ctx)
  startUpdateWatch(ctx)
  void writeStatus({ applied: true, pid: process.pid, failures })
}

/** Записать отметку о загрузке host-части: помогает диагностировать «404». */
async function writeStatus(patch) {
  try {
    const dir = join(dshHome(), 'dsh-sync')
    await mkdir(dir, { recursive: true })
    const file = join(dir, PLUGIN_STATUS_FILE)
    let current = {}
    try {
      current = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      current = {}
    }
    await writeFile(file, `${JSON.stringify({ ...current, ...patch, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch {
    // диагностика не должна мешать загрузке
  }
}

//

// Отметка о загрузке модуля: по ней видно, дошло ли дело до host-части вообще.
void writeStatus({ imported: true })
