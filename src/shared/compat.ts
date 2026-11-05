// Claude Code format uyumluluğu (09/01): sabitler, rapor tipleri ve yalnızca şema içeren Markdown rapor.
// Saf TS; main ve renderer ortak kullanır. Raporda değer, yol, prompt ya da kimlik bulunmaz.

/**
 * Test edilen Claude Code sürüm aralığı. `npm run compat:snapshot` farkı yazdırır; değer elle güncellenir.
 * testedMin: gerçek veriyle doğrulanan en eski sürüm (2.1.288–2.1.318 arası tüm yerel transcript'ler normalizer'dan
 * tanınmayan tip ve eksik alan olmadan geçti). 2.1.139 registry'yi aynı zorunlu alanlarla yazıyor ama denenmedi.
 */
export const COMPAT = { testedMin: '2.1.288', testedMax: '2.1.318' } as const;

export const COMPAT_ISSUE_BASE = 'https://github.com/ufukaytas/DijiTerminal/issues/new';
export const ISSUE_URL_MAX = 6000;

export type CompatLevel = 'ok' | 'warn' | 'error';

export type CompatSignalId =
  | 'unknownRecordTypes'
  | 'unknownRecordKeys'
  | 'registryParseErrors'
  | 'unknownRegistryStatus'
  | 'processWithoutSession'
  | 'hookBadLines'
  | 'statusLineUnparsed';

export interface CompatSignal {
  id: CompatSignalId;
  level: CompatLevel;
  count: number;
  /** Yalnızca şema bilgisi: tip adı → sayı, eksik anahtar adları vb. Değer yok. */
  detail: Record<string, number>;
}

export interface CompatReport {
  level: CompatLevel;
  claudeVersion: string | null;
  testedMin: string;
  testedMax: string;
  untestedVersion: boolean;
  /** Yalnızca eşiği aşan (level ≠ ok) sinyaller. */
  signals: CompatSignal[];
  /** Pencere başlangıcı (ms). */
  since: number;
  /** Raporun üretildiği an (ms). */
  at: number;
  /** Pencere içinde işlenen transcript kaydı (oran paydası). */
  records: number;
  /** Tanınmayan kayıt tipi → anahtar adı → tip ('string|null'). Değer yok. */
  unknownShapes?: Record<string, Record<string, string>>;
}

export interface CompatEnv {
  appVersion: string;
  osVersion: string;
}

const LEVEL_RANK: Record<CompatLevel, number> = { ok: 0, warn: 1, error: 2 };

export function maxLevel(a: CompatLevel, b: CompatLevel): CompatLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** '2.1.318' karşılaştırması; sayı olmayan parçalar 0. a<b → negatif. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Sürüm dizesi güvenli mi (rapora yalnızca biçimi tutan sürüm girer). */
export function safeVersion(v: string | null): string | null {
  return v && /^\d+(\.\d+){1,3}([-+][0-9A-Za-z.]{1,20})?$/.test(v) ? v : null;
}

export const SIGNAL_LABELS: Record<CompatSignalId, string> = {
  unknownRecordTypes: 'Tanınmayan transcript kayıt tipleri',
  unknownRecordKeys: 'Transcript kayıtlarında beklenen alan eksik',
  registryParseErrors: 'Session dosyaları okunamadı',
  unknownRegistryStatus: 'Bilinmeyen session durumu',
  processWithoutSession: 'Claude Code çalışıyor ama session dosyası yok',
  hookBadLines: 'Geçersiz hook olay satırları',
  statusLineUnparsed: 'statusLine verisi çözümlenemedi',
};

/** Dizeyi Markdown tablo hücresine güvenli koy (yalnız şema adları zaten; yine de | ve ` kaçırılır). */
const cell = (s: string): string => s.replace(/[|`\n\r]/g, ' ').slice(0, 80);

/** Yalnızca şema bilgisi içeren Markdown rapor. */
export function buildCompatMarkdown(report: CompatReport, env: CompatEnv): string {
  const lines: string[] = [];
  const ver = safeVersion(report.claudeVersion) ?? 'bilinmiyor';
  lines.push('## DijiTerminal uyumluluk raporu', '');
  lines.push(`- DijiTerminal: ${cell(env.appVersion)}`);
  lines.push(`- macOS: ${cell(env.osVersion)}`);
  lines.push(`- Claude Code: ${ver}${report.untestedVersion ? ' (test edilmemiş sürüm)' : ''}`);
  lines.push(`- Test edilen aralık: ${report.testedMin}–${report.testedMax}`);
  lines.push(`- Seviye: ${report.level}`);
  lines.push(`- Pencere: son ${Math.max(1, Math.round((report.at - report.since) / 60_000))} dk, ${report.records} transcript kaydı`);
  lines.push('');
  if (report.signals.length === 0) {
    lines.push('Eşiği aşan sinyal yok.');
  } else {
    lines.push('| Sinyal | Seviye | Sayı | Ayrıntı |', '|---|---|---|---|');
    for (const s of report.signals) {
      const detail = Object.entries(s.detail)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, n]) => `\`${cell(k)}\` ×${n}`)
        .join(', ');
      lines.push(`| ${s.id} | ${s.level} | ${s.count} | ${detail || '—'} |`);
    }
  }
  const shapes = Object.entries(report.unknownShapes ?? {});
  if (shapes.length) {
    lines.push('', '### Tanınmayan kayıt tiplerinin şeması (yalnızca anahtar adları ve tipler)');
    for (const [type, keys] of shapes) {
      lines.push('', `**${cell(type)}**`, '');
      for (const [k, t] of Object.entries(keys)) lines.push(`- \`${cell(k)}\`: ${cell(t)}`);
    }
  }
  lines.push('', '_Rapor yalnızca şema bilgisi içerir: değer, dosya yolu, prompt ya da kimlik yoktur._');
  return lines.join('\n');
}

/** Önceden doldurulmuş issue URL'i; ISSUE_URL_MAX aşılırsa gövde kısaltılır ve "Tam rapor panoda" notu eklenir. */
export function buildIssueUrl(report: CompatReport, env: CompatEnv, markdown = buildCompatMarkdown(report, env)): { url: string; truncated: boolean } {
  const ver = safeVersion(report.claudeVersion) ?? 'bilinmiyor';
  const title = `Uyumluluk: Claude Code ${ver}`;
  // Issue formu (.github/ISSUE_TEMPLATE/compat.yml) `body`'yi yok sayar; alanlar kimlikleriyle doldurulur.
  const head =
    `${COMPAT_ISSUE_BASE}?template=compat.yml&title=${encodeURIComponent(title)}` +
    `&claude-version=${encodeURIComponent(ver)}&app-version=${encodeURIComponent(env.appVersion.slice(0, 40))}`;
  const make = (body: string): string => `${head}&report=${encodeURIComponent(body)}`;
  let url = make(markdown);
  if (url.length <= ISSUE_URL_MAX) return { url, truncated: false };
  const note = '\n\n… (kısaltıldı — tam rapor panoda, lütfen buraya yapıştırın)';
  const rows = markdown.split('\n');
  while (rows.length > 1) {
    rows.pop();
    url = make(rows.join('\n') + note);
    if (url.length <= ISSUE_URL_MAX) return { url, truncated: true };
  }
  return { url: make(note.trim()), truncated: true };
}
