/**
 * Профильный слой: белый список, нейтрализация путей, машинные поля,
 * журнал конфликтов и обратная подстановка локальных путей.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../lib/config.mjs'
import { createNeutralizer } from '../lib/neutralize.mjs'
import {
  applyPatchMirror,
  decideSync,
  readLocalPatch,
  readProfileMirror,
  readProfileSnapshot,
  readProfileStatus,
  readLocalBundles,
  resolveProfileDir,
  stableStringify,
} from '../lib/profile.mjs'
import { pullProfile, pushProfile } from '../lib/profile.mjs'
import { addTombstone } from '../lib/tombstones.mjs'
import { parseYaml } from '../lib/yaml.mjs'

const PATCH_LOCAL = `# Пользовательский патч: комментарии и \\!!js должны остаться.
- insert:
    - id: third-party
      name: some-third-party
      config:
        value: !!js dshHomePath('x')
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
    fontSize: 16
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
`

async function makeEnv(prefix) {
  const root = await mkdtemp(join(tmpdir(), `dsh-profile-${prefix}-`))
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'desktop')
  const mirror = join(root, 'mirror')
  await mkdir(profileDir, { recursive: true })
  await mkdir(mirror, { recursive: true })
  await writeFile(join(profileDir, 'cordis.patch.yml'), PATCH_LOCAL)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: { 'dsh-notify': '^1.0.0' },
    dsh: { profile: { bundles: ['dsh-notify', '@deepseek-ai/dsh-base'] } },
  }, null, 2))
  await mkdir(join(profileDir, 'node_modules', 'dsh-notify'), { recursive: true })
  await writeFile(join(profileDir, 'node_modules', 'dsh-notify', 'package.json'), '{"name":"dsh-notify"}')
  const config = { ...defaultConfig(home), backend: 'folder', deviceId: `device-${prefix}`, repoDir: mirror }
  await mkdir(join(home, 'dsh-notify'), { recursive: true })
  await writeFile(join(home, 'dsh-notify', 'settings.json'), JSON.stringify({
    notifications: true,
    sound: false,
    theme: 'system',
    deviceId: 'machine-1',
    token: 'SECRET',
    machinePath: 'C:\\Users\\Nobody\\secret',
  }, null, 2))
  return { root, home, profileDir, mirror, config }
}

test('патч: комментарии, insert и !!js сохраняются, меняется только безопасная запись', async () => {
  const env = await makeEnv('patch')
  try {
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    const result = await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    assert.equal(result.skipped, false)
    const mirrorPatch = await readFile(join(env.mirror, 'profile', 'cordis.patch.yml'), 'utf8')
    assert.match(mirrorPatch, /ui-theme/)
    assert.match(mirrorPatch, /preference: dark/)
    assert.doesNotMatch(mirrorPatch, /agent-default-model/, 'небезопасная запись не должна уезжать')
    assert.doesNotMatch(mirrorPatch, /some-third-party/, 'insert-записи не переносятся')
    // Приём на «другом устройстве»: безопасные ключи применяются, остальное цело.
    const deviceB = await makeEnv('patch-b')
    try {
      await writeFile(join(deviceB.profileDir, 'cordis.patch.yml'), `- insert:\n    - id: keep\n      name: keep-me\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: light\n`)
      await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
      const pulled = await pullProfile({ home: deviceB.home, config: deviceB.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: deviceB.home }) })
      assert.equal(pulled.skipped, false)
      const patched = await readFile(join(deviceB.profileDir, 'cordis.patch.yml'), 'utf8')
      assert.match(patched, /id: keep/, 'чужая insert-запись должна остаться')
      assert.match(patched, /preference: dark/, 'тема приехала из зеркала')
      const doc = parseYaml(patched)
      const theme = doc.find(entry => entry?.id === 'ui-theme')
      assert.equal(theme.config.preference, 'dark')
      assert.equal(theme.config.fontSize, 16)
      assert.equal(doc.some(entry => entry?.id === 'agent-default-model'), false)
    } finally {
      await rm(deviceB.root, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('нейтрализация путей: в зеркало уходят токены, при приёме — локальные пути', () => {
  const neutralizer = createNeutralizer({ home: homedir(), dshHome: join(homedir(), '.dsh') })
  const text = `файл: ${join(homedir(), '.dsh', 'browser-secrets.env')} и %USERPROFILE%\\docs`
  const neutralized = neutralizer.neutralizeText(text)
  assert.match(neutralized, /\$\{DSH_HOME\}\/browser-secrets\.env/)
  assert.doesNotMatch(neutralized, new RegExp(homedir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'i'))
  assert.match(neutralized, /\$\{HOME\}[\\/]docs/)
  const back = neutralizer.localizeText(neutralized)
  assert.equal(back.includes(process.platform === 'win32' ? 'browser-secrets.env' : 'browser-secrets.env'), true)
  assert.equal(back.includes(homedir()), true)
})

test('MCP-пути в патче нейтрализуются при отправке и подставляются при приёме', async () => {
  const env = await makeEnv('mcp')
  try {
    const secretPath = join(env.home, 'browser-secrets.env')
    await writeFile(join(env.profileDir, 'cordis.patch.yml'), `- id: mcp-manager
  name: "@deepseek-ai/dsh-mcp-manager"
  config:
    servers:
      playwright:
        transport: stdio
        command: cmd
        args:
          - /c
          - --secrets
          - "${secretPath.replace(/\\/g, '\\\\')}"
        enabled: true
`)
    const neutralizer = createNeutralizer({ home: homedir(), dshHome: env.home })
    await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer })
    const mirrorPatch = await readFile(join(env.mirror, 'profile', 'cordis.patch.yml'), 'utf8')
    assert.match(mirrorPatch, /\$\{DSH_HOME\}\/browser-secrets\.env/)
    assert.equal(mirrorPatch.includes(env.home), false, 'локальный путь не должен уезжать в зеркало')

    const deviceB = await makeEnv('mcp-b')
    try {
      await pullProfile({ home: deviceB.home, config: deviceB.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: deviceB.home }) })
      const patched = await readFile(join(deviceB.profileDir, 'cordis.patch.yml'), 'utf8')
      assert.match(patched, /browser-secrets\.env/)
      assert.equal(patched.includes('${DSH_HOME}'), false, 'токен должен быть заменён локальным путём')
      assert.equal(patched.includes(deviceB.home), true)
    } finally {
      await rm(deviceB.root, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('настройки плагинов: белый список, машинные поля не уезжают', async () => {
  const env = await makeEnv('settings')
  try {
    await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: env.home }) })
    const mirrorSettings = JSON.parse(await readFile(join(env.mirror, 'profile', 'settings', 'dsh-notify.json'), 'utf8'))
    assert.equal(mirrorSettings.notifications, true)
    assert.equal(mirrorSettings.sound, false)
    assert.equal(mirrorSettings.deviceId, undefined)
    assert.equal(mirrorSettings.token, undefined)
    assert.equal(mirrorSettings.machinePath, undefined)
    const files = await readdir(join(env.mirror, 'profile', 'settings'))
    assert.deepEqual(files, ['dsh-notify.json'], 'плагины вне белого списка не синхронизируются')

    // Приём: локальные настройки обновляются, незнакомые ключи сохраняются.
    const deviceB = await makeEnv('settings-b')
    try {
      await writeFile(join(deviceB.home, 'dsh-notify', 'settings.json'), JSON.stringify({ notifications: false, volume: 50, custom: 'keep' }))
      await pullProfile({ home: deviceB.home, config: deviceB.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: deviceB.home }) })
      const applied = JSON.parse(await readFile(join(deviceB.home, 'dsh-notify', 'settings.json'), 'utf8'))
      assert.equal(applied.notifications, true)
      assert.equal(applied.sound, false)
      assert.equal(applied.custom, 'keep', 'локальные несинхронизируемые ключи не теряются')
    } finally {
      await rm(deviceB.root, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('браузерные настройки dsh-polish приезжают очередью для клиента', async () => {
  const env = await makeEnv('browser')
  try {
    await mkdir(join(env.home, 'dsh-sync'), { recursive: true })
    await writeFile(join(env.home, 'dsh-sync', 'browser-settings.json'), JSON.stringify({ settings: { 'dsh-polish': { enabled: true, panelVisibility: { a: 'pinned' } } } }))
    await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: env.home }) })
    const mirrorPolish = JSON.parse(await readFile(join(env.mirror, 'profile', 'settings', 'dsh-polish.json'), 'utf8'))
    assert.deepEqual(mirrorPolish.panelVisibility, { a: 'pinned' })

    const deviceB = await makeEnv('browser-b')
    try {
      await pullProfile({ home: deviceB.home, config: deviceB.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: deviceB.home }) })
      const pending = JSON.parse(await readFile(join(deviceB.home, 'dsh-sync', 'browser-settings.pending.json'), 'utf8'))
      assert.equal(pending.settings['dsh-polish'].enabled, true)
    } finally {
      await rm(deviceB.root, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('включённые плагины: добавляются только установленные, локальные не удаляются', async () => {
  const env = await makeEnv('bundles')
  try {
    await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: env.home }) })
    const mirrorBundles = JSON.parse(await readFile(join(env.mirror, 'profile', 'bundles.json'), 'utf8'))
    assert.deepEqual(mirrorBundles.bundles, ['dsh-notify', '@deepseek-ai/dsh-base'])
    assert.equal(mirrorBundles.dependencies, undefined, 'зависимости с адресами не переносятся')

    const deviceB = await makeEnv('bundles-b')
    try {
      await writeFile(join(deviceB.profileDir, 'package.json'), JSON.stringify({
        name: 'profile',
        dsh: { profile: { bundles: ['dsh-notify', 'dsh-local-only'] } },
      }, null, 2))
      const result = await pullProfile({ home: deviceB.home, config: deviceB.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: deviceB.home }) })
      assert.equal(result.skipped, false)
      const manifest = JSON.parse(await readFile(join(deviceB.profileDir, 'package.json'), 'utf8'))
      assert.deepEqual(manifest.dsh.profile.bundles, ['dsh-notify', 'dsh-local-only'])
      const warnings = (result.warnings ?? []).join(' ')
      assert.match(warnings, /не установлен/)
      // Повторная отправка с устройства B не удаляет его локальные плагины.
      await pushProfile({ home: deviceB.home, config: deviceB.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: deviceB.home }) })
      const bundles = await readLocalBundles(deviceB.profileDir)
      assert.deepEqual(bundles.bundles, ['dsh-notify', 'dsh-local-only'])
    } finally {
      await rm(deviceB.root, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('конфликт профиля: локальная копия остаётся, случай пишется в журнал', async () => {
  const homeA = await makeEnv('conflict-a')
  const homeB = await makeEnv('conflict-b')
  try {
    const configA = homeA.config
    const configB = { ...homeB.config, repoDir: homeA.mirror }
    const neA = createNeutralizer({ home: homedir(), dshHome: homeA.home })
    const neB = createNeutralizer({ home: homedir(), dshHome: homeB.home })
    // A отправляет тёмную тему, B принимает её как базис.
    await pushProfile({ home: homeA.home, config: configA, repoDir: homeA.mirror, neutralizer: neA })
    await pullProfile({ home: homeB.home, config: configB, repoDir: homeA.mirror, neutralizer: neB })
    let patchedB = await readFile(join(homeB.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patchedB, /preference: dark/)

    // A меняет тему на светлую и отправляет.
    const patchA = join(homeA.profileDir, 'cordis.patch.yml')
    await writeFile(patchA, PATCH_LOCAL.replace('preference: dark', 'preference: light'))
    await pushProfile({ home: homeA.home, config: configA, repoDir: homeA.mirror, neutralizer: neA })

    // B меняет тему сам — обе стороны изменились: применяется локальная.
    const patchB = join(homeB.profileDir, 'cordis.patch.yml')
    await writeFile(patchB, (await readFile(patchB, 'utf8')).replace('preference: dark', 'preference: system'))
    const pulled = await pullProfile({ home: homeB.home, config: configB, repoDir: homeA.mirror, neutralizer: neB })
    assert.equal(pulled.conflicts, 1)
    const after = await readFile(patchB, 'utf8')
    assert.match(after, /preference: system/, 'локальная копия не затирается')

    const journal = JSON.parse(await readFile(join(homeA.mirror, 'profile', 'conflicts.json'), 'utf8'))
    assert.equal(journal.entries.length, 1)
    assert.equal(journal.entries[0].file, 'profile/cordis.patch.yml')
    assert.match(String(journal.entries[0].reason), /изменились/)

    // Отправка с B разрешает конфликт в пользу локальной копии.
    await pushProfile({ home: homeB.home, config: configB, repoDir: homeA.mirror, neutralizer: neB })
    const mirrorPatch = await readFile(join(homeA.mirror, 'profile', 'cordis.patch.yml'), 'utf8')
    assert.match(mirrorPatch, /preference: system/)
  } finally {
    await rm(homeA.root, { recursive: true, force: true })
    await rm(homeB.root, { recursive: true, force: true })
  }
})

test('нет каталога профиля — профильный слой пропускается без падения', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-none-'))
  try {
    const home = join(root, 'home')
    const mirror = join(root, 'mirror')
    await mkdir(home, { recursive: true })
    await mkdir(mirror, { recursive: true })
    const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-none', repoDir: mirror }
    const pushed = await pushProfile({ home, config, repoDir: mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: home }) })
    assert.equal(pushed.skipped, true)
    const pulled = await pullProfile({ home, config, repoDir: mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: home }) })
    assert.equal(pulled.skipped, true)
    const status = await readProfileStatus({ home, config })
    assert.equal(status.available, false)
    assert.equal(status.enabled, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('подозрительная запись не попадает в profile/cordis.patch.yml как есть', async () => {
  const env = await makeEnv('junk')
  try {
    await writeFile(join(env.profileDir, 'cordis.patch.yml'), '- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: dark\n    tokenPath: C:\\Users\\Nobody\\secret\n')
    const local = await readLocalPatch(env.profileDir, createNeutralizer({ home: homedir(), dshHome: env.home }))
    // Ключ tokenPath не в белом списке — записи про тему нет? Есть preference,
    // значит запись остаётся, но только с безопасным ключом.
    assert.equal(local.entries.length, 1)
    assert.deepEqual(Object.keys(local.entries[0].config), ['preference'])
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('tombstones не трогаются профильным слоем', async () => {
  const env = await makeEnv('tomb')
  try {
    const tombstones = { version: 1, sessions: {} }
    addTombstone(tombstones, 'session-x', 'device-a')
    await writeFile(join(env.mirror, 'tombstones.json'), JSON.stringify(tombstones))
    await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: env.home }) })
    const after = JSON.parse(await readFile(join(env.mirror, 'tombstones.json'), 'utf8'))
    assert.deepEqual(after, tombstones)
    const mirror = await readProfileMirror(env.mirror)
    assert.equal(mirror.present, true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('решение о синхронизации: конфликт только когда обе стороны изменились', () => {
  // В зеркале ничего нет — применять.
  assert.deepEqual(decideSync({ localHash: 'l' }).apply, true)
  // Копии совпали — менять нечего.
  assert.equal(decideSync({ baseHash: 'a', localHash: 'a', remoteHash: 'a' }).apply, false)
  // Изменилась только локальная (отправка) или только удалённая (приём).
  assert.equal(decideSync({ baseHash: 'a', localHash: 'b', remoteHash: 'a' }).conflict, false)
  assert.equal(decideSync({ baseHash: 'a', localHash: 'a', remoteHash: 'b' }).conflict, false)
  // Первый обмен без базиса — не конфликт.
  assert.equal(decideSync({ localHash: 'a', remoteHash: 'b' }).conflict, false)
  // Обе стороны ушли от базиса — конфликт.
  const conflict = decideSync({ baseHash: 'a', localHash: 'b', remoteHash: 'c' })
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.apply, false)
})

test('стабильная сериализация не зависит от порядка ключей', () => {
  assert.equal(
    stableStringify({ b: 2, a: { d: 4, c: 3 } }),
    stableStringify({ a: { c: 3, d: 4 }, b: 2 }),
  )
})

test('каталог профиля: из окружения только внутри этого DSH_HOME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-dir-'))
  try {
    const home = join(root, 'home')
    const inside = join(home, 'profiles', 'desktop')
    const outside = join(root, 'other-profile')
    await mkdir(inside, { recursive: true })
    await mkdir(outside, { recursive: true })
    const config = { ...defaultConfig(home) }
    // Чужой профиль из окружения не подхватываем: иначе тестовая копия
    // плагина трогала бы настройки пользователя. Остаётся профиль этого DSH_HOME.
    assert.equal(resolveProfileDir(home, config, { DSH_PROFILE_DIR: outside }), inside)
    assert.equal(resolveProfileDir(home, config, { DSH_PROFILE_DIR: inside }), inside)
    // Явно указанный в настройках каталог — доверяем (это осознанный выбор).
    assert.equal(resolveProfileDir(home, { ...config, profileDir: outside }, {}), outside)
    // Без подсказок берём единственный найденный профиль.
    assert.equal(resolveProfileDir(home, config, {}), inside)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readProfileSnapshot не пишет файлов и не содержит секретов', async () => {
  const env = await makeEnv('snapshot')
  try {
    const before = await readFile(join(env.profileDir, 'cordis.patch.yml'), 'utf8')
    const snapshot = await readProfileSnapshot({ home: env.home, config: env.config })
    assert.equal(snapshot.profileDir, env.profileDir)
    const json = JSON.stringify(snapshot)
    assert.equal(json.includes('SECRET'), false)
    assert.equal(json.includes('machine-1'), false)
    assert.equal(await readFile(join(env.profileDir, 'cordis.patch.yml'), 'utf8'), before)
    assert.equal(existsSync(join(env.mirror, 'profile')), false)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('сквозной сценарий: push/pull переносят профиль, workspace и сессии вместе', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-e2e-'))
  try {
    const shared = join(root, 'shared')
    const homeA = join(root, 'home-a')
    const homeB = join(root, 'home-b')
    await mkdir(shared, { recursive: true })
    const projectA = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
    const projectB = process.platform === 'win32' ? 'D:\\work\\alpha' : '/home/user/alpha'

    const makeHome = async (home, projectPath, deviceId, withSession = true) => {
      await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
      await writeFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
    fontSize: 16
`)
      await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['dsh-notify'] } } }))
      await mkdir(join(home, 'storages'), { recursive: true })
      await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { defaultWorkspaceId: 'local-default', pinnedSessionIds: ['session-p'], archivedSessionIds: [] },
        tables: {
          workspaces: {
            'ws-local': { path: projectPath, title: 'Alpha', sessionIds: ['session-one'] },
          },
        },
      }))
      // Лог сессии, чтобы работал и обычный обмен сессиями.
      if (withSession) {
        const { localSessionDir } = await import('../lib/store.mjs')
        const { zstdCompressSync } = await import('node:zlib')
        const header = { type: 'session', version: 4, id: 'session-one', createdAt: Date.now(), cwd: projectPath, isSeeded: false, delegationDepth: 0 }
        const dir = localSessionDir(home, projectPath, 'session-one')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
          zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
          zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'text', seq: 0 })}\n`)),
        ]))
      }
      const config = { ...defaultConfig(home), backend: 'folder', deviceId, repoDir: shared }
      config.projects = { alpha: { path: projectPath, title: 'Alpha' } }
      return config
    }

    const configA = await makeHome(homeA, projectA, 'device-a')
    const configB = await makeHome(homeB, projectB, 'device-b', false)

    const { push, pull } = await import('../lib/sync.mjs')
    const pushed = await push({ home: homeA, config: configA })
    assert.equal(pushed.pushed, 1)
    assert.equal(pushed.profile?.skipped, false)
    assert.equal(pushed.workspace?.workspaces, 1)
    assert.equal(existsSync(join(shared, 'profile', 'cordis.patch.yml')), true)
    assert.equal(existsSync(join(shared, 'profile', 'bundles.json')), true)
    assert.equal(existsSync(join(shared, 'workspace.json')), true)

    const pulled = await pull({ home: homeB, config: configB })
    assert.equal(pulled.imported, 1)
    assert.equal(pulled.profile?.skipped, false)
    const themeText = await readFile(join(homeB, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    assert.match(themeText, /preference: dark/, 'тема приехала на второе устройство')
    // В локальном сторе путь остаётся локальным (стор DSH не переписывается).
    const localStore = JSON.parse(await readFile(join(homeB, 'storages', 'workspace.json'), 'utf8'))
    assert.equal(localStore.tables.workspaces['ws-local'].path, projectB)
    // Очередь привязки: у B сессия уже есть в сторе, привязывать нечего.
    assert.equal(pulled.workspace?.toAttach, 0)
    // Профиль в зеркале не содержит машинных путей.
    const mirrorPatch = await readFile(join(shared, 'profile', 'cordis.patch.yml'), 'utf8')
    assert.equal(mirrorPatch.includes(homeA), false)
    assert.equal(mirrorPatch.includes(projectA), false)
    const workspaceMirror = JSON.parse(await readFile(join(shared, 'workspace.json'), 'utf8'))
    assert.equal(JSON.stringify(workspaceMirror).includes(projectA), false)
    assert.equal(JSON.stringify(workspaceMirror).includes('pinnedSessionIds'), false)
    assert.equal(JSON.stringify(workspaceMirror).includes('defaultWorkspaceId'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
