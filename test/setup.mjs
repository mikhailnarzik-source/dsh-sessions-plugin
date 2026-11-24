/**
 * Изоляция тестов: каждый тестовый процесс получает свой временный DSH_HOME,
 * чтобы тесты не писали в реальный ~/.dsh (last-run.json, история, очередь).
 *
 * Загружается через `node --import ./test/setup.mjs --test test/*.test.mjs`,
 * то есть до статических импортов тестовых файлов.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (typeof process.env.DSH_HOME !== 'string' || process.env.DSH_HOME === '') {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sessions-test-home-'))
  process.env.DSH_HOME = home
  process.on('exit', () => {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // уборка необязательна
    }
  })
}
