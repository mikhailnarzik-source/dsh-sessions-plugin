import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeConflictCount, readProfileStatus } from '../lib/profile.mjs'

test('активные конфликты считаются без разрешённых', () => {
  assert.equal(activeConflictCount([]), 0)
  assert.equal(activeConflictCount([{ file: 'a' }, { file: 'b', resolution: 'локальная копия отправлена' }]), 1)
  assert.equal(activeConflictCount([{ file: 'a', resolution: 'ok' }, { file: 'b', resolution: 'ok' }]), 0)
  assert.equal(activeConflictCount([{ file: 'a', resolution: '' }]), 1)
})

test('readProfileStatus: разрешённый конфликт — история, а не активный', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-profile-status-'))
  try {
    await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'desktop', dependencies: {} }))
    const repoDir = join(home, 'dsh-sync', 'repo')
    await mkdir(join(repoDir, 'profile'), { recursive: true })
    await writeFile(join(repoDir, 'profile', 'conflicts.json'), JSON.stringify({
      version: 1,
      entries: [{ at: '2026-11-23T18:46:46.877Z', device: 'dev', file: 'profile/bundles.json', reason: 'обе копии изменились', resolution: 'локальная копия отправлена в зеркало' }],
    }))
    const status = await readProfileStatus({ home, config: { repoDir, profile: { enabled: true } } })
    assert.equal(status.conflictCount, 0, 'разрешённый конфликт не активен')
    assert.equal(status.conflictHistory, 1, 'он остался в истории')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
