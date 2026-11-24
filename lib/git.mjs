/**
 * Тонкая обёртка над git. Зеркало — рабочее дерево, которое считается
 * производным: перед каждой операцией оно приводится к состоянию удалённой
 * ветки, локальных коммитов там не бывает.
 *
 * Закалка сети (аудит P0-2 / P2-17):
 * - каждая операция ограничена таймаутом: обычная — 45 с, fetch/pull — 60 с,
 *   push с загрузкой файлов — 120 с; зависший git убивается вместе с деревом
 *   процессов (taskkill /T /F на Windows, сигнал группе на POSIX);
 * - сетевые сбои (schannel/TLS, таймаут, «fetch failed», обрыв соединения)
 *   у fetch и push повторяются до 3 раз с нарастающей паузой;
 * - GITHUB_TOKEN передаётся прямо в команду флагом
 *   `-c http.extraHeader=Authorization: Basic x-access-token:<токен>` —
 *   без credential helper и без sh (все вызовы идут с shell: false).
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rm, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Таймаут обычной git-операции (30–60 с по аудиту). */
export const GIT_TIMEOUT_MS = 45_000
/** Fetch/pull ходит в сеть — верхняя граница диапазона. */
export const GIT_FETCH_TIMEOUT_MS = 60_000
/** Push загружает файлы — 120 с по аудиту. */
export const GIT_PUSH_TIMEOUT_MS = 120_000

/** Сколько раз повторить сетевую ошибку (3–5 по аудиту). */
export const NETWORK_RETRIES = 3
let retryBaseMs = 1_500

const NETWORK_ERROR_RE = /schannel|ssl\b|tls\b|certificate|timed out|timeout|fetch failed|could not resolve host|connection reset|connection refused|connection closed|unable to access|operation timed out|failed to connect|early eof|unexpected disconnect|rpc failed|recv failure|send failure|network is unreachable|no route to host/i

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Тесты подменяют исполнителя, чтобы проверять последовательность команд на
// машине, где запуск настоящего git недоступен (например, под песочницей),
// и сам spawn — чтобы проверять таймаут и дерево процессов.
let runnerOverride = null
let spawnOverride = null

export function __setRunnerForTest(fn) {
  runnerOverride = fn
}

export function __setSpawnForTest(fn) {
  spawnOverride = fn
}

export function __setRetryBaseForTest(ms) {
  retryBaseMs = ms
}

const spawnFor = () => spawnOverride ?? spawn

/**
 * Убить процесс вместе с потомками.
 * Windows: taskkill /T /F. POSIX: сигнал группе — git запускается detached,
 * чтобы потомки попали в одну группу.
 */
function killTree(child) {
  if (typeof child?.pid !== 'number') {
    try {
      child?.kill?.('SIGKILL')
    } catch {
      // уже завершился
    }
    return
  }
  if (process.platform === 'win32') {
    const killer = spawnFor()('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    })
    killer.on('error', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // уже завершился
      }
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // уже завершился
    }
  }
}

/** Похоже ли на сетевой сбой, который стоит повторить. */
export function isNetworkError(result) {
  if (result?.code === -2) return true
  return NETWORK_ERROR_RE.test(`${result?.stderr ?? ''} ${result?.message ?? ''}`)
}

/**
 * Флаги авторизации для сетевых операций: токен GitHub передаём напрямую
 * через http.extraHeader, чтобы git не спрашивал учётные данные и не
 * полагался на credential helper. Для ssh-адресов флаги безвредны.
 */
export function authArgs() {
  const token = (process.env.GITHUB_TOKEN ?? '').trim()
  if (token === '') return []
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`]
}

// Вывод git собираем через временные файлы, а не через pipe: так вызов
// одинаково работает и в обычной консоли, и под песочницей, где программы
// не могут открывать именованные каналы.
export async function runCapture(args, cwd, { timeoutMs = GIT_TIMEOUT_MS, env: extraEnv = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-git-'))
  const outPath = join(dir, 'out')
  const errPath = join(dir, 'err')
  const out = await open(outPath, 'w')
  const err = await open(errPath, 'w')
  try {
    const code = await new Promise((resolvePromise) => {
      const child = spawnFor()('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extraEnv },
        stdio: ['ignore', out.fd, err.fd],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      })
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        killTree(child)
        resolvePromise({ code: -2, message: `git не ответил за ${timeoutMs} мс — процесс убит по таймауту` })
      }, timeoutMs)
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ code: -1, message: String(error.message) })
      })
      child.on('close', (exitCode) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ code: exitCode })
      })
    })
    const [stdout, stderr] = await Promise.all([readFile(outPath, 'utf8'), readFile(errPath, 'utf8')])
    return { code: code.code, stdout, stderr: code.message ?? stderr }
  } finally {
    await out.close().catch(() => {})
    await err.close().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function git(repoDir, args, { allowFailure = false, timeoutMs = GIT_TIMEOUT_MS, retries = 0 } = {}) {
  const runner = runnerOverride ?? runCapture
  const fullArgs = ['-C', repoDir, ...authArgs(), ...args]
  let result = await runner(fullArgs, repoDir, { timeoutMs })
  for (let attempt = 0; attempt < retries && isNetworkError(result); attempt++) {
    await pause(retryBaseMs * 2 ** attempt)
    result = await runner(fullArgs, repoDir, { timeoutMs })
  }
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} → ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result
}

export async function ensureRepo({ repoDir, branch = 'main' }) {
  if (!existsSync(repoDir)) {
    await mkdir(repoDir, { recursive: true })
    await git(repoDir, ['init', '-b', branch])
  }
}

export async function setRemote(repoDir, remote) {
  const current = await git(repoDir, ['remote', 'get-url', 'origin'], { allowFailure: true })
  if (current.code === 0) {
    if (current.stdout.trim() !== remote) await git(repoDir, ['remote', 'set-url', 'origin', remote])
    return
  }
  await git(repoDir, ['remote', 'add', 'origin', remote])
}

/** Состояние удалённой ветки; false — если ветки/римоута ещё нет. */
export async function fetchRemote(repoDir, branch) {
  const fetched = await git(repoDir, ['fetch', '--quiet', 'origin', branch], {
    allowFailure: true,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    retries: NETWORK_RETRIES,
  })
  if (fetched.code !== 0) return false
  const reset = await git(repoDir, ['reset', '--hard', '--quiet', 'FETCH_HEAD'], { allowFailure: true })
  return reset.code === 0
}

export async function hasChanges(repoDir) {
  const status = await git(repoDir, ['status', '--porcelain'])
  return status.stdout.trim() !== ''
}

/**
 * Закоммитить и отправить изменения.
 *
 * Проверяем не «есть ли изменения в рабочем дереве», а «есть ли что-то в
 * индексе после `add -A`: на Windows `status` показывает файлы из-за разницы
 * переводов строк, а после нормализации коммитить нечего — тогда коммит падал
 * с «nothing to commit».
 */
/** Сколько ждать, пока активный git-процесс отпустит index.lock (мс). */
export const INDEX_LOCK_WAIT_MS = 5_000
/** Лок старше этого возраста считается брошенным (мс). */
export const INDEX_LOCK_STALE_MS = 60_000

/**
 * Разобраться с чужим index.lock: свежий — подождать до INDEX_LOCK_WAIT_MS,
 * брошенный (старше INDEX_LOCK_STALE_MS) — удалить. Возвращает true, если лок снят.
 */
export async function recoverIndexLock(repoDir, errorText, options = {}) {
  const message = typeof errorText === 'string' ? errorText : ''
  if (!/index\.lock/i.test(message) || !/File exists/i.test(message)) return false
  const lockPath = join(repoDir, '.git', 'index.lock')
  const waitMs = options.waitMs ?? INDEX_LOCK_WAIT_MS
  const staleMs = options.staleMs ?? INDEX_LOCK_STALE_MS
  const deadline = Date.now() + waitMs
  while (true) {
    let info
    try {
      info = await stat(lockPath)
    } catch {
      return true
    }
    if (Date.now() - info.mtimeMs > staleMs) {
      try {
        await unlink(lockPath)
        return true
      } catch {
        return false
      }
    }
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

export async function commitAndPush({ repoDir, branch, message, name = 'dsh-sync', email = 'dsh-sync@localhost' }) {
  await git(repoDir, ['add', '-A'])
  const staged = await git(repoDir, ['diff', '--cached', '--name-only'])
  if (staged.stdout.trim() === '') return { committed: false, pushed: false }

  let commit = await git(repoDir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--quiet', '-m', message], { allowFailure: true })
  if (commit.code !== 0) {
    let text = `${commit.stdout}${commit.stderr}`
    // Гонка с внешним изменением: коммитить больше нечего — это не ошибка.
    if (/nothing to commit|no changes added/i.test(text)) {
      return { committed: false, pushed: false }
    }
    // Чужой git оставил index.lock (параллельная синхронизация или падение):
    // брошенный лок снимаем, свежий — ждём и повторяем commit один раз.
    if (!(await recoverIndexLock(repoDir, text))) {
      throw new Error(`git commit → ${commit.code}: ${text.trim()}`)
    }
    commit = await git(repoDir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--quiet', '-m', message], { allowFailure: true })
    text = `${commit.stdout}${commit.stderr}`
    if (commit.code !== 0) {
      throw new Error(`git commit → ${commit.code}: ${text.trim()}`)
    }
  }

  const pushed = await git(repoDir, ['push', '--quiet', 'origin', `HEAD:${branch}`], {
    allowFailure: true,
    timeoutMs: GIT_PUSH_TIMEOUT_MS,
    retries: NETWORK_RETRIES,
  })
  if (pushed.code !== 0) {
    if (isNetworkError(pushed)) {
      throw new Error(`git push не удался из-за сети (после ${NETWORK_RETRIES} повторов): ${pushed.stderr.trim() || pushed.stdout.trim()}`)
    }
    throw new Error(`git push отклонён: ${pushed.stderr.trim()} (сначала выполните pull)`)
  }

  // Держим pack компактным: история накапливает версии бинарных логов.
  await git(repoDir, ['gc', '--auto', '--quiet'], { allowFailure: true })
  return { committed: true, pushed: true }
}
