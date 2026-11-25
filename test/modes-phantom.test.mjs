import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyLocalOnlyModes, existingSessionIds, pruneSessionModes, publishLocalOnly, readSessionModes } from '../lib/session-modes.mjs'
import { makeSessionLocal } from '../lib/cloud-copy.mjs'
import { writeFile } from 'node:fs/promises'

test('домашний снимок объявлений сильнее устаревшего зеркала (фантомы не воскресают)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-localonly-auth-'))
  try {
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    const repoDir = join(home, 'dsh-sync', 'repo')
    await mkdir(repoDir, { recursive: true })
    const now = new Date().toISOString()
    await writeFile(join(home, 'dsh-sync', 'local-only.json'), JSON.stringify({ version: 1, updatedAt: now, sessions: { 'session-real': { declaredBy: 'd', at: now, reason: 'owner' } } }))
    await writeFile(join(repoDir, 'local-only.json'), JSON.stringify({ version: 1, updatedAt: '2026-11-01T00:00:00.000Z', sessions: { 'session-real': { declaredBy: 'd', at: '2026-11-01T00:00:00.000Z', reason: 'owner' }, 'session-phantom': { declaredBy: 'd', at: '2026-11-01T00:00:00.000Z', reason: 'owner' } } }))
    const result = await publishLocalOnly({ home, repoDir })
    assert.deepEqual(Object.keys(result.data.sessions), ['session-real'], 'фантом из старого зеркала снят')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('pruneSessionModes убирает режимы несуществующих сессий', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-modes-prune-'))
  try {
    await mkdir(join(home, 'sessions', '--project--', 'session-real'), { recursive: true })
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', 'session-modes.json'), JSON.stringify({ version: 2, sessions: { 'session-real': 'local', 'session-ghost': 'local' }, workspaces: {} }))
    const result = await pruneSessionModes(home)
    assert.deepEqual(result.removed, ['session-ghost'])
    const modes = await readSessionModes(home)
    assert.equal(modes.sessions['session-ghost'], undefined)
    assert.equal(modes.sessions['session-real'], 'local')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('makeSessionLocal не создаёт объявление для несуществующей сессии', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-phantom-declare-'))
  try {
    const result = await makeSessionLocal({
      home,
      config: { repoDir: '', deviceId: 'device-test', projects: {} },
      sessionId: 'session-server01-missing-000000000000',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'session/not-found')
    const modes = await readSessionModes(home)
    assert.equal(modes.sessions['session-server01-missing-000000000000'], undefined, 'режим не создан')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('фантомные объявления не создают режимы у несуществующих сессий', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-phantom-modes-'))
  try {
    await mkdir(join(home, 'sessions', '--project--', 'session-real'), { recursive: true })
    const existing = await existingSessionIds(home)
    assert.equal(existing.has('session-real'), true)
    assert.equal(existing.has('session-phantom'), false)
    const result = await applyLocalOnlyModes(home, ['session-real', 'session-phantom'], { onlyExisting: true })
    assert.deepEqual(result.changed, ['session-real'])
    const modes = await readSessionModes(home)
    assert.equal(modes.sessions['session-real'], 'local')
    assert.equal(modes.sessions['session-phantom'], undefined, 'фантом не попал в режимы')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('без onlyExisting поведение прежнее (совместимость)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-phantom-compat-'))
  try {
    const result = await applyLocalOnlyModes(home, ['session-x'], {})
    assert.deepEqual(result.changed, ['session-x'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
