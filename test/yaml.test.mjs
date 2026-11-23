/**
 * Минимальный YAML профильного слоя: разбор, сохранение `!!js`, цитаты,
 * блочные скаляры и разбиение patch-файла на блоки без потери чужих строк.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseYaml,
  parseBlockEntry,
  parseScalar,
  serializeBlockEntry,
  splitTopLevelBlocks,
  stringifyYaml,
  YamlError,
} from '../lib/yaml.mjs'

test('разбор словарей, списков и скаляров', () => {
  const doc = parseYaml(`# комментарий
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
    fontSize: 16
    enabled: true
    empty: null
    ratio: 1.5
- id: mcp-manager
  config:
    servers:
      local:
        command: cmd
        args:
          - /c
          - --flag
`)
  assert.equal(Array.isArray(doc), true)
  assert.equal(doc.length, 2)
  assert.equal(doc[0].id, 'ui-theme')
  assert.equal(doc[0].config.preference, 'dark')
  assert.equal(doc[0].config.fontSize, 16)
  assert.equal(doc[0].config.enabled, true)
  assert.equal(doc[0].config.empty, null)
  assert.equal(doc[0].config.ratio, 1.5)
  assert.deepEqual(doc[1].config.servers.local.args, ['/c', '--flag'])
})

test('кавычки, двоеточия и решётки в строках', () => {
  assert.equal(parseScalar('"a: b"'), 'a: b')
  assert.equal(parseScalar("'it''s'"), "it's")
  assert.equal(parseScalar('plain text # не комментарий'), 'plain text # не комментарий')
  const doc = parseYaml('- value: "http://127.0.0.1:9222"\n')
  assert.equal(doc[0].value, 'http://127.0.0.1:9222')
})

test('!!js сохраняется как маркер, а не как строка', () => {
  const doc = parseYaml('- id: x\n  config:\n    value: !!js dshHomePath("sessions")\n')
  assert.deepEqual(doc[0].config.value, { js: 'dshHomePath("sessions")' })
  const text = serializeBlockEntry({ id: 'x', config: { value: { js: 'dshHomePath("sessions")' } } })
  assert.match(text, /value: !!js dshHomePath\("sessions"\)/)
})

test('блочные скаляры | и >', () => {
  const doc = parseYaml('- id: note\n  config:\n    text: |\n      строка один\n      строка два\n    folded: >\n      a\n      b\n')
  assert.equal(doc[0].config.text, 'строка один\nстрока два\n')
  assert.equal(doc[0].config.folded, 'a b\n')
})

test('сериализация и обратный разбор', () => {
  const value = {
    id: 'ui-theme',
    name: '@deepseek-ai/dsh-client-ui-theme',
    config: {
      preference: 'dark',
      fontSize: 16,
      path: '${DSH_HOME}/browser-secrets.env',
      empty: '',
      list: ['a', 'b'],
    },
  }
  const text = `${stringifyYaml([value])}`
  const parsed = parseYaml(text)
  assert.deepEqual(parsed[0], value)
})

test('splitTopLevelBlocks: шапка, записи и отсутствие правок чужих строк', () => {
  const text = `# шапка
# ещё комментарий
- insert:
    - id: third
      name: third
- id: ui-theme
  config:
    preference: dark

# хвостовой комментарий
`
  const parts = splitTopLevelBlocks(text)
  assert.equal(parts.blocks.length, 2)
  assert.match(parts.header, /# шапка/)
  const first = parseBlockEntry(parts.blocks[0])
  assert.equal(first.insert[0].id, 'third')
  const second = parseBlockEntry(parts.blocks[1])
  assert.equal(second.config.preference, 'dark')
})

test('непонятный YAML — понятная ошибка, а не молчаливая порча', () => {
  assert.throws(() => parseYaml('ключ: значение\n  - неверный отступ\n'), YamlError)
  assert.throws(() => parseYaml('- a\nне список\n'), YamlError)
})
