import { homedir } from 'node:os'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { listLocalSessions } from './lib/store.mjs'
import { resolveSessionTitle } from './lib/titles.mjs'
import { loadConfig } from './lib/config.mjs'
import { collectDuplicateGroups } from './lib/sync.mjs'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const config = await loadConfig(home)
const sessions = await listLocalSessions(home)
const rows = []
for (const session of sessions) {
  const info = await stat(session.path)
  const title = await resolveSessionTitle({ id: session.id, title: '', path: session.path })
  rows.push({ id: session.id, title: title.title, sizeMb: Math.round(session.size / 1024 / 1024 * 10) / 10, mtime: info.mtime.toISOString().slice(0, 16) })
}
rows.sort((a, b) => b.sizeMb - a.sizeMb)
console.log('локальных сессий:', rows.length)
for (const row of rows) console.log(String(row.sizeMb).padStart(6), 'МБ', row.mtime, row.id.slice(0, 26).padEnd(28), row.title.slice(0, 60))
const scan = await collectDuplicateGroups({ home, config })
console.log('дубли: групп', (scan.groups ?? []).length)
for (const group of scan.groups ?? []) {
  console.log(' группа match=', group.match, 'canonical=', group.canonicalId, 'копий:', (group.sessions ?? []).length)
  for (const s of group.sessions ?? []) console.log('   ', s.id.slice(0, 26).padEnd(28), 'side=' + (s.sides?.join('+') ?? s.side), Math.round((s.sizeBytes ?? 0) / 1048576 * 10) / 10 + 'МБ', 'canonical=' + (s.canonical === true))
}
