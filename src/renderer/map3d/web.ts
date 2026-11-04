// Web küresi (03/06'daki düz web halkasının yerini aldı): bütün projelerin uzandığı noktalı dünya, panonun web
// yeşilinde. Karalar yoğun parlak noktalar (Natural Earth 110m, landMask), okyanus seyrek sönük örgü, fresnel kenar
// parıltısı ve yüzeyin biraz üstünde süzülen bir ağ (düğümler + en yakın komşulara çizgiler). Her süren web çağrısı
// (WebSearch / WebFetch) yörüngede bir uydu olarak döner ve yanında sorgu ya da alan adı taşır (etiket rengi
// çağıran ajanın aksan rengi). Çağrı bitince uydu ~6 sn sönük dolaşır, sonra kaybolur. İstek küreye varınca
// yüzeyde dalga yayılır. Altında tıklanabilir "WEB · N istek/dk · M açık" rozeti.
import * as THREE from 'three';
import type { BoardSnapshot, ToolCall } from '@shared/types';
import { hashString } from '../lib/agentChip';
import { shellColor } from '../lib/robotColor';
import type { SceneEnv } from './env';
import { disposeTree, geo, geoKeyed, glowSprite, WEB_ORBITS, WEB_R } from './geometries';
import { isLand } from './landMask';
import { el, labelObject, type CSS2DObject } from './labels';
import type { RenderQuality } from './quality';
import { DEMAND_ACTIVE, DEMAND_AMBIENT, DEMAND_NONE, type Demand } from './renderLoop';

export const WEB_CENTER = new THREE.Vector3(0, 12.2, -0.6);
const LINGER_S = 6;
const FADE_PER_S = 1.2;
const PING_S = 1.4;
const MAX_PINGS = 8;
/** Aynı anda en fazla bu kadar uydu çizilir; rozet yine tüm açık istekleri sayar. */
export const MAX_SATS = 12;
const LABEL_MAX = 28;
/** Fibonacci küresindeki aday nokta sayısı: Yüksek kalitede 14 bin, Dengeli'de yarısı (okyanusun 2/3'ü atlanır). */
export const WEB_N = 14000;
export const webPointCount = (q: RenderQuality): number => (q === 'balanced' ? WEB_N / 2 : WEB_N);
const WEB_GREEN = 0x4cc38a;
const SAT_LIVE = 0xd4ffec;
const SAT_DONE = 0x5d7f70;
const PING_COLOR = 0x9df0c8;
const NET_NODES = 90;

// ---- Saf yardımcılar (testli) ----

/** Uydu etiketi: WebFetch / URL → alan adı; arama → tırnaksız sorgu; 28 karakterde kısalır. */
export function webCallLabel(call: Pick<ToolCall, 'name' | 'label'>): string {
  const raw = call.label.trim();
  let text = raw.replace(/^fetch\s+/i, '');
  const url = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/i.exec(text);
  if (call.name === 'WebFetch' || /^https?:\/\//i.test(text)) text = url?.[1] ?? text;
  else text = text.replace(/["“”]/g, '');
  text = text.replace(/^www\./i, '');
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text || 'web';
}

export interface LiveWebCall {
  id: string;
  label: string;
  color: string;
}

/** Snapshot'taki süren web çağrıları (sona ermiş session'lar hariç), çağıran ajanın kabuk rengiyle. */
export function liveWebCalls(s: Pick<BoardSnapshot, 'sessions' | 'projects'>): LiveWebCall[] {
  const colorOf = new Map(s.projects.map((p) => [p.id, p.color]));
  const out: LiveWebCall[] = [];
  for (const sess of s.sessions) {
    if (sess.status === 'ended') continue;
    for (const a of sess.agents) {
      const c = a.current;
      if (a.done || !c || c.endedAt !== undefined || c.category !== 'web') continue;
      out.push({ id: c.id, label: webCallLabel(c), color: shellColor(a, colorOf.get(sess.projectId) ?? '#5EA0FF') });
    }
  }
  return out;
}

/** Son 60 sn'deki web isteği sayısı (session.log). */
export function webPerMinute(s: Pick<BoardSnapshot, 'log'>, now: number): number {
  let n = 0;
  for (const e of s.log) if (e.kind === 'tool' && e.category === 'web' && now - e.ts < 60_000) n++;
  return n;
}

// ---- Küre ----

/** Kara ve okyanus noktaları (birim yönler; yarıçapı gölgelendirici verir) ve `land` özniteliği. */
export function webDots(n: number): THREE.BufferGeometry {
  return geoKeyed(`webDots:${n}`, () => {
    const pos: number[] = [];
    const land: number[] = [];
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const th = i * 2.399963;
      const x = Math.cos(th) * r;
      const z = Math.sin(th) * r;
      const isL = isLand((Math.asin(y) * 180) / Math.PI, (Math.atan2(-z, x) * 180) / Math.PI);
      if (!isL && i % 3) continue; // okyanus: her üçüncü nokta
      pos.push(x, y, z);
      land.push(isL ? 1 : 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('land', new THREE.Float32BufferAttribute(land, 1));
    // Noktalar gölgelendiricide yarıçapa itilir: sınır küresi gerçek boyutu kapsamalı (frustum culling).
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WEB_R * 1.1);
    return g;
  });
}

/** Ağ: yüzeyin 1.08–1.4 yarıçap üstünde 90 düğüm, her biri en yakın 3 komşusuna (mesafe sınırlı) bağlı. */
function netNodes(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  let s = 11;
  const rn = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < NET_NODES; i++) {
    const u = rn() * 2 - 1;
    const a = rn() * Math.PI * 2;
    const rr = Math.sqrt(1 - u * u);
    out.push(new THREE.Vector3(Math.cos(a) * rr, u, Math.sin(a) * rr).multiplyScalar(WEB_R * (1.08 + rn() * 0.32)));
  }
  return out;
}
const webNetNodes = () => geoKeyed('webNetNodes', () => new THREE.BufferGeometry().setFromPoints(netNodes()));
const webNetLinks = () =>
  geoKeyed('webNetLinks', () => {
    const nodes = netNodes();
    const links: THREE.Vector3[] = [];
    nodes.forEach((p, i) => {
      nodes
        .map((q, j) => [j, p.distanceTo(q)] as const)
        .filter(([j]) => j !== i)
        .sort((x, y) => x[1] - y[1])
        .slice(0, 3)
        .forEach(([j, d]) => {
          if (d < WEB_R * 0.9 && i < j) links.push(p, nodes[j]!);
        });
    });
    return new THREE.BufferGeometry().setFromPoints(links);
  });

const DOT_VERT = /* glsl */ `
  attribute float land;
  uniform float uHeat, uR, uScale;
  uniform vec3 uLand, uSea;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position * uR, 1.0);
    vec3 n = normalize(normalMatrix * position);
    float facing = dot(normalize(-mv.xyz), n);
    float rim = 1.0 - abs(facing);
    vCol = mix(uSea, uLand, land);
    // Arka yüz gizli: koyu çekirdeğin ardındaki noktalar çizilmez.
    vA = (land > 0.5 ? 0.85 : 0.35) * (0.55 + 0.45 * rim) * (0.85 + 0.35 * uHeat) * step(-0.05, facing);
    gl_PointSize = (land > 0.5 ? 2.2 : 1.4) * (1.0 + 0.6 * rim) * uScale * (14.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;

const DOT_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c);
    if (d > 0.25) discard;
    gl_FragColor = vec4(vCol, vA * (1.0 - d * 3.2));
  }`;

const RIM_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const RIM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uHeat;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float f = pow(1.0 - abs(dot(vN, vV)), 2.4);
    gl_FragColor = vec4(uColor * (1.2 + uHeat * 0.8), f * (0.75 + uHeat * 0.4));
  }`;

export interface WebUniforms {
  uHeat: { value: number };
  uR: { value: number };
  uScale: { value: number };
  uLand: { value: THREE.Color };
  uSea: { value: THREE.Color };
}

interface Sat {
  id: string;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  tag: CSS2DObject;
  orbit: number;
  ang: number;
  speed: number;
  done: boolean;
  linger: number;
  fade: number;
}

interface Ping {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  t: number;
}

const tmp = new THREE.Vector3();
const ADD = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } as const;

export class WebGlobe {
  readonly group = new THREE.Group();
  /** Dönen kısım: çekirdek, noktalar, dalgalar. */
  readonly globe = new THREE.Group();
  /** Ağ küreden yavaşça ters yönde döner. */
  readonly net = new THREE.Group();
  readonly uniforms: WebUniforms = {
    uHeat: { value: 0 },
    uR: { value: WEB_R * 1.004 },
    uScale: { value: 1 },
    uLand: { value: new THREE.Color('#7DF0C0') },
    uSea: { value: new THREE.Color('#2F8F68') },
  };
  readonly rimUniforms = { uColor: { value: new THREE.Color(WEB_GREEN) }, uHeat: { value: 0 } };
  readonly dots: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Koyu çekirdek: arka yüzü susturur, tıklama hedefi. */
  readonly core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly rim: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly links: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  readonly nodes: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  readonly atmo: THREE.Sprite;
  readonly badge: HTMLButtonElement;
  private readonly badgeRate: HTMLElement;
  private readonly tilts = WEB_ORBITS.map((o) => new THREE.Euler(o.tilt[0], o.tilt[1], o.tilt[2]));
  readonly sats = new Map<string, Sat>();
  readonly pings: Ping[] = [];
  private heat = 0;
  private launched = 0;
  private flicker = 0;

  constructor(
    private readonly env: SceneEnv,
    onFocus: () => void,
    quality: RenderQuality = 'high',
    pixelRatio = 1,
  ) {
    this.group.position.copy(WEB_CENTER);
    this.group.name = 'web';
    this.core = new THREE.Mesh(
      geo('webCore'),
      new THREE.MeshBasicMaterial({ color: 0x071712, transparent: true, opacity: 0.88 }),
    );
    this.dots = new THREE.Points(
      webDots(webPointCount(quality)),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
        vertexShader: DOT_VERT,
        fragmentShader: DOT_FRAG,
        ...ADD,
      }),
    );
    this.uniforms.uScale.value = Math.min(2, pixelRatio);
    this.globe.add(this.core, this.dots);
    this.rim = new THREE.Mesh(
      geo('webRim'),
      new THREE.ShaderMaterial({
        uniforms: this.rimUniforms as unknown as Record<string, THREE.IUniform>,
        vertexShader: RIM_VERT,
        fragmentShader: RIM_FRAG,
        side: THREE.BackSide,
        ...ADD,
      }),
    );
    this.links = new THREE.LineSegments(
      webNetLinks(),
      new THREE.LineBasicMaterial({ color: WEB_GREEN, opacity: 0.26, ...ADD }),
    );
    this.nodes = new THREE.Points(
      webNetNodes(),
      new THREE.PointsMaterial({ color: 0xa8f5d2, size: 0.09, opacity: 0.75, ...ADD }),
    );
    this.net.add(this.links, this.nodes);
    this.atmo = glowSprite(env.glow, WEB_GREEN, WEB_R * 4.2);
    const b = el('button', 'webtitle');
    b.type = 'button';
    b.setAttribute('aria-label', 'Web küresine yakınlaş');
    const name = el('b', '', 'web');
    this.badgeRate = el('span', '', '0 istek/dk · 0 açık');
    b.append(name, this.badgeRate);
    b.addEventListener('click', onFocus);
    this.badge = b;
    const badgeObj = labelObject(b, 0.5, 0);
    badgeObj.position.set(0, -WEB_R - 0.35, 0);
    this.group.add(this.globe, this.rim, this.net, this.atmo, badgeObj);
    env.picks.add(this.core, { kind: 'web' });
    this.setHeat(0);
  }

  /** Ayarlardaki görüntü kalitesi (Dengeli: yarı nokta) ve piksel oranı (nokta boyu). */
  setQuality(quality: RenderQuality, pixelRatio: number): void {
    this.dots.geometry = webDots(webPointCount(quality));
    this.uniforms.uScale.value = Math.min(2, pixelRatio);
  }

  /** Parçacıkların ve robotların hedefi: kürenin alt yüzeyi (dünya). */
  surfaceTarget(): THREE.Vector3 {
    return this.group.localToWorld(new THREE.Vector3(0, -WEB_R * 0.9, 0));
  }

  center(): THREE.Vector3 {
    return this.group.getWorldPosition(new THREE.Vector3());
  }

  /** Snapshot: süren çağrılar uydu olur; bitenler sönük dolaşmaya başlar; rozet sayıları. */
  sync(s: BoardSnapshot, now: number): void {
    const live = liveWebCalls(s);
    const ids = new Set(live.map((c) => c.id));
    for (const c of live) if (!this.sats.has(c.id) && this.sats.size < MAX_SATS) this.launch(c);
    for (const sat of this.sats.values()) {
      const done = !ids.has(sat.id);
      if (done !== sat.done) {
        sat.done = done;
        sat.mesh.material.color.set(done ? SAT_DONE : SAT_LIVE);
        sat.tag.element.classList.toggle('old', done);
      }
    }
    const open = live.length;
    const text = `${webPerMinute(s, now)} istek/dk · ${open} açık`;
    if (this.badgeRate.textContent !== text) this.badgeRate.textContent = text;
  }

  private launch(c: LiveWebCall): void {
    const orbit = this.launched++ % this.tilts.length;
    const mesh = new THREE.Mesh(geo('webSat'), new THREE.MeshBasicMaterial({ color: SAT_LIVE }));
    mesh.add(glowSprite(this.env.glow, WEB_GREEN, 0.9));
    const tagEl = el('div', 'sattag');
    const dot = el('i', '');
    dot.style.background = c.color;
    tagEl.append(dot, document.createTextNode(c.label));
    const tag = labelObject(tagEl, 0, 0.5);
    tag.position.set(0.2, 0, 0);
    mesh.add(tag);
    this.group.add(mesh);
    const sat: Sat = {
      id: c.id,
      mesh,
      tag,
      orbit,
      ang: (hashString(c.id) % 628) / 100,
      speed: 0.9 + (hashString(c.id + 's') % 50) / 100,
      done: false,
      linger: LINGER_S,
      fade: 1,
    };
    this.place(sat);
    this.sats.set(c.id, sat);
  }

  private place(sat: Sat): void {
    const r = WEB_ORBITS[sat.orbit]!.r;
    // Yörünge çemberi kendi XY düzleminde, sonra eğilir (halkalar çizilmez; yalnızca uydular).
    tmp.set(Math.cos(sat.ang) * r, Math.sin(sat.ang) * r, 0).applyEuler(this.tilts[sat.orbit]!);
    sat.mesh.position.copy(tmp);
  }

  /** İstek küreye vardı: yüzeyde dalga. Hareketi azalt açıkken yok (yalnızca parlaklık). */
  ping(): void {
    if (this.env.reducedMotion) return;
    if (this.pings.length >= MAX_PINGS) this.removePing(0);
    const seed = (this.launched + this.pings.length * 7 + Date.now()) % 1000;
    const n = new THREE.Vector3(
      Math.sin(seed) * 0.8,
      -0.2 + ((seed % 7) / 7) * 0.6,
      Math.cos(seed * 1.3) * 0.8,
    ).normalize();
    const mesh = new THREE.Mesh(
      geo('webPing'),
      new THREE.MeshBasicMaterial({ color: PING_COLOR, side: THREE.DoubleSide, opacity: 1, ...ADD }),
    );
    mesh.position.copy(n).multiplyScalar(WEB_R * 1.01);
    mesh.lookAt(n.multiplyScalar(5));
    this.globe.add(mesh);
    this.pings.push({ mesh, t: 0 });
  }

  /** Web etkinliği (03/06 effects): 0..1; karalar, kenar ve ağ çizgileri parlar, dönüş hızlanır. */
  setHeat(h: number): void {
    this.heat = h;
    this.uniforms.uHeat.value = h;
    this.rimUniforms.uHeat.value = h;
    this.atmo.material.opacity = 0.08 + h * 0.2;
    this.nodes.material.opacity = 0.75 + h * 0.25;
    this.setLinks();
  }

  private setLinks(): void {
    this.links.material.opacity = 0.26 + this.heat * 0.35 + this.flicker;
  }

  /**
   * Her kare. `decor`: kürenin ve ağın dönüşü, ağ çizgilerinin titreşimi (döngü boştayken durur). Web etkinliği
   * sürerken dönüş yavaş hız ister (ortam); uydular ve yüzey dalgaları tam hız. Hareketi azalt: dönme yok,
   * yalnızca parlaklık; biten uydu bekleme süresinden sonra kalkar.
   */
  step(dt: number, decor: boolean, camPos?: THREE.Vector3): Demand {
    const reduced = this.env.reducedMotion;
    // Kamerayla kürenin aynı yönündeki (öndeki) uyduların etiketi görünür; arkadakiler ve bitenler yalnızca nokta.
    const toCam = camPos ? camPos.clone().sub(this.group.position).normalize() : null;
    let d: Demand = DEMAND_NONE;
    if (decor && !reduced) {
      this.globe.rotation.y += dt * (0.06 + this.heat * 0.25);
      this.net.rotation.y -= dt * 0.025;
      this.flicker = Math.sin(this.globe.rotation.y * 7) * 0.04;
      this.setLinks();
    }
    if (!reduced && this.heat > 0) d = DEMAND_AMBIENT;
    for (const sat of [...this.sats.values()]) {
      if (!reduced) {
        sat.ang += dt * sat.speed;
        this.place(sat);
        d = DEMAND_ACTIVE;
      }
      const front = !toCam || sat.mesh.position.dot(toCam) > 0;
      sat.tag.visible = front && !sat.done;
      if (sat.done) {
        sat.linger -= dt;
        if (sat.linger <= 0) sat.fade -= dt * (reduced ? 10 : FADE_PER_S);
        sat.mesh.scale.setScalar(Math.max(0.01, sat.fade));
        sat.tag.element.style.opacity = String(Math.max(0, sat.fade));
        if (sat.fade <= 0) this.removeSat(sat);
        else if (reduced) d = Math.max(d, DEMAND_AMBIENT) as Demand;
      }
    }
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i]!;
      p.t += dt / PING_S;
      p.mesh.scale.setScalar(1 + p.t * 6);
      p.mesh.material.opacity = Math.max(0, 1 - p.t);
      if (p.t >= 1) this.removePing(i);
      else d = DEMAND_ACTIVE;
    }
    return d;
  }

  private removeSat(sat: Sat): void {
    disposeTree(sat.mesh); // uydu + parıltı malzemesi, etiket DOM'dan kalkar
    this.sats.delete(sat.id);
  }

  private removePing(i: number): void {
    const p = this.pings[i];
    if (!p) return;
    disposeTree(p.mesh);
    this.pings.splice(i, 1);
  }

  /** Bağlam yenilendi / sahne yeniden kuruldu: uçuştaki uydu ve dalgalar bırakılır. */
  reset(): void {
    for (const s of [...this.sats.values()]) this.removeSat(s);
    while (this.pings.length) this.removePing(this.pings.length - 1);
  }

  /** Gölgelendirici, çekirdek, ağ ve parıltı malzemeleri; paylaşılan geometriler kalır. */
  dispose(): void {
    this.reset();
    this.env.picks.removeTree(this.group);
    disposeTree(this.group);
  }
}
