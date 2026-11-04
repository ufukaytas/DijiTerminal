// Artımlı jsonl okuyucu
// Yalnızca yeni eklenen byte'ları okur; yarım satırı bir sonraki okumaya bırakır.
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudePaths } from '../paths';
import { shouldSkip, stripLargeData } from './prefilter';
import { seekToTime } from './seek';

/** JSON.parse çıktısı; yorumu 02/03'te. */
export type RawRecord = Record<string, unknown>;

const CHUNK = 4 * 1024 * 1024;
const BIG_FILE = 8 * 1024 * 1024;
const SEEK_MARGIN_MS = 10 * 60_000;
const MAX_REST = 64 * 1024 * 1024;
const NL = 0x0a;

export class TranscriptCursor {
  readonly path: string;
  readonly sessionId: string;
  readonly agentId: string | null;
  offset = 0;
  lastRecordTs = 0;
  /** İzleme: toplam okunan byte, bozuk satır sayısı. */
  bytesRead = 0;
  parseErrors = 0;
  private rest: Buffer = Buffer.alloc(0);
  private started = false;
  private skipFirstLine = false;

  constructor(filePath: string, sessionId: string, agentId: string | null) {
    this.path = filePath;
    this.sessionId = sessionId;
    this.agentId = agentId;
  }

  /**
   * projects/ altındaki göreli yola göre kimlik:
   *  - `<enc>/<sid>.jsonl` → ana session
   *  - `<enc>/<sid>/…/agent-<id>.jsonl` → subagent (ara klasör derinliği sürüme göre değişebilir)
   */
  static fromPath(filePath: string, paths: ClaudePaths): TranscriptCursor | null {
    if (!filePath.endsWith('.jsonl')) return null;
    const rel = path.relative(paths.projects, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep).filter(Boolean);
    const base = path.basename(filePath, '.jsonl');
    if (parts.length === 2) return new TranscriptCursor(filePath, base, null);
    if (parts.length >= 3 && parts[1]) {
      const agentId = base.startsWith('agent-') ? base.slice('agent-'.length) : base;
      return new TranscriptCursor(filePath, parts[1], agentId);
    }
    return null;
  }

  /**
   * Son okumadan bu yana eklenen tam satırları ayrıştırıp döner. `onChunk` verilirse kayıtlar her okuma
   * parçasından (4 MB) sonra ona teslim edilir ve dönüş boş olur: büyük bir günün tamamı aynı anda
   * bellekte ayrıştırılmış nesne olarak tutulmaz (05/02, main bellek tepesi).
   */
  async pump(opts: { dayStart: number }, onChunk?: (records: RawRecord[]) => void): Promise<RawRecord[]> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(this.path);
    } catch {
      return [];
    }
    const size = st.size;
    if (size < this.offset) {
      // Dosya yeniden yazıldı ya da kısaldı: baştan oku (uuid dedupe çift saymayı önler).
      this.offset = 0;
      this.rest = Buffer.alloc(0);
      this.skipFirstLine = false;
    }
    if (!this.started) {
      this.started = true;
      if (size > BIG_FILE) {
        this.offset = await seekToTime(this.path, size, opts.dayStart - SEEK_MARGIN_MS);
        this.skipFirstLine = this.offset > 0;
      }
    }
    if (size <= this.offset) return [];

    const out: RawRecord[] = [];
    const fh = await fs.promises.open(this.path, 'r');
    try {
      let pos = this.offset;
      // Tek okuma tamponu: satırlar string'e, artık (rest) kopyaya çevrildiği için her tur yeniden kullanılabilir.
      // 500 MB'lık açılışta 4 MB'lık onlarca ayrı ayırma yerine tek ayırma (05/02, main RSS).
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
      while (pos < size) {
        const want = Math.min(buf.length, size - pos);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        this.bytesRead += bytesRead;
        let data = this.rest.length ? Buffer.concat([this.rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        this.rest = Buffer.alloc(0);

        if (this.skipFirstLine) {
          const nl = data.indexOf(NL);
          if (nl === -1) continue; // satır sonu henüz yok; bu veri atlanacak satırın parçası
          data = data.subarray(nl + 1);
          this.skipFirstLine = false;
        }
        const lastNl = data.lastIndexOf(NL);
        if (lastNl === -1) {
          this.keepRest(data);
          continue;
        }
        this.keepRest(data.subarray(lastNl + 1));
        let start = 0;
        while (start < lastNl) {
          let nl = data.indexOf(NL, start);
          if (nl === -1 || nl > lastNl) nl = lastNl;
          if (nl > start) this.parseLine(data.subarray(start, nl), out);
          start = nl + 1;
        }
        if (onChunk && out.length) {
          this.offset = pos; // teslim edilen kayıtlar okunmuş sayılır (dinleyici hata atarsa yeniden okunmasın)
          onChunk(out.splice(0));
        }
      }
      this.offset = pos;
    } finally {
      await fh.close();
    }
    return out;
  }

  private keepRest(b: Buffer): void {
    if (b.length > MAX_REST) {
      // Beklenmeyen dev satır: bellek tavanı. Satır atlanır.
      console.warn(`[transcript] ${path.basename(this.path)}: 64 MB'ı aşan satır atlandı`);
      this.rest = Buffer.alloc(0);
      this.skipFirstLine = true;
      return;
    }
    this.rest = Buffer.from(b); // kopya: chunk buffer'ı yeniden kullanılmaz ama alt-dilim tüm chunk'ı tutmasın
  }

  private parseLine(line: Buffer, out: RawRecord[]): void {
    if (line.length === 0 || shouldSkip(line)) return;
    let rec: unknown;
    try {
      rec = JSON.parse(stripLargeData(line).toString('utf8'));
    } catch {
      this.parseErrors++;
      return;
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) return;
    const r = rec as RawRecord;
    const ts = typeof r['timestamp'] === 'string' ? Date.parse(r['timestamp']) : NaN;
    if (Number.isFinite(ts) && ts > this.lastRecordTs) this.lastRecordTs = ts;
    out.push(r);
  }
}
