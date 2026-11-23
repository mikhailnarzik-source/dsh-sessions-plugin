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
 *   profile/conflicts.json        журнал конфликтов приёма/отправки
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
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex')
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
  if (exists) {
    const backupDir = join(profileDir, '.dsh-sync-backup')
    await mkdir(backupDir, { recursive: true })
    await copyFile(file, join(backupDir, `cordis.patch.yml.${Date.now()}`))
  }
  await writeFile(file, joinPatchParts(parts.header, serialized, parts.tail), 'utf8')
  return { ok: true, changed }
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
  await copyFile(file, join(profileDir, '.dsh-sync-backup', `package.json.${Date.now()}`)).catch(() => {})
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
        const backupDir = join(home, 'dsh-sync', 'backups', 'profile')
        await mkdir(backupDir, { recursive: true })
        await copyFile(file, join(backupDir, `${plugin}.json.${Date.now()}`))
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
 * @returns {{profileDir?: string, patch, bundles, settings, sources, warnings}}
 */
export async function readProfileSnapshot({ home, config, neutralizer }) {
  const profileDir = resolveProfileDir(home, config)
  const ne = neutralizer ?? createNeutralizer({ home: homedir(), dshHome: home })
  if (profileDir === undefined) {
    return { profileDir: undefined, warnings: ['каталог профиля не найден — профильный слой пропущен'], patch: { entries: [], present: false }, bundles: { bundles: [], present: false }, settings: { settings: {}, sources: {} }, sources: {} }
  }
  const patch = await readLocalPatch(profileDir, ne)
  const bundles = await readLocalBundles(profileDir)
  const browserSettings = await readBrowserSettings(home)
  const settings = await readPluginSettings({ home, neutralizer: ne, browserSettings })
  return {
    profileDir,
    patch,
    bundles,
    settings,
    sources: settings.sources,
    warnings: [...patch.warnings, ...settings.warnings],
  }
}

/** Записать снимок профиля в зеркало (порядок вызовов важен для тестов). */
export async function writeProfileMirror(repoDir, snapshot) {
  await writePatchMirror(repoDir, snapshot.patch.entries)
  await writeBundlesMirror(repoDir, snapshot.bundles.bundles)
  const written = await writeSettingsMirror(repoDir, snapshot.settings.settings)
  return { patchEntries: snapshot.patch.entries.length, bundles: snapshot.bundles.bundles.length, settings: written.written }
}

/** Хеш переносимого снимка по каждой единице синхронизации. */
export function profileHashes(snapshot) {
  return {
    [PROFILE_PATCH_FILE]: hashOf(snapshot.patch.entries),
    [PROFILE_BUNDLES_FILE]: hashOf(snapshot.bundles.bundles),
    ...Object.fromEntries(Object.entries(snapshot.settings.settings).map(([plugin, value]) => [`${PROFILE_SETTINGS_DIR}/${plugin}.json`, hashOf(value)])),
  }
}

/** Хеши единиц, лежащих в зеркале. */
export function mirrorHashes(mirror) {
  return {
    [PROFILE_PATCH_FILE]: hashOf(mirror.patch.entries),
    [PROFILE_BUNDLES_FILE]: hashOf(mirror.bundles.bundles),
    ...Object.fromEntries(Object.entries(mirror.settings ?? {}).map(([plugin, value]) => [`${PROFILE_SETTINGS_DIR}/${plugin}.json`, hashOf(value)])),
  }
}

/** Прочитать всё профильное зеркало. */
export async function readProfileMirror(repoDir) {
  const patch = await readPatchMirror(repoDir)
  const bundles = await readBundlesMirror(repoDir)
  const settings = await readSettingsMirror(repoDir)
  const journal = await readJournal(repoDir)
  return {
    patch,
    bundles,
    settings: settings.settings,
    warnings: [...patch.warnings, ...settings.warnings],
    present: patch.present || bundles.present || Object.keys(settings.settings).length > 0,
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
    const decision = decideSync({ baseHash: base.entries[file], localHash, remoteHash: remoteHashes[file] })
    if (decision.conflict) {
      conflicts.push({ file, reason: decision.reason, resolution: 'локальная копия отправлена в зеркало' })
    }
    base.entries[file] = localHash
  }
  // Удалённые локально настройки: если запись была в базисе и в зеркале, но
  // локально исчезла — трогать зеркало не будем (на другом устройстве она жива).
  const result = await writeProfileMirror(repoDir, snapshot)
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
 * Приём профильного слоя: подставить локальные пути и применить настройки.
 * При конфликте локальная копия не затирается — случай пишется в журнал.
 */
export async function pullProfile({ home, config, repoDir, neutralizer, dryRun = false }) {
  const ne = neutralizer ?? createNeutralizer({ home: homedir(), dshHome: home })
  const mirror = await readProfileMirror(repoDir)
  if (!mirror.present) {
    return { skipped: true, reason: 'в зеркале нет профильного слоя', conflicts: 0, applied: 0, warnings: mirror.warnings }
  }
  const snapshot = await readProfileSnapshot({ home, config, neutralizer: ne })
  if (snapshot.profileDir === undefined) {
    return { skipped: true, reason: 'каталог профиля не найден', conflicts: 0, applied: 0, warnings: [...mirror.warnings, ...snapshot.warnings] }
  }
  const base = await readBase(home)
  const localHashes = profileHashes(snapshot)
  const remoteHashes = mirrorHashes(mirror)
  const conflicts = []
  const applied = []
  const warnings = [...mirror.warnings, ...snapshot.warnings]
  const patchDecision = decideSync({
    baseHash: base.entries[PROFILE_PATCH_FILE],
    localHash: localHashes[PROFILE_PATCH_FILE],
    remoteHash: remoteHashes[PROFILE_PATCH_FILE],
  })
  if (patchDecision.conflict) {
    conflicts.push({ file: PROFILE_PATCH_FILE, reason: patchDecision.reason, resolution: 'локальная копия сохранена' })
  } else {
    if (patchDecision.apply && mirror.patch.entries.length > 0) {
      if (!dryRun) {
        const result = await applyPatchMirror(snapshot.profileDir, mirror.patch.entries, ne)
        if (result.ok === false) warnings.push(result.warning)
        else if (result.changed > 0) applied.push({ file: PROFILE_PATCH_FILE, changed: result.changed })
      }
    }
    // Базис фиксируем даже когда копии совпали: иначе следующее расхождение
    // не с чем сравнивать и конфликт не будет замечен.
    if (remoteHashes[PROFILE_PATCH_FILE] !== undefined) base.entries[PROFILE_PATCH_FILE] = remoteHashes[PROFILE_PATCH_FILE]
  }

  const bundlesDecision = decideSync({
    baseHash: base.entries[PROFILE_BUNDLES_FILE],
    localHash: localHashes[PROFILE_BUNDLES_FILE],
    remoteHash: remoteHashes[PROFILE_BUNDLES_FILE],
  })
  if (bundlesDecision.conflict) {
    conflicts.push({ file: PROFILE_BUNDLES_FILE, reason: bundlesDecision.reason, resolution: 'список плагинов не изменён' })
  } else {
    if (bundlesDecision.apply && mirror.bundles.bundles.length > 0 && !dryRun) {
      const result = await applyBundlesMirror(snapshot.profileDir, mirror.bundles.bundles)
      if (result.warning !== undefined) warnings.push(result.warning)
      if (result.added.length > 0) applied.push({ file: PROFILE_BUNDLES_FILE, added: result.added })
      for (const item of result.skipped) warnings.push(`плагин ${item.name}: ${item.reason}`)
    }
    if (remoteHashes[PROFILE_BUNDLES_FILE] !== undefined) base.entries[PROFILE_BUNDLES_FILE] = remoteHashes[PROFILE_BUNDLES_FILE]
  }

  const settingsToApply = {}
  for (const [plugin, value] of Object.entries(mirror.settings)) {
    const file = `${PROFILE_SETTINGS_DIR}/${plugin}.json`
    const decision = decideSync({
      baseHash: base.entries[file],
      localHash: localHashes[file],
      remoteHash: remoteHashes[file],
    })
    if (decision.conflict) {
      conflicts.push({ file, reason: decision.reason, resolution: 'локальные настройки сохранены' })
      continue
    }
    if (remoteHashes[file] !== undefined) base.entries[file] = remoteHashes[file]
    if (!decision.apply) continue
    settingsToApply[plugin] = value
  }
  if (Object.keys(settingsToApply).length > 0 && !dryRun) {
    const pendingBrowser = (await readPendingBrowserSettings(home)).settings
    const result = await applyPluginSettings({ home, settings: settingsToApply, browserPending: pendingBrowser })
    if (result.applied.length > 0) applied.push({ file: PROFILE_SETTINGS_DIR, settings: result.applied })
    for (const item of result.skipped) warnings.push(`настройки ${item.plugin} не записаны: ${item.reason}`)
  }

  if (conflicts.length > 0 && !dryRun) await appendJournal(repoDir, conflicts, config?.deviceId)
  if (!dryRun) await writeBase(home, base)
  return {
    skipped: false,
    applied: applied.length,
    details: applied,
    conflicts: conflicts.length,
    conflictDetails: conflicts,
    warnings,
  }
}

/** Краткий статус профильного слоя для панели. */
export async function readProfileStatus({ home, config }) {
  const profileDir = resolveProfileDir(home, config)
  const ne = createNeutralizer({ home: homedir(), dshHome: home })
  const snapshot = await readProfileSnapshot({ home, config, neutralizer: ne })
  const repoDir = typeof config?.repoDir === 'string' ? config.repoDir : ''
  const mirror = repoDir === ''
    ? { patch: { present: false, entries: [] }, bundles: { present: false, bundles: [] }, settings: {}, present: false }
    : await readProfileMirror(repoDir)
  const journal = repoDir === '' ? { entries: [] } : await readJournal(repoDir)
  const bundles = snapshot.bundles.bundles ?? []
  return {
    enabled: config?.profile?.enabled !== false,
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
    mirror: {
      present: mirror.present,
      patchEntries: mirror.patch.entries.map(entry => entry.id),
      bundles: mirror.bundles.bundles.length,
      settings: Object.keys(mirror.settings),
    },
    conflicts: journal.entries.slice(-5),
    conflictCount: journal.entries.length,
    pendingBrowser: Object.keys((await readPendingBrowserSettings(home)).settings).length,
  }
}
