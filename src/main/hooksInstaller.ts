// Faz 1 hook kurulum kitaplığının (hooks/lib/installer.mjs, CLI ile ortak) main tarafı bağlantısı.
// Uzantısız import: tipler installer.d.ts'ten, çalışma zamanında Vite .mjs'i çözer.
import { install, status, uninstall } from '../../hooks/lib/installer';
import type { HookInstallerLike } from './handlers';

export const hookInstaller: HookInstallerLike = { status, install, uninstall };
