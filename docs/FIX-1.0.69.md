# 1.0.69: восстановление после чужого `index.lock`

Симптом: синхронизация падала с

```
git commit → 128: fatal: Unable to create '…/.git/index.lock': File exists.
Another git process seems to be running…
```

Причины: параллельный git (автосинхронизация + ручной запуск/резерв) или
брошенный лок после упавшего процесса. Раньше это требовало ручного удаления файла.

## Что сделано

- `lib/git.mjs`: `recoverIndexLock(repoDir, errorText)`:
  - если `index.lock` **старше 60 с** — считается брошенным и удаляется;
  - если **свежий** — ждём до 5 с, пока активный git его отпустит;
  - после снятия лока `commitAndPush` повторяет `git commit` один раз.
- Остальные ошибки git не маскируются (не «not a git repository», не сетевые).
- Константы: `INDEX_LOCK_WAIT_MS = 5000`, `INDEX_LOCK_STALE_MS = 60000`.
- Тесты: `test/lock-recovery.test.mjs` (брошенный лок, свежий лок, освобождение,
  чужие ошибки, границы констант).

## Проверка

```
node --check lib/git.mjs
node --import ./test/setup.mjs --test test/*.test.mjs
```

Если лок всё же остался (git-процесс действительно жив), синхронизация честно
сообщит об ошибке, а не удалит чужой лок.
