import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir, splitLog } from '../lib/store.mjs'
import { pull, push } from '../lib/sync.mjs'
import { recordRun, readHistory } from '../lib/history.mjs'

// --- helpers ---------------------------------------------------------------

function makeLog(header, events) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function appendEvent(bytes, event) {
  return Buffer.concat([bytes, zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))])
}

function headerFor(cwd, id = `session-${randomUUID()}`, parent = undefined) {
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: parent === undefined ? 0 : 1 }
  if (parent !== undefined) header.parentSession = parent
  return header
}

async function writeSession(home, cwd, id, bytes) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), bytes)
  return dir
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-guard-'))
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  await mkdir(home, { recursive: true })
  await mkdir(shared, { recursive: true })
  const projectPath = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-a', repoDir: shared }
  config.projects = { alpha: { path: projectPath, title: 'alpha' } }
  await saveConfig(home, config)
  return { root, home, shared, config, projectPath }
}

const mirrorSessionDir = (config, projectId, id) => join(config.repoDir, 'sessions', projectId, id)

// --- порог и карантин ------------------------------------------------------

test('больше 5 удалений за прогон требуют подтверждения, затем уходят в карантин', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let i = 0; i < 7; i++) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.home, env.projectPath, id, makeLog(headerFor(env.projectPath, id), [{ seq: 0 }]))
    }
    await push({ home: env.home, config: env.config })

    for (const id of ids) {
      await rm(localSessionDir(env.home, env.projectPath, id), { recursive: true, force: true })
    }

    const blocked = await push({ home: env.home, config: env.config })
    assert.equal(blocked.removed, 0, 'без подтверждения ничего не удалено')
    assert.ok(blocked.requireConfirmation, 'есть запрос подтверждения')
    assert.equal(blocked.requireConfirmation.removed, 7)
    for (const id of ids) {
      assert.equal(existsSync(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd')), true, 'зеркало не тронуто')
    }

    const confirmed = await push({ home: env.home, config: env.config, confirmPrune: true })
    assert.equal(confirmed.removed, 7)
    assert.equal(confirmed.removedIds.length, 7)
    assert.equal(confirmed.removedReason, 'удалено локально')
    for (const id of ids) {
      assert.equal(existsSync(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd')), false, 'живая копия удалена')
      assert.equal(existsSync(join(env.config.repoDir, 'sessions', 'alpha', '_deleted', id, 'session.v4.jsonl.zstd')), true, 'карантин на месте')
      assert.equal(existsSync(join(env.config.repoDir, 'sessions', 'alpha', '_deleted', id, 'deleted-at.json')), true, 'отметка времени карантина')
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('одно удаление из десяти известных проходит без подтверждения', async () => {
  const env = await makeEnvironment()
  try {
    const ids = []
    for (let i = 0; i < 10; i++) {
      const id = `session-${randomUUID()}`
      ids.push(id)
      await writeSession(env.home, env.projectPath, id, makeLog(headerFor(env.projectPath, id), [{ seq: 0 }]))
    }
    await push({ home: env.home, config: env.config })

    await rm(localSessionDir(env.home, env.projectPath, ids[0]), { recursive: true, force: true })
    const result = await push({ home: env.home, config: env.config })
    assert.equal(result.requireConfirmation, undefined, '10% — ниже порога')
    assert.equal(result.removed, 1)
    assert.deepEqual(result.removedIds, [ids[0]])
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('карантин вычищается через 30 дней', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, id, makeLog(headerFor(env.projectPath, id), [{ seq: 0 }]))
    await push({ home: env.home, config: env.config })
    await rm(localSessionDir(env.home, env.projectPath, id), { recursive: true, force: true })
    await push({ home: env.home, config: env.config, confirmPrune: true })
    const quarantine = join(env.config.repoDir, 'sessions', 'alpha', '_deleted', id)
    assert.equal(existsSync(quarantine), true, 'карантин создан')

    // Состариваем запись: 40 дней назад.
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString()
    await writeFile(join(quarantine, 'deleted-at.json'), `${JSON.stringify({ at: old, reason: 'удалено локально' })}\n`, 'utf8')

    await push({ home: env.home, config: env.config })
    assert.equal(existsSync(quarantine), false, 'запись старше 30 дней вычищена')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- push-guard ------------------------------------------------------------

test('локальный лог короче зеркального — зеркало не перезаписывается', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const base = makeLog(headerFor(env.projectPath, id), [{ seq: 0 }])
    await writeSession(env.home, env.projectPath, id, base)
    await push({ home: env.home, config: env.config })

    // «Другое устройство» дописало зеркало вперёд.
    const longer = appendEvent(appendEvent(base, { seq: 1 }), { seq: 2 })
    await writeFile(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd'), longer)

    // Локально всё ещё короткий лог: короткий и является префиксом зеркального.
    const result = await push({ home: env.home, config: env.config })
    assert.equal(result.guarded.length, 1)
    assert.match(result.guarded[0].message, /короче зеркального/)
    const mirrored = await readFile(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd'))
    assert.deepEqual(splitLog(mirrored).tail, splitLog(longer).tail, 'зеркало сохранило больше событий')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('разошедшиеся логи: зеркало не перезаписывается', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const base = makeLog(headerFor(env.projectPath, id), [{ seq: 0 }])
    await writeSession(env.home, env.projectPath, id, base)
    await push({ home: env.home, config: env.config })

    const fromMirror = appendEvent(base, { seq: 1, from: 'mirror' })
    await writeFile(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd'), fromMirror)
    const local = appendEvent(base, { seq: 1, from: 'local' })
    await writeSession(env.home, env.projectPath, id, local)

    const result = await push({ home: env.home, config: env.config })
    assert.equal(result.guarded.length, 1)
    assert.match(result.guarded[0].message, /разошлись/)
    const mirrored = await readFile(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd'))
    assert.deepEqual(splitLog(mirrored).tail, splitLog(fromMirror).tail, 'зеркало не потеряло события')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('локальный лог длиннее зеркального-префикса — fast-forward записывается', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const base = makeLog(headerFor(env.projectPath, id), [{ seq: 0 }])
    await writeSession(env.home, env.projectPath, id, base)
    await push({ home: env.home, config: env.config })

    // Зеркало дописано до seq:2, локально — то же самое плюс ещё событие.
    const mirrorVersion = appendEvent(appendEvent(base, { seq: 1 }), { seq: 2 })
    await writeFile(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd'), mirrorVersion)
    const local = appendEvent(mirrorVersion, { seq: 3 })
    await writeSession(env.home, env.projectPath, id, local)

    const result = await push({ home: env.home, config: env.config })
    assert.equal(result.pushed, 1)
    assert.equal(result.guarded, undefined)
    const mirrored = await readFile(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd'))
    assert.deepEqual(splitLog(mirrored).tail, splitLog(local).tail)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- сверка версий DSH -----------------------------------------------------

test('зеркало нового формата не отдаётся старому приложению и не перезаписывается', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    await writeFile(
      join(env.config.repoDir, 'projects.json'),
      `${JSON.stringify({ version: 1, projects: {}, dsh: { version: '9.9.9', format: 5 } }, null, 2)}\n`,
      'utf8',
    )
    await writeSession(env.home, env.projectPath, id, makeLog(headerFor(env.projectPath, id), [{ seq: 0 }]))

    const result = await pull({ home: env.home, config: env.config })
    assert.equal(result.imported, 0, 'логи нового формата не импортируются')
    assert.match(result.warning ?? '', /новый формат/)

    const pushed = await push({ home: env.home, config: env.config })
    assert.equal(pushed.guarded.length, 1)
    assert.match(pushed.guarded[0].message, /новом формате/)
    assert.equal(existsSync(join(mirrorSessionDir(env.config, 'alpha', id), 'session.v4.jsonl.zstd')), false, 'в новое зеркало ничего не записано')

    const meta = JSON.parse(await readFile(join(env.config.repoDir, 'projects.json'), 'utf8'))
    assert.equal(meta.dsh.format, 5, 'отметка формата не понижена')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('зеркало новее по версии: предупреждение, приём продолжается, отметка не затирается', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const log = makeLog(headerFor(env.projectPath, id), [{ seq: 0 }])
    await writeSession(env.home, env.projectPath, id, log)
    await push({ home: env.home, config: env.config })

    // Зеркало «обновилось» более новой версией DSH при том же формате.
    const meta = JSON.parse(await readFile(join(env.config.repoDir, 'projects.json'), 'utf8'))
    meta.dsh = { version: '9.9.9', format: 4 }
    await writeFile(join(env.config.repoDir, 'projects.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

    // Старое приложение отправляет свою сессию: отметка версии не затирается.
    const pushed = await push({ home: env.home, config: env.config, dshVersion: '1.0.0' })
    assert.equal(pushed.guarded, undefined)
    const after = JSON.parse(await readFile(join(env.config.repoDir, 'projects.json'), 'utf8'))
    assert.equal(after.dsh.version, '9.9.9', 'более новая версия в метаданных сохранена')

    // Другое устройство принимает: предупреждение есть, импорт идёт.
    const other = await mkdtemp(join(tmpdir(), 'dsh-sync-guard-b-'))
    try {
      const configB = { ...env.config, deviceId: 'device-b' }
      configB.repoDir = env.config.repoDir
      const result = await pull({ home: other, config: configB, dshVersion: '1.0.0' })
      assert.equal(result.imported, 1)
      assert.match(result.warning ?? '', /более новой версией DSH/)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- журнал удалений -------------------------------------------------------

test('журнал запусков фиксирует удаления: removed, deletedIds, причина', async () => {
  const env = await makeEnvironment()
  try {
    const record = {
      ok: true,
      at: new Date().toISOString(),
      action: 'push',
      message: 'тест',
      removed: 3,
      removedIds: ['session-a', 'session-b', 'session-c'],
      removedReason: 'удалено локально',
    }
    await recordRun(env.home, record)

    const history = await readHistory(env.home, 5)
    const last = history[history.length - 1]
    assert.equal(last.removed, 3)
    assert.deepEqual(last.removedIds, ['session-a', 'session-b', 'session-c'])
    assert.equal(last.removedReason, 'удалено локально')

    const raw = await readFile(join(env.home, 'dsh-sync', 'history.jsonl'), 'utf8')
    assert.ok(raw.includes('"removed":3'), 'в файле журнала есть поле removed')
    assert.ok(raw.includes('"deletedIds"') || raw.includes('"removedIds"'), 'в файле журнала есть список id')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- субагенты -------------------------------------------------------------

test('недоступный каталог проекта останавливает удаление из зеркала', async () => {
  const env = await makeEnvironment()
  try {
    const a = `session-${randomUUID()}`
    const b = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, a, makeLog(headerFor(env.projectPath, a), [{ seq: 0 }]))
    await writeSession(env.home, env.projectPath, b, makeLog(headerFor(env.projectPath, b), [{ seq: 0 }]))
    await push({ home: env.home, config: env.config })

    // «Сломали доступ» к каталогу именно этого проекта: корень сессий цел,
    // а папка проекта исчезла. Это не «удалили всё» — удалять нельзя.
    await rm(join(env.home, 'sessions'), { recursive: true, force: true })
    await mkdir(join(env.home, 'sessions'), { recursive: true })

    const result = await push({ home: env.home, config: env.config })
    assert.equal(result.removed, 0, 'ничего не удалено')
    assert.match(result.warning ?? '', /каталог сессий проекта недоступен/)
    assert.equal(existsSync(join(mirrorSessionDir(env.config, 'alpha', a), 'session.v4.jsonl.zstd')), true, 'зеркало не тронуто')
    assert.equal(existsSync(join(mirrorSessionDir(env.config, 'alpha', b), 'session.v4.jsonl.zstd')), true, 'зеркало не тронуто')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('удаление родителя с субагентами предупреждает, sidecar хранит parent/children', async () => {
  const env = await makeEnvironment()
  try {
    const parentId = `session-${randomUUID()}`
    const childId = `session-${randomUUID()}`
    await writeSession(env.home, env.projectPath, parentId, makeLog(headerFor(env.projectPath, parentId), [{ seq: 0 }]))
    await writeSession(env.home, env.projectPath, childId, makeLog(headerFor(env.projectPath, childId, parentId), [{ seq: 0 }]))
    await push({ home: env.home, config: env.config })

    // sidecar родителя знает детей, sidecar ребёнка — родителя.
    const parentSidecar = JSON.parse(await readFile(join(mirrorSessionDir(env.config, 'alpha', parentId), 'session.json'), 'utf8'))
    const childSidecar = JSON.parse(await readFile(join(mirrorSessionDir(env.config, 'alpha', childId), 'session.json'), 'utf8'))
    assert.equal(parentSidecar.parent, '')
    assert.deepEqual(parentSidecar.children, [childId])
    assert.equal(childSidecar.parent, parentId)
    assert.deepEqual(childSidecar.children, [])

    // Удаляем родителя: предупреждение о субагентах, карантин родителя.
    await rm(localSessionDir(env.home, env.projectPath, parentId), { recursive: true, force: true })
    const result = await push({ home: env.home, config: env.config, confirmPrune: true })
    assert.equal(result.removed, 1)
    assert.deepEqual(result.removedIds, [parentId])
    assert.deepEqual(result.parentWithChildren, [childId])
    assert.match(result.warning ?? '', /родитель с субагентами/)
    assert.equal(existsSync(join(env.config.repoDir, 'sessions', 'alpha', '_deleted', parentId)), true, 'родитель в карантине')
    assert.equal(existsSync(join(mirrorSessionDir(env.config, 'alpha', childId), 'session.v4.jsonl.zstd')), true, 'ребёнок остался в зеркале')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
