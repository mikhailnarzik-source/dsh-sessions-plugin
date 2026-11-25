# 1.0.79: предохранители автоудаления сессий (M7)

Причина инцидента 25.11 и правила восстановления — `docs/SESSION-SAFETY.md`.

## Что случилось

1. Сессии восстановили из архива (`~/.dsh.rar` → `full_dsh` → `~/.dsh/sessions`).
2. В старом зеркале `dsh-sync` остались **18 активных меток удаления** на эти же
   сессии (17 `children` + одна `made-local`); всего 198 меток.
3. Автосинхронизация при pull применила метки к свежим локальным копиям —
   сессии снова ушли в карантин и исчезли из списка.

Почему не помогло: время файлов при копировании из архива сохраняется, поэтому
восстановленные логи выглядели «не новее» удаления; предела на количество
удалений за проход не было; возраст меток не проверялся; отдельного выключателя
автоудаления не было.

## Предохранители

- **Воскрешение:** если `mtime` лога больше `tombstone.at + 60 с`, сессия не
  удаляется, метка переводится в `reason: "restored"` (пишется после
  `fetch+reset`, чтобы не потерялась), в отчёте — `revivedIds/revivedDetails`.
  Защищается вся группа «родитель + субагенты».
- **Массовый предохранитель:** конфиг `deletions`
  `{ autoApply: true, maxAutoRemove: 3, maxTombstoneAgeDays: 7 }`.
  Автоудаление не выполняется, если:
  - независимых операций больше `maxAutoRemove` (`reason: mass`),
  - метка старше `maxTombstoneAgeDays` (`stale`),
  - `autoApply: false` (`disabled`).
  Тогда не удаляется **ничего** из пачки: `summary.deletionsBlocked`, предупреждение
  в `last-run` «автоудаление остановлено: N меток — проверьте „Удаления“».
- **Ручное подтверждение:** `applyDeletions(confirm: true)` («Применить удаления»)
  дожимает заблокированное, но **не обходит** `restored`/«воскрешение» и локальные
  режимы; возвращает `guard {bypassed, wouldBlock}`, `blocked`, `revivedIds`,
  `restoredSkipped`.
- **План:** `pendingDeletions {count, ids, reasons}` в plan/summary — видно до
  применения.

## Тесты

`test/auto-delete-safety.test.mjs` — 13 тестов: свежая метка удаляется; лог новее
метки → revived + restored и повторный pull не удаляет; защита группы; 5 меток →
`mass` и ничего не удалено; 4 сессии одной группы — одна операция (не блокируется);
метка 8 дней → `stale`; `autoApply:false` → `disabled`; confirm дожимает
заблокированное; restored не удаляется; pendingDeletions; нормализация конфига.

```
node --check lib/config.mjs lib/deletions.mjs lib/sync.mjs
node --import ./test/setup.mjs --test test/*.test.mjs   → 417/417
node test/plugin-smoke.mjs                              → OK
```

## Эксплуатация

- Сразу после восстановления из архива: остановить автосинхронизацию
  (`autoSync.enabled=false`), сверить `tombstones.json` с живыми сессиями,
  снять/пометить `restored`, только потом sync (чек-лист в `SESSION-SAFETY.md`).
- Бэкап перед работами: `E:\_dsh_restore_work\safety-backup-<дата>`.
- Карантин (`dsh-sync/deleted`, `sessions/*/_deleted`) не чистить без нужды.
