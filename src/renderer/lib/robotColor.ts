// Robot aksan rengi (03/08): beyaz kabuğun üstündeki yüz çerçevesi, göğüs paneli, önkol, diz ve taban.
// Alt ajanda takımına/tipine göre oyuncak tonlarında (aynı takım aynı renk), liderde projenin kimlik rengi. Haritada, isim etiketinde, hover
// kartında ve Workers kartlarında aynı renk küçük bir kare olarak görünür. Durum rengi gözde ve pedde kalır.
import type { AgentView } from '@shared/types';
import { hashString } from './agentChip';

/** Bilinen takımlar ve Claude Code ajan tipleri. */
export const SHELL: Readonly<Record<string, string>> = {
  audience: '#5EA8F0',
  pipeline: '#A884F0',
  ventures: '#F0A93C',
  Explore: '#3FC4A0',
  'general-purpose': '#F08A5A',
};
/** Bilinmeyen takım/tip/ad için kararlı havuz (beyaz kabukta okunan doygun oyuncak tonları). */
export const SHELL_POOL = ['#E879A8', '#8CCB5E', '#6E9CF2', '#F09A6E', '#9C86F2', '#45C8C0'] as const;

export function shellColor(
  a: Pick<AgentView, 'isMain' | 'team' | 'agentType' | 'name' | 'id'>,
  projectColor: string,
): string {
  if (a.isMain) return projectColor;
  const key = a.team || a.agentType;
  if (key && SHELL[key]) return SHELL[key]!;
  const seed = a.team || a.agentType || a.name || a.id;
  return SHELL_POOL[hashString(seed) % SHELL_POOL.length]!;
}
