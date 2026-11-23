/**
 * Профильный слой: полный белый список (расходы, задачи, «Входящие»),
 * manifest с хэшами, двухшаговый приём (план → «Применить») и бэкапы.
 *
 * Запуск: node --test test/profile-plan.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../lib/config.mjs'
import {
  EXPENSES_SESSION_LIMIT,
  PROFILE_BACKUP_SUFFIX,
  applyPendingProfile,
  discardProfilePlan,
  mergeExpenseSessions,
  mergeScheduleTasks,
  planProfilePull,
  pullProfile,
  pushProfile,
  readLocalExpenses,
  readLocalInbox,
  readLocalSchedule,
  readProfileApplyRecord,
  readProfileManifest,
  readProfileMirror,
  readProfilePlan,
} from '../lib/profile.mjs'

const PATCH = `# личный патч
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light
`

async function makeEnv(prefix, { autoApply = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), `dsh-profile-plan-${prefix}-`))
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'desktop')
  const mirror = join(root, 'mirror')
  await mkdir(profileDir, { recursive: true })
  await mkdir(mirror, { recursive: true })
  await writeFile(join(profileDir, 'cordis.patch.yml'), PATCH)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }, null, 2))
  const config = { ...defaultConfig(home), backend: 'folder', deviceId: `device-${prefix}`, repoDir: mirror }
  config.profile = { enabled: true, autoApply }
  return { root, home, profileDir, mirror, config }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function seedExpenses(home, sessions) {
  await mkdir(join(home, 'dsh-expenses'), { recursive: true })
  await writeFile(join(home, 'dsh-expenses', 'sessions.json'), `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, 'utf8')
}

async function seedSchedule(home, tasks) {
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'schedule.json'), `${JSON.stringify({
    unit: { name: 'schedule', version: 2 },
    global: null,
    tables: { tasks },
  }, null, 2)}\n`, 'utf8')
}

async function seedInbox(home, extra = {}) {
  await mkdir(join(home, 'dsh-inbox'), { recursive: true })
  await writeFile(join(home, 'dsh-inbox', 'state.json'), `${JSON.stringify({
    version: 5,
    offset: 100,
    enabled: true,
    botUsername: 'dsh_test_bot',
    allowedChatIds: ['111'],
    allowedUserIds: ['111'],
    ownerUserId: '111',
    ownerChatId: '',
    security: { groupsEnabled: false },
    deviceId: 'machine-id-should-not-sync',
    queue: { listener: true },
    lastUpdateId: 99,
    messages: [{ chatId: '111', text: 'секретная переписка', at: '2026-11-22T08:00:00.000Z', direction: 'in' }],
    currentChatSession: {},
    ...extra,
  }, null, 2)}\n`, 'utf8')
}

function expenseRecord(id, updatedAt, extra = {}) {
  return {
    id,
    title: `Сессия ${id}`,
    createdAt: updatedAt - 1000,
    updatedAt,
    input: 10,
    cacheHit: 20,
    output: 30,
    requests: 1,
    toolCalls: 2,
    costUsd: 0.01,
    todayInput: 5,
    todayCacheHit: 0,
    todayOutput: 0,
    todayRequests: 1,
    todayToolCalls: 0,
    todayCostUsd: 0.001,
    subagent: false,
    error: false,
    ...extra,
  }
}

function scheduleTask(id, updatedAt, prompt, extra = {}) {
  return {
    record: { id, kind: 'rrule', title: `Задача ${id}`, prompt, rrule: 'DTSTART:20261123T090000Z\nRRULE:FREQ=DAILY;COUNT=1', scheduledAt: '2026-11-23T09:00:00.000Z' },
    involvedSessionIds: [`session-${id}`],
    status: 'active',
    createdAt: '2026-11-22T09:00:00.000Z',
    updatedAt,
    target: { kind: 'session', sessionId: `session-${id}` },
    ...extra,
  }
}

test('история расходов: слияние по id, без дублей, более новый updatedAt побеждает', async () => {
  const local = {
    'id-a': expenseRecord('id-a', 200, { title: 'Локальная' }),
    'id-b': expenseRecord('id-b', 150),
  }
  const remote = {
    'id-a': expenseRecord('id-a', 100, { title: 'Старая' }),
    'id-c': expenseRecord('id-c', 300, { title: 'Из зеркала' }),
  }
  const merged = mergeExpenseSessions([local, remote], { limit: 10 })
  assert.deepEqual(Object.keys(merged).sort(), ['id-a', 'id-b', 'id-c'], 'без дублей, объединение по id')
  assert.equal(merged['id-a'].title, 'Локальная', 'более новая локальная запись не затёрта')
  assert.equal(merged['id-c'].title, 'Из зеркала', 'новая запись из зеркала добавлена')

  // Лимит: в зеркало уходят только самые свежие записи.
  const many = {}
  for (let index = 0; index < 12; index += 1) many[`id-${index}`] = expenseRecord(`id-${index}`, 1000 + index)
  const limited = mergeExpenseSessions([many], { limit: 5 })
  assert.equal(Object.keys(limited).length, 5)
  assert.equal(limited['id-11'] !== undefined, true, 'самая свежая запись осталась')
  assert.equal(limited['id-0'], undefined, 'самая старая отброшена по лимиту')
})

test('история расходов и задачи: переносятся по id, машинные поля не уезжают', async () => {
  const envA = await makeEnv('exp-a', { autoApply: true })
  const envB = await makeEnv('exp-b', { autoApply: true })
  try {
    await seedExpenses(envA.home, {
      's-1': expenseRecord('s-1', 200, { title: 'Работа' }),
      's-2': expenseRecord('s-2', 100),
    })
    await seedSchedule(envA.home, {
      't-1': scheduleTask('t-1', '2026-11-23T10:00:00.000Z', `Заметка: ${join(envA.home, 'notes.txt')}`),
      't-2': scheduleTask('t-2', '2026-11-22T10:00:00.000Z', 'простая задача'),
    })
    const neA = { home: homedir(), dshHome: envA.home }
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    await pushProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer(neA) })

    const mirrorExpenses = JSON.parse(await readFile(join(envA.mirror, 'profile', 'expenses-sessions.json'), 'utf8'))
    assert.equal(Object.keys(mirrorExpenses.sessions).length, 2)
    assert.equal(mirrorExpenses.sessions['s-1'].todayInput, undefined, 'счётчики «за сегодня» не переносятся')
    const mirrorScheduleRaw = await readFile(join(envA.mirror, 'profile', 'schedule.json'), 'utf8')
    assert.equal(mirrorScheduleRaw.includes(envA.home), false, 'локальный путь задачи не уехал в зеркало')
    assert.match(mirrorScheduleRaw, /\$\{DSH_HOME\}/, 'путь заменён токеном')

    // Устройство B: своя история и своя старая копия задачи t-1.
    await seedExpenses(envB.home, {
      's-1': expenseRecord('s-1', 100, { title: 'Старое имя' }),
      's-3': expenseRecord('s-3', 50),
    })
    await seedSchedule(envB.home, { 't-1': scheduleTask('t-1', '2026-11-21T10:00:00.000Z', 'старая версия'), 't-3': scheduleTask('t-3', '2026-11-20T10:00:00.000Z', 'местная') })

    const pushed = await pushProfile({
      home: envB.home,
      config: envB.config,
      repoDir: envA.mirror,
      neutralizer: createNeutralizer({ home: homedir(), dshHome: envB.home }),
    })
    assert.equal(pushed.skipped, false)
    const mergedMirror = JSON.parse(await readFile(join(envA.mirror, 'profile', 'expenses-sessions.json'), 'utf8'))
    assert.deepEqual(Object.keys(mergedMirror.sessions).sort(), ['s-1', 's-2', 's-3'], 'история объединена без дублей')
    assert.equal(mergedMirror.sessions['s-1'].title, 'Работа', 'побеждает более новый updatedAt')
    const mergedSchedule = JSON.parse(await readFile(join(envA.mirror, 'profile', 'schedule.json'), 'utf8'))
    assert.deepEqual(Object.keys(mergedSchedule.tasks).sort(), ['t-1', 't-2', 't-3'])
    assert.match(mergedSchedule.tasks['t-1'].record.prompt, /Заметка/, 'более новая задача не затёрта')

    // Слияние в обе стороны: приём на A обновляет локальные файлы и делает бэкап.
    await pullProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envA.home }) })
    const localExpenses = JSON.parse(await readFile(join(envA.home, 'dsh-expenses', 'sessions.json'), 'utf8'))
    assert.deepEqual(Object.keys(localExpenses.sessions).sort(), ['s-1', 's-2', 's-3'], 'приём добавил историю B без дублей')
    const expenseFiles = await readdir(join(envA.home, 'dsh-expenses'))
    assert.equal(expenseFiles.some(name => name.includes(PROFILE_BACKUP_SUFFIX)), true, 'перед записью истории расходов сделан бэкап')
    const localSchedule = JSON.parse(await readFile(join(envA.home, 'storages', 'schedule.json'), 'utf8'))
    assert.equal(Object.values(localSchedule.tables.tasks).some(entry => entry.record.id === 't-3'), true, 'задача B приехала на A')
  } finally {
    await rm(envA.root, { recursive: true, force: true })
    await rm(envB.root, { recursive: true, force: true })
  }
})

test('задачи автоматизации: приём сливает по id, локальные пути подставляются обратно', async () => {
  const envA = await makeEnv('sch-a', { autoApply: true })
  const envB = await makeEnv('sch-b', { autoApply: true })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    await seedSchedule(envA.home, {
      't-1': scheduleTask('t-1', '2026-11-23T10:00:00.000Z', `Файл: ${join(envA.home, 'notes.txt')}`),
    })
    await pushProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envA.home }) })
    await seedSchedule(envB.home, { 't-2': scheduleTask('t-2', '2026-11-20T10:00:00.000Z', 'местная задача') })

    const pulled = await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envB.home }) })
    assert.equal(pulled.skipped, false)
    assert.equal(pulled.mode, 'auto')
    const store = JSON.parse(await readFile(join(envB.home, 'storages', 'schedule.json'), 'utf8'))
    const ids = Object.values(store.tables.tasks).map(entry => entry.record.id).sort()
    assert.deepEqual(ids, ['t-1', 't-2'], 'обе задачи на месте, без дублей')
    const imported = Object.values(store.tables.tasks).find(entry => entry.record.id === 't-1')
    assert.match(imported.record.prompt, /notes\.txt/)
    assert.equal(imported.record.prompt.includes(envB.home), true, 'локальный путь подставлен')
  } finally {
    await rm(envA.root, { recursive: true, force: true })
    await rm(envB.root, { recursive: true, force: true })
  }
})

test('«Входящие»: в зеркало только настройки и белый список, машинные поля остаются локально', async () => {
  const envA = await makeEnv('inbox-a', { autoApply: true })
  const envB = await makeEnv('inbox-b', { autoApply: true })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    await seedInbox(envA.home)
    await pushProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envA.home }) })
    const mirrorText = await readFile(join(envA.mirror, 'profile', 'inbox-settings.json'), 'utf8')
    const mirror = JSON.parse(mirrorText)
    assert.deepEqual(mirror.settings.allowedChatIds, ['111'])
    assert.equal(mirror.settings.botUsername, 'dsh_test_bot')
    assert.equal(mirrorText.includes('machine-id-should-not-sync'), false, 'deviceId не уезжает')
    assert.equal(mirrorText.includes('секретная переписка'), false, 'история сообщений не уезжает')
    assert.equal(mirror.settings.offset, undefined, 'offset/lastUpdateId не уезжают')
    assert.equal(mirror.settings.queue, undefined, 'queue не уезжает')

    await seedInbox(envB.home, { deviceId: 'device-b-local', offset: 7, allowedChatIds: ['222'], allowedUserIds: ['222'], ownerUserId: '222' })
    await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envB.home }) })
    const inbox = JSON.parse(await readFile(join(envB.home, 'dsh-inbox', 'state.json'), 'utf8'))
    assert.deepEqual(inbox.allowedChatIds, ['111'], 'белый список приехал из зеркала')
    assert.equal(inbox.deviceId, 'device-b-local', 'машинный deviceId не затёрт')
    assert.equal(inbox.offset, 7, 'offset остался локальным')
    assert.deepEqual(inbox.queue, { listener: true }, 'queue осталась локальной')
    assert.equal(Array.isArray(inbox.messages), true, 'локальная история сообщений сохранена')
    const local = await readLocalInbox({ home: envB.home })
    assert.equal(local.settings.allowedChatIds[0], '111')

    // Устройство без плагина «Входящие» не должно затирать чужой белый список.
    const envC = await makeEnv('inbox-c', { autoApply: true })
    try {
      await pushProfile({ home: envC.home, config: envC.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envC.home }) })
      const afterPush = JSON.parse(await readFile(join(envA.mirror, 'profile', 'inbox-settings.json'), 'utf8'))
      assert.deepEqual(afterPush.settings.allowedChatIds, ['111'], 'белый список в зеркале не затёрт устройством без «Входящих»')
      const pulledC = await pullProfile({ home: envC.home, config: envC.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envC.home }) })
      assert.equal(pulledC.applied, 0)
      assert.equal(pulledC.pendingPlan, false)
      assert.equal((pulledC.warnings ?? []).some(text => /Входящих/.test(String(text))), true, 'в предупреждениях объяснено, почему «Входящие» пропущены')
      assert.equal(existsSync(join(envC.home, 'dsh-inbox', 'state.json')), false, 'state.json «Входящих» не создаётся без плагина')
    } finally {
      await rm(envC.root, { recursive: true, force: true })
    }
  } finally {
    await rm(envA.root, { recursive: true, force: true })
    await rm(envB.root, { recursive: true, force: true })
  }
})

test('manifest.json: sha256 и размеры совпадают с файлами зеркала', async () => {
  const env = await makeEnv('manifest', { autoApply: true })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    await seedExpenses(env.home, { 's-1': expenseRecord('s-1', 100) })
    await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: env.home }) })
    const manifest = await readProfileManifest(env.mirror)
    assert.equal(manifest.present, true)
    assert.equal(manifest.device, env.config.deviceId)
    assert.equal(Number.isFinite(Date.parse(manifest.updatedAt)), true, 'есть дата обновления')

    const patchFile = join(env.mirror, 'profile', 'cordis.patch.yml')
    const patchBytes = await readFile(patchFile)
    assert.deepEqual(manifest.files['profile/cordis.patch.yml'], { sha256: sha256(patchBytes), bytes: patchBytes.length })
    const expensesFile = join(env.mirror, 'profile', 'expenses-sessions.json')
    const expensesBytes = await readFile(expensesFile)
    assert.deepEqual(manifest.files['profile/expenses-sessions.json'], { sha256: sha256(expensesBytes), bytes: expensesBytes.length })
    assert.equal(Object.keys(manifest.files).every(rel => rel.startsWith('profile/')), true, 'пути относительные')
    assert.equal(manifest.files['profile/manifest.json'], undefined, 'манифест не описывает сам себя')
    assert.equal(manifest.files['profile/conflicts.json'], undefined, 'журнал конфликтов не в манифесте')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('ручной режим: pull строит план и не трогает файлы, применение — по кнопке', async () => {
  const envA = await makeEnv('manual-a', { autoApply: true })
  const envB = await makeEnv('manual-b', { autoApply: false })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    const themePatch = (await readFile(join(envA.profileDir, 'cordis.patch.yml'), 'utf8')).replace('preference: light', 'preference: dark')
    await writeFile(join(envA.profileDir, 'cordis.patch.yml'), themePatch)
    await mkdir(join(envA.home, 'dsh-notify'), { recursive: true })
    await writeFile(join(envA.home, 'dsh-notify', 'settings.json'), JSON.stringify({ notifications: true, sound: true }))
    await pushProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envA.home }) })
    await mkdir(join(envB.home, 'dsh-notify'), { recursive: true })
    await writeFile(join(envB.home, 'dsh-notify', 'settings.json'), JSON.stringify({ notifications: false, sound: false, custom: 'keep' }))
    // У B то же зеркало, что у A: в жизни это общий репозиторий/папка облака.
    envB.config = { ...envB.config, repoDir: envA.mirror }

    const pulled = await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envB.home }) })
    assert.equal(pulled.skipped, false)
    assert.equal(pulled.applied, 0, 'ручной режим: ничего не применено')
    assert.equal(pulled.pendingPlan, true, 'план ждёт применения')
    assert.equal(pulled.mode, 'pending')
    const localPatchBefore = await readFile(join(envB.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(localPatchBefore, /preference: light/, 'локальный файл не изменён до применения')

    const pending = await readProfilePlan(envB.home)
    assert.equal(pending.present, true)
    assert.equal(pending.entries.some(entry => entry.file === 'profile/cordis.patch.yml' && entry.action === 'apply'), true)
    assert.equal(pending.source.device, envA.config.deviceId, 'в плане видно устройство-источник')

    // Применение отложенного плана.
    const applied = await applyPendingProfile({ home: envB.home, config: envB.config, neutralizer: createNeutralizer({ home: homedir(), dshHome: envB.home }) })
    assert.equal(applied.ok, true)
    assert.ok(applied.applied >= 1, 'хотя бы тема применена')
    const localPatchAfter = await readFile(join(envB.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(localPatchAfter, /preference: dark/, 'тема приехала после «Применить»')
    const settings = JSON.parse(await readFile(join(envB.home, 'dsh-notify', 'settings.json'), 'utf8'))
    assert.equal(settings.notifications, true)
    assert.equal(settings.custom, 'keep', 'локальные несинхронизируемые ключи сохранены')

    // Бэкап каждого изменённого файла лежит рядом: <файл>.before-sync-<время>.
    const profileFiles = await readdir(envB.profileDir)
    assert.equal(profileFiles.some(name => name.includes(PROFILE_BACKUP_SUFFIX)), true, 'бэкап cordis.patch.yml рядом с файлом')
    const notifyFiles = await readdir(join(envB.home, 'dsh-notify'))
    assert.equal(notifyFiles.some(name => name.includes(PROFILE_BACKUP_SUFFIX)), true, 'бэкап settings.json рядом с файлом')

    // План израсходован, итог применения записан.
    assert.equal((await readProfilePlan(envB.home)).present, false, 'план очищен после применения')
    const record = await readProfileApplyRecord(envB.home)
    assert.equal(record.present, true)
    assert.equal(record.mode, 'manual')
    assert.ok(record.applied >= 1)
  } finally {
    await rm(envA.root, { recursive: true, force: true })
    await rm(envB.root, { recursive: true, force: true })
  }
})

test('план устаревает: изменившийся локальный файл или зеркало не затираются', async () => {
  const envA = await makeEnv('stale-a', { autoApply: true })
  const envB = await makeEnv('stale-b', { autoApply: false })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    envB.config = { ...envB.config, repoDir: envA.mirror }
    await writeFile(join(envA.profileDir, 'cordis.patch.yml'), PATCH.replace('preference: light', 'preference: dark'))
    await pushProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envA.home }) })
    const neB = createNeutralizer({ home: homedir(), dshHome: envB.home })
    await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: neB })

    // Пока план лежал, локальный файл B изменился вручную.
    await writeFile(join(envB.profileDir, 'cordis.patch.yml'), PATCH.replace('preference: light', 'preference: system'))
    const applied = await applyPendingProfile({ home: envB.home, config: envB.config, neutralizer: neB })
    assert.equal(applied.ok, false, 'устаревший план не применяется')
    assert.equal(applied.skipped.some(item => /изменился после плана/.test(String(item.reason))), true)
    assert.match(await readFile(join(envB.profileDir, 'cordis.patch.yml'), 'utf8'), /preference: system/, 'локальная правка не затёрта')

    // Новый план после приёма применяется уже на актуальные данные.
    await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: neB })
    const again = await applyPendingProfile({ home: envB.home, config: envB.config, neutralizer: neB })
    assert.equal(again.ok, true)
    assert.match(await readFile(join(envB.profileDir, 'cordis.patch.yml'), 'utf8'), /preference: dark/)
  } finally {
    await rm(envA.root, { recursive: true, force: true })
    await rm(envB.root, { recursive: true, force: true })
  }
})

test('повторный приём не строит план заново из-за локальных дополнений', async () => {
  const envA = await makeEnv('repeat-a', { autoApply: true })
  const envB = await makeEnv('repeat-b', { autoApply: true })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    await writeFile(join(envA.profileDir, 'cordis.patch.yml'), PATCH.replace('preference: light', 'preference: dark'))
    // У B есть своя безопасная запись, которой нет в зеркале: это не конфликт.
    await writeFile(join(envB.profileDir, 'cordis.patch.yml'), `${PATCH}- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: en
`)
    await pushProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envA.home }) })
    const neB = createNeutralizer({ home: homedir(), dshHome: envB.home })
    const first = await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: neB })
    assert.equal(first.mode, 'auto')
    assert.ok(first.applied >= 1)
    const second = await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: neB })
    assert.equal(second.applied, 0, 'повторно применять нечего')
    assert.equal(second.pendingPlan, false, 'план не появляется снова')
    const third = await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: neB })
    assert.equal(third.plan.entries.filter(entry => entry.action === 'apply').length, 0, 'все единицы — skip')
    assert.match(await readFile(join(envB.profileDir, 'cordis.patch.yml'), 'utf8'), /preference: en/, 'локальная запись сохранена')
  } finally {
    await rm(envA.root, { recursive: true, force: true })
    await rm(envB.root, { recursive: true, force: true })
  }
})

test('авто-применение: без конфликтов приём сразу меняет профиль', async () => {
  const envA = await makeEnv('auto-a', { autoApply: true })
  const envB = await makeEnv('auto-b', { autoApply: true })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    await writeFile(join(envA.profileDir, 'cordis.patch.yml'), PATCH.replace('preference: light', 'preference: dark'))
    await pushProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envA.home }) })
    const pulled = await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envB.home }) })
    assert.equal(pulled.mode, 'auto')
    assert.equal(pulled.pendingPlan, false)
    assert.ok(pulled.applied >= 1)
    assert.match(await readFile(join(envB.profileDir, 'cordis.patch.yml'), 'utf8'), /preference: dark/)
  } finally {
    await rm(envA.root, { recursive: true, force: true })
    await rm(envB.root, { recursive: true, force: true })
  }
})

test('план можно перестроить и отменить: файлы не меняются', async () => {
  const envA = await makeEnv('plan-a', { autoApply: true })
  const envB = await makeEnv('plan-b', { autoApply: false })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    await writeFile(join(envA.profileDir, 'cordis.patch.yml'), PATCH.replace('preference: light', 'preference: dark'))
    await pushProfile({ home: envA.home, config: envA.config, repoDir: envA.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: envA.home }) })
    const neB = createNeutralizer({ home: homedir(), dshHome: envB.home })
    await pullProfile({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: neB })
    const plan = await planProfilePull({ home: envB.home, config: envB.config, repoDir: envA.mirror, neutralizer: neB })
    assert.equal(plan.entries.some(entry => entry.action === 'apply'), true)
    assert.equal(plan.source.device, envA.config.deviceId)
    assert.equal(await discardProfilePlan(envB.home).then(result => result.discarded), true)
    assert.equal((await readProfilePlan(envB.home)).present, false)
    assert.match(await readFile(join(envB.profileDir, 'cordis.patch.yml'), 'utf8'), /preference: light/, 'отмена плана не меняет файлы')
  } finally {
    await rm(envA.root, { recursive: true, force: true })
    await rm(envB.root, { recursive: true, force: true })
  }
})

test('лимит истории расходов соблюдается в зеркале', async () => {
  const env = await makeEnv('limit', { autoApply: true })
  try {
    const { createNeutralizer } = await import('../lib/neutralize.mjs')
    const sessions = {}
    for (let index = 0; index < EXPENSES_SESSION_LIMIT + 7; index += 1) {
      sessions[`limit-${index}`] = expenseRecord(`limit-${index}`, 1000 + index)
    }
    await seedExpenses(env.home, sessions)
    await pushProfile({ home: env.home, config: env.config, repoDir: env.mirror, neutralizer: createNeutralizer({ home: homedir(), dshHome: env.home }) })
    const mirror = await readProfileMirror(env.mirror)
    assert.equal(Object.keys(mirror.expenses.sessions).length, EXPENSES_SESSION_LIMIT, 'в зеркале не больше лимита записей')
    assert.equal(mirror.expenses.sessions['limit-0'], undefined, 'самые старые записи отброшены')
    assert.equal(mirror.expenses.sessions[`limit-${EXPENSES_SESSION_LIMIT + 6}`] !== undefined, true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('readLocalExpenses/readLocalSchedule/readLocalInbox не падают без файлов', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-empty-'))
  try {
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    const expenses = await readLocalExpenses({ home })
    assert.equal(expenses.found, false)
    assert.deepEqual(expenses.sessions, {})
    const schedule = await readLocalSchedule({ home })
    assert.equal(schedule.found, false)
    const inbox = await readLocalInbox({ home })
    assert.equal(inbox.found, false)
    assert.deepEqual(inbox.settings, {})
    // Пустое зеркало: профильного слоя нет, план пустой.
    const plan = await planProfilePull({ home, config: { ...defaultConfig(home), profileDir: undefined }, repoDir: join(root, 'mirror') })
    assert.equal(plan.mirrorPresent, false)
    assert.deepEqual(plan.entries, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Слияние пустых источников не падает и не выдумывает записи.
test('слияние пустых источников безопасно', () => {
  assert.deepEqual(mergeExpenseSessions([{}, undefined]), {})
  assert.deepEqual(mergeScheduleTasks([{}, undefined], { limit: 1 }), {})
  assert.equal(PROFILE_BACKUP_SUFFIX, '.before-sync-')
})
