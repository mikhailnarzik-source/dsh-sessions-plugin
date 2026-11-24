import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * DSH отвергает установку пакета, если package.json начинается с BOM:
 * «installation rejected: Unexpected token '﻿', "﻿{"... is not valid JSON».
 * Держим это отдельным тестом, чтобы BOM снова не просочился из PowerShell.
 */
test('package.json без BOM и валидный JSON', async () => {
  const bytes = await readFile(new URL('../package.json', import.meta.url))
  assert.notEqual(bytes[0], 0xef, 'первый байт не BOM (EF BB BF)')
  const text = bytes.toString('utf8')
  const manifest = JSON.parse(text)
  assert.equal(manifest.name, 'dsh-sessions')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
})
