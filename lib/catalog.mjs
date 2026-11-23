/**
 * «Каталог» зеркала: делает резервную копию понятной человеку.
 *
 * Рядом с каждым логом кладётся `session.json` (название, даты, размер,
 * вложения), в папке проекта — `index.md` со списком сессий, в корне зеркала —
 * `README.md` с описанием структуры и инструкцией по восстановлению вручную.
 * Всё это обычные текстовые файлы, движок их не читает и не ломается от них.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame, frameSlices } from './frames.mjs'

const LOG_NAME = 'session.v4.jsonl.zstd'

const README_LINES = [
  '# Резервная копия сессий DeepSeek Harness',
  '',
  'Эта папка — копия истории работы. Её можно читать и восстанавливать вручную,',
  'без плагина.',
  '',
  '## Что где лежит',
  '',
  '```',
  'sessions/<проект>/<session-идентификатор>/session.v4.jsonl.zstd   сам лог сессии',
  'sessions/<проект>/<session-идентификатор>/session.json            описание сессии',
  'sessions/<проект>/index.md                                        список сессий проекта',
  'sessions/<проект>/_deleted/<session-идентификатор>/               карантин удалённых (30 дней)',
  'attachments/objects/<xx>/<sha256>                                  файлы и картинки из чата',
  'attachments/README.md                                              какие файлы к каким сессиям',
  'projects.json                                                      проекты и пути на устройствах',
  'workspace.json                                                     рабочие пространства и сессии в них',
  'profile/cordis.patch.yml                                          тема, язык, шрифт, MCP (без путей)',
  'profile/bundles.json                                               включённые плагины профиля',
  'profile/settings/<плагин>.json                                    настройки плагинов по белому списку',
  'profile/conflicts.json                                             журнал конфликтов настройек',
  'tombstones.json                                                    какие сессии удалены, когда, кем и почему',
  '```',
  '',
  '- **Папка проекта** (например `sessions/harness`) — это один проект (рабочая',
  '  папка). Название — идентификатор из настроек плагина; человеческое название',
  '  и пути указаны в `projects.json`.',
  '- **Папка сессии** — один диалог. Внутри два файла: сам лог и `session.json`',
  '  с названием, датой, размером и списком вложений.',
  '- **Лог** — двоичный поток zstd с JSON-событиями; так его пишет сам DSH.',
  '- **Файлы вложений** адресуются по содержимому (sha256), поэтому один и тот же',
  '  файл хранится один раз, сколько бы сессий его ни использовало.',
  '- **Профиль** — переносимая часть настроек DSH. Пути заменены на `${HOME}` и',
  '  `${DSH_HOME}`, секреты и машинные поля сюда не попадают.',
  '- **Рабочие пространства** — привязка сессий к папкам проекта. Глобальные',
  '  поля DSH (закреплённые, архив, пространство по умолчанию) не переносятся.',
  '',
  '## Как восстановить вручную',
  '',
  '1. Скопировать папку нужной сессии в каталог сессий DSH:',
  '   `%USERPROFILE%/.dsh/sessions/<папка-проекта>/`',
  '   (какая папка соответствует вашему проекту — видно в `projects.json`).',
  '2. Запустить DSH — сессия появится в списке.',
  '3. Вложения: скопировать содержимое `attachments/objects` в',
  '   `%USERPROFILE%/.dsh/attachments/v1/objects/`.',
  '',
  'Удалённая сессия лежит в `sessions/<проект>/_deleted/<id>/`. Чтобы вернуть её',
  'вручную: перенести папку обратно в `sessions/<проект>/<id>/`, удалить в ней',
  '`deleted-at.json` и убрать запись об этой сессии из `tombstones.json`',
  '(`reason` и `by` подскажут, когда, кем и почему она была удалена).',
  '',
  '## Как восстановить автоматически',
  '',
  'Установить плагин `dsh-sync` и указать этот репозиторий как зеркало — он',
  'привезёт сессии сам.',
  '',
]

const README = README_LINES.join('\n')

/** Текст пользовательского сообщения: content — массив блоков. */
function messageText(event) {
  const content = event.data?.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join(' ')
  }
  if (typeof event.data?.text === 'string') return event.data.text
  return ''
}

/** Служебные вставки не годятся в название. */
function isServiceText(text) {
  return /^(Current runtime context|<system-reminder>|Time sampled|A skill is a reusable|Browser time zone|Tokens prefixed)/.test(text.trim())
}

/** Короткое описание сессии: название, число событий, дата. */
function describeSession(bytes) {
  const slices = frameSlices(bytes)
  let header = null
  let title = ''
  let events = 0

  for (let index = 0; index < slices.length; index++) {
    let text
    try {
      text = decodeFrame(bytes, slices[index][0], slices[index][1])
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (header === null) {
        header = event
        continue
      }
      events += 1
      if (title === '' && event.type === 'user/message') {
        const value = messageText(event)
        if (typeof value === 'string' && value.trim() !== '' && !isServiceText(value)) {
          title = value.trim().replace(/\s+/g, ' ').slice(0, 80)
        }
      }
    }
    // Название почти всегда в первых событиях — дальше не разбираем.
    if (title !== '' && index > 4) break
  }

  // Точный пересчёт событий требует разбора всего лога: для человека хватает
  // числа кадров (обычно один кадр — одно событие).
  return { header, title: title === '' ? 'Без названия' : title, events: Math.max(events, slices.length - 1) }
}

/** Все хеши вложений, на которые ссылается лог. */
function referencedHashes(bytes) {
  const found = new Set()
  for (const [start, end] of frameSlices(bytes)) {
    let text
    try {
      text = decodeFrame(bytes, start, end)
    } catch {
      continue
    }
    for (const match of text.matchAll(/sha256:([0-9a-f]{64})/g)) found.add(match[1])
  }
  return found
}

async function writeIfChanged(path, content) {
  try {
    const current = await readFile(path, 'utf8')
    if (current === content) return false
  } catch {
    // файла нет — пишем
  }
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
  return true
}

/**
 * Обновить человекочитаемое описание зеркала.
 * @param repoDir каталог зеркала
 * @param sessionsByProject Map(projectId → [{ id, changed? }])
 */
export async function writeCatalog(repoDir, sessionsByProject, options = {}) {
  await writeIfChanged(join(repoDir, 'README.md'), README)

  const attachmentIndex = new Map()
  let written = 0

  for (const [projectId, entries] of sessionsByProject) {
    const projectDir = join(repoDir, 'sessions', projectId)
    if (!existsSync(projectDir)) continue

    const rows = []
    for (const entry of entries) {
      const sessionDir = join(projectDir, entry.id)
      if (!existsSync(sessionDir)) continue
      const logPath = join(sessionDir, LOG_NAME)
      if (!existsSync(logPath)) continue
      const sidecarPath = join(sessionDir, 'session.json')

      // Неизменившуюся сессию не разбираем заново: берём готовое описание.
      if (entry.changed !== true && existsSync(sidecarPath)) {
        try {
          const saved = JSON.parse(await readFile(sidecarPath, 'utf8'))
          for (const item of saved.attachments ?? []) {
            if (!attachmentIndex.has(item.sha256)) attachmentIndex.set(item.sha256, [])
            attachmentIndex.get(item.sha256).push(entry.id)
          }
          // Старые описания не знают про родителя: читаем заголовок один раз,
          // чтобы достроить связи, и перезаписываем описания с этим полем.
          if (typeof saved.parent !== 'string') {
            let parent = ''
            try {
              const info = describeSession(await readFile(logPath))
              parent = typeof info.header?.parentSession === 'string' ? info.header.parentSession : ''
            } catch {
              // лог не читается — останется без родителя
            }
            rows.push({ ...saved, dir: entry.id, parent, sidecarPath })
            continue
          }
          rows.push({
            ...saved,
            dir: entry.id,
            parent: saved.parent,
            sidecarPath,
            savedChildren: Array.isArray(saved.children) ? saved.children : undefined,
          })
          continue
        } catch {
          // битый sidecar перезапишем ниже
        }
      }

      const bytes = entry.bytes ?? await readFile(logPath)
      const info = describeSession(bytes)
      const size = (await stat(logPath)).size
      const hashes = referencedHashes(bytes)
      for (const hash of hashes) {
        if (!attachmentIndex.has(hash)) attachmentIndex.set(hash, [])
        attachmentIndex.get(hash).push(entry.id)
      }

      const createdAt = typeof info.header?.createdAt === 'number' ? new Date(info.header.createdAt).toISOString() : ''
      const sidecar = {
        id: entry.id,
        title: entry.title ?? info.title,
        createdAt,
        events: info.events,
        sizeBytes: size,
        project: projectId,
        path: options.projectPath ?? '',
        attachments: [...hashes].map(hash => ({
          sha256: hash,
          storedAt: `attachments/objects/${hash.slice(0, 2)}/${hash}`,
        })),
        note: 'Лог сессии лежит рядом: session.v4.jsonl.zstd. Восстановление — см. README.md в корне зеркала.',
      }
      written += 1

      rows.push({
        ...sidecar,
        dir: entry.id,
        parent: typeof info.header?.parentSession === 'string' ? info.header.parentSession : '',
        sidecarPath,
      })
    }

    // Родственные связи субагентов: у сессии указан родитель, у родителя —
    // список детей. Считается по заголовкам логов этого же проекта.
    for (const row of rows) {
      row.children = rows
        .filter(other => other.parent === row.id)
        .map(other => other.id)
        .sort()
      const childrenChanged = JSON.stringify(row.children) !== JSON.stringify(row.savedChildren ?? [])
      if (row.savedChildren !== undefined && !childrenChanged) continue // менять нечего
      const { savedChildren, sidecarPath, dir, bytes: _unused, ...sidecarData } = row
      sidecarData.parent = row.parent ?? ''
      sidecarData.children = row.children
      await writeFile(sidecarPath, `${JSON.stringify(sidecarData, null, 2)}\n`, 'utf8')
    }

    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    const lines = [
      `# Проект «${projectId}»`,
      '',
      `Путь на этом компьютере: ${options.projectPath ?? 'не указан'}`,
      `Сессий в копии: ${rows.length}`,
      '',
      '| Дата | Название | Блоков | Размер | Папка |',
      '|---|---|---|---|---|',
    ]
    for (const row of rows) {
      const title = String(row.title ?? '').replace(/\|/g, '\\|')
      const sizeMb = (Number(row.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)
      lines.push(`| ${String(row.createdAt ?? '').slice(0, 16).replace('T', ' ')} | ${title} | ${row.events ?? 0} | ${sizeMb} МБ | ${row.dir} |`)
    }
    lines.push('', 'Описание каждой сессии — в её папке, файл `session.json`.', '')
    await writeIfChanged(join(projectDir, 'index.md'), lines.join('\n'))
  }

  const attachmentLines = [
    '# Вложения',
    '',
    'Файлы хранятся по адресу содержимого: `attachments/objects/<первые два символа>/<sha256>`.',
    'Ниже — какие вложения к каким сессиям относятся.',
    '',
    '| sha256 | сессии |',
    '|---|---|',
  ]
  for (const [hash, sessions] of [...attachmentIndex.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    attachmentLines.push(`| ${hash} | ${[...new Set(sessions)].join(', ')} |`)
  }
  attachmentLines.push('')
  await writeIfChanged(join(repoDir, 'attachments', 'README.md'), attachmentLines.join('\n'))

  return { described: written }
}
