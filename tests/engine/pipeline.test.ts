// Uçtan uca: fixture üreteci (05/01) → TranscriptPool (02/02) → normalizeRecord (02/03).
// Üç parça ayrı yazıldı; bu test birbirlerinin formatını gerçekten anladıklarını doğrular.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudePaths } from '@main/engine/paths';
import { TranscriptPool, type RecordsBatch } from '@main/engine/transcript/pool';
import { normalizeRecord } from '@main/engine/normalize';
import { createNormalizerState, type EngineEvent } from '@main/engine/events';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');
const scenarios = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => {
    try {
      return JSON.parse(readFileSync(join(FIXTURES, name, 'manifest.json'), 'utf8')).name === name;
    } catch {
      return false;
    }
  });

let pool: TranscriptPool | null = null;
afterEach(async () => {
  await pool?.stop();
  pool = null;
});

async function run(name: string) {
  const paths = claudePaths({ configDir: join(FIXTURES, name, 'claude') });
  pool = new TranscriptPool(paths);
  const batches: RecordsBatch[] = [];
  pool.on('records', (b: RecordsBatch) => batches.push(b));
  await pool.boot(0, []); // dayStart 0: fixture zamanlarından bağımsız olarak her kaydı oku
  const state = createNormalizerState();
  const events: EngineEvent[] = [];
  for (const b of batches) {
    for (const rec of b.records) events.push(...normalizeRecord(rec, { sessionId: b.sessionId, agentId: b.agentId, state }));
  }
  return { batches, events, state };
}

describe('fixture → pool → normalizer', () => {
  it('en az 9 senaryo bulundu', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(9);
  });

  it.each(scenarios)('%s: kayıtlar olaylara dönüşüyor, araç başlangıç/bitişleri eşleşiyor', async (name) => {
    const { batches, events, state } = await run(name);
    expect(batches.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);

    const starts = new Set(events.filter((e) => e.type === 'tool-start').map((e) => e.toolUseId));
    const ends = events.filter((e) => e.type === 'tool-end');
    for (const e of ends) expect(starts.has(e.toolUseId), `${name}: ${e.toolUseId} için tool-start yok`).toBe(true);

    // Üreteç yalnızca normalizer'ın tanıdığı kayıt tiplerini yazmalı.
    expect(state.unknownTypes).toEqual({});
  });

  it('subagents-team: subagent kayıtları ajan kimliğiyle geliyor', async () => {
    const { batches, events } = await run('subagents-team');
    const agentIds = new Set(batches.map((b) => b.agentId).filter(Boolean));
    expect(agentIds.size).toBe(3);
    expect(events.some((e) => e.type === 'subagent-hint')).toBe(true);
  });

  it('fork-resume: kopyalanan geçmiş çift sayılmıyor, supersede yayınlanıyor', async () => {
    const paths = claudePaths({ configDir: join(FIXTURES, 'fork-resume', 'claude') });
    pool = new TranscriptPool(paths);
    const supersedes: { from: string; to: string }[] = [];
    pool.on('supersede', (s: { from: string; to: string }) => supersedes.push(s));
    const uuids: string[] = [];
    pool.on('records', (b: RecordsBatch) => {
      for (const r of b.records) if (typeof r['uuid'] === 'string') uuids.push(r['uuid']);
    });
    await pool.boot(0, []);
    expect(supersedes.length).toBe(1);
    expect(new Set(uuids).size).toBe(uuids.length);
  });
});
