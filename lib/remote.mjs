/**
 * Два бэкенда хранения зеркала:
 *
 * - `git` — репозиторий (рабочее дерево считается производным: перед каждой
 *   операцией приводится к состоянию удалённой ветки, после — коммит и push);
 * - `folder` — обычная папка на диске (OneDrive, Яндекс.Диск, Syncthing, сетевой
 *   шар). Никакого git и никаких бинарников: синхронизацией занимается
 *   клиент облака. Если задана `folderDir` (папка облака), зеркало копируется
 *   в локальный кеш `repoDir` и обратно — как у WebDAV.
 */
import { commitAndPush, ensureRepo, fetchRemote, setRemote } from './git.mjs'
import { createFolderBackend } from './folder.mjs'
import { createYandexBackend } from './yandex.mjs'
import { createWebdavBackend } from './webdav.mjs'

export async function createRemote(config) {
  if (config.backend === 'yandex') return createYandexBackend(config)
  if (config.backend === 'webdav') return createWebdavBackend(config)

  if (config.backend === 'folder') {
    // Новый режим «папка облака + локальный кеш»: копирование и сверка файлов.
    if (typeof config.folderDir === 'string' && config.folderDir.trim() !== '') {
      return createFolderBackend(config)
    }
    // Старый режим: repoDir и есть папка облака, копировать нечего.
    return {
      kind: 'folder',
      async sync() {
        return true
      },
      async commit() {
        return { committed: false, pushed: false }
      },
      async compare() {
        return { local: 0, cloud: 0, differ: 0, onlyLocal: 0, onlyCloud: 0 }
      },
    }
  }

  await ensureRepo({ repoDir: config.repoDir, branch: config.branch })
  const remote = {
    kind: 'git',
    async sync() {
      if (config.remote) {
        await setRemote(config.repoDir, config.remote)
        return fetchRemote(config.repoDir, config.branch)
      }
      return true
    },
    async commit(message) {
      return commitAndPush({ repoDir: config.repoDir, branch: config.branch, message })
    },
  }
  return remote
}
