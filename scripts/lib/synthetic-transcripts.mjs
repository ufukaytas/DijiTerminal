// @ts-check
// Sentetik transcript klasörü üreteci (02/02 bench-transcripts ve 05/02 bench --big ortak).
// Gerçek veri kullanılmaz: dolgu metni, progress kayıtları ve base64 görsel satırları.

import fs from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;

/** Yerel saatle bugünün başlangıcı. */
export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * @param {string} projects
 * @param {number} totalMb
 */
export function generate(projects, totalMb) {
  const dayStart = startOfToday();
  const pad = 'lorem ipsum dolor sit amet '.repeat(30);
  const img = 'iVBORw0KGgoAAAANSUhEUg'.repeat(9000); // ~200 KB
  let seq = 0;
  /** @param {string} sid @param {number} ts @param {number} kind */
  const line = (sid, ts, kind) => {
    const uuid = `00000000-0000-4000-8000-${(seq++).toString(16).padStart(12, '0')}`;
    const t = new Date(ts).toISOString();
    if (kind % 11 === 0)
      return `{"type":"progress","uuid":"${uuid}","sessionId":"${sid}","timestamp":"${t}","data":{"type":"hook_progress","note":"${pad}"}}\n`;
    if (kind % 97 === 0)
      return `{"type":"user","uuid":"${uuid}","sessionId":"${sid}","timestamp":"${t}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${img}"}}]}]}}\n`;
    if (kind % 2 === 0)
      return `{"type":"user","uuid":"${uuid}","sessionId":"${sid}","timestamp":"${t}","message":{"role":"user","content":"${pad}"}}\n`;
    return `{"type":"assistant","uuid":"${uuid}","sessionId":"${sid}","timestamp":"${t}","message":{"role":"assistant","model":"claude-demo","content":[{"type":"text","text":"${pad}"}],"usage":{"input_tokens":12,"output_tokens":34}}}\n`;
  };

  const bigCount = 4;
  const bigBytes = Math.floor((totalMb * MB * 0.7) / bigCount);
  const smallCount = 36;
  const smallBytes = Math.floor((totalMb * MB * 0.3) / smallCount);
  let written = 0;
  let files = 0;

  /** @param {string} file @param {string} sid @param {number} bytes @param {number} todayShare */
  const writeFile = (file, sid, bytes, todayShare) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'w');
    const oldBytes = Math.floor(bytes * (1 - todayShare));
    let n = 0;
    let buf = '';
    let ts = dayStart - 20 * 3600_000;
    for (let pos = 0; pos < bytes;) {
      if (pos >= oldBytes && ts < dayStart) ts = dayStart + 60_000;
      const l = line(sid, ts, n++);
      ts += 500;
      buf += l;
      pos += Buffer.byteLength(l);
      if (buf.length > 4 * MB) {
        fs.writeSync(fd, buf);
        buf = '';
      }
    }
    if (buf) fs.writeSync(fd, buf);
    fs.closeSync(fd);
    written += fs.statSync(file).size;
    files++;
  };

  for (let i = 0; i < bigCount; i++) {
    const enc = `-Users-bench-Projects-big-${i}`;
    const sid = `b1000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    writeFile(path.join(projects, enc, `${sid}.jsonl`), sid, bigBytes, 0.03);
  }
  for (let i = 0; i < smallCount; i++) {
    const enc = `-Users-bench-Projects-app-${i % 6}`;
    const sid = `51000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    const file =
      i % 3 === 0
        ? path.join(projects, enc, sid, 'subagents', `agent-${i.toString(16)}.jsonl`)
        : path.join(projects, enc, `${sid}.jsonl`);
    writeFile(file, sid, smallBytes, 1);
  }
  return { dayStart, written, files };
}
