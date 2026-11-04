// session.log filtreleri (03/04). Saf fonksiyonlar.
import { CATEGORY_COLOR } from '@shared/constants';
import type { LogEntry, SessionView, ToolCategory } from '@shared/types';

export type LogCategoryFilter = ToolCategory | 'other';
export interface LogFilter {
  projectId: string | null;
  sessionId: string | null;
  categories: LogCategoryFilter[]; // boş = hepsi
  errorsOnly: boolean;
}

export const DEFAULT_LOG_FILTER: LogFilter = Object.freeze({
  projectId: null,
  sessionId: null,
  categories: [],
  errorsOnly: false,
}) as LogFilter;

/** Filtre çubuğundaki çipler; bir çip birden çok kategoriyi kapsayabilir. */
export const CATEGORY_CHIPS: readonly { key: string; label: string; cats: LogCategoryFilter[]; color: string }[] = [
  { key: 'read', label: 'okuma/arama', cats: ['read', 'search'], color: CATEGORY_COLOR.read },
  { key: 'edit', label: 'düzenleme', cats: ['edit'], color: CATEGORY_COLOR.edit },
  { key: 'bash', label: 'bash', cats: ['bash'], color: CATEGORY_COLOR.bash },
  { key: 'web', label: 'web', cats: ['web', 'browser'], color: CATEGORY_COLOR.web },
  { key: 'agent', label: 'ajan', cats: ['agent'], color: CATEGORY_COLOR.agent },
  { key: 'mcp', label: 'mcp', cats: ['mcp'], color: CATEGORY_COLOR.mcp },
  { key: 'other', label: 'diğer', cats: ['other', 'plan'], color: CATEGORY_COLOR.plan },
];

const ERROR_RE = /hata|error|fail|başarısız/i;

export function isErrorEntry(e: LogEntry): boolean {
  return e.state === 'err' || (e.kind === 'sys' && ERROR_RE.test(e.label));
}

/** Araç kaydı kendi kategorisiyle; prompt/say/sys/agent kayıtları yalnızca "diğer" ile eşleşir. */
function matchesCategory(e: LogEntry, cats: ReadonlySet<LogCategoryFilter>): boolean {
  if (e.kind !== 'tool') return cats.has('other');
  return cats.has(e.category ?? 'plan');
}

export function filterLog(entries: LogEntry[], f: LogFilter, sessionsById: Map<string, SessionView>): LogEntry[] {
  if (!isFilterActive(f)) return entries;
  const cats = new Set(f.categories);
  return entries.filter((e) => {
    if (f.sessionId && e.sessionId !== f.sessionId) return false;
    if (f.projectId && sessionsById.get(e.sessionId)?.projectId !== f.projectId) return false;
    if (cats.size > 0 && !matchesCategory(e, cats)) return false;
    if (f.errorsOnly && !isErrorEntry(e)) return false;
    return true;
  });
}

export function isFilterActive(f: LogFilter): boolean {
  return f.projectId !== null || f.sessionId !== null || f.categories.length > 0 || f.errorsOnly;
}

/** Çipin bütün kategorileri seçiliyse kaldırır, değilse ekler. */
export function toggleChip(f: LogFilter, chipCats: readonly LogCategoryFilter[]): LogFilter {
  const set = new Set(f.categories);
  const on = chipCats.every((c) => set.has(c));
  for (const c of chipCats) {
    if (on) set.delete(c);
    else set.add(c);
  }
  return { ...f, categories: [...set] };
}

const ALL_CATS = new Set<string>(CATEGORY_CHIPS.flatMap((c) => c.cats));
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** localStorage'dan gelen değeri doğrular; bozuksa varsayılan. */
export function parseLogFilter(raw: string | null): LogFilter {
  if (!raw) return { ...DEFAULT_LOG_FILTER };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object') return { ...DEFAULT_LOG_FILTER };
    const id = (x: unknown) => (typeof x === 'string' && ID_RE.test(x) ? x : null);
    return {
      projectId: id(v['projectId']),
      sessionId: id(v['sessionId']),
      categories: Array.isArray(v['categories'])
        ? (v['categories'].filter((c) => typeof c === 'string' && ALL_CATS.has(c)) as LogCategoryFilter[])
        : [],
      errorsOnly: v['errorsOnly'] === true,
    };
  } catch {
    return { ...DEFAULT_LOG_FILTER };
  }
}

export const LOG_FILTER_KEY = 'diji.logFilter.v1';

export function loadLogFilter(): LogFilter {
  try {
    return parseLogFilter(window.localStorage.getItem(LOG_FILTER_KEY));
  } catch {
    return { ...DEFAULT_LOG_FILTER };
  }
}

export function saveLogFilter(f: LogFilter): void {
  try {
    window.localStorage.setItem(LOG_FILTER_KEY, JSON.stringify(f));
  } catch {
    // depolama kapalı — tercih bu oturumla sınırlı kalır
  }
}
