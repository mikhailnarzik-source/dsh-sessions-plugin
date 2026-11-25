import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planProfilePull } from '../lib/profile.mjs'

test('настройки панелей (browser) не попадают в план профиля', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-browser-settings-plan-'))
  try {
    await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
    await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'desktop', dependencies: {} }))
    const repoDir = join(home, 'dsh-sync', 'repo')
    await mkdir(join(repoDir, 'profile', 'settings'), { recursive: true })
    await writeFile(join(repoDir, 'profile', 'settings', 'dsh-cards.json'), JSON.stringify({ panelVisibility: { visible: ['cards'], pinned: [], known: [] } }))
    await writeFile(join(repoDir, 'profile', 'settings', 'dsh-polish.json'), JSON.stringify({ panelVisibility: { visible: ['polish'], pinned: [], known: [] } }))
    await writeFile(join(repoDir, 'profile', 'manifest.json'), JSON.stringify({ version: 1, device: 'x', updatedAt: new Date().toISOString(), files: {} }))
    const plan = await planProfilePull({ home, config: { repoDir, profile: { enabled: true }, projects: {} }, repoDir })
    const settingsFiles = plan.entries.filter((entry) => String(entry.file).startsWith('profile/settings/') && String(entry.file).match(/dsh-(cards|polish)\.json/))
    assert.deepEqual(settingsFiles, [], 'браузерные настройки панелей пропущены в плане')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
