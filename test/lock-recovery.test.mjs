import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverIndexLock, INDEX_LOCK_WAIT_MS, INDEX_LOCK_STALE_MS } from '../lib/git.mjs'

async function repoWithLock(ageMs = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-git-lock-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  const lock = join(dir, '.git', 'index.lock')
  await writeFile(lock, '')
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs)
    await utimes(lock, at, at)
  }
  return { dir, lock }
}

test('брошенный index.lock старше минуты удаляется, commit повторяется', async () => {
  const { dir, lock } = await repoWithLock(INDEX_LOCK_STALE_MS + 30_000)
  const recovered = await recoverIndexLock(dir, "fatal: Unable to create '.../.git/index.lock': File exists.")
  assert.equal(recovered, true)
  await assert.rejects(stat(lock), 'лок удалён')
  await rm(dir, { recursive: true, force: true })
})

test('свежий index.lock не удаляется, ожидание ограничено', async () => {
  const { dir, lock } = await repoWithLock(0)
  const started = Date.now()
  const recovered = await recoverIndexLock(dir, 'fatal: Unable to create index.lock: File exists.', { waitMs: 300 })
  assert.equal(recovered, false)
  assert.ok(Date.now() - started >= 250, 'ждали активный лок')
  assert.ok((await stat(lock)).size === 0, 'активный лок на месте')
  await rm(dir, { recursive: true, force: true })
})

test('свежий лок снимается, когда процесс его отпустил', async () => {
  const { dir, lock } = await repoWithLock(0)
  setTimeout(() => { void rm(lock, { force: true }) }, 200)
  const recovered = await recoverIndexLock(dir, 'fatal: Unable to create index.lock: File exists.', { waitMs: 2_000 })
  assert.equal(recovered, true)
  await rm(dir, { recursive: true, force: true })
})

test('другие ошибки git не трогаем', async () => {
  const { dir, lock } = await repoWithLock(INDEX_LOCK_STALE_MS + 30_000)
  const recovered = await recoverIndexLock(dir, 'fatal: not a git repository')
  assert.equal(recovered, false)
  assert.ok((await stat(lock)).size === 0, 'чужой лок не тронут')
  await rm(dir, { recursive: true, force: true })
})

test('константы ожидания осмысленны', () => {
  assert.ok(INDEX_LOCK_WAIT_MS >= 1_000 && INDEX_LOCK_WAIT_MS <= 15_000)
  assert.ok(INDEX_LOCK_STALE_MS >= 30_000)
})
