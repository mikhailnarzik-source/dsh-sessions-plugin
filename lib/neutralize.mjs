/**
 * Нейтрализация машинных путей в переносимых данных.
 *
 * В зеркало нельзя класть локальные пути: на другом компьютере другой
 * пользователь, другой корень диска и другой каталог DSH. Поэтому при
 * отправке путь домашнего каталога заменяется токеном `${HOME}`, каталога DSH —
 * `${DSH_HOME}`, а при приёме токены превращаются обратно в локальные пути.
 *
 * Заменяется только целый сегмент: `C:\Users\Alice` не должен «поймать»
 * `C:\Users\Alice2`. Для этого после совпадения проверяется граница.
 */
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export const HOME_TOKEN = '${HOME}'
export const DSH_HOME_TOKEN = '${DSH_HOME}'

const WINDOWS = process.platform === 'win32'

/** Экранировать строку для regular expression. */
function escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Путь с прямыми слэшами и без хвостового разделителя. */
export function toPortablePath(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized === '' ? '/' : normalized
}

/** Путь с разделителями текущей платформы. */
export function toLocalPath(value) {
  if (typeof value !== 'string') return ''
  return WINDOWS ? value.replace(/\//g, '\\') : value.replace(/\\/g, '/')
}

function pathTail(path, root) {
  const portable = toPortablePath(path)
  const base = toPortablePath(root)
  if (portable === base) return ''
  if (!portable.startsWith(`${base}/`)) return undefined
  return portable.slice(base.length + 1)
}

/**
 * Создать преобразователь для конкретной машины.
 * @param {{home?: string, dshHome?: string}} options
 */
export function createNeutralizer(options = {}) {
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : homedir()
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? options.dshHome : ''

  /**
   * Заменить известные машинные корни на токены. Длинные пути проверяются
   * первыми: каталог DSH обычно вложен в домашний и должен получить свой токен.
   */
  function neutralizeText(value) {
    let text = String(value)
    const roots = [
      [dshHome, DSH_HOME_TOKEN],
      [home, HOME_TOKEN],
    ].filter(([root]) => typeof root === 'string' && root !== '')
    // На Windows один и тот же путь встречается с прямыми и обратными слэшами,
    // а иногда и с двойной косой чертой в JSON.
    for (const [root, token] of roots) {
      const forms = new Set([
        toLocalPath(root),
        toPortablePath(root),
      ])
      for (const form of forms) {
        if (form === '') continue
        const pattern = new RegExp(`${escape(form)}(?![A-Za-z0-9_])`, 'gi')
        text = text.replace(pattern, token)
      }
    }
    // Переменная окружения в тексте — это тот же машинный путь.
    text = text.replace(/%USERPROFILE%/gi, HOME_TOKEN)
    text = text.replace(/%APPDATA%/gi, '${APPDATA}')
    text = text.replace(/\$\{HOME\}/g, HOME_TOKEN)
    // Токен всегда с прямыми слэшами: зеркало читается на другой ОС.
    text = text.replace(/\$\{DSH_HOME\}\\/g, `${DSH_HOME_TOKEN}/`)
    text = text.replace(/\$\{HOME\}\\/g, `${HOME_TOKEN}/`)
    text = text.replace(/\$\{APPDATA\}\\/g, '${APPDATA}/')
    return text
  }

  /** Вернуть локальный путь по токену (только целый путь, без «где-то внутри»). */
  function localizePath(value) {
    const text = String(value)
    const table = [
      [DSH_HOME_TOKEN, dshHome],
      ['${APPDATA}', process.env.APPDATA ?? joinHome('AppData', 'Roaming')],
      [HOME_TOKEN, home],
    ]
    for (const [token, root] of table) {
      if (root === '' || root === undefined) continue
      if (text === token) return root
      if (text.startsWith(`${token}/`) || text.startsWith(`${token}\\`)) {
        const rest = text.slice(token.length + 1)
        return toLocalPath(`${toPortablePath(root)}/${rest}`)
      }
    }
    return toLocalPath(text)
  }

  function joinHome(...parts) {
    return win32.isAbsolute(home) ? win32.join(home, ...parts) : posix.join(home, ...parts)
  }

  /** Заменить токены обратно на локальные пути внутри произвольного текста. */
  function localizeText(value) {
    let text = String(value)
    if (dshHome !== '') {
      text = text.replace(/\$\{DSH_HOME\}(?![A-Za-z0-9_])/g, toLocalPath(dshHome))
    }
    text = text.replace(/\$\{HOME\}(?![A-Za-z0-9_])/g, toLocalPath(home))
    if (process.env.APPDATA) text = text.replace(/\$\{APPDATA\}/g, toLocalPath(process.env.APPDATA))
    return text
  }

  /** Привести путь к переносимому виду: токен для своих каталогов. */
  function neutralizePath(value) {
    return toPortablePath(neutralizeText(value))
  }

  return { neutralizeText, localizeText, neutralizePath, localizePath, home, dshHome }
}

/** Похоже ли значение на машинный абсолютный путь. */
export function looksLikeMachinePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (value.includes(HOME_TOKEN) || value.includes(DSH_HOME_TOKEN)) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (/^\\\\[^\\]+\\/.test(value)) return true
  if (/^%[A-Z_]+%/.test(value)) return true
  if (/^\/(?:Users|home|root)\//.test(value)) return true
  return false
}

/** Ключи, которые описывают эту машину или несут секреты и не должны уезжать в зеркало. */
const MACHINE_KEY = /^(?:deviceId|device|machineId|machine|hostname|host|localPath|path|repoDir|pid|port|home|dshHome|token|secret|password|passphrase|credential|credentials|apiKey|apikey|key|env|headers|authorization|auth|cookie|bearer)$/i

export function isMachineKey(key) {
  return MACHINE_KEY.test(String(key))
}

/**
 * Убрать машинные поля из произвольного JSON и нейтрализовать пути в
 * оставшихся строках. Используется для белого списка настроек плагинов.
 * @param {unknown} value
 * @param {{neutralizer: ReturnType<typeof createNeutralizer>, depth?: number}} options
 */
export function sanitizeValue(value, options, depth = 0) {
  const neutralizer = options?.neutralizer
  if (depth > 12) return undefined
  if (typeof value === 'string') {
    return neutralizer === undefined ? value : neutralizer.neutralizeText(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    const items = []
    for (const item of value.slice(0, 2000)) {
      const sanitized = sanitizeValue(item, options, depth + 1)
      if (sanitized !== undefined) items.push(sanitized)
    }
    return items
  }
  if (typeof value === 'object' && value !== null) {
    const result = {}
    for (const [key, item] of Object.entries(value).slice(0, 500)) {
      if (isMachineKey(key)) continue
      const sanitized = sanitizeValue(item, options, depth + 1)
      if (sanitized !== undefined) result[key] = sanitized
    }
    return result
  }
  return undefined
}
