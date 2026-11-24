/**
 * M1-A: идентичность сессий, дедупликация и детерминированный рейтинг.
 *
 * Проверяем три вещи:
 * - D1: contentHash (sha256 нормализованного лога) и lineageKey (sha1 линии)
 *   попадают в session.json при записи и лениво достраиваются в старых
 *   описаниях, не переписывая сами логи;
 * - D2: копия той же сессии с другим id находится по хешу, дедупликация не
 *   путает её с независимой сессией, а план «Проверить» показывает седьмую
 *   корзину «дубли» (по contentHash+lineageKey и по паре events+bytes ±1%);
 * - D4: рейтинг кандидатов одинаков на двух «устройствах», канонический id —
 *   id с детьми (иначе победителя), проигравшие получают reason superseded.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  DUPLICATE_SIZE_TOLERANCE,
  computeContentHash,
  computeLineageKey,
  computeSessionIdentity,
  duplicateGroups,
  findContentDuplicate,
  findDuplicate,
  findDuplicateAmongLogs,
  hasSessionIdentity,
  identityIndexOf,
  importDecision,
  normalizeTitleForIdentity,
  readSessionSidecar,
  writeCatalog,
} from '../lib/catalog.mjs'
import { defaultConfig, saveConfig, canonicalCwd } from '../lib/config.mjs'
import { candidateRankKey, chooseCanonical, rankCandidates, SUPERSEDED_REASON } from '../lib/deletions.mjs'
import { readHeader, rewriteHeader } from '../lib/format.mjs'
import { PLAN_BUCKETS, buildPlan, emptyPlanCounts } from '../lib/plan.mjs'
import { repairLog } from '../lib/repair.mjs'
import { localSessionDir } from '../lib/store.mjs'

// --- общие помощники -------------------------------------------------------

const PROJECT = 'alpha'
const PROJECT_PATH = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
const OTHER_PATH = process.platform === 'win32' ? 'D:\\archive\\alpha' : '/archive/alpha'
/** Фиксированное время создания: копии должны совпадать, независимые — нет. */
const CREATED_AT = Date.UTC(2026, 10, 20, 10, 0, 0)

const LOG_NAME = 'session.v4.jsonl.zstd'

function frameOf(event) {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))
}

function makeLog(header, events = []) {
  return Buffer.concat([frameOf(header), ...events.map(frameOf)])
}

function headerFor(id, options = {}) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: options.createdAt ?? CREATED_AT,
    cwd: options.cwd ?? PROJECT_PATH,
    isSeeded: false,
    delegationDepth: 0,
  }
}

function titleEvent(title, seq = 0) {
  return { type: 'session/title', seq, time: CREATED_AT + 1000, data: { title } }
}

function userEvent(text, seq = 1) {
  return { type: 'user/message', seq, time: CREATED_AT + 2000, data: { content: [{ type: 'text', text }] } }
}

/** Событие, которое ссылается на id своей же сессии (так пишет DSH). */
function deliveryEvent(id, seq = 2) {
  return {
    type: 'session-log-deepseek/delivery-accepted',
    seq,
    time: CREATED_AT + 3000,
    data: { sessionId: id, sessionFormatVersion: 4, throughSeq: seq - 1 },
  }
}

/** Копия лога: другой id и другой путь в заголовке, хвост байт-в-байт. */
function copyLog(log, patch) {
  const parsed = readHeader(log)
  return rewriteHeader(log, { ...parsed.header, ...patch }, parsed.frameEnd)
}

/** Рабочий диалог: название, сообщение, путь в событии и ссылка на свой id. */
function dialogLog(id, options = {}) {
  const header = headerFor(id, options)
  return makeLog(header, [
    titleEvent(options.title ?? 'Рабочий диалог'),
    userEvent(options.message ?? 'Привет, покажи файлы'),
    {
      type: 'tool/result',
      seq: 3,
      time: CREATED_AT + 2500,
      data: { text: `Прочитал ${(options.cwd ?? PROJECT_PATH)}\\AGENTS.md` },
    },
    deliveryEvent(id, 4),
  ])
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Слепок каталога: пути и sha256 файлов (план не должен ничего менять). */
async function snapshotTree(dir) {
  const entries = []
  const walk = async (current) => {
    let items
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of items) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const content = await readFile(full)
      entries.push([full, sha256(content), content.length])
    }
  }
  await walk(dir)
  return entries.sort((left, right) => left[0].localeCompare(right[0]))
}

async function makeEnv() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-m1-'))
  const home = join(root, 'home')
  const repoDir = join(root, 'mirror')
  await mkdir(home, { recursive: true })
  await mkdir(repoDir, { recursive: true })
  const config = { ...defaultConfig(home), backend: 'folder', deviceId: 'device-a', repoDir }
  config.projects = { [PROJECT]: { path: PROJECT_PATH, title: PROJECT } }
  await saveConfig(home, config)
  return { root, home, repoDir, config }
}

async function writeLocalSession(home, id, bytes) {
  const dir = localSessionDir(home, PROJECT_PATH, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG_NAME), bytes)
  return dir
}

async function writeMirrorSession(repoDir, id, bytes) {
  const dir = join(repoDir, 'sessions', PROJECT, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, LOG_NAME), bytes)
  return dir
}

// --- D1: contentHash -------------------------------------------------------

test('D1: contentHash стабилен при переезде и repairLog, но ловит другой лог', () => {
  const id = `session-${randomUUID()}`
  const copyId = `session-${randomUUID()}`
  const original = dialogLog(id)
  // «Переезд»: id и путь в заголовке другие, хвост тот же.
  const moved = copyLog(original, { id: copyId, cwd: OTHER_PATH })
  // repairLog переписывает sessionId внутри событий — содержимое то же.
  const repaired = repairLog(copyLog(original, { id: copyId, cwd: OTHER_PATH }))
  assert.equal(repaired.changed > 0, true, 'repairLog действительно правит события')

  const hash = computeContentHash(original)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(computeContentHash(moved), hash, 'переезд и новый id не меняют хеш')
  assert.equal(computeContentHash(repaired.bytes), hash, 'переписанный sessionId не меняет хеш')
  assert.equal(hash, computeContentHash(original), 'хеш детерминирован')

  // Порядок кадров сохраняется: перестановка событий — уже другой лог.
  const swapped = makeLog(headerFor(id), [
    userEvent('Второе'),
    titleEvent('Рабочий диалог'),
    deliveryEvent(id),
  ])
  assert.notEqual(computeContentHash(swapped), hash, 'порядок событий важен')
  assert.notEqual(computeContentHash(dialogLog(`session-${randomUUID()}`, { title: 'Другой' })), hash,
    'другой текст — другой хеш')
})

// --- D1: lineageKey --------------------------------------------------------

test('D1: lineageKey — одна линия при переезде, разные у независимых сессий', () => {
  const base = computeLineageKey({ createdAt: CREATED_AT, title: '  Рабочий   ДИАЛОГ ', cwd: PROJECT_PATH, projectId: PROJECT })
  assert.match(base, /^[0-9a-f]{40}$/)
  // Название нормализуется (регистр, лишние пробелы), путь проекта — из projectId.
  assert.equal(
    computeLineageKey({ createdAt: new Date(CREATED_AT).toISOString(), title: 'рабочий диалог', cwd: OTHER_PATH, projectId: PROJECT }),
    base,
    'копия на другом пути — та же линия',
  )
  assert.equal(normalizeTitleForIdentity('  A \n B  '), 'a b')
  assert.notEqual(computeLineageKey({ createdAt: CREATED_AT + 1, title: 'Рабочий диалог', cwd: PROJECT_PATH, projectId: PROJECT }), base,
    'другое время создания — другая линия')
  assert.notEqual(computeLineageKey({ createdAt: CREATED_AT, title: 'Другое название', cwd: PROJECT_PATH, projectId: PROJECT }), base,
    'другое название — другая линия')
  assert.notEqual(computeLineageKey({ createdAt: CREATED_AT, title: 'Рабочий диалог', cwd: PROJECT_PATH, projectId: 'beta' }), base,
    'другой проект — другая линия')
  // Идентичность по логу: title берётся из первого сообщения.
  const identity = computeSessionIdentity({ bytes: dialogLog(`session-${randomUUID()}`), projectId: PROJECT })
  assert.equal(identity.lineageKey, computeLineageKey({ createdAt: CREATED_AT, title: 'Привет, покажи файлы', cwd: PROJECT_PATH, projectId: PROJECT }))
})

// --- D1: session.json ------------------------------------------------------

test('D1: writeCatalog пишет contentHash/lineageKey в session.json и не трогает лог', async () => {
  const env = await makeEnv()
  try {
    const id = `session-${randomUUID()}`
    const log = dialogLog(id)
    const dir = await writeMirrorSession(env.repoDir, id, log)
    const logHash = sha256(log)

    const written = await writeCatalog(env.repoDir, new Map([[PROJECT, [{ id, changed: true }]]]), { projectPath: PROJECT_PATH })
    assert.equal(written.described, 1)

    const sidecar = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    const expected = computeSessionIdentity({ bytes: log, projectId: PROJECT })
    assert.equal(sidecar.contentHash, expected.contentHash, 'contentHash в session.json')
    assert.equal(sidecar.lineageKey, expected.lineageKey, 'lineageKey в session.json')
    assert.equal(sidecar.events, 4, 'точное число событий')
    assert.equal(Number.isFinite(Date.parse(sidecar.lastEventAt)), true, 'lastEventAt для рейтинга')
    assert.equal(hasSessionIdentity(sidecar), true)
    assert.equal(sha256(await readFile(join(dir, LOG_NAME))), logHash, 'лог не переписан')

    // Копия с другим id/путём получает тот же contentHash и lineageKey.
    const copyId = `session-${randomUUID()}`
    const copyDir = await writeMirrorSession(env.repoDir, copyId, copyLog(log, { id: copyId, cwd: OTHER_PATH }))
    await writeCatalog(env.repoDir, new Map([[PROJECT, [{ id: copyId, changed: true }]]]), { projectPath: PROJECT_PATH })
    const copySidecar = JSON.parse(await readFile(join(copyDir, 'session.json'), 'utf8'))
    assert.equal(copySidecar.contentHash, sidecar.contentHash)
    assert.equal(copySidecar.lineageKey, sidecar.lineageKey)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('D1: старый session.json мигрирует лениво — хеши достраиваются, лог не меняется', async () => {
  const env = await makeEnv()
  try {
    const id = `session-${randomUUID()}`
    const log = dialogLog(id)
    const dir = await writeMirrorSession(env.repoDir, id, log)
    await writeCatalog(env.repoDir, new Map([[PROJECT, [{ id, changed: true }]]]), { projectPath: PROJECT_PATH })
    const sidecarPath = join(dir, 'session.json')
    const full = JSON.parse(await readFile(sidecarPath, 'utf8'))
    // Старое описание: без идентичности, но со связями.
    const old = { ...full }
    delete old.contentHash
    delete old.lineageKey
    delete old.lastEventAt
    await writeFile(sidecarPath, `${JSON.stringify(old, null, 2)}\n`, 'utf8')
    const logHash = sha256(await readFile(join(dir, LOG_NAME)))

    // Чтение без записи: идентичность возвращается, файл на диске не меняется.
    const before = await readFile(sidecarPath, 'utf8')
    const read = await readSessionSidecar(dir, { projectId: PROJECT })
    assert.equal(read.migrated, true, 'миграция помечена')
    assert.equal(hasSessionIdentity(read.identity), true)
    assert.equal(read.identity.contentHash, computeSessionIdentity({ bytes: log, projectId: PROJECT }).contentHash)
    assert.equal(await readFile(sidecarPath, 'utf8'), before, 'чтение само по себе ничего не пишет')

    // Следующая запись каталога достраивает поля в session.json.
    await writeCatalog(env.repoDir, new Map([[PROJECT, [{ id, changed: false }]]]), { projectPath: PROJECT_PATH })
    const migrated = JSON.parse(await readFile(sidecarPath, 'utf8'))
    assert.equal(hasSessionIdentity(migrated), true, 'session.json мигрирован')
    assert.equal(migrated.contentHash, full.contentHash)
    assert.equal(migrated.lineageKey, full.lineageKey)
    assert.equal(sha256(await readFile(join(dir, LOG_NAME))), logHash, 'лог не переписан при миграции')
    // И повторная запись уже ничего не меняет.
    const snapshot = await readFile(sidecarPath, 'utf8')
    await writeCatalog(env.repoDir, new Map([[PROJECT, [{ id, changed: false }]]]), { projectPath: PROJECT_PATH })
    assert.equal(await readFile(sidecarPath, 'utf8'), snapshot, 'идемпотентно')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- D2: дедупликация импорта ---------------------------------------------

test('D2: findDuplicate находит копию по contentHash/lineageKey и молчит для чужой сессии', () => {
  const first = `session-${randomUUID()}`
  const second = `session-${randomUUID()}`
  const third = `session-${randomUUID()}`
  const original = dialogLog(first)
  const copy = copyLog(dialogLog(first), { id: second, cwd: OTHER_PATH })
  const other = dialogLog(third, { title: 'Совсем другое', message: 'Расскажи про другое' })

  const identities = [original, copy, other].map((bytes, index) => {
    const id = [first, second, third][index]
    return { id, ...computeSessionIdentity({ bytes, projectId: PROJECT }) }
  })
  const index = identityIndexOf(identities)
  assert.equal(index.byContentHash.size <= 2, true)

  const viaLineage = findDuplicate(index, identities[1])
  assert.equal(viaLineage?.id, first, 'копия найдена по lineageKey')
  assert.equal(viaLineage?.match, 'lineageKey')
  const viaContent = findContentDuplicate(index, identities[1])
  assert.equal(viaContent?.id, first)
  assert.equal(findDuplicate(index, identities[2]), undefined, 'другой диалог — не копия')
  // Сам себя не находим: иначе импорт «дедуплицировал» бы каждую сессию.
  const soloIndex = identityIndexOf([identities[0]])
  assert.equal(findContentDuplicate(soloIndex, identities[0]), undefined)
  assert.equal(findDuplicate(soloIndex, identities[0]), undefined)

  // Готовое решение для импорта/pull: копию не создавать, причина duplicate.
  const skip = importDecision({ index, identity: identities[1] })
  assert.equal(skip.action, 'skip')
  assert.equal(skip.reason, 'duplicate')
  assert.equal(skip.duplicateId, first)
  assert.equal(skip.match, 'lineageKey')
  assert.deepEqual(importDecision({ index, identity: identities[2] }), { action: 'import', reason: '' })
  assert.deepEqual(importDecision({}), { action: 'import', reason: '' })

  // Импорт по логам: копия уже лежит локально — не создаём вторую.
  const remoteLog = copyLog(dialogLog(first), { id: second, cwd: OTHER_PATH })
  const among = findDuplicateAmongLogs({
    sessions: [{ id: first, bytes: dialogLog(first) }],
    bytes: remoteLog,
    projectId: PROJECT,
    id: second,
  })
  assert.equal(among?.id, first)
  assert.equal(among?.match, 'lineageKey')
  // Уже посчитанная идентичность экономит разбор лога.
  const precomputed = findDuplicateAmongLogs({
    sessions: [{ id: first, bytes: dialogLog(first) }],
    identity: computeSessionIdentity({ bytes: remoteLog, projectId: PROJECT }),
    projectId: PROJECT,
    id: second,
  })
  assert.equal(precomputed?.id, first)
  assert.equal(findDuplicateAmongLogs({
    sessions: [{ id: third, bytes: dialogLog(third, { message: 'Другое', title: 'Другое' }) }],
    bytes: remoteLog,
    projectId: PROJECT,
    id: second,
  }), undefined, 'чужой лог не считается копией')
  // Пустые независимые сессии с одинаковым содержимым не схлопываются:
  // их линии разные (разное createdAt), поэтому findDuplicate молчит.
  const emptyA = `session-${randomUUID()}`
  const emptyB = `session-${randomUUID()}`
  const emptyIndex = identityIndexOf([
    { id: emptyA, ...computeSessionIdentity({ bytes: makeLog(headerFor(emptyA)), projectId: PROJECT }) },
    { id: emptyB, ...computeSessionIdentity({ bytes: makeLog(headerFor(emptyB, { createdAt: CREATED_AT + 5000 })), projectId: PROJECT }) },
  ])
  assert.equal(findDuplicate(emptyIndex, computeSessionIdentity({ bytes: makeLog(headerFor(emptyB, { createdAt: CREATED_AT + 5000 })), projectId: PROJECT })), undefined)
})

test('D2: duplicateGroups — contentHash для копий, events+bytes ±1% для старых зеркал', () => {
  const first = `session-${randomUUID()}`
  const second = `session-${randomUUID()}`
  const original = dialogLog(first)
  const copy = copyLog(dialogLog(first), { id: second, cwd: OTHER_PATH })
  const strong = duplicateGroups([
    { id: first, side: 'local', bytes: original, sizeBytes: original.length, createdAt: CREATED_AT },
    { id: second, side: 'mirror', bytes: copy, sizeBytes: copy.length, createdAt: CREATED_AT },
  ], { projectId: PROJECT })
  assert.equal(strong.length, 1)
  assert.equal(strong[0].match, 'contentHash')
  assert.deepEqual(strong[0].sessions.map(item => item.id).sort(), [first, second].sort())
  assert.equal(strong[0].sessions.every(item => item.side !== undefined), true, 'сторона копии известна')

  // Старое зеркало без хеша: одинаковые события и размер ±1% — кандидат в дубли.
  const weak = duplicateGroups([
    { id: 'session-old-1', events: 5, sizeBytes: 1000 },
    { id: 'session-old-2', events: 5, sizeBytes: 1005 },
  ])
  assert.equal(weak.length, 1)
  assert.equal(weak[0].match, 'events+bytes')
  // Размер отличается больше чем на 1% — уже не пара.
  assert.deepEqual(duplicateGroups([
    { id: 'session-old-1', events: 5, sizeBytes: 1000 },
    { id: 'session-old-2', events: 5, sizeBytes: 1020 },
  ]), [])
  assert.equal(DUPLICATE_SIZE_TOLERANCE, 0.01)
  assert.deepEqual(duplicateGroups([
    { id: 'session-old-1', events: 5, sizeBytes: 1000 },
    { id: 'session-old-2', events: 6, sizeBytes: 1000 },
  ]), [], 'разное число событий — не пара')

  // Ложное срабатывание: одинаковая длина лога, но разное содержимое.
  const different = makeLog(headerFor(`session-${randomUUID()}`), [titleEvent('Другое'), userEvent('Другое')])
  const sameShape = makeLog(headerFor(`session-${randomUUID()}`), [titleEvent('Другие'), userEvent('Другое')])
  assert.deepEqual(duplicateGroups([
    { id: 'session-x', bytes: different, sizeBytes: different.length, createdAt: CREATED_AT },
    { id: 'session-y', bytes: sameShape, sizeBytes: sameShape.length, createdAt: CREATED_AT },
  ], { projectId: PROJECT }), [], 'разное содержимое не дубль, даже если размер похож')
})

// --- D2: седьмая корзина плана --------------------------------------------

test('D2: план показывает седьмую корзину «дубли» и ничего не изменяет', async () => {
  const env = await makeEnv()
  try {
    assert.ok(PLAN_BUCKETS.includes('duplicates'), 'дубли — седьмая корзина')
    assert.equal(emptyPlanCounts().duplicates, 0)

    const first = `session-${randomUUID()}`
    const second = `session-${randomUUID()}`
    await writeLocalSession(env.home, first, dialogLog(first))
    // Та же сессия в том же проекте, но под другим id (копия/повторный импорт).
    await writeLocalSession(env.home, second, copyLog(dialogLog(first), { id: second }))

    const before = await snapshotTree(env.root)
    const plan = await buildPlan({ home: env.home, config: env.config })
    assert.deepEqual(await snapshotTree(env.root), before, 'план ничего не записал')

    assert.equal(plan.counts.duplicates, 1, 'одна лишняя копия')
    assert.ok(plan.sizes.duplicates > 0, 'размер корзины посчитан')
    assert.equal(plan.duplicateCount, plan.counts.duplicates)
    assert.equal(plan.buckets.duplicates.length, 1)
    const item = plan.buckets.duplicates[0]
    assert.equal(plan.duplicates.groups.length, 1)
    const group = plan.duplicates.groups[0]
    assert.equal(group.sessions.length, 2)
    const canonicalId = rankCandidates(group.sessions)[0].id
    assert.equal(item.canonicalId, canonicalId, 'канонический id — по детерминированному рейтингу')
    assert.equal(item.id, canonicalId === first ? second : first, 'в корзине — лишняя копия')
    assert.equal(item.match, 'contentHash')
    assert.equal(plan.duplicates.byContentHash, 1)
    assert.equal(group.sessions.filter(session => session.canonical).length, 1)
    assert.equal(plan.hasChanges, true, 'дубли — повод для проверки')
    assert.match(plan.message, /Дублей: 1/)
    // Копии остаются и в обычных корзинах: план ничего не склеивает.
    assert.equal(plan.counts.onlyLocal, 2)
    assert.deepEqual(plan.deletions, [], 'дубли не становятся удалениями')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('D2: план видит копию в зеркале под другим id и показывает несохранённую пару', async () => {
  const env = await makeEnv()
  try {
    const local = `session-${randomUUID()}`
    const cloud = `session-${randomUUID()}`
    await writeLocalSession(env.home, local, dialogLog(local))
    // Та же сессия приехала в зеркало под другим id (канонический путь).
    await writeMirrorSession(env.repoDir, cloud, copyLog(dialogLog(local), { id: cloud, cwd: canonicalCwd(PROJECT) }))

    const plan = await buildPlan({ home: env.home, config: env.config })
    assert.equal(plan.counts.duplicates, 1, 'одна лишняя копия')
    const item = plan.buckets.duplicates[0]
    assert.equal([local, cloud].includes(item.canonicalId), true)
    const group = plan.duplicates.groups[0]
    assert.deepEqual(group.sessions.map(session => session.id).sort(), [local, cloud].sort())
    assert.deepEqual(group.sessions.map(session => session.side).sort(), ['local', 'mirror'])
    assert.equal(plan.counts.onlyLocal, 1, 'копии остаются в своих корзинах')
    assert.equal(plan.counts.onlyCloud, 1)
    assert.deepEqual(plan.deletions, [])
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('D2: одинаковые сессии без копий не попадают в «дубли»', async () => {
  const env = await makeEnv()
  try {
    // Две независимые сессии с похожей формой, но разным содержимым и временем.
    const first = `session-${randomUUID()}`
    const second = `session-${randomUUID()}`
    await writeLocalSession(env.home, first, makeLog(headerFor(first), [userEvent('Первая сессия')]))
    await writeLocalSession(env.home, second, makeLog(headerFor(second, { createdAt: CREATED_AT + 60_000 }), [userEvent('Вторая сессия')]))
    const plan = await buildPlan({ home: env.home, config: env.config })
    assert.equal(plan.counts.duplicates, 0)
    assert.deepEqual(plan.buckets.duplicates, [])
    assert.equal(plan.duplicateCount, 0)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

// --- D4: детерминированный рейтинг ----------------------------------------

test('D4: rankCandidates — lastEventAt > events > bytes > children > createdAt < id <', () => {
  const order = (candidates, childrenById) => rankCandidates(candidates, childrenById).map(item => item.id)

  // lastEventAt важнее числа событий и размера.
  assert.deepEqual(order([
    { id: 'session-a', lastEventAt: 100, events: 50, bytes: 5000 },
    { id: 'session-b', lastEventAt: 200, events: 1, bytes: 10 },
  ]), ['session-b', 'session-a'])
  // При равном lastEventAt — больше событий.
  assert.deepEqual(order([
    { id: 'session-a', lastEventAt: 100, events: 2, bytes: 5000 },
    { id: 'session-b', lastEventAt: 100, events: 5, bytes: 10 },
  ]), ['session-b', 'session-a'])
  // Затем размер.
  assert.deepEqual(order([
    { id: 'session-a', lastEventAt: 100, events: 2, bytes: 5000 },
    { id: 'session-b', lastEventAt: 100, events: 2, bytes: 10 },
  ]), ['session-a', 'session-b'])
  // Затем дети: родитель главнее копии без детей.
  const childrenById = new Map([['session-a', ['session-child']]])
  assert.deepEqual(order([
    { id: 'session-a', lastEventAt: 100, events: 2, bytes: 500, children: [] },
    { id: 'session-b', lastEventAt: 100, events: 2, bytes: 500, children: [] },
  ], childrenById), ['session-a', 'session-b'])
  // Затем createdAt: раньше созданная — оригинал.
  assert.deepEqual(order([
    { id: 'session-b', lastEventAt: 100, events: 2, bytes: 500, createdAt: 200 },
    { id: 'session-a', lastEventAt: 100, events: 2, bytes: 500, createdAt: 100 },
  ]), ['session-a', 'session-b'])
  // Затем id: стабильный добор, чтобы порядок не зависел от обхода.
  assert.deepEqual(order([
    { id: 'session-b', lastEventAt: 100, events: 2, bytes: 500, createdAt: 100 },
    { id: 'session-a', lastEventAt: 100, events: 2, bytes: 500, createdAt: 100 },
  ]), ['session-a', 'session-b'])
  assert.deepEqual(candidateRankKey({ id: 'session-a', lastEventAt: '2026-11-20T10:00:00.000Z', sizeBytes: 7, children: ['x'] }), {
    lastEventAt: Date.parse('2026-11-20T10:00:00.000Z'),
    events: 0,
    bytes: 7,
    children: 1,
    createdAt: 0,
    id: 'session-a',
  })
})

test('D4: рейтинг одинаков на двух «устройствах» (порядок входа не важен)', () => {
  const candidates = [
    { id: 'session-b', lastEventAt: 300, events: 3, bytes: 900, children: [], createdAt: 100 },
    { id: 'session-a', lastEventAt: 300, events: 3, bytes: 900, children: [], createdAt: 100 },
    { id: 'session-c', lastEventAt: 500, events: 1, bytes: 100, children: [], createdAt: 500 },
    { id: 'session-d', lastEventAt: 300, events: 4, bytes: 100, children: [], createdAt: 200 },
  ]
  const childrenById = new Map([['session-b', ['session-child']]])
  const deviceA = rankCandidates(candidates, childrenById).map(item => item.id)
  const deviceB = rankCandidates([...candidates].reverse(), childrenById).map(item => item.id)
  assert.deepEqual(deviceA, deviceB, 'один и тот же порядок на двух устройствах')
  // session-b обгоняет session-a за счёт детей, session-d — за счёт событий.
  assert.deepEqual(deviceA, ['session-c', 'session-d', 'session-b', 'session-a'])
})

// --- D4: канонический id ---------------------------------------------------

test('D4: chooseCanonical берёт id с детьми, иначе id победителя', () => {
  const fresh = { id: 'session-fresh', lastEventAt: 500, events: 9, bytes: 900, createdAt: 100 }
  const parent = { id: 'session-parent', lastEventAt: 100, events: 2, bytes: 100, createdAt: 50 }
  const childrenById = new Map([['session-parent', ['session-child']]])
  const ranked = rankCandidates([fresh, parent], childrenById)
  assert.deepEqual(ranked.map(item => item.id), ['session-fresh', 'session-parent'], 'победитель — свежая копия')

  const chosen = chooseCanonical(ranked[0], ranked, { childrenById })
  assert.equal(chosen.winnerId, 'session-fresh')
  assert.equal(chosen.canonicalId, 'session-parent', 'канонический id — родитель с детьми')
  assert.equal(chosen.children, 1)
  assert.deepEqual(chosen.supersededIds, ['session-fresh'], 'проигравшая копия — superseded')
  assert.equal(chosen.superseded[0].reason, SUPERSEDED_REASON)
  assert.equal(chosen.superseded[0].reason, 'superseded')
  assert.equal(chosen.reason, 'superseded')

  // У победителя есть дети — канонический id его.
  const withChildren = chooseCanonical(ranked[0], ranked, { childrenById: new Map([['session-fresh', ['session-child']]]) })
  assert.equal(withChildren.canonicalId, 'session-fresh')
  assert.deepEqual(withChildren.supersededIds, ['session-parent'])
  // Форма «второй аргумент — дети победителя».
  const childrenArg = chooseCanonical(fresh, ['session-child'])
  assert.equal(childrenArg.canonicalId, 'session-fresh')
  assert.equal(childrenArg.children, 1)

  // Без детей канонический id — id победителя; проигравших нет.
  const single = chooseCanonical(fresh, [fresh])
  assert.equal(single.canonicalId, 'session-fresh')
  assert.deepEqual(single.superseded, [])
  assert.equal(single.reason, '')
})

test('D4: chooseCanonical возвращает restoredFrom и не зависит от порядка', () => {
  const winner = { id: 'session-winner', lastEventAt: 900, events: 5, bytes: 500, createdAt: 100 }
  const parent = { id: 'session-parent', lastEventAt: 100, events: 2, bytes: 100, createdAt: 50 }
  const childrenById = new Map([['session-parent', ['session-child']]])
  const tombstones = { sessions: { 'session-parent': { reason: 'manual', restoredFrom: 'prune' } } }
  const forward = chooseCanonical(winner, [winner, parent], { childrenById, tombstones })
  const backward = chooseCanonical(winner, [...[winner, parent]].reverse(), { childrenById, tombstones })
  assert.equal(forward.canonicalId, 'session-parent')
  assert.equal(backward.canonicalId, forward.canonicalId, 'порядок входа не влияет')
  assert.deepEqual(backward.supersededIds, forward.supersededIds)
  assert.equal(forward.restoredFrom, 'prune', 'restoredFrom из надгробия канонической копии')
  // Явное поле кандидата важнее надгробия.
  const explicit = chooseCanonical({ ...winner, restoredFrom: 'expired' }, [parent], { childrenById, tombstones })
  assert.equal(explicit.restoredFrom, 'expired')
  // Надгробия нет — пустая строка, без выдумок.
  const empty = chooseCanonical(winner, [parent], { childrenById })
  assert.equal(empty.restoredFrom, '')
})

test('D4: пустой набор кандидатов не ломает chooseCanonical', () => {
  const empty = chooseCanonical(undefined, [])
  assert.equal(empty.canonicalId, '')
  assert.equal(empty.winnerId, '')
  assert.deepEqual(empty.superseded, [])
  assert.deepEqual(empty.ranked, [])
  assert.equal(empty.restoredFrom, '')
})
