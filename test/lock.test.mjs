import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireLock, LOCK_HEARTBEAT_MS, LOCK_STALE_MS } from '../lib/lock.mjs'

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test('лок: занятый лок не берётся, после release берётся', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-lock-'))
  try {
    const first = await acquireLock(root, 'a')
    assert.ok(first, 'первый лок взят')
    assert.equal(await acquireLock(root, 'b'), undefined, 'второй не берётся, пока первый жив')
    await first.release()
    const second = await acquireLock(root, 'b')
    assert.ok(second, 'после release лок берётся')
    await second.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('лок: мёртвый pid снимается сразу', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-lock-'))
  try {
    const lockDir = join(root, 'sync.lock')
    await mkdir(lockDir, { recursive: true })
    await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: 999_999_999, at: Date.now(), owner: 'dead' })}\n`, 'utf8')
    const lock = await acquireLock(root, 'alive')
    assert.ok(lock, 'лок мёртвого процесса снят')
    await lock.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('лок: молчание дольше порога — лок снимается автоматически', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-lock-'))
  try {
    const first = await acquireLock(root, 'a', { staleMs: 120, heartbeatMs: 60_000 })
    assert.ok(first, 'первый лок взят')
    await pause(200)
    const second = await acquireLock(root, 'b', { staleMs:120, heartbeatMs: 60_000 })
    assert.ok(second, 'замолчавший лок снят по таймауту')
    await second.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('лок: heartbeat держит лок живым дольше порога', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-lock-'))
  try {
    const first = await acquireLock(root, 'a', { staleMs: 150, heartbeatMs: 25 })
    assert.ok(first, 'первый лок взят')
    await pause(400)
    assert.equal(await acquireLock(root, 'b', { staleMs: 150, heartbeatMs: 25 }), undefined, 'живой лок не отбирается')
    const info = JSON.parse(await readFile(join(root, 'sync.lock', 'owner.json'), 'utf8'))
    assert.ok(Date.now() - info.at < 150, 'heartbeat обновляет время владельца')
    await first.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('лок: значения по умолчанию — 5 минут молчания, heartbeat раз в минуту', () => {
  assert.equal(LOCK_STALE_MS, 5 * 60_000)
  assert.equal(LOCK_HEARTBEAT_MS, 60_000)
})
