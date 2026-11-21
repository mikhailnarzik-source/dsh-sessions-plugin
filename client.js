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
    const CREATE_REPO_PATH = '/api/dsh-sync/create-repo';
    const DIAG_PATH = '/api/dsh-sync/diagnostics';
    const UPDATE_PATH = '/api/dsh-sync/update';
    const UPDATE_APPLY_PATH = '/api/dsh-sync/update/apply';
    const shortSha = (value) => (value === null || value === undefined || value === '' ? '?' : String(value).slice(0, 7));

    const en = { title: 'Session sync' };
    const ru = { title: 'Синхронизация сессий' };

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

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        border: '1px solid rgba(128,128,128,0.22)',
        borderRadius: 12,
        background: 'rgba(128,128,128,0.04)',
      },
      title: { fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },
      accent: { width: 3, height: 16, borderRadius: 2, background: 'rgba(80,120,200,0.75)', flex: '0 0 auto' },
      hint: { fontSize: 12, opacity: 0.75, lineHeight: 1.5 },
      row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 },
      dot: { width: 8, height: 8, borderRadius: 4, flex: '0 0 auto' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 500 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontSize: 12, fontWeight: 500, opacity: 0.85 },
      get input() {
        return {
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 10px',
          borderRadius: 8,
          border: '1px solid rgba(128,128,128,0.35)',
          background: 'transparent',
          color: 'inherit',
          fontSize: 13,
          fontFamily: 'inherit',
          colorScheme: themeScheme(),
        };
      },
      buttons: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      button: {
        padding: '7px 13px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      primary: {
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid rgba(80,120,200,0.55)',
        background: 'rgba(80,120,200,0.16)',
        color: 'inherit',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      note: { fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, background: 'rgba(128,128,128,0.10)' },
      error: { fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, background: 'rgba(209,36,47,0.12)', border: '1px solid rgba(209,36,47,0.35)' },
      ok: { fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, background: 'rgba(40,150,80,0.12)', border: '1px solid rgba(40,150,80,0.35)' },
      meta: { fontSize: 11.5, opacity: 0.65 },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 },
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

    function explain(error) {
      const message = String(error?.message ?? error);
      if (error?.status === 404) {
        return `${message}. Host-часть плагина не загрузилась — полностью закройте DSH (включая значок в трее) и запустите снова, обновления страницы недостаточно.`;
      }
      return message;
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
            '.dshs-card button{transition:background-color .12s ease,border-color .12s ease,color .12s ease}',
            '.dshs-card button:hover:not(:disabled){background:rgba(128,128,128,0.16);border-color:rgba(150,150,150,0.65)}',
            '.dshs-card button:active:not(:disabled){background:rgba(128,128,128,0.24)}',
            '.dshs-card button:disabled{opacity:.55;cursor:default}',
            '.dshs-card button:focus-visible{outline:2px solid rgba(80,120,200,0.65);outline-offset:2px}',
            '.dshs-card input:focus-visible,.dshs-card select:focus-visible{outline:2px solid rgba(80,120,200,0.55);outline-offset:1px}',
            '.dshs-card select:hover{border-color:rgba(150,150,150,0.65)}',
            '.dshs-card select,.dshs-card select option{color-scheme:inherit;background-color:transparent;color:inherit}',
            '.dshs-card select option{background:#22242a;color:#f2f2f2}',
            '.dshs-card select option:checked{background:#3a3f4b;color:#ffffff}',
            '.dshs-card a{color:inherit}',
          ].join('\n');
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-sync: styles');
      } catch (error) {
        console.error('[dsh-sync] анимация недоступна:', error);
      }

      const listeners = new Set();
      let snapshot = { loading: true, data: null, error: '', busy: '', notice: '' };

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


      // Состояние нужно и в панели, а не только на открытой странице плагина:
      // опрашиваем его сами, иначе строка в подвале всегда видит пустоту.
      try {
        ctx.effect(() => {
          let stopped = false;
          let timer;

          const tick = async () => {
            if (stopped) return;
            await refresh();
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

      const run = async (action) => {
        publish({ busy: action, notice: '', error: '' });
        try {
          const result = await post(RUN_PATH, { action });
          if (result?.ok === true) {
            publish({ busy: '', notice: result.message || 'Готово' });
          } else {
            publish({ busy: '', error: result?.message ?? 'Синхронизация не удалась' });
          }
          await refresh();
        } catch (error) {
          publish({ busy: '', error: `Синхронизация не удалась: ${explain(error)}` });
        }
      };

      const useSnapshot = () => {
        const [, force] = React.useReducer((n) => n + 1, 0);
        React.useEffect(() => {
          listeners.add(force);
          return () => listeners.delete(force);
        }, []);
        return snapshot;
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
          // backupStatus в SyncProgress: причина сбоя резерва, если она есть.
          data?.backupStatus !== undefined && data.backupStatus.ok !== true && data.backupStatus.message !== ''
            ? h('span', { style: { fontSize: 11.5, color: '#d1242f' } }, data.backupStatus.message)
            : null,
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
        // Настройки плюс строка диагностики: пока неясно, что передаёт страница.
        const subject = props?.subject
        const debug = subject === undefined ? 'subject: нет' : 'subject: ' + JSON.stringify(subject).slice(0, 220)
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('span', { style: { fontSize: 11, opacity: 0.55 } }, debug),
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
    function CollapsedItem({ title, summary, badge, children }) {
      const [open, setOpen] = React.useState(false)
      return h(
        'div',
        {
          className: 'dsh-our-card',
          style: { display: 'flex', flexDirection: 'column', gap: 8 },
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
          h(
            'button',
            {
              type: 'button',
              onClick: () => setOpen(!open),
              style: {
                padding: '4px 12px',
                borderRadius: 8,
                border: '1px solid rgba(128,128,128,0.32)',
                background: open ? 'rgba(106,139,208,0.18)' : 'rgba(128,128,128,0.1)',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
                flex: '0 0 auto',
              },
            },
            open ? 'Свернуть' : 'Открыть',
          ),
        ),
        open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, children) : null,
      )
    }

      function SyncCard(props) {
        const view = props?.view;
        const state = useSnapshot();
        const data = state.data;
        const [update, setUpdate] = React.useState(null);
        const [updateNote, setUpdateNote] = React.useState('');
        const [probe, setProbe] = React.useState(null);
        const [draft, setDraft] = React.useState({ backend: 'git', remote: '', repoDir: '', yandexToken: '', yandexPath: 'dsh-sync', webdavLogin: '', webdavPassword: '', webdavPath: 'dsh-sync', secondaryBackend: 'none', secondaryRemote: '', secondaryLogin: '', secondaryPassword: '', secondaryPath: 'dsh-sync', projectPath: '', projectId: '', attachments: false, autoUpdate: false, useExternal: true });
        const [touched, setTouched] = React.useState(false);

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
            secondaryBackend: data.config.secondary?.backend ?? 'none',
            secondaryRemote: data.config.secondary?.remote ?? '',
            secondaryLogin: data.config.secondary?.webdavLogin ?? '',
            secondaryPassword: data.config.secondary?.webdavPassword ?? '',
            secondaryPath: data.config.secondary?.webdavPath ?? 'dsh-sync',
            useExternal: data.config.useExternal !== false,
          });
        }, [data?.config?.remote, data?.config?.projectPath, data?.config?.projectId, data?.config?.attachments, data?.config?.useExternal, touched]);

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

        const checks = data?.checks ?? [];
        const busy = state.busy !== '';
        const status = data?.status;
        const last = data?.lastRun;
        const external = data?.external;
        const mode = data?.mode;

        return h(
          'div',
          { style: S.page, className: 'dshs-card' },

          h(
            'div',
            { style: S.section },
            h('span', { style: S.title }, h('span', { style: S.accent }), 'Обновление плагина'),
            h(
              'span',
              { style: S.hint },
              update === null
                ? 'Проверяем версию…'
                : update.status === 'local'
                  ? 'Локальная установка: свежий код уже на месте, обновлять нечего.'
                  : update.status === 'behind'
                    ? `Доступно обновление: ${shortSha(update.installed)} → ${shortSha(update.latest)} — установится автоматически.`
                    : update.status === 'current'
                      ? `Актуально (${shortSha(update.installed)})`
                      : update.detail !== undefined && update.detail !== ''
                        ? `Проверка не удалась: ${update.detail}`
                        : 'Состояние неизвестно',
            ),
            update?.status === 'behind'
              ? h('button', { style: S.button, onClick: () => void applyUpdate() }, 'Обновить')
              : null,
            updateNote !== '' ? h('span', { style: S.note }, updateNote) : null,
          ),

          h(
            'div',
            { style: S.section },
            h('span', { style: S.title }, h('span', { style: S.accent }), 'Проверка окружения'),
            checks.length === 0
              ? h('span', { style: S.hint }, state.loading ? 'Проверка…' : 'Не удалось получить данные от host-части.')
              : null,
            ...checks.map((check) =>
              h(
                'div',
                { key: check.id, style: S.row },
                h('span', { style: { ...S.dot, background: check.ok ? '#2f9e44' : '#d1242f' } }),
                h('span', { style: { minWidth: 150 } }, check.title),
                h('span', { style: S.meta }, check.detail),
              ),
            ),
            checks.some((check) => !check.ok)
              ? h('span', { style: S.note }, checks.filter((check) => !check.ok).map((check) => check.hint).join(' '))
              : null,
          ),

          h(
            'div',
            { style: S.section },
            h('span', { style: S.title }, h('span', { style: S.accent }), 'Настройки'),
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
                  h('span', { style: { fontSize: 11, opacity: 0.6, lineHeight: 1.5 } }, "Пароль приложения: Яндекс ID → Безопасность → Пароли приложений → создать для «Файлы»."),
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
                    { style: S.button, disabled: busy, onClick: () => void checkYandex() },
                    state.busy === 'yandex' ? 'Проверка…' : 'Проверить доступ',
                  ),
                  probe
                    ? h(
                        'span',
                        { style: { fontSize: 12, color: probe.ok ? '#2f9e44' : '#d1242f' } },
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
                  h('span', { style: { fontSize: 11, opacity: 0.6, lineHeight: 1.5 } }, "OAuth-токен выдаётся приложению с доступом к диску: oauth.yandex.ru → «Создать приложение» → права на файлы."),
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
                    { style: S.button, disabled: busy, onClick: () => void checkYandex() },
                    state.busy === 'yandex' ? 'Проверка…' : 'Проверить доступ',
                  ),
                  probe
                    ? h(
                        'span',
                        { style: { fontSize: 12, color: probe.ok ? '#2f9e44' : '#d1242f' } },
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
              'span',
              { style: S.hint },
              'Плагин обновляется сам: проверка раз в 6 часов, при выходе новой версии установка идёт автоматически.',
            ),
            h(
              'div',
              { style: S.field },
              h('span', { style: S.label }, 'Резервное хранилище (дублирование)'),
              h(
                'select',
                {
                  style: { ...S.input, colorScheme: themeScheme() },
                  value: draft.secondaryBackend,
                  onChange: (event) => set({ secondaryBackend: event.target.value }),
                },
                h('option', { value: 'none' }, 'Не дублировать'),
                h('option', { value: 'git' }, 'Git-репозиторий'),
                h('option', { value: 'webdav' }, 'Яндекс.Диск (WebDAV)'),
              ),
              draft.secondaryBackend === 'git'
                ? h('input', {
                    style: { ...S.input, colorScheme: themeScheme() },
                    value: draft.secondaryRemote,
                    placeholder: 'https://github.com/user/dsh-sessions-backup.git',
                    onChange: (event) => set({ secondaryRemote: event.target.value }),
                  })
                : null,
              draft.secondaryBackend === 'webdav'
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h('input', {
                      style: { ...S.input, colorScheme: themeScheme() },
                      value: draft.secondaryLogin,
                      placeholder: 'логин Яндекса',
                      onChange: (event) => set({ secondaryLogin: event.target.value }),
                    }),
                    h('input', {
                      style: { ...S.input, colorScheme: themeScheme() },
                      type: 'password',
                      value: draft.secondaryPassword,
                      placeholder: data?.secondaryPasswordStored === true ? 'пароль сохранён в хранилище' : 'пароль приложения',
                      onChange: (event) => set({ secondaryPassword: event.target.value }),
                    }),
                    h('input', {
                      style: { ...S.input, colorScheme: themeScheme() },
                      value: draft.secondaryPath,
                      placeholder: 'dsh-sync-backup',
                      onChange: (event) => set({ secondaryPath: event.target.value }),
                    }),
                  )
                : null,
              h(
                'span',
                { style: S.hint },
                'Сессии и настройки дублируются в оба места, вложения — только в основное. Если основное хранилище недоступно, приём идёт из резервного.',
              ),
            ),
            h(
              'div',
              { style: S.buttons },
              h(
                'button',
                {
                  style: S.button,
                  disabled: busy || data === null,
                  onClick: () => {
                    // Сохраняем только на загруженных настройках: иначе пустые
                    // значения по умолчанию затирают уже настроенное хранилище.
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
                  style: S.button,
                  disabled: busy,
                  title: 'Собрать отчёт о состоянии и скопировать в буфер обмена',
                  onClick: () => void copyDiagnostics(),
                },
                state.busy === 'diag' ? 'Сбор…' : 'Диагностика',
              ),
            ),
            h(
              'span',
              { style: S.hint },
              'Репозиторий создаётся приватным через токен GitHub из хранилища DSH. Если токена нет — создайте репозиторий вручную и вставьте его HTTPS-адрес выше.',
            ),
          ),

          external?.found
            ? h(
                'div',
                { style: S.section },
                h('span', { style: S.title }, h('span', { style: S.accent }), 'Внешний плагин синхронизации'),
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
            'div',
            { style: S.section },
            h('span', { style: S.title }, h('span', { style: S.accent }), 'Синхронизация'),
        h('span', { style: { fontSize: 11, opacity: 0.5 } }, 'секция страницы: ' + detailState),
            status
              ? h('span', { style: S.hint }, `Сессий локально: ${status.local}, в зеркале: ${status.mirror}. Только локально: ${status.onlyLocal}, только в зеркале: ${status.onlyMirror}.`)
              : null,
            h(
              'div',
              { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, opacity: 0.8 } },
              h('span', { style: S.row }, h('span', { style: { ...S.dot, background: '#2f9e44' } }), 'синхронизировано'),
              h('span', { style: S.row }, h('span', { style: { ...S.dot, background: '#e8590c' } }), 'есть изменения'),
              h('span', { style: S.row }, h('span', { style: { ...S.dot, background: '#d1242f' } }), 'не отправлялось'),
            ),
            h(SyncProgress, { data }),

            data?.pending
              ? h('span', { style: S.note }, 'Есть неотправленные изменения — они уйдут при следующей отправке (не чаще раза в 5 минут) или по кнопке.')
              : null,
            status && status.local === 0 && status.mirror > 0
              ? h(
                  'span',
                  { style: S.note },
                  `Диагностика: home=${data?.debug?.home ?? '?'}, просканировано сессий ${data?.debug?.sessionsScanned ?? '?'}, пути в сторе: ${(data?.debug?.cwds ?? []).join(' | ') || '—'}, путь проекта: ${data?.debug?.projectPath || '—'}`,
                )
              : null,
            h(
              'div',
              { style: S.buttons },
              h(
                'button',
                { style: S.primary, disabled: busy, onClick: () => void run('sync') },
                state.busy === 'sync' ? 'Синхронизация…' : 'Синхронизировать',
              ),
              h('button', { style: S.button, disabled: busy, onClick: () => void run('pull') }, 'Только принять'),
              h('button', { style: S.button, disabled: busy, onClick: () => void run('push') }, 'Только отправить'),
              h('button', { style: S.button, disabled: busy, onClick: () => void refresh() }, 'Обновить'),
            ),
            last
              ? h(
                  'span',
                  { style: last.ok ? S.ok : S.error },
                  `${new Date(last.at).toLocaleString('ru-RU')} — ${last.ok ? 'успешно' : 'ошибка'}: ${last.message}`,
                )
              : h('span', { style: S.hint }, 'Ещё не запускалось.'),
            (data?.history?.length ?? 0) > 0
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('span', { style: S.label }, 'Последние запуски'),
                  ...data.history.slice(-3).reverse().map((entry, index) =>
                    h(
                      'span',
                      { key: `h${index}`, style: entry.ok ? S.meta : S.error },
                      `${new Date(entry.at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })} — ${entry.ok ? 'ok' : 'ошибка'}: ${entry.message}`,
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
          ),

          state.notice ? h('span', { style: S.ok }, state.notice) : null,
          state.error ? h('span', { style: S.error }, state.error) : null,
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

        const color = phase === 'ok' ? '#2f9e44' : phase === 'error' ? '#d1242f' : 'rgba(128,128,128,0.45)';

        return h(
          'div',
          {
            className: 'dshs-card',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
              padding: '32px 28px 64px',
              maxWidth: 700,
              height: '100%',
              boxSizing: 'border-box',
              overflowY: 'auto',
              overflowX: 'hidden',
            },
          },
          h('span', { style: { fontSize: 19, fontWeight: 600 } }, 'Синхронизация сессий'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 14 } },
            h('span', { style: { width: 12, height: 12, borderRadius: 6, background: color, flex: '0 0 auto' } }),
            h('span', null, text || 'Готово к синхронизации'),
          ),
          detail ? h('span', { style: { fontSize: 12.5, opacity: 0.7, lineHeight: 1.5 } }, detail) : null,
          h(
            'button',
            {
              type: 'button',
              onClick: () => void run(),
              disabled: phase === 'busy',
              style: {
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                height: 34,
                padding: '0 16px',
                borderRadius: 8,
                border: '1px solid rgba(128,128,128,0.32)',
                background: 'rgba(128,128,128,0.12)',
                color: 'inherit',
                font: 'inherit',
                fontSize: 13.5,
                fontWeight: 600,
                cursor: phase === 'busy' ? 'progress' : 'pointer',
              },
            },
            phase === 'busy' ? 'Синхронизация…' : 'Синхронизировать снова',
          ),
          h(
            'span',
            { style: { fontSize: 12, opacity: 0.6, lineHeight: 1.6 } },
            'Автосинхронизация работает в фоне: приём при старте и раз в 15 минут, отправка при изменениях.',
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                marginTop: 6,
                paddingTop: 12,
                borderTop: '1px solid rgba(128,128,128,0.18)',
                maxWidth: 640,
              },
            },
            h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, 'Настройки'),
            h(SyncCard, { view: null }),
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
                width: 420,
                maxWidth: 'calc(100vw - 32px)',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                padding: '20px 22px',
                borderRadius: 14,
                border: '1px solid rgba(128,128,128,0.28)',
                background: 'var(--dsw-alias-bg-base, #22242a)',
                color: 'var(--dsw-alias-label-primary, inherit)',
                boxShadow: '0 18px 50px rgba(0,0,0,0.45)',
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
                  onClick: done,
                  style: {
                    padding: '7px 16px',
                    borderRadius: 8,
                    border: '1px solid rgba(128,128,128,0.35)',
                    background: 'rgba(80,120,200,0.18)',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                  },
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
        );
      }

      ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: 'dsh-sync',
        order: 55,
        label: () => t('title'),
        locale: NS,
      }, () => h(CollapsedItem, { title: 'Синхронизация сессий', summary: 'Статус, резерв и настройки хранилища', badge: 'наше' }, h(SyncCard))));

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

      // Индикатор перед названием сессии: точка состояния синхронизации.
      try {
        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
          name: 'sidebar.session.row.leading',
          id: 'dsh-sync',
          order: 60,
        }, SyncDot));
      } catch (error) {
        console.error('[dsh-sync] индикатор в списке сессий недоступен:', error);
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

      // Строка состояния в подвале панели: сразу видно, всё ли синхронизировано.
      try {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-sync-footer',
          order: 40,
        }, SyncFooterRow));
      } catch (error) {
        console.error('[dsh-sync] строка состояния в подвале недоступна:', error);
      }
    }

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
        sessionStates.data = result?.states ?? {};
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

    function SyncDot({ sessionId }) {
      const states = useSessionStates();
      const state = states[sessionId];
      if (state === undefined) return null;
      const color = state === 'green' ? '#2f9e44' : state === 'red' ? '#d1242f' : '#e8590c';
      const title = state === 'green'
        ? 'Синхронизировано'
        : state === 'red'
          ? 'Не синхронизировано — ещё ни разу не уходило в зеркало'
          : 'Есть неотправленные изменения';
      return h('span', {
        title,
        style: {
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          marginRight: 4,
          flex: '0 0 auto',
        },
      });
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
.${P}-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#5a6070)}
.${P}-close:disabled{opacity:.4;cursor:not-allowed}
.${P}-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary,#16181d)}
.${P}-body{display:flex;flex-direction:column;gap:12px;min-width:0;margin-top:20px;padding:0 24px}
.${P}-note{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#5a6070)}
.${P}-warning{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#5a6070)}
.${P}-warning p{margin:0}
.${P}-warning svg{margin-top:2px;color:var(--dsw-alias-state-error-primary,#d92d20)}
.${P}-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.${P}-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#16181d);min-width:72px}
.${P}-button:disabled{cursor:not-allowed;opacity:.4}
.${P}-button-outline{box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3,#d5d7dd))}
.${P}-button-primary{background:var(--dsw-alias-button-primary-fill,#2a6df4);color:var(--dsw-alias-label-primary-foreground,#fff)}
.${P}-button-delete:not(:disabled){color:var(--dsw-alias-state-error-primary,#d92d20)}
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
.${P}-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1f5ada)}
.${P}-button-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.${P}-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
}
@keyframes ${P}-enter{0%{opacity:0}to{opacity:1}}
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

      return { inject: ['slots', 'locale'], apply };
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
    return module.exports;
  },
});
