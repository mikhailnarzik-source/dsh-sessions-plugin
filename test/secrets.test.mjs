/**
 * Проверка переноса пароля WebDAV в хранилище секретов.
 *
 * Запускается вручную: создаёт временный профиль, кладёт настройки с паролем
 * открытым текстом и проверяет, что после запуска плагина пароль оказался в
 * хранилище, а файл настроек его больше не содержит.
 */
import fs from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = await mkdtemp(join(tmpdir(), 'dsh-secret-'))
process.env.DSH_HOME = home
fs.mkdirSync(join(home, 'dsh-sync'), { recursive: true })

const configPath = join(home, 'dsh-sync.json')
fs.writeFileSync(configPath, JSON.stringify({
  version: 1,
  backend: 'git',
  remote: 'https://github.com/example/repo.git',
  repoDir: join(home, 'dsh-sync', 'repo'),
  branch: 'main',
  webdavPassword: 'старый-пароль',
  projects: { harness: { path: home } },
  secondary: {
    enabled: true,
    backend: 'webdav',
    repoDir: join(home, 'dsh-sync', 'webdav-cache'),
    webdavLogin: 'narzik1989',
    webdavPassword: 'пароль-резерва',
    webdavPath: 'dsh-sync',
  },
}, null, 2) + '\n', 'utf8')

/** Хранилище секретов в памяти. */
const store = new Map()
const credentials = {
  async set(key, value) { store.set(key, value) },
  async resolve(key) { return store.has(key) ? { value: store.get(key), source: 'stored' } : undefined },
  async unset(key) { store.delete(key) },
  async describe(key) { return { configured: store.has(key), writable: true } },
}

const routes = new Map()
const ctx = {
  effect: (fn) => fn(),
  connection: { fetch: { register: (route) => routes.set(route.path, route) } },
  tools: { register: () => {} },
  get: (name) => (name === 'credentials' ? credentials : undefined),
}

const { apply } = await import('file:///E:/DeepSeek%20Harness/plugins/dsh-sessions/index.js')
apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 600))

const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const checks = []
checks.push(['пароль основного хранилища убран из файла', saved.webdavPassword === undefined])
checks.push(['пароль резерва убран из файла', saved.secondary?.webdavPassword === undefined])
checks.push(['в настройках осталась отметка', saved.secondary?.passwordStored === true])
checks.push(['секрет записан в хранилище', store.get('DSH_SYNC_WEBDAV_PASSWORD') === 'пароль-резерва'])
checks.push(['кеш резерва сохранён', saved.secondary?.repoDir?.endsWith('webdav-cache') === true])

// Сохранение через маршрут: новый пароль тоже не должен попасть в файл.
const saveRoute = routes.get('/api/dsh-sync/config')
const response = await saveRoute.fetch(new Request('http://local/api', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ secondaryBackend: 'webdav', secondaryLogin: 'narzik1989', secondaryPassword: 'новый-пароль', projectId: 'harness', projectPath: home }),
}))
const result = await response.json()
const afterSave = JSON.parse(fs.readFileSync(configPath, 'utf8'))
checks.push(['сохранение прошло', result.ok === true])
checks.push(['новый пароль не попал в файл', afterSave.secondary?.webdavPassword === undefined])
checks.push(['новый пароль в хранилище', store.get('DSH_SYNC_WEBDAV_PASSWORD') === 'новый-пароль'])

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ок  ' : 'НЕТ '} ${name}`)
  if (!ok) failed += 1
}
console.log(failed === 0 ? '\nсекреты: OK' : `\nсекреты: ${failed} проблем`)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
