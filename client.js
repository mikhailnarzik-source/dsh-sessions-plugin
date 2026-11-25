/**
 * Browser half of `dsh-sync`.
 *
 * Карточка на странице «Плагины» в настройках: проверка окружения, поля для
 * адреса зеркала и пути к проекту, кнопка синхронизации и отчёт о последнем
 * запуске. Все действия идут через host-маршруты `/api/dsh-sync/*`; токены в
 * браузер не попадают.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sessions',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const { createPortal } = require('react-dom');

    const NS = 'dshSync';
    const STATE_PATH = '/api/dsh-sync/state';
    const CONFIG_PATH = '/api/dsh-sync/config';
    const RUN_PATH = '/api/dsh-sync/run';
    // План «Проверить»: только чтение.
    const PLAN_PATH = '/api/dsh-sync/plan';
    // Подтверждённые удаления: единственный путь удаления из зеркала.
    const PRUNE_PATH = '/api/dsh-sync/prune';
    const CREATE_REPO_PATH = '/api/dsh-sync/create-repo';
    const DIAG_PATH = '/api/dsh-sync/diagnostics';
    const UPDATE_PATH = '/api/dsh-sync/update';
    const UPDATE_APPLY_PATH = '/api/dsh-sync/update/apply';
    const SESSION_MODE_PATH = '/api/dsh-sync/session-mode';
    const SESSION_CLOUD_COPY_PATH = '/api/dsh-sync/session-cloud-copy';
    // «Убрать облачные копии локальных сессий»: миграция «локальная навсегда».
    const LOCAL_ONLY_MIGRATION_PATH = '/api/dsh-sync/local-only-migration';
    const PROFILE_PATH = '/api/dsh-sync/profile';
    const PROFILE_APPLY_PATH = '/api/dsh-sync/profile/apply';
    const BROWSER_SETTINGS_PATH = '/api/dsh-sync/browser-settings';
    const TOMBSTONES_PATH = '/api/dsh-sync/tombstones';
    const RESTORE_PATH = '/api/dsh-sync/restore';
    // «Найти дубли»: только чтение — группы копий и канонический id.
    const DUPLICATES_PATH = '/api/dsh-sync/duplicates';
    // «Убрать дубли в карантин»: подтверждённое действие (канонические не трогаем).
    const DUPLICATES_QUARANTINE_PATH = '/api/dsh-sync/duplicates/quarantine';
    const SECONDARY_INIT_PATH = '/api/dsh-sync/secondary-init';
    // Отмена полной сверки резерва. Прогресс приходит в /state полем
    // `secondary.init`, поэтому полоса обновляется существующим опросом
    // состояния (GET /secondary-init/status — для внешнего наблюдения).
    const SECONDARY_INIT_CANCEL_PATH = '/api/dsh-sync/secondary-init/cancel';
    // Лёгкая сверка резерва: PROPFIND + profile/manifest.json без скачивания
    // логов. Ответ: { ok, local, cloud, onlyLocal, onlyCloud, differ, code }.
    const SECONDARY_PROBE_PATH = '/api/dsh-sync/secondary-probe';
    // M4: онбординг нового устройства. GET — только чтение, без секретов.
    const ONBOARDING_PATH = '/api/dsh-sync/onboarding';
    // M6: правила сессий. GET — сводка и разбор по сессиям, POST — правка.
    const SESSION_RULES_PATH = '/api/dsh-sync/session-rules';
    // «Проверить правила»: только чтение — корзины, источники, конфликты.
    const SESSION_RULES_VERIFY_PATH = '/api/dsh-sync/session-rules/verify';
    const shortSha = (value) => (value === null || value === undefined || value === '' ? '?' : String(value).slice(0, 7));

    // Подписи страницы «Синхронизация сессий». Только тексты интерфейса:
    // логика, поля и маршруты от языка не зависят.
    const en = {
      title: 'Session sync',
      subtitle: 'Sessions, settings and attachments across devices',
      statusReady: 'configured',
      statusOff: 'not configured',
      statusChecking: 'checking…',
      statusLast: 'Last sync',
      statusNever: 'never synced',
      statusIdle: 'Ready to sync',
      actionRefresh: 'Refresh',
      actionSyncing: 'Syncing…',
      actionSyncAgain: 'Sync again',
      sectionSync: 'Synchronization',
      sectionPlan: 'Check',
      sectionConnection: 'Connection',
      sectionExtra: 'Advanced',
      sectionChecks: 'Environment check',
      sectionMaintenance: 'Maintenance',
      sectionExternal: 'External sync plugin',
      sectionDeleted: 'Deleted',
      deletedHint: 'Deleted sessions stay in quarantine for 30 days: they can be returned to the mirror and to this computer.',
      deletedEmpty: 'No deleted sessions.',
      deletedLoading: 'Loading the list…',
      deletedRestore: 'Restore',
      deletedRestoreAll: 'Restore all',
      deletedRefresh: 'Refresh list',
      deletedRestored: 'Restored sessions:',
    };
    const ru = {
      title: 'Синхронизация сессий',
      subtitle: 'Сессии, настройки и вложения между устройствами',
      statusReady: 'настроено',
      statusOff: 'не настроено',
      statusChecking: 'проверка…',
      statusLast: 'Последняя синхронизация',
      statusNever: 'ещё не синхронизировалась',
      statusIdle: 'Готово к синхронизации',
      actionRefresh: 'Обновить',
      actionSyncing: 'Синхронизация…',
      actionSyncAgain: 'Синхронизировать снова',
      sectionSync: 'Синхронизация',
      sectionPlan: 'Проверка',
      sectionConnection: 'Подключение',
      sectionExtra: 'Дополнительно',
      sectionChecks: 'Проверка окружения',
      sectionMaintenance: 'Обслуживание',
      sectionExternal: 'Внешний плагин синхронизации',
      sectionDeleted: 'Удалённые',
      deletedHint: 'Удалённые сессии лежат в карантине 30 дней: их можно вернуть в зеркало и на этот компьютер.',
      deletedEmpty: 'Удалённых сессий нет.',
      deletedLoading: 'Загрузка списка…',
      deletedRestore: 'Восстановить',
      deletedRestoreAll: 'Восстановить всё',
      deletedRefresh: 'Обновить список',
      deletedRestored: 'Восстановлено сессий:',
    };

    // Нативные выпадающие списки и поля рисуются системными цветами: без
    // color-scheme они остаются светлыми в тёмной теме.
    const themeScheme = () => {
      try {
        const background = getComputedStyle(document.body).backgroundColor;
        const parts = background.match(/[0-9.]+/g);
        if (parts === null || parts.length < 3) return 'dark';
        const [r, g, b] = parts.map(Number);
        return r * 0.299 + g * 0.587 + b * 0.114 > 140 ? 'light' : 'dark';
      } catch {
        return 'dark';
      }
    };

    // Применяем тему к нативным контролам один раз на всё приложение: так
    // выпадающие списки и поля во всех плагинах совпадают с темой.
    const applyThemeScheme = () => {
      try {
        document.documentElement.style.colorScheme = themeScheme();
      } catch {
        // вне браузера — нечего настраивать
      }
    };
    try {
      applyThemeScheme();
      const observer = new MutationObserver(applyThemeScheme);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'style'] });
    } catch {
      // без DOM работаем как раньше
    }

    // Оформление страницы «Синхронизация сессий». Цвета — токены темы
    // --dsw-alias-*: одинаково выглядят в тёмной и светлой теме DSH. Запасные
    // значения нужны, если токена нет (старая версия DSH). Отступы и радиусы
    // у всех секций одинаковые: 12–16 px.
    const S = {
      // Страница целиком: прокрутка и поля по краям задаются классом
      // .dshs-sync-page (на узком экране — 16 px).
      page: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden',
        fontSize: 13,
      },
      // Центрированный контейнер контента: до 960 px по центру окна.
      container: {
        width: '100%',
        maxWidth: 960,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxSizing: 'border-box',
      },
      // Шапка: иконка в круге, название, подзаголовок, чип и «Обновить».
      header: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', width: '100%' },
      headerIcon: {
        width: 52,
        height: 52,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        background: 'var(--dsw-alias-brand-primary, rgba(80,120,200,0.9))',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
      },
      headerText: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px', minWidth: 0 },
      headerSide: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      pageTitle: {
        margin: 0,
        fontSize: 21,
        lineHeight: 1.25,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      subtitle: {
        margin: 0,
        fontSize: 12.5,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.95))',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 11px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      chipDot: { width: 8, height: 8, borderRadius: 4, flex: '0 0 auto' },
      sections: { display: 'flex', flexDirection: 'column', gap: 16 },
      // Секция-карточка: единые поля 16/18 px и радиус 14.
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minWidth: 0,
        padding: '16px 18px',
        boxSizing: 'border-box',
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.045))',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      cardTitle: {
        margin: 0,
        fontSize: 14,
        lineHeight: 1.35,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      cardBody: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
      cardActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      // Строка статуса на странице синхронизации: результат автозапуска.
      statusPanel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 16px',
        boxSizing: 'border-box',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
        background: 'var(--dsw-alias-card-fill, rgba(128,128,128,0.045))',
      },
      accent: { width: 3, height: 16, borderRadius: 2, background: 'var(--dsw-alias-brand-primary, rgba(80,120,200,0.75))', flex: '0 0 auto' },
      hint: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.95))', overflowWrap: 'anywhere' },
      row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 },
      dot: { width: 8, height: 8, borderRadius: 4, flex: '0 0 auto' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 500 },
      field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
      label: { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary, inherit)' },
      get input() {
        return {
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 11px',
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.35))',
          background: 'var(--dsw-alias-bg-base, transparent)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          fontSize: 13,
          fontFamily: 'inherit',
          colorScheme: themeScheme(),
        };
      },
      buttons: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
      // Кнопки — единая система (`.tools/plugin-design-spec-v2.md`):
      // высота 36 (в шапке 32), padding 0 14, радиус 10, шрифт 600 12.5,
      // ширина по тексту. Только токены темы; мягкие заливки вместо белого.
      button: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 36,
        padding: '0 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12.5,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'background-color .14s ease, border-color .14s ease, color .14s ease',
      },
      buttonSmall: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 32,
        padding: '0 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12.5,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'background-color .14s ease, border-color .14s ease, color .14s ease',
      },
      primary: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 36,
        padding: '0 14px',
        borderRadius: 10,
        border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dcc) 55%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dcc) 18%, transparent)',
        color: 'var(--dsw-alias-brand-primary, #4a7dcc)',
        fontSize: 12.5,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'background-color .14s ease, border-color .14s ease, color .14s ease',
      },
      danger: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 36,
        padding: '0 14px',
        borderRadius: 10,
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d1242f) 50%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d1242f) 16%, transparent)',
        color: 'var(--dsw-alias-state-error-primary, #d1242f)',
        fontSize: 12.5,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'background-color .14s ease, border-color .14s ease, color .14s ease',
      },
      note: {
        fontSize: 12,
        lineHeight: 1.5,
        padding: '9px 11px',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.10))',
      },
      error: {
        fontSize: 12,
        lineHeight: 1.5,
        padding: '9px 11px',
        borderRadius: 10,
        background: 'rgba(209,36,47,0.12)',
        border: '1px solid var(--dsw-alias-state-error-primary, rgba(209,36,47,0.35))',
      },
      ok: {
        fontSize: 12,
        lineHeight: 1.5,
        padding: '9px 11px',
        borderRadius: 10,
        background: 'rgba(40,150,80,0.12)',
        border: '1px solid var(--dsw-alias-state-success-primary, rgba(40,150,80,0.35))',
      },
      meta: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.8))', overflowWrap: 'anywhere' },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 },
      // Панель действий внизу: «Сохранить», «Создать репозиторий», «Диагностика».
      actions: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        padding: '12px 16px',
        boxSizing: 'border-box',
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
      },
      actionsText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      statusRow: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 },
    };

    async function post(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        const error = new Error(`${response.status} ${path}${text ? `: ${text.slice(0, 200)}` : ''}`);
        error.status = response.status;
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch {
        const error = new Error(`ответ без JSON: ${text.slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }
    }

    /** GET-маршрут (онбординг): только чтение, без тела запроса. */
    async function get(path) {
      const response = await fetch(path, { method: 'GET', credentials: 'same-origin' });
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        const error = new Error(`${response.status} ${path}${text ? `: ${text.slice(0, 200)}` : ''}`);
        error.status = response.status;
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        const errorJson = new Error(`ответ без JSON: ${text.slice(0, 200)}`);
        errorJson.status = response.status;
        throw errorJson;
      }
    }

    function explain(error) {
      const message = String(error?.message ?? error);
      if (error?.status === 404) {
        return `${message}. Host-часть плагина не загрузилась — полностью закройте DSH (включая значок в трее) и запустите снова, обновления страницы недостаточно.`;
      }
      return message;
    }

    /* --- статус и ошибки резервного канала ----------------------------- */

    // Тестовые крючки: подмена черновика без настоящего React. В живом
    // интерфейсе не используются — `__test.setDraft`/`resetDraft`.
    let draftOverride = null;
    let touchedOverride = false;
    // Компонент полосы прогресса резерва живёт внутри apply(); сюда кладём
    // ссылку, чтобы headless-тест мог отрисовать его через `__test`.
    let reserveProgressComponent = null;

    /**
     * Статус резервного канала для бейджа карточки. Состояния из аудита:
     * не включён / не сохранён / не сверен / сверяется / сверен / ошибка.
     * `init` — живой прогресс полной сверки (`data.secondary.init`).
     */
    function reserveStatusOf({ secondary, activeBackend, dirty, probe, init } = {}) {
      const backend = activeBackend ?? secondary?.backend ?? 'none';
      if (backend === 'none') {
        return { key: 'off', label: 'не включён', tone: 'muted', hint: 'Резерв выключен: сессии хранятся только в основном хранилище.' };
      }
      if (dirty === true) {
        return { key: 'dirty', label: 'не сохранён', tone: 'warn', hint: 'Настройки резерва ещё не сохранены — сначала «Сохранить», потом «Сверить».' };
      }
      // Полная сверка идёт прямо сейчас: это отдельное состояние, не ошибка.
      const comparing = init?.running === true
        || secondary?.init?.running === true
        || secondary?.status?.running === true;
      if (comparing) {
        const progress = init?.progress ?? secondary?.init?.progress ?? secondary?.status?.progress ?? null;
        const done = Number(progress?.filesDone ?? 0);
        const total = Number(progress?.filesTotal ?? 0);
        return {
          key: 'comparing',
          label: 'сверяется',
          tone: 'info',
          hint: total > 0
            ? `Полная сверка идёт: ${done} из ${total} файлов. Уже скачанное сохраняется — сверку можно отменить.`
            : 'Полная сверка идёт: читаем состав облака. Уже скачанное сохраняется — сверку можно отменить.',
        };
      }
      const status = secondary?.status;
      // Отмена — не ошибка канала: после неё резерв снова «не сверен».
      const statusFailed = status !== undefined && status !== null
        && status.ok === false
        && status.cancelled !== true
        && !/needs-compare|cancelled|отмен/i.test(String(status.code ?? ''));
      if ((probe !== null && probe !== undefined && probe.ok === false) || statusFailed) {
        const source = probe !== null && probe !== undefined && probe.ok === false ? probe : status;
        return { key: 'error', label: 'ошибка', tone: 'error', hint: reserveErrorText(source) };
      }
      if (secondary?.initialized === true) {
        return { key: 'synced', label: 'сверен', tone: 'ok', hint: 'Состав облака сверен: отправка в резерв разрешена.' };
      }
      return { key: 'not-synced', label: 'не сверен', tone: 'warn', hint: 'Сначала сверка: отправка в резерв заблокирована, пока состав облака не проверен.' };
    }

    /**
     * Человеческий текст ошибки сверки: 401/403, таймаут, TLS, квота, сеть и
     * неподдерживаемый канал — с действием, а не «HTTP 403». Если известен
     * файл, на котором сорвалось скачивание, он называется в тексте.
     */
    function reserveErrorText(result) {
      const code = String(result?.code ?? '');
      const message = String(result?.message ?? '');
      const both = `${code} ${message}`;
      const file = typeof result?.file === 'string' && result.file !== '' ? result.file : '';
      const withFile = (text) => (file === '' ? text : `${text} Файл: ${file}.`);
      if (/secondary\/not-configured/.test(code)) {
        return 'Резерв не включён: выберите режим в карточке «Резервный канал» и нажмите «Сохранить».';
      }
      if (/reserve\/unsupported/.test(code) || result?.skipped === true) {
        return 'Этот канал не умеет лёгкую сверку (только PROPFIND и манифест). Нажмите «Синхронизировать резерв» — она выполнит полную сверку с загрузкой.';
      }
      if (/reserve\/unauthorized|\b401\b|\b403\b|не принял логин|пароль приложения/i.test(both)) {
        return withFile('Логин или пароль приложения не принят (401/403). Проверьте логин Яндекс.Диска и пароль приложения «Файлы», затем сохраните настройки и повторите сверку.');
      }
      if (/reserve\/timeout|уложилась/i.test(both)) {
        return withFile('Облако не ответило за отведённое время (10–30 с). Проверьте интернет и повторите «Сверить»; для крупного облака используйте «Синхронизировать резерв».');
      }
      if (/Timeout|timeout|истекло/i.test(both)) {
        return withFile('Облако не ответило за отведённое время (файл — 30 с, операция — 15 мин). Проверьте интернет и повторите: уже скачанное не скачивается заново, сверка продолжится с места остановки.');
      }
      if (/TLS|SSL|certificate|schannel|EPROTO|сертификат/i.test(both)) {
        return 'Соединение TLS не установлено: проверьте системные сертификаты и время на компьютере, затем повторите сверку.';
      }
      if (/quota|507|недостаточно места|места на диске|переполнен/i.test(both)) {
        return 'В облаке закончилось место или превышен лимит запросов. Освободите место на Диске и повторите сверку — скачанное сохранено.';
      }
      if (/cancelled|отменена/i.test(both)) {
        return 'Сверка отменена. Уже скачанное сохранено: при следующем запуске скачивание продолжится с места остановки.';
      }
      if (/network|сеть|fetch failed|ECONN|EACCES|ENOTFOUND|оборвалось/i.test(both)) {
        return withFile('Сеть недоступна или соединение оборвалось. Проверьте интернет и повторите: скачивание продолжится с места остановки.');
      }
      return withFile(message || 'Сверка резерва не удалась: проверьте настройки канала и повторите.');
    }

    /** Есть ли несохранённые изменения в карточке «Хранилище». */
    function storageDirtyOf(draft, saved) {
      const current = draft ?? {};
      const stored = saved ?? {};
      const same = (left, right) => String(left ?? '') === String(right ?? '');
      return !(
        same(current.backend ?? 'git', stored.backend ?? 'git')
        && same(current.branch ?? 'main', stored.branch ?? 'main')
        && same(current.remote, stored.remote)
        && same(current.repoDir, stored.repoDir)
        && same(current.projectPath, stored.projectPath)
        && same(current.projectId, stored.projectId)
        && (current.attachments === true) === (stored.attachments === true)
      );
    }


    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-sync: card dictionaries');
      try {
        ctx.effect(() => {
          const style = document.createElement('style');
          // Общий слой оформления: им пользуются карточка плагина и страница
          // синхронизации, поэтому кнопки и поля ведут себя одинаково.
          style.textContent = [
            '@keyframes dsh-sync-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
            // Кнопки — единая система: secondary по умолчанию, primary — класс
            // dshs-btn-primary (мягкая заливка brand). Ширина по тексту.
            '.dshs-card button{transition:background-color .12s ease,border-color .12s ease,color .12s ease;min-width:0;max-width:100%}',
            '.dshs-card button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16)) !important;border-color:var(--dsw-alias-border-l4,rgba(150,150,150,0.65))}',
            '.dshs-card button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,0.24)) !important}',
            '.dshs-card button.dshs-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 28%,transparent) !important}',
            '.dshs-card button:disabled{opacity:.55;cursor:default}',
            '.dshs-card button:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px}',
            '.dshs-card input:focus-visible,.dshs-card select:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:1px}',
            '.dshs-card select:hover{border-color:var(--dsw-alias-border-l4,rgba(150,150,150,0.65))}',
            '.dshs-card select,.dshs-card select option{color-scheme:inherit;background-color:transparent;color:inherit}',
            '.dshs-card select option{background:var(--dsw-alias-bg-layer-2,#22242a);color:var(--dsw-alias-label-primary,#f2f2f2)}',
            '.dshs-card select option:checked{background:var(--dsw-alias-interactive-bg-active,#3a3f4b);color:var(--dsw-alias-label-primary,#ffffff)}',
            '.dshs-card a{color:inherit}',
            // Страница синхронизации: симметричные поля по краям, на узком
            // экране — 16 px, чтобы контент не прилипал к краям окна.
            '.dshs-sync-page{padding:28px 24px 48px;overflow-wrap:anywhere}',
            '@media (max-width:900px){.dshs-sync-page{padding:20px 18px 36px}}',
            '@media (max-width:640px){.dshs-sync-page{padding:16px 14px 28px}.dshs-sync-header{gap:10px}.dshs-sync-container{min-width:0}}',
            '.dshs-sync-card{transition:background-color .15s ease,border-color .15s ease;overflow-wrap:anywhere}',
            '.dshs-sync-card:hover{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,0.35))}',
            '.dshs-sync-chip{transition:background-color .15s ease}',
            // Пункт меню сессии: локальная/облачная. Тот же вид, что у пунктов
            // штатного меню, но со своей иконкой и состоянием.
            '.dshs-menu-item{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12.5px;font-weight:500;text-align:left;cursor:pointer;white-space:nowrap}',
            '.dshs-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16))}',
            '.dshs-menu-item:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:1px}',
            '.dshs-menu-separator{height:1px;margin:4px 8px;background:var(--dsw-alias-border-l2,rgba(128,128,128,0.22))}',
            // Chips фильтра и строки списка сессий.
            '.dshs-modes-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.35));background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}',
            '.dshs-modes-chip[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 16%,transparent);border-color:var(--dsw-alias-brand-primary,#4a7dcc)}',
            '.dshs-modes-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16))}',
            '.dshs-modes-row{display:flex;align-items:center;gap:10px;min-width:0;padding:7px 10px;border-radius:10px;border:1px solid transparent}',
            '.dshs-modes-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1));border-color:var(--dsw-alias-border-l2,rgba(128,128,128,0.22))}',
            '.dshs-modes-list{display:flex;flex-direction:column;gap:4px;min-width:0;max-height:320px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}',
            '.dshs-ws-hint{display:flex;flex-direction:column;gap:6px;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.05)}',
            // --- индикатор синхронизации сессии по макету -------------------
            // Облако 26×18 со свечением + полоса 24×3 (радиус 1.5) под ним.
            // Локальная сессия — монитор 20×16 без полосы. Свечение и анимации
            // выключаются при prefers-reduced-motion, заполнение остаётся.
            '.dshs-ind{position:relative;display:inline-flex;flex-direction:column;align-items:center;gap:2px;flex:0 0 auto;width:26px;padding:0;border:0;background:transparent;line-height:0;outline:none}',
            '.dshs-ind:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px;border-radius:6px}',
            '.dshs-ind-cloud{position:relative;display:block;width:26px;height:18px;filter:drop-shadow(0 0 2.5px var(--dshs-ind-glow,transparent))}',
            '.dshs-ind[data-state="synced"]{--dshs-ind-glow:rgba(72,130,255,0.55)}',
            '.dshs-ind[data-state="pending"]{--dshs-ind-glow:rgba(247,190,76,0.45)}',
            '.dshs-ind[data-state="exchanging"]{--dshs-ind-glow:rgba(72,130,255,0.6)}',
            '.dshs-ind[data-state="conflict"]{--dshs-ind-glow:rgba(236,96,100,0.6)}',
            '.dshs-ind[data-state="offline"]{--dshs-ind-glow:transparent}',
            '.dshs-ind[data-state="local"]{--dshs-ind-glow:transparent}',
            '.dshs-ind svg{display:block;overflow:visible}',
            '.dshs-ind-bar{position:relative;display:block;width:24px;height:3px;border-radius:1.5px;background:rgba(126,134,148,0.28);overflow:hidden}',
            '.dshs-ind-bar>span{display:block;height:100%;border-radius:1.5px}',
            '.dshs-ind-bar-fill-synced,.dshs-ind-bar-fill-exchanging{background:linear-gradient(90deg,#6EE2FF,#4882FF)}',
            '.dshs-ind-bar-fill-pending{background:#F7BE4C}',
            '.dshs-ind-bar-fill-conflict{background:#EC6064}',
            '.dshs-ind-bar-fill-offline{background:#7E8694}',
            '.dshs-ind-dot{position:absolute;top:1px;right:0;width:4px;height:4px;border-radius:50%;background:#F7BE4C;opacity:.95}',
            // «!» у конфликта остаётся и при reduced-motion: одну красную
            // заливку без анимации иначе не отличить от synced.
            '.dshs-ind-bang{position:absolute;right:0;top:-1px;font-size:10px;line-height:12px;font-weight:800;color:#EC6064;text-shadow:0 0 6px rgba(236,96,100,.75)}',
            '.dshs-ind-run{position:absolute;top:0;left:0;width:3px;height:3px;border-radius:50%;background:#EAF6FF}',
            '.dshs-ind-tip{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:5;max-width:240px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.35));background:var(--dsw-alias-bg-layer-2,#22242a);color:var(--dsw-alias-label-primary,#f2f2f2);font-size:11px;line-height:15px;font-weight:500;white-space:normal;text-align:left;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease}',
            '.dshs-ind:hover .dshs-ind-tip,.dshs-ind:focus-visible .dshs-ind-tip{opacity:1;visibility:visible}',
            '@keyframes dshs-ind-pulse{0%,100%{opacity:.95;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}',
            '@keyframes dshs-ind-run{0%{transform:translateX(0)}100%{transform:translateX(21px)}}',
            '@keyframes dshs-ind-breathe{0%,100%{filter:drop-shadow(0 0 2px rgba(236,96,100,.45))}50%{filter:drop-shadow(0 0 6px rgba(236,96,100,.95))}}',
            '.dshs-ind[data-state="pending"] .dshs-ind-dot{animation:dshs-ind-pulse 1.6s ease-in-out infinite}',
            '.dshs-ind[data-state="exchanging"] .dshs-ind-run{animation:dshs-ind-run 1.1s linear infinite}',
            '.dshs-ind[data-state="conflict"] .dshs-ind-cloud{animation:dshs-ind-breathe 2.4s ease-in-out infinite}',
            '@media(prefers-reduced-motion:reduce){.dshs-ind-dot,.dshs-ind-run,.dshs-ind-cloud{animation:none !important}.dshs-ind-tip{transition:none}}',
            // Режим по умолчанию для рабочих пространств и подсказка об
            // облачной копии локальной сессии.
            '.dshs-ws-defaults{display:flex;flex-direction:column;gap:6px;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.05)}',
            '.dshs-ws-default-row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}',
            '.dshs-ws-default-row>span{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshs-cloud-copy{display:flex;flex-direction:column;gap:4px;min-width:0;padding:7px 9px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,0.35));background:rgba(247,190,76,0.08)}',
            '.dshs-cloud-copy-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
            // Переключатель режима в шапке сессии: чип 32 px, меню и тост
            // рисуются порталом в body (слот шапки обрезает выпадающие блоки).
            '.dshs-mode-toggle{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.35));background:transparent;color:inherit;font:inherit;font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;min-width:0;max-width:100%}',
            '.dshs-mode-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16));border-color:var(--dsw-alias-border-l4,rgba(150,150,150,0.65))}',
            '.dshs-mode-toggle:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px}',
            '.dshs-mode-toggle:disabled{opacity:.55;cursor:default}',
            '.dshs-mode-toggle[data-mode="local"]{background:rgba(128,128,128,0.12);border-color:rgba(128,128,128,0.45)}',
            '.dshs-mode-toggle-chev{font-size:10px;opacity:.7}',
            '.dshs-mode-layer{position:fixed;inset:0;z-index:70;display:flex;align-items:flex-start;justify-content:flex-end;padding:64px 16px 16px;background:transparent}',
            '.dshs-mode-menu{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:min(340px,calc(100vw - 24px));min-width:0;max-height:min(70vh,520px);overflow-y:auto;overscroll-behavior:contain;padding:14px 16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.28));background:var(--dsw-alias-bg-base,#22242a);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 18px 50px rgba(0,0,0,0.45)}',
            '.dshs-mode-menu-title{font-size:13.5px;font-weight:600;line-height:1.3}',
            '.dshs-mode-menu-text{font-size:12px;line-height:1.5;text-align:justify;hyphens:auto;overflow-wrap:normal;word-break:normal;color:var(--dsw-alias-label-secondary,rgba(128,128,128,0.95))}',
            '.dshs-mode-menu-warn{font-size:12px;line-height:1.5;padding:9px 11px;border-radius:10px;border:1px solid rgba(247,190,76,0.45);background:rgba(247,190,76,0.12)}',
            '.dshs-mode-menu-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            '.dshs-mode-menu-actions button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border-radius:10px;font:inherit;font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,0.35));background:transparent;color:inherit;min-width:0;max-width:100%}',
            '.dshs-mode-menu-actions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16))}',
            '.dshs-mode-menu-actions button:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px}',
            '.dshs-mode-menu-actions button[data-variant="primary"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 18%,transparent);color:var(--dsw-alias-brand-primary,#4a7dcc)}',
            '.dshs-mode-menu-actions button:disabled{opacity:.55;cursor:default}',
            '.dshs-mode-toast{position:fixed;right:16px;bottom:16px;z-index:85;display:flex;align-items:center;gap:10px;box-sizing:border-box;max-width:min(420px,calc(100vw - 24px));padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.28));background:var(--dsw-alias-bg-base,#22242a);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 12px 36px rgba(0,0,0,0.42);font-size:12.5px;line-height:1.4}',
            '.dshs-mode-toast-text{flex:1 1 auto;min-width:0}',
            '.dshs-mode-toast-left{font-size:11.5px;opacity:.75;white-space:nowrap}',
            '.dshs-mode-toast button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,0.35));background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer;flex:0 0 auto}',
            '.dshs-mode-toast button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16))}',
            '.dshs-mode-toast button:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px}',
            '@media (max-width:640px){.dshs-mode-layer{padding:56px 10px 10px;justify-content:center}.dshs-mode-toast{left:10px;right:10px;max-width:none}}',
            // «Дубли»: карточка поиска, список групп и действия карантина.
            '.dshs-duplicates-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.05)}',
            '.dshs-duplicates-groups{display:flex;flex-direction:column;gap:6px;min-width:0;max-height:260px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}',
            '.dshs-duplicates-group{display:flex;flex-direction:column;gap:2px;min-width:0;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.04)}',
            '.dshs-duplicates-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            '.dshs-duplicates-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            // «Удалённые»: строки карантина и кнопка восстановления.
            '.dshs-deleted-list{display:flex;flex-direction:column;gap:4px;min-width:0;max-height:260px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}',
            '.dshs-deleted-row{display:flex;align-items:center;gap:10px;min-width:0;padding:7px 10px;border-radius:10px;border:1px solid transparent}',
            '.dshs-deleted-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1));border-color:var(--dsw-alias-border-l2,rgba(128,128,128,0.22))}',
            '.dshs-deleted-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}',
            // --- группы «родитель + субагенты» ------------------------------
            // Субагенты вложены под родителем: отступ и вертикальная линия связи.
            '.dshs-modes-row[data-subagent="true"]{margin-left:18px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));border-radius:0 10px 10px 0}',
            '.dshs-group-toggle{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.35));background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer;white-space:nowrap;flex:0 0 auto}',
            '.dshs-group-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16));border-color:var(--dsw-alias-border-l4,rgba(150,150,150,0.65))}',
            '.dshs-group-toggle:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px}',
            '.dshs-group-toggle[data-open="true"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 16%,transparent)}',
            // «+N»: сколько субагентов свёрнуто под родителем.
            '.dshs-group-badge{box-sizing:border-box;display:inline-flex;align-items:center;height:22px;padding:0 7px;border-radius:7px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 12%,transparent);font-size:11px;font-weight:700;line-height:1;white-space:nowrap;flex:0 0 auto}',
            // «сирота»: субагент без родителя на этом устройстве.
            '.dshs-orphan-badge{box-sizing:border-box;display:inline-flex;align-items:center;height:22px;padding:0 7px;border-radius:7px;border:1px dashed rgba(247,190,76,0.6);background:rgba(247,190,76,0.14);font-size:11px;font-weight:600;line-height:1;white-space:nowrap;flex:0 0 auto;cursor:help}',
            '.dshs-groups-counter{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-height:24px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.06);font-size:11.5px;font-weight:600;line-height:1.2;white-space:nowrap;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
            // Заголовок карточки не распирает шапку: счётчик уходит вправо и
            // переносится, если места мало.
            '.dshs-sync-card h2{min-width:0;overflow-wrap:anywhere}',
            '@media (max-width:640px){.dshs-groups-counter{white-space:normal;font-size:11px}.dshs-sync-card h2{flex:1 1 auto}}',
            // --- перестроенная страница: 4 карточки + 2 аккордеона --------
            // Аккордеон второстепенных секций: заголовок-кнопка и тело.
            '.dshs-accordion{display:flex;flex-direction:column;min-width:0;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,0.045));overflow:hidden}',
            '.dshs-accordion-head{width:100%;box-sizing:border-box;justify-content:flex-start;gap:10px;text-align:left}',
            '.dshs-accordion-head:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16)) !important}',
            '.dshs-accordion-body{display:flex;flex-direction:column;gap:16px;min-width:0;padding:14px 16px 16px}',
            '.dshs-accordion-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 45%,transparent)}',
            '.dshs-accordion-danger .dshs-accordion-head{color:var(--dsw-alias-state-error-primary,#d1242f)}',
            '.dshs-accordion-danger .dshs-accordion-body{border-top:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 28%,transparent);padding-top:14px}',
            '@media (max-width:640px){.dshs-accordion-body{padding:12px 12px 14px}.dshs-accordion-summary{display:none}}',
            // Свёрнутый блок результата проверки (корзины, группы дублей).
            '.dshs-collapsible{display:flex;flex-direction:column;gap:8px;min-width:0;padding:8px 10px;border-radius:10px;border:1px solid rgba(128,128,128,0.22);background:rgba(128,128,128,0.04)}',
            '.dshs-collapsible-head{width:100%;box-sizing:border-box;justify-content:flex-start;gap:8px;text-align:left}',
            '.dshs-collapsible-head:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16)) !important}',
            '.dshs-collapsible-body{display:flex;flex-direction:column;gap:10px;min-width:0}',
            // «Сохранить» рядом с полями и бейдж «есть изменения».
            '.dshs-save-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}',
            '.dshs-save-badge{box-sizing:border-box;display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:8px;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap}',
            // Статус резерва и результат лёгкой сверки.
            '.dshs-reserve-status{box-sizing:border-box;display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:8px;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap}',
            '.dshs-reserve-probe{display:flex;flex-direction:column;gap:4px;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid rgba(128,128,128,0.24);background:rgba(128,128,128,0.06)}',
            // Полоса прогресса полной сверки резерва: файлы/МБ, текущий файл,
            // «Отменить». Адаптив: шапка и подписи переносятся, ничего не вылезает.
            '.dshs-reserve-progress{display:flex;flex-direction:column;gap:7px;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid rgba(128,128,128,0.24);background:rgba(128,128,128,0.06)}',
            '.dshs-reserve-progress-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;min-width:0}',
            '.dshs-reserve-progress-title{font-size:12.5px;font-weight:600;line-height:1.3;min-width:0}',
            '.dshs-reserve-progress-count{font-size:11.5px;font-weight:600;line-height:1.3;opacity:.85;white-space:nowrap;flex:0 0 auto}',
            '.dshs-reserve-progress-track{position:relative;height:6px;border-radius:3px;background:rgba(128,128,128,0.24);overflow:hidden}',
            '.dshs-reserve-progress-fill{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#6EE2FF,#4882FF);transition:width .3s ease}',
            '.dshs-reserve-progress[data-state="error"] .dshs-reserve-progress-fill{background:linear-gradient(90deg,#f07070,#d1242f)}',
            '.dshs-reserve-progress-meta{font-size:11.5px;line-height:1.5;opacity:.82;overflow-wrap:anywhere}',
            '.dshs-reserve-progress-file{font-size:11.5px;line-height:1.45;opacity:.72;overflow-wrap:anywhere;word-break:break-word}',
            '.dshs-reserve-progress-error{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#d1242f);overflow-wrap:anywhere;text-align:justify;hyphens:auto}',
            '.dshs-reserve-progress-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:2px}',
            '@media (prefers-reduced-motion:reduce){.dshs-reserve-progress-fill{transition:none}}',
            '@media (max-width:480px){.dshs-reserve-progress{padding:9px 10px}.dshs-reserve-progress-count{white-space:normal}}',
            '.dshs-danger-block{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid rgba(209,36,47,0.28);background:rgba(209,36,47,0.06)}',
            // Поиск по списку сессий: поле и «Показать ещё».
            '.dshs-sessions-search{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            '.dshs-sessions-search input{flex:1 1 200px;min-width:0}',
            '.dshs-sessions-more{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            // --- M4: карточка онбординга нового устройства ------------------
            // Чип в шапке карточки «Сессии и режим»: 32 px, как остальные чипы.
            '.dshs-onboarding-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.35));background:transparent;color:inherit;font:inherit;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;min-width:0;max-width:100%}',
            '.dshs-onboarding-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16));border-color:var(--dsw-alias-border-l4,rgba(150,150,150,0.65))}',
            '.dshs-onboarding-chip:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px}',
            '.dshs-onboarding-chip[data-ready="true"]{border-color:rgba(47,158,68,0.5);background:rgba(47,158,68,0.1);color:var(--dsw-alias-state-success-primary,#2f9e44)}',
            '.dshs-onboarding-chip[data-count="0"]{opacity:.9}',
            '.dshs-onboarding-steps{display:flex;flex-direction:column;gap:8px;min-width:0;max-height:420px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}',
            '.dshs-onboarding-step{display:flex;align-items:flex-start;gap:10px;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.045)}',
            '.dshs-onboarding-step[data-status="fail"]{border-color:rgba(209,36,47,0.42);background:rgba(209,36,47,0.075)}',
            '.dshs-onboarding-step[data-status="warn"]{border-color:rgba(247,190,76,0.42);background:rgba(247,190,76,0.075)}',
            '.dshs-onboarding-step[data-status="ok"]{border-color:rgba(47,158,68,0.32)}',
            '.dshs-onboarding-step-text{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}',
            '.dshs-onboarding-step-title{font-size:12.5px;font-weight:600;line-height:1.3}',
            '.dshs-onboarding-step-detail{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(128,128,128,0.95));text-align:justify;hyphens:auto;overflow-wrap:anywhere}',
            '.dshs-onboarding-badge{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:8px;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap;flex:0 0 auto}',
            '.dshs-onboarding-block{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.05)}',
            '.dshs-onboarding-block[data-status="off"]{border-color:rgba(247,190,76,0.42);background:rgba(247,190,76,0.07)}',
            '.dshs-onboarding-block-title{font-size:12.5px;font-weight:600;line-height:1.3}',
            '.dshs-onboarding-list{margin:0;padding-left:18px;font-size:12px;line-height:1.5}',
            '.dshs-onboarding-allow{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
            '.dshs-onboarding-deny{color:var(--dsw-alias-state-error-primary,#d1242f)}',
            '.dshs-onboarding-commands{display:flex;flex-direction:column;gap:6px;min-width:0}',
            '.dshs-onboarding-command{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            '.dshs-onboarding-command code{flex:1 1 220px;min-width:0;overflow-wrap:anywhere;font-size:11.5px;line-height:1.45;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(0,0,0,0.18)}',
            '.dshs-secret-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:1.5}',
            '@media (max-width:640px){.dshs-onboarding-step{flex-wrap:wrap}.dshs-onboarding-step .dshs-onboarding-badge{order:-1}.dshs-onboarding-steps{max-height:none}.dshs-onboarding-chip{height:32px;font-size:11px;padding:0 10px}}',
            // --- M6: правила сессий ------------------------------------------
            // Карточка «Правила» внутри «Сессии и режим»: шапка, фильтры, список
            // с прокруткой (max-height 320), бейджи пресета/владельца/лимита и
            // отчёт «Проверить правила» корзинами. Радиус 14, границы из токенов.
            '.dshs-rules-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,0.045))}',
            '.dshs-rules-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            '.dshs-rules-title{margin:0;display:flex;align-items:center;gap:8px;min-width:0;font-size:13.5px;line-height:1.35;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
            '.dshs-rules-accent{width:3px;height:16px;border-radius:2px;background:var(--dsw-alias-brand-primary,rgba(80,120,200,0.75));flex:0 0 auto}',
            '.dshs-rules-summary{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;min-height:24px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.06);font-size:11.5px;font-weight:600;line-height:1.2;white-space:nowrap;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
            '.dshs-rules-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
            '.dshs-rules-list{display:flex;flex-direction:column;gap:4px;min-width:0;max-height:320px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}',
            '.dshs-rules-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding:7px 10px;border-radius:10px;border:1px solid transparent}',
            '.dshs-rules-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1));border-color:var(--dsw-alias-border-l2,rgba(128,128,128,0.22))}',
            '.dshs-rules-row-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 180px}',
            '.dshs-rules-row-title{font-size:12.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshs-rules-shield{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--dsw-alias-state-success-primary,#2f9e44)}',
            '.dshs-rules-shield[data-protected="false"]{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,0.8))}',
            '.dshs-rules-badge{box-sizing:border-box;display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.35));background:rgba(128,128,128,0.1);font-size:11px;font-weight:600;line-height:1;white-space:nowrap;flex:0 0 auto}',
            '.dshs-rules-badge[data-tone="preset"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 12%,transparent)}',
            '.dshs-rules-badge[data-tone="warn"]{border-color:rgba(247,190,76,0.6);background:rgba(247,190,76,0.14)}',
            '.dshs-rules-badge[data-tone="owner"]{border-color:rgba(112,72,232,0.45);background:rgba(112,72,232,0.12)}',
            '.dshs-rules-badge[data-tone="limit"]{border-color:rgba(209,36,47,0.5);background:rgba(209,36,47,0.12);color:var(--dsw-alias-state-error-primary,#d1242f)}',
            '.dshs-rules-notice{display:flex;flex-direction:column;gap:4px;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid rgba(247,190,76,0.45);background:rgba(247,190,76,0.1);font-size:11.5px;line-height:1.5;text-align:justify;hyphens:auto}',
            '.dshs-rules-grow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid rgba(247,190,76,0.5);background:rgba(247,190,76,0.1)}',
            '.dshs-rules-grow-text{flex:1 1 240px;min-width:0;font-size:12px;line-height:1.5;overflow-wrap:anywhere}',
            '.dshs-rules-report{display:flex;flex-direction:column;gap:6px;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.05)}',
            '.dshs-rules-buckets{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;min-width:0}',
            '.dshs-rules-bucket{display:flex;flex-direction:column;gap:2px;min-width:0;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));background:rgba(128,128,128,0.04)}',
            '.dshs-rules-bucket-label{font-size:11px;font-weight:600;line-height:1.3;opacity:.85}',
            '.dshs-rules-bucket-value{font-size:12.5px;font-weight:600;line-height:1.3}',
            '.dshs-rules-bucket-items{font-size:11px;line-height:1.45;opacity:.8;overflow-wrap:anywhere}',
            // Модалка «Правила сессии…»: портал в body, чипы пресетов (32 px),
            // поля, «Сохранить» рядом с «Проверить правила» (36 px).
            '.dshs-rules-layer{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:32px 16px;background:rgba(0,0,0,0.42)}',
            '.dshs-rules-dialog{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:min(560px,calc(100vw - 24px));min-width:0;max-height:min(86vh,720px);overflow-y:auto;overscroll-behavior:contain;padding:16px 18px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.28));background:var(--dsw-alias-bg-base,#22242a);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 18px 50px rgba(0,0,0,0.45)}',
            '.dshs-rules-dialog-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}',
            '.dshs-rules-dialog-title{flex:1 1 auto;min-width:0;font-size:14px;font-weight:600;line-height:1.35}',
            '.dshs-rules-dialog-text{font-size:12px;line-height:1.5;text-align:justify;hyphens:auto;overflow-wrap:normal;word-break:normal;color:var(--dsw-alias-label-secondary,rgba(128,128,128,0.95))}',
            '.dshs-rules-fields{display:flex;flex-direction:column;gap:8px;min-width:0}',
            '.dshs-rules-field{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0;font-size:12.5px;line-height:1.45}',
            '.dshs-rules-field input[type="checkbox"]{margin:0;flex:0 0 auto;accent-color:var(--dsw-alias-brand-primary,#4a7dcc)}',
            '.dshs-rules-field input[type="number"]{width:120px;flex:0 0 auto}',
            '.dshs-rules-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            '.dshs-rules-actions button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,0.35));background:transparent;color:inherit;font:inherit;font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;min-width:0;max-width:100%}',
            '.dshs-rules-actions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16))}',
            '.dshs-rules-actions button:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px}',
            '.dshs-rules-actions button[data-variant="primary"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 18%,transparent);color:var(--dsw-alias-brand-primary,#4a7dcc)}',
            '.dshs-rules-actions button:disabled{opacity:.55;cursor:default}',
            '.dshs-rules-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
            '.dshs-rules-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.35));background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;min-width:0;max-width:100%}',
            '.dshs-rules-chip[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 16%,transparent);border-color:var(--dsw-alias-brand-primary,#4a7dcc)}',
            '.dshs-rules-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.16))}',
            '.dshs-rules-chip:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dcc) 55%,transparent);outline-offset:2px}',
            '.dshs-rules-menu-icon{display:inline-flex;align-items:center;color:inherit;flex:0 0 auto}',
            '@media (max-width:640px){.dshs-rules-card{padding:12px}.dshs-rules-layer{padding:12px 8px}.dshs-rules-dialog{max-height:calc(100vh - 24px);padding:14px 14px}.dshs-rules-list{max-height:none}.dshs-rules-actions button{flex:1 1 auto}.dshs-rules-field input[type="number"]{width:100%;flex:1 1 120px}}',
          ].join('\n');
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-sync: styles');
      } catch (error) {
        console.error('[dsh-sync] анимация недоступна:', error);
      }


      const publish = (next) => {
        snapshot = { ...snapshot, ...next };
        for (const listener of listeners) listener();
      };

      const refresh = async () => {
        try {
          const data = await post(STATE_PATH, {});
          publish({ data, loading: false, error: data?.ok === false ? String(data.message ?? '') : '' });
        } catch (error) {
          publish({ loading: false, error: `Не удалось получить состояние: ${explain(error)}` });
        }
      };

      // M4: шаги онбординга забираются отдельным GET-маршрутом по кнопке
      // «Проверить» (в /state приходит только сводка ready/warn/fail).
      const refreshOnboarding = async () => {
        publish({ onboardingBusy: true, onboardingError: '' });
        try {
          const report = await get(ONBOARDING_PATH);
          publish({ onboarding: report ?? null, onboardingBusy: false });
          return report;
        } catch (error) {
          publish({ onboardingBusy: false, onboardingError: `Онбординг не получен: ${explain(error)}` });
          return null;
        }
      };

      // Действия шагов: только существующие маршруты плагина. Секреты при этом
      // не читаются и не передаются — меняется лишь то, что и раньше было в UI.
      const runOnboardingAction = async (routeName) => {
        const action = String(routeName ?? '');
        if (action === '' || action === 'refresh') return refreshOnboarding();
        // Опасное действие — двойное подтверждение: первый клик показывает
        // предупреждение, второй выполняет. Как в «Опасной зоне».
        if (action === 'local-only-migration' && snapshot.onboardingConfirm !== action) {
          publish({
            onboardingConfirm: action,
            onboardingBusy: false,
            onboardingError: '',
            onboardingNotice: 'Убрать облачные копии локальных сессий? Копии уйдут в карантин на 30 дней, сами сессии останутся локальными. Нажмите кнопку ещё раз для подтверждения.',
          });
          return null;
        }
        publish({ onboardingBusy: true, onboardingError: '', onboardingNotice: '', onboardingConfirm: '' });
        try {
          if (action === 'profile-apply') {
            const result = await post(PROFILE_APPLY_PATH, { action: 'apply' });
            publish({
              onboardingBusy: false,
              onboardingNotice: result?.ok === true
                ? `Профиль применён: файлов ${result.applied ?? 0}${(result.conflicts ?? 0) > 0 ? `, конфликтов: ${result.conflicts}` : ''}.`
                : (result?.message || 'Применение профиля не удалось.'),
            });
          } else if (action === 'local-only-migration') {
            const result = await post(LOCAL_ONLY_MIGRATION_PATH, { confirm: true });
            publish({
              onboardingBusy: false,
              onboardingNotice: result?.ok === true
                ? `Облачных копий локальных сессий убрано: ${result.removed ?? 0}.`
                : (result?.message ? `Не удалось убрать копии: ${result.message}` : 'Не удалось убрать облачные копии.'),
            });
            await refreshSessionStates(true);
          } else if (action === 'sync') {
            const result = await post(RUN_PATH, { action: 'sync' });
            publish({
              onboardingBusy: false,
              onboardingNotice: result?.message || (result?.ok === true ? 'Синхронизация выполнена.' : 'Синхронизация не удалась.'),
            });
            await refresh();
          } else if (action === 'settings') {
            // Значения секретов вводятся в настройках DSH, карточка показывает
            // только факт «есть/нет» — в браузер секреты не попадают.
            publish({
              onboardingBusy: false,
              onboardingNotice: 'Секреты вводятся в настройках DSH (Settings → Plugins) или в credential store. Здесь показывается только «есть/нет», без значений.',
            });
            return null;
          } else {
            publish({ onboardingBusy: false, onboardingNotice: `Неизвестное действие: ${action}` });
            return null;
          }
          await refreshOnboarding();
          return null;
        } catch (error) {
          publish({ onboardingBusy: false, onboardingError: `Действие не выполнено: ${explain(error)}` });
          return null;
        }
      };

      /** Скопировать git-команду нового устройства (без секретов в адресе). */
      const copyOnboardingCommand = async (command) => {
        const text = String(command ?? '');
        if (text === '') return;
        try {
          if (typeof navigator === 'undefined' || navigator?.clipboard === undefined) throw new Error('clipboard недоступен');
          await navigator.clipboard.writeText(text);
          publish({ onboardingNotice: 'Команда скопирована — вставьте её в терминал.' });
        } catch {
          publish({ onboardingNotice: `Не удалось скопировать автоматически. Команда: ${text}` });
        }
      };

      // Действия онбординга для headless-тестов и кнопок карточки.
      onboardingActions = {
        refresh: refreshOnboarding,
        run: runOnboardingAction,
        copy: copyOnboardingCommand,
      };


      // Состояние нужно и в панели, а не только на открытой странице плагина:
      // опрашиваем его сами, иначе строка в подвале всегда видит пустоту.
      try {
        ctx.effect(() => {
          let stopped = false;
          let timer;

          const tick = async () => {
            if (stopped) return;
            await refresh();
            void refreshTombstones(true);
            if (stopped) return;
            timer = setTimeout(() => void tick(), 30_000);
            timer?.unref?.();
          };

          void tick();
          return () => {
            stopped = true;
            clearTimeout(timer);
          };
        }, 'dsh-sync: состояние для панели');
      } catch (error) {
        console.error('[dsh-sync] опрос состояния недоступен:', error);
      }

      const save = async (draft) => {
        publish({ busy: 'save', notice: '', error: '' });
        try {
          const data = await post(CONFIG_PATH, draft);
          publish({ data, busy: '', notice: 'Настройки сохранены' });
          return true;
        } catch (error) {
          publish({ busy: '', error: `Не удалось сохранить: ${explain(error)}` });
          return false;
        }
      };

      const run = async (action, extra = {}) => {
        publish({ busy: action, notice: '', error: '' });
        try {
          const result = await post(RUN_PATH, { action, ...extra });
          if (result?.ok === true) {
            publish({ busy: '', notice: result.message || 'Готово' });
          } else {
            publish({ busy: '', error: result?.message ?? 'Синхронизация не удалась' });
          }
          await refresh();
          await refreshTombstones(true);
        } catch (error) {
          publish({ busy: '', error: `Синхронизация не удалась: ${explain(error)}` });
        }
      };


      /** Подпись хранилища по его типу. */
      const BACKEND_LABELS = {
        git: 'GitHub',
        webdav: 'Яндекс.Диск',
        yandex: 'Яндекс.Диск',
        folder: 'Папка',
      };

      /** Полоса готовности одного хранилища: подпись, процент, объём, шкала. */
      function ProgressRow({ label, percent, caption, note, done }) {
        const value = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)));
        const color = done ? '#2f9e44' : '#e8590c';
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 } },
            h('span', { style: { fontWeight: 600 } }, label),
            h('span', { style: { marginLeft: 'auto', fontWeight: 600 } }, done ? 'готово' : `${value}%`),
          ),
          h(
            'div',
            {
              style: {
                height: 6,
                borderRadius: 3,
                background: 'rgba(128,128,128,0.22)',
                overflow: 'hidden',
              },
            },
            h('div', {
              style: {
                width: `${done ? 100 : Math.max(1, value)}%`,
                height: '100%',
                borderRadius: 3,
                background: color,
                transition: 'width .3s ease',
              },
            }),
          ),
          h('span', { style: { fontSize: 11.5, opacity: 0.7 } }, note ?? caption),

        );
      }

      /** Два хранилища рядом: основное и резервное, с процентами и объёмами. */
      function SyncProgress({ data }) {
        const megabytes = (bytes) => `${(Number(bytes ?? 0) / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
        const status = data?.status;
        const backup = data?.backup;
        const backend = data?.config?.backend ?? 'git';
        const secondaryBackend = data?.secondaryBackend;
        const hasSecondary = typeof secondaryBackend === 'string' && secondaryBackend !== 'none';

        const primaryPercent = status && status.local > 0 ? (status.mirror / status.local) * 100 : 100;
        const primaryNote = status
          ? `${status.mirror} из ${status.local} сессий${status.onlyLocal > 0 ? `, ждут отправки: ${status.onlyLocal}` : ''}`
          : '';

        const rows = [
          h(ProgressRow, {
            key: 'primary',
            label: BACKEND_LABELS[backend] ?? 'Основное хранилище',
            percent: primaryPercent,
            done: primaryPercent >= 100,
            note: primaryNote,
          }),
        ];

        if (hasSecondary) {
          rows.push(
            h(ProgressRow, {
              key: 'secondary',
              label: BACKEND_LABELS[secondaryBackend] ?? 'Резервное хранилище',
              percent: backup?.percent ?? 0,
              done: (backup?.percent ?? 0) >= 100,
              note: backup
                ? `${megabytes(backup.doneBytes)} из ${megabytes(backup.totalBytes)} · ${backup.doneFiles} из ${backup.totalFiles} файлов`
                : 'готовится к выгрузке',
            }),
          );
        }

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 14, marginTop: 4 } },
          ...rows,
          // Резерв включён, но ещё не сверен: отправка в него заблокирована.
          hasSecondary && data?.secondary?.enabled === true && data?.secondary?.initialized === false
            ? h(
                'span',
                { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-warn-primary, #e8590c)' } },
                'Резерв не сверен с облаком — сначала сверка в карточке «Резервный канал».',
              )
            : null,
          // backupStatus в SyncProgress: причина сбоя резерва, если она есть.
          data?.backupStatus !== undefined && data.backupStatus.ok !== true && data.backupStatus.message !== ''
            ? h('span', { style: { fontSize: 11.5, color: '#d1242f' } }, data.backupStatus.message)
            : null,
        );
      }

      /** Фазы полной сверки — те же слова, что в статусе host-части. */
      const RESERVE_PHASES = {
        starting: 'подготовка',
        listing: 'читаем состав облака',
        download: 'скачиваем файлы',
        plan: 'считаем расхождения',
        pull: 'принимаем данные из облака',
        done: 'готово',
        error: 'ошибка',
        cancelled: 'отменено',
      };

      /** «1,4 МБ» из байт — как в остальных подписях страницы. */
      function megabytesText(bytes) {
        return `${(Number(bytes ?? 0) / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
      }

      /** Хвост длинного пути: имя файла и одна папка перед ним. */
      function shortReserveFile(rel) {
        const text = String(rel ?? '');
        const parts = text.split('/').filter((part) => part !== '');
        if (parts.length <= 2) return text;
        return `…/${parts.slice(-2).join('/')}`;
      }

      /**
       * Полоса прогресса полной сверки резерва (П6/П7).
       *
       * Показывает «N из M файлов», «X из Y МБ», текущий файл и фазу; во время
       * работы — кнопку «Отменить». После завершения — отчёт: скачано,
       * пропущено, ошибки с файлом и подсказкой. Источник данных —
       * `data.secondary.init` (живой снимок) и `data.secondary.status`
       * (сохранённый итог `scope: 'secondary-init'`).
       */
      function ReserveProgress({ init, status, busy, onCancel }) {
        const progress = init?.progress ?? null;
        const running = init?.running === true || status?.running === true;
        const totals = status?.totals ?? progress?.totals ?? null;
        const failedNow = status?.ok === false && running !== true;
        const report = status?.scope === 'secondary-init' || totals !== null;
        if (running !== true && report !== true && failedNow !== true) return null;
        const filesTotal = Number(progress?.filesTotal ?? totals?.files ?? 0);
        const filesDone = Number(progress?.filesDone ?? (totals ? Number(totals.downloaded ?? 0) + Number(totals.skipped ?? 0) : 0));
        const bytesTotal = Number(progress?.bytesTotal ?? totals?.bytes ?? 0);
        const bytesDone = Number(progress?.bytesDone ?? (running === true ? 0 : Number(totals?.bytes ?? 0)));
        const percent = Math.max(0, Math.min(100, Math.round(Number(
          progress?.percent ?? status?.percent ?? (running === true ? 0 : 100),
        ))));
        const phase = String(progress?.phase ?? status?.phase ?? (running === true ? 'download' : 'done'));
        const currentFile = typeof progress?.currentFile === 'string' ? progress.currentFile : '';
        const cancelRequested = init?.cancelRequested === true;
        const file = typeof status?.file === 'string' ? status.file : '';
        const hint = typeof status?.hint === 'string' && status.hint !== '' ? status.hint : '';
        const failText = failedNow
          ? `${status?.message || 'полная сверка резерва не удалась'}${file !== '' ? ` Файл: ${file}.` : ''}${hint !== '' ? ` ${hint}` : ''}`
          : '';
        const counts = totals !== null
          ? `скачано: ${Number(totals.downloaded ?? 0)} · пропущено: ${Number(totals.skipped ?? 0)}${Number(totals.failed ?? 0) > 0 ? ` · ошибок: ${Number(totals.failed)}` : ''}`
          : '';
        return h(
          'div',
          {
            className: 'dshs-reserve-progress',
            'data-state': running === true ? 'running' : failedNow ? 'error' : 'done',
          },
          h(
            'div',
            { className: 'dshs-reserve-progress-head' },
            h('span', { className: 'dshs-reserve-progress-title' }, running === true ? 'Полная сверка резерва' : 'Сверка резерва завершена'),
            h('span', { className: 'dshs-reserve-progress-count' }, `${filesDone} из ${filesTotal} файлов`),
          ),
          h(
            'div',
            {
              className: 'dshs-reserve-progress-track',
              role: 'progressbar',
              'aria-valuemin': '0',
              'aria-valuemax': '100',
              'aria-valuenow': String(percent),
              'aria-label': 'Прогресс полной сверки резерва',
            },
            h('span', { className: 'dshs-reserve-progress-fill', style: { width: `${percent}%` } }),
          ),
          h(
            'span',
            { className: 'dshs-reserve-progress-meta' },
            `${megabytesText(bytesDone)} из ${megabytesText(bytesTotal)} · ${percent}%${RESERVE_PHASES[phase] !== undefined ? ` · ${RESERVE_PHASES[phase]}` : ''}`,
          ),
          running === true && currentFile !== ''
            ? h('span', { className: 'dshs-reserve-progress-file', title: currentFile }, `сейчас: ${shortReserveFile(currentFile)}`)
            : null,
          running !== true && counts !== ''
            ? h('span', { className: 'dshs-reserve-progress-file' }, counts)
            : null,
          failText !== ''
            ? h('span', { className: 'dshs-reserve-progress-error' }, failText)
            : null,
          running === true
            ? h(
                'div',
                { className: 'dshs-reserve-progress-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshs-reserve-cancel',
                    style: S.buttonSmall,
                    disabled: busy === true && cancelRequested === true,
                    title: 'Остановить скачивание: уже скачанное останется, следующий запуск продолжит с места остановки',
                    onClick: () => { if (typeof onCancel === 'function') onCancel(); },
                  },
                  cancelRequested === true ? 'Отмена…' : 'Отменить',
                ),
              )
            : null,
        );
      }
      reserveProgressComponent = ReserveProgress;


      /** Иконка синхронизации: две стрелки по кругу (шапка страницы). */
      function SyncArrows({ size = 24 }) {
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('path', {
            d: 'M12.6 8A4.6 4.6 0 1 1 11.2 4.7',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
          }),
          h('path', {
            d: 'M12.7 2.5v2.7h-2.7',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        );
      }

      /**
       * Шапка страницы: иконка в круге, название, подзаголовок, статус-чип
       * (настроено / проверка / не настроено, время последней синхронизации)
       * и кнопка «Обновить» — она перечитывает состояние с host-части.
       */
      function SyncPageHeader({ data, loading }) {
        const ready = data?.ready === true;
        const last = data?.lastRun;
        const chipText = ready ? t('statusReady') : loading ? t('statusChecking') : t('statusOff');
        const chipColor = ready
          ? 'var(--dsw-alias-state-success-primary, #2f9e44)'
          : loading
            ? 'var(--dsw-alias-state-warn-primary, #e8590c)'
            : 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.8))';
        const lastText = last
          ? `${t('statusLast')}: ${new Date(last.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
          : t('statusNever');
        return h(
          'header',
          { className: 'dshs-sync-header', style: S.header },
          h('span', { style: S.headerIcon, 'aria-hidden': 'true' }, h(SyncArrows, { size: 24 })),
          h(
            'div',
            { style: S.headerText },
            h('h1', { style: S.pageTitle }, t('title')),
            h('p', { style: S.subtitle }, t('subtitle')),
          ),
          h(
            'div',
            { style: S.headerSide },
            h(
              'span',
              { className: 'dshs-sync-chip', style: S.chip },
              h('span', { style: { ...S.chipDot, background: chipColor } }),
              chipText,
            ),
            h('span', { style: S.meta }, lastText),
            h(
              'button',
              { type: 'button', style: S.buttonSmall, disabled: loading, onClick: () => void refresh() },
              t('actionRefresh'),
            ),
          ),
        );
      }

      /** Секция-карточка страницы: заголовок с акцентом, пояснение, содержимое. */
      function Card(props) {
        const { title, hint, actions, meta } = props;
        const children = props.children;
        return h(
          'section',
          { className: 'dshs-sync-card', style: S.card },
          h(
            'div',
            { style: S.cardHead },
            h('span', { style: S.accent }),
            h('h2', { style: S.cardTitle }, title),
            // Счётчик в шапке карточки: у «Сессий и режима» — группы и субагенты.
            meta === undefined || meta === null ? null : h('span', { style: { marginLeft: 'auto', minWidth: 0, display: 'flex' } }, meta),
          ),
          hint ? h('p', { style: S.hint }, hint) : null,
          h('div', { style: S.cardBody }, children),
          actions ? h('div', { style: S.cardActions }, actions) : null,
        );
      }


      /**
       * Секция на странице плагина в панели «Плагины».
       *
       * Страница отдаёт `subject` — что именно открыто: пакет, строка списка
       * или официальный плагин. Настройки показываем только для своего пакета,
       * иначе они появятся на странице каждого плагина.
       */
function DetailSection(props) {
        // Слот общий: настройки показываем только у своего пакета.
        const subject = props?.subject
        const packageName =
          subject?.kind === 'bundle' && typeof subject?.pkg?.name === 'string'
            ? subject.pkg.name
            : typeof subject?.id === 'string'
              ? subject.id
              : ''
        if (packageName !== 'dsh-sessions' && packageName !== 'dsh-sync') return null
        // Секция живёт в общей колонке страницы плагина: держим ту же ширину,
        // что и страница синхронизации, и центрируем её по окну.
        return h(
          'div',
          { className: 'dshs-detail', style: { ...S.container, gap: 12 } },
          h(SyncCard, { view: null }),
        )
      }


      /**
       * Перехватчик ошибок рендера: вместо пустого экрана показывает причину.
       * Без него сбой любого компонента оставляет страницу пустой.
       */
      class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: '' };
        }
        static getDerivedStateFromError(error) {
          return { error: String(error?.message ?? error) };
        }
        componentDidCatch(error) {
          console.error('[dsh-sync] сбой рендера:', error);
        }
        render() {
          if (this.state.error !== '') {
            return h(
              'div',
              { style: { padding: 16, fontSize: 12.5, color: '#d1242f', whiteSpace: 'pre-wrap' } },
              'Ошибка рендера: ' + this.state.error,
            );
          }
          return this.props.children;
        }
      }

    /** Свёрнутая строка плагина: заголовок, пояснение и «Открыть». */
    /** Кнопка-шеврон: развернуть и свернуть. Виден в любой теме (currentColor). */
    function ToggleIcon({ open, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          title: open ? 'Свернуть' : 'Открыть',
          'aria-label': open ? 'Свернуть' : 'Открыть',
          'aria-expanded': open ? 'true' : 'false',
          style: {
            position: 'absolute',
            // Свёрнутая карточка: по центру по вертикали. Развёрнутая: в углу.
            top: open ? 8 : '50%',
            transform: open ? 'none' : 'translateY(-50%)',
            right: 8,
            zIndex: 2,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            padding: 0,
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.32))',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary, inherit)',
            cursor: 'pointer',
          },
        },
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' },
          },
          h('path', {
            d: 'M6 15l6-6 6 6',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      )
    }

function CollapsedItem({ title, summary, badge, children }) {
      const [open, setOpen] = React.useState(false)
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            position: 'relative',
            padding: '10px 44px 12px 12px',
            borderRadius: 10,
            border: '1px solid rgba(128,128,128,0.28)',
            background: 'rgba(128,128,128,0.07)',
            boxSizing: 'border-box',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { fontSize: 13, fontWeight: 600, flex: '0 0 auto' } }, title),
          badge !== undefined && badge !== ''
            ? h(
                'span',
                {
                  style: {
                    fontSize: 10.5,
                    padding: '1px 7px',
                    borderRadius: 999,
                    background: 'rgba(106,139,208,0.22)',
                    opacity: 0.9,
                    flex: '0 0 auto',
                  },
                },
                badge,
              )
            : null,
          h(
            'span',
            {
              style: {
                flex: 1,
                fontSize: 11.5,
                opacity: 0.6,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            summary ?? '',
          ),
          h(ToggleIcon, { open, onClick: () => setOpen(!open) }),
        ),
        open
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  paddingTop: 10,
                  marginTop: 2,
                  borderTop: '1px solid rgba(128,128,128,0.24)',
                },
              },
              children,
            )
          : null,
      )
    }

      /* --- компоненты перестроенной страницы ---------------------------- */

      /** Бейдж «есть изменения» на карточке: поля ещё не сохранены. */
      function SaveBadge({ dirty }) {
        if (dirty !== true) return null;
        return h(
          'span',
          {
            className: 'dshs-save-badge',
            'data-dirty': 'true',
            style: { ...S.badge, background: 'rgba(232,89,12,0.16)', color: 'var(--dsw-alias-state-warn-primary, #e8590c)' },
          },
          'есть изменения',
        );
      }

      /** Строка «Сохранить» рядом с полями карточки. */
      function SaveRow({ dirty, busy, busyText, onSave, note }) {
        return h(
          'div',
          { className: 'dshs-save-row', style: { ...S.cardActions, marginTop: 2 } },
          h(
            'button',
            {
              type: 'button',
              className: 'dshs-btn-primary',
              style: S.primary,
              disabled: dirty !== true || busy,
              onClick: () => {
                if (typeof onSave === 'function') void onSave();
              },
            },
            busy ? (busyText ?? 'Сохранение…') : 'Сохранить',
          ),
          h(SaveBadge, { dirty }),
          note ? h('span', { style: S.meta }, note) : null,
        );
      }

      /** Бейдж статуса резервного канала. */
      function ReserveStatusBadge({ state }) {
        if (state === null || state === undefined) return null;
        const background = state.tone === 'ok'
          ? 'rgba(40,150,80,0.16)'
          : state.tone === 'error'
            ? 'rgba(209,36,47,0.16)'
            : state.tone === 'warn'
              ? 'rgba(232,89,12,0.16)'
              : 'rgba(128,128,128,0.14)';
        return h(
          'span',
          {
            className: 'dshs-reserve-status',
            'data-state': state.key,
            title: state.hint ?? '',
            style: { ...S.badge, background },
          },
          state.label,
        );
      }

      /**
       * Аккордеон второстепенных секций: свёрнут по умолчанию, содержимое
       * остаётся в дереве (скрытым), чтобы состояние полей не терялось.
       */
      function SectionAccordion({ title, summary, badge, danger, children }) {
        const [open, setOpen] = React.useState(false);
        return h(
          'section',
          {
            className: `dshs-accordion${danger === true ? ' dshs-accordion-danger' : ''}`,
            'data-open': open ? 'true' : 'false',
            'data-danger': danger === true ? 'true' : undefined,
          },
          h(
            'button',
            {
              type: 'button',
              className: 'dshs-accordion-head',
              'aria-expanded': open ? 'true' : 'false',
              style: { ...S.button, gap: 10, padding: '0 12px', justifyContent: 'flex-start' },
              onClick: () => setOpen((value) => !value),
            },
            h('span', { className: 'dshs-accordion-chevron', 'aria-hidden': 'true', style: { fontSize: 10, opacity: 0.75, flex: '0 0 auto' } }, open ? '▾' : '▸'),
            danger === true
              ? h('span', { className: 'dshs-accordion-danger-dot', 'aria-hidden': 'true', style: { width: 8, height: 8, borderRadius: 4, background: 'var(--dsw-alias-state-error-primary, #d1242f)', flex: '0 0 auto' } })
              : null,
            h('h2', { className: 'dshs-accordion-title', style: { ...S.cardTitle, margin: 0, fontSize: 14 } }, title),
            badge !== undefined && badge !== null && badge !== ''
              ? h('span', { style: { ...S.badge, background: 'rgba(128,128,128,0.16)' } }, String(badge))
              : null,
            summary
              ? h('span', { className: 'dshs-accordion-summary', style: { ...S.meta, marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, summary)
              : null,
          ),
          h(
            'div',
            { className: 'dshs-accordion-body', style: { display: open ? 'flex' : 'none', flexDirection: 'column', gap: 16, minWidth: 0 } },
            children,
          ),
        );
      }

      /**
       * Свёрнутый блок результата: заголовок с кнопкой и содержимое. Как и
       * аккордеон, содержимое остаётся в дереве (скрытым), чтобы перерисовка
       * не сбрасывала прокрутку и выделение.
       */
      function Collapsible({ title, summary, badge, defaultOpen, children, className }) {
        const [open, setOpen] = React.useState(defaultOpen === true);
        return h(
          'div',
          { className: `dshs-collapsible${className === undefined ? '' : ` ${className}`}`, 'data-open': open ? 'true' : 'false' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshs-collapsible-head',
              'aria-expanded': open ? 'true' : 'false',
              style: { ...S.button, gap: 8, padding: '0 12px', justifyContent: 'flex-start' },
              onClick: () => setOpen((value) => !value),
            },
            h('span', { className: 'dshs-collapsible-chevron', 'aria-hidden': 'true', style: { fontSize: 10, opacity: 0.7, flex: '0 0 auto' } }, open ? '▾' : '▸'),
            h('span', { className: 'dshs-collapsible-title', style: { fontWeight: 600 } }, title),
            badge !== undefined && badge !== null && badge !== ''
              ? h('span', { style: { ...S.badge, background: 'rgba(106,139,208,0.22)' } }, String(badge))
              : null,
            summary ? h('span', { style: { ...S.meta, marginLeft: 'auto' } }, summary) : null,
          ),
          h(
            'div',
            { className: 'dshs-collapsible-body', style: { display: open ? 'flex' : 'none', flexDirection: 'column', gap: 10, minWidth: 0 } },
            children,
          ),
        );
      }

      /**
       * Корзина плана: свёрнутая строка со счётчиком, объёмом и списком id.
       * Списки длинные, поэтому прокручиваются внутри строки.
       */
      function PlanBucket({ label, count, bytes, items }) {
        const size = Number(bytes ?? 0) || 0;
        const summary = count === 0
          ? 'нет'
          : `${count}${size > 0 ? ` · ${(size / 1024).toFixed(1).replace('.', ',')} КБ` : ''}`;
        return h(
          CollapsedItem,
          { title: label, summary, badge: count > 0 ? String(count) : undefined },
          count === 0
            ? h('span', { style: { fontSize: 11.5, opacity: 0.6 } }, 'пусто')
            : h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    minWidth: 0,
                    maxHeight: 180,
                    overflowY: 'auto',
                    overscrollBehavior: 'contain',
                  },
                },
                ...items.slice(0, 50).map((item) => h(
                  'span',
                  {
                    key: item.id,
                    title: String(item.shortId ?? shortSessionId(item.id)),
                    style: { fontSize: 11.5, overflowWrap: 'anywhere' },
                  },
                  item.title !== undefined && item.title !== '' ? item.title : 'Без названия',
                )),
                count > items.length
                  ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, `… ещё ${count - items.length}`)
                  : null,
              ),
        );
      }

      // --- M4: онбординг нового устройства ---------------------------------
      // Карточка «Это новое устройство» и чип в шапке карточки «Сессии и режим».
      // Данные приходят только из host-маршрута /api/dsh-sync/onboarding: ни
      // значения секретов, ни их маски в браузер не передаются.

      const ONBOARDING_STATUS_LABELS = {
        ok: 'в порядке',
        warn: 'внимание',
        fail: 'ошибка',
        todo: 'не настроено',
      };

      const ONBOARDING_STATUS_TONES = {
        ok: { background: 'rgba(47,158,68,0.14)', border: '1px solid rgba(47,158,68,0.45)', color: 'var(--dsw-alias-state-success-primary, #2f9e44)' },
        warn: { background: 'rgba(247,190,76,0.16)', border: '1px solid rgba(247,190,76,0.5)', color: 'var(--dsw-alias-state-warn-primary, #b36b00)' },
        fail: { background: 'rgba(209,36,47,0.14)', border: '1px solid rgba(209,36,47,0.5)', color: 'var(--dsw-alias-state-error-primary, #d1242f)' },
        todo: { background: 'rgba(128,128,128,0.14)', border: '1px solid rgba(128,128,128,0.4)', color: 'inherit' },
      };

      /** Русская форма «1 шаг / 2 шага / 5 шагов». */
      const stepsWord = (count) => {
        const value = Math.abs(Number(count) || 0) % 100;
        const last = value % 10;
        if (value >= 11 && value <= 14) return 'шагов';
        if (last === 1) return 'шаг';
        if (last >= 2 && last <= 4) return 'шага';
        return 'шагов';
      };

      function OnboardingBadge({ status }) {
        const key = typeof status === 'string' && ONBOARDING_STATUS_LABELS[status] !== undefined ? status : 'todo';
        return h('span', {
          className: 'dshs-onboarding-badge',
          'data-status': key,
          style: ONBOARDING_STATUS_TONES[key],
        }, ONBOARDING_STATUS_LABELS[key]);
      }

      /** Компактный чип «Это новое устройство? N шагов» в шапке карточки «Сессии». */
      function OnboardingChip({ open, summary }) {
        const data = summary ?? null;
        const count = Math.max(0, Number(data?.count ?? 0) || 0);
        const ready = data?.ready === true && count === 0;
        const label = ready
          ? 'Всё готово'
          : count > 0
            ? `Это новое устройство? ${count} ${stepsWord(count)}`
            : 'Это новое устройство?';
        const readyTone = ready
          ? {
              background: 'rgba(47,158,68,0.1)',
              border: '1px solid rgba(47,158,68,0.5)',
              color: 'var(--dsw-alias-state-success-primary, #2f9e44)',
            }
          : {};
        return h('button', {
          type: 'button',
          className: 'dshs-onboarding-chip',
          'data-ready': ready ? 'true' : 'false',
          'data-count': String(count),
          'aria-expanded': open === true ? 'true' : 'false',
          title: ready ? 'Все шаги нового устройства выполнены' : 'Открыть проверку нового устройства',
          // Кнопка — из общей системы (32 px, radius 10, 600/12.5), только
          // компактнее по горизонтали: чип стоит в шапке карточки.
          style: { ...S.buttonSmall, padding: '0 12px', ...readyTone },
          onClick: () => {
            const next = open !== true;
            publish({ onboardingOpen: next, onboardingNotice: '', onboardingError: '' });
            if (next) void refreshOnboarding();
          },
        }, ready ? '✓ ' : '', label, open === true ? ' ▴' : ' ▾');
      }

      function OnboardingActionButton({ action, busy, confirm }) {
        if (action === null || action === undefined) return null;
        const awaiting = action.route === 'local-only-migration' && confirm === action.route;
        return h(
          'button',
          {
            type: 'button',
            style: S.buttonSmall,
            disabled: busy === true,
            'data-confirm': awaiting ? 'true' : 'false',
            onClick: () => void runOnboardingAction(action.route),
          },
          awaiting ? 'Подтвердить удаление копий' : (action.label ?? 'Выполнить'),
        );
      }

      /** Один шаг онбординга: бейдж статуса, заголовок, пояснение, действие. */
      function OnboardingStep({ step, busy, confirm }) {
        return h(
          'div',
          { className: 'dshs-onboarding-step', 'data-step': step.id, 'data-status': step.status },
          h(OnboardingBadge, { status: step.status }),
          h(
            'div',
            { className: 'dshs-onboarding-step-text' },
            h('span', { className: 'dshs-onboarding-step-title' }, step.title),
            step.detail ? h('span', { className: 'dshs-onboarding-step-detail' }, step.detail) : null,
          ),
          h(OnboardingActionButton, { action: step.action, busy, confirm }),
        );
      }

      /** Блок «Песочница и доступы»: статус из ctx/filePolicy, unknown если API нет. */
      function SandboxBlock({ sandbox }) {
        const value = sandbox ?? {
          status: 'unknown',
          label: 'Песочница: состояние неизвестно',
          detail: 'Версия DSH не отдаёт политику файловой песочницы.',
          allowed: [],
          denied: [],
          approvals: '',
        };
        const allowed = Array.isArray(value.allowed) ? value.allowed : [];
        const denied = Array.isArray(value.denied) ? value.denied : [];
        return h(
          'div',
          { className: 'dshs-onboarding-block', 'data-status': value.status, 'data-sandbox': value.status },
          h('div', { className: 'dshs-onboarding-block-title' }, value.label),
          value.detail ? h('div', { className: 'dshs-onboarding-step-detail' }, value.detail) : null,
          allowed.length > 0 || denied.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
                allowed.length > 0
                  ? h(
                      'div',
                      null,
                      h('span', { style: S.label }, 'Разрешено'),
                      h('ul', { className: 'dshs-onboarding-list' }, ...allowed.map((item, index) => h('li', { key: `a${index}`, className: 'dshs-onboarding-allow' }, item))),
                    )
                  : null,
                denied.length > 0
                  ? h(
                      'div',
                      null,
                      h('span', { style: S.label }, 'Запрещено'),
                      h('ul', { className: 'dshs-onboarding-list' }, ...denied.map((item, index) => h('li', { key: `d${index}`, className: 'dshs-onboarding-deny' }, item))),
                    )
                  : null,
              )
            : null,
          value.approvals ? h('div', { className: 'dshs-onboarding-step-detail' }, value.approvals) : null,
        );
      }

      /** Блок «Секреты»: какие рефы есть, без значений и масок. */
      function SecretsBlock({ secrets, busy }) {
        const list = Array.isArray(secrets) ? secrets : [];
        return h(
          'div',
          { className: 'dshs-onboarding-block', 'data-secrets': String(list.length) },
          h('div', { className: 'dshs-onboarding-block-title' }, 'Секреты'),
          h('div', { className: 'dshs-onboarding-step-detail' }, 'Значения хранятся в credential store DSH и в браузер не передаются — здесь только «есть/нет».'),
          ...list.map((secret) => h(
            'div',
            { key: secret.id, className: 'dshs-secret-row', 'data-secret': secret.id, 'data-present': secret.present === true ? 'true' : 'false' },
            h('span', {
              style: {
                ...S.dot,
                background: secret.present === true
                  ? 'var(--dsw-alias-state-success-primary, #2f9e44)'
                  : 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.8))',
              },
            }),
            h('span', { style: { fontWeight: 600 } }, secret.title),
            h('span', { style: { ...S.meta, overflowWrap: 'anywhere' } }, secret.ref),
            h('span', { style: secret.present === true ? S.ok : S.note }, secret.present === true ? 'есть' : 'нет'),
            h('span', { style: S.hint }, secret.purpose),
          )),
          h(
            'button',
            { type: 'button', style: S.buttonSmall, disabled: busy === true, onClick: () => void runOnboardingAction('refresh') },
            busy === true ? 'Проверка…' : 'Проверить',
          ),
        );
      }

      /** Git-команды нового устройства: адрес уже без логина/пароля. */
      function OnboardingCommands({ commands }) {
        const list = Array.isArray(commands) ? commands : [];
        if (list.length === 0) return null;
        return h(
          'div',
          { className: 'dshs-onboarding-block' },
          h('div', { className: 'dshs-onboarding-block-title' }, 'Git-команды для нового устройства'),
          h('div', { className: 'dshs-onboarding-step-detail' }, 'Скопируйте и выполните в терминале. Токен в команды не подставляется.'),
          h(
            'div',
            { className: 'dshs-onboarding-commands' },
            ...list.map((item, index) => h(
              'div',
              { key: `cmd${index}`, className: 'dshs-onboarding-command' },
              h('code', null, item.command),
              h(
                'button',
                { type: 'button', style: S.buttonSmall, onClick: () => void copyOnboardingCommand(item.command) },
                'Копировать',
              ),
            )),
          ),
        );
      }

      /** Карточка онбординга: шаги, песочница, секреты и git-команды. */
      function OnboardingCard({ data, busy, error, notice, confirm }) {
        const report = data ?? null;
        const steps = Array.isArray(report?.steps) ? report.steps : [];
        const okCount = steps.filter((step) => step.status === 'ok').length;
        const counts = report === null
          ? null
          : [
              ['fail', report.fail, 'ошибок'],
              ['warn', report.warn, 'внимание'],
              ['todo', report.todo, 'не настроено'],
            ].filter(([, value]) => Number(value ?? 0) > 0);
        return h(
          Card,
          {
            title: 'Это новое устройство',
            hint: 'Проверка нового компьютера: инструменты, версия DSH, секреты, профиль, синхронизация и рабочие пространства. Значения секретов не показываются — только «есть/нет».',
            meta: h(
              'span',
              { className: 'dshs-groups-counter' },
              report === null ? 'шаги не загружены' : `готово ${okCount} из ${steps.length}`,
            ),
          },
          h(
            'div',
            { className: 'dshs-onboarding-top', style: S.buttons },
            h(
              'button',
              {
                type: 'button',
                className: 'dshs-btn-primary',
                style: S.primary,
                disabled: busy === true,
                onClick: () => void runOnboardingAction('refresh'),
              },
              busy === true ? 'Проверка…' : 'Проверить',
            ),
            h(
              'button',
              { type: 'button', style: S.buttonSmall, onClick: () => publish({ onboardingOpen: false }) },
              'Свернуть',
            ),
            report !== null
              ? h('span', { style: S.meta }, `версия DSH: ${report.version?.current || 'неизвестна'} (нужна ${report.version?.min ?? '0.2.3-alpha.2'}+)`)
              : null,
          ),
          error ? h('div', { style: S.error }, error) : null,
          notice ? h('div', { style: S.ok }, notice) : null,
          report === null
            ? h('span', { style: S.hint }, busy === true ? 'Собираем шаги нового устройства…' : 'Шаги ещё не загружены — нажмите «Проверить».')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
                counts !== null && counts.length > 0
                  ? h(
                      'div',
                      { style: S.buttons },
                      ...counts.map(([status, value, label]) => h(
                        'span',
                        { key: status, className: 'dshs-onboarding-badge', 'data-status': status, style: ONBOARDING_STATUS_TONES[status] },
                        `${label}: ${value}`,
                      )),
                    )
                  : h('span', { style: S.ok }, report.ready === true ? 'Все обязательные шаги выполнены.' : 'Шаги требуют внимания.'),
                h(
                  'div',
                  { className: 'dshs-onboarding-steps', 'data-count': String(steps.length) },
                  ...steps.map((step) => h(OnboardingStep, { key: step.id, step, busy: busy === true, confirm: confirm ?? '' })),
                ),
                h(SandboxBlock, { sandbox: report.sandbox }),
                h(SecretsBlock, { secrets: report.secrets, busy: busy === true }),
                h(OnboardingCommands, { commands: report.commands }),
                h('span', { style: S.hint }, 'Данные собраны на этом устройстве: сеть используется только для проверки репозитория. Секреты читаются как «есть/нет» и в браузер не попадают.'),
              ),
        );
      }

      function SyncCard(props) {
        const view = props?.view;
        const state = useSnapshot();
        const data = state.data;
        const [update, setUpdate] = React.useState(updateOverride);
        const [updateNote, setUpdateNote] = React.useState('');
        const [probe, setProbe] = React.useState(null);
        // Результат лёгкой сверки резерва («Сверить» → secondary-probe).
        const [secondaryProbe, setSecondaryProbe] = React.useState(null);
        const [draft, setDraft] = React.useState(() => ({ backend: 'git', branch: 'main', remote: '', repoDir: '', yandexToken: '', yandexPath: 'dsh-sync', webdavLogin: '', webdavPassword: '', webdavPath: 'dsh-sync', secondaryBackend: 'none', secondaryRemote: '', secondaryLogin: '', secondaryPassword: '', secondaryPath: 'dsh-sync', secondaryFolder: '', projectPath: '', projectId: '', attachments: false, autoUpdate: false, useExternal: true, ...(draftOverride ?? {}) }));
        const [touched, setTouched] = React.useState(touchedOverride);

        React.useEffect(() => {
          let alive = true;
          fetch(UPDATE_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
            .then((response) => response.json())
            .then((payload) => { if (alive && payload?.ok === true) setUpdate(payload); })
            .catch(() => {});
          return () => { alive = false; };
        }, []);

        const applyUpdate = async () => {
          setUpdateNote('Обновляем…');
          try {
            const response = await fetch(UPDATE_APPLY_PATH, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            });
            const payload = await response.json();
            setUpdateNote(payload?.ok === true
              ? 'Обновление запущено. Перезапустите DSH.'
              : (payload?.message ?? 'не удалось запустить обновление'));
          } catch (error) {
            setUpdateNote(String(error?.message ?? error));
          }
        };

        React.useEffect(() => {
          void refresh();
        }, []);

        React.useEffect(() => {
          if (data?.config === undefined || touched) return;
          setDraft({
            backend: data.config.backend === 'folder' ? 'folder' : 'git',
            branch: data.config.branch ?? 'main',
            remote: data.config.remote ?? '',
            repoDir: data.config.repoDir ?? '',
            projectPath: data.config.projectPath ?? '',
            projectId: data.config.projectId ?? '',
            attachments: data.config.attachments === true,
            autoUpdate: data.config.autoUpdate === true,
            yandexToken: data.config.yandexToken ?? '',
            yandexPath: data.config.yandexPath ?? 'dsh-sync',
            webdavLogin: data.config.webdavLogin ?? '',
            webdavPassword: data.config.webdavPassword ?? '',
            webdavPath: data.config.webdavPath ?? 'dsh-sync',
            secondaryBackend: data.config.secondary?.backend ?? data.secondary?.backend ?? 'none',
            secondaryRemote: data.config.secondary?.remote ?? '',
            secondaryLogin: data.config.secondary?.webdavLogin ?? '',
            secondaryPassword: '',
            secondaryPath: data.config.secondary?.webdavPath ?? data.secondary?.webdavPath ?? 'dsh-sync',
            secondaryFolder: data.config.secondary?.folderDir ?? data.secondary?.folderDir ?? '',
            useExternal: data.config.useExternal !== false,
          });
        }, [data?.config?.remote, data?.config?.branch, data?.config?.projectPath, data?.config?.projectId, data?.config?.attachments, data?.config?.useExternal, touched]);

        if (view === 'summary') {
          const status = data?.status;
          const ready = data?.ready === true;
          const last = data?.lastRun;
          return h(
            'span',
            { style: { display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12.5 } },
            h('span', null, t('title')),
            h(
              'span',
              { style: { ...S.badge, background: ready ? 'rgba(40,150,80,0.16)' : 'rgba(200,140,0,0.16)' } },
              ready ? 'готово' : state.loading ? 'проверка…' : 'не настроено',
            ),
            status ? h('span', { style: S.meta }, `${status.local}/${status.mirror}`) : null,
            last ? h('span', { style: S.meta }, new Date(last.at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' })) : null,
            update?.status === 'behind'
              ? h('span', { style: { ...S.badge, background: 'rgba(200,140,0,0.18)' } }, `обновление: ${shortSha(update.installed)} → ${shortSha(update.latest)}`)
              : null,
          );
        }

        const set = (patch) => {
          setTouched(true);
          setDraft((current) => ({ ...current, ...patch }));
        };

        const createRepo = async () => {
          publish({ busy: 'create', notice: '', error: '' });
          try {
            const result = await post(CREATE_REPO_PATH, {});
            if (result?.ok === true) {
              setDraft((current) => ({ ...current, remote: result.remote ?? current.remote }));
              setTouched(true);
              publish({ busy: '', notice: result.message ?? 'Репозиторий готов' });
              await run('sync');
            } else {
              publish({ busy: '', error: result?.message ?? 'Не удалось создать репозиторий' });
            }
          } catch (error) {
            publish({ busy: '', error: explain(error) });
          }
        };

        const checkYandex = async () => {
          setProbe({ ok: false, text: 'Проверяю доступ…' });
          publish({ busy: 'yandex', notice: '', error: '' });
          try {
            const result = await post('/api/dsh-sync/yandex-check', {
              backend: draft.backend,
              yandexToken: draft.yandexToken,
              yandexPath: draft.yandexPath,
              webdavLogin: draft.webdavLogin,
              webdavPassword: draft.webdavPassword,
              webdavPath: draft.webdavPath,
            });
            if (result?.ok === true) {
              setProbe({ ok: true, text: result.message ?? 'Доступ к Диску подтверждён' });
              publish({ busy: '', notice: '', error: '' });
            } else {
              setProbe({ ok: false, text: result?.message ?? 'Не удалось войти в Яндекс.Диск' });
              publish({ busy: '', notice: '', error: '' });
            }
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            setProbe({ ok: false, text: text.includes('404') ? 'Маршрут проверки недоступен — перезапустите DSH' : text });
            publish({ busy: '', notice: '', error: '' });
          }
        };

        const copyDiagnostics = async () => {
          publish({ busy: 'diag', notice: '', error: '' });
          try {
            const result = await post(DIAG_PATH, {});
            if (result?.ok !== true) {
              publish({ busy: '', error: result?.message ?? 'Не удалось собрать диагностику' });
              return;
            }
            try {
              await navigator.clipboard.writeText(result.report);
              publish({ busy: '', notice: 'Диагностика скопирована в буфер обмена' });
            } catch {
              publish({ busy: '', notice: result.report.slice(0, 4000) });
            }
          } catch (error) {
            publish({ busy: '', error: explain(error) });
          }
        };

        /**
         * Сверка резервного канала: сравнить локальные сессии с облаком,
         * принять из него данные и разрешить первую выгрузку.
         */
        /**
         * «Сверить» резерва — лёгкая сверка: PROPFIND корня и
         * profile/manifest.json, без скачивания логов. Ничего не принимает и
         * не отправляет: показывает только расхождения.
         */
        const compareSecondaryLight = async () => {
          setSecondaryProbe(null);
          publish({ busy: 'secondary-probe', notice: '', error: '' });
          try {
            const result = await post(SECONDARY_PROBE_PATH, {});
            setSecondaryProbe(result);
            if (result?.ok === true) {
              publish({ busy: '', notice: result.message || 'Лёгкая сверка выполнена: логи не скачивались.' });
            } else {
              const hint = typeof result?.hint === 'string' && result.hint !== '' ? result.hint : reserveErrorText(result);
              publish({ busy: '', error: hint });
            }
            await refresh();
          } catch (error) {
            publish({ busy: '', error: `Сверка резерва не удалась: ${explain(error)}` });
          }
        };

        /**
         * «Синхронизировать резерв» — полная сверка с загрузкой: принимает
         * данные из облака и разрешает первую выгрузку. Отдельная кнопка,
         * чтобы лёгкая сверка не тянула блобы. Пока операция идёт, карточка
         * каждые 2 с обновляет /state и показывает полосу прогресса
         * (`secondary.init`), а «Отменить» зовёт POST /secondary-init/cancel.
         */
        const syncSecondaryFull = async () => {
          publish({ busy: 'secondary-init', notice: '', error: '' });
          try {
            const result = await post(SECONDARY_INIT_PATH, {});
            if (result?.ok === true) {
              const totals = result?.totals ?? null;
              const report = totals !== null
                ? `скачано ${Number(totals.downloaded ?? 0)}, пропущено ${Number(totals.skipped ?? 0)}${Number(totals.failed ?? 0) > 0 ? `, ошибок ${Number(totals.failed)}` : ''}`
                : '';
              publish({ busy: '', notice: result.message ? `${result.message}${report !== '' ? ` (${report})` : ''}` : 'Резерв синхронизирован' });
            } else if (result?.cancelled === true || result?.code === 'cancelled') {
              publish({ busy: '', notice: result?.message ?? 'Сверка отменена — уже скачанное сохранено.', error: '' });
            } else {
              const hint = typeof result?.hint === 'string' && result.hint !== '' ? result.hint : reserveErrorText(result);
              publish({ busy: '', error: hint || (result?.message ?? 'Синхронизация резерва не удалась') });
            }
            await refresh();
          } catch (error) {
            publish({ busy: '', error: `Синхронизация резерва не удалась: ${explain(error)}` });
          }
        };

        /**
         * «Отменить» полную сверку резерва: скачивание останавливается, уже
         * скачанные файлы и `.part` остаются — следующий запуск продолжит.
         */
        const cancelSecondaryFull = async () => {
          try {
            const result = await post(SECONDARY_INIT_CANCEL_PATH, {});
            publish({
              notice: result?.message ?? (result?.ok === true ? 'Отмена запрошена' : 'Сверка уже завершена'),
              error: '',
            });
            await refresh();
          } catch (error) {
            publish({ error: `Не удалось отменить сверку: ${explain(error)}` });
          }
        };

        // Пока идёт полная синхронизация резерва, состояние обновляем чаще:
        // так видно рост прогресса выгрузки, а не только итог.
        React.useEffect(() => {
          if (state.busy !== 'secondary-init') return undefined;
          const timer = setInterval(() => { void refresh(); }, 2000);
          return () => clearInterval(timer);
        }, [state.busy]);

        // Подтверждение удалений — второй клик в карточке «План и синхронизация».
        const [confirmDeletions, setConfirmDeletions] = React.useState(false);
        // Подтверждение карантина дублей — второй клик, как у удалений.
        const [confirmDuplicates, setConfirmDuplicates] = React.useState(false);

        /**
         * «Проверить»: сравнить локальные сессии с зеркалом по id и хвостам
         * логов. Только чтение: ничего не отправляется, не принимается и не
         * удаляется — даже карантин не чистится.
         */
        const checkPlan = async () => {
          publish({ busy: 'plan', planError: '', planNote: '' });
          try {
            const result = await post(PLAN_PATH, {});
            if (result?.ok === true) {
              publish({ busy: '', plan: result, planNote: result.message ?? 'Проверка выполнена: ничего не изменено.' });
            } else {
              publish({ busy: '', planError: result?.message ?? 'Не удалось построить план' });
            }
          } catch (error) {
            publish({ busy: '', planError: `Проверка не удалась: ${explain(error)}` });
          }
        };

        /**
         * «Применить удаления (N)»: подтверждённое удаление из зеркала в
         * карантин на 30 дней. После успеха обновляем план и список «Удалённые».
         */
        const applyPlanDeletions = async () => {
          setConfirmDeletions(false);
          publish({ busy: 'prune', planError: '', planNote: '' });
          try {
            const result = await post(PRUNE_PATH, { confirm: true });
            if (result?.ok === true) {
              publish({ busy: '', notice: result.message || 'Удаления применены', plan: null });
              await refreshTombstones(true);
              await checkPlan();
            } else {
              publish({ busy: '', planError: result?.message ?? 'Не удалось применить удаления' });
            }
          } catch (error) {
            publish({ busy: '', planError: `Удаления не применены: ${explain(error)}` });
          }
        };

        /**
         * «Найти дубли»: группы копий одной сессии с разными id (локально,
         * зеркало, карантин). Только чтение — ничего не удаляет.
         */
        const findDuplicates = async () => {
          setConfirmDuplicates(false);
          publish({ busy: 'duplicates', duplicatesError: '', duplicatesNote: '' });
          try {
            const result = await post(DUPLICATES_PATH, {});
            if (result?.ok === true) {
              publish({ busy: '', duplicates: result, duplicatesNote: result.message ?? '' });
            } else {
              publish({ busy: '', duplicatesError: result?.message ?? 'Не удалось найти дубли' });
            }
          } catch (error) {
            publish({ busy: '', duplicatesError: `Поиск дублей не удался: ${explain(error)}` });
          }
        };

        /** id лишних копий из отчёта — их и отправляем в карантин. */
        const duplicateLoserIds = () => {
          const ids = [];
          for (const group of Array.isArray(state.duplicates?.groups) ? state.duplicates.groups : []) {
            for (const id of group.supersededIds ?? []) {
              if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
            }
          }
          return ids;
        };

        /**
         * «Убрать дубли в карантин»: лишние копии уходят в `_deleted` с причиной
         * duplicate, канонические остаются. После успеха план и «Удалённые»
         * обновляются, чтобы списки не расходились с диском.
         */
        const applyDuplicateQuarantine = async () => {
          setConfirmDuplicates(false);
          const ids = duplicateLoserIds();
          publish({ busy: 'duplicates-quarantine', duplicatesError: '', duplicatesNote: '' });
          try {
            const result = await post(DUPLICATES_QUARANTINE_PATH, { confirm: true, ...(ids.length > 0 ? { ids } : {}) });
            if (result?.ok === true) {
              publish({
                busy: '',
                notice: result.message || 'Лишние копии убраны в карантин',
                duplicates: null,
                duplicatesNote: result.message ?? '',
                plan: null,
              });
              await refreshTombstones(true);
              await checkPlan();
            } else {
              publish({ busy: '', duplicatesError: result?.message ?? 'Не удалось убрать дубли в карантин' });
            }
          } catch (error) {
            publish({ busy: '', duplicatesError: `Дубли не убраны: ${explain(error)}` });
          }
        };

        const checks = data?.checks ?? [];
        const busy = state.busy !== '';
        const plan = state.plan;
        // «Найти дубли»: отчёт последнего поиска и его подтверждение.
        const duplicates = state.duplicates;
        const duplicateGroups = Array.isArray(duplicates?.groups) ? duplicates.groups : [];
        const status = data?.status;
        const last = data?.lastRun;
        // Вид последней ошибки и число неудач — из summary (контракт с host).
        const lastError = lastErrorLine(data);
        // Непустая очередь повторов: «в очереди: N» рядом со статусом.
        const queued = outboxCount(data);
        const external = data?.external;
        const mode = data?.mode;
        const secondary = data?.secondary;
        const savedSecondary = data?.config?.secondary ?? {};
        // До первого срабатывания эффекта черновик ещё пустой: для отрисовки
        // берём сохранённые значения, иначе карточка резерва мигает «выключено».
        const activeSecondaryBackend = touched ? draft.secondaryBackend : (savedSecondary.backend ?? draft.secondaryBackend);
        const activeSecondaryFolder = touched ? draft.secondaryFolder : (savedSecondary.folderDir ?? draft.secondaryFolder);
        const activeSecondaryLogin = touched ? draft.secondaryLogin : (savedSecondary.webdavLogin ?? draft.secondaryLogin);
        const activeSecondaryPath = touched ? draft.secondaryPath : (savedSecondary.webdavPath ?? draft.secondaryPath);
        const activeSecondaryRemote = touched ? draft.secondaryRemote : (savedSecondary.remote ?? draft.secondaryRemote);
        // Настройки резерва в черновике ещё не сохранены: сверка читает файл,
        // поэтому сначала нужно нажать «Сохранить», а не сверять старое.
        const secondaryDirty =
          activeSecondaryBackend !== (secondary?.backend ?? 'none')
          || (activeSecondaryBackend === 'folder' && activeSecondaryFolder !== (secondary?.folderDir ?? ''))
          || (activeSecondaryBackend === 'webdav'
            && (activeSecondaryLogin !== (savedSecondary.webdavLogin ?? '') || activeSecondaryPath !== (savedSecondary.webdavPath ?? 'dsh-sync')))
          || (activeSecondaryBackend === 'git' && activeSecondaryRemote !== (savedSecondary.remote ?? ''));

        // «Хранилище»: черновик отличается от сохранённых настроек.
        const savedConfig = data?.config ?? {};
        const storageDirty = touched && storageDirtyOf(draft, savedConfig);
        // Статус резерва для бейджа: не включён / не сохранён / не сверен /
        // сверен / ошибка.
        const reserveState = reserveStatusOf({
          secondary,
          activeBackend: activeSecondaryBackend,
          dirty: secondaryDirty,
          probe: secondaryProbe,
          init: secondary?.init,
        });

        /**
         * «Сохранить» внутри карточки: тот же маршрут, что у глобальной кнопки,
         * но после успеха снимает бейдж «есть изменения».
         */
        const saveCard = async () => {
          if (data === null) {
            publish({ error: 'Настройки ещё загружаются — подождите пару секунд.' });
            return;
          }
          const ok = await save(draft);
          if (ok) setTouched(false);
        };

        return h(
          'div',
          { className: 'dshs-card dshs-sync-sections', style: S.sections },

          // Итог последнего действия и ошибки — над секциями, чтобы их было
          // видно сразу после нажатия кнопки.
          state.notice ? h('div', { style: S.ok }, state.notice) : null,
          state.error ? h('div', { style: S.error }, state.error) : null,

          // --- 1. «Хранилище»: бэкенд, адрес/папка, ветка, проект ---------
          // Поля и «Сохранить» рядом: не нужно искать общую кнопку внизу.
          h(
            Card,
            {
              title: 'Хранилище',
              hint: 'Хранилище с копией сессий и проект, который синхронизируется с этого компьютера. «Сохранить» применяет поля этой карточки.',
              meta: h(SaveBadge, { dirty: storageDirty }),
            },
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, 'Тип хранилища'),
              h(
                'select',
                {
                  style: { ...S.input, colorScheme: themeScheme() },
                  value: draft.backend,
                  onChange: (event) => set({ backend: event.target.value }),
                },
                h('option', { value: 'git' }, 'Git-репозиторий (GitHub, GitLab)'),
                h('option', { value: 'folder' }, 'Папка облачного диска (клиент Яндекс.Диска, OneDrive)'),
                h('option', { value: 'webdav' }, 'Яндекс.Диск (WebDAV, пароль приложения)'),
                h('option', { value: 'yandex' }, 'Яндекс.Диск через API (OAuth-токен)'),
              ),
            ),
            draft.backend === 'folder'
              ? h(
                  'div',
                  { style: S.field },
                  h('span', { style: S.label }, 'Папка Яндекс.Диска'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    value: draft.repoDir,
                    placeholder: data?.suggestedFolder || 'C:\\Users\\me\\YandexDisk\\dsh-sync',
                    onChange: (event) => set({ repoDir: event.target.value }),
                  }),
                  h(
                    'span',
                    { style: S.hint },
                    'Установите клиент Яндекс.Диска и выберите папку внутри него — синхронизацией займётся сам клиент, git и токены не нужны.',
                  ),
                  data?.suggestedFolder && draft.repoDir === ''
                    ? h(
                        'button',
                        {
                          type: 'button',
                          style: S.button,
                          onClick: () => set({ repoDir: data.suggestedFolder }),
                        },
                        `Подставить ${data.suggestedFolder}`,
                      )
                    : null,
                )
              : draft.backend === 'webdav'
              ? h(
                  'div',
                  { style: S.field },
                  h('span', { style: S.label }, 'Логин Яндекс.Диска'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    value: draft.webdavLogin,
                    placeholder: 'narzik',
                    onChange: (event) => set({ webdavLogin: event.target.value }),
                  }),
                  h('span', { style: S.label }, 'Пароль приложения'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    type: 'password',
                    value: draft.webdavPassword,
                    placeholder: 'xxxx xxxx xxxx xxxx',
                    onChange: (event) => set({ webdavPassword: event.target.value }),
                  }),
                  h('span', { style: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.8))' } }, "Пароль приложения: Яндекс ID → Безопасность → Пароли приложений → создать для «Файлы»."),
                  h('span', { style: S.label }, 'Папка на Диске'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    value: draft.webdavPath,
                    placeholder: 'dsh-sync',
                    onChange: (event) => set({ webdavPath: event.target.value }),
                  }),
                  h(
                    'span',
                    { style: S.hint },
                    'Пароль приложения создаётся на id.yandex.ru → Безопасность → Пароли приложений (тип «Файлы»). Программа Яндекс.Диска не нужна.',
                  ),
                  h(
                    'button',
                    { type: 'button', style: S.button, disabled: busy, onClick: () => void checkYandex() },
                    state.busy === 'yandex' ? 'Проверка…' : 'Проверить доступ',
                  ),
                  probe
                    ? h(
                        'span',
                        { style: { fontSize: 12, color: probe.ok ? 'var(--dsw-alias-state-success-primary, #2f9e44)' : 'var(--dsw-alias-state-error-primary, #d1242f)' } },
                        probe.text,
                      )
                    : null,
                )
              : draft.backend === 'yandex'
              ? h(
                  'div',
                  { style: S.field },
                  h('span', { style: S.label }, 'OAuth-токен Яндекс.Диска'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    type: 'password',
                    value: draft.yandexToken,
                    placeholder: 'y0_AgAAAA…',
                    onChange: (event) => set({ yandexToken: event.target.value }),
                  }),
                  h('span', { style: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.8))' } }, "OAuth-токен выдаётся приложению с доступом к диску: oauth.yandex.ru → «Создать приложение» → права на файлы."),
                  h('span', { style: S.label }, 'Папка на Диске'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    value: draft.yandexPath,
                    placeholder: 'dsh-sync',
                    onChange: (event) => set({ yandexPath: event.target.value }),
                  }),
                  h(
                    'span',
                    { style: S.hint },
                    'Программа Яндекс.Диска не нужна: плагин сам загружает и скачивает файлы. Инструкция по токену — в README плагина.',
                  ),
                  h(
                    'button',
                    { type: 'button', style: S.button, disabled: busy, onClick: () => void checkYandex() },
                    state.busy === 'yandex' ? 'Проверка…' : 'Проверить доступ',
                  ),
                  probe
                    ? h(
                        'span',
                        { style: { fontSize: 12, color: probe.ok ? 'var(--dsw-alias-state-success-primary, #2f9e44)' : 'var(--dsw-alias-state-error-primary, #d1242f)' } },
                        probe.text,
                      )
                    : null,
                )
              : h(
                  'label',
                  { style: S.field },
                  h('span', { style: S.label }, 'Адрес репозитория с сессиями (приватный)'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    value: draft.remote,
                    placeholder: 'https://github.com/user/dsh-sessions.git',
                    onChange: (event) => set({ remote: event.target.value }),
                  }),
                ),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, 'Путь к проекту на этом компьютере'),
              h('input', {
                style: { ...S.input, colorScheme: themeScheme() },
                value: draft.projectPath,
                placeholder: 'C:\\work\\my-project',
                onChange: (event) => set({ projectPath: event.target.value }),
              }),
            ),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, 'Идентификатор проекта (одинаковый на всех устройствах)'),
              h('input', {
                style: { ...S.input, colorScheme: themeScheme() },
                value: draft.projectId,
                placeholder: 'harness',
                onChange: (event) => set({ projectId: event.target.value }),
              }),
            ),
            draft.backend === 'git'
              ? h(
                  'label',
                  { style: S.field },
                  h('span', { style: S.label }, 'Ветка репозитория'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    value: draft.branch,
                    placeholder: 'main',
                    onChange: (event) => set({ branch: event.target.value }),
                  }),
                )
              : null,
            h(
              'label',
              { style: S.checkboxRow },
              h('input', {
                type: 'checkbox',
                checked: draft.attachments,
                onChange: (event) => set({ attachments: event.target.checked }),
              }),
              h('span', null, 'Синхронизировать вложения (картинки и файлы из чата)'),
            ),
            h(
              'div',
              { style: S.row },
              h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-success-primary, #2f9e44)' } }),
              h('span', null, 'Автообновление плагина включено: проверка раз в 6 часов, установка новой версии — автоматически.'),
            ),
            h(SaveRow, {
              dirty: storageDirty,
              busy: busy,
              busyText: 'Сохранение…',
              onSave: saveCard,
              note: storageDirty ? 'Поля изменены — нажмите «Сохранить».' : 'Все изменения сохранены.',
            }),
          ),

          // --- 2. «План и синхронизация»: состояние, запуск и «Проверить» --
          h(
            Card,
            {
              title: 'План и синхронизация',
              hint: 'Состояние зеркала, прогресс копирования и ручной запуск. «Проверить» только сравнивает — ничего не изменяется.',
            },
            status
              ? h(
                  'span',
                  { style: S.hint },
                  `Сессий локально: ${status.local}, в зеркале: ${status.mirror}. Только локально: ${status.onlyLocal}, только в зеркале: ${status.onlyMirror}.`
                  + ((status.subagents ?? 0) > 0 ? ` Субагентов: ${status.subagents}, доступны ${status.subagentsAvailable ?? 0}.` : ''),
                )
              : h('span', { style: S.hint }, state.loading ? 'Читаем состояние…' : 'Состояние пока неизвестно — обновите страницу.'),
            h(
              'div',
              { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' } },
              h('span', { style: S.row }, h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-success-primary, #2f9e44)' } }), 'синхронизировано'),
              h('span', { style: S.row }, h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-warn-primary, #e8590c)' } }), 'есть изменения'),
              h('span', { style: S.row }, h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-error-primary, #d1242f)' } }), 'не отправлялось'),
            ),
            h(SyncProgress, { data }),
            queued > 0
              ? h('span', { style: S.note, 'data-outbox': String(queued) }, `в очереди: ${queued}`)
              : null,
            data?.pending
              ? h('span', { style: S.note }, 'Есть неотправленные изменения — они уйдут при следующей отправке (не чаще раза в 5 минут) или по кнопке.')
              : null,
            status && status.local === 0 && status.mirror > 0
              ? h(
                  'span',
                  { style: S.note },
                  'На этом устройстве пока нет локальных сессий — они появятся после первой отправки или скачивания из зеркала.',
                )
              : null,
            h(
              'div',
              { style: S.buttons },
              h(
                'button',
                { type: 'button', className: 'dshs-btn-primary', style: S.primary, disabled: busy, onClick: () => void run('sync') },
                state.busy === 'sync' ? 'Синхронизация…' : 'Синхронизировать',
              ),
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => void run('pull') }, 'Только принять'),
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => void run('push') }, 'Только отправить'),
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => void refresh() }, 'Обновить'),
            ),
            last
              ? h(
                  'span',
                  { style: last.ok ? S.ok : S.error },
                  `${new Date(last.at).toLocaleString('ru-RU')} — ${last.ok ? 'успешно' : 'ошибка'}: ${last.message}`,
                )
              : h('span', { style: S.hint }, 'Ещё не запускалось.'),
            (last?.removed ?? 0) > 0
              ? h(
                  'span',
                  { style: S.note },
                  `Удалено: ${last.removed} — ${last.removedReason !== undefined && last.removedReason !== '' ? last.removedReason : 'причина не указана'}.`,
                )
              : null,
            lastError !== ''
              ? h('span', { style: S.note }, lastError)
              : null,
            (last?.childrenQuarantined ?? 0) > 0
              ? h('span', { style: S.note }, `Вместе с родителями ушли в карантин субагентов: ${last.childrenQuarantined}.`)
              : null,
            (Array.isArray(last?.childrenMissing) ? last.childrenMissing.length : 0) > 0
              ? h('span', { style: S.note }, `Субагентов нет локально: ${last.childrenMissing.length} — их копии в зеркале защищены от удаления.`)
              : null,
            (last?.skippedLocal ?? 0) > 0
              ? h(
                  'span',
                  { style: S.note },
                  `Локальных сессий пропущено: ${last.skippedLocal}`
                  + ((last?.localMirrorProtected ?? 0) > 0 ? ` (копий в зеркале защищено: ${last.localMirrorProtected})` : '')
                  + '.',
                )
              : null,
            (last?.duplicatesSkipped ?? 0) > 0
              ? h(
                  'span',
                  { style: S.note },
                  `Копий-дублей при импорте пропущено: ${last.duplicatesSkipped} — такая сессия уже была локально.`,
                )
              : null,
            (last?.skippedDeletions?.removed ?? last?.requireConfirmation?.removed ?? 0) > 0
              ? h(
                  'span',
                  { style: S.note },
                  `Удалений ждёт подтверждения: ${last?.skippedDeletions?.removed ?? last.requireConfirmation.removed} — ничего не удалено. Нажмите «Проверить» и «Применить удаления» в карточке «Проверка».`,
                )
              : null,
            (data?.history?.length ?? 0) > 0
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('span', { style: S.label }, 'Последние запуски'),
                  ...data.history.slice(-3).reverse().map((entry, index) =>
                    h(
                      'span',
                      { key: `h${index}`, style: entry.ok ? S.meta : S.error },
                      `${new Date(entry.at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })} — ${entry.ok ? 'ok' : 'ошибка'}: ${entry.message}${(entry.skippedLocal ?? 0) > 0 ? ` · локальных пропущено: ${entry.skippedLocal}` : ''}`,
                    ),
                  ),
                )
              : null,
            h('span', { style: S.hint }, 'После приёма новых сессий перезапустите DSH — список обновляется при старте.'),
            data?.automation
              ? h(
                  'span',
                  { style: data.automation.lastError ? S.error : S.hint },
                  data.automation.enabled === false
                    ? 'Автосинхронизация выключена.'
                    : `Автосинхронизация: приём раз в ${data.automation.settings?.pullIntervalMinutes ?? 15} мин, отправка при изменениях (не чаще ${data.automation.settings?.pushMinIntervalMinutes ?? 5} мин)`
                      + (data.automation.lastPushAt
                        ? `; последняя отправка ${new Date(data.automation.lastPushAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                        : '')
                      + (data.automation.lastError ? `; ошибка: ${data.automation.lastError}` : ''),
                )
              : null,
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
              h(
                'div',
                { style: S.buttons },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshs-btn-primary',
                    style: S.primary,
                    disabled: busy,
                    onClick: () => void checkPlan(),
                  },
                  state.busy === 'plan' ? 'Проверяю…' : (plan === null || plan === undefined ? 'Проверить' : 'Проверить снова'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.button,
                    disabled: busy,
                    title: 'Найти копии одной сессии с разными id: локально, в зеркале и в карантине',
                    onClick: () => void findDuplicates(),
                  },
                  state.busy === 'duplicates' ? 'Ищу дубли…' : 'Найти дубли',
                ),
                plan !== null && plan !== undefined
                  ? h('span', { style: S.meta }, `Проверено: ${new Date(plan.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`)
                  : null,
                duplicates !== null && duplicates !== undefined
                  ? h('span', { style: S.meta }, `Дублей: ${duplicates.duplicates ?? 0} · групп: ${duplicates.count ?? 0}`)
                  : null,
              ),
              state.planError ? h('div', { style: S.error }, state.planError) : null,
              state.duplicatesError ? h('div', { style: S.error }, state.duplicatesError) : null,
              plan === null || plan === undefined
                ? h(
                    'span',
                    { style: S.hint },
                    'Сравнение локальных сессий с зеркалом по идентификаторам и хвостам логов. Нажмите «Проверить»: покажем, что уедет в зеркало, что приедет и что было бы удалено. Проверка только читает — ничего не изменяется. Удаления выполняются только кнопкой «Применить удаления» в «Опасной зоне».',
                  )
                : h(
                    Collapsible,
                    {
                      key: `plan-${plan.at ?? ''}`,
                      title: 'Результат проверки',
                      summary: 'ничего не изменено',
                      badge: (plan.deletionCount ?? 0) > 0 ? String(plan.deletionCount) : undefined,
                      defaultOpen: true,
                      className: 'dshs-plan-result',
                    },
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
                      h('span', { style: S.ok }, state.planNote || 'Проверка выполнена: ничего не изменено.'),
                      ...(plan.warnings?.length > 0
                        ? [h('div', { key: 'warnings', style: S.error }, ...plan.warnings.map((warning, index) => h('div', { key: `w${index}` }, `Внимание: ${warning}`)))]
                        : []),
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
                        h(PlanBucket, { label: 'Только локально', count: plan.counts?.onlyLocal ?? 0, bytes: plan.sizes?.onlyLocal ?? 0, items: plan.buckets?.onlyLocal ?? [] }),
                        h(PlanBucket, { label: 'Только в зеркале', count: plan.counts?.onlyCloud ?? 0, bytes: plan.sizes?.onlyCloud ?? 0, items: plan.buckets?.onlyCloud ?? [] }),
                        h(PlanBucket, { label: 'Совпадают', count: plan.counts?.same ?? 0, bytes: plan.sizes?.same ?? 0, items: plan.buckets?.same ?? [] }),
                        h(PlanBucket, { label: 'Локально новее', count: plan.counts?.localAhead ?? 0, bytes: plan.sizes?.localAhead ?? 0, items: plan.buckets?.localAhead ?? [] }),
                        h(PlanBucket, { label: 'В зеркале новее', count: plan.counts?.cloudAhead ?? 0, bytes: plan.sizes?.cloudAhead ?? 0, items: plan.buckets?.cloudAhead ?? [] }),
                        h(PlanBucket, { label: 'Расхождения', count: plan.counts?.conflicts ?? 0, bytes: plan.sizes?.conflicts ?? 0, items: plan.buckets?.conflicts ?? [] }),
                        h(PlanBucket, { label: 'Дубли', count: plan.counts?.duplicates ?? 0, bytes: plan.sizes?.duplicates ?? 0, items: plan.buckets?.duplicates ?? [] }),
                      ),
                      (plan.duplicates?.groups?.length ?? 0) > 0
                        ? h(
                            Collapsible,
                            {
                              title: 'Группы дублей',
                              summary: 'канонические помечены «=»',
                              badge: String(plan.duplicates.count ?? 0),
                              defaultOpen: false,
                            },
                            h(
                              'div',
                              { className: 'dshs-duplicates-groups' },
                              ...(plan.duplicates.groups ?? []).slice(0, 20).map((group, index) => h(
                                'div',
                                { key: `pg${index}`, className: 'dshs-duplicates-group' },
                                h(
                                  'span',
                                  { className: 'dshs-duplicates-head' },
                                  h('span', { style: { fontSize: 11.5, fontWeight: 600 } }, `Канонический: ${group.canonicalId}${(group.children ?? 0) > 0 ? ` · детей: ${group.children}` : ''}`),
                                  h('span', { style: S.meta }, group.match === 'contentHash' ? 'по содержимому' : 'по событиям и размеру'),
                                ),
                                ...(group.sessions ?? []).filter(session => session.canonical !== true).map(session => h(
                                  'span',
                                  { key: session.id, style: { fontSize: 11.5, opacity: 0.8, overflowWrap: 'anywhere' } },
                                  `− ${session.id}${session.side !== undefined && session.side !== '' ? ` [${session.side === 'both' ? 'локально и в зеркале' : session.side === 'mirror' ? 'в зеркале' : session.side === 'local' ? 'локально' : 'в карантине'}]` : ''}`,
                                )),
                              )),
                              (plan.duplicates?.groups?.length ?? 0) > 20
                                ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, `… ещё групп: ${plan.duplicates.groups.length - 20}`)
                                : null,
                            ),
                          )
                        : null,
                      duplicates !== null && duplicates !== undefined
                        ? h(
                            'div',
                            { className: 'dshs-duplicates-card' },
                            h(
                              'span',
                              { style: (duplicates.duplicates ?? 0) > 0 ? S.note : S.ok },
                              duplicates.duplicates > 0
                                ? `Найдено лишних копий: ${duplicates.duplicates} (групп: ${duplicates.count}). Каноническая копия каждой группы останется.`
                                : (duplicates.message ?? 'Дублей нет: копий одной сессии с разными id не найдено.'),
                            ),
                            duplicateGroups.length > 0
                              ? h(
                                  'div',
                                  { className: 'dshs-duplicates-groups' },
                                  ...duplicateGroups.slice(0, 20).map((group, index) => h(
                                    'div',
                                    { key: `dg${index}`, className: 'dshs-duplicates-group' },
                                    h(
                                      'span',
                                      { className: 'dshs-duplicates-head' },
                                      h('span', { style: { fontSize: 11.5, fontWeight: 600 } }, `Канонический: ${group.canonicalId}${(group.children ?? 0) > 0 ? ` · детей: ${group.children}` : ''}`),
                                      h('span', { style: S.meta }, `лишних: ${(group.supersededIds ?? []).length}`),
                                    ),
                                    ...(group.sessions ?? []).map(session => h(
                                      'span',
                                      { key: session.id, style: { fontSize: 11.5, opacity: session.canonical === true ? 0.95 : 0.75, overflowWrap: 'anywhere' } },
                                      `${session.canonical === true ? '= каноническая' : '− лишняя'} ${session.id}`,
                                    )),
                                  )),
                                  duplicateGroups.length > 20
                                    ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, `… ещё групп: ${duplicateGroups.length - 20}`)
                                    : null,
                                )
                              : null,
                            h('span', { style: S.hint }, 'Убрать лишние копии в карантин можно в «Опасной зоне»: каноническая копия каждой группы останется.'),
                          )
                        : null,
                      (plan.localSkipped ?? 0) > 0
                        ? h('span', { style: S.note }, `Локальных сессий не участвует в обмене: ${plan.localSkipped} (режим «локальная»).`)
                        : null,
                    ),
                  ),
              h('span', { style: S.hint }, 'Проверка сравнивает с копией зеркала на этом компьютере: сеть не используется, журнал запусков не меняется.'),
            ),
          ),

          // --- 3. «Сессии и режим»: группы, поиск, локальные/облачные -----
          h(
            Card,
            {
              title: 'Сессии и режим',
              hint: 'Локальная сессия остаётся только на этом устройстве: не отправляется, не принимается и не удаляется отметкой с другого компьютера.',
              meta: h(
                'div',
                { className: 'dshs-sessions-card-meta', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0, justifyContent: 'flex-end' } },
                // M4: чип «Это новое устройство? N шагов» открывает карточку.
                h(OnboardingChip, { open: state.onboardingOpen === true, summary: data?.onboarding }),
                h(SessionGroupsCounter, null),
              ),
            },
            h(SessionModesSection, null),
            // M6: карточка «Правила» — внутри «Сессии и режим», чтобы четыре
            // основные карточки страницы остались как в M3.
            h(SessionRulesPanel, null),
          ),

          // --- 3b. «Это новое устройство»: онбординг нового компьютера ------
          // Открывается чипом в шапке карточки «Сессии и режим»; шаги и блоки
          // «Песочница и доступы»/«Секреты» приносит GET /onboarding.
          state.onboardingOpen === true
            ? h(OnboardingCard, {
                data: state.onboarding,
                busy: state.onboardingBusy === true,
                error: state.onboardingError ?? '',
                notice: state.onboardingNotice ?? '',
                confirm: state.onboardingConfirm ?? '',
              })
            : null,

          // --- 4. «Резервный канал»: выбор режима, поля, сверка -----------
          h(
            Card,
            {
              title: 'Резервный канал',
              hint: 'Второе место для копии сессий. Папка облачного клиента (OneDrive, Яндекс.Диск, Syncthing) — рекомендуемый вариант: без сети, паролей и токенов.',
              meta: h(ReserveStatusBadge, { state: reserveState }),
            },
            h(
              'div',
              { className: 'dshs-reserve-modes', style: S.buttons },
              ...[
                { value: 'folder', label: 'Папка облака (рекомендуется)' },
                { value: 'webdav', label: 'WebDAV' },
                { value: 'git', label: 'Git' },
                { value: 'none', label: 'Не дублировать' },
              ].map((option) => {
                const active = activeSecondaryBackend === option.value;
                const choose = () => {
                  const patch = { secondaryBackend: option.value };
                  // Путь рядом с уже найденной папкой облака: резерв включится
                  // «из коробки», без ручного поиска каталога.
                  if (option.value === 'folder' && activeSecondaryFolder === '') {
                    patch.secondaryFolder = data?.suggestedSecondaryFolder ?? data?.secondary?.folderDir ?? '';
                  }
                  set(patch);
                };
                return h(
                  'button',
                  {
                    key: option.value,
                    type: 'button',
                    className: active ? 'dshs-btn-primary' : undefined,
                    style: active ? { ...S.primary, height: 32 } : S.buttonSmall,
                    'aria-pressed': active ? 'true' : 'false',
                    disabled: busy,
                    onClick: choose,
                  },
                  option.label,
                );
              }),
            ),
            activeSecondaryBackend === 'none'
              ? h('span', { style: S.hint }, 'Резерв выключен: сессии дублируются только в основное хранилище. Основная синхронизация работает как обычно.')
              : null,
            activeSecondaryBackend === 'folder'
              ? h(
                  'div',
                  { style: S.field },
                  h('span', { style: S.label }, 'Папка облака для резерва'),
                  h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    value: activeSecondaryFolder,
                    placeholder: data?.suggestedSecondaryFolder || 'C:\\Users\\me\\OneDrive\\dsh-sync-backup',
                    onChange: (event) => set({ secondaryFolder: event.target.value }),
                  }),
                  h(
                    'span',
                    { style: S.hint },
                    'Отдельная папка внутри папки облачного диска: клиент сам разнесёт её на другие компьютеры. Не указывайте ту же папку, что основное хранилище.',
                  ),
                  data?.suggestedSecondaryFolder && activeSecondaryFolder === ''
                    ? h(
                        'button',
                        { type: 'button', style: S.button, onClick: () => set({ secondaryFolder: data.suggestedSecondaryFolder }) },
                        `Подставить ${data.suggestedSecondaryFolder}`,
                      )
                    : null,
                )
              : activeSecondaryBackend === 'webdav'
                ? h(
                    'div',
                    { style: S.field },
                    h('span', { style: S.label }, 'Логин Яндекса для резерва'),
                    h('input', {
                      style: { ...S.input, colorScheme: themeScheme() },
                      value: activeSecondaryLogin,
                      placeholder: 'логин Яндекса',
                      onChange: (event) => set({ secondaryLogin: event.target.value }),
                    }),
                    h('span', { style: S.label }, 'Пароль приложения'),
                    h('input', {
                      style: { ...S.input, colorScheme: themeScheme() },
                      type: 'password',
                      value: draft.secondaryPassword,
                      placeholder: data?.secondaryPasswordStored === true ? 'пароль сохранён в хранилище' : 'пароль приложения',
                      onChange: (event) => set({ secondaryPassword: event.target.value }),
                    }),
                    h('span', { style: S.label }, 'Папка на Диске'),
                    h('input', {
                      style: { ...S.input, colorScheme: themeScheme() },
                      value: activeSecondaryPath,
                      placeholder: 'dsh-sync-backup',
                      onChange: (event) => set({ secondaryPath: event.target.value }),
                    }),
                  )
                : activeSecondaryBackend === 'git'
                  ? h(
                      'label',
                      { style: S.field },
                      h('span', { style: S.label }, 'Адрес репозитория резерва'),
                      h('input', {
                        style: { ...S.input, colorScheme: themeScheme() },
                        value: activeSecondaryRemote,
                        placeholder: 'https://github.com/user/dsh-sessions-backup.git',
                        onChange: (event) => set({ secondaryRemote: event.target.value }),
                      }),
                    )
                  : null,
            // Статус сверки и последней выгрузки.
            secondary?.enabled === true
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
                  h(
                    'span',
                    { style: secondary.initialized ? S.ok : S.note },
                    secondary.initialized
                      ? `Сверено: локально ${secondary.compare?.local ?? 0}, в облаке ${secondary.compare?.cloud ?? 0}, расходятся ${secondary.compare?.differ ?? 0}`
                        + (Number(secondary.files ?? 0) > 0
                          ? `; файлов ${secondary.files} (${megabytesText(secondary.bytes ?? 0)})`
                          : '')
                        + ((secondary.pulled?.imported ?? 0) > 0 ? `; принято из облака: ${secondary.pulled.imported}` : '')
                      : 'Сначала сверка: отправка в резерв заблокирована, пока состав облака не проверен.',
                  ),
                  secondary.initializedAt
                    ? h('span', { style: S.meta }, `последняя сверка: ${new Date(secondary.initializedAt).toLocaleString('ru-RU')}`)
                    : null,
                  secondary.lastPushAt
                    ? h(
                        'span',
                        { style: secondary.lastPushOk === false ? S.error : S.meta },
                        secondary.lastPushOk === false
                          ? `последняя выгрузка не удалась: ${secondary.lastPushMessage || 'ошибка'}`
                          : `последняя выгрузка: ${new Date(secondary.lastPushAt).toLocaleString('ru-RU')} — отправлено ${secondary.lastPushUploaded ?? 0}`,
                      )
                    : h('span', { style: S.meta }, 'выгрузка в резерв ещё не выполнялась'),
                  secondary.backend === 'folder' && secondary.folderDir
                    ? h('span', { style: S.meta }, `папка облака: ${secondary.folderDir}`)
                    : null,
                  secondary?.status?.ok === false
                    && secondary.status.cancelled !== true
                    && secondary.status.message
                    ? h('span', { style: S.error }, reserveErrorText(secondary.status))
                    : null,
                )
              : h('span', { style: S.hint }, 'Резерв выключен: сессии дублируются только в основное хранилище.'),
            secondaryDirty && secondary?.enabled === true
              ? h('span', { style: S.note }, 'Настройки резерва ещё не сохранены — сначала «Сохранить», потом «Сверить».')
              : null,
            reserveState.hint !== '' && reserveState.key === 'error'
              ? h('span', { style: S.error }, reserveState.hint)
              : null,
            // Результат лёгкой сверки: сравнивались только состав и манифест.
            secondaryProbe !== null && secondaryProbe !== undefined
              ? h(
                  'div',
                  { className: 'dshs-reserve-probe' },
                  h(
                    'span',
                    { style: secondaryProbe.ok === true ? S.ok : S.error },
                    secondaryProbe.ok === true
                      ? `Лёгкая сверка выполнена за ${Math.max(1, Math.round(Number(secondaryProbe.durationMs ?? 0) / 1000))} с: локально ${secondaryProbe.local?.count ?? 0}, в облаке ${secondaryProbe.cloud?.count ?? 0}, только локально ${secondaryProbe.onlyLocal ?? 0}, только в облаке ${secondaryProbe.onlyCloud ?? 0}, расходятся ${secondaryProbe.differ ?? 0}.`
                      : (secondaryProbe.hint || reserveErrorText(secondaryProbe)),
                  ),
                  secondaryProbe.ok === true
                    ? h('span', { style: S.meta }, 'Логи не скачивались: сравнивались только состав облака и манифест профиля.')
                    : (secondaryProbe.code ? h('span', { style: S.meta }, `код: ${secondaryProbe.code}`) : null),
                )
              : null,
            // «Сохранить» рядом с полями резерва.
            h(SaveRow, {
              dirty: secondaryDirty,
              busy: busy,
              busyText: 'Сохранение…',
              onSave: saveCard,
              note: secondaryDirty ? 'Поля изменены — нажмите «Сохранить».' : 'Настройки резерва сохранены.',
            }),
            // Две разные сверки: лёгкая «Сверить» и полная «Синхронизировать резерв».
            h(
              'div',
              { style: S.buttons },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshs-btn-primary',
                  style: S.primary,
                  disabled: busy || secondary?.enabled !== true || secondaryDirty,
                  title: secondaryDirty ? 'Сначала сохраните настройки резерва' : 'Сравнить локальные сессии с облаком без скачивания логов (PROPFIND и profile/manifest.json, 10–30 с)',
                  onClick: () => void compareSecondaryLight(),
                },
                state.busy === 'secondary-probe' ? 'Сверка…' : 'Сверить',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.button,
                  disabled: busy || secondary?.enabled !== true || secondaryDirty,
                  title: 'Полная сверка: принять данные из облака и разрешить выгрузку',
                  onClick: () => void syncSecondaryFull(),
                },
                state.busy === 'secondary-init' ? 'Синхронизация…' : 'Синхронизировать резерв',
              ),
            ),
            // Прогресс и отчёт полной сверки: полоса «N из M файлов, X из Y МБ»,
            // текущий файл, «Отменить» во время работы и итог после неё.
            secondary?.enabled === true
              ? h(ReserveProgress, {
                  init: secondary?.init,
                  status: secondary?.status,
                  busy,
                  onCancel: () => void cancelSecondaryFull(),
                })
              : null,
            h(
              'span',
              { style: S.hint },
              '«Сверить» сравнивает только состав: PROPFIND корня и profile/manifest.json, без скачивания логов, 10–30 с. «Синхронизировать резерв» — полная сверка с загрузкой: сначала принимает данные из облака, потом разрешает выгрузку; файлы качаются резюмируемо (30 с на файл, 15 мин на операцию, кнопка «Отменить»), уже скачанное не перекачивается. Сессии и настройки дублируются в оба места, вложения — только в основное.',
            ),
          ),

          // --- аккордеон 1: «Дополнительно» (свёрнут по умолчанию) ---------
          h(
            SectionAccordion,
            {
              title: 'Дополнительно',
              summary: 'Проверка окружения, профиль, обновления и служебные действия',
            },
            external?.found
            ? h(
                Card,
                { title: t('sectionExternal') },
                h(
                  'span',
                  { style: S.hint },
                  external.callable
                    ? `Найден «${external.name}» с программным интерфейсом — синхронизация выполняется через него.`
                    : `Найден «${external.name}»${external.configured ? ' (настроен)' : ''}, но он не публикует интерфейс для вызова. Используется встроенный движок; чтобы плагины не мешали друг другу, оставьте активным один.`,
                ),
                external.callable
                  ? h(
                      'label',
                      { style: S.checkboxRow },
                      h('input', {
                        type: 'checkbox',
                        checked: draft.useExternal,
                        onChange: (event) => set({ useExternal: event.target.checked }),
                      }),
                      h('span', null, 'Предпочитать внешний плагин, пока он доступен'),
                    )
                  : null,
                mode === 'external' ? h('span', { style: S.ok }, 'Активен режим: через внешний плагин') : null,
              )
            : null,
            h(
            Card,
            {
              title: t('sectionChecks'),
              hint: 'Зелёная точка — проверка пройдена, красная — нужна настройка.',
            },
            checks.length === 0
              ? h('span', { style: S.hint }, state.loading ? 'Проверка…' : 'Не удалось получить данные от host-части.')
              : null,
            ...checks.map((check) =>
              h(
                'div',
                { key: check.id, style: S.row },
                h('span', {
                  style: {
                    ...S.dot,
                    background: check.ok
                      ? 'var(--dsw-alias-state-success-primary, #2f9e44)'
                      : 'var(--dsw-alias-state-error-primary, #d1242f)',
                  },
                }),
                h('span', { style: { minWidth: 150 } }, check.title),
                h('span', { style: S.meta }, check.detail),
              ),
            ),
            checks.some((check) => !check.ok)
              ? h('span', { style: S.note }, checks.filter((check) => !check.ok).map((check) => check.hint).join(' '))
              : null,
          ),
            h(
            Card,
            {
              title: 'Профиль',
              hint: 'Оформление, язык, плагины, настройки, история расходов и задачи переезжают на другое устройство. Сначала показываем план приёма, применяем — по кнопке.',
            },
            h(ProfileLayerSection, null),
          ),
            h(
            Card,
            { title: t('sectionMaintenance'), hint: 'Проверка версии плагина и служебные действия.' },
            
            
            update?.status === 'behind'
              ? h('span', { style: { ...S.label, fontWeight: 600 } }, `${t('title')}: доступно обновление`)
              : null,
            h(
              'span',
              { style: S.hint },
              update === null
                ? 'Проверяем версию…'
                
                
                
                : update.status === 'behind'
                  ? `плагин «${t('title')}»: ${update.version ? `v${update.version} ` : ''}${shortSha(update.installed)} → ${shortSha(update.latest)} — установится автоматически.`
                  : typeof update.description === 'string' && update.description !== ''
                    ? update.description
                    : update.status === 'local'
                      ? 'Локальная установка — автообновление не применяется; свежий код уже на месте.'
                      : update.status === 'current'
                        ? `Актуально (${shortSha(update.installed)})`
                        : update.detail !== undefined && update.detail !== ''
                          ? `Проверка не удалась: ${update.detail}`
                          : 'Состояние неизвестно',
            ),
            update?.status === 'behind'
              ? h(
                  'div',
                  { style: S.cardActions },
                  h('button', { type: 'button', style: S.button, onClick: () => void applyUpdate() }, 'Обновить'),
                )
              : null,
            updateNote !== '' ? h('span', { style: S.note }, updateNote) : null,
            h('span', { style: S.hint }, 'Проверка обновлений идёт раз в 6 часов; установленная версия применяется при следующем запуске DSH.'),
          ),
            h(
            'div',
            { className: 'dshs-sync-actions', style: S.actions },
            h(
              'div',
              { style: S.actionsText },
              h('span', { style: S.label }, 'Действия'),
              h('span', { style: S.meta }, 'Настройки применяются кнопкой «Сохранить».'),
            ),
            h(
              'div',
              { style: S.buttons },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshs-btn-primary',
                  style: S.primary,
                  disabled: busy || data === null,
                  onClick: () => {
                    
                    
                    if (data === null) {
                      publish({ error: 'Настройки ещё загружаются — подождите пару секунд.' });
                      return;
                    }
                    void save(draft);
                  },
                },
                state.busy === 'save' ? 'Сохранение…' : 'Сохранить',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.button,
                  disabled: busy,
                  title: 'Создать приватный репозиторий dsh-sessions в вашем аккаунте GitHub',
                  onClick: () => void createRepo(),
                },
                state.busy === 'create' ? 'Создание…' : 'Создать репозиторий',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.button,
                  disabled: busy,
                  title: 'Собрать отчёт о состоянии и скопировать в буфер обмена',
                  onClick: () => void copyDiagnostics(),
                },
                state.busy === 'diag' ? 'Сбор…' : 'Диагностика',
              ),
            ),
          ),
            h(
            'span',
            { style: S.hint },
            'Репозиторий создаётся приватным через токен GitHub из хранилища DSH. Если токена нет — создайте репозиторий вручную и вставьте его HTTPS-адрес выше.',
          ),
          ),

          // --- аккордеон 2: «Опасная зона» (свёрнут, красный акцент) -------
          h(
            SectionAccordion,
            {
              title: 'Опасная зона',
              summary: 'Удаления, карантин и восстановление — только по подтверждению',
              danger: true,
              badge: (plan?.deletionCount ?? 0) > 0 ? String(plan.deletionCount) : undefined,
            },
            h(
            Card,
            {
              title: t('sectionDeleted'),
              hint: t('deletedHint'),
            },
            h(DeletedSection, { t }),
          ),
            plan !== null && plan !== undefined && (plan.deletionCount ?? 0) > 0
              ? h(
                  'div',
                  { className: 'dshs-danger-block' },
                  h('span', { style: S.error }, `Было бы удалено из зеркала: ${plan.deletionCount}. Это только список — нажмите «Применить удаления», чтобы перенести их в карантин на 30 дней.`),
                  (plan.requireConfirmation?.subagents ?? 0) > 0
                    ? h('span', { style: S.note }, `Вместе с родителем уйдут субагенты: ${plan.requireConfirmation.subagents} — их тоже можно будет восстановить.`)
                    : null,
                  plan.requireConfirmation?.overCount === true
                    ? h('span', { style: S.note }, `Больше ${plan.requireConfirmation.maxCount ?? 5} сессий: убедитесь, что это не сбой доступа к диску.`)
                    : null,
                  h(
                    CollapsedItem,
                    {
                      title: 'Удаления',
                      summary: `${plan.deletionCount} · в карантин на 30 дней`,
                      badge: String(plan.deletionCount),
                    },
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, maxHeight: 200, overflowY: 'auto', overscrollBehavior: 'contain' } },
                      ...(plan.deletions ?? []).slice(0, 50).map((item) => h(
                        'span',
                        {
                          key: item.id,
                          title: String(item.shortId ?? shortSessionId(item.id)),
                          style: { fontSize: 11.5, overflowWrap: 'anywhere' },
                        },
                        `${item.title !== undefined && item.title !== '' ? item.title : 'Без названия'} (${item.humanReason ?? item.reason})`,
                      )),
                      (plan.deletions?.length ?? 0) > 50
                        ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, `… ещё ${plan.deletions.length - 50}`)
                        : null,
                    ),
                  ),
                  confirmDeletions
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
                        h('span', { style: S.hint }, `Подтвердите: ${plan.deletionCount} сессий уйдут из зеркала в карантин на 30 дней. Локальные сессии не изменятся.`),
                        h(
                          'div',
                          { style: S.buttons },
                          h(
                            'button',
                            { type: 'button', style: S.danger, disabled: busy, onClick: () => void applyPlanDeletions() },
                            state.busy === 'prune' ? 'Применяю…' : `Подтвердить удаление (${plan.deletionCount})`,
                          ),
                          h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => setConfirmDeletions(false) }, 'Отмена'),
                        ),
                      )
                    : h(
                        'div',
                        { style: S.buttons },
                        h(
                          'button',
                          {
                            type: 'button',
                            style: S.danger,
                            disabled: busy,
                            title: 'Перенести эти сессии из зеркала в карантин на 30 дней',
                            onClick: () => setConfirmDeletions(true),
                          },
                          `Применить удаления (${plan.deletionCount})`,
                        ),
                      ),
                )
              : h('span', { style: { fontSize: 12, opacity: 0.75 } }, 'Удалений нет: удалять из зеркала нечего.'),
            duplicateGroups.length > 0
              ? (confirmDuplicates
                ? h(
                    'div',
                    { className: 'dshs-duplicates-actions' },
                    h('span', { style: S.hint }, `Подтвердите: ${duplicates.duplicates ?? duplicateLoserIds().length} лишних копий уйдут в карантин на 30 дней. Канонические копии останутся.`),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.danger,
                        disabled: busy,
                        onClick: () => void applyDuplicateQuarantine(),
                      },
                      state.busy === 'duplicates-quarantine' ? 'Убираю…' : `Подтвердить карантин (${duplicates.duplicates ?? duplicateLoserIds().length})`,
                    ),
                    h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => setConfirmDuplicates(false) }, 'Отмена'),
                  )
                : h(
                    'div',
                    { className: 'dshs-duplicates-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.danger,
                        disabled: busy,
                        title: 'Перенести лишние копии в карантин на 30 дней; канонические останутся',
                        onClick: () => setConfirmDuplicates(true),
                      },
                      `Убрать дубли в карантин (${duplicates.duplicates ?? duplicateLoserIds().length})`,
                    ),
                    h('span', { style: S.hint }, 'Копии не удаляются безвозвратно: их можно вернуть в карточке «Удалённые».'),
                  ))
              : null,
          ),
        );

      }

      /**
       * Экран пункта «Синхронизация» в левой панели: это действие, а не
       * настройки. При открытии запускает синхронизацию (если давно не было
       * запуска) и показывает результат крупной лампочкой.
       */
      function SyncPanel() {
        const [phase, setPhase] = React.useState('idle');
        const [text, setText] = React.useState('');
        const [detail, setDetail] = React.useState('');

        const run = async () => {
          setPhase('busy');
          setText('Синхронизация сессий…');
          try {
            const result = await post(RUN_PATH, { action: 'sync' });
            if (result?.ok === true) {
              setPhase('ok');
              setText('Сессии синхронизированы');
              setDetail(result.message ?? '');
            } else {
              setPhase('error');
              setText('Не удалось синхронизировать');
              setDetail(result?.message ?? '');
            }
          } catch (error) {
            setPhase('error');
            setText('Не удалось синхронизировать');
            setDetail(explain(error));
          }
        };

        React.useEffect(() => {
          (async () => {
            try {
              const state = await post(STATE_PATH, {});
              const lastAt = state?.lastRun?.at ? Date.parse(state.lastRun.at) : 0;
              const fresh = Number.isFinite(lastAt) && Date.now() - lastAt < 60_000;
              if (!fresh) {
                await run();
                return;
              }
              setPhase(state.lastRun.ok === true ? 'ok' : 'error');
              setText(state.lastRun.ok === true ? 'Сессии синхронизированы' : 'Последняя синхронизация не удалась');
              setDetail(state.lastRun.message ?? '');
            } catch {
              await run();
            }
          })();
        }, []);

        const color = phase === 'ok'
          ? 'var(--dsw-alias-state-success-primary, #2f9e44)'
          : phase === 'error'
            ? 'var(--dsw-alias-state-error-primary, #d1242f)'
            : 'rgba(128,128,128,0.45)';
        const pageState = useSnapshot();

        // Страница целиком: центрированный контейнер до 960 px, симметричные
        // поля по краям (на узком экране 16 px — в классе .dshs-sync-page).
        return h(
          'div',
          { className: 'dshs-card dshs-sync-page', style: S.page },
          h(
            'div',
            { className: 'dshs-sync-container', style: S.container },
            h(SyncPageHeader, { data: pageState?.data ?? null, loading: pageState?.loading !== false }),
            // Результат автозапуска при открытии страницы: светофор и «Синхронизировать снова».
            h(
              'div',
              { className: 'dshs-sync-status', style: S.statusPanel },
              h(
                'div',
                { style: S.statusRow },
                h('span', { style: { width: 12, height: 12, borderRadius: 6, background: color, flex: '0 0 auto' } }),
                h('span', null, text || t('statusIdle')),
              ),
              detail ? h('span', { style: S.hint }, detail) : null,
              h(
                'div',
                { style: S.cardActions },
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.button,
                    onClick: () => void run(),
                    disabled: phase === 'busy',
                  },
                  phase === 'busy' ? t('actionSyncing') : t('actionSyncAgain'),
                ),
              ),
              h(
                'span',
                { style: S.hint },
                'Автосинхронизация работает в фоне: приём при старте и раз в 15 минут, отправка при изменениях.',
              ),
            ),
            h(SyncCard, { view: null }),
            // Браузерные настройки (dsh-polish, dsh-cards) не видны host-части:
            // панель отдаёт их наверх и забирает очередь после приёма профиля.
            h(BrowserSettingsBridge, null),
          ),
        );
      }


      /** Иконка пункта в левой панели: две стрелки по кругу. */
      // Всплывающие карточки: боковая панель отрисована всегда, поэтому
      // уведомления видны с любой страницы и не требуют отдельного слота.
      const NOTIFICATIONS_PATH = '/api/dsh-sync/notifications';
      const TOAST_LIFETIME_MS = 12_000;
      const TOAST_POLL_MS = 20_000;


      /** Окно после обновления: показывает, что версия сменилась и всё работает. */
      function UpdateDialog({ from, version }) {
        const [closed, setClosed] = React.useState(false);
        const storageKey = `dsh-sessions-updated-${version}`;

        React.useEffect(() => {
          try {
            if (localStorage.getItem(storageKey) === '1') setClosed(true);
          } catch {
            // без хранилища окно просто покажется ещё раз
          }
        }, [storageKey]);

        if (closed || !version) return null;

        const done = () => {
          setClosed(true);
          try {
            localStorage.setItem(storageKey, '1');
          } catch {
            // не критично
          }
          // Говорим host-части, что окно закрыто: отметка об обновлении снимется.
          void post('/api/dsh-sync/ack-update', { version }).catch(() => {});
        };

        const row = (label) =>
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
            h(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  background: 'rgba(47,158,68,0.18)',
                  color: '#2f9e44',
                  fontSize: 11,
                  flex: '0 0 auto',
                },
              },
              '✓',
            ),
            h('span', null, label),
          );

        const overlay = h(
          'div',
          {
            style: {
              position: 'fixed',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.45)',
              zIndex: 80,
            },
            onClick: done,
          },
          h(
            'div',
            {
              onClick: (event) => event.stopPropagation(),
              style: {
                width: '100%',
                maxWidth: 420,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                padding: '20px 22px',
                borderRadius: 14,
                border: '1px solid rgba(128,128,128,0.28)',
                background: 'var(--dsw-alias-bg-base, #22242a)',
                color: 'var(--dsw-alias-label-primary, inherit)',
                boxShadow: '0 18px 50px rgba(0,0,0,0.45)',
                boxSizing: 'border-box',
              },
            },
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, 'Обновление dsh-sessions'),
            h('div', { style: { fontSize: 13, opacity: 0.8 } }, `Версия ${from} → ${version}`),
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'rgba(128,128,128,0.08)',
                },
              },
              row('Плагин установлен и запущен.'),
              row('Настройки, зеркало и резервное хранилище сохранены.'),
              row('Синхронизация продолжит работу автоматически.'),
            ),
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end' } },
              h(
                'button',
                {
                  type: 'button',
                  onClick: done,
                  style: { ...S.primary },
                },
                'Готово',
              ),
            ),
          ),
        );

        // Окно рисуем в body: внутри строки боковой панели position:fixed
        // обрезается контейнером, и окно становится невидимым.
        try {
          return createPortal(overlay, document.body);
        } catch {
          return overlay;
        }
      }


      function SyncToasts() {
        const [items, setItems] = React.useState([]);
        const snapshot = useSnapshot();

        React.useEffect(() => {
          let cursor = 0;
          let stopped = false;
          let timer;

          const schedule = () => {
            if (stopped) return;
            timer = setTimeout(() => void poll(), TOAST_POLL_MS);
          };

          const poll = async () => {
            try {
              const result = await post(NOTIFICATIONS_PATH, { since: cursor });
              if (result?.ok === true) {
                cursor = Number(result.cursor) || cursor;
                if (Array.isArray(result.items) && result.items.length > 0) {
                  setItems((current) => [...current, ...result.items].slice(-3));
                }
              }
            } catch {
              // без уведомлений остальное работает
            }
            schedule();
          };

          void poll();
          return () => {
            stopped = true;
            clearTimeout(timer);
          };
        }, []);

        React.useEffect(() => {
          if (items.length === 0) return undefined;
          const timer = setTimeout(() => {
            setItems((current) => current.slice(1));
          }, TOAST_LIFETIME_MS);
          return () => clearTimeout(timer);
        }, [items]);

        const color = (kind) =>
          kind === 'error' ? '#d1242f' : kind === 'update' ? '#1f6feb' : '#2f9e44';

        const toasts = h(
          'div',
          {
            style: {
              position: 'fixed',
              right: 16,
              bottom: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              zIndex: 60,
              maxWidth: 340,
            },
          },
          ...items.map((item) =>
            h(
              'div',
              {
                key: item.id,
                style: {
                  background: 'var(--dsh-surface-strong, #1f2430)',
                  color: '#fff',
                  borderLeft: `3px solid ${color(item.kind)}`,
                  borderRadius: 6,
                  padding: '8px 10px',
                  fontSize: 12,
                  lineHeight: 1.35,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
                },
              },
              item.text,
            ),
          ),
        );

        const from = snapshot.data?.updatedFrom;
        const current = snapshot.data?.version;
        // Тосты и окно живут в body, а не внутри строки панели: иначе их
        // обрезает контейнер бокового меню.
        const layer = h(
          React.Fragment,
          null,
          toasts,
          from && current ? h(UpdateDialog, { from, version: current }) : null,
        );
        try {
          return createPortal(layer, document.body);
        } catch {
          return layer;
        }
      }


      /**
       * Плашка состояния в основном окне: короткая подпись и всплывающая
       * карточка с двумя хранилищами. Висит отдельным слоем, поэтому ничего
       * не перекрывает в обычном состоянии.
       */
      function SyncHeaderBadge() {
        const state = useSnapshot();
        const data = state.data;
        const ready = data !== null && data !== undefined;

        const ref = React.useRef(null);
        const [anchor, setAnchor] = React.useState(null);

        const pending = ready && data.pending === true;
        const percent = ready ? data.backup?.percent : undefined;
        const color = !ready ? 'rgba(128,128,128,0.7)' : pending ? '#e8590c' : '#2f9e44';
        const caption = !ready
          ? 'синхронизация'
          : typeof percent === 'number'
            ? `резерв ${percent}%`
            : pending
              ? 'есть изменения'
              : 'синхронизировано';

        const open = () => {
          const rect = ref.current?.getBoundingClientRect?.();
          if (rect !== undefined && rect !== null) {
            setAnchor({ left: rect.left, top: rect.top, width: rect.width });
          }
        };
        const close = () => setAnchor(null);

        return h(
          'span',
          {
            ref,
            onMouseEnter: open,
            onMouseLeave: close,
            onFocus: open,
            onBlur: close,
            tabIndex: 0,
            title: ready ? undefined : 'Состояние синхронизации загружается',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 22,
              padding: '0 8px',
              borderRadius: 11,
              border: '1px solid rgba(128,128,128,0.28)',
              background: 'rgba(128,128,128,0.08)',
              fontSize: 11.5,
              color: 'inherit',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              cursor: 'default',
              outline: 'none',
            },
          },
          h('span', {
            style: { width: 7, height: 7, borderRadius: 4, background: color, flex: '0 0 auto' },
          }),
          h('span', { style: { opacity: 0.85 } }, caption),
          anchor !== null ? h(SyncPopover, { anchor, data }) : null,
        );
      }

      /** Всплывающая карточка с двумя хранилищами; рисуется поверх приложения. */
      function SyncPopover({ anchor, data }) {
        if (data === null || data === undefined) return null;

        const megabytes = (bytes) => `${(Number(bytes ?? 0) / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
        const status = data.status;
        const backup = data.backup;
        const backend = data.config?.backend ?? 'git';
        const secondaryBackend = data.secondaryBackend;
        const hasSecondary = typeof secondaryBackend === 'string' && secondaryBackend !== 'none';

        const primaryPercent = status && status.local > 0 ? (status.mirror / status.local) * 100 : 100;

        const rows = [
          h(ProgressRow, {
            key: 'primary',
            label: BACKEND_LABELS[backend] ?? 'Основное',
            percent: primaryPercent,
            done: primaryPercent >= 100,
            note: status ? `${status.mirror} из ${status.local} сессий` : '',
          }),
        ];
        if (hasSecondary) {
          rows.push(
            h(ProgressRow, {
              key: 'secondary',
              label: BACKEND_LABELS[secondaryBackend] ?? 'Резерв',
              percent: backup?.percent ?? 0,
              done: (backup?.percent ?? 0) >= 100,
              note: backup
                ? `${megabytes(backup.doneBytes)} из ${megabytes(backup.totalBytes)} · ${backup.doneFiles} из ${backup.totalFiles} файлов`
                : 'готовится к выгрузке',
            }),
          );
        }

        const card = h(
          'div',
          {
            style: {
              position: 'fixed',
              left: Math.max(8, Math.min(anchor.left, window.innerWidth - 300)),
              bottom: window.innerHeight - anchor.top + 8,
              width: 280,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: '12px 14px',
              borderRadius: 12,
              border: '1px solid rgba(128,128,128,0.3)',
              background: 'var(--dsw-alias-bg-base, #22242a)',
              color: 'var(--dsw-alias-label-primary, inherit)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
              zIndex: 2147483000,
              pointerEvents: 'none',
            },
          },
          h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, 'Синхронизация'),
          ...rows,
        );

        try {
          return createPortal(card, document.body);
        } catch {
          return card;
        }
      }

      function SyncSidebarIcon(props) {
        const size = Number(props && props.size) || 16;
        const state = useSnapshot();
        const data = state.data;
        const ready = data !== null && data !== undefined;
        const pending = ready && data.pending === true;
        const percent = ready ? data.backup?.percent : undefined;
        const dotColor = !ready ? 'rgba(128,128,128,0.7)' : pending ? '#e8590c' : '#2f9e44';
        const hint = !ready
          ? 'Синхронизация сессий'
          : typeof percent === 'number'
            ? `${pending ? 'Есть изменения' : 'Синхронизировано'} · резерв ${percent}%`
            : pending
              ? 'Есть изменения'
              : 'Синхронизировано';

        return h(
          'span',
          { title: hint, style: { display: 'inline-flex', alignItems: 'center', position: 'relative' } },
          h(
            'svg',
            { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
            h('path', {
              d: 'M12.6 8A4.6 4.6 0 1 1 11.2 4.7',
              stroke: 'currentColor',
              strokeWidth: 1.2,
              strokeLinecap: 'round',
            }),
            h('path', {
              d: 'M12.7 2.5v2.7h-2.7',
              stroke: 'currentColor',
              strokeWidth: 1.2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ),
          h('span', {
            style: {
              position: 'absolute',
              top: -1,
              right: -2,
              width: 6,
              height: 6,
              borderRadius: 3,
              background: dotColor,
              boxShadow: '0 0 0 2px var(--dsw-alias-bg-base, #1c1d22)',
            },
          }),
          h(SyncToasts, null),
          // Модалка правил живёт здесь: меню сессии закрывается после клика, а
          // иконка в левой панели смонтирована всегда.
          h(SessionRulesDialogHost, null),
        );
      }

      // На странице плагина карточка не нужна: менеджер показывает описание, а
      // настройки живут в карточке своего плагина в списке. Иначе одна и та же
      // секция появляется на странице каждого установленного плагина.

      // Пункт в левой панели (рядом с «Расходами» и «Плагинами») и его страница:
      // пара slots.main + sidebar.panellist — тот же приём, что у других плагинов.
      try {
        ctx.slots.inject('main', () => {
          // Ключ совпадает с именем пакета: по нему хост открывает страницу
          // пункта панели. Старый ключ оставляем для совместимости.
          const SafePanel = () => h(ErrorBoundary, null, h(SyncPanel))
          ctx.slots.register({ name: 'main', key: 'dsh-sessions' }, SafePanel)
          ctx.slots.register({ name: 'main', key: 'dsh-sync' }, SafePanel)
        });
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'dsh-sessions',
          order: 6,
          label: () => 'Синхронизация сессий',
          locale: NS,
        }, SyncSidebarIcon));
      } catch (error) {
        console.error('[dsh-sync] пункт в левой панели недоступен:', error);
      }

      // Индикатор перед названием сессии: облако/монитор по макету.
      try {
        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
          name: 'sidebar.session.row.leading',
          id: 'dsh-sync',
          order: 60,
        }, SessionSyncIndicator));
      } catch (error) {
        console.error('[dsh-sync] индикатор в списке сессий недоступен:', error);
      }

      // Пункт в меню сессии: «локальная / облачная» и «Правила сессии…».
      // Два действия — один компонент: слот списка, но регистраций не больше.
      try {
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-sync.session-mode',
          order: 55,
        }, SessionMenuItems));
      } catch (error) {
        console.error('[dsh-sync] пункт меню сессии недоступен:', error);
      }

      // Переключатель «Облачная / Локальная» в шапке открытой сессии. Слот —
      // список действий сессии (session-scoped): в него передаётся sessionId.
      try {
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-sync.mode',
          order: 35,
          locale: NS,
          inject: (sessionId) => ({ sessionId: String(sessionId ?? '') }),
        }, SessionModeToggle));
      } catch (error) {
        console.error('[dsh-sync] переключатель режима в шапке сессии недоступен:', error);
      }



      // Плашка над полем ввода: состояние видно в основном окне.
      // В шапку беседы её ставить нельзя — это одиночный слот, занятый системой,
      // и повторная регистрация роняет загрузку интерфейса.
      try {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-sync-header',
          order: 80,
        }, SyncHeaderBadge));
      } catch (error) {
        console.error('[dsh-sync] плашка у поля ввода недоступна:', error);
      }


      // Настройки на странице плагина в панели «Плагины»: только для своего пакета.
      try {
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-sync-detail',
          order: 50,
          locale: NS,
        }, DetailSection));
        detailState = 'зарегистрирована'
      } catch (error) {
        detailState = 'ошибка: ' + String(error?.message ?? error).slice(0, 120)
        console.error('[dsh-sync] секция на странице плагина недоступна:', error);
      }

      // Строка в подвале панели убрана: она показывала служебные сообщения
    // вроде «есть изменения» и занимала место в интерфейсе.
    }

    // Хранилище состояния синхронизации на уровне модуля: его читают и
    // карточка плагина, и строка в подвале боковой панели.
    const listeners = new Set();
    let snapshot = { loading: true, data: null, error: '', busy: '', notice: '', plan: null, planError: '', planNote: '', onboarding: null, onboardingOpen: false, onboardingBusy: false, onboardingError: '', onboardingNotice: '', onboardingConfirm: '' };
    // Мостик к действиям онбординга для headless-тестов: сами функции живут
    // в замыкании apply(ctx), наружу их отдаёт этот объект.
    let onboardingActions = null;
    // Состояние обновления для headless-тестов рендера: в живом интерфейсе
    // всегда null и заполняется ответом маршрута /api/dsh-sync/update.
    let updateOverride = null;
    const useSnapshot = () => {
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        listeners.add(force);
        return () => listeners.delete(force);
      }, []);
      return snapshot;
    };

    // --- строка состояния в подвале боковой панели ------------------------
    /**
     * Компактная строка над «Pending changes»: состояние сессий и готовность
     * резервной копии. Читает тот же снимок, что и карточка плагина.
     */
    function SyncFooterRow() {
      const state = useSnapshot();
      const data = state.data;
      // Строка рисуется даже до загрузки состояния: так сразу видно, что место
      // в подвале панели действительно отдано, а не проигнорировано.
      const ready = data !== null && data !== undefined;

      const pending = ready && data.pending === true;
      const backup = ready ? data.backup : undefined;
      const percent = backup?.percent;
      const done = typeof percent === 'number' && percent >= 100;

      const dot = !ready ? 'rgba(128,128,128,0.6)' : pending ? '#e8590c' : '#2f9e44';
      const label = !ready ? 'синхронизация…' : pending ? 'есть изменения' : 'синхронизировано';

      return h(
        'div',
        {
          id: 'dsh-sync-footer-row',
          title: backup
            ? `Резервная копия: ${percent}% (${backup.doneFiles} из ${backup.totalFiles} файлов)`
            : 'Синхронизация сессий',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 32,
            padding: '0 10px',
            margin: '0 2px',
            borderRadius: 8,
            fontSize: 12.5,
            color: 'inherit',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          },
        },
        h('span', {
          style: {
            width: 7,
            height: 7,
            borderRadius: 4,
            background: dot,
            flex: '0 0 auto',
          },
        }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        typeof percent === 'number' && !done
          ? h('span', { style: { opacity: 0.7, marginLeft: 'auto' } }, `резерв ${percent}%`)
          : null,
      );
    }


    // --- индикатор синхронизации в списке сессий --------------------------
    // Один общий запрос на все строки: список перерисовывается часто, а
    // состояние меняется редко, поэтому кэш на 20 секунд.
    const SESSIONS_PATH = '/api/dsh-sync/sessions';
    const sessionStates = { data: {}, at: 0, listeners: new Set() };

    async function refreshSessionStates(force) {
      if (!force && Date.now() - sessionStates.at < 20_000) return;
      try {
        const result = await post(SESSIONS_PATH, {});
        sessionStates.data = result ?? null;
        sessionStates.at = Date.now();
        for (const listener of sessionStates.listeners) listener();
      } catch {
        // без индикаторов список работает как обычно
      }
    }

    function useSessionStates() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1);
        sessionStates.listeners.add(listener);
        void refreshSessionStates(false);
        return () => sessionStates.listeners.delete(listener);
      }, []);
      return sessionStates.data;
    }

    // Строка списка может появиться раньше, чем снимок сессий её увидит: новая
    // сессия создаётся сразу, а /sessions кэшируется на 20 секунд. Такая строка
    // сама просит обновить снимок — но не чаще раза в 3 секунды, чтобы первая
    // отрисовка длинного списка не завалила host-часть запросами.
    let sessionStatesAskedAt = 0;
    let sessionStatesAsking = false;
    function requestSessionStatesRefresh() {
      if (sessionStatesAsking) return;
      const now = Date.now();
      if (now - sessionStatesAskedAt < 3_000) return;
      sessionStatesAskedAt = now;
      sessionStatesAsking = true;
      void refreshSessionStates(true).finally(() => {
        sessionStatesAsking = false;
      });
    }

    // --- «Удалённые»: надгробия зеркала и восстановление из карантина -------
    // Один общий запрос на секцию и на кнопку «Обновить»; кэш на 20 секунд,
    // чтобы перерисовка страницы не дёргала host-часть на каждый чих.
    const tombstonesState = { data: null, at: 0, listeners: new Set() };

    async function refreshTombstones(force) {
      if (!force && Date.now() - tombstonesState.at < 20_000) return;
      try {
        const result = await post(TOMBSTONES_PATH, {});
        tombstonesState.data = result ?? null;
        tombstonesState.at = Date.now();
        for (const listener of tombstonesState.listeners) listener();
      } catch {
        // без списка удалённых страница работает как обычно
      }
    }

    function useTombstones() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1);
        tombstonesState.listeners.add(listener);
        void refreshTombstones(false);
        return () => tombstonesState.listeners.delete(listener);
      }, []);
      return tombstonesState.data;
    }

    // Причины и авторы удаления: коды приходят от host-части, подписи — здесь.
    const DELETED_REASON_LABELS = {
      manual: 'вручную',
      prune: 'автоочистка',
      expired: 'срок истёк',
      replaced: 'заменено',
      restored: 'восстановлено',
      children: 'вместе с родителем',
      duplicate: 'копия уже в зеркале',
      'made-local': 'переведена в локальные',
      superseded: 'заменена новой копией',
    };
    const DELETED_BY_LABELS = {
      owner: 'пользователь',
      sync: 'синхронизация',
    };

    /** «Осталось N дн.» и дата конца карантина. */
    function quarantineLabel(entry) {
      if (entry?.expired === true) return 'карантин истёк';
      const days = Number(entry?.remainingDays);
      if (!Number.isFinite(days)) return 'карантин 30 дней';
      if (days <= 0) return 'карантин истекает сегодня';
      return `в карантине ещё ${days} дн.`;
    }

    // Значки состояния сессии: подпись и цвет точки для старых мест списка.
    // Коды приходят от host-части (session-modes.mjs → sessionBadge).
    const SESSION_BADGES = {
      synced: { color: 'var(--dsw-alias-state-success-primary, #2f9e44)', title: 'Синхронизирована' },
      pending: { color: '#e8590c', title: 'Есть неотправленные изменения' },
      never: { color: 'var(--dsw-alias-state-error-primary, #d1242f)', title: 'Ещё не уходила в зеркало' },
      local: { color: 'rgba(128,128,128,0.85)', title: 'Локальная сессия: не синхронизируется' },
      conflict: { color: 'var(--dsw-alias-state-error-primary, #d1242f)', title: 'Конфликт: правки на двух устройствах' },
      offline: { color: '#b58900', title: 'Облако недоступно: последняя синхронизация не удалась' },
      unattached: { color: '#7048e8', title: 'Сессия не привязана к рабочему пространству' },
      exchanging: { color: '#4882FF', title: 'Идёт обмен с облаком' },
    };

    function badgeOf(code) {
      return SESSION_BADGES[code] ?? (code === 'green' ? SESSION_BADGES.synced : code === 'red' ? SESSION_BADGES.never : SESSION_BADGES.pending);
    }

    /** Короткий id сессии для tooltip: в тексте строки он не показывается. */
    function shortSessionId(value) {
      const id = String(value ?? '').replace(/^session-/, '');
      if (id === '') return '';
      return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
    }

    /**
     * Подпись сессии: в тексте — название, для безымянной — «Без названия».
     * Короткий id живёт только в tooltip (title-атрибут строки).
     * `titleSource` от host-части не меняет подпись: показываем, что пришло.
     */
    function sessionLabel(session) {
      const id = String(session?.id ?? '').replace(/^session-/, '');
      const folder = String(session?.path ?? '').split(/[\\/]+/).filter(Boolean).pop() ?? '';
      const title = String(session?.title ?? '').replace(/\s+/g, ' ').trim();
      const given = String(session?.shortId ?? '').replace(/\s+/g, ' ').trim();
      const shortId = given !== '' ? given : (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
      const display = title === '' ? 'Без названия' : title.slice(0, 80);
      return { id: display, title: display, shortId, folder };
    }

    // --- группы «родитель + субагенты» --------------------------------------
    // Связи приходят от host-части для каждой сессии: groupId (корень),
    // parentSession, children/childrenCount, childrenMissingCount, orphan,
    // groupSize. Если host ещё не обновился (полей нет) — строим вложенность по
    // parentSession, а счётчики выводим из childrenCount/groupSize.

    /** Сводка групп для шапки карточки: «групп: N, субагентов: M». */
    function sessionGroupSummary(sessions = [], groups = undefined) {
      const list = Array.isArray(sessions) ? sessions : [];
      const subagentsCount = list.filter((session) => String(session?.parentSession ?? '') !== '').length;
      const orphanCount = list.filter((session) => session?.orphan === true).length;
      const derived = new Set();
      for (const session of list) {
        if (session === null || typeof session !== 'object') continue;
        const groupId = String(session.groupId ?? '').trim();
        const childrenCount = Number(session.childrenCount ?? 0) || 0;
        const groupSize = Number(session.groupSize ?? 1) || 1;
        if (groupId !== '' && (childrenCount > 0 || groupSize > 1)) derived.add(groupId);
      }
      const pick = (value, fallback) => {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
      };
      const count = pick(groups?.count, derived.size);
      const subagents = pick(groups?.subagents, subagentsCount);
      const orphans = pick(groups?.orphans, orphanCount);
      const line = `групп: ${count}, субагентов: ${subagents}${orphans > 0 ? `, сирот: ${orphans}` : ''}`;
      return { groups: count, subagents, orphans, line };
    }

    /**
     * Строки списка сессий с вложенностью: субагенты идут под родителем.
     * Свёрнуто по умолчанию — дети попадают в список, только когда родитель в
     * `expanded`. Сирота (родителя нет в списке) показывается верхним уровнем.
     * @returns {Array<{session: object, depth: number, children: string[], expanded: boolean, isParent: boolean}>}
     */
    function sessionGroupRows(sessions = [], expanded = undefined) {
      const list = (Array.isArray(sessions) ? sessions : []).filter((session) => session !== null && typeof session === 'object');
      const byId = new Map();
      for (const session of list) {
        const id = String(session.id ?? '');
        if (id !== '' && !byId.has(id)) byId.set(id, session);
      }
      const childrenOf = new Map();
      for (const session of list) {
        const parent = String(session.parentSession ?? '').trim();
        if (parent === '' || !byId.has(parent) || parent === String(session.id ?? '')) continue;
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        const kids = childrenOf.get(parent);
        if (!kids.includes(session.id)) kids.push(session.id);
      }
      const isOpen = (id) => (expanded instanceof Set ? expanded.has(id) : Boolean(expanded?.[id]));
      const rows = [];
      const emitted = new Set();
      // Скрытые дети свёрнутой группы: они остаются в списке данных, но в
      // строки не попадают, пока родитель не раскрыт.
      const hidden = new Set();
      const markHidden = (id) => {
        for (const childId of childrenOf.get(id) ?? []) {
          if (hidden.has(childId)) continue;
          hidden.add(childId);
          markHidden(childId);
        }
      };
      const emit = (session, depth) => {
        if (emitted.has(session.id)) return;
        emitted.add(session.id);
        const children = childrenOf.get(session.id) ?? [];
        const open = children.length > 0 && isOpen(session.id);
        rows.push({ session, depth, children, expanded: open, isParent: children.length > 0 });
        if (!open) {
          for (const childId of children) {
            hidden.add(childId);
            markHidden(childId);
          }
          return;
        }
        for (const childId of children) {
          const child = byId.get(childId);
          if (child !== undefined) emit(child, depth + 1);
        }
      };
      // Порядок исходного списка: группа выводится там, где стоит родитель.
      for (const session of list) {
        const parent = String(session.parentSession ?? '').trim();
        if (parent !== '' && byId.has(parent) && parent !== String(session.id ?? '')) continue;
        emit(session, 0);
      }
      // Остались только циклы/странные ссылки: показываем верхним уровнем,
      // чтобы сессия не пропала из списка (скрытые дети свёрнутых групп — нет).
      for (const session of list) {
        if (emitted.has(session.id) || hidden.has(session.id)) continue;
        emit(session, 0);
      }
      return rows;
    }

    /** Счётчик групп в шапке карточки «Сессии и режим синхронизации». */
    function SessionGroupsCounter() {
      const data = useSessionStates();
      const summary = sessionGroupSummary(data?.sessions ?? [], data?.groups);
      return h('span', {
        className: 'dshs-groups-counter',
        title: 'Группы «родитель + субагенты»: семьи и субагенты в них',
        'data-groups': String(summary.groups),
        'data-subagents': String(summary.subagents),
        'data-orphans': String(summary.orphans),
      }, summary.line);
    }

    // --- индикатор синхронизации по макету ----------------------------------
    // Облако 26×18 со свечением и полоса 24×3 под ним; локальная сессия —
    // монитор 20×16 без полосы. Проценты — заполнение полосы (и заливки облака):
    // synced 100 % синяя, pending 55 % янтарная + пульс, exchanging 70 % синяя +
    // бегущая точка, conflict 100 % красная с «дыханием», offline 25 % серая с
    // перечёркнутым облаком. Цвета — бренд #6EE2FF→#4882FF, amber #F7BE4C,
    // red #EC6064, gray #7E8694.
    const INDICATOR_COLORS = {
      brandFrom: '#6EE2FF',
      brandTo: '#4882FF',
      amber: '#F7BE4C',
      red: '#EC6064',
      gray: '#7E8694',
    };

    /**
     * Состояния индикатора: вид, заполнение полосы, цвет и анимация.
     * `dot`: 'pulse' — пульсирующая точка у облака, 'run' — бегущая по полосе.
     * `breathe` — «дыхание» свечения у конфликта, `crossed` — облако перечёркнуто.
     */
    const INDICATOR_STATES = {
      synced: { kind: 'cloud', percent: 100, fill: 'gradient', color: INDICATOR_COLORS.brandTo, glow: true, title: 'Синхронизирована' },
      pending: { kind: 'cloud', percent: 55, fill: 'amber', color: INDICATOR_COLORS.amber, dot: 'pulse', title: 'Ждёт синхронизации' },
      exchanging: { kind: 'cloud', percent: 70, fill: 'gradient', color: INDICATOR_COLORS.brandTo, dot: 'run', title: 'Обмен с облаком' },
      conflict: { kind: 'cloud', percent: 100, fill: 'red', color: INDICATOR_COLORS.red, breathe: true, bang: true, title: 'Конфликт: правки на двух устройствах' },
      offline: { kind: 'cloud', percent: 25, fill: 'gray', color: INDICATOR_COLORS.gray, crossed: true, title: 'Облако недоступно' },
      local: { kind: 'monitor', percent: 0, color: INDICATOR_COLORS.gray, title: 'Локальная сессия: не синхронизируется' },
    };

    /**
     * Состояние индикатора строки сессии.
     * Код значка от host-части → визуальное состояние макета. Значки `never` и
     * `unattached` показываются янтарным «ждёт»: у макета нет отдельных цветов,
     * а подсказка объясняет причину точнее.
     */
    function indicatorStateOf(session, data) {
      if (session === null || session === undefined) return 'pending';
      if (session.mode === 'local') return 'local';
      if (session.badge === 'conflict') return 'conflict';
      if (data?.syncing === true) return 'exchanging';
      if (session.badge === 'offline') return 'offline';
      if (session.badge === 'synced') return 'synced';
      return 'pending';
    }

    /** Размер в коротком виде: 12,3 КБ. */
    function formatBytesShort(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '';
      if (value < 1024) return `${Math.round(value)} Б`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1).replace('.', ',')} КБ`;
      return `${(value / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
    }

    /**
     * Сколько операций ждёт в очереди повторов (outbox).
     *
     * Host отдаёт `outboxCount`, вложенный `outbox.count` или `lastRun.outbox`.
     * Строка «в очереди: N» показывается только когда очередь непуста.
     */
    function outboxCount(data) {
      const candidates = [
        data?.outboxCount,
        data?.outbox?.count,
        data?.lastRun?.outbox?.count,
        data?.lastRun?.outbox,
      ];
      for (const raw of candidates) {
        const value = typeof raw === 'object' && raw !== null ? Number(raw.count) : Number(raw);
        if (Number.isFinite(value) && value > 0) return Math.trunc(value);
      }
      return 0;
    }

    /**
     * Строка последней ошибки синхронизации из summary/last-run.
     *
     * Контракт с host-частью: `summary.errorKind` — вид сбоя (network, auth,
     * format, guard, reserve), `summary.failures` — сколько элементов не удалось
     * обработать (число или массив). Если данных нет, строки тоже нет.
     * Читаем и last-run: старые записи журнала поля summary не содержат.
     */
    function lastErrorLine(data) {
      const summary = data?.summary;
      const last = data?.lastRun;
      const errorKind = String(summary?.errorKind ?? last?.errorKind ?? '').trim();
      const raw = summary?.failures ?? last?.failures;
      const failures = Array.isArray(raw) ? raw.length : Math.max(0, Math.trunc(Number(raw)) || 0);
      if (errorKind === '' && failures === 0) return '';
      const parts = [];
      if (errorKind !== '') parts.push(`последняя ошибка: ${errorKind}`);
      if (failures > 0) parts.push(`неудач: ${failures}`);
      return parts.join(', ');
    }

    /**
     * Подсказка индикатора (title/aria): режим, дата последней синхронизации,
     * размер. Дополнительно — состояние и наличие облачной копии.
     */
    function indicatorTip(session, data) {
      const code = indicatorStateOf(session, data);
      const spec = INDICATOR_STATES[code] ?? INDICATOR_STATES.pending;
      const badge = badgeOf(session?.badge);
      const modeLabel = session?.mode === 'local' ? 'Локальная' : 'Облачная';
      let stateLabel;
      if (code === 'local') stateLabel = badge.title;
      else if (badge.title.startsWith(spec.title)) stateLabel = badge.title;
      else stateLabel = `${spec.title} (${badge.title})`;
      const size = formatBytesShort(session?.bytes);
      let sync = 'ещё не синхронизировалась';
      if (session?.mode === 'local') sync = 'синхронизация отключена, данные только здесь';
      else if (session?.syncedAt) sync = `последняя синхронизация ${formatMoment(session.syncedAt)}`;
      const parts = [`${modeLabel} сессия`, stateLabel, sync];
      if (size !== '') parts.push(`размер ${size}`);
      if (session?.mode === 'local' && session?.cloudCopy === true) parts.push('в облаке есть копия');
      return parts.join(' · ');
    }

    /** Короткий id для DOM-id подсказки. */
    function indicatorTipId(session) {
      const raw = String(session?.id ?? 'session').replace(/[^A-Za-z0-9_-]+/g, '-');
      return `dshs-ind-tip-${raw}`;
    }

    /** SVG облака 26×18 с заполнением по проценту и свечением состояния. */
    function syncCloudShape(session, spec, code) {
      const percent = Math.max(0, Math.min(100, Number(spec.percent) || 0));
      const rawId = String(session?.id ?? 'session').replace(/[^A-Za-z0-9_-]+/g, '');
      const fillId = `dshs-ind-fill-${rawId}`;
      const clipId = `dshs-ind-clip-${rawId}`;
      const path = 'M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18Z';
      const fill = spec.fill === 'gradient'
        ? `url(#${fillId})`
        : spec.fill === 'amber' ? INDICATOR_COLORS.amber
          : spec.fill === 'red' ? INDICATOR_COLORS.red
            : INDICATOR_COLORS.gray;
      return h(
        'svg',
        {
          width: 26,
          height: 18,
          viewBox: '0 0 24 24',
          preserveAspectRatio: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h(
          'defs',
          { key: 'defs' },
          h(
            'linearGradient',
            { id: fillId, x1: '0', y1: '0', x2: '1', y2: '0' },
            h('stop', { offset: '0', stopColor: INDICATOR_COLORS.brandFrom }),
            h('stop', { offset: '1', stopColor: INDICATOR_COLORS.brandTo }),
          ),
          h('clipPath', { id: clipId }, h('rect', { x: 0, y: 0, width: (percent / 100) * 24, height: 24 })),
        ),
        h('path', {
          key: 'outline',
          d: path,
          fill: 'rgba(126,134,148,0.14)',
          stroke: 'rgba(126,134,148,0.55)',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'fill',
          d: path,
          fill,
          'clip-path': `url(#${clipId})`,
          opacity: code === 'offline' ? 0.9 : 1,
        }),
        spec.crossed === true
          ? h('path', {
              key: 'cross',
              d: 'M4.5 3.5 19.5 20.5',
              stroke: INDICATOR_COLORS.gray,
              strokeWidth: 1.8,
              strokeLinecap: 'round',
            })
          : null,
        spec.crossed === true
          ? h('path', {
              key: 'cross2',
              d: 'M19.5 3.5 4.5 20.5',
              stroke: INDICATOR_COLORS.gray,
              strokeWidth: 1.8,
              strokeLinecap: 'round',
            })
          : null,
      );
    }

    /** Монитор 20×16 для локальной сессии: полосы у неё нет. */
    function syncMonitorShape() {
      return h(
        'svg',
        {
          width: 20,
          height: 16,
          viewBox: '0 0 20 16',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          key: 'screen',
          x: 1.5,
          y: 1,
          width: 17,
          height: 11,
          rx: 2,
          fill: 'none',
          stroke: INDICATOR_COLORS.gray,
          strokeWidth: 1.5,
        }),
        h('path', {
          key: 'stand',
          d: 'M7 15h6',
          stroke: INDICATOR_COLORS.gray,
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * Индикатор сессии: облако + полоса (или монитор для локальной).
     * Возвращает элемент всегда: строка без данных снимка получает состояние
     * «ждёт синхронизации» (янтарное облако 55 %). Доступен с клавиатуры
     * (tabIndex 0), подсказка в title/aria и во всплывающем блоке при наведении
     * и фокусе. При prefers-reduced-motion анимации отключаются, но заполнение
     * и «!»/перечёркивание остаются.
     */
    function SessionSyncIndicator({ sessionId, session: providedSession }) {
      const data = useSessionStates();
      const found = providedSession ?? (data?.sessions ?? []).find((item) => item.id === sessionId);
      // Инвариант: у каждой строки списка есть иконка. Если сессии ещё нет в
      // снимке (только что создана, либо снимок устарел), показываем «ещё не
      // уходила в облако» — янтарное облако 55 % — и просим обновить снимок,
      // а не оставляем строку без значка.
      const known = found !== undefined && found !== null;
      const session = known ? found : { id: String(sessionId ?? ''), mode: 'cloud', badge: 'never' };
      React.useEffect(() => {
        // Строка появилась или активировалась: обновляем снимок через общий
        // механизм (кэш 20 с + троттлинг запросов в requestSessionStatesRefresh),
        // чтобы у только что созданной сессии появился настоящий значок.
        requestSessionStatesRefresh();
      }, [sessionId, known]);
      const code = indicatorStateOf(session, data);
      const spec = INDICATOR_STATES[code] ?? INDICATOR_STATES.pending;
      const tip = indicatorTip(session, data);
      const tipId = indicatorTipId(session);
      return h(
        'span',
        {
          className: 'dshs-ind',
          'data-state': code,
          role: 'img',
          tabIndex: 0,
          title: tip,
          'aria-label': tip,
          'aria-describedby': tipId,
        },
        h(
          'span',
          { key: 'cloud', className: 'dshs-ind-cloud', 'aria-hidden': 'true' },
          spec.kind === 'monitor' ? syncMonitorShape() : syncCloudShape(session, spec, code),
          spec.dot === 'pulse' ? h('span', { key: 'dot', className: 'dshs-ind-dot' }) : null,
          spec.bang === true ? h('span', { key: 'bang', className: 'dshs-ind-bang', 'aria-hidden': 'true' }, '!') : null,
        ),
        spec.kind === 'monitor'
          ? null
          : h(
              'span',
              { key: 'bar', className: 'dshs-ind-bar', 'aria-hidden': 'true' },
              h('span', {
                className: `dshs-ind-bar-fill dshs-ind-bar-fill-${code}`,
                style: { width: `${spec.percent}%` },
              }),
              spec.dot === 'run' ? h('span', { key: 'run', className: 'dshs-ind-run' }) : null,
            ),
        h('span', { key: 'tip', id: tipId, className: 'dshs-ind-tip', role: 'tooltip' }, tip),
      );
    }

    /** Прежний слот индикатора зовёт SyncDot — оставляем имя совместимым. */
    function SyncDot(props) {
      return h(SessionSyncIndicator, { sessionId: props?.sessionId });
    }

    function CloudModeIcon({ size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: '0 0 auto' },
        },
        h('path', {
          d: 'M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function LocalModeIcon({ size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: '0 0 auto' },
        },
        h('rect', {
          x: 4,
          y: 5,
          width: 16,
          height: 12,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('path', { d: 'M9 20h6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    /** Пункт меню сессии: переключить «локальная / облачная». */
    function SessionSyncMenuItem(props) {
      const sessionId = props.sessionId;
      const [, setMenuOpen] = typeof props.useMenuOpenState === 'function'
        ? props.useMenuOpenState()
        : [false, () => {}];
      const data = useSessionStates();
      const session = (data?.sessions ?? []).find((item) => item.id === sessionId);
      const isLocal = session?.mode === 'local';
      const [busy, setBusy] = React.useState(false);
      const [copyConfirm, setCopyConfirm] = React.useState(false);
      const [copyNote, setCopyNote] = React.useState('');

      const toggle = async () => {
        setBusy(true);
        try {
          await post(SESSION_MODE_PATH, { id: sessionId, mode: isLocal ? 'cloud' : 'local' });
          await refreshSessionStates(true);
          setMenuOpen(false);
        } catch (error) {
          console.error('[dsh-sync] режим сессии не переключён:', error);
        } finally {
          setBusy(false);
        }
      };

      // Удаление только облачной копии локальной сессии: подтверждение —
      // второй клик в этом же меню, локальный лог не трогается.
      const removeCloudCopy = async () => {
        setBusy(true);
        setCopyNote('');
        try {
          const result = await post(SESSION_CLOUD_COPY_PATH, { id: sessionId, confirm: true });
          setCopyNote(result?.ok === true
            ? 'облачная копия удалена, локальная сессия осталась'
            : String(result?.message ?? 'не удалось удалить копию'));
          await refreshSessionStates(true);
          setCopyConfirm(false);
        } catch (error) {
          setCopyNote(`не удалось удалить копию: ${explain(error)}`);
        } finally {
          setBusy(false);
        }
      };

      return h('div', { style: { minWidth: 0 } }, [
        h('div', { key: 'separator', className: 'dshs-menu-separator', role: 'separator' }),
        h(
          'button',
          {
            key: 'item',
            type: 'button',
            role: 'menuitem',
            className: 'dshs-menu-item',
            disabled: busy,
            onClick: () => void toggle(),
          },
          [
            h('span', { key: 'icon', style: { display: 'inline-flex', color: 'inherit' } }, isLocal ? h(CloudModeIcon) : h(LocalModeIcon)),
            h('span', { key: 'label' }, isLocal ? 'Сделать облачной' : 'Сделать локальной'),
          ],
        ),
        isLocal && session?.cloudCopy === true
          ? h('div', { key: 'cloud-copy', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
              h('div', { key: 'sep2', className: 'dshs-menu-separator', role: 'separator' }),
              copyConfirm
                ? h('button', {
                    key: 'confirm',
                    type: 'button',
                    role: 'menuitem',
                    className: 'dshs-menu-item',
                    disabled: busy,
                    onClick: () => void removeCloudCopy(),
                  }, [
                    h('span', { key: 'icon', style: { display: 'inline-flex', color: 'inherit' } }, h(CloudModeIcon)),
                    h('span', { key: 'label' }, 'Да, удалить копию из облака'),
                  ])
                : h('button', {
                    key: 'ask',
                    type: 'button',
                    role: 'menuitem',
                    className: 'dshs-menu-item',
                    disabled: busy,
                    onClick: () => setCopyConfirm(true),
                  }, [
                    h('span', { key: 'icon', style: { display: 'inline-flex', color: 'inherit' } }, h(CloudModeIcon)),
                    h('span', { key: 'label' }, 'Удалить копию из облака'),
                  ]),
              h('span', { key: 'hint', style: { ...S.meta, padding: '0 10px 4px' } }, 'в облаке есть копия, локальная сессия останется'),
              copyNote !== '' ? h('span', { key: 'note', style: { ...S.meta, padding: '0 10px 4px' } }, copyNote) : null,
            ])
          : null,
      ]);
    }

    // --- переключатель режима в шапке открытой сессии ----------------------
    // «Локальная» — обещание «данные живут только здесь»: облачная копия уходит
    // в карантин, объявление пишется в зеркальный local-only.json и само не
    // снимается. Первое переключение спрашивает подтверждение один раз; после
    // него 10 секунд работает «Отменить». Меню и тост — порталом в body: слот
    // шапки обрезает выпадающие блоки.
    const LOCAL_ONLY_CONFIRM_KEY = 'dsh-sync.localOnlyConfirmed';

    function localOnlyConfirmed() {
      try {
        return globalThis.localStorage?.getItem(LOCAL_ONLY_CONFIRM_KEY) === '1';
      } catch {
        return false;
      }
    }

    function rememberLocalOnlyConfirmed() {
      try {
        globalThis.localStorage?.setItem(LOCAL_ONLY_CONFIRM_KEY, '1');
      } catch {
        // localStorage недоступен — подтверждение спросим ещё раз
      }
    }

    function portalToBody(node) {
      try {
        return createPortal(node, document.body);
      } catch {
        return node;
      }
    }

    /**
     * Тост с действием «Отменить»: живёт 10 секунд (и сам закрывается).
     * `onUndo` возвращает прежний режим, `onClose` убирает тост.
     */
    function LocalOnlyToast({ text, seconds = 10, onUndo, onClose }) {
      const [left, setLeft] = React.useState(seconds);
      React.useEffect(() => {
        const timer = setInterval(() => setLeft((value) => (value > 0 ? value - 1 : 0)), 1000);
        return () => clearInterval(timer);
      }, []);
      React.useEffect(() => {
        if (left <= 0 && typeof onClose === 'function') onClose();
      }, [left]);
      return portalToBody(h('div', { className: 'dshs-mode-toast', role: 'status', 'aria-live': 'polite' }, [
        h('span', { key: 'text', className: 'dshs-mode-toast-text' }, String(text ?? '')),
        h('span', { key: 'left', className: 'dshs-mode-toast-left' }, `${left} с`),
        typeof onUndo === 'function'
          ? h('button', { key: 'undo', type: 'button', onClick: () => onUndo() }, 'Отменить')
          : null,
        typeof onClose === 'function'
          ? h('button', { key: 'close', type: 'button', 'aria-label': 'Закрыть', onClick: () => onClose() }, '×')
          : null,
      ]));
    }

    /**
     * Мини-меню режима: объясняет разницу и предлагает переключение.
     * `confirm` — повторный шаг «точно убрать копию из облака» (один раз).
     */
    function SessionModeMenu({ mode = 'cloud', declared = false, busy = false, confirm = false, note = '', onChoose, onConfirm, onCancel, onClose }) {
      const isLocal = mode === 'local';
      const close = () => {
        if (typeof onClose === 'function') onClose();
      };
      const action = (label, variant, handler, key) => h('button', {
        key,
        type: 'button',
        role: 'menuitem',
        'data-variant': variant,
        disabled: busy,
        onClick: handler,
      }, label);
      const actions = confirm
        ? [
            action(busy ? 'Убираем…' : 'Убрать копию из облака', 'primary', () => {
              if (typeof onConfirm === 'function') onConfirm();
            }, 'confirm'),
            action('Отмена', 'secondary', () => {
              if (typeof onCancel === 'function') onCancel();
            }, 'cancel'),
          ]
        : isLocal
          ? [
              action(busy ? 'Отправляем…' : 'Сделать облачной', 'primary', () => {
                if (typeof onChoose === 'function') onChoose('cloud');
              }, 'to-cloud'),
              action('Закрыть', 'secondary', close, 'close'),
            ]
          : [
              action(busy ? 'Переключаем…' : 'Сделать локальной', 'primary', () => {
                if (typeof onChoose === 'function') onChoose('local');
              }, 'to-local'),
              action('Закрыть', 'secondary', close, 'close'),
            ];
      const menu = h(
        'div',
        {
          className: 'dshs-mode-layer',
          role: 'presentation',
          onClick: close,
        },
        h(
          'div',
          {
            className: 'dshs-mode-menu',
            role: 'menu',
            'aria-label': 'Режим сессии',
            onClick: (event) => event.stopPropagation(),
          },
          [
            h('div', { key: 'title', className: 'dshs-mode-menu-title' }, isLocal ? 'Локальная сессия' : 'Облачная сессия'),
            h('div', { key: 'text', className: 'dshs-mode-menu-text' }, isLocal
              ? 'Сессия остаётся только на этом устройстве: не отправляется в облако и не принимается из него. Другие устройства её не увидят.'
              : 'Сессия синхронизируется между устройствами: её можно открыть на другом компьютере или восстановить из облака.'),
            isLocal && declared
              ? h('div', { key: 'declared', className: 'dshs-mode-menu-warn' }, 'Объявление «локальная навсегда» записано в зеркало: другие устройства эту сессию не отправят и не примут.')
              : null,
            confirm
              ? h('div', { key: 'confirm', className: 'dshs-mode-menu-warn' }, 'Облачная копия уйдёт в карантин на 30 дней, а объявление «локальная навсегда» останется. Вернуть сессию в облако можно кнопкой «Сделать облачной».')
              : null,
            h('div', { key: 'actions', className: 'dshs-mode-menu-actions' }, actions),
            note !== '' ? h('div', { key: 'note', className: 'dshs-mode-menu-text' }, String(note)) : null,
          ],
        ),
      );
      return portalToBody(menu);
    }

    /**
     * Переключатель «Облачная / Локальная» в шапке открытой сессии.
     * Подтверждение — один раз на устройство; после переключения в локальную
     * показывается тост «Отменить» (10 секунд) с возвратом в облако.
     */
    function SessionModeToggle(props) {
      const sessionId = String(props?.sessionId ?? '');
      const data = useSessionStates();
      const session = (data?.sessions ?? []).find((item) => item.id === sessionId);
      const mode = session?.mode === 'local' ? 'local' : 'cloud';
      const isLocal = mode === 'local';
      const declared = session?.declared === true;
      const [open, setOpen] = React.useState(false);
      const [confirm, setConfirm] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState('');
      const [toast, setToast] = React.useState(null);
      React.useEffect(() => {
        // У только что открытой сессии могло не быть снимка — просим обновить.
        requestSessionStatesRefresh();
      }, [sessionId]);

      const apply = async (target) => {
        setBusy(true);
        setNote('');
        try {
          const result = await post(SESSION_MODE_PATH, {
            id: sessionId,
            mode: target,
            ...(target === 'cloud' ? { push: true } : {}),
          });
          await refreshSessionStates(true);
          setOpen(false);
          setConfirm(false);
          if (target === 'local') {
            const removed = Number(result?.localOnly?.quarantined ?? 0);
            setToast({
              text: removed > 0
                ? 'Сессия локальная навсегда: облачная копия убрана в карантин'
                : 'Сессия локальная навсегда: облачной копии не было',
              undo: true,
            });
          } else {
            setToast({ text: 'Сессия снова облачная: объявление снято', undo: false });
          }
        } catch (error) {
          setNote(`Не удалось переключить режим: ${explain(error)}`);
        } finally {
          setBusy(false);
        }
      };

      const choose = (target) => {
        if (target === mode) {
          setOpen(false);
          return;
        }
        if (target === 'local' && !localOnlyConfirmed()) {
          setConfirm(true);
          setNote('');
          return;
        }
        void apply(target);
      };

      const confirmLocal = () => {
        rememberLocalOnlyConfirmed();
        void apply('local');
      };

      const label = isLocal ? 'Локальная' : 'Облачная';
      const title = isLocal
        ? (declared ? 'Режим сессии: локальная навсегда' : 'Режим сессии: локальная')
        : 'Режим сессии: облачная';
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } }, [
        h('button', {
          key: 'toggle',
          type: 'button',
          className: 'dshs-mode-toggle',
          'data-mode': mode,
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          title,
          disabled: busy || sessionId === '',
          onClick: () => {
            setOpen((value) => !value);
            setConfirm(false);
            setNote('');
          },
        }, [
          h('span', { key: 'icon', style: { display: 'inline-flex', color: 'inherit' } }, isLocal ? h(LocalModeIcon, { size: 13 }) : h(CloudModeIcon, { size: 13 })),
          h('span', { key: 'label' }, label),
          h('span', { key: 'chev', className: 'dshs-mode-toggle-chev', 'aria-hidden': 'true' }, '▾'),
        ]),
        open
          ? h(SessionModeMenu, {
              key: 'menu',
              mode,
              declared,
              busy,
              confirm,
              note,
              onChoose: choose,
              onConfirm: confirmLocal,
              onCancel: () => {
                setConfirm(false);
                setNote('');
              },
              onClose: () => {
                setOpen(false);
                setConfirm(false);
              },
            })
          : null,
        toast !== null
          ? h(LocalOnlyToast, {
              key: 'toast',
              text: toast.text,
              seconds: 10,
              onUndo: toast.undo === true
                ? () => {
                    setToast(null);
                    void apply('cloud');
                  }
                : undefined,
              onClose: () => setToast(null),
            })
          : null,
      ]);
    }

    // --- M6: правила сессий ---------------------------------------------------
    // Хранилище правил живёт в host-части (~/.dsh/dsh-sync/session-rules.json),
    // копия — в зеркале профиля. Клиент читает сводку GET /session-rules и
    // показывает: карточку «Правила», щиты и лимиты в списке сессий, пункт
    // «Правила сессии…» в меню сессии и модалку с пресетами и полями.
    const RULE_PRESETS = {
      control: {
        label: 'Контрольная',
        hint: 'не удалять, лимит 15 МБ, запрет развилки, уведомлять',
        fields: { protect: true, maxMb: 15, forbidFork: true, notifyForeignAppend: true },
      },
      keep: { label: 'Неприкосновенная', hint: 'не удалять из зеркала', fields: { protect: true } },
      archive: { label: 'Архив', hint: 'локальная навсегда и не удалять', fields: { syncMode: 'local', protect: true } },
      none: { label: 'Обычная', hint: 'снять правило: сессия как все', fields: {} },
    };
    const RULE_PRESET_ORDER = ['control', 'keep', 'archive', 'none'];
    const RULE_SOURCE_LABELS = {
      session: 'правило сессии',
      parent: 'унаследовано от родителя',
      match: 'правило по шаблону',
      default: 'без правила',
    };
    const RULE_FILTERS = [
      ['all', 'Все'],
      ['protected', 'Защищённые'],
      ['control', 'Контрольные'],
      ['archive', 'Архив'],
    ];
    const RULES_VERIFY_BUCKETS = [
      ['protected', 'Защищены от чистки'],
      ['ownerBlocked', 'Только владелец (push пропустит)'],
      ['overLimit', 'Переросли лимит'],
      ['localOnly', 'Объявлены локальными'],
      ['forbidFork', 'Запрещена развилка'],
      ['notify', 'Уведомлять о дополнении'],
    ];

    // Один общий запрос правил на всю страницу и меню: сводка меняется редко,
    // кэш 20 секунд, как у снимка сессий.
    const RULES_REPORT_TTL_MS = 20_000;
    const rulesState = { data: null, at: 0, loading: false, listeners: new Set() };
    const rulesVerify = { data: null, at: 0, busy: false, error: '' };

    async function refreshSessionRules(force) {
      if (!force && Date.now() - rulesState.at < RULES_REPORT_TTL_MS) return rulesState.data;
      if (rulesState.loading) return rulesState.data;
      rulesState.loading = true;
      try {
        const report = await get(SESSION_RULES_PATH);
        rulesState.data = report ?? null;
        rulesState.at = Date.now();
        return report;
      } catch {
        // без правил панель и меню работают как раньше
        return rulesState.data;
      } finally {
        rulesState.loading = false;
        for (const listener of rulesState.listeners) listener();
      }
    }

    function useSessionRules() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1);
        rulesState.listeners.add(listener);
        void refreshSessionRules(false);
        return () => rulesState.listeners.delete(listener);
      }, []);
      return rulesState.data;
    }

    function useRulesVerify() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1);
        rulesState.listeners.add(listener);
        return () => rulesState.listeners.delete(listener);
      }, []);
      return { data: rulesVerify.data, busy: rulesVerify.busy, error: rulesVerify.error };
    }

    /** «Проверить правила»: только чтение — корзины, источники, конфликты. */
    async function verifyRules() {
      if (rulesVerify.busy) return rulesVerify.data;
      rulesVerify.busy = true;
      rulesVerify.error = '';
      for (const listener of rulesState.listeners) listener();
      try {
        const report = await get(SESSION_RULES_VERIFY_PATH);
        rulesVerify.data = report ?? null;
        rulesVerify.at = Date.now();
        return report;
      } catch (error) {
        rulesVerify.error = `Проверка правил не удалась: ${explain(error)}`;
        return null;
      } finally {
        rulesVerify.busy = false;
        for (const listener of rulesState.listeners) listener();
      }
    }

    /** Мегабайты для подписи: 15 → «15», 18.42 → «18,4», 0.012 → «0,012». */
    function formatMbValue(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '—';
      const rounded = number >= 1 ? Math.round(number * 10) / 10 : Math.round(number * 1000) / 1000;
      return String(rounded).replace('.', ',');
    }

    /** Правило сессии из сводки: по id, с нормализацией префикса `session-`. */
    function rulesRowOf(report, sessionId) {
      const rows = Array.isArray(report?.sessions) ? report.sessions : [];
      const wanted = String(sessionId ?? '');
      if (wanted === '') return undefined;
      return rows.find((row) => String(row?.id ?? '') === wanted)
        ?? rows.find((row) => String(row?.id ?? '').replace(/^session-/, '') === wanted.replace(/^session-/, ''));
    }

    /** Список id из последнего запуска: что правило удержало. */
    function rulesIdsOf(report, key) {
      const list = report?.lastRun !== null && typeof report?.lastRun === 'object' ? report.lastRun[key] : undefined;
      return new Set((Array.isArray(list) ? list : []).map((id) => String(id)));
    }

    /** Фильтр карточки «Правила»: все / защищённые / контрольные / архив. */
    function rulesFilterRows(rows, filter) {
      const list = Array.isArray(rows) ? rows : [];
      if (filter === 'protected') return list.filter((row) => row?.protect === true);
      if (filter === 'control') return list.filter((row) => row?.preset === 'control');
      if (filter === 'archive') return list.filter((row) => row?.preset === 'archive' || row?.syncMode === 'local');
      return list;
    }

    /** Сессии, у которых есть что показать в карточке «Правила». */
    function rulesVisibleRows(report) {
      const rows = Array.isArray(report?.sessions) ? report.sessions : [];
      return rows.filter((row) => row?.hasRule === true || row?.overLimit === true || row?.ownerBlocked === true);
    }

    /** Название сессии для строки правил: без пустых подписей. */
    function rulesRowTitle(row) {
      const title = String(row?.title ?? '').replace(/\s+/g, ' ').trim();
      if (title !== '') return title.slice(0, 80);
      const shortId = String(row?.shortId ?? '').replace(/\s+/g, ' ').trim();
      return shortId !== '' ? shortId : 'Без названия';
    }

    /** Щит: «защищена правилом». Рисуется currentColor, читается на 14–24 px. */
    function ShieldIcon({ size = 14, protectedByRule = true }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: '0 0 auto' },
        },
        h('path', {
          d: 'M12 3.2 5.5 5.9v5.2c0 3.9 2.7 6.9 6.5 8.7 3.8-1.8 6.5-4.8 6.5-8.7V5.9L12 3.2Z',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinejoin: 'round',
        }),
        protectedByRule === true
          ? h('path', {
              d: 'm9.2 11.6 2 2 3.7-4',
              stroke: 'currentColor',
              strokeWidth: 1.7,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            })
          : null,
      );
    }

    /** Бейдж правила: пресет, владелец, лимит, чужое изменение. */
    function RuleBadge({ tone = 'preset', title = '', children }) {
      return h('span', { className: 'dshs-rules-badge', 'data-tone': tone, title }, children);
    }

    // --- карточка «Правила» в панели ---------------------------------------
    /**
     * Карточка «Правила»: список сессий с правилом, фильтр, щиты и бейджи,
     * «Проверить правила» и отчёт корзинами. Живёт внутри карточки «Сессии и
     * режим», чтобы не ломать четыре основные карточки страницы (M3).
     */
    function SessionRulesPanel() {
      const report = useSessionRules();
      const verify = useRulesVerify();
      const [filter, setFilter] = React.useState('all');
      const rows = rulesVisibleRows(report);
      const filtered = rulesFilterRows(rows, filter);
      const counts = report?.counts !== null && typeof report?.counts === 'object' ? report.counts : {};
      const foreignIds = rulesIdsOf(report, 'foreignChangeIds');
      const messages = Array.isArray(report?.lastRun?.messages) ? report.lastRun.messages.filter((line) => typeof line === 'string' && line !== '') : [];
      const verifyData = verify.data;
      const conflicts = Array.isArray(verifyData?.conflicts) ? verifyData.conflicts : [];

      const chips = RULE_FILTERS.map(([key, label]) => {
        const count = rulesFilterRows(rows, key).length;
        return h(
          'button',
          {
            key,
            type: 'button',
            className: 'dshs-rules-chip',
            'data-filter': key,
            'data-active': filter === key ? 'true' : 'false',
            'aria-pressed': filter === key ? 'true' : 'false',
            style: {
              ...S.buttonSmall,
              ...(filter === key
                ? {
                    background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dcc) 16%, transparent)',
                    borderColor: 'var(--dsw-alias-brand-primary, #4a7dcc)',
                  }
                : {}),
            },
            onClick: () => setFilter(key),
          },
          `${label} (${count})`,
        );
      });

      return h(
        'section',
        { className: 'dshs-rules-card', 'aria-labelledby': 'dshs-rules-title', 'data-rules': String(rows.length) },
        h(
          'div',
          { className: 'dshs-rules-head' },
          h('span', { className: 'dshs-rules-accent', 'aria-hidden': 'true' }),
          h(
            'h3',
            { id: 'dshs-rules-title', className: 'dshs-rules-title' },
            h(ShieldIcon, { size: 15 }),
            'Правила',
          ),
          h(
            'span',
            { className: 'dshs-rules-summary' },
            `правил: ${counts.sessions ?? 0} · защищено: ${counts.protected ?? 0}${(counts.overLimit ?? 0) > 0 ? ` · лимит: ${counts.overLimit}` : ''}`,
          ),
          h(
            'button',
            {
              type: 'button',
              style: { ...S.buttonSmall, marginLeft: 'auto' },
              disabled: verify.busy === true,
              onClick: () => void verifyRules(),
            },
            verify.busy === true ? 'Проверяем…' : 'Проверить правила',
          ),
        ),
        h(
          'span',
          { style: S.hint },
          'Правило защищает сессию от чистки, отправляет её только с устройства-владельца и следит за размером лога. Задаётся в меню сессии «Правила сессии…».',
        ),
        messages.length > 0
          ? h(
              'div',
              { className: 'dshs-rules-notice' },
              messages.slice(0, 5).map((line, index) => h('span', { key: `notice-${index}` }, line)),
            )
          : null,
        h('div', { className: 'dshs-rules-filters' }, chips),
        filtered.length === 0
          ? h(
              'span',
              { style: S.hint },
              rows.length === 0
                ? 'Правил пока нет: откройте меню сессии и выберите «Правила сессии…».'
                : 'Под фильтр ничего не попало.',
            )
          : h(
              'div',
              { className: 'dshs-rules-list' },
              filtered.map((row) => h(
                'div',
                {
                  key: row.id,
                  className: 'dshs-rules-row',
                  'data-source': row.ruleSource ?? 'default',
                  'data-over-limit': row.overLimit === true ? 'true' : undefined,
                  title: `${row.shortId || row.id}${row.inheritedFrom ? ` · унаследовано от ${row.inheritedFrom}` : ''}`,
                },
                h(
                  'span',
                  {
                    className: 'dshs-rules-shield',
                    'data-protected': row.protect === true ? 'true' : 'false',
                    title: row.protect === true ? 'Сессия защищена правилом' : 'Правило без защиты',
                  },
                  h(ShieldIcon, { size: 15, protectedByRule: row.protect === true }),
                ),
                h(
                  'span',
                  { className: 'dshs-rules-row-text' },
                  h('span', { className: 'dshs-rules-row-title' }, rulesRowTitle(row)),
                  h(
                    'span',
                    { style: S.meta },
                    `${row.presetLabel !== '' && row.presetLabel !== undefined ? `пресет: ${row.presetLabel}` : 'своё правило'} · ${RULE_SOURCE_LABELS[row.ruleSource] ?? 'правило'}`,
                  ),
                ),
                row.presetLabel !== '' && row.presetLabel !== undefined
                  ? h(RuleBadge, { key: 'preset', tone: 'preset' }, row.presetLabel)
                  : null,
                row.ownerBlocked === true
                  ? h(RuleBadge, { key: 'owner', tone: 'owner', title: row.message ?? '' }, 'правило: только владелец')
                  : null,
                foreignIds.has(String(row.id))
                  ? h(RuleBadge, { key: 'foreign', tone: 'warn', title: 'Лог изменён другим устройством: изменение не применено' }, 'изменено не владельцем')
                  : null,
                row.overLimit === true
                  ? h(
                      RuleBadge,
                      { key: 'limit', tone: 'limit', title: row.message ?? '' },
                      `лимит: ${formatMbValue(row.mb)}/${formatMbValue(row.maxMb ?? row.limitMb)} МБ`,
                    )
                  : null,
              )),
            ),
        verify.error !== ''
          ? h('span', { style: S.error }, verify.error)
          : null,
        verifyData !== null && verifyData !== undefined
          ? h(
              'div',
              { className: 'dshs-rules-report' },
              h('span', { style: S.label }, verifyData.note ?? 'Проверка ничего не изменила.'),
              h(
                'div',
                { className: 'dshs-rules-buckets' },
                RULES_VERIFY_BUCKETS.map(([key, label]) => {
                  const items = Array.isArray(verifyData.buckets?.[key]) ? verifyData.buckets[key] : [];
                  return h(
                    'div',
                    { key, className: 'dshs-rules-bucket', 'data-bucket': key },
                    h('span', { className: 'dshs-rules-bucket-label' }, label),
                    h('span', { className: 'dshs-rules-bucket-value' }, String(items.length)),
                    h('span', { className: 'dshs-rules-bucket-items' }, items.slice(0, 3).map((item) => rulesRowTitle(item)).join(', ')),
                  );
                }),
              ),
              conflicts.length > 0
                ? h(
                    'span',
                    { className: 'dshs-rules-bucket-items' },
                    `конфликтов слияния: ${conflicts.length}. Побеждает правило с более свежим updatedAt; конфликт записан в rules-history.`,
                  )
                : null,
            )
          : null,
      );
    }

    // --- модалка «Правила сессии…» ------------------------------------------
    /** Пустой черновик правила: «Обычная» сессия без правила. */
    function emptyRuleDraft() {
      return { preset: '', owner: false, protect: false, maxMb: '', forbidFork: false, notify: false, syncMode: 'cloud' };
    }

    /** Черновик из текущего правила сессии: пресет, владелец, поля. */
    function draftFromRule(rule, deviceId) {
      if (rule === undefined || rule === null || rule.hasRule !== true) return emptyRuleDraft();
      return {
        preset: typeof rule.preset === 'string' ? rule.preset : '',
        owner: typeof rule.ownerDevice === 'string' && rule.ownerDevice !== ''
          && typeof deviceId === 'string' && rule.ownerDevice === deviceId,
        protect: rule.protect === true,
        maxMb: Number.isFinite(rule.maxMb) ? String(rule.maxMb) : '',
        forbidFork: rule.forbidFork === true,
        notify: rule.notifyForeignAppend === true,
        syncMode: rule.syncMode === 'local' ? 'local' : 'cloud',
      };
    }

    /**
     * Тело POST /session-rules из черновика. «Обычная» без включённых полей —
     * это снятие правила (`clear`), иначе — пресет и явные поля.
     */
    function buildRulePayload({ sessionId, draft, deviceId }) {
      const preset = typeof draft?.preset === 'string' && draft.preset !== '' ? draft.preset : '';
      const patch = {
        protect: draft?.protect === true,
        forbidFork: draft?.forbidFork === true,
        notifyForeignAppend: draft?.notify === true,
        syncMode: draft?.syncMode === 'local' ? 'local' : 'cloud',
      };
      if (draft?.owner === true && typeof deviceId === 'string' && deviceId !== '') patch.ownerDevice = deviceId;
      const maxText = String(draft?.maxMb ?? '').replace(',', '.').trim();
      if (maxText !== '') {
        const value = Number.parseFloat(maxText);
        if (Number.isFinite(value) && value > 0) patch.maxMb = value;
      }
      const neutral = preset === ''
        && patch.protect !== true
        && patch.forbidFork !== true
        && patch.notifyForeignAppend !== true
        && patch.syncMode !== 'local'
        && patch.maxMb === undefined
        && patch.ownerDevice === undefined;
      if (neutral) return { id: sessionId, clear: true };
      const payload = { id: sessionId, patch };
      if (preset !== '') payload.preset = preset;
      return payload;
    }

    /** Модалка правила: чипы пресетов, поля, «Сохранить» и «Проверить правила». */
    function SessionRulesDialog({ sessionId, onClose }) {
      const report = useSessionRules();
      const verify = useRulesVerify();
      const deviceId = typeof report?.deviceId === 'string' ? report.deviceId : '';
      const rule = rulesRowOf(report, sessionId);
      const [draft, setDraft] = React.useState(() => draftFromRule(rule, deviceId));
      // Пока пользователь не менял поля, черновик догоняет загрузку сводки:
      // модалка может открыться раньше, чем пришёл GET /session-rules.
      const [touched, setTouched] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      React.useEffect(() => {
        void refreshSessionRules(false);
      }, []);
      React.useEffect(() => {
        if (touched) return;
        setDraft(draftFromRule(rule, deviceId));
      }, [rule?.id, rule?.updatedAt, deviceId, touched]);
      const set = (patch) => {
        setTouched(true);
        setDraft((current) => ({ ...current, ...patch }));
      };

      // Пресет раскладывается в поля сразу: до сохранения видно, что попадёт в
      // правило, а «Обычная» снимает все галочки.
      const applyPreset = (name) => {
        const fields = name !== 'none' ? (RULE_PRESETS[name]?.fields ?? {}) : {};
        set({
          preset: name === 'none' ? '' : name,
          owner: typeof fields.ownerDevice === 'string' && fields.ownerDevice !== '',
          protect: fields.protect === true,
          maxMb: Number.isFinite(fields.maxMb) ? String(fields.maxMb) : '',
          forbidFork: fields.forbidFork === true,
          notify: fields.notifyForeignAppend === true,
          syncMode: fields.syncMode === 'local' ? 'local' : 'cloud',
        });
      };

      const save = async () => {
        if (busy !== '') return;
        setBusy('save');
        setError('');
        setNotice('');
        try {
          const result = await post(SESSION_RULES_PATH, buildRulePayload({ sessionId, draft, deviceId }));
          if (result?.ok !== true) {
            setError(result?.message ?? 'Правило не сохранено.');
            return;
          }
          setNotice(result.action === 'clear' ? 'Правило снято: сессия обычная.' : 'Правило сохранено.');
          const warnings = Array.isArray(result.warnings) ? result.warnings : [];
          if (warnings.length > 0) setError(String(warnings[0]?.message ?? ''));
          await refreshSessionRules(true);
        } catch (saveError) {
          setError(`Правило не сохранено: ${explain(saveError)}`);
        } finally {
          setBusy('');
        }
      };

      const chips = RULE_PRESET_ORDER.map((name) => h(
        'button',
        {
          key: name,
          type: 'button',
          className: 'dshs-rules-chip',
          'data-preset': name,
          'data-active': (name === 'none' ? draft.preset === '' && draft.protect !== true && draft.maxMb === '' : draft.preset === name) ? 'true' : 'false',
          'aria-pressed': (name === 'none' ? draft.preset === '' : draft.preset === name) ? 'true' : 'false',
          title: RULE_PRESETS[name]?.hint ?? '',
          style: {
            ...S.buttonSmall,
            ...(draft.preset === name || (name === 'none' && draft.preset === '' && draft.protect !== true && draft.maxMb === '')
              ? {
                  background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dcc) 16%, transparent)',
                  borderColor: 'var(--dsw-alias-brand-primary, #4a7dcc)',
                }
              : {}),
          },
          onClick: () => applyPreset(name),
        },
        RULE_PRESETS[name]?.label ?? name,
      ));

      const verifyData = verify.data;
      return portalToBody(h(
        'div',
        { className: 'dshs-rules-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Правила сессии' },
        h(
          'div',
          { className: 'dshs-rules-dialog' },
          h(
            'div',
            { className: 'dshs-rules-dialog-head' },
            h(ShieldIcon, { size: 18, protectedByRule: rule?.protect === true }),
            h('span', { className: 'dshs-rules-dialog-title' }, 'Правила сессии'),
            h('span', { style: S.meta }, rule?.title !== undefined && rule?.title !== '' ? rulesRowTitle(rule) : shortSessionId(sessionId)),
            h(
              'button',
              { type: 'button', style: { ...S.buttonSmall, marginLeft: 'auto' }, onClick: () => (typeof onClose === 'function' ? onClose() : undefined) },
              'Закрыть',
            ),
          ),
          h(
            'span',
            { className: 'dshs-rules-dialog-text' },
            'Правило действует на этом и на других устройствах: защищает сессию от чистки, ограничивает отправку владельцем и следит за размером лога. Субагент наследует правило родителя; своё правило сильнее.',
          ),
          h('div', { className: 'dshs-rules-chips' }, chips),
          h(
            'div',
            { className: 'dshs-rules-fields' },
            h(
              'label',
              { className: 'dshs-rules-field' },
              h('input', {
                type: 'checkbox',
                checked: draft.owner === true,
                onChange: (event) => set({ owner: event.target.checked }),
              }),
              h('span', null, `Владелец — этот компьютер${deviceId !== '' ? ` (${deviceId})` : ''}: отправлять сессию может только он`),
            ),
            h(
              'label',
              { className: 'dshs-rules-field' },
              h('input', {
                type: 'checkbox',
                checked: draft.protect === true,
                onChange: (event) => set({ protect: event.target.checked }),
              }),
              h('span', null, 'Защита: не удалять из зеркала при чистке'),
            ),
            h(
              'label',
              { className: 'dshs-rules-field' },
              h('span', null, 'Лимит лога, МБ'),
              h('input', {
                type: 'number',
                min: '0',
                step: '0.1',
                value: draft.maxMb,
                placeholder: 'например, 15',
                style: { ...S.input, height: 36 },
                onChange: (event) => set({ maxMb: event.target.value }),
              }),
              h('span', { style: S.meta }, 'при превышении — предложение перевести в локальные'),
            ),
            h(
              'label',
              { className: 'dshs-rules-field' },
              h('input', {
                type: 'checkbox',
                checked: draft.forbidFork === true,
                onChange: (event) => set({ forbidFork: event.target.checked }),
              }),
              h('span', null, 'Запрет развилки: не создавать копию при расхождении'),
            ),
            h(
              'label',
              { className: 'dshs-rules-field' },
              h('input', {
                type: 'checkbox',
                checked: draft.notify === true,
                onChange: (event) => set({ notify: event.target.checked }),
              }),
              h('span', null, 'Уведомлять, если лог дополнило другое устройство'),
            ),
            h(
              'label',
              { className: 'dshs-rules-field' },
              h('input', {
                type: 'checkbox',
                checked: draft.syncMode === 'local',
                onChange: (event) => set({ syncMode: event.target.checked ? 'local' : 'cloud' }),
              }),
              h('span', null, 'Только локальная: не отправлять в зеркало (архив)'),
            ),
          ),
          h(
            'div',
            { className: 'dshs-rules-actions' },
            h(
              'button',
              {
                type: 'button',
                'data-variant': 'primary',
                style: { ...S.primary },
                disabled: busy !== '',
                onClick: () => void save(),
              },
              busy === 'save' ? 'Сохраняем…' : 'Сохранить',
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.button },
                disabled: verify.busy === true,
                onClick: () => void verifyRules(),
              },
              verify.busy === true ? 'Проверяем…' : 'Проверить правила',
            ),
            busy !== ''
              ? h('span', { style: S.meta }, 'Сохраняем правило…')
              : null,
          ),
          error !== '' ? h('span', { style: S.error }, error) : null,
          notice !== '' ? h('span', { style: S.ok }, notice) : null,
          verify.error !== '' ? h('span', { style: S.error }, verify.error) : null,
          verifyData !== null && verifyData !== undefined
            ? h(
                'div',
                { className: 'dshs-rules-report' },
                h('span', { style: S.label }, verifyData.note ?? 'Проверка ничего не изменила.'),
                h(
                  'span',
                  { className: 'dshs-rules-bucket-items' },
                  (Array.isArray(verifyData.lines) ? verifyData.lines : []).join(' · '),
                ),
                verifyData.sources !== null && typeof verifyData.sources === 'object'
                  ? h(
                      'span',
                      { className: 'dshs-rules-bucket-items' },
                      `источник правила — сессия: ${verifyData.sources.session ?? 0}, родитель: ${verifyData.sources.parent ?? 0}, шаблон: ${verifyData.sources.match ?? 0}`,
                    )
                  : null,
              )
            : null,
        ),
      ));
    }

    /**
     * Общее состояние модалки правил. Меню сессии закрывается после клика и его
     * компонент размонтируется — поэтому модалка живёт в постоянном Host'е
     * (иконка плагина в левой панели), а не внутри пункта меню.
     */
    const rulesDialog = { sessionId: '', open: false, listeners: new Set() };

    function setRulesDialog(next) {
      rulesDialog.sessionId = typeof next?.sessionId === 'string' ? next.sessionId : rulesDialog.sessionId;
      rulesDialog.open = next?.open === true;
      for (const listener of rulesDialog.listeners) listener();
    }

    function openRulesDialog(sessionId) {
      setRulesDialog({ sessionId: String(sessionId ?? ''), open: true });
    }

    function closeRulesDialog() {
      setRulesDialog({ open: false });
    }

    function useRulesDialogState() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1);
        rulesDialog.listeners.add(listener);
        return () => rulesDialog.listeners.delete(listener);
      }, []);
      return { sessionId: rulesDialog.sessionId, open: rulesDialog.open };
    }

    /** Постоянное место модалки правил: рисуется из иконки в левой панели. */
    function SessionRulesDialogHost() {
      const state = useRulesDialogState();
      if (state.open !== true || state.sessionId === '') return null;
      return h(SessionRulesDialog, { sessionId: state.sessionId, onClose: closeRulesDialog });
    }

    /** Пункт меню сессии «Правила сессии…»: открывает модалку правила. */
    function SessionRulesMenuItem(props) {
      const sessionId = props?.sessionId;
      const [, setMenuOpen] = typeof props?.useMenuOpenState === 'function'
        ? props.useMenuOpenState()
        : [false, () => {}];
      const report = useSessionRules();
      const rule = rulesRowOf(report, sessionId);
      React.useEffect(() => {
        void refreshSessionRules(false);
      }, []);
      const title = rule?.hasRule === true
        ? `Правило: ${rule.presetLabel || 'своё'}`
        : 'Правил пока нет';
      return h('div', { style: { minWidth: 0 } }, [
        h('div', { key: 'separator', className: 'dshs-menu-separator', role: 'separator' }),
        h(
          'button',
          {
            key: 'item',
            type: 'button',
            role: 'menuitem',
            className: 'dshs-menu-item',
            title,
            'data-rule': rule?.hasRule === true ? 'true' : 'false',
            onClick: () => {
              // Меню закрывается, модалку рисует SessionRulesDialogHost.
              setMenuOpen(false);
              openRulesDialog(sessionId);
            },
          },
          [
            h('span', { key: 'icon', className: 'dshs-rules-menu-icon' }, h(ShieldIcon, { size: 14, protectedByRule: rule?.protect === true })),
            h('span', { key: 'label' }, 'Правила сессии…'),
            rule?.hasRule === true
              ? h('span', { key: 'badge', style: { ...S.meta, marginLeft: 'auto' } }, rule.presetLabel || 'правило')
              : null,
          ],
        ),
      ]);
    }

    /**
     * Оба пункта меню сессии одним компонентом: слот — список, отдельная
     * регистрация увеличила бы их число и сломала дымовой тест.
     */
    function SessionMenuItems(props) {
      return h('div', { className: 'dshs-session-menu', style: { display: 'contents' } }, [
        h(SessionSyncMenuItem, { key: 'mode', ...props }),
        h(SessionRulesMenuItem, { key: 'rules', ...props }),
      ]);
    }

    /** Секция панели: список сессий, режимы, фильтр и массовое переключение. */
    function SessionModesSection() {
      const data = useSessionStates();
      // M6: правила сессий — щит, лимит и бейджи прямо в строках списка.
      const rulesReport = useSessionRules();
      const sessions = data?.sessions ?? [];
      const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
      const [filter, setFilter] = React.useState('all');
      const [selected, setSelected] = React.useState(() => new Set());
      const [busy, setBusy] = React.useState('');
      const [workspaceBusy, setWorkspaceBusy] = React.useState('');
      const [cloudConfirm, setCloudConfirm] = React.useState('');
      const [note, setNote] = React.useState('');
      // Миграция «локальная навсегда»: убрать оставшиеся облачные копии
      // локальных сессий (счётчик приходит из /sessions.localOnly.migration).
      const [migrationConfirm, setMigrationConfirm] = React.useState(false);
      // Группы: субагенты свёрнуты под родителем, раскрытие — по клику на «+N».
      // В наборе — id родителей, чьи дети показаны.
      const [expanded, setExpanded] = React.useState(() => new Set());
      // Поиск по названию/id и «Показать ещё»: список длинный, показываем по 50.
      const [query, setQuery] = React.useState('');
      const [visibleLimit, setVisibleLimit] = React.useState(50);
      const toggleExpanded = (id) => {
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };
      const localOnlyInfo = data?.localOnly ?? {};
      const migrationCount = Number(localOnlyInfo?.migration?.count ?? 0);
      const declaredCount = Number(localOnlyInfo?.count ?? 0);

      const normalizedQuery = query.trim().toLowerCase();
      const visible = sessions.filter((session) => {
        if (filter === 'cloud') return session.mode !== 'local';
        if (filter === 'local') return session.mode === 'local';
        if (filter === 'attention') return session.mode !== 'local' && session.badge !== 'synced';
        return true;
      }).filter((session) => {
        if (normalizedQuery === '') return true;
        const title = String(session.title ?? '').toLowerCase();
        const id = String(session.id ?? '').toLowerCase();
        return title.includes(normalizedQuery) || id.includes(normalizedQuery);
      });
      // Строки с вложенностью: субагенты идут под родителем, сирота — верхним
      // уровнем (родителя нет в списке этого устройства).
      const rows = sessionGroupRows(visible, expanded);
      // «Показать ещё»: в DOM держим не больше 50 строк, остальные — по кнопке.
      const shownRows = rows.slice(0, visibleLimit);
      const groupSummary = sessionGroupSummary(sessions, data?.groups);
      // M6: правило по каждой сессии + след последнего запуска (что удержано).
      const ruleRows = Array.isArray(rulesReport?.sessions) ? rulesReport.sessions : [];
      const ruleById = new Map(ruleRows.map((row) => [String(row?.id ?? ''), row]));
      const foreignChangedIds = rulesIdsOf(rulesReport, 'foreignChangeIds');
      const ownerBlockedIds = rulesIdsOf(rulesReport, 'ownerBlockedIds');
      // Сессии, переросшие maxMb: с autoLocal правило уже перевело их само —
      // такие не спрашиваем, остальные показываем баннером с кнопкой.
      const overLimitRows = ruleRows.filter((row) => row?.overLimit === true);
      const overLimitAsk = overLimitRows.filter((row) => row?.autoLocal !== true);
      const overLimitAuto = overLimitRows.filter((row) => row?.autoLocal === true);

      const toggleSelected = (id) => {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      const selectVisible = () => {
        setSelected((current) => {
          const next = new Set(current);
          const allSelected = visible.length > 0 && visible.every((session) => next.has(session.id));
          for (const session of visible) {
            if (allSelected) next.delete(session.id);
            else next.add(session.id);
          }
          return next;
        });
      };

      const applyMode = async (mode, ids) => {
        if (ids.length === 0) return;
        setBusy(mode);
        setNote('');
        try {
          const result = await post(SESSION_MODE_PATH, { ids, mode });
          await refreshSessionStates(true);
          setSelected(new Set());
          setNote(`Режим изменён: ${result?.changed ?? ids.length}. ${mode === 'local' ? 'Сессии останутся только на этом устройстве.' : 'Сессии снова синхронизируются.'}`);
        } catch (error) {
          setNote(`Не удалось переключить режим: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      // Умолчание режима на уровне рабочего пространства: новые сессии этого
      // пространства получат его, уже существующие остаются как есть.
      const setWorkspaceDefault = async (workspaceId, mode) => {
        setWorkspaceBusy(`ws:${workspaceId}`);
        setNote('');
        try {
          const result = await post(SESSION_MODE_PATH, { workspaceId, mode });
          await refreshSessionStates(true);
          const pinned = Number(result?.pinned ?? 0);
          setNote(`Умолчание пространства: ${mode === 'local' ? 'локальная' : 'облачная'} — для новых сессий${pinned > 0 ? `; у существующих закреплён прежний режим: ${pinned}` : ''}.`);
        } catch (error) {
          setNote(`Не удалось сохранить умолчание: ${explain(error)}`);
        } finally {
          setWorkspaceBusy('');
        }
      };

      // «Удалить копию из облака»: только зеркальная копия локальной сессии,
      // локальный лог остаётся. Подтверждение — второй клик (сначала спросить).
      const removeCloudCopy = async (sessionId) => {
        setBusy(`copy:${sessionId}`);
        setNote('');
        try {
          const result = await post(SESSION_CLOUD_COPY_PATH, { id: sessionId, confirm: true });
          if (result?.ok === true) {
            setNote(`Облачная копия удалена (карантин 30 дней), локальная сессия осталась.${result.warning ? ` ${result.warning}` : ''}`);
            setCloudConfirm('');
          } else {
            setNote(result?.message ?? 'Не удалось удалить облачную копию.');
          }
          await refreshSessionStates(true);
        } catch (error) {
          setNote(`Не удалось удалить копию: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      // Миграция «локальная навсегда»: убрать оставшиеся облачные копии
      // локальных сессий. Подтверждение — второй клик, как и у прочих удалений.
      const runMigration = async () => {
        setBusy('migration');
        setNote('');
        try {
          const result = await post(LOCAL_ONLY_MIGRATION_PATH, { confirm: true });
          if (result?.ok === true) {
            setNote(`Облачных копий локальных сессий убрано: ${result.removed ?? 0}. Сессии остались локальными.${result.warning ? ` ${result.warning}` : ''}`);
            setMigrationConfirm(false);
          } else {
            setNote(result?.message ?? 'Не удалось убрать облачные копии.');
          }
          await refreshSessionStates(true);
        } catch (error) {
          setNote(`Не удалось убрать облачные копии: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      const counts = sessions.reduce(
        (total, session) => {
          total.all += 1;
          if (session.mode === 'local') total.local += 1;
          else total.cloud += 1;
          return total;
        },
        { all: 0, local: 0, cloud: 0 },
      );
      const attention = sessions.filter((session) => session.mode !== 'local' && session.badge !== 'synced').length;
      const selectedIds = [...selected];

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
        // Поиск по списку: название или id; сброс возвращает полный список.
        h(
          'div',
          { className: 'dshs-sessions-search' },
          h('input', {
            type: 'search',
            value: query,
            placeholder: 'Поиск по названию или id',
            'aria-label': 'Поиск по названию или id',
            style: { ...S.input, height: 32 },
            onChange: (event) => {
              setQuery(event.target.value);
              setVisibleLimit(50);
            },
          }),
          normalizedQuery !== ''
            ? h(
                'button',
                {
                  type: 'button',
                  style: S.buttonSmall,
                  onClick: () => {
                    setQuery('');
                    setVisibleLimit(50);
                  },
                },
                'Сбросить',
              )
            : null,
          h('span', { style: S.meta }, normalizedQuery === '' ? `всего: ${rows.length}` : `найдено: ${rows.length}`),
        ),
        h(
          'div',
          { style: { ...S.cardActions, gap: 6 } },
          [
            ['all', `Все (${counts.all})`],
            ['cloud', `Облачные (${counts.cloud})`],
            ['local', `Локальные (${counts.local})`],
            ['attention', `Требуют внимания (${attention})`],
          ].map(([key, label]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                className: 'dshs-modes-chip',
                'data-active': filter === key ? 'true' : 'false',
                style: {
                  ...S.buttonSmall,
                  ...(filter === key
                    ? {
                        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dcc) 16%, transparent)',
                        borderColor: 'var(--dsw-alias-brand-primary, #4a7dcc)',
                      }
                    : {}),
                },
                onClick: () => {
                  setFilter(key);
                  setVisibleLimit(50);
                },
              },
              label,
            ),
          ),
        ),
        h(
          'div',
          { style: { ...S.cardActions, gap: 6 } },
          h('button', { type: 'button', style: S.buttonSmall, onClick: selectVisible, disabled: visible.length === 0 }, selected.size > 0 ? 'Снять выбор' : 'Выбрать видимые'),
          h(
            'button',
            {
              type: 'button',
              style: S.buttonSmall,
              disabled: busy !== '' || selectedIds.length === 0,
              onClick: () => void applyMode('cloud', selectedIds),
            },
            `Сделать облачными (${selectedIds.length})`,
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.buttonSmall,
              disabled: busy !== '' || selectedIds.length === 0,
              onClick: () => void applyMode('local', selectedIds),
            },
            `Сделать локальными (${selectedIds.length})`,
          ),
          data?.attachAvailable === false
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  style: S.buttonSmall,
                  disabled: busy !== '' || (data?.unattached ?? 0) === 0,
                  onClick: async () => {
                    setBusy('attach');
                    try {
                      const result = await post(PROFILE_PATH, { action: 'attach' });
                      await refreshSessionStates(true);
                      setNote(`Привязано к рабочим пространствам: ${(result?.attached ?? 0) + (result?.queued ?? 0)}.`);
                    } catch (error) {
                      setNote(`Не удалось привязать: ${explain(error)}`);
                    } finally {
                      setBusy('');
                    }
                  },
                },
                `Привязать непривязанные (${data?.unattached ?? 0})`,
              ),
        ),
        // «Убрать облачные копии локальных сессий»: миграция «локальная
        // навсегда». Кнопка активна, когда в зеркале ещё лежат копии локальных
        // сессий; подтверждение — второй клик в этом же блоке.
        h(
          'div',
          { className: 'dshs-cloud-copy' },
          h('span', { style: S.label }, 'Локальные навсегда'),
          h('span', { style: S.hint }, declaredCount > 0
            ? `Объявлено локальными навсегда: ${declaredCount}. Объявление записано в зеркало и переживает перезапуск, pull и reset.`
            : 'Сессия, переключённая в локальную, остаётся только на этом устройстве — навсегда, пока её не вернут в облако.'),
          h(
            'div',
            { className: 'dshs-cloud-copy-actions' },
            migrationConfirm
              ? [
                  h('button', {
                    key: 'confirm',
                    type: 'button',
                    style: S.danger,
                    disabled: busy !== '',
                    onClick: () => void runMigration(),
                  }, `Да, убрать копии (${migrationCount})`),
                  h('button', {
                    key: 'cancel',
                    type: 'button',
                    style: S.buttonSmall,
                    disabled: busy !== '',
                    onClick: () => setMigrationConfirm(false),
                  }, 'Отмена'),
                ]
              : h('button', {
                  key: 'ask',
                  type: 'button',
                  style: S.buttonSmall,
                  disabled: busy !== '' || migrationCount === 0,
                  onClick: () => setMigrationConfirm(true),
                }, `Убрать облачные копии локальных сессий (${migrationCount})`),
            h('span', { style: S.meta }, migrationCount > 0
              ? 'эти сессии уже локальные, но копия в облаке ещё есть: уберём её в карантин 30 дней'
              : 'копий локальных сессий в облаке нет'),
          ),
        ),
        workspaces.length > 0
          ? h(
              'div',
              { className: 'dshs-ws-defaults' },
              h('span', { style: S.label }, 'Режим по умолчанию для рабочих пространств'),
              h('span', { style: S.hint }, 'Действует для новых сессий; уже переключённые сессии не меняются.'),
              workspaces.map((workspace) =>
                h(
                  'div',
                  { key: workspace.id, className: 'dshs-ws-default-row' },
                  h(
                    'span',
                    { style: S.meta, title: workspace.path ?? '' },
                    `${workspace.title || workspace.path || workspace.id} · сессий: ${workspace.sessions ?? 0}`,
                  ),
                  h(
                    'select',
                    {
                      value: workspace.defaultMode === 'local' ? 'local' : 'cloud',
                      disabled: busy !== '' || workspaceBusy !== '',
                      'aria-label': `Режим по умолчанию для ${workspace.title || workspace.path || workspace.id}`,
                      onChange: (event) => void setWorkspaceDefault(workspace.id, event.target.value),
                      style: { ...S.input, width: 'auto', height: 32, flex: '0 0 auto' },
                    },
                    h('option', { value: 'cloud' }, 'Облачная'),
                    h('option', { value: 'local' }, 'Локальная'),
                  ),
                ),
              ),
            )
          : null,
        note !== '' ? h('span', { style: S.note }, note) : null,
        // M6: «Сессия выросла до X МБ — перевести в локальные?». Баннер только
        // там, где правило не включает autoLocal (иначе всё уже сделано само).
        overLimitAsk.length > 0
          ? h(
              'div',
              { className: 'dshs-rules-grow', role: 'status' },
              h(
                'span',
                { className: 'dshs-rules-grow-text' },
                `Сессия выросла до ${formatMbValue(overLimitAsk[0]?.mb)} МБ — перевести в локальные?`
                  + (overLimitAsk.length > 1 ? ` (и ещё ${overLimitAsk.length - 1})` : '')
                  + ` Лимит правила — ${formatMbValue(overLimitAsk[0]?.maxMb ?? overLimitAsk[0]?.limitMb)} МБ.`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.buttonSmall,
                  disabled: busy !== '',
                  'data-action': 'rule-make-local',
                  onClick: () => void applyMode('local', overLimitAsk.map((row) => row.id)),
                },
                'Перевести в локальные',
              ),
            )
          : null,
        overLimitAuto.length > 0
          ? h(
              'span',
              { style: S.hint },
              `Правило autoLocal: переведено в локальные автоматически — ${overLimitAuto.length}. Лимит: ${formatMbValue(overLimitAuto[0]?.maxMb ?? overLimitAuto[0]?.limitMb)} МБ.`,
            )
          : null,
        rows.length === 0
          ? h('span', { style: S.hint }, sessions.length === 0 ? 'Сессии появятся здесь после первого запуска синхронизации или настройки проекта.' : (normalizedQuery !== '' ? 'По запросу ничего не найдено.' : 'Под фильтр ничего не попало.'))
          : h(
              'div',
              { className: 'dshs-modes-list' },
              shownRows.map((row) => {
                const session = row.session;
                const badge = badgeOf(session.badge);
                const label = sessionLabel(session);
                const isLocal = session.mode === 'local';
                const childrenCount = Number(session.childrenCount ?? row.children.length ?? 0) || 0;
                const missingCount = Number(session.childrenMissingCount ?? 0) || 0;
                const groupSize = Number(session.groupSize ?? 1) || 1;
                // M6: правило этой сессии (щит, лимит, владелец, чужое изменение).
                const rule = ruleById.get(String(session.id));
                return h(
                  'div',
                  {
                    key: session.id,
                    className: 'dshs-modes-row',
                    title: `${label.shortId}${groupSize > 1 ? ` · группа: ${groupSize}` : ''}${session.orphan === true ? ' · сирота: родитель не найден на этом устройстве' : ''}`,
                    'data-subagent': row.depth > 0 ? 'true' : undefined,
                    'data-depth': String(row.depth),
                    'data-orphan': session.orphan === true ? 'true' : undefined,
                  },
                  // «+N»: субагенты свёрнуты под родителем, клик раскрывает.
                  row.isParent
                    ? h(
                        'button',
                        {
                          key: 'group',
                          type: 'button',
                          className: 'dshs-group-toggle',
                          'data-open': row.expanded ? 'true' : 'false',
                          'aria-expanded': row.expanded ? 'true' : 'false',
                          title: row.expanded
                            ? `Свернуть субагентов: ${childrenCount}`
                            : `Развернуть субагентов: ${childrenCount}`,
                          onClick: (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleExpanded(session.id);
                          },
                        },
                        `+${childrenCount}`,
                      )
                    : null,
                  h('input', {
                    type: 'checkbox',
                    checked: selected.has(session.id),
                    onChange: () => toggleSelected(session.id),
                    style: { margin: 0, flex: '0 0 auto', accentColor: 'var(--dsw-alias-brand-primary, #4a7dcc)' },
                  }),
                  // Индикатор по макету: облако/монитор, полоса и подсказка.
                  h(SessionSyncIndicator, { key: 'ind', sessionId: session.id, session }),
                  h(
                    'span',
                    { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: '1 1 auto' } },
                    h('span', { style: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label.id),
                    h(
                      'span',
                      { style: { ...S.meta, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      `${badge.title}${label.folder === '' ? '' : ` · ${label.folder}`}${missingCount > 0 ? ` · в облаке ещё ${missingCount}` : ''}`,
                    ),
                    // Локальная сессия, у которой в облаке осталась копия:
                    // подсказка и отдельное действие с подтверждением.
                    isLocal && session.cloudCopy === true
                      ? h(
                          'div',
                          { key: 'cloud-copy', className: 'dshs-cloud-copy' },
                          h(
                            'span',
                            { style: S.meta },
                            `В облаке есть копия${session.cloudCopyBytes ? ` (${formatBytesShort(session.cloudCopyBytes)})` : ''}, локально отключена — сессия остаётся здесь.`,
                          ),
                          cloudConfirm === session.id
                            ? h(
                                'div',
                                { className: 'dshs-cloud-copy-actions' },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    style: S.buttonSmall,
                                    disabled: busy !== '',
                                    onClick: (event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void removeCloudCopy(session.id);
                                    },
                                  },
                                  'Да, удалить копию',
                                ),
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    style: S.buttonSmall,
                                    onClick: (event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      setCloudConfirm('');
                                    },
                                  },
                                  'Отмена',
                                ),
                              )
                            : h(
                                'div',
                                { className: 'dshs-cloud-copy-actions' },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    style: S.buttonSmall,
                                    disabled: busy !== '',
                                    onClick: (event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      setCloudConfirm(session.id);
                                    },
                                  },
                                  'Удалить копию из облака',
                                ),
                              ),
                        )
                      : null,
                  ),
                  // «сирота»: субагент без родителя на этом устройстве.
                  session.orphan === true
                    ? h(
                        'span',
                        {
                          key: 'orphan',
                          className: 'dshs-orphan-badge',
                          title: 'Родитель этой сессии не найден на этом устройстве: субагент показывается отдельно и защищён от удаления',
                        },
                        'сирота',
                      )
                    : null,
                  // M6: щит у сессий с правилом и бейдж превышения лимита.
                  rule?.hasRule === true
                    ? h(
                        'span',
                        {
                          key: 'rule-shield',
                          className: 'dshs-rules-shield',
                          'data-protected': rule.protect === true ? 'true' : 'false',
                          title: rule.protect === true
                            ? `Защищена правилом${rule.presetLabel ? `: ${rule.presetLabel}` : ''}${rule.ruleSource === 'parent' ? ` (от ${rule.inheritedFrom})` : ''}`
                            : `Правило сессии${rule.presetLabel ? `: ${rule.presetLabel}` : ''}`,
                          'aria-label': rule.protect === true ? 'защищена правилом' : 'есть правило',
                        },
                        h(ShieldIcon, { size: 15, protectedByRule: rule.protect === true }),
                      )
                    : null,
                  rule?.overLimit === true
                    ? h(
                        'span',
                        { key: 'rule-limit', className: 'dshs-rules-badge', 'data-tone': 'limit', title: rule.message ?? '' },
                        `лимит: ${formatMbValue(rule.mb)}/${formatMbValue(rule.maxMb ?? rule.limitMb)} МБ`,
                      )
                    : null,
                  rule?.ownerBlocked === true || ownerBlockedIds.has(String(session.id))
                    ? h(
                        'span',
                        {
                          key: 'rule-owner',
                          className: 'dshs-rules-badge',
                          'data-tone': 'owner',
                          title: rule?.ownerDevice ? `Сессия принадлежит ${rule.ownerDevice}: отправляет только владелец` : 'правило: только владелец',
                        },
                        'правило: только владелец',
                      )
                    : null,
                  foreignChangedIds.has(String(session.id))
                    ? h(
                        'span',
                        {
                          key: 'rule-foreign',
                          className: 'dshs-rules-badge',
                          'data-tone': 'warn',
                          title: 'Лог в зеркале изменён другим устройством: изменение не применено молча',
                        },
                        'изменено не владельцем',
                      )
                    : null,
                  h(
                    'span',
                    {
                      style: {
                        ...S.badge,
                        flex: '0 0 auto',
                        background: isLocal ? 'rgba(128,128,128,0.16)' : 'rgba(70,130,220,0.16)',
                      },
                    },
                    isLocal ? 'локальная' : 'облачная',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.buttonSmall,
                      disabled: busy !== '',
                      onClick: (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void applyMode(isLocal ? 'cloud' : 'local', [session.id]);
                      },
                    },
                    isLocal ? 'В облако' : 'Локально',
                  ),
                );
              }),
            ),
        // «Показать ещё»: остальные строки списка, чтобы DOM не разрастался.
        rows.length > shownRows.length
          ? h(
              'div',
              { className: 'dshs-sessions-more' },
              h(
                'button',
                {
                  type: 'button',
                  style: S.buttonSmall,
                  onClick: () => setVisibleLimit((value) => value + 50),
                },
                `Показать ещё ${Math.min(50, rows.length - shownRows.length)}`,
              ),
              h('span', { style: S.meta }, `показано ${shownRows.length} из ${rows.length}`),
            )
          : null,
        // Подсказка под списком: сколько всего групп и как раскрыть субагентов.
        rows.length === 0
          ? null
          : h('span', { style: S.hint }, groupSummary.subagents > 0
              ? `${groupSummary.line}. Субагенты свёрнуты под родителем — нажмите «+N», чтобы раскрыть.`
              : 'Сессий с субагентами нет: группы появятся, когда субагент запустится из диалога.'),
      );
    }

    /**
     * Секция «Удалённые»: список надгробий зеркала с причиной, автором и сроком
     * карантина, кнопки «Восстановить» и «Восстановить всё».
     */
    function DeletedSection(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key;
      const data = useTombstones();
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState('');
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];

      const restore = async (ids, all) => {
        if (!all && (ids === undefined || ids.length === 0)) return;
        setBusy(all === true ? 'all' : String(ids[0] ?? ''));
        setNote('');
        try {
          const result = await post(RESTORE_PATH, all === true ? { all: true } : { ids });
          if (result?.ok === true) {
            const restored = Array.isArray(result.restoredIds) ? result.restoredIds.length : 0;
            const failed = Array.isArray(result.failed) ? result.failed.length : 0;
            // Восстановление группы: host вернул всю семью вместе с детьми.
            const groupChildren = Number(result.restoredGroup?.children ?? 0) || 0;
            const groupNote = groupChildren > 0 ? ` Вся группа: вместе с субагентами (${groupChildren}).` : '';
            setNote(`${t('deletedRestored')} ${restored}${failed > 0 ? `, не удалось: ${failed}` : ''}.${groupNote} ${result.warning ?? ''}`.trim());
          } else {
            setNote(result?.message ?? 'Не удалось восстановить сессии');
          }
          await refreshTombstones(true);
          await refreshSessionStates(true);
        } catch (error) {
          setNote(`Не удалось восстановить: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      const restoreOne = (entry) => {
        if (entry?.canRestore === false) {
          setNote(entry.expired === true
            ? 'Срок карантина истёк — сессию восстановить нельзя.'
            : 'Карантинная копия не найдена — восстанавливать нечего.');
          return;
        }
        void restore([entry.id], false);
      };

      const reasonLabel = (reason) => DELETED_REASON_LABELS[reason] ?? 'удалено';
      const byLabel = (by) => DELETED_BY_LABELS[by] ?? 'неизвестно';
      const canRestoreAny = sessions.some((entry) => entry.canRestore !== false);

      if (data === null) {
        return h('span', { style: S.hint }, t('deletedLoading'));
      }
      if (sessions.length === 0) {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
          h('span', { style: S.hint }, t('deletedEmpty')),
          h(
            'div',
            { style: S.cardActions },
            h('button', { type: 'button', style: S.buttonSmall, disabled: busy !== '', onClick: () => void refreshTombstones(true) }, t('deletedRefresh')),
          ),
        );
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
        h(
          'div',
          { className: 'dshs-deleted-list' },
          sessions.map((entry) => {
            const label = sessionLabel({ id: entry.id, title: entry.title, shortId: entry.shortId });
            const at = entry.at ? new Date(entry.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'дата неизвестна';
            // Группа удалённых: у родителя — сколько субагентов ушло с ним, у
            // ребёнка — к какому родителю он относится. Восстановление группы
            // одной кнопкой возвращает всю семью (host расширяет id до группы).
            const childrenCount = Number(entry.childrenCount ?? 0) || 0;
            const groupSize = Number(entry.groupSize ?? 1) || 1;
            const isGroupMember = childrenCount > 0 || String(entry.parentSession ?? '') !== '' || groupSize > 1;
            const meta = [
              `удалено ${at}`,
              byLabel(entry.by),
              reasonLabel(entry.reason),
              entry.expired === true
                ? quarantineLabel(entry)
                : entry.quarantined === false
                  ? 'копии в карантине нет'
                  : quarantineLabel(entry),
              childrenCount > 0
                ? `вместе с ${childrenCount} ${childrenCount === 1 ? 'субагентом' : 'субагентами'}`
                : '',
            ].filter(Boolean).join(' · ');
            return h(
              'div',
              {
                key: entry.id,
                className: 'dshs-deleted-row',
                title: `${label.shortId}${groupSize > 1 ? ` · группа: ${groupSize}` : ''}`,
                'data-group': isGroupMember ? 'true' : undefined,
              },
              h('span', {
                style: {
                  ...S.dot,
                  background: entry.expired === true
                    ? 'rgba(128,128,128,0.7)'
                    : 'var(--dsw-alias-state-warn-primary, #e8590c)',
                },
              }),
              h(
                'span',
                { className: 'dshs-deleted-text' },
                h('span', { style: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label.id),
                h('span', { style: { ...S.meta, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, meta),
              ),
              h(
                'span',
                { style: { ...S.badge, flex: '0 0 auto', background: 'rgba(128,128,128,0.14)' } },
                reasonLabel(entry.reason),
              ),
              entry.orphan === true
                ? h('span', { key: 'orphan', className: 'dshs-orphan-badge', title: 'Родитель этой удалённой сессии не найден в карантине' }, 'сирота')
                : childrenCount > 0
                  ? h('span', { key: 'group', className: 'dshs-group-badge', title: 'Вместе с родителем удалены субагенты' }, `+${childrenCount}`)
                  : null,
              h(
                'button',
                {
                  type: 'button',
                  style: S.buttonSmall,
                  disabled: busy !== '' || entry.canRestore === false,
                  title: entry.expired === true
                    ? 'Срок карантина истёк'
                    : isGroupMember
                      ? 'Вернуть в зеркало всю группу: родителя и субагентов'
                      : 'Вернуть сессию в зеркало',
                  onClick: () => restoreOne(entry),
                },
                isGroupMember ? `Восстановить группу${groupSize > 1 ? ` (${groupSize})` : ''}` : t('deletedRestore'),
              ),
            );
          }),
        ),
        h(
          'div',
          { style: S.cardActions },
          h(
            'button',
            {
              type: 'button',
              className: 'dshs-btn-primary',
              style: S.primary,
              disabled: busy !== '' || !canRestoreAny,
              onClick: () => void restore(undefined, true),
            },
            busy === 'all' ? 'Восстанавливаем…' : `${t('deletedRestoreAll')} (${sessions.filter((entry) => entry.canRestore !== false).length})`,
          ),
          h('button', { type: 'button', style: S.buttonSmall, disabled: busy !== '', onClick: () => void refreshTombstones(true) }, t('deletedRefresh')),
        ),
        note !== '' ? h('span', { style: S.note }, note) : null,
        h('span', { style: S.hint }, 'Если сессия вернулась в зеркало, другие устройства получат её при следующем приёме. После восстановления перезапустите DSH, чтобы сессия появилась в списке.'),
      );
    }

    /** Момент времени для подписи: 2026-11-23 22:30. */
    const formatMoment = (value) => {
      const text = typeof value === 'string' ? value : '';
      if (text === '') return '—';
      return text.replace('T', ' ').replace('Z', '').slice(0, 16);
    };

    /** Секция панели: план приёма, применение, журнал и рабочие пространства. */
    function ProfileLayerSection() {
      const [state, setState] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [busy, setBusy] = React.useState('');

      const load = async () => {
        try {
          const result = await post(PROFILE_PATH, { action: 'status' });
          setState(result);
        } catch (error) {
          setNote(`Статус профиля не получен: ${explain(error)}`);
        }
      };

      React.useEffect(() => {
        void load();
      }, []);

      const attachWorkspace = async (hint) => {
        setBusy('attach');
        setNote('');
        try {
          const result = await post(PROFILE_PATH, {
            action: 'attach-workspace',
            projectId: hint.projectId ?? '',
            path: hint.path,
            sessionIds: hint.sessionIds ?? [],
          });
          await load();
          await refreshSessionStates(true);
          setNote(`Привязано сессий: ${result?.attached ?? 0}.`);
        } catch (error) {
          setNote(`Не удалось привязать: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      const applyPlan = async () => {
        setBusy('apply');
        setNote('');
        try {
          const result = await post(PROFILE_APPLY_PATH, { action: 'apply' });
          await load();
          if (result?.ok === true) {
            const skipped = (result.skipped ?? []).length;
            setNote(`Применено файлов: ${result.applied ?? 0}${(result.conflicts ?? 0) > 0 ? `, конфликтов: ${result.conflicts}` : ''}${skipped > 0 ? `; пропущено: ${skipped}` : ''}. Резервная копия каждого файла лежит рядом с ним (суффикс .before-sync-).`);
          } else {
            setNote(result?.message || 'Применение не удалось.');
          }
        } catch (error) {
          setNote(`Не удалось применить план: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      const refreshPlan = async () => {
        setBusy('plan');
        setNote('');
        try {
          const result = await post(PROFILE_APPLY_PATH, { action: 'plan' });
          await load();
          setNote(result?.pending === true
            ? `План обновлён: файлов к применению ${result.plan?.files ?? 0}.`
            : 'Применять нечего: профиль совпадает с зеркалом.');
        } catch (error) {
          setNote(`Не удалось обновить план: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      const discardPlan = async () => {
        setBusy('discard');
        setNote('');
        try {
          await post(PROFILE_APPLY_PATH, { action: 'discard' });
          await load();
          setNote('План отменён: локальные файлы не менялись.');
        } catch (error) {
          setNote(`Не удалось отменить план: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      const toggleAutoApply = async (enabled) => {
        setBusy('auto');
        setNote('');
        try {
          const result = await post(PROFILE_PATH, { action: 'auto-apply', enabled });
          await load();
          setNote(result?.autoApply === true
            ? 'Авто-применение включено: план применится сам, только если конфликтов нет.'
            : 'Авто-применение выключено: план применяется кнопкой «Применить».');
        } catch (error) {
          setNote(`Не удалось изменить режим: ${explain(error)}`);
        } finally {
          setBusy('');
        }
      };

      const profile = state?.profile ?? null;
      const workspace = state?.workspace ?? null;
      const journal = state?.journal ?? [];
      const plan = profile?.plan ?? null;
      const lastApply = profile?.lastApply ?? null;
      const canApply = busy === '' && plan?.present === true && (plan.files ?? 0) > 0;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
        profile === null
          ? h('span', { style: S.hint }, 'Загрузка состояния профиля…')
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
              h(
                'div',
                { style: S.row },
                h('span', {
                  style: { ...S.dot, background: profile.available ? 'var(--dsw-alias-state-success-primary, #2f9e44)' : 'rgba(128,128,128,0.6)' },
                }),
                h('span', { style: { fontWeight: 600 } }, profile.available ? 'Профиль найден' : 'Профиль не найден'),
                h('span', { style: S.meta }, profile.profileDir || 'каталог профиля не определён'),
              ),
              profile.available
                ? h(
                    'span',
                    { style: S.meta },
                    `Патч: ${(profile.patch?.entries ?? []).join(', ') || 'без безопасных записей'} · включено плагинов: ${profile.bundles?.count ?? 0} · настроек плагинов: ${(profile.settings ?? []).length}`,
                  )
                : null,
              profile.available
                ? h(
                    'span',
                    { style: S.meta },
                    `История расходов: ${profile.extras?.expenses ?? 0} записей · задачи автоматизации: ${profile.extras?.schedule ?? 0} · «Входящие»: настроек ${profile.extras?.inbox ?? 0}`,
                  )
                : null,
              profile.mirror?.present
                ? h(
                    'span',
                    { style: S.meta },
                    `В зеркале: тема/язык/MCP — ${(profile.mirror.patchEntries ?? []).join(', ') || 'нет'} · плагинов ${profile.mirror.bundles ?? 0} · настроек ${(profile.mirror.settings ?? []).length} · расходов ${profile.mirror.expenses ?? 0} · задач ${profile.mirror.schedule ?? 0}`,
                  )
                : h('span', { style: S.hint }, 'В зеркале профильного слоя пока нет: он появится после первой отправки с этого устройства или другого.'),
              profile.mirror?.manifest?.present
                ? h(
                    'span',
                    { style: S.meta },
                    `Манифест зеркала: ${formatMoment(profile.mirror.manifest.updatedAt)} · устройство ${profile.mirror.manifest.device || '—'} · файлов ${profile.mirror.manifest.files ?? 0}`,
                  )
                : null,
              (profile.patch?.warnings ?? []).length > 0
                ? h('span', { style: S.note }, `Предупреждения: ${profile.patch.warnings.join('; ')}`)
                : null,
              (profile.conflictCount ?? 0) > 0
                ? h('span', { style: S.note }, `Конфликтов в журнале: ${profile.conflictCount}. Локальные настройки при конфликте не затираются.`)
                : null,
              h('span', { style: S.hint }, 'Переносятся только тема/язык/шрифт/MCP, настройки плагинов по белому списку, история расходов, задачи автоматизации и настройки «Входящих». Секреты, deviceId/offset/queue и машинные пути не уезжают.'),
              // --- план приёма: сначала показываем, потом применяем ------------
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, marginTop: 4 } },
                h('span', { style: { ...S.row, fontWeight: 600 } }, 'План применения'),
                plan?.present === true
                  ? h(
                      'span',
                      { style: S.meta },
                      `Источник: ${plan.source?.device || 'неизвестное устройство'} · зеркало обновлено ${formatMoment(plan.source?.updatedAt)} · к применению: ${plan.files ?? 0} файлов, конфликтов: ${plan.conflictCount ?? 0}`,
                    )
                  : h(
                      'span',
                      { style: S.hint },
                      profile.autoApply === true
                        ? 'Авто-применение включено: при приёме план применится сам, если конфликтов нет.'
                        : 'Плана нет. При приёме с другого устройства здесь появится список файлов: сначала показываем, потом применяем.',
                    ),
                plan?.present === true
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
                      ...(plan.entries ?? []).slice(-8).map((entry, index) =>
                        h(
                          'span',
                          { key: index, style: S.meta },
                          `${entry.file} — ${entry.action === 'apply' ? 'применить' : entry.action === 'conflict' ? 'конфликт, локальная копия сохранена' : 'без изменений'}${entry.bytes !== undefined ? ` · ${entry.bytes} Б` : ''}`,
                        ),
                      ),
                    )
                  : null,
                (plan?.conflicts ?? []).length > 0
                  ? h(
                      'span',
                      { style: S.note },
                      `Конфликты: ${(plan.conflicts ?? []).map((item) => `${item.file} — ${item.reason}`).join('; ')}`,
                    )
                  : null,
                plan?.present === true
                  ? h(
                      'div',
                      { style: S.cardActions },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshs-btn-primary',
                          style: S.primary,
                          disabled: !canApply,
                          onClick: () => void applyPlan(),
                        },
                        busy === 'apply' ? 'Применяем…' : 'Применить',
                      ),
                      h('button', { type: 'button', style: S.buttonSmall, disabled: busy !== '', onClick: () => void refreshPlan() }, 'Обновить план'),
                      h('button', { type: 'button', style: S.buttonSmall, disabled: busy !== '', onClick: () => void discardPlan() }, 'Отменить план'),
                    )
                  : null,
                h(
                  'label',
                  { style: { ...S.row, cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: profile.autoApply === true,
                    disabled: busy !== '',
                    onChange: (event) => void toggleAutoApply(event.target.checked),
                  }),
                  h('span', { style: S.hint }, 'Применять автоматически, если конфликтов нет (по умолчанию — вручную)'),
                ),
                lastApply?.present
                  ? h(
                      'span',
                      { style: S.meta },
                      `Последнее применение: ${formatMoment(lastApply.at)} (${lastApply.mode === 'auto' ? 'авто' : 'вручную'}) · файлов ${lastApply.applied ?? 0} · конфликтов ${lastApply.conflicts ?? 0}`,
                    )
                  : null,
              ),
            ),
        workspace !== null
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
              h('span', { style: { ...S.row, fontWeight: 600 } }, 'Рабочие пространства'),
              h(
                'span',
                { style: S.meta },
                `В зеркале: ${workspace.mirrorWorkspaces ?? 0} · здесь: ${workspace.localWorkspaces ?? 0} · совпало: ${workspace.matched ?? 0} · к привязке: ${workspace.toAttach ?? 0}`,
              ),
              (workspace.hints ?? []).map((hint, index) =>
                h(
                  'div',
                  { key: `${hint.title}-${index}`, className: 'dshs-ws-hint' },
                  h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, hint.title || 'Без названия'),
                  h('span', { style: S.meta }, `${hint.path} · сессий: ${(hint.sessionIds ?? []).length}`),
                  h(
                    'span',
                    { style: S.hint },
                    hint.projectId !== ''
                      ? `Рабочее пространство с другого устройства: сессии привяжутся к локальному пути проекта «${hint.projectId}».`
                      : 'Рабочее пространство с другого устройства, а проект не настроен в плагине: укажите путь в «Подключении» или откройте эту папку в DSH.',
                  ),
                  h(
                    'div',
                    { style: S.cardActions },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.buttonSmall,
                        disabled: busy !== '' || (hint.sessionIds ?? []).length === 0,
                        onClick: () => void attachWorkspace(hint),
                      },
                      'Привязать',
                    ),
                  ),
                ),
              ),
              (workspace.hints ?? []).length === 0
                ? h('span', { style: S.hint }, 'Все рабочие пространства из зеркала нашлись на этом устройстве.')
                : null,
            )
          : null,
        journal.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
              h('span', { style: { ...S.row, fontWeight: 600 } }, 'Журнал конфликтов'),
              journal.slice(-5).map((entry, index) =>
                h(
                  'span',
                  { key: index, style: S.meta },
                  `${entry.file}: ${entry.reason} — ${entry.resolution}`,
                ),
              ),
            )
          : null,
        h(
          'div',
          { style: S.cardActions },
          h('button', { type: 'button', style: S.buttonSmall, disabled: busy !== '', onClick: () => void load() }, 'Обновить состояние'),
        ),
        note !== '' ? h('span', { style: S.note }, note) : null,
      );
    }

    /**
     * Мост браузерных настроек: localStorage не виден host-части, поэтому
     * панель отдаёт значения dsh-polish/dsh-cards наверх и забирает очередь
     * после приёма профильного слоя с другого устройства.
     */
    const BROWSER_SETTING_KEYS = {
      'dsh-polish': {
        enabled: ['dsh-polish:enabled', (value) => (value === true ? '1' : '0')],
        panelVisibility: ['dsh-polish:panel-visibility', (value) => JSON.stringify(value)],
      },
      'dsh-cards': {
        panelVisibility: ['dsh-polish:panel-visibility', (value) => JSON.stringify(value)],
      },
    };

    function readBrowserSettingsSnapshot() {
      const result = {};
      for (const [plugin, keys] of Object.entries(BROWSER_SETTING_KEYS)) {
        const values = {};
        for (const [field, [storageKey, encode]] of Object.entries(keys)) {
          try {
            const raw = localStorage.getItem(storageKey);
            if (raw === null || raw === undefined) continue;
            if (field === 'panelVisibility') {
              const parsed = JSON.parse(raw);
              if (parsed !== null && typeof parsed === 'object') values[field] = parsed;
            } else {
              values[field] = encode === undefined ? raw : raw === '1' || raw === 'true';
            }
          } catch {
            // значение не читается — пропускаем
          }
        }
        if (Object.keys(values).length > 0) result[plugin] = values;
      }
      return result;
    }

    function applyBrowserSettings(settings) {
      for (const [plugin, fields] of Object.entries(settings ?? {})) {
        const keys = BROWSER_SETTING_KEYS[plugin];
        if (keys === undefined) continue;
        for (const [field, value] of Object.entries(fields ?? {})) {
          const entry = keys[field];
          if (entry === undefined) continue;
          try {
            localStorage.setItem(entry[0], entry[1](value));
          } catch {
            // хранилище недоступно — настройка применится в следующий раз
          }
        }
      }
      try {
        window.dispatchEvent(new CustomEvent('dsh-polish:panels-changed'));
      } catch {
        // событие — необязательное
      }
    }

    function BrowserSettingsBridge() {
      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const current = readBrowserSettingsSnapshot();
            const result = await post(BROWSER_SETTINGS_PATH, { current });
            const pending = result?.pending?.settings ?? {};
            if (alive && pending !== null && typeof pending === 'object' && Object.keys(pending).length > 0) {
              applyBrowserSettings(pending);
              await post(BROWSER_SETTINGS_PATH, { applied: true });
            }
          } catch {
            // браузерные настройки — вспомогательная часть профиля
          }
        })();
        return () => {
          alive = false;
        };
      }, []);
      return null;
    }


    // ---- встроенный плагин удаления сессий -----------------------------------
    // Код взят из отдельного плагина и работает в своей области видимости:
    // сбой в синхронизации не мешает удалению и наоборот.
    const deleteClient = (function (require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'sessionDelete'
    /** Host routes registered by index.js. */
    const INSPECT_PATH = '/api/session-delete/inspect'
    const DELETE_PATH = '/api/session-delete/delete'
    /** Word the user must type before the last button enables. */
    const CONFIRM_WORD = 'delete'
    /** Private class prefix; never collides with host class names. */
    const P = 'dshsd'

    const en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Delete session?',
      'dialog.question': 'Are you sure you want to delete this session?',
      'dialog.detail': 'The conversation history, its projection cache and its workspace entry are removed. Project files on disk are kept unless you choose to delete them in the next step.',
      'dialog.checking': 'Checking linked sessions and files…',
      'dialog.confirmTitle': 'Confirm deletion',
      'dialog.confirmDetail': 'Session "{title}" will be deleted permanently. This action cannot be undone.',
      'dialog.confirmDetailUntitled': 'This session will be deleted permanently. This action cannot be undone.',
      'dialog.typeWord': 'Type {word} in the field below, then press Yes.',
      'dialog.placeholder': 'delete',
      'dialog.deleting': 'Deleting…',
      'dialog.yes': 'Yes',
      'dialog.no': 'No',
      'dialog.close': 'Close',
      'related.title': 'Session is linked to other sessions',
      'related.desc': 'Linked sessions: {count}. Descendant sessions are deleted with this one.',
      'related.note': 'Review the linked sessions before continuing.',
      'related.children': 'Subagent sessions deleted together with this one: {count}. They can be restored from Deleted.',
      'related.show': 'Show the list ({count})',
      'related.parent': 'parent session',
      'related.child': 'child session',
      'related.running': 'running',
      'related.untitled': 'Untitled session',
      'files.checkbox': 'Also delete the files this session created ({count})',
      'files.show': 'Show the paths ({count})',
      'files.risk': 'Those project files will be removed from disk. This cannot be undone.',
      'session.liveNote': 'This session is open right now. It will be closed as part of the deletion.',
      'session.runningNote': 'This session is generating a reply. It will be stopped and closed as part of the deletion.',
      'error.active': 'The session could not be closed. Try again.',
      'error.notFound': 'This session no longer exists.',
      'error.invalid': 'The request was rejected.',
      'error.network': 'The request failed. Nothing was deleted.',
      'error.generic': 'Operation failed: {message}',
      'dialog.scopeTitle': 'Where to delete',
      'dialog.scopeEverywhere': 'Delete on every device — the session disappears from the shared repository too.',
      'dialog.scopeLocal': 'Only on this device — the session comes back on the next sync.',
      'dialog.warning': 'Deletion is permanent and, by default, propagates to the other devices through synchronization.',
}

    const ru = {
      'menu.delete': 'Удалить сессию',
      'dialog.title': 'Удалить сессию?',
      'dialog.question': 'Вы точно хотите удалить данную сессию?',
      'dialog.detail': 'История переписки, кэш проекций и запись в списке workspace будут удалены. Файлы проекта на диске останутся, если не отметить их удаление на следующем шаге.',
      'dialog.checking': 'Проверка связанных сессий и файлов…',
      'dialog.confirmTitle': 'Подтверждение удаления',
      'dialog.confirmDetail': 'Сессия «{title}» будет удалена безвозвратно. Это действие нельзя отменить.',
      'dialog.confirmDetailUntitled': 'Сессия будет удалена безвозвратно. Это действие нельзя отменить.',
      'dialog.typeWord': 'Введите слово {word} в поле ниже и нажмите «Да».',
      'dialog.placeholder': 'delete',
      'dialog.deleting': 'Удаление…',
      'dialog.yes': 'Да',
      'dialog.no': 'Нет',
      'dialog.close': 'Закрыть',
      'related.title': 'Сессия связана с другими',
      'related.desc': 'Связанных сессий: {count}. Дочерние сессии будут удалены вместе с этой.',
      'related.note': 'Проверьте список связанных сессий, прежде чем продолжать.',
      'related.children': 'Вместе с этой сессией будут удалены субагенты: {count}. Вернуть их можно в карточке «Удалённые».',
      'related.show': 'Показать список ({count})',
      'related.parent': 'родительская сессия',
      'related.child': 'дочерняя сессия',
      'related.running': 'активна',
      'related.untitled': 'Сессия без названия',
      'files.checkbox': 'Также удалить файлы, созданные этой сессией ({count})',
      'files.show': 'Показать пути ({count})',
      'files.risk': 'Эти файлы проекта будут удалены с диска. Восстановить их нельзя.',
      'session.liveNote': 'Сессия открыта прямо сейчас. При удалении она будет закрыта.',
      'session.runningNote': 'Сессия сейчас генерирует ответ. При удалении она будет остановлена и закрыта.',
      'error.active': 'Не удалось закрыть сессию. Попробуйте ещё раз.',
      'error.notFound': 'Сессии уже не существует.',
      'error.invalid': 'Запрос отклонён.',
      'error.network': 'Не удалось выполнить запрос. Ничего не удалено.',
      'error.generic': 'Не удалось выполнить: {message}',
      'dialog.scopeTitle': 'Где удалять',
      'dialog.scopeEverywhere': 'На всех устройствах — сессия исчезнет и из общего репозитория.',
      'dialog.scopeLocal': 'Только на этом устройстве — при следующей синхронизации сессия вернётся.',
      'dialog.warning': 'Удаление необратимо и по умолчанию распространяется на другие устройства через синхронизацию.',
}

    const de = {
      'menu.delete': 'Sitzung löschen',
      'dialog.title': 'Sitzung löschen?',
      'dialog.question': 'Möchten Sie diese Sitzung wirklich löschen?',
      'dialog.detail': 'Verlauf, Projektions-Cache und Workspace-Eintrag werden entfernt. Projektdateien auf der Festplatte bleiben erhalten, sofern Sie im nächsten Schritt nicht deren Löschung wählen.',
      'dialog.checking': 'Verknüpfte Sitzungen und Dateien werden geprüft…',
      'dialog.confirmTitle': 'Löschen bestätigen',
      'dialog.confirmDetail': 'Sitzung „{title}“ wird endgültig gelöscht. Dies kann nicht rückgängig gemacht werden.',
      'dialog.confirmDetailUntitled': 'Diese Sitzung wird endgültig gelöscht. Dies kann nicht rückgängig gemacht werden.',
      'dialog.typeWord': 'Geben Sie {word} im Feld unten ein und drücken Sie dann Ja.',
      'dialog.placeholder': 'delete',
      'dialog.deleting': 'Wird gelöscht…',
      'dialog.yes': 'Ja',
      'dialog.no': 'Nein',
      'dialog.close': 'Schließen',
      'related.title': 'Sitzung ist mit anderen Sitzungen verknüpft',
      'related.desc': 'Verknüpfte Sitzungen: {count}. Untergeordnete Sitzungen werden mit dieser gelöscht.',
      'related.note': 'Prüfen Sie die verknüpften Sitzungen, bevor Sie fortfahren.',
      'related.children': 'Untergeordnete Sitzungen werden mit dieser gelöscht: {count}. Sie lassen sich unter „Gelöscht“ wiederherstellen.',
      'related.show': 'Liste anzeigen ({count})',
      'related.parent': 'übergeordnete Sitzung',
      'related.child': 'untergeordnete Sitzung',
      'related.running': 'aktiv',
      'related.untitled': 'Unbenannte Sitzung',
      'files.checkbox': 'Auch die von dieser Sitzung erstellten Dateien löschen ({count})',
      'files.show': 'Pfade anzeigen ({count})',
      'files.risk': 'Diese Projektdateien werden von der Festplatte entfernt. Das ist nicht rückgängig zu machen.',
      'session.liveNote': 'Diese Sitzung ist gerade geöffnet. Sie wird beim Löschen geschlossen.',
      'session.runningNote': 'Diese Sitzung erzeugt gerade eine Antwort. Sie wird beim Löschen beendet und geschlossen.',
      'error.active': 'Die Sitzung konnte nicht geschlossen werden. Versuchen Sie es erneut.',
      'error.notFound': 'Diese Sitzung existiert nicht mehr.',
      'error.invalid': 'Die Anfrage wurde abgelehnt.',
      'error.network': 'Die Anfrage ist fehlgeschlagen. Es wurde nichts gelöscht.',
      'error.generic': 'Vorgang fehlgeschlagen: {message}',
    }

    const es = {
      'menu.delete': 'Eliminar sesión',
      'dialog.title': '¿Eliminar sesión?',
      'dialog.question': '¿Seguro que quiere eliminar esta sesión?',
      'dialog.detail': 'Se eliminarán el historial, la caché de proyecciones y la entrada del espacio de trabajo. Los archivos del proyecto en disco se conservan salvo que elija eliminarlos en el siguiente paso.',
      'dialog.checking': 'Comprobando sesiones vinculadas y archivos…',
      'dialog.confirmTitle': 'Confirmar eliminación',
      'dialog.confirmDetail': 'La sesión «{title}» se eliminará de forma permanente. Esta acción no se puede deshacer.',
      'dialog.confirmDetailUntitled': 'Esta sesión se eliminará de forma permanente. Esta acción no se puede deshacer.',
      'dialog.typeWord': 'Escriba {word} en el campo y pulse Sí.',
      'dialog.placeholder': 'delete',
      'dialog.deleting': 'Eliminando…',
      'dialog.yes': 'Sí',
      'dialog.no': 'No',
      'dialog.close': 'Cerrar',
      'related.title': 'La sesión está vinculada a otras sesiones',
      'related.desc': 'Sesiones vinculadas: {count}. Las sesiones descendientes se eliminarán con esta.',
      'related.note': 'Revise las sesiones vinculadas antes de continuar.',
      'related.children': 'Las sesiones secundarias se eliminarán junto con esta: {count}. Puede restaurarlas en «Eliminadas».',
      'related.show': 'Mostrar la lista ({count})',
      'related.parent': 'sesión principal',
      'related.child': 'sesión secundaria',
      'related.running': 'activa',
      'related.untitled': 'Sesión sin título',
      'files.checkbox': 'Eliminar también los archivos creados por esta sesión ({count})',
      'files.show': 'Mostrar las rutas ({count})',
      'files.risk': 'Estos archivos del proyecto se eliminarán del disco. No se pueden recuperar.',
      'session.liveNote': 'Esta sesión está abierta ahora mismo. Se cerrará al eliminarla.',
      'session.runningNote': 'Esta sesión está generando una respuesta. Se detendrá y se cerrará al eliminarla.',
      'error.active': 'No se pudo cerrar la sesión. Inténtelo de nuevo.',
      'error.notFound': 'Esta sesión ya no existe.',
      'error.invalid': 'La solicitud fue rechazada.',
      'error.network': 'La solicitud falló. No se eliminó nada.',
      'error.generic': 'La operación falló: {message}',
    }

    const fr = {
      'menu.delete': 'Supprimer la session',
      'dialog.title': 'Supprimer la session ?',
      'dialog.question': 'Voulez-vous vraiment supprimer cette session ?',
      'dialog.detail': 'L’historique, le cache de projections et l’entrée d’espace de travail seront supprimés. Les fichiers du projet sur le disque sont conservés, sauf si vous choisissez de les supprimer à l’étape suivante.',
      'dialog.checking': 'Vérification des sessions liées et des fichiers…',
      'dialog.confirmTitle': 'Confirmer la suppression',
      'dialog.confirmDetail': 'La session « {title} » sera définitivement supprimée. Cette action est irréversible.',
      'dialog.confirmDetailUntitled': 'Cette session sera définitivement supprimée. Cette action est irréversible.',
      'dialog.typeWord': 'Saisissez {word} dans le champ ci-dessous, puis appuyez sur Oui.',
      'dialog.placeholder': 'delete',
      'dialog.deleting': 'Suppression…',
      'dialog.yes': 'Oui',
      'dialog.no': 'Non',
      'dialog.close': 'Fermer',
      'related.title': 'La session est liée à d’autres sessions',
      'related.desc': 'Sessions liées : {count}. Les sessions descendantes seront supprimées avec celle-ci.',
      'related.note': 'Vérifiez les sessions liées avant de continuer.',
      'related.children': 'Les sessions enfants seront supprimées avec celle-ci : {count}. Elles sont récupérables dans « Supprimées ».',
      'related.show': 'Afficher la liste ({count})',
      'related.parent': 'session parente',
      'related.child': 'session enfant',
      'related.running': 'en cours',
      'related.untitled': 'Session sans titre',
      'files.checkbox': 'Supprimer aussi les fichiers créés par cette session ({count})',
      'files.show': 'Afficher les chemins ({count})',
      'files.risk': 'Ces fichiers du projet seront supprimés du disque. C’est irréversible.',
      'session.liveNote': 'Cette session est actuellement ouverte. Elle sera fermée lors de la suppression.',
      'session.runningNote': 'Cette session génère une réponse. Elle sera arrêtée et fermée lors de la suppression.',
      'error.active': 'Impossible de fermer la session. Réessayez.',
      'error.notFound': 'Cette session n’existe plus.',
      'error.invalid': 'La requête a été refusée.',
      'error.network': 'La requête a échoué. Rien n’a été supprimé.',
      'error.generic': 'Échec de l’opération : {message}',
    }

    const ja = {
      'menu.delete': 'セッションを削除',
      'dialog.title': 'セッションを削除しますか？',
      'dialog.question': 'このセッションを本当に削除しますか？',
      'dialog.detail': '会話履歴、プロジェクションキャッシュ、ワークスペースの登録を削除します。次の手順で選択しない限り、ディスク上のプロジェクトファイルは残ります。',
      'dialog.checking': '関連するセッションとファイルを確認しています…',
      'dialog.confirmTitle': '削除の確認',
      'dialog.confirmDetail': 'セッション「{title}」は完全に削除されます。この操作は元に戻せません。',
      'dialog.confirmDetailUntitled': 'このセッションは完全に削除されます。この操作は元に戻せません。',
      'dialog.typeWord': '下の欄に {word} と入力してから「はい」を押してください。',
      'dialog.placeholder': 'delete',
      'dialog.deleting': '削除しています…',
      'dialog.yes': 'はい',
      'dialog.no': 'いいえ',
      'dialog.close': '閉じる',
      'related.title': 'セッションは他のセッションと関連しています',
      'related.desc': '関連するセッション: {count}。子セッションも一緒に削除されます。',
      'related.note': '続行する前に関連するセッションを確認してください。',
      'related.children': 'このセッションと一緒に子セッションが削除されます: {count}。「削除済み」から復元できます。',
      'related.show': '一覧を表示 ({count})',
      'related.parent': '親セッション',
      'related.child': '子セッション',
      'related.running': '実行中',
      'related.untitled': '無題のセッション',
      'files.checkbox': 'このセッションが作成したファイルも削除する ({count})',
      'files.show': 'パスを表示 ({count})',
      'files.risk': 'これらのプロジェクトファイルはディスクから削除されます。元に戻せません。',
      'session.liveNote': 'このセッションは現在開かれています。削除時に閉じられます。',
      'session.runningNote': 'このセッションは応答を生成中です。削除時に停止して閉じます。',
      'error.active': 'セッションを閉じられませんでした。もう一度お試しください。',
      'error.notFound': 'このセッションはもう存在しません。',
      'error.invalid': 'リクエストは拒否されました。',
      'error.network': 'リクエストに失敗しました。何も削除されていません。',
      'error.generic': '操作に失敗しました: {message}',
    }

    const pt = {
      'menu.delete': 'Excluir sessão',
      'dialog.title': 'Excluir sessão?',
      'dialog.question': 'Tem certeza de que deseja excluir esta sessão?',
      'dialog.detail': 'O histórico, o cache de projeções e o registro no workspace serão removidos. Os arquivos do projeto no disco são mantidos, a menos que você escolha excluí-los na próxima etapa.',
      'dialog.checking': 'Verificando sessões vinculadas e arquivos…',
      'dialog.confirmTitle': 'Confirmar exclusão',
      'dialog.confirmDetail': 'A sessão «{title}» será excluída permanentemente. Esta ação não pode ser desfeita.',
      'dialog.confirmDetailUntitled': 'Esta sessão será excluída permanentemente. Esta ação não pode ser desfeita.',
      'dialog.typeWord': 'Digite {word} no campo abaixo e pressione Sim.',
      'dialog.placeholder': 'delete',
      'dialog.deleting': 'Excluindo…',
      'dialog.yes': 'Sim',
      'dialog.no': 'Não',
      'dialog.close': 'Fechar',
      'related.title': 'A sessão está vinculada a outras sessões',
      'related.desc': 'Sessões vinculadas: {count}. As sessões descendentes serão excluídas junto com esta.',
      'related.note': 'Revise as sessões vinculadas antes de continuar.',
      'related.children': 'As sessões filhas serão excluídas junto com esta: {count}. É possível restaurá-las em «Excluídas».',
      'related.show': 'Mostrar a lista ({count})',
      'related.parent': 'sessão pai',
      'related.child': 'sessão filha',
      'related.running': 'em execução',
      'related.untitled': 'Sessão sem título',
      'files.checkbox': 'Excluir também os arquivos criados por esta sessão ({count})',
      'files.show': 'Mostrar os caminhos ({count})',
      'files.risk': 'Esses arquivos do projeto serão removidos do disco. Não é possível desfazer.',
      'session.liveNote': 'Esta sessão está aberta agora. Ela será fechada ao ser excluída.',
      'session.runningNote': 'Esta sessão está gerando uma resposta. Ela será interrompida e fechada ao ser excluída.',
      'error.active': 'Não foi possível fechar a sessão. Tente novamente.',
      'error.notFound': 'Esta sessão não existe mais.',
      'error.invalid': 'A solicitação foi recusada.',
      'error.network': 'A solicitação falhou. Nada foi excluído.',
      'error.generic': 'Falha na operação: {message}',
    }

    const zh = {
      'menu.delete': '删除会话',
      'dialog.title': '删除会话？',
      'dialog.question': '您确定要删除此会话吗？',
      'dialog.detail': '将删除对话历史、投影缓存和工作区记录。除非在下一步选择，磁盘上的项目文件会保留。',
      'dialog.checking': '正在检查关联会话和文件…',
      'dialog.confirmTitle': '确认删除',
      'dialog.confirmDetail': '会话“{title}”将被永久删除。此操作无法撤销。',
      'dialog.confirmDetailUntitled': '此会话将被永久删除。此操作无法撤销。',
      'dialog.typeWord': '在下方输入 {word}，然后点击“是”。',
      'dialog.placeholder': 'delete',
      'dialog.deleting': '正在删除…',
      'dialog.yes': '是',
      'dialog.no': '否',
      'dialog.close': '关闭',
      'related.title': '会话与其他会话相关联',
      'related.desc': '关联会话：{count}。子会话也将随之删除。',
      'related.note': '继续前请检查关联会话。',
      'related.children': '将随此会话一起删除子会话: {count}。可在「已删除」中恢复。',
      'related.show': '显示列表（{count}）',
      'related.parent': '父会话',
      'related.child': '子会话',
      'related.running': '运行中',
      'related.untitled': '未命名会话',
      'files.checkbox': '同时删除此会话创建的文件（{count}）',
      'files.show': '显示路径（{count}）',
      'files.risk': '这些项目文件将从磁盘删除，无法恢复。',
      'session.liveNote': '此会话当前已打开，删除时会被关闭。',
      'session.runningNote': '此会话正在生成回复，删除时会被停止并关闭。',
      'error.active': '无法关闭会话。请重试。',
      'error.notFound': '此会话已不存在。',
      'error.invalid': '请求被拒绝。',
      'error.network': '请求失败，未删除任何内容。',
      'error.generic': '操作失败：{message}',
    }

    const dictionaries = { en, ru, de, es, fr, ja, pt, zh }

    const CSS = `
.${P}-item-wrap{position:relative}
.${P}-separator{height:.5px;margin:3px 8px;background:var(--dsw-alias-border-l2,#e3e3e6)}
.${P}-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#16181d);text-align:left}
.${P}-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));outline:none}
.${P}-item-danger,.${P}-item-danger .${P}-item-icon{color:var(--dsw-alias-state-error-primary,#d92d20)}
.${P}-item-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon,currentColor)}
.${P}-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(hover:hover){
.${P}-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.${P}-item-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(217,45,32,.08))}
}
.${P}-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.${P}-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur,blur(2px))}
.${P}-mask:after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));animation:${P}-enter var(--ds-transition-duration,150ms) var(--ds-ease-in-out,ease)}
.${P}-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(460px,100%);max-height:calc(100dvh - 48px);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.24));color:var(--dsw-alias-label-primary,#16181d);font:inherit;animation:${P}-enter var(--ds-transition-duration,150ms) var(--ds-ease-in-out,ease)}
.${P}-dialog:focus{outline:none}
.${P}-content{display:flex;flex-direction:column;width:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.${P}-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.${P}-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary,#16181d)}
.${P}-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid transparent;border-radius:10px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#5a6070)}
.${P}-close:disabled{opacity:.4;cursor:not-allowed}
.${P}-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary,#16181d)}
.${P}-body{display:flex;flex-direction:column;gap:12px;min-width:0;margin-top:20px;padding:0 24px}
.${P}-note{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#5a6070)}
.${P}-warning{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#5a6070)}
.${P}-warning p{margin:0}
.${P}-warning svg{margin-top:2px;color:var(--dsw-alias-state-error-primary,#d92d20)}
.${P}-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:0 24px}
.${P}-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l4,#c9ccd4);border-radius:10px;background:transparent;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap;color:var(--dsw-alias-label-primary,#16181d);min-width:0}
.${P}-button:disabled{cursor:not-allowed;opacity:.55}
.${P}-button-outline{background:transparent;border-color:var(--dsw-alias-border-l4,#c9ccd4)}
.${P}-button-primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#2a6df4) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2a6df4) 18%,transparent);color:var(--dsw-alias-brand-primary,#2a6df4)}
.${P}-button-delete:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 16%,transparent);color:var(--dsw-alias-state-error-primary,#d92d20)}
.${P}-field{box-sizing:border-box;width:100%;height:44px;padding:7px 14px;border:.5px solid var(--dsw-alias-border-l4,#c9ccd4);border-radius:var(--dsw-radius-lg,12px);background:transparent;outline:none;font:inherit;font-size:16px;line-height:22px;color:var(--dsw-alias-label-primary,#16181d)}
.${P}-field::placeholder{color:var(--dsw-alias-label-dimmed,#9aa0ae)}
.${P}-field:focus{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#2a6df4))}
.${P}-field:disabled{color:var(--dsw-alias-label-dimmed,#9aa0ae)}
.${P}-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5a6070)}
.${P}-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d92d20)}
.${P}-details{margin-top:2px}
.${P}-summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#5a6070);font-size:13px;line-height:20px}
.${P}-summary:hover{color:var(--dsw-alias-label-primary,#16181d)}
.${P}-list{display:flex;flex-direction:column;gap:4px;max-height:190px;overflow:auto;margin-top:8px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#f6f7f9);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5a6070)}
.${P}-row{display:flex;flex-direction:column;gap:1px;min-width:0}
.${P}-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#16181d);font-size:13px;line-height:18px}
.${P}-row-meta{color:var(--dsw-alias-label-tertiary,#7a8294);font-size:11px;line-height:16px}
.${P}-path{word-break:break-all}
.${P}-check{display:flex;align-items:flex-start;gap:10px;margin-top:2px;color:var(--dsw-alias-label-primary,#16181d);font-size:14px;line-height:22px;cursor:pointer}
.${P}-check input{flex:none;width:16px;height:16px;margin:3px 0 0;accent-color:var(--dsw-alias-button-primary-fill,#2a6df4);cursor:pointer}
.${P}-check input:disabled{cursor:default}
@media(hover:hover){
.${P}-button-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2a6df4) 28%,transparent)}
.${P}-button-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.${P}-button-delete:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 24%,transparent)}
.${P}-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
}
@keyframes ${P}-enter{0%{opacity:0}to{opacity:1}}
@media (max-width:640px){.${P}-footer{padding:0 16px}.${P}-button{flex:1 1 auto;justify-content:center}.${P}-dialog{border-radius:14px}}
@media(prefers-reduced-motion:reduce){
.${P}-mask:after,.${P}-dialog{animation:none}
}
`

    /* ---------------------------------------------------------------- state */

    let pluginCtx = null
    let translate = (key) => key
    // Итог регистрации секции страницы плагина: показываем в карточке списка.
    let detailState = 'не регистрировали'

    const initialState = {
      open: false,
      step: 'confirm',
      target: null,
      info: null,
      draft: '',
      busy: false,
      error: null,
      deleteFiles: false,
      localOnly: false,
      relatedOpen: false,
      filesOpen: false,
    }

    let state = { ...initialState }
    const listeners = new Set()

    function getState() {
      return state
    }

    function patch(next) {
      state = { ...state, ...next }
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[session-delete] state listener failed:', error)
        }
      }
    }

    function subscribeState(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function usePluginStateSync() {
      return React.useSyncExternalStore(subscribeState, getState, getState)
    }

    function usePluginStateLegacy() {
      const [value, setValue] = React.useState(getState)
      React.useEffect(() => {
        setValue(getState())
        return subscribeState(() => setValue(getState()))
      }, [])
      return value
    }

    const usePluginState = typeof React.useSyncExternalStore === 'function'
      ? usePluginStateSync
      : usePluginStateLegacy

    /* -------------------------------------------------------------- actions */

    function openDialog(target) {
      patch({ ...initialState, open: true, target })
    }

    function closeDialog() {
      if (state.busy) return
      patch({ ...initialState })
    }

    function describeFailure(payload, status) {
      const code = payload !== null && typeof payload === 'object' && typeof payload.code === 'string' ? payload.code : ''
      if (code === 'session/active') return translate('error.active')
      if (code === 'session/not-found') return translate('error.notFound')
      if (code === 'request/invalid') return translate('error.invalid')
      const message = payload !== null && typeof payload === 'object' && typeof payload.message === 'string' && payload.message !== ''
        ? payload.message
        : `HTTP ${String(status)}`
      return translate('error.generic', { message })
    }

    async function postJson(endpoint, body) {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      return { response, payload }
    }

    /** Step one: ask the Host what this deletion would touch. */
    async function startInspection() {
      const target = state.target
      if (target === null || state.busy) return
      patch({ busy: true, error: null })
      try {
        const { response, payload } = await postJson(INSPECT_PATH, { sessionId: target.sessionId })
        if (response.ok && payload !== null && payload.ok === true) {
          const related = Array.isArray(payload.related) ? payload.related : []
          patch({
            busy: false,
            info: payload,
            step: related.length > 0 ? 'related' : 'word',
            relatedOpen: false,
            filesOpen: false,
            deleteFiles: false,
            error: null,
          })
          return
        }
        patch({ busy: false, error: describeFailure(payload, response.status) })
      } catch (error) {
        console.error('[session-delete] inspect request failed:', error)
        patch({ busy: false, error: translate('error.network') })
      }
    }

    /** Last step: perform the confirmed deletion. */
    async function confirmDelete() {
      const target = state.target
      if (target === null || state.busy) return
      patch({ busy: true, error: null })
      try {
        const { response, payload } = await postJson(DELETE_PATH, {
          sessionId: target.sessionId,
          confirm: CONFIRM_WORD,
          deleteFiles: state.deleteFiles === true,
          // Область удаления: по умолчанию расходится на другие устройства.
          localOnly: state.localOnly === true,
        })
        if (response.ok && payload !== null && payload.ok === true) {
          patch({ ...initialState })
          refreshSessions()
          return
        }
        patch({ busy: false, error: describeFailure(payload, response.status) })
      } catch (error) {
        console.error('[session-delete] delete request failed:', error)
        patch({ busy: false, error: translate('error.network') })
      }
    }

    /** Ask the Session Controller to re-read its durable list after a removal. */
    function refreshSessions() {
      if (pluginCtx === null) return
      const sessions = pluginCtx.get('sessions')
      if (sessions === undefined || sessions === null || typeof sessions.refresh !== 'function') return
      try {
        const pending = sessions.refresh()
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') {
          pending.catch((error) => console.warn('[session-delete] session list refresh failed:', error))
        }
      } catch (error) {
        console.warn('[session-delete] session list refresh failed:', error)
      }
    }

    /* ---------------------------------------------------------- primitives */

    function TrashIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      },
      h('path', { key: 'lid', d: 'M4 7h16' }),
      h('path', { key: 'handle', d: 'M9.5 4h5' }),
      h('path', { key: 'body', d: 'M6.5 7l.9 12.1a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7' }),
      h('path', { key: 'ribs', d: 'M10 11v5.5M14 11v5.5' }))
    }

    function CloseIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      }, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
    }

    function WarningIcon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: 'none' },
      },
      h('path', { key: 'shape', d: 'M12 3.6l9 15.8H3z' }),
      h('path', { key: 'stem', d: 'M12 9.5v4.4' }),
      h('path', { key: 'dot', d: 'M12 16.8h.01' }))
    }

    /**
     * Host-style modal: mask, dialog, header with title and close, description,
     * body and footer. Escape and mask clicks close; focus enters the dialog and
     * returns to the previously focused element on close.
     */
    function Modal({ open, onClose, closeLabel, title, description, footer, children, busy }) {
      const dialogRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        const node = dialogRef.current
        const previous = document.activeElement
        const focusableSelector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'
        const focusTarget = node !== null
          ? node.querySelector('[data-modal-autofocus]') ?? node.querySelector(focusableSelector) ?? node
          : null
        if (focusTarget !== null && typeof focusTarget.focus === 'function') {
          focusTarget.focus({ preventScroll: true })
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== 'Tab' || node === null) return
          const items = [...node.querySelectorAll(focusableSelector)].filter((element) => !element.closest('[inert], [hidden]'))
          if (items.length === 0) {
            event.preventDefault()
            node.focus({ preventScroll: true })
            return
          }
          const first = items[0]
          const last = items[items.length - 1]
          const active = document.activeElement
          const leavingStart = event.shiftKey && (active === first || active === node)
          const leavingEnd = !event.shiftKey && active === last
          if (leavingStart || leavingEnd) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus({ preventScroll: true })
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous instanceof HTMLElement && previous.isConnected) {
            previous.focus({ preventScroll: true })
          }
        }
      }, [open])

      if (!open) return null
      return createPortal(h('div', { className: `${P}-root`, role: 'presentation' }, [
        h('div', {
          key: 'mask',
          className: `${P}-mask`,
          'aria-hidden': true,
          onClick: busy ? undefined : onClose,
        }),
        h('div', {
          key: 'dialog',
          ref: dialogRef,
          tabIndex: -1,
          className: `${P}-dialog`,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
        }, [
          h('div', { key: 'content', className: `${P}-content` }, [
            h('div', { key: 'header', className: `${P}-header` }, [
              h('h2', { key: 'title', className: `${P}-title` }, title),
              h('button', {
                key: 'close',
                type: 'button',
                className: `${P}-close`,
                'aria-label': closeLabel,
                disabled: busy === true,
                onClick: onClose,
              }, h(CloseIcon, { size: 14 })),
            ]),
            description !== undefined && description !== '' ? h('p', {
              key: 'description',
              className: `${P}-description`,
            }, description) : null,
            children !== undefined && children !== null ? h('div', {
              key: 'body',
              className: `${P}-body`,
            }, children) : null,
          ]),
          footer !== undefined && footer !== null ? h('div', {
            key: 'footer',
            className: `${P}-footer`,
          }, footer) : null,
        ]),
      ]), document.body)
    }

    function Button({ variant, danger, onClick, disabled, children }) {
      const classes = [`${P}-button`]
      if (variant === 'primary') classes.push(`${P}-button-primary`)
      else classes.push(`${P}-button-outline`)
      if (danger === true) classes.push(`${P}-button-delete`)
      return h('button', {
        type: 'button',
        className: classes.join(' '),
        disabled: disabled === true,
        onClick,
      }, children)
    }

    /** Expandable list of linked Sessions. */
    function RelatedList({ rows, open, onToggle, t }) {
      return h('details', {
        className: `${P}-details`,
        open,
        onToggle: (event) => onToggle(event.currentTarget.open),
      }, [
        h('summary', { key: 'summary', className: `${P}-summary` },
          t('related.show', { count: String(rows.length) })),
        h('div', { key: 'list', className: `${P}-list` }, rows.map((row) => h('div', {
          key: row.sessionId,
          className: `${P}-row`,
        }, [
          h('span', { key: 'title', className: `${P}-row-title` }, row.title === '' ? t('related.untitled') : row.title),
          h('span', { key: 'meta', className: `${P}-row-meta` }, [
            row.relation === 'parent' ? t('related.parent') : t('related.child'),
            row.running === true ? t('related.running') : null,
          ].filter(Boolean).join(' · ')),
        ]))),
      ])
    }

    /** Expandable list of project paths the Session named. */
    function FilesList({ files, open, onToggle, t }) {
      return h('details', {
        className: `${P}-details`,
        open,
        onToggle: (event) => onToggle(event.currentTarget.open),
      }, [
        h('summary', { key: 'summary', className: `${P}-summary` },
          t('files.show', { count: String(files.length) })),
        h('div', { key: 'list', className: `${P}-list` }, files.map((file) => h('div', {
          key: file.relative,
          className: `${P}-path`,
        }, file.relative))),
      ])
    }

    /* -------------------------------------------------------------- entries */

    function SessionDeleteMenuItem(props) {
      const sessionId = props.sessionId
      const displayTitle = props.displayTitle ?? ''
      const [, setMenuOpen] = props.useMenuOpenState()
      return h('div', { className: `${P}-item-wrap` }, [
        h('div', { key: 'separator', className: `${P}-separator`, role: 'separator' }),
        h('button', {
          key: 'item',
          type: 'button',
          role: 'menuitem',
          className: `${P}-item ${P}-item-danger`,
          onClick: () => {
            setMenuOpen(false)
            openDialog({ sessionId, displayTitle })
          },
        }, [
          h('span', { key: 'icon', className: `${P}-item-icon` }, h(TrashIcon, { size: 14 })),
          h('span', { key: 'label', className: `${P}-item-label` }, translate('menu.delete')),
        ]),
      ])
    }

    function SessionDeleteDialog() {
      const current = usePluginState()
      if (current.open !== true || current.target === null) return null

      const t = translate
      const target = current.target
      const info = current.info
      const related = info !== null && Array.isArray(info.related) ? info.related : []
      // Субагенты исчезнут вместе с родителем: их количество показываем в
      // подтверждении, чтобы удаление группы не было неожиданностью.
      const childrenCount = related.filter((row) => row?.relation === 'child').length
      const files = info !== null && Array.isArray(info.files) ? info.files : []
      const busy = current.busy === true
      const typed = current.draft.trim().toLowerCase() === CONFIRM_WORD
      const errorNode = current.error === null
        ? null
        : h('p', { key: 'error', className: `${P}-error`, role: 'alert' }, current.error)

      const close = () => {
        closeDialog()
      }

      let title
      let description
      let body
      let footer

      if (current.step === 'related') {
        title = t('related.title')
        description = t('related.desc', { count: String(related.length) })
        body = [
          h('p', { key: 'note', className: `${P}-note` }, t('related.note')),
          childrenCount > 0
            ? h('p', { key: 'children', className: `${P}-error` }, t('related.children', { count: String(childrenCount) }))
            : null,
          h(RelatedList, {
            key: 'related',
            rows: related,
            open: current.relatedOpen === true,
            onToggle: (open) => patch({ relatedOpen: open }),
            t,
          }),
          errorNode,
        ]
        footer = [
          h(Button, { key: 'no', variant: 'outline', disabled: busy, onClick: close }, t('dialog.no')),
          h(Button, {
            key: 'yes',
            variant: 'primary',
            disabled: busy,
            onClick: () => patch({ step: 'word', error: null }),
          }, t('dialog.yes')),
        ]
      } else if (current.step === 'word') {
        const sessionTitle = info !== null && info.session !== undefined && typeof info.session.title === 'string'
          ? info.session.title
          : ''
        const shownTitle = sessionTitle !== '' ? sessionTitle : (target.displayTitle ?? '')
        title = t('dialog.confirmTitle')
        description = shownTitle === '' ? t('dialog.confirmDetailUntitled') : t('dialog.confirmDetail', { title: shownTitle })
        body = [
          h('div', { key: 'warning', className: `${P}-warning` }, [
            h(WarningIcon, { key: 'icon', size: 18 }),
            h('p', { key: 'prompt' }, t('dialog.typeWord', { word: CONFIRM_WORD })),
          ]),
          // «Вместе с N субагентами»: у родителя в подтверждении видно, что
          // удаляется вся группа, а не одна сессия.
          childrenCount > 0
            ? h('p', { key: 'children', className: `${P}-error`, 'data-children': String(childrenCount) }, t('related.children', { count: String(childrenCount) }))
            : null,
          h('input', {
            key: 'field',
            type: 'text',
            className: `${P}-field`,
            value: current.draft,
            placeholder: t('dialog.placeholder'),
            autoComplete: 'off',
            autoCapitalize: 'off',
            autoCorrect: 'off',
            spellCheck: false,
            autoFocus: true,
            'data-modal-autofocus': true,
            disabled: busy,
            onChange: (event) => patch({ draft: event.target.value, error: null }),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              if (current.draft.trim().toLowerCase() === CONFIRM_WORD && !busy) {
                void confirmDelete()
              }
            },
          }),
          info !== null && info.live === true
            ? h('p', { key: 'live', className: `${P}-note` }, info.running === true
              ? t('session.runningNote')
              : t('session.liveNote'))
            : null,
          h('div', { key: 'scope', className: `${P}-scope` }, [
            h('p', { key: 'title', className: `${P}-status` }, t('dialog.scopeTitle')),
            h('label', { key: 'everywhere', className: `${P}-check` }, [
              h('input', {
                key: 'radio',
                type: 'radio',
                name: 'dshsd-scope',
                checked: current.localOnly !== true,
                disabled: busy,
                onChange: () => patch({ localOnly: false }),
              }),
              h('span', { key: 'text' }, t('dialog.scopeEverywhere')),
            ]),
            h('label', { key: 'local', className: `${P}-check` }, [
              h('input', {
                key: 'radio',
                type: 'radio',
                name: 'dshsd-scope',
                checked: current.localOnly === true,
                disabled: busy,
                onChange: () => patch({ localOnly: true }),
              }),
              h('span', { key: 'text' }, t('dialog.scopeLocal')),
            ]),
            h('p', { key: 'warning', className: `${P}-error` }, t('dialog.warning')),
          ]),
          files.length > 0 ? h('label', { key: 'check', className: `${P}-check` }, [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: current.deleteFiles === true,
              disabled: busy,
              onChange: (event) => patch({ deleteFiles: event.target.checked }),
            }),
            h('span', { key: 'text' }, t('files.checkbox', { count: String(files.length) })),
          ]) : null,
          files.length > 0 ? h(FilesList, {
            key: 'files',
            files,
            open: current.filesOpen === true,
            onToggle: (open) => patch({ filesOpen: open }),
            t,
          }) : null,
          files.length > 0 && current.deleteFiles === true
            ? h('p', { key: 'risk', className: `${P}-error` }, t('files.risk'))
            : null,
          busy ? h('p', { key: 'status', className: `${P}-status`, role: 'status' }, t('dialog.deleting')) : null,
          errorNode,
        ]
        footer = [
          h(Button, { key: 'no', variant: 'outline', disabled: busy, onClick: close }, t('dialog.no')),
          h(Button, {
            key: 'yes',
            variant: 'outline',
            danger: true,
            disabled: busy || !typed,
            onClick: () => {
              void confirmDelete()
            },
          }, t('dialog.yes')),
        ]
      } else {
        title = t('dialog.title')
        description = t('dialog.question')
        body = [
          h('p', { key: 'note', className: `${P}-note` }, t('dialog.detail')),
          busy ? h('p', { key: 'status', className: `${P}-status`, role: 'status' }, t('dialog.checking')) : null,
          errorNode,
        ]
        footer = [
          h(Button, { key: 'no', variant: 'outline', disabled: busy, onClick: close }, t('dialog.no')),
          h(Button, {
            key: 'yes',
            variant: 'primary',
            disabled: busy,
            onClick: () => {
              void startInspection()
            },
          }, t('dialog.yes')),
        ]
      }

      return h(Modal, {
        open: true,
        onClose: close,
        closeLabel: t('dialog.close'),
        title,
        description,
        footer,
        busy,
      }, body)
    }

    /* ---------------------------------------------------------------- apply */

    function apply(ctx) {
      pluginCtx = ctx
      translate = ctx.locale.bind(NS)

      for (const [locale, dictionary] of Object.entries(dictionaries)) {
        ctx.effect(() => ctx.locale.register(NS, locale, dictionary), `session-delete: ${locale} dictionary`)
      }

      /* Re-render open surfaces with the new language; `translate` reads it live. */
      ctx.effect(() => ctx.locale.subscribe(() => patch({})), 'session-delete: locale changes')

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-session-delete'
        tag.dataset.pluginCss = 'dsh-session-delete/client.css'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'session-delete: styles')

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-delete.delete',
        order: 500,
      }, SessionDeleteMenuItem))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-delete.dialog',
        order: 1000,
      }, SessionDeleteDialog))
    }

      return {
        inject: ['slots', 'locale'],
        apply,
        // Крючок для headless-тестов диалога удаления: состояние и подсчёт
        // группы. На живое поведение не влияет.
        __test: {
          getState,
          setState: (next) => patch(next ?? {}),
          resetState: () => patch({ ...initialState }),
          relatedChildren: (related) => (Array.isArray(related) ? related.filter((row) => row?.relation === 'child').length : 0),
          relatedSummary: (related) => {
            const rows = Array.isArray(related) ? related : [];
            return {
              total: rows.length,
              children: rows.filter((row) => row?.relation === 'child').length,
              parents: rows.filter((row) => row?.relation === 'parent').length,
            };
          },
        },
      };
    })(require);

    exports.apply = (ctx) => {
      apply(ctx);
      try {
        deleteClient.apply(ctx);
      } catch (error) {
        console.error('[dsh-sessions] удаление сессий недоступно:', error);
      }
    };
    exports.inject = ['slots', 'locale'];
    exports.NS = NS;
    // Внутренний крючок для headless-тестов (`npm test`): позволяет отрисовать
    // список сессий с данными без настоящего React и сети. На поведение
    // интерфейса не влияет и ничего не регистрирует в DSH.
    exports.__test = {
      setSessionStates: (value) => {
        sessionStates.data = value ?? null;
        sessionStates.at = Date.now();
        for (const listener of sessionStates.listeners) listener();
      },
      readSessionStates: () => sessionStates.data,
      // Состояние host-части для тестов панели: в живом интерфейсе его
      // приносит опрос STATE_PATH (раз в 30 секунд).
      setHostState: (value) => {
        snapshot = { ...snapshot, loading: false, data: value ?? null, error: '' };
        for (const listener of listeners) listener();
      },
      readHostState: () => snapshot.data,
      // M4: отчёт онбординга и открытая карточка «Это новое устройство».
      // В живом интерфейсе отчёт приносит GET /api/dsh-sync/onboarding.
      setOnboarding: (value) => {
        snapshot = { ...snapshot, onboarding: value ?? null };
        for (const listener of listeners) listener();
      },
      readOnboarding: () => snapshot.onboarding,
      setOnboardingOpen: (value) => {
        snapshot = {
          ...snapshot,
          onboardingOpen: value === true,
          onboardingBusy: false,
          onboardingError: '',
          onboardingNotice: '',
          onboardingConfirm: '',
        };
        for (const listener of listeners) listener();
      },
      readOnboardingOpen: () => snapshot.onboardingOpen === true,
      readOnboardingConfirm: () => snapshot.onboardingConfirm,
      // Действия шагов онбординга: только существующие маршруты плагина.
      runOnboardingAction: (route) => onboardingActions?.run?.(route),
      refreshOnboarding: () => onboardingActions?.refresh?.(),
      onboardingCounts: (report) => {
        const steps = Array.isArray(report?.steps) ? report.steps : [];
        return {
          ready: report?.ready === true,
          count: Number(report?.count ?? 0) || 0,
          warn: steps.filter((step) => step.status === 'warn').length,
          fail: steps.filter((step) => step.status === 'fail').length,
          todo: steps.filter((step) => step.status === 'todo').length,
        };
      },
      // Черновик настроек для headless-тестов перестроенной страницы: бейдж
      // «есть изменения» и кнопка «Сохранить» рядом с полями.
      setDraft: (patch) => {
        draftOverride = { ...(draftOverride ?? {}), ...(patch ?? {}) };
        touchedOverride = true;
        for (const listener of listeners) listener();
      },
      resetDraft: () => {
        draftOverride = null;
        touchedOverride = false;
        for (const listener of listeners) listener();
      },
      readDraftOverride: () => draftOverride,
      // Статусы резервного канала и человеческие тексты ошибок сверки.
      reserveStatusOf,
      reserveErrorText,
      reserveStatusLabel: (payload) => reserveStatusOf(payload).label,
      // Полоса прогресса полной сверки резерва: для headless-тестов рендера
      // (N из M файлов, X из Y МБ, текущий файл, кнопка «Отменить»).
      ReserveProgress: (props) => (typeof reserveProgressComponent === 'function' ? reserveProgressComponent(props ?? {}) : null),
      storageDirtyOf,
      // План «Проверить» для тестов карточки: в живом интерфейсе его приносит
      // маршрут /api/dsh-sync/plan по кнопке.
      setPlan: (value) => {
        snapshot = { ...snapshot, plan: value ?? null };
        for (const listener of listeners) listener();
      },
      readPlan: () => snapshot.plan,
      // Состояние обновления для headless-тестов плашки: в живом интерфейсе его
      // приносит маршрут /api/dsh-sync/update, значение null — «ещё не проверено».
      setUpdateState: (value) => {
        updateOverride = value ?? null;
      },
      readUpdateState: () => updateOverride,
      // Отчёт «Найти дубли» для тестов карточки: в живом интерфейсе его
      // приносит маршрут /api/dsh-sync/duplicates по кнопке.
      setDuplicates: (value) => {
        snapshot = { ...snapshot, duplicates: value ?? null };
        for (const listener of listeners) listener();
      },
      readDuplicates: () => snapshot.duplicates,
      setTombstones: (value) => {
        tombstonesState.data = value ?? null;
        tombstonesState.at = Date.now();
        for (const listener of tombstonesState.listeners) listener();
      },
      readTombstones: () => tombstonesState.data,
      requestSessionStatesRefresh,
      sessionLabel,
      shortSessionId,
      badgeOf,
      SESSION_BADGES,
      INDICATOR_STATES,
      INDICATOR_COLORS,
      indicatorStateOf,
      indicatorTip,
      lastErrorLine,
      outboxCount,
      formatBytesShort,
      SessionSyncIndicator,
      SyncDot,
      // Переключатель режима в шапке сессии: для headless-тестов рендера
      // (меню, подтверждение и тост «Отменить» без настоящего React).
      SessionModeToggle,
      SessionModeMenu,
      LocalOnlyToast,
      DELETED_REASON_LABELS,
      DELETED_BY_LABELS,
      // Группы «родитель + субагенты»: сводка для шапки, строки с вложенностью,
      // счётчик и диалог удаления (подтверждение с числом субагентов).
      sessionGroupSummary,
      sessionGroupRows,
      SessionGroupsCounter,
      // M6: правила сессий — данные сводки и проверки, компоненты и чистые
      // помощники для headless-тестов рендера и тела POST.
      setSessionRules: (value) => {
        rulesState.data = value ?? null;
        rulesState.at = Date.now();
        for (const listener of rulesState.listeners) listener();
      },
      readSessionRules: () => rulesState.data,
      setRulesVerify: (value) => {
        rulesVerify.data = value ?? null;
        rulesVerify.at = Date.now();
        for (const listener of rulesState.listeners) listener();
      },
      readRulesVerify: () => rulesVerify.data,
      verifyRules,
      SessionRulesPanel,
      SessionRulesDialog,
      SessionRulesDialogHost,
      SessionRulesMenuItem,
      SessionMenuItems,
      openRulesDialog,
      closeRulesDialog,
      ShieldIcon,
      RULE_PRESETS,
      RULE_PRESET_ORDER,
      RULE_FILTERS,
      RULE_SOURCE_LABELS,
      RULES_VERIFY_BUCKETS,
      formatMbValue,
      rulesRowOf,
      rulesIdsOf,
      rulesFilterRows,
      rulesVisibleRows,
      rulesRowTitle,
      emptyRuleDraft,
      draftFromRule,
      buildRulePayload,
      deleteDialog: deleteClient.__test,
    };
    return module.exports;
  },
});
