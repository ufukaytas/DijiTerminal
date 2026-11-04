// MapView ↔ store senkronu (03/07 Prompt 7) ve WebGL olmadan liste görünümüne düşme.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectScene, firstSessionOfProject, MapView } from '@renderer/components/MapView';
import { resetBoard, useBoard } from '@renderer/state/board';
import { IDS, makeSnapshot } from '../__fixtures__/snapshot';

const NOW = 1_800_000_000_000;
const tick = () => new Promise<void>((r) => queueMicrotask(r));

function fakes() {
  const scene = { update: vi.fn(), select: vi.fn(), handleEvents: vi.fn() };
  const ix = { focusSession: vi.fn(), focusProject: vi.fn() };
  return { scene, ix };
}

beforeEach(() => resetBoard());
afterEach(() => cleanup());

describe('connectScene', () => {
  it('mevcut snapshot ve seçimle başlar; snapshot değişince update', () => {
    const { scene, ix } = fakes();
    const link = connectScene(scene, ix);
    expect(scene.update).toHaveBeenCalledTimes(1);
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    expect(scene.update).toHaveBeenCalledTimes(2);
    link.dispose();
  });

  it('snapshot ile gelen otomatik seçim kamerayı uçurmaz', async () => {
    const { scene, ix } = fakes();
    const link = connectScene(scene, ix);
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    await tick();
    expect(useBoard.getState().selectedSessionId).not.toBeNull();
    expect(scene.select).toHaveBeenLastCalledWith(useBoard.getState().selectedSessionId);
    expect(ix.focusSession).not.toHaveBeenCalled();
    link.dispose();
  });

  it("haritadan seçim store'a yazılır ama ikinci uçuş başlamaz", async () => {
    const { scene, ix } = fakes();
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    const link = connectScene(scene, ix);
    link.selectFromMap(IDS.busy);
    await tick();
    expect(useBoard.getState().selectedSessionId).toBe(IDS.busy);
    expect(scene.select).toHaveBeenLastCalledWith(IDS.busy);
    expect(ix.focusSession).not.toHaveBeenCalled();
    link.selectFromMap(IDS.team, 'a1');
    expect(useBoard.getState().focusAgentId).toBe('a1');
    link.selectFromMap(IDS.busy);
    expect(useBoard.getState().focusAgentId).toBeNull();
    link.dispose();
  });

  it("başka panelden seçim kamerayı o session'a uçurur", async () => {
    const { scene, ix } = fakes();
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    const link = connectScene(scene, ix);
    useBoard.getState().select(IDS.idle);
    await tick();
    expect(ix.focusSession).toHaveBeenCalledWith(IDS.idle);
    link.dispose();
  });

  it('Bekleyene git: seçim + proje odağı aynı anda → session odağı kazanır', async () => {
    const { scene, ix } = fakes();
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    useBoard.getState().select(IDS.busy);
    const link = connectScene(scene, ix);
    useBoard.getState().goToNextWaiting();
    await tick();
    expect(ix.focusSession).toHaveBeenCalledTimes(1);
    expect(ix.focusProject).not.toHaveBeenCalled();
    link.dispose();
  });

  it('üst bar proje segmenti ve Tümü kamerayı projeye / eve götürür', async () => {
    const { scene, ix } = fakes();
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    const link = connectScene(scene, ix);
    useBoard.getState().setFocus('p2agents');
    await tick();
    expect(ix.focusProject).toHaveBeenLastCalledWith('p2agents');
    useBoard.getState().setFocus('all');
    await tick();
    expect(ix.focusProject).toHaveBeenLastCalledWith('all');
    link.dispose();
  });

  it('dispose sonrası abonelik kalmaz', async () => {
    const { scene, ix } = fakes();
    const link = connectScene(scene, ix);
    link.dispose();
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    useBoard.getState().select(IDS.idle);
    await tick();
    expect(scene.update).toHaveBeenCalledTimes(1);
    expect(ix.focusSession).not.toHaveBeenCalled();
  });
});

describe('firstSessionOfProject', () => {
  it('öncelik: bekleyen → çalışan → boşta', () => {
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    expect(firstSessionOfProject('p1demoapp')).toBe(IDS.waiting);
    expect(firstSessionOfProject('yok')).toBeNull();
  });
});

describe('MapView', () => {
  it('WebGL yoksa 2B listeye düşer, 3B düğmesi pasif', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<MapView />);
    expect(document.querySelector('.map2d')).not.toBeNull();
    expect((screen.getByRole('button', { name: '3B' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'liste' }).getAttribute('aria-pressed')).toBe('true');
    err.mockRestore();
  });
});
