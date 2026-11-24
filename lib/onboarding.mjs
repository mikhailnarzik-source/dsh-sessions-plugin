/**
 * M4: онбординг нового устройства — чистая логика без файлов и сети.
 *
 * `collectOnboarding(input)` собирает шаги «что проверить на новом
 * компьютере» и два информационных блока: песочница/доступы и секреты.
 * Вход — уже добытые host-частью факты (наличие рефов, версии, конфликты
 * профиля, состояние репозитория). Модуль ничего не читает сам и никогда не
 * возвращает значений секретов: только «есть/нет», без `value`, `masked` и
 * источников. Это позволяет отдавать результат в браузер без риска утечки.
 *
 * Статусы шага: `ok` — всё в порядке; `warn` — работает, но есть риск;
 * `fail` — нужно исправить, иначе синхронизация не заработает; `todo` —
 * ещё не настроено (ожидаемое действие пользователя).
 *
 * `ready` — можно работать: нет ни одного `fail`/`todo`. Предупреждения
 * (`warn`) не блокируют готовность, но видны в карточке. `count` — сколько
 * шагов требуют действия (fail + todo): именно это число показывает чип.
 */

/** Минимальная версия DSH, с которой работает M4-набор. */
export const DSH_MIN_VERSION = '0.2.3-alpha.2'

/**
 * Рефы credential store, которые показывает блок «Секреты».
 * `need` — когда реф обязателен: `git` (основное хранилище в git),
 * `reserve` (резерв WebDAV), `model` (модель DeepSeek), `optional`.
 */
export const SECRET_REFS = [
  {
    id: 'GITHUB_TOKEN',
    ref: 'refs.GITHUB_TOKEN',
    title: 'GitHub-токен',
    purpose: 'доступ к приватному репозиторию зеркала и проверка обновлений',
    need: 'git',
  },
  {
    id: 'DEEPSEEK_API_KEY',
    ref: 'refs.DEEPSEEK_API_KEY',
    title: 'Ключ DeepSeek API',
    purpose: 'модель DeepSeek в DSH на этом устройстве',
    need: 'model',
  },
  {
    id: 'DSH_SYNC_WEBDAV_PASSWORD',
    ref: 'refs.DSH_SYNC_WEBDAV_PASSWORD',
    title: 'Пароль WebDAV резерва',
    purpose: 'резервный канал через Яндекс.Диск (WebDAV)',
    need: 'reserve',
  },
  {
    id: 'DSH_VAULT_PASSPHRASE',
    ref: 'refs.DSH_VAULT_PASSPHRASE',
    title: 'Пароль сейфа DSH',
    purpose: 'шифрование сейфа и импорт секретов с другого устройства',
    need: 'optional',
  },
]

const STEP_ORDER = [
  'tools',
  'dsh-version',
  'github-token',
  'deepseek-key',
  'webdav-password',
  'vault-passphrase',
  'profile',
  'sync',
  'local-copies',
  'workspace',
]

/** Разобрать semver в `{ main: [major, minor, patch], pre: string[] }` (или null). */
export function parseVersion(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(value))
  if (match === null) return null
  const main = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (main.some(part => !Number.isFinite(part))) return null
  const pre = match[4] === undefined ? [] : match[4].split('.').filter(part => part !== '')
  return { main, pre }
}

/**
 * Сравнить две версии по semver, включая prerelease-суффиксы.
 * @returns {number} -1, 0 или 1; нераспознанные версии считаются равными.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.main[index] !== b.main[index]) return a.main[index] < b.main[index] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  // Версия без prerelease старше такой же с prerelease.
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.pre[index]
    const rightPart = b.pre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/.test(leftPart)
    const rightNumber = /^\d+$/.test(rightPart)
    if (leftNumber && rightNumber) {
      const x = Number(leftPart)
      const y = Number(rightPart)
      if (x !== y) return x < y ? -1 : 1
      continue
    }
    // Числовой идентификатор всегда младше буквенного (правило semver).
    if (leftNumber) return -1
    if (rightNumber) return 1
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/** Версия не меньше минимальной. Нераспознанная версия — `false`. */
export function isVersionAtLeast(version, minimum = DSH_MIN_VERSION) {
  if (parseVersion(version) === null) return false
  return compareVersions(version, minimum) >= 0
}

/** Убрать логин/пароль из URL репозитория: в интерфейс уходит адрес без секретов. */
export function sanitizeRemote(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  try {
    const url = new URL(text)
    if (url.username !== '' || url.password !== '') {
      url.username = ''
      url.password = ''
    }
    return url.toString()
  } catch {
    // Не URL (SSH-строка вида git@host:path) — только на всякий случай режем user:pass@.
    return text.replace(/\/\/[^/@\s]+@/g, '//')
  }
}

/** Наличие рефов: принимает `{ ID: { configured } }` или `{ ID: boolean }`. */
function refPresent(refs, id) {
  const entry = refs?.[id]
  if (entry === true) return true
  if (entry === false || entry === undefined || entry === null) return false
  return entry.configured === true || entry.present === true
}

function refsOf(input) {
  const refs = input?.refs ?? {}
  const list = SECRET_REFS.map((secret) => ({
    id: secret.id,
    ref: secret.ref,
    title: secret.title,
    purpose: secret.purpose,
    need: secret.need,
    present: refPresent(refs, secret.id),
  }))
  return list
}

function secretById(secrets, id) {
  return secrets.find(secret => secret.id === id) ?? { present: false }
}

/** Версии git/Node строкой: «Node v24.1.0 · git 2.50.0». */
function toolsDetail(tools) {
  const parts = []
  const nodeVersion = typeof tools?.node?.version === 'string' ? tools.node.version.trim() : ''
  const gitVersion = typeof tools?.git?.version === 'string' ? tools.git.version.trim() : ''
  parts.push(nodeVersion === '' ? (tools?.node?.ok === true ? 'Node.js: есть' : 'Node.js: нет') : `Node ${nodeVersion}`)
  parts.push(gitVersion === '' ? (tools?.git?.ok === true ? 'git: есть' : 'git: нет') : `git ${gitVersion}`)
  return parts.join(' · ')
}

function syncContext(input) {
  const sync = input?.sync ?? {}
  const backend = typeof sync.backend === 'string' && sync.backend !== '' ? sync.backend : 'git'
  return {
    backend,
    git: backend === 'git',
    webdav: backend === 'webdav',
    yandex: backend === 'yandex',
    folder: backend === 'folder',
    configured: sync.configured === true,
    reachable: sync.reachable === true,
    remote: sanitizeRemote(sync.remote),
    repoDir: typeof sync.repoDir === 'string' ? sync.repoDir : '',
    target: typeof sync.repoDir === 'string' && sync.repoDir !== '' ? sync.repoDir : '',
  }
}

/** Git-команды для копирования: только адрес без логина/пароля. */
function gitCommands(context) {
  if (!context.git || context.remote === '') return []
  const commands = [{ label: 'Проверить доступ', command: `git ls-remote ${context.remote}` }]
  if (!context.configured) {
    const target = context.target !== '' ? context.target : 'dsh-sync'
    commands.push({ label: 'Склонировать зеркало', command: `git clone ${context.remote} "${target}"` })
  }
  return commands
}

/**
 * Блок «Песочница и доступы». Если host не отдал политику (нет сервиса
 * `sandboxPolicy` или он не ответил) — статус `unknown`, без догадок.
 */
export function describeSandbox(input) {
  const raw = input?.sandbox
  const workspaceRoot = typeof raw?.workspaceRoot === 'string' ? raw.workspaceRoot : ''
  const extraRoots = Number.isFinite(Number(raw?.additionalWritableRoots)) ? Number(raw.additionalWritableRoots) : 0
  if (raw === undefined || raw === null || raw.available !== true || typeof raw.mode !== 'string' || raw.mode === '') {
    return {
      status: 'unknown',
      mode: null,
      workspaceRoot,
      label: 'Песочница: состояние неизвестно',
      detail: 'Версия DSH не отдаёт политику файловой песочницы — проверьте доступы вручную в настройках DSH.',
      allowed: [],
      denied: [],
      approvals: 'Подтверждения (approvals) выдаются при попытке операции вне разрешённых каталогов; если их нет — работайте внутри рабочего каталога.',
    }
  }
  if (raw.mode === 'danger-full-access') {
    return {
      status: 'off',
      mode: raw.mode,
      workspaceRoot,
      label: 'Песочница выключена: полный доступ к файлам',
      detail: 'Ограничений нет: DSH может читать и изменять файлы вне рабочего каталога. Включайте «workspace-write», если нужна защита от случайных правок.',
      allowed: ['чтение и запись любых файлов', 'запуск команд без ограничения каталога'],
      denied: [],
      approvals: 'Подтверждения не запрашиваются: политика «danger-full-access» разрешает всё.',
    }
  }
  if (raw.mode === 'read-only') {
    return {
      status: 'on',
      mode: raw.mode,
      workspaceRoot,
      label: 'Песочница включена: только чтение',
      detail: 'Запись файлов запрещена даже внутри рабочего каталога. Для правок переключите режим на «workspace-write».',
      allowed: ['чтение файлов', 'запуск безопасных команд чтения'],
      denied: ['запись файлов', 'изменения вне рабочего каталога'],
      approvals: 'Для записи DSH запросит подтверждение (approvals); без подтверждения запись будет отклонена.',
    }
  }
  const additional = extraRoots > 0 ? ` Дополнительно разрешённых каталогов: ${extraRoots}.` : ''
  return {
    status: 'on',
    mode: raw.mode,
    workspaceRoot,
    label: 'Песочница включена: запись только в рабочем каталоге',
    detail: `Изменения вне рабочего каталога запрещены.${additional}${workspaceRoot !== '' ? ` Рабочий каталог: ${workspaceRoot}.` : ''}`,
    allowed: ['чтение файлов', 'запись внутри рабочего каталога', 'запуск команд в рабочем каталоге'],
    denied: ['запись вне рабочего каталога', 'изменение системных файлов'],
    approvals: 'Запись вне рабочего каталога возможна только через подтверждение (approvals); иначе держите изменения внутри рабочего каталога.',
  }
}

/** Собрать шаги онбординга из чистых фактов. */
function buildSteps(input, secrets) {
  const tools = input?.tools ?? {}
  const dshVersion = typeof input?.dshVersion === 'string' ? input.dshVersion.trim() : ''
  const profile = input?.profile ?? {}
  const sync = syncContext(input)
  const workspace = input?.workspace ?? {}
  const localCopies = input?.localCopies ?? {}
  const steps = []

  // 1. git + Node
  const nodeOk = tools?.node?.ok === true
  const gitOk = tools?.git?.ok === true
  steps.push({
    id: 'tools',
    title: 'Git и Node.js',
    status: nodeOk && gitOk ? 'ok' : 'fail',
    detail: nodeOk && gitOk
      ? toolsDetail(tools)
      : `Не найдено: ${[nodeOk ? '' : 'Node.js', gitOk ? '' : 'git'].filter(Boolean).join(', ')}. ${toolsDetail(tools)}`,
    action: nodeOk && gitOk ? null : { label: 'Проверить снова', route: 'refresh' },
    blocking: true,
  })

  // 2. Версия DSH
  const versionOk = dshVersion !== '' && isVersionAtLeast(dshVersion, DSH_MIN_VERSION)
  steps.push({
    id: 'dsh-version',
    title: 'Версия DSH',
    status: versionOk ? 'ok' : dshVersion === '' ? 'todo' : 'fail',
    detail: dshVersion === ''
      ? `Версию определить не удалось; нужна ${DSH_MIN_VERSION} или новее`
      : `${dshVersion} (нужна ${DSH_MIN_VERSION} или новее)`,
    action: versionOk ? null : { label: 'Проверить снова', route: 'refresh' },
    blocking: true,
  })

  // 3. GitHub-токен: обязателен для git-хранилища, иначе — предупреждение.
  const github = secretById(secrets, 'GITHUB_TOKEN')
  steps.push({
    id: 'github-token',
    title: 'GitHub-токен',
    status: github.present ? 'ok' : sync.git || sync.configured ? 'fail' : 'warn',
    detail: github.present
      ? 'есть в хранилище DSH — сам токен в интерфейс не передаётся'
      : sync.git || sync.configured
        ? 'не задан: приватный репозиторий зеркала недоступен без токена'
        : 'не задан: для хранилища в папке облака не обязателен, но нужен для проверки обновлений',
    action: github.present ? null : { label: 'Открыть настройки', route: 'settings' },
    blocking: sync.git || sync.configured,
  })

  // 4. Ключ DeepSeek API
  const deepseek = secretById(secrets, 'DEEPSEEK_API_KEY')
  steps.push({
    id: 'deepseek-key',
    title: 'Ключ DeepSeek API',
    status: deepseek.present ? 'ok' : 'todo',
    detail: deepseek.present ? 'есть в хранилище DSH' : 'не задан: без него DSH не сможет обращаться к модели',
    action: deepseek.present ? null : { label: 'Открыть настройки', route: 'settings' },
    blocking: true,
  })

  // 5. Пароль WebDAV-резерва: нужен только если выбран этот канал.
  const webdav = secretById(secrets, 'DSH_SYNC_WEBDAV_PASSWORD')
  steps.push({
    id: 'webdav-password',
    title: 'Пароль WebDAV резерва',
    status: webdav.present ? 'ok' : sync.webdav ? 'fail' : 'ok',
    detail: webdav.present
      ? 'есть в хранилище DSH'
      : sync.webdav
        ? 'не задан: резерв WebDAV настроен, но без пароля приложения не подключится'
        : 'не нужен: резервный канал не использует WebDAV',
    action: webdav.present || !sync.webdav ? null : { label: 'Открыть настройки', route: 'settings' },
    blocking: sync.webdav,
  })

  // 6. Пароль сейфа: необязателен, но полезен на новом устройстве.
  const vault = secretById(secrets, 'DSH_VAULT_PASSPHRASE')
  steps.push({
    id: 'vault-passphrase',
    title: 'Пароль сейфа DSH',
    status: vault.present ? 'ok' : 'warn',
    detail: vault.present
      ? 'есть в хранилище DSH: сейф и импорт секретов доступны'
      : 'не задан: сейф не откроется на этом устройстве, хотя синхронизация сессий работает',
    action: vault.present ? null : { label: 'Открыть настройки', route: 'settings' },
    blocking: false,
  })

  // 7. Профиль: конфликты и план приёма.
  const conflictCount = Math.max(0, Number(profile?.conflictCount ?? 0) || 0)
  const pendingFiles = Math.max(0, Number(profile?.plan?.files ?? 0) || 0)
  const planPending = profile?.plan?.present === true && pendingFiles > 0
  const profileStatus = profile?.available !== true
    ? 'fail'
    : conflictCount > 0
      ? 'warn'
      : planPending
        ? 'todo'
        : 'ok'
  steps.push({
    id: 'profile',
    title: 'Профиль DSH',
    status: profileStatus,
    detail: profile?.available !== true
      ? 'каталог профиля не найден: настройки и плагины с другого устройства не приедут'
      : conflictCount > 0
        ? `конфликтов в журнале: ${conflictCount} — локальные настройки при конфликте не затираются, примените план вручную`
        : planPending
          ? `план приёма ждёт применения: файлов ${pendingFiles}`
          : 'план профиля применён или приезжать нечему',
    action: profile?.available !== true || (conflictCount === 0 && !planPending)
      ? null
      : { label: 'Применить профиль', route: 'profile-apply' },
    blocking: true,
  })

  // 8. Синхронизация: репозиторий настроен и доступен.
  let syncStatus = 'ok'
  let syncDetail = ''
  if (!sync.configured) {
    syncStatus = 'todo'
    syncDetail = sync.folder || sync.webdav || sync.yandex
      ? 'хранилище не настроено: укажите папку или адрес и сохраните настройки'
      : 'хранилище не настроено: укажите адрес репозитория и сохраните настройки'
  } else if (!sync.reachable) {
    syncStatus = 'fail'
    syncDetail = sync.git
      ? `репозиторий ${sync.remote || ''} недоступен: проверьте адрес, сеть и токен`
      : 'хранилище не отвечает: проверьте путь облака и доступ к нему'
  } else {
    syncDetail = sync.git
      ? `репозиторий доступен${sync.remote !== '' ? `: ${sync.remote}` : ''}`
      : 'хранилище доступно'
  }
  steps.push({
    id: 'sync',
    title: 'Синхронизация',
    status: syncStatus,
    detail: syncDetail,
    action: syncStatus === 'ok' ? null : { label: sync.configured ? 'Проверить снова' : 'Открыть настройки', route: sync.configured ? 'refresh' : 'settings' },
    blocking: true,
  })

  // 9. Локальные сессии с облачными копиями (миграция «локальная навсегда»).
  const copies = Math.max(0, Number(localCopies?.count ?? 0) || 0)
  steps.push({
    id: 'local-copies',
    title: 'Миграция локальных копий',
    status: copies > 0 ? 'todo' : 'ok',
    detail: copies > 0
      ? `локальных сессий с облачными копиями: ${copies} — можно убрать копии, оставив сессии локальными`
      : localCopies?.checked === false
        ? 'ещё не проверялись: запустите «Проверить»'
        : 'облачных копий у локальных сессий нет',
    action: copies > 0 ? { label: 'Убрать облачные копии', route: 'local-only-migration' } : null,
    blocking: false,
  })

  // 10. Рабочее пространство
  const hints = Math.max(0, Number(workspace?.hints?.length ?? workspace?.hints ?? 0) || 0)
  const matched = Math.max(0, Number(workspace?.matched ?? 0) || 0)
  const localWorkspaces = Math.max(0, Number(workspace?.localWorkspaces ?? 0) || 0)
  const workspaceStatus = workspace?.enabled === false
    ? 'warn'
    : hints > 0
      ? 'todo'
      : matched > 0
        ? 'ok'
        : localWorkspaces === 0
          ? 'warn'
          : 'ok'
  steps.push({
    id: 'workspace',
    title: 'Рабочее пространство',
    status: workspaceStatus,
    detail: workspace?.enabled === false
      ? 'перенос рабочих пространств выключен в настройках'
      : hints > 0
        ? `не привязано сессий: ${hints} — привяжите к рабочему пространству`
        : matched > 0
          ? `рабочих пространств привязано: ${matched}`
          : 'рабочие пространства ещё не созданы: это нормально для нового устройства',
    action: hints > 0 ? { label: 'Открыть настройки', route: 'settings' } : null,
    blocking: false,
  })

  return steps
}

/**
 * Собрать онбординг нового устройства.
 * @param {object} input - чистые факты, см. README модуля.
 * @returns {{ok:boolean, steps:Array, ready:boolean, count:number, warn:number, fail:number, todo:number, secrets:Array, sandbox:object, commands:Array, version:object}}
 */
export function collectOnboarding(input = {}) {
  const facts = input !== null && typeof input === 'object' ? input : {}
  const secrets = refsOf(facts)
  const rawSteps = buildSteps(facts, secrets)
  // Порядок фиксирован: карточка показывает шаги в одном и том же порядке.
  const steps = STEP_ORDER
    .map(id => rawSteps.find(step => step.id === id))
    .filter(step => step !== undefined)
  const warn = steps.filter(step => step.status === 'warn').length
  const fail = steps.filter(step => step.status === 'fail').length
  const todo = steps.filter(step => step.status === 'todo').length
  const count = fail + todo
  const context = syncContext(facts)
  return {
    ok: true,
    version: {
      min: DSH_MIN_VERSION,
      current: typeof facts.dshVersion === 'string' ? facts.dshVersion : '',
    },
    steps,
    ready: fail === 0 && todo === 0,
    count,
    warn,
    fail,
    todo,
    secrets,
    sandbox: describeSandbox(facts),
    commands: gitCommands(context),
  }
}
