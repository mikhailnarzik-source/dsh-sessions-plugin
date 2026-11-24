import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { listLocalSessions } from './lib/store.mjs'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessions = await listLocalSessions(home)
const sorted = sessions.sort((a, b) => b.size - a.size).slice(0, 4)
for (const session of sorted) {
  const bytes = await readFile(session.path)
  // Разбор кадров zstd: ищем все события session/title по всему логу.
  const titles = []
  let offset = 0
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const isMagic = (at) => magic.every((value, index) => bytes[at + index] === value)
  let frames = 0
  while (offset + 4 <= bytes.length && frames < 400) {
    let end = -1
    for (let index = offset + 4; index + 4 <= bytes.length; index += 1) {
      if (isMagic(index)) { end = index; break }
    }
    const frameEnd = end === -1 ? bytes.length : end
    let text = ''
    try { text = zstdDecompressSync(bytes.subarray(offset, frameEnd)).toString('utf8') } catch { break }
    frames += 1
    for (const line of text.split('\n')) {
      if (!line.includes('session/title')) continue
      try {
        const event = JSON.parse(line)
        if (event?.type === 'session/title' && typeof event?.data?.title === 'string') titles.push(event.data.title)
      } catch {}
    }
    if (end === -1) break
    offset = end
  }
  console.log(session.id, 'размер', Math.round(session.size / 1024), 'КБ', 'кадров', frames, 'title-событий', titles.length)
  for (const title of titles.slice(0, 5)) console.log('   ', title.slice(0, 80))
  if (titles.length > 5) console.log('    ... последний:', titles.at(-1).slice(0, 80))
}
