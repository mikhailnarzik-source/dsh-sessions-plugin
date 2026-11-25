# 1.0.82: производительность и гонки (M9, аудит п.1–3)

Закрывает три пункта аудита архитектуры: чтение логов на каждый опрос панели,
два независимых опроса состояния и отсутствие общего лока у писателей зеркала.

## M9-A — кэш метаданных и единый снапшот

- `lib/store.mjs`: `listMirrorSessions` больше не читает логи целиком — заголовок
  берётся из кэша по `(path, mtime, size)`, читается только префикс 512 Б
  (8/64 КБ для аномальных логов); `bytes` — ленивый геттер; LRU 500;
  `storeStats()/clearMirrorCache()/setMirrorCacheLimit()`.
- `lib/state-snapshot.mjs`: единый снапшот `{at, value}` с single-flight,
  TTL 5 с и проверкой подписи на каждом вызове (логи, ledger, tombstones,
  modes, local-only, state, outbox, workspace…). `invalidate()` во время
  расчёта не кладёт устаревшее значение.
- `index.js`: `/state` и `/sessions` собираются **одним** расчётом; 18 мест
  инвалидации (sync/prune/restore/mode/duplicates/outbox/profile attach/
  saveSettings) сбрасывают снапшот; старый TTL-кэш `sessionStates` удалён.

**Метрики (стенд 20 логов / 23,8 МБ):** было 23,8 МБ чтения на опрос → 10 240 Б
на первый (0,04 %) и 0 Б на повторный; весь опрос ~4 мс; `mirrorFullReads = 0`.

## M9-B — единый лок писателей зеркала

- `lib/mirror-write.mjs`: `withMirrorLock(home, action, fn[, options])` —
  межпроцессный лок (`dsh-sync/sync.lock`, stale 5 мин, heartbeat 1 мин),
  ожидание занятого лока до 30 с, затем `{ok:false, busy:true, code:'mirror/busy'}`
  без выполнения и без исключения; вложенный вызов не берёт лок повторно
  (`AsyncLocalStorage`); исключение внутри `fn` лок освобождает.
  `mirrorLockBusy()/readMirrorLock()` — быстрая проверка без захвата.
- `lib/lock.mjs`: исправлена гонка «между mkdir и owner.json» (grace-порог,
  перечитывание, снятие брошенного лока переименованием) — её нашёл стресс-тест
  двух процессов.
- `index.js` под локом: restore, cloud-copy/makeSessionLocal/Cloud, режимы и
  объявления, дубли в карантин, миграция local-only, prepare/reconcile
  local-only, prune (host-путь), синхронизация host-путём, применение профиля,
  правила сессий. Перед спавном child — fast-fail по занятости; `autoTick`
  считает `busy` пропуском такта, повторный клик не запускает вторую операцию.
- `lib/sync-child.mjs`: тот же `withMirrorLock`, `busy` → `skipped`, host лок
  вокруг child не держит (нет двойного лока и deadlock).

## Проверки

```
node --check index.js lib/*.mjs
node --import ./test/setup.mjs --test test/*.test.mjs   → 454/454 (12 прогонов подряд)
node test/plugin-smoke.mjs                              → OK
node test/client-smoke.mjs                              → OK
```

Новые тесты: `test/state-cache.test.mjs` (18) — single-flight, TTL, подпись,
инвалидация, кэш стора, формат ответов golden-ключами; `test/mirror-lock.test.mjs`
(15) — busy/ожидание, вложенность, исключения, мёртвый pid, два реальных
процесса-писателя без перемешивания строк, child→host без deadlock, все
маршруты-писатели под локом.
