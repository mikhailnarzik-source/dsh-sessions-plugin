import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { titleOfLog, titleOfLogBytes, resolveSessionTitle } from '../lib/titles.mjs'

function frame(events) {
  return zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n'))
}

function titleEvent(title) {
  return { type: 'session/title', seq: 1, data: { title } }
}

test('titleOfLogBytes берёт последнее событие session/title', () => {
  const bytes = frame([titleEvent('Первое сообщение'), titleEvent('Настоящее название')])
  assert.equal(titleOfLogBytes(bytes), 'Настоящее название')
})

test('titleOfLog находит позднее переименование в хвосте большого лога', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-title-tail-'))
  try {
    const path = join(dir, 'session.v4.jsonl.zstd')
    const big = Buffer.concat([
      frame([titleEvent('Черновик')]),
      frame([{ type: 'message', data: { text: 'x'.repeat(200_000) } }]),
      frame([titleEvent('Финальное название')]),
      frame([{ type: 'message', data: { text: 'y'.repeat(400_000) } }]),
    ])
    await writeFile(path, big)
    assert.equal(await titleOfLog(path), 'Финальное название')
    const resolved = await resolveSessionTitle({ id: 'session-test', title: 'Черновик', path })
    assert.equal(resolved.title, 'Финальное название')
    assert.equal(resolved.titleSource, 'log')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
