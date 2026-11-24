import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { listLocalSessions } from './lib/store.mjs'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessions = await listLocalSessions(home)
for (const session of sessions.sort((a, b) => b.size - a.size).slice(0, 5)) {
  const bytes = await readFile(session.path)
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const isMagic = (at) => magic.every((value, index) => bytes[at + index] === value)
  const hits = []
  let offset = 0
  while (offset + 4 <= bytes.length) {
    let end = -1
    for (let index = offset + 4; index + 4 <= bytes.length; index += 1) {
      if (isMagic(index)) { end = index; break }
    }
    const frameEnd = end === -1 ? bytes.length : end
    let text = ''
    try { text = zstdDecompressSync(bytes.subarray(offset, frameEnd)).toString('utf8') } catch { break }
    if (text.includes('session/title')) {
      for (const line of text.split('\n')) {
        try {
          const event = JSON.parse(line)
          if (event?.type === 'session/title') hits.push({ offset, title: event.data?.title })
        } catch {}
      }
    }
    if (end === -1) break
    offset = end
  }
  console.log(session.id.slice(0, 20), 'размер', Math.round(session.size / 1024), 'КБ; title-события:', hits.map((h) => Math.round(h.offset / 1024) + 'КБ ' + String(h.title).slice(0, 40)).join(' | '))
}
