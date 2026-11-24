import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pushAttachments, pruneMirrorAttachments, attachmentCutoff, DEFAULT_ATTACHMENTS_RETENTION_DAYS } from '../lib/attachments.mjs'

const OLD_HASH = 'a'.repeat(64)
const NEW_HASH = 'b'.repeat(64)

async function makeFixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attach-retention-'))
  const repoDir = join(home, 'repo')
  const objects = join(home, 'attachments', 'v1', 'objects', 'aa')
  await mkdir(objects, { recursive: true })
  const oldFile = join(objects, OLD_HASH)
  const newFile = join(objects, NEW_HASH)
  await writeFile(oldFile, 'old')
  await writeFile(newFile, 'new')
  const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  await utimes(oldFile, oldDate, oldDate)
  return { home, repoDir, oldFile, newFile }
}

test('порог вложений: 30 дней по умолчанию и 0 = отключено', () => {
  assert.equal(DEFAULT_ATTACHMENTS_RETENTION_DAYS, 30)
  assert.equal(attachmentCutoff(0), 0)
  assert.ok(attachmentCutoff(30) < Date.now())
})

test('pushAttachments не отправляет старые вложения и убирает их из зеркала', async () => {
  const { home, repoDir } = await makeFixture()
  try {
    const first = await pushAttachments({ home, repoDir })
    assert.equal(first.added, 1, 'новое вложение отправлено')
    assert.equal(first.skippedOld, 1, 'старое пропущено')
    const mirrorOld = join(repoDir, 'attachments', 'objects', 'aa', OLD_HASH)
    await assert.rejects(stat(mirrorOld), 'старого нет в зеркале')
    const mirrorNew = join(repoDir, 'attachments', 'objects', 'aa', NEW_HASH)
    assert.equal((await stat(mirrorNew)).size, 3, 'новое на месте')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('pruneMirrorAttachments удаляет старые копии и не трогает локальные', async () => {
  const { home, repoDir, oldFile } = await makeFixture()
  try {
    const mirrorOld = join(repoDir, 'attachments', 'objects', 'aa', OLD_HASH)
    await mkdir(join(repoDir, 'attachments', 'objects', 'aa'), { recursive: true })
    await writeFile(mirrorOld, 'old')
    const dry = await pruneMirrorAttachments({ home, repoDir, dryRun: true })
    assert.equal(dry.removed, 1, 'dry-run видит одно старое вложение')
    assert.equal((await stat(mirrorOld)).size, 3, 'dry-run ничего не удалил')
    const result = await pruneMirrorAttachments({ home, repoDir })
    assert.equal(result.removed, 1)
    await assert.rejects(stat(mirrorOld), 'старая копия в зеркале удалена')
    assert.equal((await stat(oldFile)).size, 3, 'локальный оригинал на месте')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('retentionDays=0 — хранить все вложения', async () => {
  const { home, repoDir } = await makeFixture()
  try {
    const result = await pushAttachments({ home, repoDir, retentionDays: 0 })
    assert.equal(result.added, 2, 'оба вложения отправлены')
    assert.equal(result.skippedOld, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
