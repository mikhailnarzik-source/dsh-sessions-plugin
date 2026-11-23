/**
 * Минимальный YAML для профильного слоя.
 *
 * Полноценный YAML-парсер здесь не нужен и опасен: в `cordis.patch.yml` лежат
 * пользовательские строки, комментарии и выражения `!!js`, которые нельзя
 * молча переписывать. Модуль умеет ровно то, что нужно профильной
 * синхронизации:
 *
 *  - разобрать документ-массив patch-записей (вложенные словари и списки,
 *    кавычки, комментарии, блочные скаляры `|`/`>`, маркер `!!js`);
 *  - разбить текст на верхнеуровневые блоки `- ...`, чтобы менять только
 *    адресованные записи, а остальные строки сохранять байт-в-байт;
 *  - сериализовать одну запись обратно в YAML.
 *
 * Всё непонятное — исключение `YamlError`: вызывающая сторона пропускает
 * такой файл и пишет предупреждение, а не портит его.
 */

export class YamlError extends Error {
  constructor(message) {
    super(message)
    this.name = 'YamlError'
  }
}

/** Убрать комментарий из строки, не трогая `#` внутри кавычек. */
function stripComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote !== '') {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

/** Разобрать простой скаляр: кавычки, числа, булевы, null. */
export function parseScalar(raw) {
  const text = raw.trim()
  if (text === '') return null
  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null
  if (/^(?:true|True|TRUE)$/.test(text)) return true
  if (/^(?:false|False|FALSE)$/.test(text)) return false
  if (/^!!js(?:\s|$)/.test(text)) return { js: text.replace(/^!!js\s*/, '') }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('[') && text.endsWith(']')) return parseFlowSequence(text)
  if (text.startsWith('{') && text.endsWith('}')) return parseFlowMap(text)
  return text
}

/** Разделить содержимое flow-коллекции по запятым верхнего уровня. */
function splitFlow(inner) {
  const parts = []
  let current = ''
  let quote = ''
  let depth = 0
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]
    if (quote !== '') {
      current += char
      if (char === '\\' && quote === '"') {
        current += inner[index + 1] ?? ''
        index += 1
      } else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === '[' || char === '{') {
      depth += 1
      current += char
    } else if (char === ']' || char === '}') {
      depth -= 1
      current += char
    } else if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

function parseFlowSequence(text) {
  const inner = text.slice(1, -1).trim()
  if (inner === '') return []
  return splitFlow(inner).map(item => parseScalar(item))
}

function parseFlowMap(text) {
  const inner = text.slice(1, -1).trim()
  if (inner === '') return {}
  const result = {}
  for (const part of splitFlow(inner)) {
    const index = part.indexOf(':')
    if (index < 0) throw new YamlError(`не разобрана flow-запись: ${part}`)
    const key = parseScalar(part.slice(0, index))
    result[String(key)] = parseScalar(part.slice(index + 1))
  }
  return result
}

/** Значение после `key:` или `-`. */
function valueAfter(text) {
  return text.replace(/^[:,]?\s*/, '')
}

/** Строки с отступами; пустые и комментарии выкидываются. */
function significantLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  return lines.map((line, index) => {
    const withoutComment = stripComment(line)
    const trimmed = withoutComment.trimEnd()
    const indent = trimmed.length - trimmed.replace(/^\s+/, '').length
    return { index, raw: line, text: trimmed.slice(indent), indent, blank: trimmed.trim() === '' }
  })
}

function isSequenceLine(line) {
  return line !== undefined && (line.text === '-' || line.text.startsWith('- '))
}

/** Разделить `key: value` на ключ и остаток. */
function splitKey(text) {
  let quote = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote !== '') {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':' && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      return [text.slice(0, index).trim(), text.slice(index + 1).trim()]
    }
  }
  return undefined
}

/**
 * Разобрать блок (словарь или список) на строках с отступом `indent`.
 * @returns {{value: unknown, next: number}}
 */
function parseBlock(lines, start, indent) {
  const line = lines[start]
  if (line === undefined || line.blank) throw new YamlError('неожиданный конец YAML')
  if (isSequenceLine(line)) return parseSequence(lines, start, indent)
  return parseMapping(lines, start, indent)
}

function parseSequence(lines, start, indent) {
  const result = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.blank) {
      index += 1
      continue
    }
    if (line.indent !== indent || !isSequenceLine(line)) break
    const content = line.text === '-' ? '' : line.text.slice(2)
    if (content.trim() === '') {
      index += 1
      const next = nextContent(lines, index)
      if (next === undefined || lines[next].indent <= indent) {
        result.push(null)
        index = next ?? lines.length
        continue
      }
      const parsed = parseBlock(lines, next, lines[next].indent)
      result.push(parsed.value)
      index = parsed.next
      continue
    }
    const pair = splitKey(content)
    if (pair !== undefined && !looksLikeScalarWithColon(content)) {
      const map = {}
      const first = parsePairValue(pair[1], lines, index + 1, indent + 2)
      map[String(parseScalar(pair[0]))] = first.value
      index = first.next
      const rest = parseMappingContinuation(lines, index, indent + 2, map)
      result.push(map)
      index = rest
      continue
    }
    result.push(parseScalar(content))
    index += 1
  }
  return { value: result, next: index }
}

/** Строка вида `- https://x` не должна считаться парой ключ-значение. */
function looksLikeScalarWithColon(content) {
  const pair = splitKey(content)
  if (pair === undefined) return false
  // URL в списке: `https://...` — двоеточие без пробела после, splitKey уже это
  // отсекает. Осталось отсечь случаи вида `text: more`, где ключ невероятен.
  return /[\\/]/.test(pair[0]) || pair[0].startsWith('-')
}

function nextContent(lines, index) {
  let current = index
  while (current < lines.length && lines[current].blank) current += 1
  return current < lines.length ? current : undefined
}

/** Разобрать значение пары; при пустом значении — вложенный блок. */
function parsePairValue(rest, lines, nextIndex, childIndent) {
  const value = rest.trim()
  if (value.startsWith('|') || value.startsWith('>')) {
    return parseBlockScalar(value, lines, nextIndex)
  }
  if (value !== '') return { value: parseScalar(value), next: nextIndex }
  const next = nextContent(lines, nextIndex)
  if (next === undefined) return { value: null, next: nextIndex }
  const child = lines[next]
  // Список может стоять на том же отступе, что и ключ: `key:\n- item`.
  if (child.indent < childIndent) return { value: null, next: nextIndex }
  if (child.indent === childIndent - 2 && isSequenceLine(child)) {
    const parsed = parseSequence(lines, next, child.indent)
    return { value: parsed.value, next: parsed.next }
  }
  const parsed = parseBlock(lines, next, child.indent)
  return { value: parsed.value, next: parsed.next }
}

function parseBlockScalar(marker, lines, nextIndex) {
  const style = marker.startsWith('>') ? 'folded' : 'literal'
  const strip = marker.includes('-')
  const collected = []
  let index = nextIndex
  let blockIndent
  while (index < lines.length) {
    const line = lines[index]
    if (line.blank) {
      collected.push('')
      index += 1
      continue
    }
    if (blockIndent === undefined) blockIndent = line.indent
    if (line.indent < blockIndent) break
    collected.push(line.raw.slice(blockIndent))
    index += 1
  }
  let text = style === 'folded' ? collected.filter(line => line !== '').join(' ') : collected.join('\n')
  if (!strip) text += '\n'
  return { value: text, next: index }
}

function parseMapping(lines, start, indent) {
  const result = {}
  const index = parseMappingContinuation(lines, start, indent, result)
  return { value: result, next: index }
}

function parseMappingContinuation(lines, start, indent, result) {
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.blank) {
      index += 1
      continue
    }
    if (line.indent !== indent || isSequenceLine(line)) break
    const pair = splitKey(line.text)
    if (pair === undefined) throw new YamlError(`не разобрана строка YAML: ${line.raw.trim()}`)
    const key = String(parseScalar(pair[0]))
    const parsed = parsePairValue(pair[1], lines, index + 1, indent + 2)
    result[key] = parsed.value
    index = parsed.next
  }
  return index
}

/** Разобрать YAML-документ целиком. */
export function parseYaml(text) {
  const lines = significantLines(text)
  const first = nextContent(lines, 0)
  if (first === undefined) return null
  const parsed = parseBlock(lines, first, lines[first].indent)
  const tail = nextContent(lines, parsed.next)
  if (tail !== undefined) throw new YamlError(`лишние строки после документа: ${lines[tail].raw.trim()}`)
  return parsed.value
}

/** Разбить patch-файл на шапку, верхнеуровневые блоки `- ...` и хвост. */
export function splitTopLevelBlocks(text) {
  const source = String(text).replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const header = []
  const blocks = []
  const tail = []
  let current
  for (const line of lines) {
    if (/^-\s/.test(line) || /^-$/.test(line)) {
      if (current !== undefined) blocks.push(current.join('\n'))
      current = [line]
      continue
    }
    if (current === undefined) {
      header.push(line)
      continue
    }
    if (/^[^\s#]/.test(line) && line.trim() !== '') {
      // Строка без отступа, не список и не комментарий — документ не patch-массив.
      throw new YamlError(`неожиданная строка верхнего уровня: ${line.trim()}`)
    }
    current.push(line)
  }
  if (current !== undefined) blocks.push(current.join('\n'))
  // Хвостовые пустые строки после последнего блока не должны раздувать блок.
  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1]
    const match = last.match(/\n+$/)
    if (match !== null) {
      tail.push(...match[0].split('\n').slice(1))
      blocks[blocks.length - 1] = last.slice(0, last.length - match[0].length + 1)
    }
  }
  return { header: header.join('\n'), blocks, tail: tail.join('\n') }
}

/** Текст блока как значение массива из одного элемента. */
export function parseBlockEntry(block) {
  const parsed = parseYaml(block)
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new YamlError('блок не является одной записью массива')
  }
  return parsed[0]
}

const SAFE_KEY = /^[A-Za-z0-9_.-]+$/

function quoteString(value) {
  const text = String(value)
  const needQuote = text === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) || /: |: $| #|\n|\t/.test(text) || /^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(text)
  if (!needQuote) return text
  return JSON.stringify(text)
}

function serializeKey(value) {
  const text = String(value)
  return SAFE_KEY.test(text) ? text : JSON.stringify(text)
}

function serializeScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return quoteString(value)
  if (typeof value === 'object' && value !== null && typeof value.js === 'string') return `!!js ${value.js}`
  throw new YamlError(`нельзя сериализовать значение: ${String(value)}`)
}

function serializeNode(value, indent, lines) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.js !== 'string') {
        const nested = []
        serializeNode(item, indent + 2, nested)
        const firstLine = nested.shift()
        lines.push(`${pad}- ${firstLine.trimStart()}`)
        lines.push(...nested)
      } else {
        lines.push(`${pad}- ${serializeScalar(item)}`)
      }
    }
    return lines
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const isCollection = item !== null && typeof item === 'object' && typeof item.js !== 'string'
      if (isCollection) {
        lines.push(`${pad}${serializeKey(key)}:`)
        serializeNode(item, indent + 2, lines)
      } else {
        lines.push(`${pad}${serializeKey(key)}: ${serializeScalar(item)}`)
      }
    }
    return lines
  }
  lines.push(`${pad}${serializeScalar(value)}`)
  return lines
}

/** Сериализовать одну patch-запись как элемент массива. */
export function serializeBlockEntry(entry) {
  const lines = []
  serializeNode([entry], 0, lines)
  return lines.join('\n')
}

/** Сериализовать произвольный документ (для тестов и каталогов). */
export function stringifyYaml(value) {
  const lines = []
  serializeNode(value, 0, lines)
  return `${lines.join('\n')}\n`
}
