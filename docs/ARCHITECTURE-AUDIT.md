# Аудит архитектуры `dsh-sessions` 1.0.81 (M8, задача 23)

Метод: только чтение кода и документов (`grep`, построчный разбор, измерение тел функций).
Код не менялся, тесты не запускались, DSH не перезапускался. Ссылки — `файл:строка`
относительно `.publish/dsh-sessions-plugin`.

Объём: `index.js` 5 120 строк, `client.js` 8 185, `lib/` 40 модулей / 17 981,
`delete/index.js` 910, `cli.mjs` 619, `test/` 51 файл.

## 1. Карта слоёв

| Слой | Файлы | Роль | Пишет на диск |
|---|---|---|---|
| host | `index.js` | HTTP-маршруты (`index.js:4392`–`4992`), tool-обёртки (`index.js:4998`), состояние панели, автоматика, restore/prune/mode/профиль | да, напрямую |
| host-плагин внутри | `delete/index.js` | встроенный «плагин удаления»: свой API, сессии, `fs.rm` (`delete/index.js:384`, `:530`), надгробия через `lib/tombstones.mjs` | да |
| движок | `lib/sync.mjs` (3 196), `lib/store.mjs`, `lib/format.mjs`, `lib/frames.mjs`, `lib/catalog.mjs` | push/pull/prune/дубли/идентичность/логи | да (child) |
| движок | `lib/deletions.mjs`, `lib/tombstones.mjs`, `lib/session-modes.mjs`, `lib/session-rules.mjs`, `lib/session-groups.mjs`, `lib/titles.mjs` | правила удаления, режимы, правила сессий, группы, названия | частично |
| хранилища | `lib/webdav.mjs` (1 451), `lib/yandex.mjs`, `lib/git.mjs`, `lib/remote.mjs`, `lib/folder.mjs`, `lib/replica.mjs` | бэкенды зеркала и резерва | да |
| профиль | `lib/profile.mjs` (2 111), `lib/neutralize.mjs`, `lib/yaml.mjs` | перенос настроек, расходов, расписания, «Входящих» | да |
| служебное | `lib/outbox.mjs`, `lib/lock.mjs`, `lib/history.mjs`, `lib/ledger.mjs`, `lib/config.mjs`, `lib/secrets.mjs` | очередь, лок, журналы, реестр | да |
| child | `lib/sync-child.mjs`, `lib/secondary-child.mjs` | отдельный процесс Node, берёт `sync.lock` (`lib/sync-child.mjs:251`) | да |
| client | `client.js` | один IIFE-бандл: слоты, карточки, диалоги, правила, режимы, профиль, удаление, мониторинг | нет |
| CLI | `cli.mjs` | те же действия из консоли | да |

Наблюдения:
- Единственный слой с блокировкой — child. Host пишет в зеркало сам (`index.js:3641`, `:3897`, `:4017`, `:4087`), лок не берёт.
- Бизнес-логика присутствует во всех трёх слоях: host, client и движок независимо считают режимы, группы, подписи, сводки.
- `lib/plan.mjs` (414 строк) — фактически второй движок планирования рядом с `sync.mjs`.
- `delete/index.js` — «плагин в плагине»: отдельные маршруты, хранилище и право удалять файлы проекта.

## 2. Дубли логики

| # | Что дублируется | Где | Оценка |
|---|---|---|---|
| 1 | Хелперы планирования | `lib/plan.mjs:54,64,155,175,256,262` копируют `lib/sync.mjs:422,432,380,412,106,111` (`headerOf`, `groupsOf`, `relationOf`, `selectedProjects`, разбор версий) | 6 функций один-в-один |
| 2 | HTTP/WebDAV-обход | `lib/webdav.mjs:304,322,486,794` и `lib/yandex.mjs:30,48,68,140`, `lib/folder.mjs:89,107,168` (`walkFiles`, `mapLimit`, `request`, `upload`, `listRemote`) | три почти одинаковых бэкенда |
| 3 | Причины/авторы удаления | `lib/deletions.mjs:46` (`reasonLabel`), `lib/tombstones.mjs:49` (`TOMBSTONE_REASONS`), `client.js:4183`–`4198`, `client.js:6470` | 3 реестра, 2 слоя |
| 4 | Значки состояния | `lib/session-modes.mjs` (`sessionBadge`) → `lib/ledger.mjs:54` (`sessionState`) → `client.js:4210` (`SESSION_BADGES`), `client.js:4392` (`indicatorStateOf`) | подписи/цвета в клиенте повторяют коды host |
| 5 | Названия и короткий id | `lib/titles.mjs:46,53` vs `client.js:4226,4237,4243` | 2 реализации обрезки/подписи |
| 6 | Группы «родитель + субагенты» | `index.js:645` (`computeSessionGroupStats`), `index.js:760` (`tombstoneGroup`) vs `client.js:4254,4283` (`sessionGroupSummary`, `sessionGroupRows`) | сводка считается на обоих концах |
| 7 | Правила сессий | `lib/session-rules.mjs:161,497,527` vs `index.js:2806,2868` (пересборка полей) vs `client.js:5419,5437,5498` (draft/payload) | 3 представления одной модели |
| 8 | Режимы/«локальная навсегда» | `lib/session-modes.mjs` + `lib/sync.mjs` (`publishLocalOnly`) + `index.js:4000–4128` (`prepareLocalOnlyState`, `reconcileLocalOnlyState`, `switchSessionMode`) + `client.js:5790` | одно состояние, четыре точки |
| 9 | Счётчики/форматы | `lib/catalog.mjs:203` (`hashOf`) vs `lib/profile.mjs:193,206`; `lib/deletions.mjs:337` (`childCount`) vs `lib/sync.mjs:1128`; `lib/outbox.mjs:57` vs `lib/tombstones.mjs:65` (`isoNow`); `lib/onboarding.mjs:87` vs `lib/sync.mjs:105` (`compareVersions`) | мелкие копии |
| 10 | Метки формата/версии | `lib/plan.mjs:251` и `lib/sync.mjs:1418,2553` — одинаковая проверка «зеркало новее» | логику можно вынести в одну функцию |

Вывод: дубли в основном «презентационные» (сводки, подписи, правила) и «движковые» (`plan.mjs`, бэкенды).
Первые дают рассинхрон UI с host, вторые — расхождение поведения plan/push/pull.

## 3. Крупные файлы и функции (>300 строк)

| Файл | Строк | Крупные единицы | Предложение |
|---|---|---|---|
| `client.js` | 8 185 | `SyncCard` L1957–3402 (≈1 450), `SessionModesSection` L5790–6428 (≈640), `ProfileLayerSection` L6597–6917 (≈320), `SessionDeleteDialog` L7762–7953 (≈190), `SessionRulesPanel` L5241–5413 (≈170); две функции с именем `apply` (`client.js:565` и `:7954`) | разнести карточки/диалоги по файлам и собрать общий слой `ui/format`, `ui/state`; переименовать `apply` |
| `index.js` | 5 120 | `apply` L4363–5120 (757), `readState` L837–1107 (271), `sessionStates` L2554–2765 (212), `runSync` L1547–1846 (300), `restoreSessions` L3577–3864 (288) | вынести маршруты (`routes.mjs`), состояние (`state.mjs`), восстановление (`restore.mjs`) |
| `lib/webdav.mjs` | 1 451 | `createWebdavBackend` L462–1396 (≈935, ~30 вложенных замыканий) | разделить на `webdav/{http,listing,transfer,probe}.mjs` |
| `lib/sync.mjs` | 3 196 | `push` L1392–1997 (606), `applyDeletions` L2129–2479 (351), `pull` L2480–2656 (177) + хвост приёма L2657–3196 | `push.mjs`, `pull.mjs`, `prune.mjs`, общий `guards.mjs` |
| `lib/profile.mjs` | 2 111 | 99 функций: patch, bundles, settings, expenses, schedule, inbox, manifest, plan, apply в одном файле | 5–6 модулей по домену |
| `delete/index.js` | 910 | inspect/delete/removeSessionArtifacts в одном файле с собственными маршрутами (`DELETE_PATH = /api/session-delete/delete`) | оставить отдельным пакетом или вынести |

Все крупные единицы разбиваются без изменения поведения: чистые функции уже отделены, мешают только
общие замыкания и неявные зависимости от `home`/`config`.

## 4. Риски

### 4.1 Гонки

| Риск | Факт | Последствие |
|---|---|---|
| host пишет в зеркало без лока | `index.js:3641` (`restore` → `remote.sync()`), `:3897` (удаление облачной копии), `:4017` и `:4087` (`commitMirrorChanges`), `:3490` (дубли) | одновременный child-push и `fetch+reset` затирают незакоммиченные надгробия; `git index.lock` |
| autoSync vs ручные действия | `automation.running` поднимает только `autoTick` (`index.js:2217,2230`); кнопка (`index.js:4604`) и очередь (`index.js:4215`) его не ставят | параллельно идут pull, push из outbox и watcher (`index.js:4281–4297`, шаг 5 с) |
| watcher удалений | `index.js:4281` вызывает `runSync` вне `automation.running` | лишние запуски при каждом удалении сессии |
| `fetch+reset` | `lib/sync.mjs:1401–1402`; ручные метки спасаются снимком (`:1398`) и слиянием (`:1471`) | окно всё равно есть: снимок до `sync()`, запись после |
| outbox read-modify-write | `lib/outbox.mjs:192–198` пишет файл без tmp+rename; `enqueue`/`flush` — цикл «прочитать-изменить-записать» (`:204–231`, `:394–461`) | потеря операции при параллельном enqueue (autoTick + кнопка + shutdown) |
| отложенное удаление | повтор идёт с `confirm:true` и обходит массовый предохранитель (`lib/sync.mjs:2185–2206`) | восстановленная сессия защищена (`restoredSkipped`), но предохранитель уже обойдён |
| лок | `lib/lock.mjs:16–18` (stale 5 мин, heartbeat 1 мин), проверка pid `:74–80` | живой долгий upload защищён; после убийства процесса лок снимается по pid |

### 4.2 Потеря данных

| Риск | Факт | Смягчение / замечание |
|---|---|---|
| метки удаления сильнее файлов | инцидент 25.11 описан в `docs/SESSION-SAFETY.md`; активные метки применяются повторно (`lib/sync.mjs:887–963`) | предохранитель: `maxAutoRemove` 3, stale 7 дней (`lib/deletions.mjs:728–783`); M7 |
| снятые метки удаляются из файла | `lib/sync.mjs:1476–1481` стирает `reason=restored` навсегда | факт остаётся только в `history.jsonl`; при потере журнала нет следов |
| встроенное удаление файлов | `delete/index.js:378–384`, `:530` — физическое `fs.rm` сессии и файлов проекта (`deleteFiles`) | не проходит через карантин зеркала; отдельный код внутри sync-плагина |
| restore | `index.js:3688–3704` уводит живую копию в `_deleted/<id>.superseded-*`, возвращает канонический id (`index.js:3368`) | при повторном restore карантины копятся, чистка только по карантинной политике |
| fork | `forbidFork` реально применяется при конфликте (`lib/sync.mjs:2890–2899`), причина видна в отчёте | ограничение работает только на pull; `protect` проверяется в prune (`lib/sync.mjs:2180–2184`) |
| битые/чужие файлы | битый JSON → пустые структуры: `lib/tombstones.mjs:86–100`, `lib/outbox.mjs:158–179`, `lib/ledger.mjs:14–23` | тихая деградация: пользователь не узнает, что метки/очередь потеряны |

### 4.3 Производительность

| Риск | Факт | Оценка |
|---|---|---|
| полное чтение логов при каждом `/state` | `readState` → `localSessionsFor` (`index.js:866`) и `listMirrorSessions` (`index.js:881`; зеркало читается для первого проекта, `index.js:852–853`); `listMirrorSessions` читает **все** логи целиком (`lib/store.mjs:94–117`), как и `listLocalSessions` (`lib/store.mjs:62–91`) | 20 сессий × 40 МБ ≈ 800 МБ чтения на каждый опрос `/state`; маршрут без кэша (`index.js:4392`) |
| опрос из клиента | `client.js:955–961`: `/state` и `/tombstones` каждые 30 с принудительно (`refreshTombstones(true)`, `client.js:958`), `/sessions` кэш 20 с (`client.js:4115`), но есть дозапрос чаще 3 с (`client.js:4146`) | 2 запроса/30 с на каждое открытое окно + полный скан зеркала |
| `/sessions` | `index.js:2554–2765`: чтение конфига, ledger, workspace, режимов, надгробий, `stat` и названий по каждой сессии; кэш всего 5 с (`index.js:2555`) | кэш почти не спасает, дорогие вызовы внутри |
| заголовки | `lib/titles.mjs:178–193`: окна 1/4/16/64 МБ от хвоста + лимит распаковки 48 МБ (`:26,119`) | на 40 МБ без названия — почти полное чтение файла; кэш 500 (`:28`) |
| память push/pull | `lib/sync.mjs:1439` → `listLocalSessions` держит все байты; хеши считаются по нормализованному тексту (`lib/catalog.mjs:153–223`, `:992`, `:2764`, `:2918`) | байты + строки → ×2–3 к размеру логов |
| WebDAV-перечисление | `lib/webdav.mjs:835–892`: сначала `PROPFIND depth: infinity`, при отказе — обход «корень → sessions → проекты» (`:870–890`) | на больших зеркалах десятки запросов; таймаут `lightProbe` (`lib/webdav.mjs:90–104`) |
| WebDAV-скачивание | `lib/webdav.mjs:712–736`: `arrayBuffer` + `Buffer.concat` целиком в памяти; 8 параллельных (`:1093`, M5) | до ~8 × 40 МБ + докачка `part` |
| очередь | `lib/outbox.mjs:194` молча обрезает до 100 операций (`slice(-100)`) | старые операции пропадают без сообщения |

### 4.4 Устаревшие кэши

| Кэш | Где | Риск |
|---|---|---|
| снимок сессий 5 с | `index.js:2466,2555` | после ручных правок в зеркале панель 5 с показывает старое |
| названия по mtime+size | `lib/titles.mjs:209–233` | изменение лога без смены mtime (редко) даёт старое имя |
| probe облака | `index.js:454–456` (TTL проверки remote через `git ls-remote`) | статус «доступен» может отставать |
| ledger | `lib/ledger.mjs:54–60` — только mtime/size | дописывание без mtime (сетевой диск) не заметно |
| `automation.workspaceCount` | `index.js:2259–2261,4280–4296` | после рестарта счётчик переинициализируется — удаления в первые секунды могут не уехать |

## 5. Совместимость версий и форматов

| Механизм | Факт | Замечание |
|---|---|---|
| формат логов | `LOG_FORMAT = 4` (`lib/frames.mjs:13`), пишется в `projects.json.dsh.format` (`lib/mirror-meta.mjs:34–40,57–66`); push блокируется при новее (`lib/sync.mjs:1418–1422`), pull предупреждает (`lib/sync.mjs:2553`) | у старых зеркал роль формата играет `projects.version` — сравнение с 4 может дать ложное «новее» |
| версия DSH | `compareVersions` (`lib/sync.mjs:105–125`), `detectDshVersion`; отчёт `supportedFormat` (`lib/sync.mjs:236`) | проверка версии не влияет на решение о push — только текст |
| надгробия | `TOMBSTONES_VERSION = 2` (`lib/tombstones.mjs:32`), неизвестные `reason` → `manual` (`:80`) | миграция односторонняя: старый код не поймёт `made-local`/`superseded` |
| sidecar | ленивая достройка `contentHash`/`lineageKey` без перезаписи лога (`lib/catalog.mjs:606–646`) | при отказе чтения лога identity не появится, дубль не распознается |
| outbox | `OUTBOX_VERSION = 1` (`lib/outbox.mjs:23`), старый формат `{id}` читается (`:74–95`) | версия не проверяется при чтении — только форма |
| конфиг | `lib/config.mjs:60–97` (`defaultConfig`, `version: 1`), `loadConfig:99–113` нормализует только `deletions` | версия схемы не читается; новые поля `profile`/`autoSync`/`secondary` в старом конфиге не нормализуются |
| Node | `engines.node >= 22.15` (`package.json`); zstd из `node:zlib` | на старом Node падает разбор логов, а не предупреждает |

## 6. Дубли настроек между плагинами

| Что | Где | Проблема |
|---|---|---|
| белый список настроек чужих плагинов | `lib/profile.mjs:113–144`: `dsh-notify` (12 ключей), `dsh-calendar`, `dsh-expenses`, `dsh-polish`, `dsh-cards` | схема живёт в `dsh-sessions`; при изменении плагина настройки молча перестают синхронизироваться |
| `panelVisibility` | `dsh-polish` и `dsh-cards` пишут один ключ в localStorage (`dsh-polish/client.js:81`, `dsh-cards/client.js:38`); в профиле — два файла (`lib/profile.mjs:133–143`) | один объект в двух зеркалах; причина FIX-1.0.81 «2 файла ждут применения» |
| безопасный patch | `lib/profile.mjs:80–106` перечисляет `ui-theme`, `locale`, `mcp-manager` | новые настройки оформления требуют правки sync-плагина |
| очередь браузерных настроек | `lib/profile.mjs:48–49` + `client.js:6962` (`BrowserSettingsBridge`) + маршрут `index.js:4942` | двусторонний контракт «pending → applied → snapshot» держится вручную |
| маршруты | префикс `/api/dsh-sync/*` (`index.js:4392+`) при имени пакета `dsh-sessions` | старый `dsh-sync` 0.7.5 тоже объявлял `/api/dsh-sync/*` — при включении обоих будет коллизия |

## 7. Десять приоритетных улучшений

| # | Улучшение | Файл:строка | Польза | Сложность |
|---|---|---|---|---|
| 1 | Кэшируемый индекс метаданных вместо чтения логов: `listLocalSessions`/`listMirrorSessions` возвращают только заголовок/`stat`, байты — по требованию; `readState` перестаёт читать зеркало | `lib/store.mjs:62–117`, `index.js:866–903`, `index.js:4392` | убирает ~800 МБ I/O на опрос, ускоряет панель и push | M |
| 2 | Один межпроцессный лок для всех писателей зеркала: обернуть restore/cloud-copy/mode/local-only/duplicates в `acquireLock` или провести через child | `lib/lock.mjs:27`, `lib/sync-child.mjs:251`, `index.js:3641,3897,4017,4087,3490` | устраняет `fetch+reset` поверх чужих правок и `index.lock` | M |
| 3 | Единый кэшированный снапшот `state+sessions`: один маршрут/одна функция с TTL 5–10 с, клиент не опрашивает два эндпоинта | `index.js:2544–2576`, `index.js:4392,4656`, `client.js:955–961,4111–4152` | меньше запросов и рассинхрона «строка vs список» | L |
| 4 | Потоковая передача WebDAV: скачивание в `.part` через `pipeline` (без `arrayBuffer`+`concat`), лимит параллелизма по памяти | `lib/webdav.mjs:658–751`, `:1093` | 40 МБ-сессии не держат 2 копии в RAM; стабильность на слабых машинах | M |
| 5 | Разбить `client.js`: карточки/диалоги в отдельные модули, общий `labels/format`, `SessionModesSection` и `SyncCard` — на подкомпоненты | `client.js:1957–3402`, `:5790–6428`, `:4183–4243` | сопровождаемость, точечные тесты, убирает дубли подписей | H |
| 6 | Удалить второй движок `lib/plan.mjs`: импортировать `headerOf`/`groupsOf`/`relationOf`/`selectedProjects` из `sync.mjs` (или вынести в `lib/mirror-view.mjs`) | `lib/plan.mjs:54,64,155,175,256,262` vs `lib/sync.mjs:422,432,380,412,106,111` | одно поведение plan/push/pull, минус 6 копий | L |
| 7 | Слить `lib/yandex.mjs` в webdav-адаптер (общий `httpBackend` + `walkFiles/mapLimit/request/upload`) | `lib/yandex.mjs:30–195`, `lib/webdav.mjs:304,322,486,794`, `lib/folder.mjs:89,107,168` | один транспорт, одна обработка ошибок/таймаутов | M |
| 8 | Атомарная запись outbox (tmp+rename) и явная политика вытеснения вместо `slice(-100)`: слияние операций при записи, счётчик отброшенных в отчёт | `lib/outbox.mjs:192–198`, `:204–231`, `:194`, `:394–461` | не теряет отложенные удаления/восстановления | L |
| 9 | Контракт «коды → подписи» от host: клиент рисует то, что пришло (`reason`/`by`/`badge` уже есть), локальные реестры `DELETED_*`/`SESSION_BADGES`/`shortSessionId` убрать | `client.js:4183–4243`, `:4210`, `lib/deletions.mjs:46`, `lib/session-modes.mjs`, `lib/titles.mjs:46` | один источник правды, подписи не расходятся | L |
| 10 | Декларируемые настройки профиля: каждый плагин объявляет `dsh.profileSettings` в `package.json`, `profile.mjs` читает их вместо хардкод-списка; `panelVisibility` — один владелец | `lib/profile.mjs:80–144`, `client.js:6962`, FIX-1.0.81 | конец «дрейфу ключей» и циклу «2 файла ждут применения» | M |

Дополнительно (11-е, если брать сверх десяти): разбить `restoreSessions` на «синхронизация → выбор
канонического id → карантин → восстановление → привязка» (`index.js:3577–3864`) — 288 строк с пятью
независимыми побочными эффектами и без лока.

## 8. Что удалить или упростить

| Что | Где | Почему |
|---|---|---|
| опубликованный `dsh-sync` 0.7.5 | `.publish/dsh-sync` (3 294 строки JS; в активный профиль не входит — `~/.dsh/profiles/desktop/package.json`) | дубль функции и тот же префикс `/api/dsh-sync/*` (`dsh-sync/index.js:36–77`); источник путаницы имён (`dsh-sync` vs `dsh-sessions`) |
| отдельный `dsh-session-delete` | `.publish/dsh-session-delete` vs `delete/index.js` (разные SHA, разошлись) | два «плагина удаления» с разным поведением (`fs.rm` в обоих) |
| `dsh-sessions-bundle` | `.publish/dsh-sessions-bundle` (только манифест) | пустая обёртка, ничего не даёт |
| `hint`-копии в клиенте | `client.js:4183–4243` | переезжает в #9 |
| копии `walk/walkFiles/mapLimit` | `lib/attachments.mjs:32`, `lib/folder.mjs:89`, `lib/profile.mjs:1666`, `lib/replica.mjs:39`, `lib/webdav.mjs:584`, `lib/yandex.mjs:94` | один `lib/fs-walk.mjs` |
| двойная проверка формата | `lib/plan.mjs:251`, `lib/sync.mjs:1418,2553` | один `assertFormat()` |
| хвостовой поиск названия с окнами до 64 МБ | `lib/titles.mjs:178–193` | оставить префикс 2 МБ + sidecar из `session.json`; хвост — только для «переименованных» по флагу |

Не трогать: предохранитель автоудаления (`lib/deletions.mjs:728–783`), формат-гард, карантины и
`forbidFork` — это проверенные инцидентом защиты (25.11, `docs/SESSION-SAFETY.md`).

## 9. Ограничения аудита

- Только чтение; тесты (`test/` 51 файл) не запускались, поведение не воспроизводилось живым прогоном.
- Оценки размеров функций — по границам определений, не по AST; ±10 строк.
- Производительность оценена по коду (полные `readFile` в `lib/store.mjs`), без замеров на реальном зеркале 20×40 МБ.
