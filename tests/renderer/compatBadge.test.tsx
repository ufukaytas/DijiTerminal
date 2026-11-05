// 09/01 uyumluluk rozeti: ok/yok → gizli; warn sarı, error kırmızı; panel; "Bu oturumda gizle" yeni sinyal gelene kadar.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CompatReport, CompatSignal } from '@shared/compat';
import { Header } from '@renderer/components/Header';
import { EmptyState } from '@renderer/components/map/SessionGrid';
import { compatView, emptyMapWarning } from '@renderer/lib/compat';
import { resetBoard, useBoard } from '@renderer/state/board';
import { useCompatUi } from '@renderer/state/compat';
import { makeSnapshot } from './__fixtures__/snapshot';

const sig = (id: CompatSignal['id'], level: CompatSignal['level'] = 'warn', detail: Record<string, number> = { 'foo-bar': 120 }): CompatSignal => ({
  id,
  level,
  count: Object.values(detail).reduce((a, b) => a + b, 0),
  detail,
});
const report = (signals: CompatSignal[], over: Partial<CompatReport> = {}): CompatReport => ({
  level: signals.some((s) => s.level === 'error') ? 'error' : signals.length ? 'warn' : 'ok',
  claudeVersion: '2.1.340',
  testedMin: '2.1.288',
  testedMax: '2.1.318',
  untestedVersion: true,
  signals,
  since: 0,
  at: 0,
  records: 1000,
  ...over,
});
const show = (c: CompatReport | undefined) =>
  act(() => useBoard.getState().setSnapshot(c ? { ...makeSnapshot(), compat: c } : makeSnapshot()));

beforeEach(() => {
  resetBoard();
  useCompatUi.setState({ hidden: new Set() });
});
afterEach(() => cleanup());

describe('CompatBadge', () => {
  it('rapor yok ya da ok → rozet yok', () => {
    show(undefined);
    render(<Header />);
    expect(screen.queryByText('⚠ Uyumluluk')).toBeNull();
    show(report([]));
    expect(screen.queryByText('⚠ Uyumluluk')).toBeNull();
  });

  it('warn sarı, error kırmızı; tıklayınca panel: sürüm, sinyal, ayrıntı', () => {
    show(report([sig('unknownRecordTypes')]));
    render(<Header />);
    const badge = screen.getByText('⚠ Uyumluluk');
    expect(badge.className).toContain('c-wait');
    fireEvent.click(badge);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/Claude Code 2\.1\.340 · test edilen aralık 2\.1\.288–2\.1\.318/)).toBeTruthy();
    expect(screen.getByText('Tanınmayan transcript kayıt tipleri')).toBeTruthy();
    expect(screen.getByText('foo-bar ×120')).toBeTruthy();
    show(report([sig('processWithoutSession', 'error', { claudeSureci: 2, canliSession: 0 })]));
    expect(screen.getByText('⚠ Uyumluluk', { selector: 'button' }).className).toContain('c-slow');
  });

  it('"Bu oturumda gizle": aynı sinyaller gizli kalır, yeni sinyal türü rozeti geri getirir', () => {
    show(report([sig('unknownRecordTypes')]));
    render(<Header />);
    fireEvent.click(screen.getByText('⚠ Uyumluluk'));
    fireEvent.click(screen.getByText('Bu oturumda gizle'));
    expect(screen.queryByText('⚠ Uyumluluk')).toBeNull();
    show(report([sig('unknownRecordTypes', 'warn', { 'foo-bar': 500 })]));
    expect(screen.queryByText('⚠ Uyumluluk')).toBeNull();
    show(report([sig('unknownRecordTypes'), sig('hookBadLines', 'warn', { invalid: 12 })]));
    expect(screen.getByText('⚠ Uyumluluk')).toBeTruthy();
  });
});

describe('boş harita', () => {
  it('çelişki sinyali → uyarı + rozete yönlendirme; "henüz session yok" metni gösterilmez', () => {
    show(report([sig('processWithoutSession', 'error', { claudeSureci: 2, canliSession: 0 })]));
    render(<EmptyState />);
    expect(screen.getByRole('alert').textContent).toBe(emptyMapWarning('2.1.340'));
    expect(screen.getByText(/Uyumluluk rozetine tıklayın/)).toBeTruthy();
    expect(screen.queryByText(/Henüz çalışan Claude Code/)).toBeNull();
  });

  it('sinyal yok → yalnızca olağan boş durum metni', () => {
    show(report([]));
    render(<EmptyState />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Henüz çalışan Claude Code/)).toBeTruthy();
  });
});

describe('compat metinleri', () => {
  it('çelişki sinyali → boş harita uyarısı; sürüm bilinmiyorsa genel ifade', () => {
    const v = compatView(report([sig('processWithoutSession', 'error')]), new Set());
    expect(v?.level).toBe('error');
    expect(v?.summary).toBe(emptyMapWarning('2.1.340'));
    expect(emptyMapWarning(null)).toContain('kurulu Claude Code sürümü');
  });
});
