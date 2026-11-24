# M0: хотфиксы синхронизации — 1.0.67

Версия `1.0.67` закрывает M0 из аудита 24.11 (папка `DSH-домой-2026-11-24`,
`02-передача-домой/18-ПЛАН-РАБОТ.md`). Основание — факты рабочего компьютера
(`23-аудит-архитектуры.md`) и ручные патчи в `node_modules`, которые не попадали в исходники.

## Что исправлено

| ID | Что | Файлы |
|---|---|---|
| H1 | У каждой строки списка есть иконка синхронизации: неизвестная сессия = `pending` (янтарное облако 55 %, «Ещё не уходила в зеркало»); снимок обновляется при создании/активации строки | `client.js` |
| H2 | Названия вместо id: `session.title` → первое событие `session/title` из лога (первые 2 МБ, кэш по path+mtime) → `session.json` зеркала → «Без названия»; `shortId` только в tooltip; работает в сессиях, плане, «Удалённых», режимах | `lib/titles.mjs`, `index.js`, `client.js` |
| H3 | Метка удаления сильнее присутствия копии: `dropTombstone` только если сессия новее метки; `made-local` не снимается никогда; `pull` не импортирует сессию с активной меткой | `lib/sync.mjs` |
| H4 | Восстановление возвращает тот же id: канонический id (с учётом группы), `restoredFrom`, метка `restored`, конфликтующая живая копия — в `_deleted` с `reason: superseded`; новых копий не появляется | `index.js`, `lib/deletions.mjs` |
| H5 | Единый интерфейс бэкендов: WebDAV получил `list/sync/commit/remove/capabilities` и `lightProbe()`; вместо `remote.sync is not a function` — «резерв не поддерживает операцию «X»» с кодом `reserve/unsupported`, операция уходит в очередь | `lib/webdav.mjs`, `lib/secondary-init.mjs`, `index.js` |
| H6 | Outbox + flush: очередь неотправленных операций (`push/delete/mode/restore`) в `~/.dsh/dsh-sync/outbox.json`, повтор с backoff, отправка при старте/таймере и в cleanup (таймаут 8 с, выход не блокируется); в панели «в очереди: N» | `lib/outbox.mjs`, `index.js`, `client.js` |
| H7 | Формат-гард реально работает: формат читается из `dsh.format`/`projects.version`; при более новом формате зеркала push блокируется (`errorKind: format`) | `lib/mirror-meta.mjs`, `lib/sync.mjs` |
| H8 | Реестр причин надгробий: `duplicate`, `made-local`, `superseded` сохраняются и показываются; неизвестные по-прежнему `manual` | `lib/tombstones.mjs`, `client.js` |
| H9 | `errorKind` (`network/auth/format/guard/reserve/unknown`) + счётчик `failures` в `last-run.json` и `history.jsonl`; успех сбрасывает счётчик; в панели строка «последняя ошибка: …, неудач: N» | `lib/history.mjs`, `lib/sync-child.mjs`, `client.js` |
| H10 | Один `recordRun` на прогон: двойная запись в `sync-child.mjs` убрана, доводки host-части пишут только `last-run.json` | `lib/sync-child.mjs`, `index.js` |
| H11 | Проверка обновлений смотрит правильный репозиторий `mikhailnarzik-source/dsh-sessions-plugin` (имя `dsh-sessions`), показывает версию + короткий commit, для локальной установки — «автообновление не применяется» | `lib/update.js`, `client.js` |

## Дополнительно

- `test/setup.mjs`: у каждого тестового процесса свой временный `DSH_HOME` — тесты больше
  не пишут в реальный `~/.dsh`; полный набор проходит параллельно.
- U3-заготовка: лёгкая сверка резерва (`lightProbe` = PROPFIND + `profile/manifest.json`,
  без скачивания блобов, таймаут 10–30 с), полный `sync()` остаётся для загрузки.

## Проверки

```
node --check index.js client.js lib/*.mjs
node --import ./test/setup.mjs --test test/*.test.mjs
ℹ tests 247  ℹ pass 247  ℹ fail 0
```

Живая проверка `lib/update.js` на профиле: `installed 83ee8a8…`, `latest 8cfd0cd…`,
описание «доступно обновление: v1.0.66 (83ee8a8) → 8cfd0cd».

## Что сделать рабочему компьютеру после обновления

1. Обновить `dsh-sessions` до 1.0.67 (через плагин-менеджер) и перезапустить DSH.
2. Удалить ручные патчи `client.js.bak-before-icon-fix`, `index.js.bak-before-title-fix`
   и сами правки в `node_modules` — они теперь в исходнике.
3. Прогнать регрессионный чек-лист из `18-ПЛАН-РАБОТ.md` §4 (10 пунктов).
4. Проверить: иконка у каждой строки, названия, «убрать копию из облака» держится,
   удаление не воскресает, «Сверить» резерва — быстрая.

## Дальше (M1)

`contentHash`/`lineageKey`, импорт по содержимому, рейтинг «самая свежая» и канонический id,
кнопка «Найти дубли», агрегация расходов (родитель + субагенты, название из `session/title`,
бейдж «локальная»), `local-only.json` и переключатель режима в шапке сессии.
