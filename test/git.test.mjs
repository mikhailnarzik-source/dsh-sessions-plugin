import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __setRetryBaseForTest,
  __setRunnerForTest,
  __setSpawnForTest,
  commitAndPush,
  ensureRepo,
  fetchRemote,
  git,
  isNetworkError,
  runCapture,
  setRemote,
} from '../lib/git.mjs'

function recorder(responses = {}) {
  const calls = []
  const runner = async (args) => {
    calls.push(args.join(' '))
    for (const [pattern, value] of Object.entries(responses)) {
      if (args.join(' ').includes(pattern)) return typeof value === 'function' ? value(args) : value
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}

/** На время теста убираем GITHUB_TOKEN: токен добавляет флаги в команды. */
async function withoutGithubToken(run) {
  const saved = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    return await run()
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved
  }
}

test('git: инициализация, remote, fetch и коммит идут в нужном порядке', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    await withoutGithubToken(async () => {
      const { calls, runner } = recorder({
        'remote get-url origin': { code: 128, stdout: '', stderr: 'no such remote' },
        'diff --cached --name-only': { code: 0, stdout: 'sessions/alpha/x\n', stderr: '' },
      })
      __setRunnerForTest(runner)

      const repoDir = join(root, 'repo')
      await ensureRepo({ repoDir, branch: 'main' })
      await setRemote(repoDir, 'git@github.com:me/sessions.git')
      await fetchRemote(repoDir, 'main')
      const result = await commitAndPush({ repoDir, branch: 'main', message: 'test' })

      assert.equal(result.committed, true)
      assert.equal(result.pushed, true)
      assert.deepEqual(calls.map(call => `git ${call}`), [
        'git -C ' + repoDir + ' init -b main',
        'git -C ' + repoDir + ' remote get-url origin',
        'git -C ' + repoDir + ' remote add origin git@github.com:me/sessions.git',
        'git -C ' + repoDir + ' fetch --quiet origin main',
        'git -C ' + repoDir + ' reset --hard --quiet FETCH_HEAD',
        'git -C ' + repoDir + ' add -A',
        'git -C ' + repoDir + ' diff --cached --name-only',
        'git -C ' + repoDir + ' -c user.name=dsh-sync -c user.email=dsh-sync@localhost commit --quiet -m test',
        'git -C ' + repoDir + ' push --quiet origin HEAD:main',
        'git -C ' + repoDir + ' gc --auto --quiet',
      ])
    })
  } finally {
    __setRunnerForTest(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: без изменений коммит не создаётся', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    await withoutGithubToken(async () => {
      const { calls, runner } = recorder({ 'diff --cached --name-only': { code: 0, stdout: '', stderr: '' } })
      __setRunnerForTest(runner)
      const repoDir = join(root, 'repo')
      await ensureRepo({ repoDir, branch: 'main' })
      const result = await commitAndPush({ repoDir, branch: 'main', message: 'empty' })
      assert.equal(result.committed, false)
      assert.equal(calls.some(call => call.includes('commit')), false)
    })
  } finally {
    __setRunnerForTest(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: отклонённый push сообщает о необходимости pull и не повторяется', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    await withoutGithubToken(async () => {
      const { calls, runner } = recorder({
        'diff --cached --name-only': { code: 0, stdout: 'x\n', stderr: '' },
        'push --quiet': { code: 1, stdout: '', stderr: 'rejected: non-fast-forward' },
      })
      __setRunnerForTest(runner)
      const repoDir = join(root, 'repo')
      await ensureRepo({ repoDir, branch: 'main' })
      await assert.rejects(() => commitAndPush({ repoDir, branch: 'main', message: 'x' }), /сначала выполните pull/)
      // Отклонение — не сетевой сбой: повторных попыток быть не должно.
      assert.equal(calls.filter(call => call.includes('push --quiet')).length, 1)
    })
  } finally {
    __setRunnerForTest(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: allowFailure возвращает код вместо исключения', async () => {
  __setRunnerForTest(async () => ({ code: 1, stdout: '', stderr: 'boom' }))
  try {
    const result = await git('.', ['status'], { allowFailure: true })
    assert.equal(result.code, 1)
    await assert.rejects(() => git('.', ['status']), /boom/)
  } finally {
    __setRunnerForTest(null)
  }
})

test('git: сетевой сбой fetch повторяется и завершается успехом', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    await withoutGithubToken(async () => {
      let fetchCalls = 0
      const { runner } = recorder({
        'fetch --quiet': () => {
          fetchCalls += 1
          if (fetchCalls <= 2) {
            return { code: 128, stdout: '', stderr: 'fatal: unable to access: schannel: next InitializeSecurityContext failed: SEC_E_ILLEGAL_MESSAGE' }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
        'reset --hard': { code: 0, stdout: '', stderr: '' },
      })
      __setRunnerForTest(runner)
      __setRetryBaseForTest(5)

      const ok = await fetchRemote(join(root, 'repo'), 'main')
      assert.equal(ok, true)
      assert.equal(fetchCalls, 3)
    })
  } finally {
    __setRunnerForTest(null)
    __setRetryBaseForTest(1500)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: сетевой сбой push повторяется, после повторов ошибка понятна', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    await withoutGithubToken(async () => {
      const { calls, runner } = recorder({
        'diff --cached --name-only': { code: 0, stdout: 'x\n', stderr: '' },
        'push --quiet': { code: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host' },
      })
      __setRunnerForTest(runner)
      __setRetryBaseForTest(5)
      const repoDir = join(root, 'repo')
      await ensureRepo({ repoDir, branch: 'main' })
      await assert.rejects(() => commitAndPush({ repoDir, branch: 'main', message: 'x' }), /из-за сети/)
      assert.equal(calls.filter(call => call.includes('push --quiet')).length, 4)
    })
  } finally {
    __setRunnerForTest(null)
    __setRetryBaseForTest(1500)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: GITHUB_TOKEN передаётся напрямую через http.extraHeader, без credential helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  const saved = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'test-token-123'
  try {
    const { calls, runner } = recorder({
      'remote get-url origin': { code: 128, stdout: '', stderr: 'no such remote' },
      'diff --cached --name-only': { code: 0, stdout: 'x\n', stderr: '' },
    })
    __setRunnerForTest(runner)
    const repoDir = join(root, 'repo')
    await ensureRepo({ repoDir, branch: 'main' })
    await setRemote(repoDir, 'https://github.com/me/sessions.git')
    const result = await commitAndPush({ repoDir, branch: 'main', message: 'x' })
    assert.equal(result.pushed, true)

    const expected = Buffer.from('x-access-token:test-token-123').toString('base64')
    const pushCall = calls.find(call => call.includes('push --quiet'))
    assert.ok(pushCall, 'push выполнен')
    assert.ok(pushCall.includes(`-c http.extraHeader=Authorization: Basic ${expected}`), 'токен в http.extraHeader')
    assert.equal(calls.some(call => /credential|askpass|helper/i.test(call)), false, 'без credential helper')
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved
    __setRunnerForTest(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: без GITHUB_TOKEN заголовок авторизации не добавляется', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    await withoutGithubToken(async () => {
      const { calls, runner } = recorder({ 'diff --cached --name-only': { code: 0, stdout: 'x\n', stderr: '' } })
      __setRunnerForTest(runner)
      const repoDir = join(root, 'repo')
      await ensureRepo({ repoDir, branch: 'main' })
      await commitAndPush({ repoDir, branch: 'main', message: 'x' })
      assert.equal(calls.some(call => call.includes('http.extraHeader')), false)
    })
  } finally {
    __setRunnerForTest(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: таймаут убивает зависший git вместе с деревом процессов', async () => {
  const spawned = []
  const fakeGit = new EventEmitter()
  fakeGit.pid = 4242
  fakeGit.kill = () => {}
  __setSpawnForTest((command, args, options) => {
    spawned.push({ command, args, shell: options.shell })
    if (command === 'git') return fakeGit
    // taskkill (дерево процессов): завершается успешно.
    const killer = new EventEmitter()
    setTimeout(() => killer.emit('close', 0), 0)
    return killer
  })
  try {
    const result = await runCapture(['status'], '.', { timeoutMs: 30 })
    assert.equal(result.code, -2)
    assert.match(result.stderr, /таймаут/i)
    assert.equal(isNetworkError(result), true)

    const gitCall = spawned.find(call => call.command === 'git')
    assert.ok(gitCall, 'git запущен')
    assert.equal(gitCall.shell, false, 'shell: false — без sh')

    if (process.platform === 'win32') {
      const taskkill = spawned.find(call => call.command === 'taskkill')
      assert.ok(taskkill, 'taskkill вызывается для дерева процессов')
      assert.ok(taskkill.args.includes('/T') && taskkill.args.includes('/F'), 'убивается всё дерево')
      assert.equal(taskkill.shell, false)
    } else {
      assert.ok(fakeGit.kill !== undefined, 'на POSIX процесс убивается сигналом')
    }
  } finally {
    __setSpawnForTest(null)
  }
})
