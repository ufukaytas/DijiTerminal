// Ajan çipi rengi ve etiketi (03/02). Workers paneli (03/03) aynı görünümü kullanır.
import { PROJECT_PALETTE } from '@shared/constants';
import type { AgentView } from '@shared/types';

export interface AgentChip {
  label: string;
  bg: string;
  fg: string;
}

/** Kararlı, küçük bir string hash'i (FNV-1a). Aynı takım her zaman aynı rengi alır. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `#RRGGBB` + opaklık → `rgba(...)`. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const NEUTRAL: AgentChip = { label: '', bg: '#262C38', fg: '#AEB8CC' };

export function agentChip(a: AgentView): AgentChip {
  if (a.isMain) return { label: 'ANA', bg: '#262C38', fg: '#D7DDE8' };
  if (a.team) {
    const color = PROJECT_PALETTE[hashString(a.team) % PROJECT_PALETTE.length]!;
    return { label: a.team, bg: withAlpha(color, 0.22), fg: color };
  }
  if (a.agentType === 'Explore') return { label: 'Explore', bg: '#14304A', fg: '#9ED0FF' };
  if (a.agentType === 'general-purpose') return { label: 'general', bg: '#4A3220', fg: '#FFC79A' };
  return { ...NEUTRAL, label: a.agentType || 'ajan' };
}
