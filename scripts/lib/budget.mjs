// @ts-check
// Performans bütçesi (05/02 Bölüm 10) ve bir PerfReport'un bütçeyle karşılaştırılması.
// Referans makine: MacBook Pro M3, 18 GB. Başka makinede eşikler bilgi amaçlıdır (bench.mjs --strict hariç).

/**
 * @typedef {'active' | 'idle' | 'big' | 'soak'} Scenario
 * @typedef {{
 *   key: string, label: string, limit: number, unit: string, cmp: '<' | '>=',
 *   info?: boolean,
 *   scenarios: Scenario[], modes: ('app'|'headless')[],
 *   value: (r: any) => number | null,
 * }} BudgetRule
 * @typedef {{ key: string, label: string, value: number | null, limit: number, unit: string, cmp: '<' | '>=', status: 'ok' | 'fail' | 'n/a' | 'info', note?: string }} BudgetRow
 */

/** @param {any} r @param {'visible'|'hidden'} name */
const phase = (r, name) => (r.phases ?? []).find((/** @type {any} */ p) => p.name === name) ?? null;
/** @param {number | null | undefined} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {any} s örnek (avg/p95) */
// Toplam yuvarlanır: 0.1 + 0.2 gibi toplamlar tabloda 0.30000000000000004 görünmesin.
const cpuTotal = (s) => (s ? Math.round((s.cpu.main + s.cpu.renderer + (s.cpu.gpu ?? 0)) * 10) / 10 : null);

/** @type {BudgetRule[]} */
export const BUDGET = [
  {
    key: 'idleCpuTotal',
    label: 'Boşta CPU (session yok, pencere görünür), toplam',
    limit: 1,
    unit: '%',
    cmp: '<',
    scenarios: ['idle'],
    modes: ['app', 'headless'],
    value: (r) => num(cpuTotal(phase(r, 'visible')?.avg)),
  },
  {
    key: 'mainCpuActive',
    label: '4 aktif session (replay ×5), main',
    limit: 5,
    unit: '%',
    cmp: '<',
    scenarios: ['active'],
    modes: ['app', 'headless'],
    value: (r) => num(phase(r, 'visible')?.avg.cpu.main),
  },
  {
    key: 'rendererCpuActive',
    label: '4 aktif session, renderer (3B dahil)',
    limit: 15,
    unit: '%',
    cmp: '<',
    scenarios: ['active'],
    modes: ['app'],
    value: (r) => num(phase(r, 'visible')?.avg.cpu.renderer),
  },
  {
    key: 'hiddenCpuTotal',
    label: 'Pencere gizli, 4 aktif session, toplam',
    limit: 1,
    unit: '%',
    cmp: '<',
    scenarios: ['active'],
    modes: ['app', 'headless'],
    value: (r) => num(cpuTotal(phase(r, 'hidden')?.avg)),
  },
  {
    // Bellek bütçesi phys_footprint ile (Etkinlik Monitörü'nün "Bellek" sütunu). RSS, Electron Framework'ün
    // paylaşılan sayfalarını her süreçte ayrı saydığı için gerçek maliyeti abartır (karar 2026-10-28).
    key: 'footprintTotal',
    label: 'Toplam bellek (phys_footprint, tüm süreçler), p95',
    limit: 350,
    unit: 'MB',
    cmp: '<',
    scenarios: ['active', 'idle', 'soak'],
    modes: ['app'],
    value: (r) => {
      const v = (r.phases ?? [])
        .map((/** @type {any} */ p) => p.p95.footprintMb)
        .filter((/** @type {unknown} */ x) => typeof x === 'number');
      return v.length ? Math.max(...v) : null;
    },
  },
  {
    key: 'rssTotal',
    label: 'Toplam RSS (main + renderer + GPU), p95 — bilgi',
    limit: 350,
    unit: 'MB',
    cmp: '<',
    info: true,
    scenarios: ['active', 'idle', 'soak'],
    modes: ['app'],
    value: (r) => {
      const v = (r.phases ?? []).map((/** @type {any} */ p) => p.p95.rssMb.total);
      return v.length ? Math.max(...v) : null;
    },
  },
  {
    key: 'engineRss',
    label: 'Motor RSS (başsız, p95) — bilgi',
    limit: 350,
    unit: 'MB',
    cmp: '<',
    scenarios: ['active', 'idle', 'big'],
    modes: ['headless'],
    value: (r) => {
      const v = (r.phases ?? []).map((/** @type {any} */ p) => p.p95.rssMb.total);
      return v.length ? Math.max(...v) : null;
    },
  },
  {
    key: 'firstSnapshotBig',
    label: 'İlk snapshot, büyük günlük transcript klasörü',
    limit: 1500,
    unit: 'ms',
    cmp: '<',
    scenarios: ['big'],
    modes: ['app', 'headless'],
    value: (r) => num(r.firstSnapshotMs),
  },
  {
    key: 'snapshotBytes',
    label: 'Snapshot boyutu (en büyük)',
    limit: 200 * 1024,
    unit: 'B',
    cmp: '<',
    scenarios: ['active', 'big', 'soak'],
    modes: ['app', 'headless'],
    value: (r) => num(r.maxSnapshotBytes),
  },
  {
    key: 'fpsActive',
    label: '3B harita, aktif modda (animasyon sürerken)',
    limit: 50,
    unit: 'fps',
    cmp: '>=',
    scenarios: ['active'],
    modes: ['app'],
    // Eski raporlarda yalnızca fpsAvg vardı.
    value: (r) => num(r.renderer?.fpsActive ?? r.renderer?.fpsAvg),
  },
  {
    key: 'fpsIdle',
    label: '3B harita, boşta (değişen bir şey yok)',
    limit: 5,
    unit: 'fps',
    cmp: '<',
    scenarios: ['idle', 'active'],
    modes: ['app'],
    value: (r) => num(r.renderer?.fpsIdle),
  },
  {
    // Geometri sayısının ilk → son değişimi sızıntı göstergesi değil: replay boyunca sahneye ajan ve dosya
    // eklenip çıkar. Ölçü, GPU'da olup sahnede/paylaşılan önbellekte olmayan (dispose edilmemiş) geometriler.
    key: 'geometryOrphans',
    label: 'Sahipsiz three geometrisi, son örnek (sızıntı)',
    limit: 3,
    unit: 'adet',
    cmp: '<',
    scenarios: ['active', 'soak'],
    modes: ['app'],
    value: (r) => num(r.renderer?.orphanGeometries),
  },
  {
    key: 'soakRssGrowth',
    label: '60 dk soak RSS artışı (ilk 5 dk → son 5 dk)',
    limit: 40,
    unit: 'MB',
    cmp: '<',
    scenarios: ['soak'],
    modes: ['app', 'headless'],
    value: (r) => {
      const t = r.rssTrend ?? [];
      if (t.length < 2) return null;
      return Math.round((t[t.length - 1][1] - t[0][1]) * 10) / 10;
    },
  },
];

/**
 * @param {any} report PerfReport (+ scenario)
 * @param {Scenario} scenario
 * @returns {BudgetRow[]}
 */
export function evaluate(report, scenario) {
  const mode = report.mode === 'headless' ? 'headless' : 'app';
  /** @type {BudgetRow[]} */
  const rows = [];
  for (const b of BUDGET) {
    if (!b.scenarios.includes(scenario) || !b.modes.includes(mode)) continue;
    const value = b.value(report);
    const pass = value !== null && (b.cmp === '<' ? value < b.limit : value >= b.limit);
    // Bilgi satırı (info) aşımda kırmızı olmaz ve exit kodunu etkilemez.
    const status = value === null ? 'n/a' : pass ? 'ok' : b.info ? 'info' : 'fail';
    /** @type {BudgetRow} */
    const row = { key: b.key, label: b.label, value, limit: b.limit, unit: b.unit, cmp: b.cmp, status };
    if (value === null) row.note = 'ölçülemedi';
    rows.push(row);
  }
  return rows;
}

/** Referans makine mi (Apple M3)? Değilse eşikler bilgi amaçlıdır. @param {{ cpuModel?: string }} machine */
export function isReferenceMachine(machine) {
  return /Apple M3/i.test(machine?.cpuModel ?? '');
}

/** @param {number | null} v @param {string} unit */
function fmt(v, unit) {
  if (v === null) return '—';
  if (unit === 'B') return `${Math.round(v / 1024)} KB`;
  return `${Number.isInteger(v) ? v : Math.round(v * 10) / 10} ${unit}`;
}

/**
 * Konsol tablosu. Renk yalnızca TTY'de.
 * @param {BudgetRow[]} rows
 * @param {{ color?: boolean }} [o]
 */
export function formatTable(rows, o = {}) {
  const color = o.color ?? false;
  const paint = (/** @type {string} */ s, /** @type {'ok'|'fail'|'n/a'|'info'} */ st) =>
    !color ? s : st === 'ok' ? `\x1b[32m${s}\x1b[0m` : st === 'fail' ? `\x1b[31m${s}\x1b[0m` : `\x1b[2m${s}\x1b[0m`;
  const w = Math.max(10, ...rows.map((r) => r.label.length));
  const lines = [`${'Metrik'.padEnd(w)}  ${'Değer'.padStart(10)}  ${'Hedef'.padStart(12)}  Durum`];
  for (const r of rows) {
    const mark =
      r.status === 'ok'
        ? '✓'
        : r.status === 'fail'
          ? '✗ AŞIM'
          : r.status === 'info'
            ? '· bilgi (sınır üstü)'
            : '· ölçülemedi';
    const target = `${r.cmp} ${fmt(r.limit, r.unit)}`;
    lines.push(
      paint(`${r.label.padEnd(w)}  ${fmt(r.value, r.unit).padStart(10)}  ${target.padStart(12)}  ${mark}`, r.status),
    );
  }
  return lines.join('\n');
}
