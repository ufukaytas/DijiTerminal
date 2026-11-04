// Harita kapsamı: sona eren session ve yaşayanı kalmayan proje haritadan kalkar.
import { describe, expect, it } from 'vitest';
import { mapScope } from '@renderer/lib/mapScope';
import { makeSnapshot } from './__fixtures__/snapshot';

describe('mapScope', () => {
  it('ended session kalkar; projenin sessionIds listesi daralır; hepsi bitmiş proje kalkar', () => {
    const snap = makeSnapshot();
    const p = snap.projects[0]!;
    const [first, ...rest] = p.sessionIds;
    const sessions = snap.sessions.map((s) =>
      s.id === first ? { ...s, status: 'ended' as const } : s,
    );
    const scope = mapScope({ projects: snap.projects, sessions });
    expect(scope.sessions.some((s) => s.id === first)).toBe(false);
    const sp = scope.projects.find((x) => x.id === p.id);
    if (rest.some((id) => sessions.find((s) => s.id === id)?.status !== 'ended')) expect(sp?.sessionIds).not.toContain(first);
    else expect(sp).toBeUndefined();

    const allEnded = snap.sessions.map((s) => (p.sessionIds.includes(s.id) ? { ...s, status: 'ended' as const } : s));
    expect(mapScope({ projects: snap.projects, sessions: allEnded }).projects.find((x) => x.id === p.id)).toBeUndefined();
  });

  it('değişmeyen proje aynı nesne olarak döner', () => {
    const snap = makeSnapshot();
    const live = snap.sessions.map((s) => (s.status === 'ended' ? { ...s, status: 'idle' as const } : s));
    const scope = mapScope({ projects: snap.projects, sessions: live });
    expect(scope.projects[0]).toBe(snap.projects[0]);
  });
});
