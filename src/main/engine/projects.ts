// Proje çözümleyici
// cwd → git kökü (worktree'ler ana repoya bağlanır), deterministik renk/amblem, "agent takımı" etiketi.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMBLEMS, PROJECT_PALETTE } from '@shared/constants';
import type { AppSettings, EmblemKind } from '@shared/types';
import { gitRevParse, type GitRoots } from './git';

export interface ResolvedProject {
  id: string; // sha1(root).slice(0,10)
  root: string; // ana repo kökü (mutlak)
  worktree: string | null;
  isGit: boolean;
  displayPath: string; // '~/Projects/youcms'
}

export interface ProjectIdentity {
  name: string;
  color: string; // hex
  emblem: EmblemKind;
  hidden: boolean;
}

export interface ProjectResolverDeps {
  git?: (cwd: string) => Promise<GitRoots | null>;
  settings: () => AppSettings;
  home?: string;
  countAgents?: (root: string) => Promise<number>;
  now?: () => number;
}

const CACHE_TTL_MS = 10 * 60_000;
const TAG_TTL_MS = 60_000;
const TEAM_TAG = 'agent takımı';
const WORKTREE_RE = /^(.*?)[/\\]\.claude[/\\]worktrees[/\\]([^/\\]+)/;

export const projectIdOf = (root: string): string => crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);

export function hashInt(s: string): number {
  return parseInt(crypto.createHash('sha1').update(s).digest('hex').slice(0, 8), 16);
}

async function defaultCountAgents(root: string): Promise<number> {
  try {
    const names = await fs.promises.readdir(path.join(root, '.claude', 'agents'));
    return names.filter((n) => n.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/** Git'e gitmeden: `.claude/worktrees/<ad>` sezgiseli ya da cwd'nin kendisi. */
export function heuristicRoot(cwd: string): { root: string; worktree: string | null } {
  const abs = path.resolve(cwd);
  const m = WORKTREE_RE.exec(abs);
  if (m && m[1] && m[2]) return { root: m[1], worktree: m[2] };
  return { root: abs, worktree: null };
}

export class ProjectResolver {
  private readonly git: (cwd: string) => Promise<GitRoots | null>;
  private readonly settings: () => AppSettings;
  private readonly home: string;
  private readonly countAgents: (root: string) => Promise<number>;
  private readonly now: () => number;

  private cache = new Map<string, { at: number; value: ResolvedProject }>();
  private inflight = new Map<string, Promise<ResolvedProject>>();
  private tags = new Map<string, { at: number; value: string | null }>();

  constructor(deps: ProjectResolverDeps) {
    this.git = deps.git ?? gitRevParse;
    this.settings = deps.settings;
    this.home = deps.home ?? os.homedir();
    this.countAgents = deps.countAgents ?? defaultCountAgents;
    this.now = deps.now ?? Date.now;
  }

  /** Senkron tahmin: önbellekte varsa o, yoksa sezgisel. Store, git sonucu gelene kadar bunu kullanır. */
  peek(cwd: string): ResolvedProject {
    const hit = this.cache.get(cwd);
    if (hit) return hit.value;
    const h = heuristicRoot(cwd);
    return this.make(h.root, h.worktree, false);
  }

  resolve(cwd: string): Promise<ResolvedProject> {
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value);
    const running = this.inflight.get(cwd);
    if (running) return running;
    const p = this.compute(cwd)
      .then((value) => {
        this.cache.set(cwd, { at: this.now(), value });
        return value;
      })
      .finally(() => this.inflight.delete(cwd));
    this.inflight.set(cwd, p);
    return p;
  }

  private async compute(cwd: string): Promise<ResolvedProject> {
    const h = heuristicRoot(cwd);
    const g: GitRoots | null = await this.git(cwd).catch(() => null);
    if (g) {
      const common = g.commonDir.replace(/[/\\]+$/, '');
      const mainRoot = /[/\\]\.git$/.test(common) ? path.dirname(common) : g.toplevel;
      const worktree = path.resolve(g.toplevel) !== path.resolve(mainRoot) ? path.basename(g.toplevel) : null;
      return this.make(path.resolve(mainRoot), worktree, true);
    }
    return this.make(h.root, h.worktree, false);
  }

  private make(root: string, worktree: string | null, isGit: boolean): ResolvedProject {
    return { id: projectIdOf(root), root, worktree, isGit, displayPath: this.display(root) };
  }

  private display(root: string): string {
    const home = this.home.replace(/[/\\]+$/, '');
    if (home && (root === home || root.startsWith(home + path.sep))) return '~' + root.slice(home.length);
    return root;
  }

  /**
   * Ayardaki renk/amblem önce ayrılır; kalan kökler alfabetik sırayla `hash(root) % n` konumundan başlayıp
   * ilk boş renge/amblemlere yerleşir. Palet biterse tekrar başa döner.
   */
  identity(root: string, visibleRoots: string[]): ProjectIdentity {
    const s = this.settings().projects[root] ?? {};
    const name = s.alias?.trim() || path.basename(root) || root;
    const hidden = s.hidden === true;
    const roots = [...new Set([...visibleRoots, root])].sort();
    const colors = this.assign(roots, PROJECT_PALETTE, (r) => this.settings().projects[r]?.color);
    const emblems = this.assign(roots, EMBLEMS, (r) => this.settings().projects[r]?.emblem);
    return {
      name,
      color: colors.get(root) ?? PROJECT_PALETTE[0] ?? '#8A94A6',
      emblem: (emblems.get(root) ?? EMBLEMS[0] ?? 'cube') as EmblemKind,
      hidden,
    };
  }

  private assign<T extends string>(roots: string[], pool: readonly T[], fixed: (r: string) => T | undefined): Map<string, T> {
    const out = new Map<string, T>();
    const used = new Set<T>();
    for (const r of roots) {
      const f = fixed(r);
      if (f) {
        out.set(r, f);
        used.add(f);
      }
    }
    const n = pool.length;
    for (const r of roots) {
      if (out.has(r) || n === 0) continue;
      const start = hashInt(r) % n;
      let pick: T | undefined;
      for (let i = 0; i < n; i++) {
        const c = pool[(start + i) % n] as T;
        if (!used.has(c)) {
          pick = c;
          break;
        }
      }
      if (pick === undefined) {
        // Palet bitti: başa dön (çakışmaya izin ver).
        used.clear();
        pick = pool[start] as T;
      }
      used.add(pick);
      out.set(r, pick);
    }
    return out;
  }

  async tagOf(root: string): Promise<string | null> {
    const hit = this.tags.get(root);
    if (hit && this.now() - hit.at < TAG_TTL_MS) return hit.value;
    const value = (await this.countAgents(root)) >= 3 ? TEAM_TAG : null;
    this.tags.set(root, { at: this.now(), value });
    return value;
  }

  /** Senkron: son bilinen etiket (yoksa null). */
  peekTag(root: string): string | null {
    return this.tags.get(root)?.value ?? null;
  }

  isHidden(root: string): boolean {
    return this.settings().projects[root]?.hidden === true;
  }

  invalidate(cwd?: string): void {
    if (cwd === undefined) {
      this.cache.clear();
      this.tags.clear();
    } else {
      this.cache.delete(cwd);
    }
  }
}
