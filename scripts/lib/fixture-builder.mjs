// @ts-check
// FixtureBuilder — Claude Code'un kendi dosya düzeninde sentetik fixture üretir (05/01).
//
// Üretilen klasör:
//   <out>/manifest.json   ad, açıklama, now, beklenen sonuçlar (Sprint 2 motor testi okur)
//   <out>/claude/         CLAUDE_CONFIG_DIR olarak kullanılacak "oynatma bitmiş" son hal
//   <out>/timeline.json   replay için sıralı işlemler: { at, op: 'write'|'append'|'delete', path, json?|line? }
//   <out>/repos/          (opsiyonel) sahte proje kökleri, ör. .claude/agents/*.md
//
// Tüm yollar /Users/demo altında, tüm metinler kısa ve sentetik; check-fixtures bunları tarar.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CLAUDE_VERSION = '2.1.0';

/** ASCII harf/rakam dışındaki her karakter '-' olur (02/01 encodeCwd ile aynı kural). @param {string} cwd */
export function encodeCwd(cwd) {
  let out = '';
  for (const ch of cwd) out += /[A-Za-z0-9]/.test(ch) ? ch : '-';
  return out;
}

/** Deterministik UUID v4 biçimi. @param {string} seed */
export function seededUuid(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  const v = (8 + (parseInt(h[16] ?? '0', 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** @param {string} seed @param {string} prefix @param {number} [len] */
export function seededId(seed, prefix, len = 24) {
  const h = crypto.createHash('sha1').update(seed).digest('base64url').replace(/[-_]/g, 'x');
  return prefix + h.slice(0, len);
}

/** @typedef {{ at: number, op: 'write', path: string, json: unknown } | { at: number, op: 'append', path: string, line: unknown } | { at: number, op: 'delete', path: string }} TimelineOp */

export const DEFAULT_USAGE = Object.freeze({
  input_tokens: 4,
  cache_creation_input_tokens: 1200,
  cache_read_input_tokens: 18000,
  output_tokens: 150,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1200 },
  service_tier: 'standard',
});

export class FixtureBuilder {
  /**
   * @param {{ name: string, description: string, now: string, windowMs?: number }} o
   *  now: manifest'teki "şimdi" (ISO). t=0 anı now - windowMs (varsayılan 20 dk).
   */
  constructor(o) {
    this.name = o.name;
    this.description = o.description;
    this.now = o.now;
    this.nowMs = Date.parse(o.now);
    if (!Number.isFinite(this.nowMs)) throw new Error(`Geçersiz now: ${o.now}`);
    this.startMs = this.nowMs - (o.windowMs ?? 20 * 60_000);
    this.t = 0;
    this.seq = 0;
    /** @type {TimelineOp[]} */
    this.ops = [];
    /** @type {Record<string, string>} */
    this.repoFiles = {};
    /** @type {Record<string, unknown>} */
    this.expectations = { sessions: 0 };
    /** @type {Record<string, unknown>} */
    this.extraManifest = {};
    /** @type {Map<string, string>} dosya → son uuid (parentUuid zinciri) */
    this.lastUuid = new Map();
  }

  /** Zamanı t=0'dan itibaren ms olarak ayarla. @param {number} ms */
  at(ms) {
    if (ms < this.t) throw new Error(`Zaman geri gidemez: ${ms} < ${this.t}`);
    this.t = ms;
    return this;
  }

  /** @param {number} ms */
  advance(ms) {
    return this.at(this.t + ms);
  }

  get clockMs() {
    return this.startMs + this.t;
  }

  iso() {
    return new Date(this.clockMs).toISOString();
  }

  /** @param {string} kind */
  nextUuid(kind = 'rec') {
    this.seq += 1;
    return seededUuid(`${this.name}:${kind}:${this.seq}`);
  }

  /** @param {string} prefix @param {string} kind */
  nextId(prefix, kind) {
    this.seq += 1;
    return seededId(`${this.name}:${kind}:${this.seq}`, prefix);
  }

  /** @param {string} rel @param {unknown} json */
  writeJson(rel, json) {
    this.ops.push({ at: this.t, op: 'write', path: rel, json: structuredClone(json) });
  }

  /** @param {string} rel @param {Record<string, unknown>} line */
  append(rel, line) {
    this.ops.push({ at: this.t, op: 'append', path: rel, line });
    if (typeof line.uuid === 'string') this.lastUuid.set(rel, line.uuid);
  }

  /** @param {string} rel */
  delete(rel) {
    this.ops.push({ at: this.t, op: 'delete', path: rel });
  }

  /** Sahte proje dosyası (repos/<rel>). @param {string} rel @param {string} content */
  repoFile(rel, content) {
    this.repoFiles[rel] = content;
  }

  /** @param {Record<string, unknown>} e */
  expect(e) {
    Object.assign(this.expectations, e);
    return this;
  }

  /**
   * @param {{ pid: number, cwd: string, sessionId?: string, name?: string | null, branch?: string,
   *   model?: string, status?: 'busy'|'idle'|'waiting'|'shell', waitingFor?: string | null, entrypoint?: string,
   *   register?: boolean }} o
   */
  session(o) {
    return new SessionWriter(this, o);
  }

  /** @param {string} outDir @param {{ force?: boolean }} [opts] */
  build(outDir, opts = {}) {
    if (fs.existsSync(outDir)) {
      if (!opts.force) throw new Error(`Fixture zaten var: ${outDir} (üzerine yazmak için --force)`);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    const claude = path.join(outDir, 'claude');
    fs.mkdirSync(claude, { recursive: true });

    // "Oynatma bitmiş" son hali bellekte kur, sonra yaz.
    /** @type {Map<string, string[] | unknown>} */
    const files = new Map();
    const ordered = [...this.ops].sort((a, b) => a.at - b.at);
    for (const op of ordered) {
      if (op.op === 'write') files.set(op.path, { __json: op.json });
      else if (op.op === 'delete') files.delete(op.path);
      else {
        const cur = files.get(op.path);
        const lines = Array.isArray(cur) ? cur : [];
        lines.push(JSON.stringify(op.line));
        files.set(op.path, lines);
      }
    }
    for (const [rel, content] of files) {
      const abs = path.join(claude, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (Array.isArray(content)) fs.writeFileSync(abs, content.join('\n') + '\n');
      else fs.writeFileSync(abs, JSON.stringify(/** @type {{__json: unknown}} */ (content).__json, null, 2) + '\n');
    }
    for (const [rel, content] of Object.entries(this.repoFiles)) {
      const abs = path.join(outDir, 'repos', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(ordered) + '\n');
    const manifest = {
      name: this.name,
      description: this.description,
      source: 'synthetic',
      now: this.now,
      pidAliveOverride: true,
      ...this.extraManifest,
      expect: this.expectations,
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { files: files.size, ops: ordered.length };
  }
}

/** Bir session'ın (ya da subagent'ın) transcript ve registry kayıtlarını yazar. */
export class SessionWriter {
  /**
   * @param {FixtureBuilder} b
   * @param {{ pid: number, cwd: string, sessionId?: string, name?: string | null, branch?: string, model?: string,
   *   status?: 'busy'|'idle'|'waiting'|'shell', waitingFor?: string | null, entrypoint?: string, register?: boolean }} o
   * @param {{ parent: SessionWriter, agentId: string }} [sub]
   */
  constructor(b, o, sub) {
    this.b = b;
    this.pid = o.pid;
    this.cwd = o.cwd;
    this.sessionId = sub ? sub.parent.sessionId : (o.sessionId ?? b.nextUuid('session'));
    this.branch = o.branch ?? 'main';
    this.model = o.model ?? 'claude-opus-5-5';
    this.agentId = sub ? sub.agentId : null;
    this.parent = sub ? sub.parent : null;
    const enc = encodeCwd(this.cwd);
    this.file = sub
      ? `projects/${enc}/${this.sessionId}/agent-${sub.agentId}.jsonl`
      : `projects/${enc}/${this.sessionId}.jsonl`;
    this.registryFile = `sessions/${this.pid}.json`;
    /** @type {Record<string, unknown>} */
    this.reg = {
      pid: this.pid,
      sessionId: this.sessionId,
      cwd: this.cwd,
      name: o.name ?? null,
      kind: 'interactive',
      entrypoint: o.entrypoint ?? 'cli',
      status: o.status ?? 'idle',
      waitingFor: o.waitingFor ?? null,
      startedAt: b.clockMs,
      updatedAt: b.clockMs,
      statusUpdatedAt: b.clockMs,
    };
    if (!sub && o.register !== false) b.writeJson(this.registryFile, this.reg);
  }

  /** Registry dosyasını güncelle (durum değişimi vb.). @param {Record<string, unknown>} patch */
  registry(patch) {
    const statusChanged = 'status' in patch && patch.status !== this.reg.status;
    Object.assign(this.reg, patch, { updatedAt: this.b.clockMs });
    if (statusChanged) this.reg.statusUpdatedAt = this.b.clockMs;
    this.b.writeJson(this.registryFile, this.reg);
    return this;
  }

  /** Süreç bitti: registry dosyası silinir. */
  exit() {
    this.b.delete(this.registryFile);
    return this;
  }

  /** @param {Record<string, unknown>} rest */
  base(rest) {
    const uuid = /** @type {string} */ (rest.uuid ?? this.b.nextUuid('rec'));
    return {
      parentUuid: this.b.lastUuid.get(this.file) ?? null,
      isSidechain: this.agentId !== null,
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: this.branch,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...rest,
      uuid,
      timestamp: this.b.iso(),
    };
  }

  /** Kullanıcı prompt'u. @param {string} text */
  user(text) {
    const rec = this.base({ type: 'user', message: { role: 'user', content: text } });
    this.b.append(this.file, rec);
    return rec.uuid;
  }

  /** Meta kullanıcı kaydı (slash komutu vb.). @param {string} text @param {boolean} [isMeta] */
  userRaw(text, isMeta = false) {
    const rec = this.base({ type: 'user', ...(isMeta ? { isMeta: true } : {}), message: { role: 'user', content: text } });
    this.b.append(this.file, rec);
    return rec.uuid;
  }

  /**
   * Asistan mesajı. Gerçek Claude Code gibi her content bloğu ayrı satıra, aynı message.id ve usage ile yazılır.
   * @param {{ text?: string, thinking?: boolean, tools?: { name: string, input: Record<string, unknown>, id?: string }[],
   *   model?: string, stop?: string | null, usage?: Record<string, unknown>, apiError?: boolean }} o
   * @returns {{ msgId: string, toolUseIds: string[] }}
   */
  assistant(o) {
    const msgId = this.b.nextId('msg_', 'msg');
    const model = o.apiError ? '<synthetic>' : (o.model ?? this.model);
    /** @type {Record<string, unknown>[]} */
    const blocks = [];
    if (o.thinking) blocks.push({ type: 'thinking', thinking: '▒▒▒▒', signature: 'sig' });
    if (o.text) blocks.push({ type: 'text', text: o.text });
    const toolUseIds = [];
    for (const t of o.tools ?? []) {
      const id = t.id ?? this.b.nextId('toolu_', 'tool');
      toolUseIds.push(id);
      blocks.push({ type: 'tool_use', id, name: t.name, input: t.input });
    }
    const stop = o.stop !== undefined ? o.stop : (toolUseIds.length ? 'tool_use' : 'end_turn');
    const requestId = this.b.nextId('req_', 'req');
    blocks.forEach((block, i) => {
      const last = i === blocks.length - 1;
      const rec = this.base({
        type: 'assistant',
        requestId,
        ...(o.apiError ? { isApiErrorMessage: true } : {}),
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [block],
          stop_reason: last ? stop : null,
          stop_sequence: null,
          usage: o.apiError ? { input_tokens: 0, output_tokens: 0 } : (o.usage ?? DEFAULT_USAGE),
        },
      });
      this.b.append(this.file, rec);
    });
    return { msgId, toolUseIds };
  }

  /**
   * Araç sonucu (user kaydı içinde tool_result bloğu).
   * @param {string} toolUseId
   * @param {{ ok?: boolean, content?: unknown, toolUseResult?: unknown }} [o]
   */
  toolResult(toolUseId, o = {}) {
    const rec = this.base({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: o.content ?? 'ok', is_error: o.ok === false }],
      },
      ...(o.toolUseResult !== undefined ? { toolUseResult: o.toolUseResult } : {}),
    });
    this.b.append(this.file, rec);
    return rec.uuid;
  }

  /** @param {string} subtype @param {Record<string, unknown>} [extra] */
  system(subtype, extra = {}) {
    const rec = this.base({ type: 'system', subtype, ...extra });
    this.b.append(this.file, rec);
    return rec.uuid;
  }

  /** @param {number} durationMs */
  turn(durationMs) {
    return this.system('turn_duration', { durationMs, isMeta: false });
  }

  /** @param {string} title */
  aiTitle(title) {
    this.b.append(this.file, { type: 'ai-title', aiTitle: title, sessionId: this.sessionId });
  }

  /** @param {string} prompt */
  lastPrompt(prompt) {
    this.b.append(this.file, { type: 'last-prompt', lastPrompt: prompt, sessionId: this.sessionId });
  }

  /** Atlanacak tipte gürültü kaydı (prefilter testi). */
  noise() {
    this.b.append(this.file, { type: 'file-history-snapshot', messageId: this.b.nextUuid('fh'), snapshot: { trackedFileBackups: {} } });
  }

  /**
   * Başka bir session'ın kayıtlarını aynı uuid'lerle kopyala (resume/fork davranışı).
   * @param {SessionWriter} other @param {number} [limit]
   */
  copyHistoryFrom(other, limit = Infinity) {
    const recs = this.b.ops.filter((op) => op.op === 'append' && op.path === other.file).slice(0, limit);
    for (const op of recs) {
      const line = /** @type {Record<string, unknown>} */ (op.op === 'append' ? op.line : {});
      if (typeof line.uuid !== 'string') continue;
      this.b.append(this.file, { ...line, sessionId: this.sessionId });
    }
  }

  /**
   * Subagent: ana transcript'e Agent tool_use yazar, subagent dosyasını ve .meta.json'u oluşturur.
   * @param {{ agentId: string, agentType: string, description: string, model?: string, background?: boolean }} o
   */
  spawnSubagent(o) {
    const { toolUseIds } = this.assistant({
      tools: [{
        name: 'Agent',
        input: { description: o.description, prompt: '▒▒▒▒', subagent_type: o.agentType, ...(o.background ? { run_in_background: true } : {}) },
      }],
    });
    const toolUseId = /** @type {string} */ (toolUseIds[0]);
    this.b.advance(400);
    const sub = new SessionWriter(this.b, { pid: this.pid, cwd: this.cwd, branch: this.branch, model: o.model && o.model !== 'inherit' ? o.model : this.model }, { parent: this, agentId: o.agentId });
    const enc = encodeCwd(this.cwd);
    this.b.writeJson(`projects/${enc}/${this.sessionId}/agent-${o.agentId}.meta.json`, {
      description: o.description,
      agentType: o.agentType,
      model: o.model ?? 'inherit',
      requestShape: o.background ? 'background' : 'foreground',
    });
    sub.user('▒▒▒▒');
    return { sub, toolUseId };
  }

  /**
   * Subagent bitti: ana transcript'e tool_result yazar.
   * @param {string} toolUseId @param {{ agentId: string, description: string, ok?: boolean, resolvedModel?: string }} o
   */
  finishSubagent(toolUseId, o) {
    return this.toolResult(toolUseId, {
      ok: o.ok !== false,
      content: [{ type: 'text', text: 'tamam' }],
      toolUseResult: {
        status: o.ok === false ? 'failed' : 'completed',
        agentId: o.agentId,
        description: o.description,
        totalDurationMs: 42_000,
        totalToolUseCount: 6,
        ...(o.resolvedModel ? { resolvedModel: o.resolvedModel } : {}),
      },
    });
  }
}
