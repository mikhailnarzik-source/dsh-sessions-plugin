/**
 * Профильный слой синхронизации.
 *
 * Сессии — не всё, что нужно на втором компьютере: там ещё нужны оформление,
 * язык, включённые плагины и их настройки. Этот модуль возит переносимую часть
 * профиля DSH:
 *
 *   profile/cordis.patch.yml      безопасные ключи патча (тема, язык, шрифт, MCP)
 *   profile/bundles.json          package.json → dsh.profile.bundles
 *   profile/settings/<плагин>.json  настройки плагинов по белому списку
 *   profile/expenses-sessions.json  история расходов (слияние по id записи)
 *   profile/schedule.json         задачи автоматизации (слияние по id)
 *   profile/inbox-settings.json   «Входящие»: настройки и белый список
 *   profile/manifest.json         что и когда уехало в зеркало (sha256/bytes)
 *   profile/conflicts.json        журнал конфликтов приёма/отправки
 *
 * Приём двухшаговый: pull строит план (что применить, откуда и когда), а
 * применение — отдельная кнопка «Применить» (ручной режим по умолчанию).
 * Авто-применение включается `profile.autoApply=true` и только когда конфликтов
 * нет. Перед записью каждый локальный файл сохраняется рядом как
 * `<файл>.before-sync-<время>`.
 *
 * Чего здесь нет и не должно быть: browser-secrets.env, dsh-inbox/device.json,
 * идентификаторов устройства, путей и прочих машинных полей. Пути в
 * переносимых значениях заменяются на `${HOME}` / `${DSH_HOME}` и
 * подставляются обратно при приёме.
 *
 * Политика конфликтов: если и локальная, и удалённая копия изменились с
 * прошлого обмена (базис хранится в `~/.dsh/dsh-sync/profile-base.json`),
 * применяется локальная копия, а случай пишется в журнал. Так ничьи настройки
 * не теряются молча.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createNeutralizer, isMachineKey, sanitizeValue } from './neutralize.mjs'
import { parseBlockEntry, parseYaml, serializeBlockEntry, splitTopLevelBlocks, YamlError } from './yaml.mjs'

export const PROFILE_DIR = 'profile'
export const PROFILE_PATCH_FILE = 'profile/cordis.patch.yml'
export const PROFILE_BUNDLES_FILE = 'profile/bundles.json'
export const PROFILE_SETTINGS_DIR = 'profile/settings'
export const PROFILE_CONFLICTS_FILE = 'profile/conflicts.json'
export const BASE_FILE = 'profile-base.json'
export const JOURNAL_LIMIT = 200
export const PENDING_BROWSER_FILE = 'browser-settings.pending.json'
export const BROWSER_SETTINGS_FILE = 'browser-settings.json'

// Новые единицы профильного слоя: история расходов, задачи автоматизации и
// «Входящие». Хранятся отдельными файлами зеркала, чтобы не смешивать их с
// настройками по белому списку.
export const PROFILE_EXPENSES_FILE = 'profile/expenses-sessions.json'
export const PROFILE_SCHEDULE_FILE = 'profile/schedule.json'
export const PROFILE_INBOX_FILE = 'profile/inbox-settings.json'
export const PROFILE_MANIFEST_FILE = 'profile/manifest.json'
/** План применения: лежит на устройстве, а не в зеркале. */
export const PROFILE_PLAN_FILE = 'profile-plan.json'
/** Итог последнего применения — для карточки «Профиль». */
export const PROFILE_APPLY_FILE = 'profile-apply.json'
/** Суффикс резервной копии локального файла перед записью. */
export const PROFILE_BACKUP_SUFFIX = '.before-sync-'

export const EXPENSES_STORE = join('dsh-expenses', 'sessions.json')
export const SCHEDULE_STORE = join('storages', 'schedule.json')
export const INBOX_STORE = join('dsh-inbox', 'state.json')

/** Файлы зеркала, которые сливаются объединением, а не перезаписью. */
export const EXTRA_PROFILE_FILES = new Set([PROFILE_EXPENSES_FILE, PROFILE_SCHEDULE_FILE])

export const EXPENSES_SESSION_LIMIT = 500
export const SCHEDULE_TASK_LIMIT = 200

/**
 * Белый список записей `cordis.patch.yml`: только оформление, язык, шрифты и
 * MCP-серверы. Всё остальное (модели, встроенные сервисы, отключения плагинов,
 * пути, секреты) остаётся машинным и не синхронизируется.
 */
export const SAFE_PATCH_ENTRIES = {
  'ui-theme': {
    name: '@deepseek-ai/dsh-client-ui-theme',
    keys: [
      'preference',
      'fontSize',
      'textFontSize',
      'codeFontSize',
      'terminalFontSize',
      'textFontFamily',
      'codeFontFamily',
      'terminalFontFamily',
    ],
  },
  locale: {
    name: '@deepseek-ai/dsh-client-locale',
    keys: ['preference'],
  },
  'ui-locale': {
    name: '@deepseek-ai/dsh-client-locale',
    keys: ['preference'],
  },
  'mcp-manager': {
    name: '@deepseek-ai/dsh-mcp-manager',
    keys: ['servers'],
  },
}

/**
 * Настройки плагинов по белому списку. `kind: 'file'` — JSON-файл в каталоге
 * DSH, `kind: 'browser'` — значения браузерного localStorage, которые приносит
 * host-часть из панели плагина.
 */
export const PLUGIN_SETTINGS = [
  {
    plugin: 'dsh-notify',
    kind: 'file',
    file: join('dsh-notify', 'settings.json'),
    keys: ['notifications', 'sound', 'gameMode', 'theme', 'variant', 'position', 'duration', 'volume', 'system', 'textSize', 'fontFamily', 'fontStyle'],
  },
  {
    plugin: 'dsh-calendar',
    kind: 'file',
    file: join('dsh-calendar', 'data.json'),
    keys: ['version', 'events', 'timer', 'log'],
  },
  {
    plugin: 'dsh-expenses',
    kind: 'file',
    file: join('dsh-expenses', 'rates.json'),
    keys: ['base', 'source', 'status', 'rubPerUsd', 'rubPerCny', 'cnyPerUsd'],
  },
  {
    plugin: 'dsh-polish',
    kind: 'browser',
    file: null,
    keys: ['enabled', 'panelVisibility'],
  },
  {
    plugin: 'dsh-cards',
    kind: 'browser',
    file: null,
    keys: ['panelVisibility'],
  },
]

const SETTINGS_BY_PLUGIN = new Map(PLUGIN_SETTINGS.map(item => [item.plugin, item]))

/** Лежит ли путь внутри каталога (с учётом регистра на Windows). */
function isInside(dir, root) {
  const normalize = (value) => {
    const resolved = String(value).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const folder = normalize(dir)
  const base = normalize(root)
  return folder === base || folder.startsWith(`${base}${process.platform === 'win32' ? '\\' : '/'}`) || folder.startsWith(`${base}/`)
}

/** Каталог профиля: из настроек, окружения или единственный найденный. */
export function resolveProfileDir(home, config, env = process.env) {
  const pick = (dir, mustBeInside) => {
    if (typeof dir !== 'string' || dir.trim() === '') return undefined
    // Профиль из окружения принимаем, только если он принадлежит этому DSH_HOME:
    // иначе тестовая/вторая копия плагина трогала бы чужой профиль.
    if (mustBeInside !== undefined && !isInside(dir, mustBeInside)) return undefined
    return existsSync(dir) ? dir : undefined
  }
  const profilesRoot = join(home, 'profiles')
  const fromConfig = pick(config?.profileDir)
  if (fromConfig !== undefined) return fromConfig
  const fromEnv = pick(env?.DSH_PROFILE_DIR, profilesRoot)
  if (fromEnv !== undefined) return fromEnv
  const name = typeof config?.profile === 'string' && config.profile !== '' ? config.profile : env?.DSH_PROFILE
  if (typeof name === 'string' && name !== '') {
    const candidate = join(profilesRoot, name)
    if (existsSync(candidate)) return candidate
  }
  const root = join(home, 'profiles')
  if (!existsSync(root)) return undefined
  try {
    const dirs = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    const preferred = dirs.includes('desktop') ? 'desktop' : dirs.length === 1 ? dirs[0] : undefined
    if (preferred !== undefined) {
      const candidate = join(root, preferred)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // каталог профилей недоступен
  }
  return undefined
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Стабильная сериализация объекта для хеша (порядок ключей не важен). */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashOf(value) {
  return sha256(stableStringify(value))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// --- cordis.patch.yml -------------------------------------------------------

/** Безопасные записи из локального профиля (с нейтрализацией путей). */
export async function readLocalPatch(profileDir, neutralizer) {
  const file = join(profileDir, 'cordis.patch.yml')
  const result = { present: false, file, entries: [], warnings: [] }
  if (!existsSync(file)) return result
  result.present = true
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    result.warnings.push(`cordis.patch.yml не прочитан: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  let parts
  try {
    parts = splitTopLevelBlocks(text)
  } catch (error) {
    result.warnings.push(`cordis.patch.yml не разобран: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  for (const block of parts.blocks) {
    let entry
    try {
      entry = parseBlockEntry(block)
    } catch (error) {
      if (error instanceof YamlError) {
        result.warnings.push(`запись patch пропущена: ${error.message}`)
        continue
      }
      throw error
    }
    const spec = SAFE_PATCH_ENTRIES[entry?.id]
    if (spec === undefined || !isPlainObject(entry.config)) continue
    const config = safePatchConfig(entry.config, spec, neutralizer)
    if (Object.keys(config).length === 0) continue
    result.entries.push({ id: entry.id, name: spec.name, config })
  }
  return result
}

/** Отфильтровать config записи по белому списку и нейтрализовать пути. */
export function safePatchConfig(config, spec, neutralizer) {
  const filtered = {}
  for (const key of spec.keys) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) continue
    const value = config[key]
    if (value === undefined) continue
    filtered[key] = sanitizeValue(value, { neutralizer })
  }
  return filtered
}

/** Записать переносимый patch в зеркало. */
export async function writePatchMirror(repoDir, entries) {
  const header = [
    '# Профиль, перенесённый dsh-sessions: только безопасные ключи',
    '# (оформление, язык, шрифт, MCP). Пути заменены на ${HOME}/${DSH_HOME}.',
    '',
  ].join('\n')
  const body = entries.map(entry => serializeBlockEntry({ id: entry.id, name: entry.name, config: entry.config })).join('\n')
  const text = `${header}${body}${body === '' ? '' : '\n'}`
  await mkdir(join(repoDir, PROFILE_DIR), { recursive: true })
  await writeFile(join(repoDir, PROFILE_PATCH_FILE), text, 'utf8')
  return { written: entries.length }
}

/** Прочитать переносимый patch из зеркала. */
export async function readPatchMirror(repoDir) {
  const file = join(repoDir, PROFILE_PATCH_FILE)
  const result = { present: false, entries: [], warnings: [] }
  if (!existsSync(file)) return result
  result.present = true
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    result.warnings.push(`profile/cordis.patch.yml не прочитан: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  let doc
  try {
    doc = parseYaml(text)
  } catch (error) {
    result.warnings.push(`profile/cordis.patch.yml не разобран: ${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  for (const entry of Array.isArray(doc) ? doc : []) {
    const spec = SAFE_PATCH_ENTRIES[entry?.id]
    if (spec === undefined || !isPlainObject(entry.config)) continue
    const config = {}
    for (const key of spec.keys) {
      if (Object.prototype.hasOwnProperty.call(entry.config, key)) config[key] = entry.config[key]
    }
    if (Object.keys(config).length > 0) result.entries.push({ id: entry.id, name: spec.name, config })
  }
  return result
}

/** Собрать текст patch-файла из шапки, блоков и хвоста. */
function joinPatchParts(header, blocks, tail) {
  const chunks = []
  const head = header.replace(/\n+$/, '')
  if (head !== '') chunks.push(head)
  for (const block of blocks) chunks.push(block.replace(/\n+$/, ''))
  const end = String(tail ?? '').replace(/\n+$/, '')
  if (end !== '') chunks.push(end)
  return `${chunks.join('\n')}\n`
}

/**
 * Влить безопасные записи зеркала в локальный `cordis.patch.yml`.
 *
 * Меняются только адресованные записи из белого списка; остальные строки
 * (включая `insert`, комментарии и `!!js`) остаются как были. Новые записи
 * добавляются только для известных безопасных id — так на устройстве без
 * нужного плагина не появляется мусорная строка.
 */
export async function applyPatchMirror(profileDir, entries, neutralizer) {
  const file = join(profileDir, 'cordis.patch.yml')
  const exists = existsSync(file)
  const text = exists ? await readFile(file, 'utf8') : ''
  let parts
  try {
    parts = splitTopLevelBlocks(text)
  } catch (error) {
    return { ok: false, changed: 0, warning: `локальный cordis.patch.yml не разобран, приём пропущен: ${error instanceof Error ? error.message : String(error)}` }
  }
  const blocks = parts.blocks.map(raw => {
    let value
    try {
      value = parseBlockEntry(raw)
    } catch {
      value = null
    }
    return { raw, value }
  })
  // Шапка patch-файла — только комментарии: если там что-то ещё, значит файл
  // не является списком записей и переписывать его нельзя.
  const unsafeHeader = parts.header
    .split('\n')
    .some(line => line.trim() !== '' && !line.trim().startsWith('#'))
  if (unsafeHeader) {
    return { ok: false, changed: 0, warning: 'локальный cordis.patch.yml имеет нестандартную шапку, приём пропущен' }
  }
  const byId = new Map()
  for (let index = 0; index < blocks.length; index++) {
    const id = blocks[index].value?.id
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, index)
  }
  let changed = 0
  const serialized = blocks.map(block => block.raw)
  for (const entry of entries) {
    const spec = SAFE_PATCH_ENTRIES[entry.id]
    if (spec === undefined) continue
    const localized = { id: entry.id, name: entry.name, config: localizeConfig(entry.config, neutralizer) }
    const index = byId.get(entry.id)
    if (index === undefined) {
      serialized.push(serializeBlockEntry(localized))
      changed += 1
      continue
    }
    const current = blocks[index].value
    if (!isPlainObject(current)) continue
    const nextConfig = isPlainObject(current.config) ? { ...current.config } : {}
    for (const key of spec.keys) {
      if (Object.prototype.hasOwnProperty.call(entry.config, key)) nextConfig[key] = localized.config[key]
      else if (spec.keys.includes(key)) delete nextConfig[key]
    }
    const nextEntry = { ...current, config: nextConfig }
    const nextRaw = serializeBlockEntry(nextEntry)
    if (nextRaw !== blocks[index].raw.trimEnd()) {
      serialized[index] = nextRaw
      changed += 1
    }
  }
  if (changed === 0) return { ok: true, changed: 0 }
  const backup = exists ? await backupBeforeSync(file) : undefined
  await writeFile(file, joinPatchParts(parts.header, serialized, parts.tail), 'utf8')
  return { ok: true, changed, backup }
}

/** Локальные пути в значениях записи (обратная замена токенов). */
export function localizeConfig(value, neutralizer) {
  if (typeof value === 'string') return neutralizer.localizeText(value)
  if (Array.isArray(value)) return value.map(item => localizeConfig(item, neutralizer))
  if (isPlainObject(value)) {
    const result = {}
    for (const [key, item] of Object.entries(value)) result[key] = localizeConfig(item, neutralizer)
    return result
  }
  return value
}

// --- включённые плагины -----------------------------------------------------

/** `dsh.profile.bundles` из package.json профиля. */
export async function readLocalBundles(profileDir) {
  const file = join(profileDir, 'package.json')
  const empty = { present: false, file, bundles: [], dependencies: [] }
  if (!existsSync(file)) return empty
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter(item => typeof item === 'string' && item.trim() !== '')
      : []
    const dependencies = isPlainObject(manifest?.dependencies) ? Object.keys(manifest.dependencies) : []
    return { present: true, file, bundles, dependencies }
  } catch {
    return empty
  }
}

/** Установлен ли пакет в профиле (есть каталог с манифестом). */
export function isInstalledInProfile(profileDir, name) {
  if (typeof name !== 'string' || name === '') return false
  return existsSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
}

export async function writeBundlesMirror(repoDir, bundles) {
  const value = { version: 1, source: 'dsh.profile.bundles', bundles }
  await mkdir(join(repoDir, PROFILE_DIR), { recursive: true })
  await writeFile(join(repoDir, PROFILE_BUNDLES_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { written: bundles.length }
}

export async function readBundlesMirror(repoDir) {
  const file = join(repoDir, PROFILE_BUNDLES_FILE)
  if (!existsSync(file)) return { present: false, bundles: [] }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const bundles = Array.isArray(parsed?.bundles)
      ? parsed.bundles.filter(item => typeof item === 'string' && item.trim() !== '')
      : []
    return { present: true, bundles }
  } catch {
    return { present: false, bundles: [] }
  }
}

/**
 * Добавить недостающие включённые плагины. Ничего не удаляем и не трогаем
 * пакеты, которых нет в профиле: общий список должен остаться рабочим.
 */
export async function applyBundlesMirror(profileDir, remoteBundles) {
  const local = await readLocalBundles(profileDir)
  if (!local.present) return { ok: false, added: [], skipped: [], warning: 'package.json профиля не найден' }
  const known = new Set(local.bundles)
  const added = []
  const skipped = []
  for (const name of remoteBundles) {
    if (known.has(name)) continue
    if (!isInstalledInProfile(profileDir, name)) {
      skipped.push({ name, reason: 'плагин не установлен в этом профиле' })
      continue
    }
    known.add(name)
    added.push(name)
  }
  if (added.length === 0) return { ok: true, added, skipped }
  const file = local.file
  let manifest
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { ok: false, added: [], skipped, warning: 'package.json профиля не разобран' }
  }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles = [...(manifest.dsh.profile.bundles ?? []), ...added]
  await backupBeforeSync(file).catch(() => {})
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { ok: true, added, skipped }
}

// --- настройки плагинов по белому списку ------------------------------------

/**
 * Собрать настройки плагинов для зеркала.
 * @param {{home: string, neutralizer: object, browserSettings?: object}} options
 */
export async function readPluginSettings({ home, neutralizer, browserSettings }) {
  const settings = {}
  const sources = {}
  const warnings = []
  for (const spec of PLUGIN_SETTINGS) {
    if (spec.kind === 'file') {
      const file = join(home, spec.file)
      if (!existsSync(file)) {
        sources[spec.plugin] = 'missing'
        continue
      }
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        const filtered = filterSettings(parsed, spec, neutralizer)
        if (Object.keys(filtered).length === 0) {
          sources[spec.plugin] = 'empty'
          continue
        }
        settings[spec.plugin] = filtered
        sources[spec.plugin] = 'file'
      } catch (error) {
        warnings.push(`настройки ${spec.plugin} не прочитаны: ${error instanceof Error ? error.message : String(error)}`)
        sources[spec.plugin] = 'error'
      }
      continue
    }
    const values = browserSettings?.[spec.plugin]
    if (!isPlainObject(values)) {
      sources[spec.plugin] = 'missing'
      continue
    }
    const filtered = filterSettings(values, spec, neutralizer)
    if (Object.keys(filtered).length === 0) {
      sources[spec.plugin] = 'empty'
      continue
    }
    settings[spec.plugin] = filtered
    sources[spec.plugin] = 'browser'
  }
  return { settings, sources, warnings }
}

/** Отфильтровать значения настроек по белому списку. */
export function filterSettings(value, spec, neutralizer) {
  if (!isPlainObject(value)) return {}
  const filtered = {}
  for (const key of spec.keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (isMachineKey(key)) continue
    const sanitized = sanitizeValue(value[key], { neutralizer })
    if (sanitized !== undefined) filtered[key] = sanitized
  }
  return filtered
}

export async function writeSettingsMirror(repoDir, settings) {
  const dir = join(repoDir, PROFILE_SETTINGS_DIR)
  await mkdir(dir, { recursive: true })
  const written = []
  for (const [plugin, value] of Object.entries(settings)) {
    const file = join(dir, `${plugin}.json`)
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    written.push(plugin)
  }
  return { written }
}

export async function readSettingsMirror(repoDir) {
  const dir = join(repoDir, PROFILE_SETTINGS_DIR)
  const settings = {}
  const warnings = []
  if (!existsSync(dir)) return { settings, warnings }
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
  } catch {
    return { settings, warnings }
  }
  for (const entry of entries) {
    const plugin = entry.name.replace(/\.json$/, '')
    const spec = SETTINGS_BY_PLUGIN.get(plugin)
    if (spec === undefined) continue // не белый список — не трогаем
    try {
      const parsed = JSON.parse(await readFile(join(dir, entry.name), 'utf8'))
      const filtered = filterSettings(parsed, spec, undefined)
      if (Object.keys(filtered).length > 0) settings[plugin] = filtered
    } catch (error) {
      warnings.push(`profile/settings/${entry.name} не разобран: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { settings, warnings }
}

/** Записать настройки плагина на диск; браузерные — в очередь для клиента. */
export async function applyPluginSettings({ home, settings, browserPending }) {
  const applied = []
  const skipped = []
  const pending = { ...(browserPending ?? {}) }
  for (const [plugin, value] of Object.entries(settings)) {
    const spec = SETTINGS_BY_PLUGIN.get(plugin)
    if (spec === undefined) continue
    if (spec.kind === 'browser') {
      pending[plugin] = value
      applied.push({ plugin, kind: 'browser' })
      continue
    }
    const file = join(home, spec.file)
    try {
      let current = {}
      if (existsSync(file)) {
        current = JSON.parse(await readFile(file, 'utf8'))
        await backupBeforeSync(file)
      }
      if (!isPlainObject(current)) current = {}
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify({ ...current, ...value }, null, 2)}\n`, 'utf8')
      applied.push({ plugin, kind: 'file' })
    } catch (error) {
      skipped.push({ plugin, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  if (Object.keys(pending).length > 0) {
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', PENDING_BROWSER_FILE), `${JSON.stringify({ version: 1, at: new Date().toISOString(), settings: pending }, null, 2)}\n`, 'utf8')
  }
  return { applied, skipped, pendingBrowser: Object.keys(pending).length }
}

// --- журнал конфликтов и базис ----------------------------------------------

export async function readJournal(repoDir) {
  const file = join(repoDir, PROFILE_CONFLICTS_FILE)
  if (!existsSync(file)) return { version: 1, entries: [] }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return { version: 1, entries: Array.isArray(parsed?.entries) ? parsed.entries.slice(-JOURNAL_LIMIT) : [] }
  } catch {
    return { version: 1, entries: [] }
  }
}

/**
 * Активные (неразрешённые) конфликты: записи журнала без `resolution`.
 * Разрешённые остаются историей и не должны висеть в статусе как «конфликтов: 1».
 */
export function activeConflictCount(entries = []) {
  return (entries ?? []).filter(entry => entry?.resolution === undefined || entry.resolution === '').length
}

/** Дописать конфликты в журнал зеркала; возвращает число записей. */
export async function appendJournal(repoDir, entries, deviceId) {
  if (!Array.isArray(entries) || entries.length === 0) return 0
  const journal = await readJournal(repoDir)
  const at = new Date().toISOString()
  for (const entry of entries) {
    journal.entries.push({ at, device: deviceId ?? '', ...entry })
  }
  journal.entries = journal.entries.slice(-JOURNAL_LIMIT)
  await mkdir(join(repoDir, PROFILE_DIR), { recursive: true })
  await writeFile(join(repoDir, PROFILE_CONFLICTS_FILE), `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  return entries.length
}

function basePath(home) {
  return join(home, 'dsh-sync', BASE_FILE)
}

export async function readBase(home) {
  try {
    const parsed = JSON.parse(await readFile(basePath(home), 'utf8'))
    return { version: 1, entries: isPlainObject(parsed?.entries) ? parsed.entries : {} }
  } catch {
    return { version: 1, entries: {} }
  }
}

export async function writeBase(home, base) {
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  await writeFile(basePath(home), `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: base.entries }, null, 2)}\n`, 'utf8')
}

/**
 * Решение по одной синхронизируемой единице.
 * @returns {{conflict: boolean, apply: boolean, remoteHash: string|undefined}}
 */
export function decideSync({ baseHash, localHash, remoteHash }) {
  if (remoteHash === undefined) return { conflict: false, apply: true, reason: 'в зеркале нет' }
  if (localHash === remoteHash) return { conflict: false, apply: false, reason: 'совпадает' }
  if (baseHash !== undefined && localHash !== baseHash && remoteHash !== baseHash) {
    return { conflict: true, apply: false, reason: 'обе копии изменились с прошлого обмена' }
  }
  return { conflict: false, apply: true, reason: baseHash === undefined ? 'первый обмен' : 'изменилась одна сторона' }
}

// --- сборка переносимого профиля -------------------------------------------

/** Прочитать браузерные настройки, сохранённые host-частью. */
export async function readBrowserSettings(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'dsh-sync', BROWSER_SETTINGS_FILE), 'utf8'))
    return isPlainObject(parsed?.settings) ? parsed.settings : {}
  } catch {
    return {}
  }
}

export async function writeBrowserSettings(home, settings) {
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  await writeFile(join(home, 'dsh-sync', BROWSER_SETTINGS_FILE), `${JSON.stringify({ version: 1, at: new Date().toISOString(), settings: isPlainObject(settings) ? settings : {} }, null, 2)}\n`, 'utf8')
}

/** Очередь браузерных настроек после приёма (её забирает клиент). */
export async function readPendingBrowserSettings(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'dsh-sync', PENDING_BROWSER_FILE), 'utf8'))
    return { at: parsed?.at ?? '', settings: isPlainObject(parsed?.settings) ? parsed.settings : {} }
  } catch {
    return { at: '', settings: {} }
  }
}

export async function clearPendingBrowserSettings(home) {
  await writeFile(join(home, 'dsh-sync', PENDING_BROWSER_FILE), `${JSON.stringify({ version: 1, at: new Date().toISOString(), settings: {} }, null, 2)}\n`, 'utf8').catch(() => {})
}

/**
 * Собрать снимок переносимой части профиля.
 * @returns {{profileDir?: string, patch, bundles, settings, extras, sources, warnings}}
 */
export async function readProfileSnapshot({ home, config, neutralizer }) {
  const profileDir = resolveProfileDir(home, config)
  const ne = neutralizer ?? createNeutralizer({ home: homedir(), dshHome: home })
  if (profileDir === undefined) {
    return { profileDir: undefined, warnings: ['каталог профиля не найден — профильный слой пропущен'], patch: { entries: [], present: false }, bundles: { bundles: [], present: false }, settings: { settings: {}, sources: {} }, extras: emptyExtras(), sources: {} }
  }
  const patch = await readLocalPatch(profileDir, ne)
  const bundles = await readLocalBundles(profileDir)
  const browserSettings = await readBrowserSettings(home)
  const settings = await readPluginSettings({ home, neutralizer: ne, browserSettings })
  const extras = {
    expenses: await readLocalExpenses({ home, neutralizer: ne }),
    schedule: await readLocalSchedule({ home, neutralizer: ne }),
    inbox: await readLocalInbox({ home, neutralizer: ne }),
  }
  return {
    profileDir,
    patch,
    bundles,
    settings,
    extras,
    sources: settings.sources,
    warnings: [...patch.warnings, ...settings.warnings, ...extras.expenses.warnings, ...extras.schedule.warnings, ...extras.inbox.warnings],
  }
}

/** Пустые переносимые данные, когда каталога профиля нет. */
export function emptyExtras() {
  return {
    expenses: { found: false, file: '', sessions: {}, warnings: [] },
    schedule: { found: false, file: '', tasks: {}, warnings: [] },
    inbox: { found: false, file: '', settings: {}, warnings: [] },
  }
}

/**
 * Записать снимок профиля в зеркало.
 * История расходов и задачи автоматизации сливаются с тем, что уже лежит в
 * зеркале: записи другого устройства не теряются от отправки этого. После
 * записи обновляется manifest.json — по нему видно, чьи данные и когда приехали.
 */
export async function writeProfileMirror(repoDir, snapshot, { device } = {}) {
  await writePatchMirror(repoDir, snapshot.patch.entries)
  await writeBundlesMirror(repoDir, snapshot.bundles.bundles)
  const written = await writeSettingsMirror(repoDir, snapshot.settings.settings)
  const existing = await readProfileMirror(repoDir)
  const extras = snapshot.extras ?? emptyExtras()
  const expenses = mergeExpenseSessions([existing.expenses.sessions, extras.expenses?.sessions ?? {}], { limit: EXPENSES_SESSION_LIMIT })
  const schedule = mergeScheduleTasks([existing.schedule.tasks, extras.schedule?.tasks ?? {}], { limit: SCHEDULE_TASK_LIMIT })
  const inbox = isPlainObject(extras.inbox?.settings) ? extras.inbox.settings : {}
  if (Object.keys(expenses).length > 0 || existing.expenses.present) await writeExpensesMirror(repoDir, expenses)
  if (Object.keys(schedule).length > 0 || existing.schedule.present) await writeScheduleMirror(repoDir, schedule)
  // «Входящие» — настройки устройства: если локального файла нет (плагин не
  // установлен), чужой белый список не затираем.
  if (extras.inbox?.found === true) await writeInboxMirror(repoDir, inbox)
  const manifestFile = await writeProfileManifest(repoDir, { device })
  return {
    patchEntries: snapshot.patch.entries.length,
    bundles: snapshot.bundles.bundles.length,
    settings: written.written,
    extras: {
      expenses: Object.keys(expenses).length,
      schedule: Object.keys(schedule).length,
      inbox: Object.keys(inbox).length,
    },
    manifest: { files: Object.keys(manifestFile.files).length, device: manifestFile.device, updatedAt: manifestFile.updatedAt },
  }
}

/** Хеш переносимого снимка по каждой единице синхронизации. */
export function profileHashes(snapshot) {
  const extras = snapshot.extras ?? emptyExtras()
  return {
    [PROFILE_PATCH_FILE]: hashOf(snapshot.patch.entries),
    [PROFILE_BUNDLES_FILE]: hashOf(snapshot.bundles.bundles),
    ...Object.fromEntries(Object.entries(snapshot.settings.settings).map(([plugin, value]) => [`${PROFILE_SETTINGS_DIR}/${plugin}.json`, hashOf(value)])),
    [PROFILE_EXPENSES_FILE]: hashOf(extras.expenses?.sessions ?? {}),
    [PROFILE_SCHEDULE_FILE]: hashOf(extras.schedule?.tasks ?? {}),
    [PROFILE_INBOX_FILE]: hashOf(extras.inbox?.settings ?? {}),
  }
}

/** Хеши единиц, лежащих в зеркале. */
export function mirrorHashes(mirror) {
  return {
    [PROFILE_PATCH_FILE]: hashOf(mirror.patch.entries),
    [PROFILE_BUNDLES_FILE]: hashOf(mirror.bundles.bundles),
    ...Object.fromEntries(Object.entries(mirror.settings ?? {}).map(([plugin, value]) => [`${PROFILE_SETTINGS_DIR}/${plugin}.json`, hashOf(value)])),
    [PROFILE_EXPENSES_FILE]: hashOf(mirror.expenses?.sessions ?? {}),
    [PROFILE_SCHEDULE_FILE]: hashOf(mirror.schedule?.tasks ?? {}),
    [PROFILE_INBOX_FILE]: hashOf(mirror.inbox?.settings ?? {}),
  }
}

/** Прочитать всё профильное зеркало. */
export async function readProfileMirror(repoDir) {
  const patch = await readPatchMirror(repoDir)
  const bundles = await readBundlesMirror(repoDir)
  const settings = await readSettingsMirror(repoDir)
  const expenses = await readExpensesMirror(repoDir)
  const schedule = await readScheduleMirror(repoDir)
  const inbox = await readInboxMirror(repoDir)
  const manifest = await readProfileManifest(repoDir)
  const journal = await readJournal(repoDir)
  return {
    patch,
    bundles,
    settings: settings.settings,
    expenses,
    schedule,
    inbox,
    manifest,
    warnings: [...patch.warnings, ...settings.warnings, ...expenses.warnings, ...schedule.warnings, ...inbox.warnings, ...manifest.warnings],
    present: patch.present || bundles.present || Object.keys(settings.settings).length > 0 || expenses.present || schedule.present || inbox.present || manifest.present,
    journal,
  }
}

/**
 * Отправка профильного слоя: собрать локальное, сравнить с зеркалом и базисом,
 * записать переносимую часть. Локальная копия при конфликте приоритетнее —
 * она и уезжает в зеркало, а случай попадает в журнал.
 */
export async function pushProfile({ home, config, repoDir, neutralizer }) {
  const ne = neutralizer ?? createNeutralizer({ home: homedir(), dshHome: home })
  const snapshot = await readProfileSnapshot({ home, config, neutralizer: ne })
  if (snapshot.profileDir === undefined) {
    return { skipped: true, reason: 'каталог профиля не найден', conflicts: [], warnings: snapshot.warnings }
  }
  const mirror = await readProfileMirror(repoDir)
  const base = await readBase(home)
  const localHashes = profileHashes(snapshot)
  const remoteHashes = mirrorHashes(mirror)
  const conflicts = []
  for (const [file, localHash] of Object.entries(localHashes)) {
    // История расходов и задачи объединяются по id: это не конфликт, а слияние.
    if (EXTRA_PROFILE_FILES.has(file)) continue
    const decision = decideSync({ baseHash: base.entries[file], localHash, remoteHash: remoteHashes[file] })
    if (decision.conflict) {
      conflicts.push({ file, reason: decision.reason, resolution: 'локальная копия отправлена в зеркало' })
    }
  }
  const result = await writeProfileMirror(repoDir, snapshot, { device: config?.deviceId })
  // Базис фиксируем по локальному состоянию: именно его это устройство только
  // что разослало (стратегия «локальная копия приоритетнее»).
  for (const [file, localHash] of Object.entries(localHashes)) base.entries[file] = localHash
  if (conflicts.length > 0) await appendJournal(repoDir, conflicts, config?.deviceId)
  await writeBase(home, base)
  return {
    skipped: false,
    ...result,
    conflicts: conflicts.length,
    warnings: snapshot.warnings,
  }
}

/**
 * Приём профильного слоя: сначала строим план, потом (по кнопке) применяем.
 *
 * По умолчанию режим ручной: pull только сохраняет план в
 * `~/.dsh/dsh-sync/profile-plan.json`, а локальные файлы не меняются. Если в
 * настройках стоит `profile.autoApply=true` и конфликтов нет — применяем сразу.
 * При конфликте локальная копия не затирается, случай пишется в журнал.
 */
export async function pullProfile({ home, config, repoDir, neutralizer, dryRun = false }) {
  const ne = neutralizer ?? createNeutralizer({ home: homedir(), dshHome: home })
  const plan = await planProfilePull({ home, config, repoDir, neutralizer: ne })
  const summary = summarizePlan(plan)
  if (!plan.mirrorPresent) {
    return { skipped: true, reason: 'в зеркале нет профильного слоя', conflicts: 0, applied: 0, pendingPlan: false, mode: 'none', plan: summary, warnings: plan.warnings }
  }
  if (plan.profileDir === undefined) {
    return { skipped: true, reason: 'каталог профиля не найден', conflicts: 0, applied: 0, pendingPlan: false, mode: 'none', plan: summary, warnings: plan.warnings }
  }
  const conflicts = plan.conflicts.length
  const actionable = plan.entries.filter(entry => entry.action === 'apply')
  const autoApply = config?.profile?.autoApply === true
  let applied = []
  let warnings = [...plan.warnings]
  let mode = dryRun ? 'plan' : 'manual'
  let pendingPlan = false
  if (!dryRun) {
    const base = await readBase(home)
    let baseChanged = false
    // Совпавшие единицы сразу фиксируем в базисе: иначе следующее расхождение
    // не с чем сравнивать и конфликт не будет замечен.
    for (const entry of plan.entries) {
      if (entry.action !== 'skip' || EXTRA_PROFILE_FILES.has(entry.file)) continue
      const next = entry.localHash
      if (next === undefined) {
        if (base.entries[entry.file] === undefined) continue
        delete base.entries[entry.file]
        baseChanged = true
        continue
      }
      if (base.entries[entry.file] === next) continue
      base.entries[entry.file] = next
      baseChanged = true
    }
    if (autoApply && conflicts === 0 && actionable.length > 0) {
      const mirror = await readProfileMirror(repoDir)
      const result = await applyPlanEntries({ home, config, profileDir: plan.profileDir, entries: actionable, mirror, neutralizer: ne, base })
      applied = result.applied
      warnings = [...warnings, ...result.warnings]
      baseChanged = baseChanged || result.baseChanged
      mode = 'auto'
      await clearProfilePlan(home)
      await writeProfileApplyRecord(home, { mode: 'auto', applied: applied.length, conflicts, files: applied.map(item => item.file), device: config?.deviceId })
    } else if (actionable.length > 0) {
      await writeProfilePlan(home, plan)
      pendingPlan = true
      mode = 'pending'
    } else {
      await clearProfilePlan(home)
      if (applied.length === 0) mode = 'none'
    }
    if (baseChanged) await writeBase(home, base)
    if (conflicts > 0) await appendJournal(repoDir, plan.conflicts, config?.deviceId)
  }
  return {
    skipped: false,
    applied: applied.length,
    details: applied,
    conflicts,
    conflictDetails: plan.conflicts,
    warnings,
    mode,
    pendingPlan,
    plan: summary,
  }
}

/**
 * Применить отложенный план (кнопка «Применить»).
 *
 * Перед записью сверяем план с текущим состоянием: если зеркало или локальный
 * файл изменились после построения плана, единица пропускается с объяснением —
 * так применение не затирает более новое.
 */
export async function applyPendingProfile({ home, config, neutralizer }) {
  const ne = neutralizer ?? createNeutralizer({ home: homedir(), dshHome: home })
  const pending = await readProfilePlan(home)
  if (!pending.present) {
    return { ok: false, code: 'no-plan', message: 'Плана применения нет: сначала выполните приём профиля.' }
  }
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  if (pending.repoDir !== '' && repoDir !== '' && pending.repoDir !== repoDir) {
    await clearProfilePlan(home)
    return { ok: false, code: 'stale-plan', message: 'План построен для другого зеркала — выполните приём заново.' }
  }
  const plan = await planProfilePull({ home, config, repoDir, neutralizer: ne })
  if (!plan.mirrorPresent) {
    await clearProfilePlan(home)
    return { ok: false, code: 'no-mirror', message: 'В зеркале больше нет профильного слоя — выполните приём заново.' }
  }
  if (plan.profileDir === undefined) {
    await clearProfilePlan(home)
    return { ok: false, code: 'no-profile', message: 'Каталог профиля не найден.' }
  }
  const expected = new Map(pending.entries.map(entry => [entry.file, entry]))
  const fresh = []
  const skipped = []
  for (const entry of plan.entries) {
    const planned = expected.get(entry.file)
    if (planned === undefined) continue
    // История расходов и задачи сливаются объединением: их локальные изменения
    // не конфликтуют с планом и не требуют точного совпадения хэшей.
    const unionKind = entry.kind === 'expenses' || entry.kind === 'schedule'
    if (!unionKind) {
      if (planned.remoteHash !== entry.remoteHash) {
        skipped.push({ file: entry.file, reason: 'зеркало изменилось после плана — выполните приём заново' })
        continue
      }
      if (planned.localHash !== entry.localHash) {
        skipped.push({ file: entry.file, reason: 'локальный файл изменился после плана' })
        continue
      }
    }
    if (entry.action === 'conflict') {
      skipped.push({ file: entry.file, reason: 'конфликт: локальная копия сохранена' })
      continue
    }
    if (entry.action !== 'apply') continue
    fresh.push(entry)
  }
  if (fresh.length === 0) {
    await clearProfilePlan(home)
    return {
      ok: false,
      code: 'nothing',
      message: 'Применять нечего: план устарел или в нём только конфликты.',
      skipped,
      conflicts: plan.conflicts.length,
    }
  }
  const mirror = await readProfileMirror(repoDir)
  const base = await readBase(home)
  const result = await applyPlanEntries({ home, config, profileDir: plan.profileDir, entries: fresh, mirror, neutralizer: ne, base })
  for (const entry of plan.entries) {
    if (entry.action !== 'skip' || EXTRA_PROFILE_FILES.has(entry.file)) continue
    if (entry.localHash === undefined) continue
    base.entries[entry.file] = entry.localHash
  }
  await writeBase(home, base)
  await clearProfilePlan(home)
  await writeProfileApplyRecord(home, { mode: 'manual', applied: result.applied.length, conflicts: plan.conflicts.length, files: result.applied.map(item => item.file), device: config?.deviceId })
  return {
    ok: true,
    applied: result.applied.length,
    details: result.applied,
    skipped: [...skipped, ...result.warnings.map(text => ({ reason: text }))],
    conflicts: plan.conflicts.length,
    conflictDetails: plan.conflicts,
    warnings: result.warnings,
    source: plan.source,
  }
}

/** Заново построить план применения из текущего зеркала. */
export async function refreshProfilePlan({ home, config, neutralizer }) {
  const ne = neutralizer ?? createNeutralizer({ home: homedir(), dshHome: home })
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  const plan = await planProfilePull({ home, config, repoDir, neutralizer: ne })
  const actionable = plan.entries.filter(entry => entry.action === 'apply')
  if (!plan.mirrorPresent || plan.profileDir === undefined || actionable.length === 0) {
    await clearProfilePlan(home)
    return { ok: true, pending: false, plan: summarizePlan(plan) }
  }
  await writeProfilePlan(home, plan)
  return { ok: true, pending: true, plan: summarizePlan(plan) }
}

/** Отменить отложенный план: локальные файлы не меняются. */
export async function discardProfilePlan(home) {
  const removed = await clearProfilePlan(home)
  return { ok: true, discarded: removed }
}

/** Краткий статус профильного слоя для панели. */
export async function readProfileStatus({ home, config }) {
  const profileDir = resolveProfileDir(home, config)
  const ne = createNeutralizer({ home: homedir(), dshHome: home })
  const snapshot = await readProfileSnapshot({ home, config, neutralizer: ne })
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  const emptyMirror = {
    patch: { present: false, entries: [] },
    bundles: { present: false, bundles: [] },
    settings: {},
    expenses: { present: false, sessions: {}, warnings: [] },
    schedule: { present: false, tasks: {}, warnings: [] },
    inbox: { present: false, settings: {}, warnings: [] },
    manifest: { present: false, version: 1, device: '', updatedAt: '', files: {}, warnings: [] },
    present: false,
    warnings: [],
  }
  const mirror = repoDir === '' ? emptyMirror : await readProfileMirror(repoDir)
  const journal = repoDir === '' ? { entries: [] } : await readJournal(repoDir)
  const plan = await readProfilePlan(home)
  const lastApply = await readProfileApplyRecord(home)
  const bundles = snapshot.bundles.bundles ?? []
  const extras = snapshot.extras ?? emptyExtras()
  return {
    enabled: config?.profile?.enabled !== false,
    autoApply: config?.profile?.autoApply === true,
    profileDir: profileDir ?? '',
    available: profileDir !== undefined,
    patch: {
      present: snapshot.patch.present,
      entries: snapshot.patch.entries.map(entry => entry.id),
      warnings: snapshot.warnings,
    },
    bundles: {
      count: bundles.length,
      installed: profileDir === undefined
        ? 0
        : bundles.filter(name => (snapshot.bundles.dependencies ?? []).includes(name) || isInstalledInProfile(profileDir, name)).length,
      mirrorCount: mirror.bundles.bundles.length,
    },
    settings: Object.entries(snapshot.sources)
      .filter(([, source]) => source !== 'missing')
      .map(([plugin, source]) => ({ plugin, source })),
    extras: {
      expenses: Object.keys(extras.expenses?.sessions ?? {}).length,
      schedule: Object.keys(extras.schedule?.tasks ?? {}).length,
      inbox: Object.keys(extras.inbox?.settings ?? {}).length,
    },
    mirror: {
      present: mirror.present,
      patchEntries: mirror.patch.entries.map(entry => entry.id),
      bundles: mirror.bundles.bundles.length,
      settings: Object.keys(mirror.settings),
      expenses: Object.keys(mirror.expenses?.sessions ?? {}).length,
      schedule: Object.keys(mirror.schedule?.tasks ?? {}).length,
      inbox: Object.keys(mirror.inbox?.settings ?? {}).length,
      manifest: {
        present: mirror.manifest?.present === true,
        device: mirror.manifest?.device ?? '',
        updatedAt: mirror.manifest?.updatedAt ?? '',
        files: Object.keys(mirror.manifest?.files ?? {}).length,
      },
    },
    plan: summarizePlan(plan),
    lastApply: lastApply.present
      ? { present: true, at: lastApply.at, mode: lastApply.mode ?? '', applied: lastApply.applied ?? 0, conflicts: lastApply.conflicts ?? 0, files: lastApply.files ?? [], device: lastApply.device ?? '' }
      : { present: false },
    conflicts: journal.entries.slice(-5),
    // Разрешённые конфликты остаются в журнале как история, но не считаются
    // активными: иначе «конфликтов: 1» висит вечно после ручного применения.
    conflictCount: activeConflictCount(journal.entries),
    conflictHistory: journal.entries.length - activeConflictCount(journal.entries),
    pendingBrowser: Object.keys((await readPendingBrowserSettings(home)).settings).length,
  }
}

// --- резервные копии перед записью ------------------------------------------

/** Метка времени, безопасная для имени файла: 2026-11-23T22-30-00-000Z. */
function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Сохранить копию локального файла рядом с ним перед перезаписью:
 * `<файл>.before-sync-<время>`. Возвращает путь копии или undefined.
 */
export async function backupBeforeSync(file, stamp) {
  if (typeof file !== 'string' || file === '' || !existsSync(file)) return undefined
  const target = `${file}${PROFILE_BACKUP_SUFFIX}${stamp ?? backupStamp()}`
  await copyFile(file, target)
  return target
}

// --- история расходов (dsh-expenses/sessions.json) --------------------------

/**
 * Переносимые поля записи истории расходов. Счётчики «за сегодня» (today*)
 * машинные: на каждом устройстве они пересчитываются по своим логам.
 */
export const EXPENSE_SESSION_FIELDS = [
  'id',
  'title',
  'createdAt',
  'updatedAt',
  'input',
  'cacheHit',
  'output',
  'requests',
  'toolCalls',
  'costUsd',
  'subagent',
  'error',
]

/** Время записи для слияния: число миллисекунд или ISO-строка. */
export function recordTime(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return fallback
}

/** Одна запись истории расходов в переносимом виде. */
export function portableExpenseSession(record, neutralizer, fallbackId) {
  if (!isPlainObject(record)) return undefined
  const id = typeof record.id === 'string' && record.id !== ''
    ? record.id
    : typeof fallbackId === 'string' && fallbackId !== ''
      ? fallbackId
      : undefined
  if (id === undefined) return undefined
  const portable = { id }
  for (const field of EXPENSE_SESSION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue
    const value = sanitizeValue(record[field], { neutralizer })
    if (value !== undefined) portable[field] = value
  }
  return portable
}

/** Переносимый словарь истории расходов по id записи. */
export function portableExpenses(sessions, neutralizer) {
  const result = {}
  for (const [key, record] of Object.entries(isPlainObject(sessions) ? sessions : {})) {
    const portable = portableExpenseSession(record, neutralizer, key)
    if (portable !== undefined) result[portable.id] = portable
  }
  return result
}

export async function readLocalExpenses({ home, neutralizer }) {
  const file = join(home, EXPENSES_STORE)
  const empty = { found: false, file, sessions: {}, warnings: [] }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return { found: true, file, sessions: portableExpenses(parsed?.sessions, neutralizer), warnings: [] }
  } catch (error) {
    return { ...empty, found: true, warnings: [`история расходов не прочитана: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

export async function readExpensesMirror(repoDir) {
  const file = join(repoDir, PROFILE_EXPENSES_FILE)
  const empty = { present: false, sessions: {}, warnings: [] }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return { present: true, sessions: portableExpenses(parsed?.sessions), warnings: [] }
  } catch (error) {
    return { ...empty, warnings: [`profile/expenses-sessions.json не разобран: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

/**
 * Слить словари истории расходов по id записи: побеждает более новый updatedAt,
 * одинаковые id не дублируются. Лимит отбрасывает самые старые записи.
 */
export function mergeExpenseSessions(sources, { limit = EXPENSES_SESSION_LIMIT } = {}) {
  const merged = new Map()
  for (const source of sources) {
    for (const record of Object.values(isPlainObject(source) ? source : {})) {
      if (!isPlainObject(record)) continue
      const id = typeof record.id === 'string' && record.id !== '' ? record.id : undefined
      if (id === undefined) continue
      const previous = merged.get(id)
      if (previous === undefined) {
        merged.set(id, record)
        continue
      }
      merged.set(id, recordTime(record.updatedAt) >= recordTime(previous.updatedAt) ? { ...previous, ...record } : { ...record, ...previous })
    }
  }
  const items = [...merged.entries()]
    .sort((left, right) => {
      const delta = recordTime(right[1].updatedAt) - recordTime(left[1].updatedAt)
      if (delta !== 0) return delta
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
    })
    .slice(0, Math.max(1, limit))
  return Object.fromEntries(items)
}

/** Есть ли в зеркале записи новее или такие, которых нет локально. */
export function needsExpenseMerge(local, remote) {
  for (const record of Object.values(isPlainObject(remote) ? remote : {})) {
    if (!isPlainObject(record)) continue
    const current = isPlainObject(local) ? local[record.id] : undefined
    if (current === undefined) return true
    if (recordTime(record.updatedAt) > recordTime(current.updatedAt)) return true
  }
  return false
}

export async function writeExpensesMirror(repoDir, sessions) {
  await mkdir(join(repoDir, PROFILE_DIR), { recursive: true })
  const value = { version: 1, sessions: isPlainObject(sessions) ? sessions : {} }
  await writeFile(join(repoDir, PROFILE_EXPENSES_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { written: Object.keys(value.sessions).length }
}

/** Влить историю расходов из зеркала в локальный файл (объединение по id). */
export async function applyExpensesMirror({ home, sessions, neutralizer, limit = EXPENSES_SESSION_LIMIT }) {
  const file = join(home, EXPENSES_STORE)
  let raw = {}
  if (existsSync(file)) {
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      raw = {}
    }
  }
  if (!isPlainObject(raw)) raw = {}
  const local = isPlainObject(raw.sessions) ? raw.sessions : {}
  let added = 0
  let updated = 0
  let normalized = 0
  for (const value of Object.values(isPlainObject(sessions) ? sessions : {})) {
    if (!isPlainObject(value)) continue
    const remote = localizeConfig(value, neutralizer)
    const id = remote.id
    if (typeof id !== 'string' || id === '') continue
    const current = local[id]
    if (!isPlainObject(current)) {
      local[id] = {
        todayInput: 0,
        todayCacheHit: 0,
        todayOutput: 0,
        todayRequests: 0,
        todayToolCalls: 0,
        todayCostUsd: 0,
        ...remote,
      }
      added += 1
      continue
    }
    for (const field of ['todayInput', 'todayCacheHit', 'todayOutput', 'todayRequests', 'todayToolCalls', 'todayCostUsd']) {
      if (current[field] === undefined) {
        current[field] = 0
        normalized += 1
      }
    }
    if (recordTime(remote.updatedAt) > recordTime(current.updatedAt)) {
      local[id] = { ...current, ...remote }
      updated += 1
    }
  }
  let removed = 0
  const ids = Object.keys(local)
  if (ids.length > limit) {
    ids.sort((left, right) => recordTime(local[right]?.updatedAt) - recordTime(local[left]?.updatedAt))
    for (const id of ids.slice(limit)) {
      delete local[id]
      removed += 1
    }
  }
  if (added + updated + normalized + removed === 0) {
    return { ok: true, changed: 0, added: 0, updated: 0, removed: 0 }
  }
  const backup = await backupBeforeSync(file)
  await mkdir(dirname(file), { recursive: true })
  const next = { ...raw, version: isPlainObject(raw.version) ? raw.version : 1, sessions: local }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { ok: true, changed: added + updated + normalized + removed, added, updated, removed, backup }
}

// --- задачи автоматизации (storages/schedule.json) --------------------------

function emptySchedule() {
  return { unit: { name: 'schedule', version: 2 }, global: null, tables: { tasks: {} } }
}

function scheduleTasksOf(raw) {
  return isPlainObject(raw?.tables?.tasks) ? raw.tables.tasks : {}
}

function scheduleEntryId(entry, fallbackId) {
  if (isPlainObject(entry) && isPlainObject(entry.record)) {
    const id = entry.record.id
    if (typeof id === 'string' && id !== '') return id
  }
  return typeof fallbackId === 'string' && fallbackId !== '' ? fallbackId : undefined
}

/** Одна задача автоматизации в переносимом виде (пути нейтрализуются). */
export function portableScheduleEntry(entry, neutralizer, fallbackId) {
  if (!isPlainObject(entry)) return undefined
  const sanitized = sanitizeValue(entry, { neutralizer })
  if (!isPlainObject(sanitized)) return undefined
  const id = scheduleEntryId(sanitized, fallbackId)
  if (id === undefined) return undefined
  const record = isPlainObject(sanitized.record) ? { ...sanitized.record, id } : { id }
  return { ...sanitized, record }
}

/** Переносимый словарь задач по id. */
export function portableScheduleTasks(tasks, neutralizer) {
  const result = {}
  for (const [key, entry] of Object.entries(isPlainObject(tasks) ? tasks : {})) {
    const portable = portableScheduleEntry(entry, neutralizer, key)
    if (portable !== undefined) result[portable.record.id] = portable
  }
  return result
}

export async function readLocalSchedule({ home, neutralizer }) {
  const file = join(home, SCHEDULE_STORE)
  const empty = { found: false, file, tasks: {}, warnings: [] }
  if (!existsSync(file)) return empty
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    return { found: true, file, tasks: portableScheduleTasks(scheduleTasksOf(raw), neutralizer), warnings: [] }
  } catch (error) {
    return { ...empty, found: true, warnings: [`задачи автоматизации не прочитаны: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

export async function readScheduleMirror(repoDir) {
  const file = join(repoDir, PROFILE_SCHEDULE_FILE)
  const empty = { present: false, tasks: {}, warnings: [] }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return { present: true, tasks: portableScheduleTasks(parsed?.tasks), warnings: [] }
  } catch (error) {
    return { ...empty, warnings: [`profile/schedule.json не разобран: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

/**
 * Слить задачи по id: при совпадении побеждает более новый updatedAt, список
 * involvedSessionIds объединяется. Лимит отбрасывает самые старые задачи.
 */
export function mergeScheduleTasks(sources, { limit = SCHEDULE_TASK_LIMIT } = {}) {
  const merged = new Map()
  const add = (id, entry) => {
    const previous = merged.get(id)
    if (previous === undefined) {
      merged.set(id, entry)
      return
    }
    const winner = recordTime(entry.updatedAt) >= recordTime(previous.updatedAt) ? entry : previous
    const loser = winner === entry ? previous : entry
    const involved = [...new Set([
      ...(Array.isArray(loser.involvedSessionIds) ? loser.involvedSessionIds : []),
      ...(Array.isArray(winner.involvedSessionIds) ? winner.involvedSessionIds : []),
    ])]
    merged.set(id, { ...loser, ...winner, involvedSessionIds: involved })
  }
  for (const source of sources) {
    for (const [key, entry] of Object.entries(isPlainObject(source) ? source : {})) {
      const portable = portableScheduleEntry(entry, undefined, key)
      if (portable === undefined) continue
      add(portable.record.id, portable)
    }
  }
  const items = [...merged.entries()]
    .sort((left, right) => {
      const delta = recordTime(right[1].updatedAt) - recordTime(left[1].updatedAt)
      if (delta !== 0) return delta
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
    })
    .slice(0, Math.max(1, limit))
  return Object.fromEntries(items)
}

/** Есть ли в зеркале задачи новее или такие, которых нет локально. */
export function needsScheduleMerge(local, remote) {
  for (const entry of Object.values(isPlainObject(remote) ? remote : {})) {
    if (!isPlainObject(entry)) continue
    const id = scheduleEntryId(entry, entry.record?.id)
    if (id === undefined) continue
    const current = isPlainObject(local) ? local[id] : undefined
    if (current === undefined) return true
    if (recordTime(entry.updatedAt) > recordTime(current.updatedAt)) return true
  }
  return false
}

export async function writeScheduleMirror(repoDir, tasks) {
  await mkdir(join(repoDir, PROFILE_DIR), { recursive: true })
  const value = { version: 1, tasks: isPlainObject(tasks) ? tasks : {} }
  await writeFile(join(repoDir, PROFILE_SCHEDULE_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { written: Object.keys(value.tasks).length }
}

/** Влить задачи автоматизации из зеркала в локальный стор DSH. */
export async function applyScheduleMirror({ home, tasks, neutralizer }) {
  const file = join(home, SCHEDULE_STORE)
  let raw
  let found = false
  if (existsSync(file)) {
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
      found = true
    } catch {
      raw = undefined
    }
  }
  if (!isPlainObject(raw)) raw = emptySchedule()
  if (!isPlainObject(raw.tables)) raw.tables = {}
  if (!isPlainObject(raw.tables.tasks)) raw.tables.tasks = {}
  const local = raw.tables.tasks
  const byId = new Map()
  for (const [key, entry] of Object.entries(local)) {
    const id = scheduleEntryId(entry, key)
    if (id !== undefined) byId.set(id, key)
  }
  let added = 0
  let updated = 0
  for (const remote of Object.values(isPlainObject(tasks) ? tasks : {})) {
    if (!isPlainObject(remote)) continue
    const id = scheduleEntryId(remote)
    if (id === undefined) continue
    const localized = localizeConfig(remote, neutralizer)
    const key = byId.get(id)
    if (key === undefined) {
      local[id] = localized
      byId.set(id, id)
      added += 1
      continue
    }
    const current = local[key]
    if (recordTime(remote.updatedAt) > recordTime(current?.updatedAt)) {
      const involved = [...new Set([
        ...(Array.isArray(current?.involvedSessionIds) ? current.involvedSessionIds : []),
        ...(Array.isArray(localized?.involvedSessionIds) ? localized.involvedSessionIds : []),
      ])]
      local[key] = {
        ...(isPlainObject(current) ? current : {}),
        ...localized,
        record: {
          ...(isPlainObject(current) && isPlainObject(current.record) ? current.record : {}),
          ...(isPlainObject(localized.record) ? localized.record : {}),
        },
        involvedSessionIds: involved,
      }
      updated += 1
    }
  }
  if (added + updated === 0) {
    return { ok: true, changed: 0, added: 0, updated: 0, found }
  }
  const backup = await backupBeforeSync(file)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return { ok: true, changed: added + updated, added, updated, backup, found }
}

// --- «Входящие» (dsh-inbox/state.json) --------------------------------------

/**
 * Белый список полей `dsh-inbox/state.json`: настройки и доверенные чаты.
 * Машинные поля (deviceId, offset/lastUpdateId, queue, messages, текущая
 * сессия, состояние меню и профиля бота) не переносятся.
 */
export const INBOX_SETTING_KEYS = [
  'enabled',
  'allowedChatIds',
  'allowedUserIds',
  'ownerUserId',
  'ownerChatId',
  'security',
  'botUsername',
]

function normalizeIdList(value) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const item of value) {
    const id = typeof item === 'number' ? String(item) : typeof item === 'string' ? item.trim() : ''
    if (id === '' || result.includes(id)) continue
    result.push(id)
  }
  return result
}

/** Настройки «Входящих» в переносимом виде. */
export function portableInboxSettings(raw, neutralizer) {
  if (!isPlainObject(raw)) return {}
  const settings = {}
  for (const key of INBOX_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (key === 'allowedChatIds' || key === 'allowedUserIds') {
      settings[key] = normalizeIdList(raw[key])
      continue
    }
    if (key === 'security') {
      settings[key] = { groupsEnabled: raw.security?.groupsEnabled === true }
      continue
    }
    if (key === 'enabled') {
      settings[key] = raw.enabled === true
      continue
    }
    const value = sanitizeValue(raw[key], { neutralizer })
    if (value !== undefined) settings[key] = value
  }
  return settings
}

export async function readLocalInbox({ home, neutralizer }) {
  const file = join(home, INBOX_STORE)
  const empty = { found: false, file, settings: {}, warnings: [] }
  if (!existsSync(file)) return empty
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    return { found: true, file, settings: portableInboxSettings(raw, neutralizer), warnings: [] }
  } catch (error) {
    return { ...empty, found: true, warnings: [`«Входящие» не прочитаны: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

export async function readInboxMirror(repoDir) {
  const file = join(repoDir, PROFILE_INBOX_FILE)
  const empty = { present: false, settings: {}, warnings: [] }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return { present: true, settings: portableInboxSettings(parsed?.settings), warnings: [] }
  } catch (error) {
    return { ...empty, warnings: [`profile/inbox-settings.json не разобран: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

export async function writeInboxMirror(repoDir, settings) {
  await mkdir(join(repoDir, PROFILE_DIR), { recursive: true })
  const value = { version: 1, settings: isPlainObject(settings) ? settings : {} }
  await writeFile(join(repoDir, PROFILE_INBOX_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { written: Object.keys(value.settings).length }
}

/**
 * Применить настройки «Входящих»: меняются только поля белого списка,
 * deviceId/queue/offset/messages и прочие машинные поля локального файла
 * остаются как были.
 */
export async function applyInboxMirror({ home, settings, neutralizer }) {
  const file = join(home, INBOX_STORE)
  if (!existsSync(file)) return { ok: true, changed: 0, created: false }
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { ok: false, changed: 0, warning: 'локальный state.json «Входящих» не разобран, приём пропущен' }
  }
  if (!isPlainObject(raw)) return { ok: false, changed: 0, warning: 'локальный state.json «Входящих» имеет неожиданный формат, приём пропущен' }
  const next = { ...raw }
  const remote = portableInboxSettings(settings, neutralizer)
  let changed = 0
  for (const key of INBOX_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(remote, key)) {
      if (JSON.stringify(next[key]) !== JSON.stringify(remote[key])) {
        next[key] = remote[key]
        changed += 1
      }
    } else if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key]
      changed += 1
    }
  }
  if (changed === 0) return { ok: true, changed: 0, created: false }
  const backup = await backupBeforeSync(file)
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { ok: true, changed, created: false, backup }
}

// --- manifest.json в зеркале -----------------------------------------------

function manifestRelPath(root, full) {
  const prefix = root.endsWith('\\') || root.endsWith('/') ? root : `${root}${process.platform === 'win32' ? '\\' : '/'}`
  return `${PROFILE_DIR}/${full.slice(prefix.length).replace(/\\/g, '/')}`
}

async function listMirrorProfileFiles(repoDir) {
  const root = join(repoDir, PROFILE_DIR)
  if (!existsSync(root)) return []
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.includes(PROFILE_BACKUP_SUFFIX) || entry.name.endsWith('.tmp')) continue
      const rel = manifestRelPath(root, full)
      if (rel === PROFILE_MANIFEST_FILE || rel === PROFILE_CONFLICTS_FILE) continue
      found.push({ full, rel })
    }
  }
  await walk(root)
  found.sort((left, right) => left.rel.localeCompare(right.rel))
  return found
}

/** Описать каждый файл профиля в зеркале: sha256 содержимого и размер. */
export async function buildProfileManifest(repoDir, { device = '', updatedAt } = {}) {
  const files = {}
  for (const item of await listMirrorProfileFiles(repoDir)) {
    const bytes = await readFile(item.full)
    files[item.rel] = { sha256: sha256(bytes), bytes: bytes.length }
  }
  return {
    version: 1,
    device: typeof device === 'string' ? device : '',
    updatedAt: typeof updatedAt === 'string' && updatedAt !== '' ? updatedAt : new Date().toISOString(),
    files,
  }
}

/** Записать profile/manifest.json — по нему видно, что и когда приехало. */
export async function writeProfileManifest(repoDir, options = {}) {
  const manifest = await buildProfileManifest(repoDir, options)
  await mkdir(join(repoDir, PROFILE_DIR), { recursive: true })
  await writeFile(join(repoDir, PROFILE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

export async function readProfileManifest(repoDir) {
  const file = join(repoDir, PROFILE_MANIFEST_FILE)
  const empty = { present: false, version: 1, device: '', updatedAt: '', files: {}, warnings: [] }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const files = {}
    for (const [rel, value] of Object.entries(isPlainObject(parsed?.files) ? parsed.files : {})) {
      if (!isPlainObject(value)) continue
      files[rel] = {
        sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
        bytes: Number.isFinite(value.bytes) ? value.bytes : 0,
      }
    }
    return {
      present: true,
      version: Number.isFinite(parsed?.version) ? parsed.version : 1,
      device: typeof parsed?.device === 'string' ? parsed.device : '',
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
      files,
      warnings: [],
    }
  } catch (error) {
    return { ...empty, warnings: [`profile/manifest.json не разобран: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

function manifestBytes(manifest, file) {
  const entry = isPlainObject(manifest?.files) ? manifest.files[file] : undefined
  return isPlainObject(entry) && Number.isFinite(entry.bytes) ? entry.bytes : undefined
}

// --- «нужно ли что-то применять» для единиц с частичным слиянием ------------

/**
 * Частичные единицы (патч, настройки, плагины) не всегда становятся побайтно
 * равны зеркалу: локальные безопасные записи и неизвестные ключи остаются.
 * Поэтому «применять ли» решаем по вложенности: есть ли в зеркале значение,
 * которого нет локально. Так план не появляется повторно из-за локальных
 * дополнений.
 */
export function needsPatchMerge(localEntries, remoteEntries) {
  const local = new Map((Array.isArray(localEntries) ? localEntries : []).map(entry => [entry?.id, entry?.config ?? {}]))
  for (const entry of Array.isArray(remoteEntries) ? remoteEntries : []) {
    if (!isPlainObject(entry)) continue
    const spec = SAFE_PATCH_ENTRIES[entry.id]
    if (spec === undefined) continue
    const current = local.get(entry.id)
    if (!isPlainObject(current)) return true
    for (const key of spec.keys) {
      if (!Object.prototype.hasOwnProperty.call(entry.config ?? {}, key)) continue
      if (JSON.stringify(current[key]) !== JSON.stringify(entry.config[key])) return true
    }
  }
  return false
}

export function needsSettingsMerge(localValue, remoteValue) {
  for (const [key, value] of Object.entries(isPlainObject(remoteValue) ? remoteValue : {})) {
    if (JSON.stringify(isPlainObject(localValue) ? localValue[key] : undefined) !== JSON.stringify(value)) return true
  }
  return false
}

export function needsBundlesMerge(localBundles, remoteBundles, profileDir) {
  const known = new Set(Array.isArray(localBundles) ? localBundles : [])
  for (const name of Array.isArray(remoteBundles) ? remoteBundles : []) {
    if (known.has(name)) continue
    if (profileDir === undefined || isInstalledInProfile(profileDir, name)) return true
  }
  return false
}

// --- план приёма, применение и журнал применения ---------------------------

/** План приёма: что, откуда и когда приехало; конфликты не применяются. */
export async function planProfilePull({ home, config, repoDir, neutralizer }) {
  const ne = neutralizer ?? createNeutralizer({ home: homedir(), dshHome: home })
  const mirror = await readProfileMirror(repoDir)
  const plan = {
    version: 1,
    at: new Date().toISOString(),
    repoDir: typeof repoDir === 'string' ? repoDir : '',
    profileDir: undefined,
    mirrorPresent: mirror.present,
    source: {
      device: mirror.manifest?.device ?? '',
      updatedAt: mirror.manifest?.updatedAt ?? '',
      version: mirror.manifest?.version ?? 1,
    },
    entries: [],
    conflicts: [],
    warnings: [...mirror.warnings],
    manifest: {
      present: mirror.manifest?.present === true,
      files: Object.keys(mirror.manifest?.files ?? {}).length,
    },
  }
  if (!mirror.present) return plan
  const snapshot = await readProfileSnapshot({ home, config, neutralizer: ne })
  plan.profileDir = snapshot.profileDir
  plan.warnings.push(...snapshot.warnings)
  if (snapshot.profileDir === undefined) return plan
  const base = await readBase(home)
  const localHashes = profileHashes(snapshot)
  const remoteHashes = mirrorHashes(mirror)
  const pushLegacy = (file, kind, needed, extra = {}) => {
    const remoteHash = remoteHashes[file]
    if (remoteHash === undefined) return
    const localHash = localHashes[file]
    const decision = decideSync({ baseHash: base.entries[file], localHash, remoteHash })
    // Конфликт важен только если действительно есть что применять: локальные
    // дополнения (безопасные записи, неизвестные ключи) не конфликт.
    const conflict = needed === true && decision.conflict
    if (conflict) {
      plan.conflicts.push({ file, reason: decision.reason, resolution: 'локальная копия сохранена' })
    }
    plan.entries.push({
      file,
      kind,
      ...extra,
      action: needed !== true ? 'skip' : conflict ? 'conflict' : 'apply',
      localHash,
      remoteHash,
      reason: conflict ? decision.reason : needed === true ? 'в зеркале есть изменения' : 'совпадает',
      bytes: manifestBytes(mirror.manifest, file),
    })
  }
  if (mirror.patch.present) pushLegacy(PROFILE_PATCH_FILE, 'patch', needsPatchMerge(snapshot.patch.entries, mirror.patch.entries))
  if (mirror.bundles.present) {
    const localBundles = snapshot.bundles.bundles ?? []
    for (const name of mirror.bundles.bundles) {
      if (localBundles.includes(name)) continue
      if (isInstalledInProfile(snapshot.profileDir, name)) continue
      plan.warnings.push(`плагин ${name}: не установлен в этом профиле`)
    }
    pushLegacy(PROFILE_BUNDLES_FILE, 'bundles', needsBundlesMerge(localBundles, mirror.bundles.bundles, snapshot.profileDir))
  }
  for (const plugin of Object.keys(mirror.settings)) {
    pushLegacy(
      `${PROFILE_SETTINGS_DIR}/${plugin}.json`,
      'settings',
      needsSettingsMerge(snapshot.settings.settings[plugin], mirror.settings[plugin]),
      { plugin },
    )
  }
  if (mirror.inbox.present) {
    if (snapshot.extras?.inbox?.found === true) {
      pushLegacy(PROFILE_INBOX_FILE, 'inbox', needsSettingsMerge(snapshot.extras.inbox.settings, mirror.inbox.settings))
    } else {
      plan.warnings.push('настройки «Входящих» не применены: локальный state.json не найден (плагин «Входящие» не установлен)')
      plan.entries.push({
        file: PROFILE_INBOX_FILE,
        kind: 'inbox',
        action: 'skip',
        localHash: localHashes[PROFILE_INBOX_FILE],
        remoteHash: remoteHashes[PROFILE_INBOX_FILE],
        reason: 'локальный файл «Входящих» не найден',
        bytes: manifestBytes(mirror.manifest, PROFILE_INBOX_FILE),
      })
    }
  }
  const extras = snapshot.extras ?? emptyExtras()
  if (mirror.expenses.present) {
    const needed = needsExpenseMerge(extras.expenses?.sessions ?? {}, mirror.expenses.sessions)
    plan.entries.push({
      file: PROFILE_EXPENSES_FILE,
      kind: 'expenses',
      action: needed ? 'apply' : 'skip',
      localHash: localHashes[PROFILE_EXPENSES_FILE],
      remoteHash: remoteHashes[PROFILE_EXPENSES_FILE],
      reason: needed ? 'в зеркале есть записи новее или которых нет локально' : 'совпадает',
      bytes: manifestBytes(mirror.manifest, PROFILE_EXPENSES_FILE),
    })
  }
  if (mirror.schedule.present) {
    const needed = needsScheduleMerge(extras.schedule?.tasks ?? {}, mirror.schedule.tasks)
    plan.entries.push({
      file: PROFILE_SCHEDULE_FILE,
      kind: 'schedule',
      action: needed ? 'apply' : 'skip',
      localHash: localHashes[PROFILE_SCHEDULE_FILE],
      remoteHash: remoteHashes[PROFILE_SCHEDULE_FILE],
      reason: needed ? 'в зеркале есть задачи новее или которых нет локально' : 'совпадает',
      bytes: manifestBytes(mirror.manifest, PROFILE_SCHEDULE_FILE),
    })
  }
  return plan
}

/** Краткая сводка плана для панели. */
export function summarizePlan(plan) {
  const entries = (plan?.entries ?? []).map(entry => ({
    file: entry.file,
    kind: entry.kind ?? '',
    ...(entry.plugin !== undefined ? { plugin: entry.plugin } : {}),
    action: entry.action,
    bytes: entry.bytes,
    reason: entry.reason ?? '',
  }))
  return {
    present: entries.length > 0,
    at: plan?.at ?? '',
    repoDir: plan?.repoDir ?? '',
    source: plan?.source ?? { device: '', updatedAt: '' },
    entries,
    files: entries.filter(entry => entry.action === 'apply').length,
    conflictCount: entries.filter(entry => entry.action === 'conflict').length,
    conflicts: plan?.conflicts ?? [],
    manifest: plan?.manifest ?? { present: false, files: 0 },
  }
}

function planFilePath(home) {
  return join(home, 'dsh-sync', PROFILE_PLAN_FILE)
}

function applyFilePath(home) {
  return join(home, 'dsh-sync', PROFILE_APPLY_FILE)
}

/** Сохранить отложенный план рядом с локальным состоянием синхронизации. */
export async function writeProfilePlan(home, plan) {
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  const value = {
    version: 1,
    at: plan.at ?? new Date().toISOString(),
    repoDir: plan.repoDir ?? '',
    source: plan.source ?? { device: '', updatedAt: '' },
    manifest: plan.manifest ?? { present: false, files: 0 },
    entries: (plan.entries ?? []).map(entry => ({
      file: entry.file,
      kind: entry.kind,
      ...(entry.plugin !== undefined ? { plugin: entry.plugin } : {}),
      action: entry.action,
      localHash: entry.localHash,
      remoteHash: entry.remoteHash,
      bytes: entry.bytes,
    })),
    conflicts: plan.conflicts ?? [],
    warnings: (plan.warnings ?? []).slice(0, 20),
  }
  await writeFile(planFilePath(home), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return value
}

export async function readProfilePlan(home) {
  const file = planFilePath(home)
  const empty = { present: false, version: 1, at: '', repoDir: '', source: { device: '', updatedAt: '' }, manifest: { present: false, files: 0 }, entries: [], conflicts: [], warnings: [] }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return {
      present: true,
      version: Number.isFinite(parsed?.version) ? parsed.version : 1,
      at: typeof parsed?.at === 'string' ? parsed.at : '',
      repoDir: typeof parsed?.repoDir === 'string' ? parsed.repoDir : '',
      source: isPlainObject(parsed?.source) ? parsed.source : { device: '', updatedAt: '' },
      manifest: isPlainObject(parsed?.manifest) ? parsed.manifest : { present: false, files: 0 },
      entries: Array.isArray(parsed?.entries) ? parsed.entries.filter(entry => isPlainObject(entry) && typeof entry.file === 'string') : [],
      conflicts: Array.isArray(parsed?.conflicts) ? parsed.conflicts : [],
      warnings: Array.isArray(parsed?.warnings) ? parsed.warnings : [],
    }
  } catch {
    return empty
  }
}

/** Убрать отложенный план; возвращает true, если файл был. */
export async function clearProfilePlan(home) {
  const file = planFilePath(home)
  if (!existsSync(file)) return false
  await rm(file, { force: true }).catch(() => {})
  return true
}

/** Записать итог применения — карточка «Профиль» показывает его в журнале. */
export async function writeProfileApplyRecord(home, record) {
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  const value = {
    version: 1,
    at: new Date().toISOString(),
    mode: record.mode ?? 'manual',
    applied: record.applied ?? 0,
    conflicts: record.conflicts ?? 0,
    files: Array.isArray(record.files) ? record.files : [],
    device: typeof record.device === 'string' ? record.device : '',
  }
  await writeFile(applyFilePath(home), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return value
}

export async function readProfileApplyRecord(home) {
  const file = applyFilePath(home)
  if (!existsSync(file)) return { present: false }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return {
      present: true,
      at: typeof parsed?.at === 'string' ? parsed.at : '',
      mode: typeof parsed?.mode === 'string' ? parsed.mode : 'manual',
      applied: Number.isFinite(parsed?.applied) ? parsed.applied : 0,
      conflicts: Number.isFinite(parsed?.conflicts) ? parsed.conflicts : 0,
      files: Array.isArray(parsed?.files) ? parsed.files : [],
      device: typeof parsed?.device === 'string' ? parsed.device : '',
    }
  } catch {
    return { present: false }
  }
}

/** Применить одну единицу плана к локальному профилю. */
async function applyPlanEntry({ home, profileDir, entry, mirror, neutralizer }) {
  if (entry.kind === 'patch') {
    const result = await applyPatchMirror(profileDir, mirror.patch.entries, neutralizer)
    if (result.ok === false) return { ok: false, warning: result.warning }
    return { ok: true, detail: { file: entry.file, kind: 'patch', changed: result.changed ?? 0, backup: result.backup } }
  }
  if (entry.kind === 'bundles') {
    const result = await applyBundlesMirror(profileDir, mirror.bundles.bundles)
    if (result.ok === false) return { ok: false, warning: result.warning }
    return {
      ok: true,
      detail: { file: entry.file, kind: 'bundles', added: result.added.length },
      warnings: result.skipped.map(item => `плагин ${item.name}: ${item.reason}`),
    }
  }
  if (entry.kind === 'settings') {
    const plugin = entry.plugin
    const value = isPlainObject(mirror.settings) ? mirror.settings[plugin] : undefined
    if (!isPlainObject(value)) return { ok: false, warning: `настройки ${plugin} пропали из зеркала` }
    const pendingBrowser = (await readPendingBrowserSettings(home)).settings
    const result = await applyPluginSettings({ home, settings: { [plugin]: value }, browserPending: pendingBrowser })
    if (result.skipped.length > 0) {
      return { ok: false, warning: `настройки ${plugin} не записаны: ${result.skipped[0].reason}` }
    }
    return { ok: true, detail: { file: entry.file, kind: 'settings', plugin } }
  }
  if (entry.kind === 'inbox') {
    const result = await applyInboxMirror({ home, settings: mirror.inbox.settings, neutralizer })
    if (result.ok === false) return { ok: false, warning: result.warning }
    return { ok: true, detail: { file: entry.file, kind: 'inbox', changed: result.changed } }
  }
  if (entry.kind === 'expenses') {
    const result = await applyExpensesMirror({ home, sessions: mirror.expenses.sessions, neutralizer })
    return { ok: true, detail: { file: entry.file, kind: 'expenses', changed: result.changed, added: result.added, updated: result.updated, backup: result.backup } }
  }
  if (entry.kind === 'schedule') {
    const result = await applyScheduleMirror({ home, tasks: mirror.schedule.tasks, neutralizer })
    return { ok: true, detail: { file: entry.file, kind: 'schedule', changed: result.changed, added: result.added, updated: result.updated, backup: result.backup } }
  }
  return { ok: false, warning: `неизвестная единица профиля: ${entry.kind}` }
}

/** Применить набор единиц плана; базис выставляем по локальному состоянию. */
async function applyPlanEntries({ home, config, profileDir, entries, mirror, neutralizer, base }) {
  const applied = []
  const warnings = []
  let baseChanged = false
  for (const entry of entries) {
    if (entry.action !== 'apply') continue
    let result
    try {
      result = await applyPlanEntry({ home, profileDir, entry, mirror, neutralizer })
    } catch (error) {
      warnings.push(`${entry.file} не применён: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (result.ok === false) {
      if (typeof result.warning === 'string' && result.warning !== '') warnings.push(result.warning)
      continue
    }
    applied.push(result.detail)
    for (const text of result.warnings ?? []) {
      if (typeof text === 'string' && text !== '') warnings.push(text)
    }
  }
  // После применения перечитываем локальный профиль: базис — это локальное
  // состояние после слияния, а не побайтно зеркало. Локальные дополнения
  // (безопасные записи, неизвестные ключи) остаются и не должны выглядеть
  // конфликтом при следующем приёме.
  if (base !== undefined && applied.length > 0) {
    try {
      const after = await readProfileSnapshot({ home, config, neutralizer })
      const afterHashes = profileHashes(after)
      for (const detail of applied) {
        if (EXTRA_PROFILE_FILES.has(detail.file)) continue
        const hash = afterHashes[detail.file]
        if (hash === undefined) continue
        base.entries[detail.file] = hash
        baseChanged = true
      }
    } catch {
      // базис — вспомогательная структура, приём уже прошёл
    }
  }
  return { applied, warnings, baseChanged }
}
