/**
 * Тесты папки-бэкенда: копирование между локальным кешем и папкой облачного
 * клиента, сверка (reconcile), удаление исчезнувших файлов и повторы io-ошибок.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFolderBackend, retryIo, transientIoError } from '../lib/folder.mjs'

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-folder-'))
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, ...rel.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
}

test('папка-бэкенд выгружает кеш в папку облака и забирает обратно', async () => {
  const root = await makeRoot()
  const cloud = join(root, 'cloud')
  const cacheA = join(root, 'cache-a')
  const cacheB = join(root, 'cache-b')
  try {
    const files = {
      'sessions/p/session-1/session.v4.jsonl.zstd': 'лог-1',
      'sessions/p/session-2/session.v4.jsonl.zstd': 'лог-2',
      'projects.json': '{"projects":{}}',
    }
    await writeTree(cacheA, files)

    const backendA = createFolderBackend({ repoDir: cacheA, folderDir: cloud }, { baseMs: 1 })
    const uploaded = await backendA.commit()
    assert.equal(uploaded.uploaded, 3, 'все файлы выгружены')
    assert.equal(uploaded.committed, true)
    for (const rel of Object.keys(files)) {
      assert.equal(existsSync(join(cloud, ...rel.split('/'))), true, `в папке облака есть ${rel}`)
    }

    const backendB = createFolderBackend({ repoDir: cacheB, folderDir: cloud }, { baseMs: 1 })
    await backendB.sync()
    for (const [rel, content] of Object.entries(files)) {
      assert.equal(await readFile(join(cacheB, ...rel.split('/')), 'utf8'), content, `кеш получил ${rel}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('папка-бэкенд удаляет из облака файлы, исчезнувшие из кеша', async () => {
  const root = await makeRoot()
  const cloud = join(root, 'cloud')
  const cache = join(root, 'cache')
  try {
    await writeTree(cache, {
      'sessions/p/keep/session.v4.jsonl.zstd': 'остаётся',
      'sessions/p/drop/session.v4.jsonl.zstd': 'удаляется',
    })
    const backend = createFolderBackend({ repoDir: cache, folderDir: cloud }, { baseMs: 1 })
    await backend.commit()

    await rm(join(cache, 'sessions', 'p', 'drop'), { recursive: true, force: true })
    const result = await backend.commit()
    assert.equal(result.removed, 1, 'лишний файл убран из облака')
    assert.equal(existsSync(join(cloud, 'sessions', 'p', 'drop', 'session.v4.jsonl.zstd')), false)
    assert.equal(existsSync(join(cloud, 'sessions', 'p', 'keep', 'session.v4.jsonl.zstd')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('сверка папки считает локальные, облачные и разошедшиеся файлы', async () => {
  const root = await makeRoot()
  const cloud = join(root, 'cloud')
  const cache = join(root, 'cache')
  try {
    await writeTree(cloud, {
      'sessions/p/shared/session.v4.jsonl.zstd': 'в облаке старее',
      'sessions/p/cloud-only/session.v4.jsonl.zstd': 'только облако',
      'projects.json': '{}',
    })
    await writeTree(cache, {
      'sessions/p/shared/session.v4.jsonl.zstd': 'в кеше новее и длиннее',
      'sessions/p/local-only/session.v4.jsonl.zstd': 'только локально',
    })
    const backend = createFolderBackend({ repoDir: cache, folderDir: cloud }, { baseMs: 1 })
    const plan = await backend.compare()
    assert.equal(plan.local, 2, 'локальных файлов')
    assert.equal(plan.cloud, 3, 'облачных файлов')
    assert.equal(plan.differ, 1, 'один файл отличается')
    assert.equal(plan.onlyLocal, 1, 'один только локально')
    assert.equal(plan.onlyCloud, 2, 'два только в облаке (сессия и projects.json)')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('старый режим: облачная папка совпадает с кешем — копировать нечего', async () => {
  const root = await makeRoot()
  const shared = join(root, 'shared')
  try {
    await writeTree(shared, { 'sessions/p/s/session.v4.jsonl.zstd': 'лог' })
    const backend = createFolderBackend({ repoDir: shared, folderDir: shared }, { baseMs: 1 })
    await backend.sync()
    const result = await backend.commit()
    assert.equal(result.uploaded, 0)
    assert.equal(result.removed, 0)
    assert.equal(backend.sameDir, true)
    assert.equal(await readFile(join(shared, 'sessions', 'p', 's', 'session.v4.jsonl.zstd'), 'utf8'), 'лог')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('io-ошибки повторяются (3–5 попыток), обычные — сразу наружу', async () => {
  let calls = 0
  const value = await retryIo(async () => {
    calls += 1
    if (calls < 3) {
      const error = new Error('файл занят клиентом облака')
      error.code = 'EBUSY'
      throw error
    }
    return 'готово'
  }, { baseMs: 1 })
  assert.equal(value, 'готово')
  assert.equal(calls, 3, 'две временные ошибки повторены')

  let hardCalls = 0
  await assert.rejects(
    () => retryIo(async () => {
      hardCalls += 1
      const error = new Error('неверный путь')
      error.code = 'EINVAL'
      throw error
    }, { baseMs: 1 }),
    /неверный путь/,
  )
  assert.equal(hardCalls, 1, 'постоянную ошибку не повторяем')

  let exhausted = 0
  await assert.rejects(
    () => retryIo(async () => {
      exhausted += 1
      const error = new Error('всё ещё занято')
      error.code = 'EPERM'
      throw error
    }, { baseMs: 1, retries: 4 }),
    /всё ещё занято/,
  )
  assert.equal(exhausted, 4, 'всего 4 попытки')

  assert.equal(transientIoError({ code: 'EBUSY' }), true)
  assert.equal(transientIoError({ code: 'EINVAL' }), false)
})

test('без папки облака бэкенд говорит об этом прямо', () => {
  assert.throws(
    () => createFolderBackend({ repoDir: '/tmp/cache' }),
    /не задана папка облака/,
  )
})
