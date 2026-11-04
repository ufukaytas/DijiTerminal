import { describe, expect, it } from 'vitest';
import type { SessionView } from '@shared/types';
import {
  DEFAULT_LOG_FILTER,
  filterLog,
  isFilterActive,
  parseLogFilter,
  toggleChip,
  type LogFilter,
} from '@renderer/components/log/filterLog';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const snap = makeSnapshot(1_800_000_000_000);
const byId = new Map<string, SessionView>(snap.sessions.map((s) => [s.id, s]));
const f = (o: Partial<LogFilter>): LogFilter => ({ ...DEFAULT_LOG_FILTER, ...o });

describe('filterLog', () => {
  it('filtre yoksa aynı dizi döner', () => {
    expect(filterLog(snap.log, DEFAULT_LOG_FILTER, byId)).toBe(snap.log);
    expect(isFilterActive(DEFAULT_LOG_FILTER)).toBe(false);
  });

  it('proje ve session', () => {
    const p = filterLog(snap.log, f({ projectId: 'p3docs' }), byId);
    expect(p.length).toBeGreaterThan(0);
    expect(p.every((e) => byId.get(e.sessionId)?.projectId === 'p3docs')).toBe(true);
    const s = filterLog(snap.log, f({ sessionId: IDS.team }), byId);
    expect(s.every((e) => e.sessionId === IDS.team)).toBe(true);
  });

  it('kategori: araç kayıtları kategoriyle, prompt/say yalnızca "diğer" ile', () => {
    const bash = filterLog(snap.log, toggleChip(DEFAULT_LOG_FILTER, ['bash']), byId);
    expect(bash.length).toBeGreaterThan(0);
    expect(bash.every((e) => e.kind === 'tool' && e.category === 'bash')).toBe(true);
    const other = filterLog(snap.log, toggleChip(DEFAULT_LOG_FILTER, ['other', 'plan']), byId);
    expect(other.some((e) => e.kind === 'say')).toBe(true);
    expect(other.some((e) => e.kind === 'prompt')).toBe(true);
    expect(other.some((e) => e.toolName === 'ExitPlanMode')).toBe(true); // plan kategorisi diğer'de
    expect(other.some((e) => e.category === 'bash')).toBe(false);
  });

  it('sadece hatalar', () => {
    const errs = filterLog(snap.log, f({ errorsOnly: true }), byId);
    expect(errs.map((e) => e.id)).toEqual(['l-err-1']);
  });

  it("session snapshot'ta yoksa proje filtresinde düşer", () => {
    const orphan = { ...snap.log[0]!, id: 'o', sessionId: '99999999-9999-4999-8999-999999999999' };
    expect(filterLog([orphan], f({ projectId: 'p1demoapp' }), byId)).toEqual([]);
  });
});

describe('toggleChip / parseLogFilter', () => {
  it('çip bütün kategorileri açar ve kapatır', () => {
    const on = toggleChip(DEFAULT_LOG_FILTER, ['read', 'search']);
    expect(on.categories.sort()).toEqual(['read', 'search']);
    expect(toggleChip(on, ['read', 'search']).categories).toEqual([]);
    const partial = f({ categories: ['read'] });
    expect(toggleChip(partial, ['read', 'search']).categories.sort()).toEqual(['read', 'search']);
  });

  it('bozuk localStorage değeri varsayılana döner; geçersiz alanlar ayıklanır', () => {
    expect(parseLogFilter('{bozuk')).toEqual(DEFAULT_LOG_FILTER);
    expect(parseLogFilter(null)).toEqual(DEFAULT_LOG_FILTER);
    expect(
      parseLogFilter(
        JSON.stringify({ projectId: '../x', sessionId: IDS.busy, categories: ['bash', 'evil'], errorsOnly: 'yes' }),
      ),
    ).toEqual({ projectId: null, sessionId: IDS.busy, categories: ['bash'], errorsOnly: false });
  });
});
