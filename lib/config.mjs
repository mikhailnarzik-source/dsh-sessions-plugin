/**
 * dsh-sync — переносимый между устройствами формат сессий.
 *
 * В зеркале каждая сессия лежит с нейтральным абсолютным путём
 * `/dsh-sync/projects/<projectId>`: он считается абсолютным и на Windows
 * (win32.isAbsolute("/x") === true), и на POSIX. На устройстве путь
 * подставляется локальный — тем же приёмом, что и в session-remap.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

export const CONFIG_FILE = 'dsh-sync.json'

/**
 * Предохранители автоматического удаления сессий по меткам.
 *
 * Инцидент 25.11: после восстановления сессий из архива старое зеркало с
 * метками удаления при первом же pull удалило 18 живых сессий. Поэтому
 * автоудаление по метке ограничено: не больше `maxAutoRemove` независимых
 * удалений за проход, только метки не старше `maxTombstoneAgeDays` дней и
 * только при включённом `autoApply`. Всё, что не прошло предохранитель,
 * удаляется только подтверждённым действием «Применить удаления».
 */
export const DELETIONS_DEFAULTS = Object.freeze({
  autoApply: true,
  maxAutoRemove: 3,
  maxTombstoneAgeDays: 7,
})

/**
 * Нормализовать настройки автоудаления: старый конфиг без `deletions` получает
 * безопасные значения по умолчанию, а не «удалять всё».
 *
 * @param config настройки синхронизации (может быть без `deletions`).
 * @returns {{ autoApply: boolean, maxAutoRemove: number, maxTombstoneAgeDays: number }}
 */
export function deletionsConfig(config) {
  const raw = config?.deletions
  const source = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : {}
  const count = (value, fallback) => (Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback)
  return {
    // Выключено может быть только явным false: `undefined` в старом конфиге
    // означает «работать как раньше», а не «удалять без ограничений».
    autoApply: source.autoApply !== false,
    maxAutoRemove: count(source.maxAutoRemove, DELETIONS_DEFAULTS.maxAutoRemove),
    maxTombstoneAgeDays: count(source.maxTombstoneAgeDays, DELETIONS_DEFAULTS.maxTombstoneAgeDays),
  }
}

export function resolveDshHome(cliHome) {
  if (cliHome) return resolve(cliHome)
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

export function defaultConfig(home) {
  return {
    version: 1,
    deviceId: `device-${createHash('sha256').update(`${platform()}-${homedir()}-${Date.now()}`).digest('hex').slice(0, 12)}`,
    backend: 'git',
    repoDir: join(home, 'dsh-sync', 'repo'),
    remote: '',
    branch: 'main',
    attachments: false,
    // Вложения старше N дней не отправляются в облако и удаляются из зеркала.
    // 0 — хранить все. Локальные копии не трогаем.
    attachmentsRetentionDays: 30,
    useExternal: true,
    autoSync: {
      enabled: true,
      pullOnStart: true,
      pushOnChange: true,
      pushMinIntervalMinutes: 5,
      pullIntervalMinutes: 15,
    },
    // Удаления из зеркала: только отдельным подтверждённым действием
    // «Применить удаления» (маршрут /api/dsh-sync/prune). push и pull ничего не
    // удаляют; autoPrune оставлен в конфиге для совместимости и по умолчанию
    // выключен — автоматической очистки зеркала нет.
    sync: { autoPrune: false },
    // Автоудаление локальных копий по меткам другого устройства (pull и
    // «повторно применить метки»). Предохранители — см. DELETIONS_DEFAULTS:
    // при массовой пачке, старой метке или autoApply:false ничего не удаляется,
    // требуется подтверждение «Применить удаления».
    deletions: { ...DELETIONS_DEFAULTS },
    // Профильный слой: оформление, язык, включённые плагины и их настройки.
    // По умолчанию приём ручной: pull строит план, применяет кнопка «Применить».
    profile: { enabled: true, autoApply: false },
    // Привязка сессий к рабочим пространствам.
    workspace: { enabled: true },
    projects: {},
  }
}

export async function loadConfig(home) {
  const path = join(home, CONFIG_FILE)
  if (!existsSync(path)) {
    const config = defaultConfig(home)
    await saveConfig(home, config)
    return config
  }
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (config === null || typeof config !== 'object') throw new Error(`битый конфиг: ${path}`)
  config.projects ??= {}
  // Конфиг со старой версии не знает про предохранители автоудаления: подставляем
  // их в памяти, чтобы первая же синхронизация не удалила пачку «как раньше».
  config.deletions = deletionsConfig(config)
  return config
}

export async function saveConfig(home, config) {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

/** Идентификатор проекта: стабильный, безопасный для пути. */
export function normalizeProjectId(raw) {
  const id = String(raw).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (id === '' || id === '.' || id === '..') throw new Error(`недопустимый id проекта: ${raw}`)
  return id
}

/** Нейтральный абсолютный путь, одинаково валидный на Windows и POSIX. */
export function canonicalCwd(projectId) {
  return `/dsh-sync/projects/${projectId}`
}

export function newId() {
  return randomUUID()
}
