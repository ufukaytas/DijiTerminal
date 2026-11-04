import { describe, expect, it } from 'vitest';
import { fitName, PlatePainter, type PlateContent } from '@renderer/map3d/plate';
import { fakeCanvas, type FakeCtx } from './_env';

const content = (over: Partial<PlateContent> = {}): PlateContent => ({
  name: 'demo-app',
  tag: null,
  path: '~/Projects/demo-app',
  color: '#F0A6CA',
  summary: [['2 session · 3 ajan · $1.20', '#AEB8CC']],
  ...over,
});

function painter() {
  let canvas: ReturnType<typeof fakeCanvas> | null = null;
  let resolveFonts: () => void = () => {};
  const fonts = new Promise<void>((r) => (resolveFonts = r));
  const p = new PlatePainter(
    (w, h) => {
      canvas = fakeCanvas(w, h);
      return canvas;
    },
    8,
    fonts,
  );
  return { p, ctx: (): FakeCtx => canvas!.ctx, resolveFonts };
}

describe('PlatePainter', () => {
  it('aynı içerik yeniden çizilmez; özet değişince çizilir', () => {
    const { p, ctx } = painter();
    expect(p.paint(content())).toBe(true);
    const v = p.texture.version;
    expect(p.paint(content())).toBe(false);
    expect(p.paint(content({ summary: [['2 session · 3 ajan · $1.20', '#AEB8CC']] }))).toBe(false);
    expect(p.draws).toBe(1);
    expect(p.texture.version).toBe(v);
    expect(p.paint(content({ summary: [['2 session · 3 ajan · $1.20', '#AEB8CC'], [' · bekliyor', '#F2B134']] }))).toBe(true);
    expect(p.draws).toBe(2);
    expect(ctx().fillTextCalls).toContain(' · bekliyor');
    expect(p.texture.anisotropy).toBe(8);
  });

  it('fontlar yüklenince bir kez daha çizilir', async () => {
    const { p, resolveFonts } = painter();
    p.paint(content());
    resolveFonts();
    await Promise.resolve();
    await Promise.resolve();
    expect(p.draws).toBe(2);
  });

  it('ad, tag, yol ve özet parçaları çizilir', () => {
    const { p, ctx } = painter();
    p.paint(content({ tag: 'agent takımı', summary: [['1 session', '#AEB8CC'], [' · çakışma', '#FF7A6B']] }));
    expect(ctx().fillTextCalls).toEqual(['demo-app', 'agent takımı', '~/Projects/demo-app', '1 session', ' · çakışma']);
  });
});

describe('fitName', () => {
  const measure = (t: string, px: number) => t.length * px * 0.55;

  it('sığan ad 168px', () => {
    expect(fitName(measure, 'youcms', 1700)).toEqual({ text: 'youcms', px: 168 });
  });

  it('uzun ad 120px\'e kadar küçülür', () => {
    const name = 'x'.repeat(20); // 20 × 168 × .55 = 1848 > 1700; 20 × 152 × .55 = 1672
    expect(fitName(measure, name, 1700).px).toBeLessThan(168);
    expect(fitName(measure, name, 1700).px).toBeGreaterThanOrEqual(120);
  });

  it('120px\'te de sığmayan ad … ile kesilir', () => {
    const r = fitName(measure, 'çok-uzun-bir-proje-adı-gerçekten-uzun', 1700);
    expect(r.px).toBe(120);
    expect(r.text.endsWith('…')).toBe(true);
    expect(measure(r.text, 120)).toBeLessThanOrEqual(1700);
  });
});
