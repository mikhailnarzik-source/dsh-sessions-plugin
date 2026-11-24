import { homedir } from 'node:os'
import { join } from 'node:path'
import { listLocalSessions } from './lib/store.mjs'
import { titleOfLog, resolveSessionTitle } from './lib/titles.mjs'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessions = await listLocalSessions(home)
const sorted = sessions.sort((a, b) => b.size - a.size).slice(0, 6)
for (const session of sorted) {
  const raw = await titleOfLog(session.path)
  const resolved = await resolveSessionTitle({ id: session.id, title: 'предварительное', path: session.path })
  console.log(session.id.slice(0, 20), '| log:', raw.slice(0, 50), '| resolved:', resolved.title.slice(0, 50), '| source:', resolved.titleSource)
}
