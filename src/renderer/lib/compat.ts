// Uyumluluk rozeti ve paneli (09/01). Saf fonksiyonlar: görünürlük ("Bu oturumda gizle") ve metinler.
import { maxLevel, SIGNAL_LABELS, type CompatLevel, type CompatReport, type CompatSignal, type CompatSignalId } from '@shared/compat';

export interface CompatView {
  level: Exclude<CompatLevel, 'ok'>;
  signals: CompatSignal[];
  /** Panelde kısa açıklama (brif §7). */
  summary: string;
  versionLine: string;
}

/**
 * Rozet görünür mü: seviye ok değil ve gizlenmemiş en az bir sinyal var.
 * "Bu oturumda gizle" sinyal kimliklerini gizler; yeni bir sinyal türü gelince rozet yeniden çıkar.
 */
export function compatView(report: CompatReport | undefined, hidden: ReadonlySet<CompatSignalId>): CompatView | null {
  if (!report || report.level === 'ok') return null;
  const visible = report.signals.filter((s) => !hidden.has(s.id));
  if (visible.length === 0) return null;
  const level = visible.reduce<CompatLevel>((l, s) => maxLevel(l, s.level), 'ok');
  if (level === 'ok') return null;
  return { level, signals: report.signals, summary: summaryOf(report), versionLine: versionLine(report) };
}

export function versionLine(r: CompatReport): string {
  const v = r.claudeVersion ? `Claude Code ${r.claudeVersion}` : 'Claude Code sürümü bilinmiyor';
  const tested = `test edilen aralık ${r.testedMin}–${r.testedMax}`;
  return r.untestedVersion ? `${v} · ${tested} (bu sürüm henüz test edilmedi)` : `${v} · ${tested}`;
}

export function summaryOf(r: CompatReport): string {
  if (r.signals.some((s) => s.id === 'processWithoutSession')) return emptyMapWarning(r.claudeVersion);
  return 'Claude Code’un dosya biçiminde tanınmayan değişiklikler görüldü. Harita çalışıyor ama bazı bilgiler eksik olabilir.';
}

/** Boş harita + çelişki sinyali (brif §7 #3). */
export function emptyMapWarning(version: string | null): string {
  const v = version ? `Claude Code ${version}` : 'kurulu Claude Code sürümü';
  return `Claude Code çalışıyor ama session dosyaları okunamıyor. Bu büyük olasılıkla ${v} ile uyumsuzluk.`;
}

export const signalLabel = (id: CompatSignalId): string => SIGNAL_LABELS[id];

/** Ayrıntı satırı: en sık 5 anahtar, `foo-bar ×120, …`. */
export function detailLine(s: CompatSignal): string {
  const items = Object.entries(s.detail).sort((a, b) => b[1] - a[1]);
  const head = items.slice(0, 5).map(([k, n]) => `${k} ×${n}`);
  return items.length > 5 ? `${head.join(', ')}, …` : head.join(', ');
}
