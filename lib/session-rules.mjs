/**
 * Правила сессий (M6, задача 22, этапы 1–2) — только host-слой, без UI.
 *
 * Правило говорит движку синхронизации, что можно делать с сессией:
 * защищать её от удаления из зеркала (`protect`), отправлять только с
 * устройства-владельца (`ownerDevice`), не принимать молча чужие изменения
 * (`notifyForeignAppend`), держать лог в пределах лимита (`maxMb`,
 * предложение перевести в локальные) и запрещать развилку копий (`forbidFork`).
 *
 * Файл правил — настройка синхронизации, поэтому он живёт в домашнем каталоге
 * DSH рядом с режимами сессий: `~/.dsh/dsh-sync/session-rules.json`.
 *
 * Формат (версия 1):
 * {
 *   "version": 1,
 *   "updatedAt": "2026-11-25T00:00:00.000Z",
 *   "presets": {
 *     "control": { "protect": true, "maxMb": 15, "forbidFork": true, "notifyForeignAppend": true },
 *     "keep":    { "protect": true },
 *     "archive": { "syncMode": "local", "protect": true }
 *   },
 *   "sessions": {
 *     "session-<id>": {
 *       "preset": "control", "ownerDevice": "device-a", "protect": true,
 *       "maxMb": 15, "forbidFork": true, "notifyForeignAppend": true,
 *       "syncMode": "local", "autoLocal": false, "updatedAt": "…"
 *     }
 *   },
 *   "matches": [
 *     { "workspaceId": "alpha", "titlePrefix": "Деплой", "preset": "control", "updatedAt": "…" }
 *   ]
 * }
 *
 * - `presets` — шаблоны полей. Пресет применяется при создании правила
 *   (поля сразу раскладываются в запись) и при разборе правила из файла.
 * - `sessions` — правила конкретных сессий. Ключ нормализуется
 *   (`normalizeSessionId`, как в остальном плагине).
 * - `matches` — правила по рабочему пространству и префиксу названия: сессия
 *   получает их, если для неё нет отдельного правила и она не наследует
 *   правило родителя.
 *
 * Наследование: правило родителя (вверх по цепочке `parentSession`) действует
 * на субагентов. Ребёнок без своего правила наследует preset/protect/maxMb/
 * ownerDevice (и остальные поля правила), источник помечается
 * `ruleSource: 'parent'` + `inheritedFrom`. Собственное правило ребёнка сильнее
 * наследования; при его создании возвращается предупреждение (не блок).
 *
 * Конфликты при merge: у каждой записи есть `updatedAt`; при слиянии двух
 * экземпляров файла (второе устройство, профильный слой) побеждает более
 * свежая запись. Конфликт (в том числе равное время с разными данными)
 * записывается в `~/.dsh/dsh-sync/rules-history.jsonl` и, если вызывающий
 * передал зеркало, в `profile/conflicts.json` (через `appendJournal` в sync.mjs).
 *
 * Модуль не знает про delete/push/pull и не пишет логи сессий: им пользуются
 * `lib/deletions.mjs` (protect), `lib/sync.mjs` (ownerDevice, maxMb, forbidFork)
 * и UI-слой для полей `protected`/`ownerBlocked`/`overLimit`/`ruleSource`.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeSessionId } from './session-modes.mjs'

/** Имя файла правил в `~/.dsh/dsh-sync/`. */
export const RULES_FILE = 'session-rules.json'
/** Версия формата хранилища правил. */
export const RULES_VERSION = 1
/** Журнал конфликтов слияния правил (по строке JSON на конфликт). */
export const RULES_HISTORY_FILE = 'rules-history.jsonl'
/** Копия правил в зеркале: второе устройство видит их вместе с профилем. */
export const RULES_PROFILE_RELATIVE = join('profile', RULES_FILE)
/** Встроенные пресеты: control — важная сессия, keep — не удалять, archive — локальная. */
export const PRESET_NAMES = ['control', 'keep', 'archive']
/** Один мегабайт: лимит `maxMb` и размеры в отчёте считаются в нём. */
export const MB = 1024 * 1024
/** Подпись строки плана/отчёта для защищённой сессии. */
export const PROTECTED_RULE_LABEL = 'защищена правилом'
/** Сообщение для push/pull, когда сессией владеет другое устройство. */
export const OWNER_RULE_MESSAGE = 'правило: только владелец'
/** Предложение, когда лог перерос `maxMb`. */
export const LIMIT_RULE_HINT = 'перевести в локальные'
/** Сколько последних записей журнала конфликтов отдавать по умолчанию. */
export const RULES_HISTORY_LIMIT = 200

/**
 * Встроенные значения пресетов. Пользовательский файл может их переопределить:
 * поля пресета в файле сильнее встроенных, поля правила — сильнее пресета.
 */
export const DEFAULT_PRESETS = Object.freeze({
  control: Object.freeze({ protect: true, maxMb: 15, forbidFork: true, notifyForeignAppend: true }),
  keep: Object.freeze({ protect: true }),
  archive: Object.freeze({ syncMode: 'local', protect: true }),
})

// --- служебные ---------------------------------------------------------------

/** Время в ISO: число/Date/строка, иначе «сейчас». */
export function isoTime(now) {
  if (now instanceof Date) return now.toISOString()
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString()
  if (typeof now === 'string' && now !== '') {
    const parsed = Date.parse(now)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

/** Время записи в мс: `updatedAt` или 0. */
function timeOf(entry) {
  const parsed = Date.parse(String(entry?.updatedAt ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function round1(value) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10) / 10
}

/** Копия встроенных пресетов, чтобы никто не менял общий объект. */
function defaultPresets() {
  const presets = {}
  for (const name of PRESET_NAMES) presets[name] = { ...DEFAULT_PRESETS[name] }
  return presets
}

/** Число мегабайт для отчёта: 15 → «15», 0.3 → «0.3», 0.001 → «0.001». */
export function formatMb(value) {
  if (!Number.isFinite(value)) return '—'
  // Крупные лимиты — до десятых, мелкие — до тысячных: 0.001 не должен стать «0».
  const rounded = value >= 1 ? round1(value) : Math.round(value * 1000) / 1000
  return String(rounded)
}

/**
 * Идентификатор сессии в том же виде, что и в остальных файлах плагина:
 * без префикса `session-` он добавляется, пустой — отбрасывается.
 */
export function normalizeRuleId(sessionId) {
  return normalizeSessionId(sessionId)
}

/** Пустой файл правил: встроенные пресеты, ни одной сессии. */
export function emptyRules() {
  return {
    version: RULES_VERSION,
    updatedAt: '',
    presets: defaultPresets(),
    sessions: {},
    matches: [],
  }
}

/**
 * Нормализовать поля одного правила. Неизвестные ключи отбрасываются, значения
 * приводятся к типам формата: так один и тот же файл после чтения/записи
 * остаётся стабильным, а сравнение `updatedAt` имеет смысл.
 */
export function normalizeRuleFields(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const result = {}
  const preset = trimString(source.preset)
  if (preset !== '') result.preset = preset
  for (const key of ['protect', 'forbidFork', 'notifyForeignAppend', 'autoLocal']) {
    if (typeof source[key] === 'boolean') result[key] = source[key]
  }
  if (Number.isFinite(source.maxMb)) {
    if (source.maxMb > 0) result.maxMb = source.maxMb
  } else if (typeof source.maxMb === 'string' && source.maxMb.trim() !== '') {
    const parsed = Number.parseFloat(source.maxMb)
    if (Number.isFinite(parsed) && parsed > 0) result.maxMb = parsed
  }
  const ownerDevice = trimString(source.ownerDevice)
  if (ownerDevice !== '') result.ownerDevice = ownerDevice
  if (source.syncMode === 'local' || source.syncMode === 'cloud') result.syncMode = source.syncMode
  const updatedAt = trimString(source.updatedAt)
  if (updatedAt !== '' && Number.isFinite(Date.parse(updatedAt))) result.updatedAt = new Date(Date.parse(updatedAt)).toISOString()
  return result
}

/** Нормализовать одну запись `matches`; без workspace/titlePrefix запись бессмысленна. */
function normalizeMatch(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const workspaceId = trimString(raw.workspaceId)
  const titlePrefix = trimString(raw.titlePrefix)
  if (workspaceId === '' && titlePrefix === '') return undefined
  const match = normalizeRuleFields(raw)
  if (workspaceId !== '') match.workspaceId = workspaceId
  if (titlePrefix !== '') match.titlePrefix = titlePrefix
  return match
}

/**
 * Привести прочитанный файл к формату версии 1: битые записи отбрасываются,
 * встроенные пресеты всегда на месте, id нормализуются.
 */
export function normalizeRules(raw) {
  const rules = emptyRules()
  if (raw === null || typeof raw !== 'object') return rules
  rules.version = RULES_VERSION
  const updatedAt = trimString(raw.updatedAt)
  if (updatedAt !== '' && Number.isFinite(Date.parse(updatedAt))) rules.updatedAt = new Date(Date.parse(updatedAt)).toISOString()

  const presets = raw.presets !== null && typeof raw.presets === 'object' ? raw.presets : {}
  for (const [rawName, fields] of Object.entries(presets)) {
    const name = trimString(rawName)
    if (name === '' || fields === null || typeof fields !== 'object') continue
    const normalized = normalizeRuleFields(fields)
    delete normalized.preset
    delete normalized.updatedAt
    rules.presets[name] = { ...(rules.presets[name] ?? {}), ...normalized }
  }

  for (const [rawId, rawEntry] of Object.entries(raw.sessions ?? {})) {
    const id = normalizeRuleId(rawId)
    if (id === '' || rawEntry === null || typeof rawEntry !== 'object') continue
    rules.sessions[id] = normalizeRuleFields(rawEntry)
  }

  const matches = Array.isArray(raw.matches) ? raw.matches : []
  for (const rawMatch of matches) {
    const match = normalizeMatch(rawMatch)
    if (match !== undefined) rules.matches.push(match)
  }
  return rules
}

// --- путь и атомарная запись --------------------------------------------------

/** Путь файла правил этого устройства. */
export function rulesPath(home) {
  return join(home, 'dsh-sync', RULES_FILE)
}

/** Путь журнала конфликтов слияния правил этого устройства. */
export function rulesHistoryPath(home) {
  return join(home, 'dsh-sync', RULES_HISTORY_FILE)
}

/** Путь копии правил в зеркале (рядом с файлами профиля). */
export function rulesProfilePath(repoDir) {
  return join(repoDir, RULES_PROFILE_RELATIVE)
}

/** Атомарная запись JSON: временный файл рядом + rename (не теряет старый при сбое). */
async function writeJsonAtomic(target, payload) {
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
  return payload
}

/**
 * Прочитать правила устройства. Нет файла или он битый — пустые правила, а не
 * падение синхронизации: правило — настройка, без неё работа продолжается.
 */
export async function readSessionRules(home) {
  if (typeof home !== 'string' || home === '') return emptyRules()
  const path = rulesPath(home)
  if (!existsSync(path)) return emptyRules()
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return normalizeRules(parsed)
  } catch {
    return emptyRules()
  }
}

/**
 * Записать правила атомарно. `updatedAt` вызывающего сохраняется (это важно для
 * merge: более свежее хранилище не должно «омолаживаться» каждым чтением);
 * пустое время записи заменяется текущим.
 */
export async function writeSessionRules(home, rules) {
  if (typeof home !== 'string' || home === '') throw new Error('не задан каталог DSH для файла правил')
  const saved = normalizeRules(rules)
  if (saved.updatedAt === '') saved.updatedAt = isoTime()
  await writeJsonAtomic(rulesPath(home), saved)
  return saved
}

/** Копия правил в зеркало профиля — второе устройство увидит их при pull. */
export async function writeRulesProfile({ repoDir, rules } = {}) {
  if (typeof repoDir !== 'string' || repoDir === '') throw new Error('не задан каталог зеркала для правил')
  const payload = normalizeRules(rules)
  await writeJsonAtomic(rulesProfilePath(repoDir), payload)
  return payload
}

/** Прочитать копию правил из зеркала; нет файла — undefined. */
export async function readRulesProfile({ repoDir } = {}) {
  if (typeof repoDir !== 'string' || repoDir === '') return undefined
  const path = rulesProfilePath(repoDir)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    return normalizeRules(parsed)
  } catch {
    return undefined
  }
}

// --- пресеты и сопоставление --------------------------------------------------

/** Поля пресета: встроенные значения, перекрытые полями файла. */
export function resolvePreset(rules, presetName) {
  const name = trimString(presetName)
  if (name === '') return {}
  const builtin = DEFAULT_PRESETS[name] ?? {}
  const custom = rules?.presets?.[name]
  const fields = custom !== null && typeof custom === 'object' ? normalizeRuleFields(custom) : {}
  return { ...builtin, ...fields }
}

/**
 * Найти правило `matches` для сессии: рабочее пространство и/или префикс
 * названия. Более специфичная запись (длиннее префикс, есть workspace) главнее;
 * при равной специфичности — более свежая; при равенстве — первая в файле.
 */
export function findMatchRule(rules, { session, workspaceId } = {}) {
  const entries = Array.isArray(rules?.matches) ? rules.matches : []
  if (entries.length === 0) return undefined
  const title = trimString(session?.title ?? session?.name)
  const workspace = trimString(workspaceId ?? session?.workspaceId)
  let best
  let bestScore = -1
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const entryWorkspace = trimString(entry.workspaceId)
    if (entryWorkspace !== '' && entryWorkspace !== workspace) continue
    const prefix = trimString(entry.titlePrefix)
    if (prefix !== '') {
      if (title === '') continue
      if (!title.toLowerCase().startsWith(prefix.toLowerCase())) continue
    }
    const score = (prefix !== '' ? prefix.length * 2 : 0) + (entryWorkspace !== '' ? 1 : 0)
    if (score > bestScore || (score === bestScore && timeOf(entry) > timeOf(best))) {
      best = entry
      bestScore = score
    }
  }
  return best
}

/** Правило одного предка: ближайший родитель вверх по цепочке, у которого есть правило. */
export function inheritedRule({ rules, sessionId, groups } = {}) {
  const id = normalizeRuleId(sessionId)
  if (id === '') return undefined
  let current = id
  const seen = new Set([current])
  for (let depth = 0; depth < 64; depth++) {
    const rawParent = groups?.parentById?.get(current)
    const parent = normalizeRuleId(rawParent)
    if (parent === '' || seen.has(parent)) return undefined
    seen.add(parent)
    const entry = rules?.sessions?.[parent]
    if (entry !== undefined && entry !== null && typeof entry === 'object') {
      return { entry, from: parent, depth: depth + 1 }
    }
    current = parent
  }
  return undefined
}

/**
 * Правило сессии для движка синхронизации.
 *
 * Порядок: правило сессии → унаследованное правило родителя → `matches` →
 * умолчание (ничего не защищено, это сохраняет прежнее поведение без файла).
 *
 * @param rules прочитанные правила (readSessionRules)
 * @param session объект сессии ({id, title?, workspaceId?}) или её id
 * @param groups {parentById, childrenByParent} для наследования
 * @param workspaceId рабочее пространство проекта (если в сессии не задано)
 * @param deviceId это устройство: по нему считается `ownerBlocked`
 * @param bytes размер лога: сразу считается `overLimit`/`mb`
 * @returns правило с полями summary для UI:
 *   { sessionId, preset, protect, maxMb, forbidFork, notifyForeignAppend,
 *     ownerDevice, syncMode, autoLocal, ruleSource, inheritedFrom,
 *     inheritedDepth, updatedAt, ownerBlocked, overLimit?, mb?, limitMb?,
 *     message?, suggestion? }
 */
export function resolveRulesForSession({ rules, session, groups, workspaceId, deviceId, bytes } = {}) {
  const store = rules ?? emptyRules()
  const id = normalizeRuleId(typeof session === 'string' ? session : session?.id)
  let entry = store.sessions?.[id]
  let ruleSource = 'session'
  let inheritedFrom
  let inheritedDepth
  if (entry === undefined) {
    const inherited = inheritedRule({ rules: store, sessionId: id, groups })
    if (inherited !== undefined) {
      entry = inherited.entry
      ruleSource = 'parent'
      inheritedFrom = inherited.from
      inheritedDepth = inherited.depth
    }
  }
  if (entry === undefined) {
    const matched = findMatchRule(store, { session, workspaceId })
    if (matched !== undefined) {
      entry = matched
      ruleSource = 'match'
    }
  }
  const explicit = entry !== undefined && entry !== null && typeof entry === 'object' ? entry : undefined
  if (explicit === undefined) ruleSource = 'default'
  const presetName = trimString(explicit?.preset)
  const presetFields = presetName !== '' ? resolvePreset(store, presetName) : {}
  const merged = { ...presetFields, ...(explicit ?? {}) }
  const ownerDevice = trimString(merged.ownerDevice)
  const device = trimString(deviceId)
  const rule = {
    sessionId: id,
    preset: presetName !== '' ? presetName : undefined,
    protect: merged.protect === true,
    maxMb: Number.isFinite(merged.maxMb) && merged.maxMb > 0 ? merged.maxMb : undefined,
    forbidFork: merged.forbidFork === true,
    notifyForeignAppend: merged.notifyForeignAppend === true,
    ownerDevice: ownerDevice !== '' ? ownerDevice : undefined,
    syncMode: merged.syncMode === 'local' || merged.syncMode === 'cloud' ? merged.syncMode : undefined,
    autoLocal: merged.autoLocal === true,
    ruleSource,
    inheritedFrom,
    inheritedDepth,
    updatedAt: trimString(merged.updatedAt),
    ownerBlocked: ownerDevice !== '' && device !== '' && ownerDevice !== device,
  }
  if (bytes !== undefined) Object.assign(rule, overLimitOf(rule, bytes))
  return rule
}

/**
 * Правила для набора сессий: Map<нормализованный id, правило>.
 * Один вызов на проект — дешевле, чем разбирать файл на каждую сессию.
 */
export function resolveRulesForSessions({ rules, sessions, groups, workspaceId, deviceId } = {}) {
  const result = new Map()
  const store = rules ?? emptyRules()
  const list = Array.isArray(sessions) ? sessions : []
  for (const session of list) {
    const id = normalizeRuleId(session?.id)
    if (id === '') continue
    result.set(id, resolveRulesForSession({
      rules: store,
      session,
      groups,
      workspaceId,
      deviceId,
      bytes: Number.isFinite(session?.size) ? session.size : undefined,
    }))
  }
  return result
}

// --- размер лога и поля отчёта ------------------------------------------------

/** Мегабайты для поля отчёта: крупные — до десятых, мелкие — до тысячных. */
function roundMb(value) {
  if (!Number.isFinite(value)) return 0
  return value >= 1 ? round1(value) : Math.round(value * 1000) / 1000
}

/**
 * Перерос ли лог лимит правила. Возвращает данные для строки плана/отчёта:
 * «сессия выросла до X МБ, лимит Y» + предложение перевести в локальные.
 * Автоматического переключения здесь нет: только поле `suggestion`.
 */
export function overLimitOf(rule, bytes) {
  const rawLimit = rule?.maxMb
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined
  const size = Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined
  const rawMb = size === undefined ? 0 : size / MB
  if (limit === undefined || size === undefined) {
    return { overLimit: false, maxMb: limit, limitMb: limit, bytes: size, mb: roundMb(rawMb) }
  }
  const overLimit = size > limit * MB
  return {
    overLimit,
    maxMb: limit,
    limitMb: limit,
    bytes: size,
    mb: roundMb(rawMb),
    message: overLimit ? `сессия выросла до ${formatMb(rawMb)} МБ, лимит ${formatMb(limit)}` : undefined,
    suggestion: overLimit ? LIMIT_RULE_HINT : undefined,
  }
}

/**
 * Поля правила для summary/UI: `protected`, `ownerBlocked`, `overLimit`,
 * `ruleSource` — ровно те, что читает панель, плюс подробности для подсказки.
 */
export function ruleFields(rule, { bytes, deviceId } = {}) {
  const resolved = rule ?? {}
  const limit = overLimitOf(resolved, bytes)
  const device = trimString(deviceId)
  const ownerBlocked = resolved.ownerBlocked === true
    || (trimString(resolved.ownerDevice) !== '' && device !== '' && trimString(resolved.ownerDevice) !== device)
  return {
    id: resolved.sessionId ?? '',
    preset: resolved.preset,
    protected: resolved.protect === true,
    ownerBlocked,
    overLimit: limit.overLimit,
    ruleSource: resolved.ruleSource ?? 'default',
    ownerDevice: resolved.ownerDevice,
    maxMb: resolved.maxMb,
    limitMb: limit.limitMb,
    syncMode: resolved.syncMode,
    forbidFork: resolved.forbidFork === true,
    notifyForeignAppend: resolved.notifyForeignAppend === true,
    inheritedFrom: resolved.inheritedFrom,
    bytes: limit.bytes,
    mb: limit.mb,
    // Код причины удержания для журнала/панели: правило владельца — rule-owner.
    reason: ownerBlocked ? 'rule-owner' : undefined,
    message: limit.message ?? (ownerBlocked || resolved.ownerBlocked === true ? OWNER_RULE_MESSAGE : undefined),
    suggestion: limit.suggestion,
  }
}

/** Сводка хранилища для панели/диагностики. */
export function rulesCounts(rules) {
  const store = rules ?? emptyRules()
  return {
    version: store.version,
    updatedAt: store.updatedAt,
    sessions: Object.keys(store.sessions ?? {}).length,
    matches: Array.isArray(store.matches) ? store.matches.length : 0,
    presets: Object.keys(store.presets ?? {}).length,
  }
}

// --- создание и правка правила ------------------------------------------------

/** Собрать запись правила: поля пресета, затем явные поля; время — `now`. */
export function buildRuleEntry({ rules, preset, patch = {}, now } = {}) {
  const name = trimString(preset ?? patch?.preset)
  const base = name !== '' ? resolvePreset(rules, name) : {}
  const entry = normalizeRuleFields({
    ...base,
    ...(patch !== null && typeof patch === 'object' ? patch : {}),
    preset: name !== '' ? name : undefined,
    updatedAt: isoTime(now),
  })
  return entry
}

/**
 * Создать/обновить правило сессии. Пресет раскладывается в поля сразу, поэтому
 * запись читается одинаково и этим, и старым кодом.
 *
 * Субагенту правило задавать можно, но это предупреждение: он и так наследует
 * правило родителя, а собственное правило сильнее (менять поведение — осознанно).
 *
 * @returns {{ rules, entry, previous, warning? }}
 */
export async function setSessionRule({ home, rules, id, sessionId, preset, patch = {}, groups, now, persist = true } = {}) {
  const key = normalizeRuleId(sessionId ?? id)
  if (key === '') throw new Error('не задан идентификатор сессии для правила')
  const store = rules ?? (typeof home === 'string' && home !== '' ? await readSessionRules(home) : emptyRules())
  const entry = buildRuleEntry({ rules: store, preset, patch, now })
  // Пресет не указан явно — сохраняем прежнее имя, чтобы UI не терял ярлык.
  if (entry.preset === undefined) {
    const previousPreset = trimString(store.sessions?.[key]?.preset)
    if (previousPreset !== '') entry.preset = previousPreset
  }
  const previous = store.sessions?.[key]
  store.sessions ??= {}
  store.sessions[key] = entry
  store.updatedAt = entry.updatedAt
  let warning
  if (groups?.parentById?.has(key)) {
    warning = 'правило задано субагенту: он и так наследует правило родителя, но собственное правило сильнее'
  }
  if (typeof home === 'string' && home !== '' && persist !== false) await writeSessionRules(home, store)
  return { rules: store, entry, previous, warning }
}

/** Снять правило сессии (наследование родителя снова начнёт действовать). */
export async function clearSessionRule({ home, rules, id, sessionId, now, persist = true } = {}) {
  const key = normalizeRuleId(sessionId ?? id)
  if (key === '') throw new Error('не задан идентификатор сессии для правила')
  const store = rules ?? (typeof home === 'string' && home !== '' ? await readSessionRules(home) : emptyRules())
  const previous = store.sessions?.[key]
  if (previous !== undefined) {
    delete store.sessions[key]
    store.updatedAt = isoTime(now)
    if (typeof home === 'string' && home !== '' && persist !== false) await writeSessionRules(home, store)
  }
  return { rules: store, previous, removed: previous !== undefined }
}

// --- слияние (второе устройство, профиль) ------------------------------------

/** Ключ записи `matches`: рабочее пространство + префикс названия. */
function matchKey(entry) {
  return `${trimString(entry?.workspaceId)}\u0000${trimString(entry?.titlePrefix)}`
}

/** Слить пару записей по `updatedAt`; вернуть победителя и запись конфликта. */
function mergePair({ kind, id, localEntry, incomingEntry, localTime, incomingTime }) {
  if (localEntry === undefined) return { entry: incomingEntry, changed: true }
  if (incomingEntry === undefined) return { entry: localEntry, changed: false }
  if (JSON.stringify(localEntry) === JSON.stringify(incomingEntry)) return { entry: localEntry, changed: false }
  let winner
  if (incomingTime > localTime) winner = 'incoming'
  else if (localTime > incomingTime) winner = 'local'
  // Равное время при разных данных: детерминированно оставляем локальную
  // запись, но конфликт записываем — иначе расхождение осталось бы незаметным.
  else winner = 'local'
  const conflict = {
    kind,
    id,
    winner,
    reason: winner === 'local' && localTime === incomingTime ? 'equal-updatedAt' : 'updatedAt',
    localUpdatedAt: trimString(localEntry?.updatedAt),
    incomingUpdatedAt: trimString(incomingEntry?.updatedAt),
    local: localEntry,
    incoming: incomingEntry,
  }
  const entry = winner === 'incoming' ? incomingEntry : localEntry
  return { entry, changed: winner === 'incoming', conflict }
}

/**
 * Слить локальные и пришедшие правила. По каждой записи побеждает более свежая
 * (`updatedAt`), пресеты — по времени хранилища. Возвращает также список
 * конфликтов: их пишут в журнал (`recordRuleConflicts`) и, при возможности, в
 * `profile/conflicts.json` зеркала.
 *
 * @returns {{ rules, conflicts, changed }}
 */
export function mergeSessionRules(localRules, incomingRules, { now } = {}) {
  const local = normalizeRules(localRules)
  const incoming = normalizeRules(incomingRules)
  const conflicts = []
  let changed = false

  for (const [id, entry] of Object.entries(incoming.sessions)) {
    const merged = mergePair({
      kind: 'session-rule',
      id,
      localEntry: local.sessions[id],
      incomingEntry: entry,
      localTime: timeOf(local.sessions[id]),
      incomingTime: timeOf(entry),
    })
    if (merged.changed) {
      local.sessions[id] = merged.entry
      changed = true
    }
    if (merged.conflict !== undefined) conflicts.push(merged.conflict)
  }

  // Пресеты: поля сливаются по ключу, при расхождении решает свежесть хранилища.
  const localStoreTime = timeOf(local)
  const incomingStoreTime = timeOf(incoming)
  for (const [name, fields] of Object.entries(incoming.presets)) {
    const current = local.presets[name]
    if (current === undefined) {
      local.presets[name] = fields
      changed = true
      continue
    }
    const merged = mergePair({
      kind: 'preset',
      id: name,
      localEntry: current,
      incomingEntry: fields,
      localTime: localStoreTime,
      incomingTime: incomingStoreTime,
    })
    if (merged.changed) {
      local.presets[name] = merged.entry
      changed = true
    }
    if (merged.conflict !== undefined) conflicts.push(merged.conflict)
  }

  // matches: ключ — workspace+titlePrefix.
  const localMatches = new Map(local.matches.map(entry => [matchKey(entry), entry]))
  for (const entry of incoming.matches) {
    const key = matchKey(entry)
    const current = localMatches.get(key)
    const merged = mergePair({
      kind: 'match',
      id: key.replace('\u0000', '/'),
      localEntry: current,
      incomingEntry: entry,
      localTime: timeOf(current),
      incomingTime: timeOf(entry),
    })
    if (merged.changed) {
      localMatches.set(key, merged.entry)
      changed = true
    }
    if (merged.conflict !== undefined) conflicts.push(merged.conflict)
  }
  if (changed) local.matches = [...localMatches.values()]

  const newest = Math.max(localStoreTime, incomingStoreTime, 0)
  if (newest > 0) local.updatedAt = isoTime(newest)
  else if (changed) local.updatedAt = isoTime(now)
  else if (local.updatedAt === '' && incoming.updatedAt !== '') local.updatedAt = incoming.updatedAt

  return { rules: local, conflicts, changed }
}

/**
 * Дописать конфликты слияния в `~/.dsh/dsh-sync/rules-history.jsonl`.
 * Тело конфликта (local/incoming) в журнал не копируется — только id, время и
 * победитель: журнал читается в диагностике и не должен расти бесконтрольно.
 */
export async function recordRuleConflicts(home, conflicts, { now } = {}) {
  const list = Array.isArray(conflicts) ? conflicts.filter(item => item !== null && typeof item === 'object') : []
  if (list.length === 0 || typeof home !== 'string' || home === '') return { written: 0, path: '' }
  const path = rulesHistoryPath(home)
  const at = isoTime(now)
  const lines = list.map(conflict => JSON.stringify({
    at,
    type: 'session-rules',
    kind: conflict.kind ?? 'session-rule',
    id: conflict.id ?? '',
    winner: conflict.winner ?? 'local',
    reason: conflict.reason ?? 'updatedAt',
    localUpdatedAt: conflict.localUpdatedAt ?? '',
    incomingUpdatedAt: conflict.incomingUpdatedAt ?? '',
  }))
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8')
  return { written: lines.length, path }
}

/** Прочитать последние конфликты слияния правил (для диагностики/тестов). */
export async function readRulesHistory(home, limit = RULES_HISTORY_LIMIT) {
  if (typeof home !== 'string' || home === '') return []
  const path = rulesHistoryPath(home)
  if (!existsSync(path)) return []
  try {
    const text = await readFile(path, 'utf8')
    const entries = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') entries.push(parsed)
      } catch {
        // битая строка журнала не мешает читать остальные
      }
    }
    const max = Number.isFinite(limit) && limit > 0 ? limit : RULES_HISTORY_LIMIT
    return entries.slice(-max)
  } catch {
    return []
  }
}

/**
 * Принять правила из зеркала профиля: прочитать копию, слить с локальными,
 * сохранить результат и записать конфликты. Это «второе устройство видит
 * правила»: после push на A файл `profile/session-rules.json` приезжает в
 * зеркало, а pull на B вливает его в локальное хранилище.
 *
 * @returns {{ rules, conflicts, merged:boolean, applied:boolean, present:boolean }}
 */
export async function mergeRulesFromProfile({ home, repoDir, now } = {}) {
  const local = await readSessionRules(home)
  const incoming = await readRulesProfile({ repoDir })
  if (incoming === undefined) {
    return { rules: local, conflicts: [], merged: false, applied: false, present: false }
  }
  const merged = mergeSessionRules(local, incoming, { now })
  if (merged.conflicts.length > 0) await recordRuleConflicts(home, merged.conflicts, { now })
  if (!merged.changed) return { rules: local, conflicts: merged.conflicts, merged: false, applied: false, present: true }
  const saved = await writeSessionRules(home, merged.rules)
  return { rules: saved, conflicts: merged.conflicts, merged: true, applied: true, present: true }
}
