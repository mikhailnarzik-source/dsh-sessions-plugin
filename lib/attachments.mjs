/**
 * Вложения DSH: `attachments/v1/{objects,file-objects,files}` — объекты,
 * адресуемые по sha256, поэтому копируются только недостающие файлы и никогда
 * не перезаписываются. `tmp` и `request-images` (кеш запросов) не синхронизируются.
 */
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const SYNCED_DIRS = ['objects', 'file-objects', 'files']

/** Сколько дней вложения ездят в облако. 0 — хранить все. */
export const DEFAULT_ATTACHMENTS_RETENTION_DAYS = 30

/** Порог по времени: файлы старше него в облако не отправляются. */
export function attachmentCutoff(retentionDays = DEFAULT_ATTACHMENTS_RETENTION_DAYS, now = Date.now()) {
  const days = Number(retentionDays)
  if (!Number.isFinite(days) || days <= 0) return 0
  return now - days * 24 * 60 * 60 * 1000
}

async function isOlderThan(absolute, cutoff) {
  if (cutoff <= 0) return false
  try {
    return (await stat(absolute)).mtimeMs < cutoff
  } catch {
    return false
  }
}


async function walk(dir, base, out) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) await walk(absolute, base, out)
    else if (entry.isFile()) out.push({ absolute, rel: relative(base, absolute).split(sep).join('/') })
  }
}

async function collect(root) {
  const files = []
  for (const name of SYNCED_DIRS) await walk(join(root, name), root, files)
  return files
}

async function copyMissing(source, target) {
  if (existsSync(target)) return false
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  return true
}

/** Локальные вложения → зеркало. Возвращает статистику. */
export async function pushAttachments({ home, repoDir, retentionDays = DEFAULT_ATTACHMENTS_RETENTION_DAYS }) {
  const source = join(home, 'attachments', 'v1')
  if (!existsSync(source)) return { added: 0, skipped: 0, bytes: 0, skippedOld: 0, pruned: 0 }
  const cutoff = attachmentCutoff(retentionDays)
  // Старые вложения не держим в облаке: сначала убираем их из зеркала,
  // затем не отправляем заново (дома копии остаются).
  const pruned = await pruneMirrorAttachments({ home, repoDir, retentionDays })
  const files = await collect(source)
  let added = 0
  let bytes = 0
  let skippedOld = 0
  for (const file of files) {
    if (await isOlderThan(file.absolute, cutoff)) {
      skippedOld += 1
      continue
    }
    const target = join(repoDir, 'attachments', ...file.rel.split('/'))
    if (await copyMissing(file.absolute, target)) {
      added += 1
      bytes += (await stat(file.absolute)).size
    }
  }
  return { added, skipped: files.length - added - skippedOld, bytes, skippedOld, pruned: pruned.removed, prunedBytes: pruned.bytes, retentionDays }
}

/**
 * Убрать из зеркала вложения старше retentionDays. Возраст берётся по
 * локальному оригиналу (у копии в зеркале mtime — время копирования).
 * Локальные файлы не трогаем: чистим только облачную копию.
 */
export async function pruneMirrorAttachments({ home, repoDir, retentionDays = DEFAULT_ATTACHMENTS_RETENTION_DAYS, dryRun = false }) {
  const cutoff = attachmentCutoff(retentionDays)
  if (cutoff <= 0) return { removed: 0, bytes: 0 }
  const mirrorRoot = join(repoDir, 'attachments')
  if (!existsSync(mirrorRoot)) return { removed: 0, bytes: 0 }
  const files = await collect(mirrorRoot)
  let removed = 0
  let bytes = 0
  for (const file of files) {
    const local = join(home, 'attachments', 'v1', ...file.rel.split('/'))
    if (!existsSync(local)) continue
    if (!(await isOlderThan(local, cutoff))) continue
    const size = (await stat(file.absolute)).size
    removed += 1
    bytes += size
    if (!dryRun) await rm(file.absolute, { force: true })
  }
  return { removed, bytes }
}

/** Зеркало → локальные вложения (недостающие файлы). */
export async function pullAttachments({ home, repoDir }) {
  const mirror = join(repoDir, 'attachments')
  if (!existsSync(mirror)) return { restored: 0, skipped: 0 }
  const files = []
  await walk(mirror, mirror, files)
  const target = join(home, 'attachments', 'v1')
  let restored = 0
  for (const file of files) {
    if (await copyMissing(file.absolute, join(target, ...file.rel.split('/')))) restored += 1
  }
  return { restored, skipped: files.length - restored }
}

/**
 * Убрать вложения, на которые не ссылается ни одна оставшаяся сессия.
 *
 * Ссылки в логах выглядят как `"attachmentId":"sha256:<хеш>"`, а объекты лежат
 * под своими хешами. Найденное сначала уезжает в архив, только потом удаляется.
 *
 * @param references множество хешей, которые ещё нужны
 */
export async function pruneAttachments({ home, repoDir, references, dryRun = false }) {
  const roots = [
    { kind: 'local', dir: join(home, 'attachments', 'v1') },
    { kind: 'mirror', dir: join(repoDir, 'attachments') },
  ]
  const archive = join(home, 'dsh-sync', 'deleted-attachments', new Date().toISOString().replace(/[:.]/g, '-'))
  let removed = 0
  let kept = 0
  let bytes = 0

  for (const root of roots) {
    if (!existsSync(root.dir)) continue
    const files = []
    await walk(root.dir, root.dir, files)
    for (const file of files) {
      const name = file.rel.split('/').pop() ?? ''
      if (!/^[0-9a-f]{64}$/.test(name) || references.has(name)) {
        kept += 1
        continue
      }
      const size = (await stat(file.absolute)).size
      bytes += size
      removed += 1
      if (dryRun) continue
      try {
        const target = join(archive, root.kind, ...file.rel.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await copyFile(file.absolute, target)
      } catch {
        // архив не обязателен — файл всё равно удаляется
      }
      await rm(file.absolute, { force: true })
    }
  }

  return { removed, kept, bytes, archive: dryRun ? undefined : archive }
}
