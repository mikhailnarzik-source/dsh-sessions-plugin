/**
 * Секреты синхронизации.
 *
 * Пароль приложения Яндекс.Диска раньше лежал открытым текстом в
 * `~/.dsh/dsh-sync.json`. Теперь он хранится в хранилище секретов DSH, а в
 * настройках остаётся только отметка «пароль сохранён».
 *
 * Здесь тонкая обёртка: сервис может отсутствовать (старый профиль, тесты),
 * и тогда вызывающий код откатывается к прежнему поведению.
 */

/** Ключ пароля WebDAV в хранилище секретов DSH. */
export const WEBDAV_SECRET = 'DSH_SYNC_WEBDAV_PASSWORD'

/** Значение-заглушка, которое приходит из интерфейса вместо настоящего пароля. */
export const PLACEHOLDER = '********'

/** Сервис секретов профиля или undefined. */
function service(ctx) {
  try {
    return ctx?.get?.('credentials')
  } catch {
    return undefined
  }
}

/** Прочитать секрет или undefined. */
export async function readSecret(ctx, key = WEBDAV_SECRET) {
  try {
    const hit = await service(ctx)?.resolve?.(key)
    const value = hit?.value
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** Записать секрет. false — хранилище недоступно. */
export async function writeSecret(ctx, value, key = WEBDAV_SECRET) {
  if (typeof value !== 'string' || value === '' || value === PLACEHOLDER) return false
  try {
    const store = service(ctx)
    if (store === undefined || typeof store.set !== 'function') return false
    await store.set(key, value)
    return true
  } catch {
    return false
  }
}

/** Удалить секрет; отсутствие не считается ошибкой. */
export async function forgetSecret(ctx, key = WEBDAV_SECRET) {
  try {
    await service(ctx)?.unset?.(key)
    return true
  } catch {
    return false
  }
}

/** Есть ли сохранённый пароль. */
export async function hasSecret(ctx, key = WEBDAV_SECRET) {
  return (await readSecret(ctx, key)) !== undefined
}
