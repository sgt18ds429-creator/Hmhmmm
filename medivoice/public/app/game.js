// game.js — «سباق ميدي فويز»: لعبة سباق بمنظور عمق تُلعب أثناء انتظار الملزمة.
// تفتح في نافذة سفلية فوق شاشة التحويل وتعرض تقدّمه، وتنغلق وحدها عندما تجهز الملزمة.
// ثلاثة مسارات، سيارات وشاحنات وأقماع، نجوم ومضاعف، وقوى: درع ومغناطيس ونيترو. وكل 10% من
// تقدم الملزمة تمر نقطة تفتيش على الطريق تمنح نقاطاً. خفيفة عمداً (أشكال بسيطة على canvas).

import { h, sheet } from './ui.js';

const LANES = 3;
const BEST_KEY = 'mv-race-best';
const FONT = '"El Messiri", "IBM Plex Sans Arabic", system-ui, sans-serif';
const CAR_COLORS = ['#ffb547', '#6fe3b4', '#ff7a8a', '#7cc8ff', '#ffd166', '#c9b8ff'];
const POWERS = {
  shield: { color: '#7cc8ff', label: 'درع', ms: 0 },
  magnet: { color: '#ffb547', label: 'مغناطيس', ms: 9000 },
  nitro: { color: '#ff7a8a', label: 'نيترو', ms: 3200 },
};

function loadBest() { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } }
function saveBest(v) { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* تخزين غير متاح */ } }
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * @param onClose يُستدعى عند إغلاق اللعبة (بزر الإغلاق أو الرجوع أو عند جاهزية الملزمة)
 * @returns { update(pct, text), done(), close() }
 */
export function openGame({ onClose } = {}) {
  const fill = h('i');
  const pctEl = h('b', { class: 'num' }, '0%');
  const textEl = h('small');
  const bar = h('div', { class: 'game-progress', role: 'status' }, fill, pctEl, textEl);
  const canvas = h('canvas', { class: 'game-canvas', 'aria-label': 'لعبة سباق: اضغط يمين اللعبة أو يسارها أو اسحب حتى تغيّر المسار' });
  const hint = h('p', { class: 'game-hint' }, 'اضغط يمين أو يسار، أو اسحب، حتى تغيّر المسار. الملزمة تكمل بالخلفية.');
  const s = sheet({ title: 'سباق لحد ما تجهز الملزمة', body: h('div', { class: 'game' }, bar, canvas, hint), onClose: () => { stop(); onClose?.(); } });
  s.panel.classList.add('game-panel');

  const g = canvas.getContext('2d');
  let W = 0, H = 0, horizon = 0, roadBottom = 0, roadTop = 0;
  const st = {
    mode: 'ready', finished: false,
    lane: 1, x: 0, speed: 0, dist: 0, bonus: 0, time: 0, combo: 0, streak: 0,
    best: loadBest(), newBest: false,
    cars: [], items: [], sparks: [], flags: [], texts: [],
    dash: 0, spawnIn: 0, itemIn: 0, shake: 0, flash: 0, shield: false, magnetUntil: 0, nitroUntil: 0, hitSlow: 0,
    lastPct: 0, lastFlagPct: 0,
  };
  let raf = 0, last = 0, running = true, paused = false;

  // ── المنظور ──
  // z: عمق العنصر من 0 (الأفق) إلى 1 (أسفل الشاشة عند اللاعب)
  const PLAYER_Z = 0.9;
  const yOf = (z) => horizon + (H - horizon) * Math.pow(z, 1.55);
  const halfRoad = (z) => roadTop + (roadBottom - roadTop) * Math.pow(z, 1.55);
  const scaleOf = (z) => 0.16 + 0.84 * Math.pow(z, 1.35);
  const laneOffset = (lane) => (lane - (LANES - 1) / 2) / LANES * 2; // -0.66 .. 0.66
  const xOf = (lane, z) => W / 2 + laneOffset(lane) * halfRoad(z);
  const carSize = (z) => { const k = scaleOf(z); return { w: roadBottom * 0.36 * k, h: roadBottom * 0.62 * k }; };
  const score = () => Math.floor(st.dist * 5) + st.bonus;
  const now = () => performance.now();
  const nitro = () => now() < st.nitroUntil;
  const magnet = () => now() < st.magnetUntil;

  // الخلفية الثابتة (السماء والنجوم والتوهج والأرض وجسم الطريق) تُرسم مرة واحدة في لوحة جانبية،
  // لأن التدرّجات بحجم الشاشة في كل إطار هي أثقل ما في اللعبة على الهاتف أثناء عمل التحويل
  let bg = null;
  function paintBackground(dpr) {
    bg = document.createElement('canvas');
    bg.width = canvas.width; bg.height = canvas.height;
    const b = bg.getContext('2d');
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = b.createLinearGradient(0, 0, 0, horizon * 1.4);
    sky.addColorStop(0, '#0d0720'); sky.addColorStop(1, '#2b1458');
    b.fillStyle = sky; b.fillRect(-12, -12, W + 24, horizon * 1.4 + 12);
    b.fillStyle = 'rgba(244,240,255,.5)';
    for (let i = 0; i < 26; i++) { const sx = ((i * 97) % W), sy = (i * 53) % Math.max(1, horizon * 0.9); b.fillRect(sx, sy, 2, 2); }
    const glow = b.createRadialGradient(W / 2, horizon, 4, W / 2, horizon, W * 0.6);
    glow.addColorStop(0, 'rgba(201,35,193,.5)'); glow.addColorStop(1, 'rgba(201,35,193,0)');
    b.fillStyle = glow; b.fillRect(0, 0, W, horizon * 1.5);
    b.fillStyle = '#120b26'; b.fillRect(-12, horizon, W + 24, H - horizon + 12);
    b.fillStyle = '#1b1330';
    b.beginPath(); b.moveTo(W / 2 - roadTop, horizon); b.lineTo(W / 2 + roadTop, horizon); b.lineTo(W / 2 + roadBottom, H + 12); b.lineTo(W / 2 - roadBottom, H + 12); b.closePath(); b.fill();
  }

  function layout() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // دقة محدودة عمداً: الهاتف يشغّل التحويل في الخلفية نفسها، ودقة 1.25 كافية للرسوم المسطحة
    const dpr = Math.min(1.25, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    horizon = H * 0.2;
    roadBottom = Math.min(W * 0.48, 260);
    roadTop = roadBottom * 0.14;
    st.x = laneOffset(st.lane);
    paintBackground(dpr);
  }

  function reset() {
    Object.assign(st, { mode: 'run', lane: 1, x: laneOffset(1), speed: 0.55, dist: 0, bonus: 0, time: 0, combo: 1, streak: 0, newBest: false,
      cars: [], items: [], sparks: [], flags: [], texts: [], spawnIn: 1.1, itemIn: 1.8, shake: 0, flash: 0, shield: false, magnetUntil: 0, nitroUntil: 0, hitSlow: 0 });
  }

  function move(dir) {
    if (st.mode === 'run' && !st.finished) st.lane = Math.max(0, Math.min(LANES - 1, st.lane + dir));
  }

  // ── الإدخال: ضغط على نصف الشاشة، أو سحب، أو الأسهم ──
  let press = null;
  const onDown = (e) => {
    e.preventDefault();
    if (st.finished) return;
    if (st.mode !== 'run') { reset(); return; }
    press = { x: e.clientX, t: now(), moved: false };
  };
  const onMove = (e) => {
    if (!press || press.moved) return;
    const dx = e.clientX - press.x;
    if (Math.abs(dx) > 22) { press.moved = true; move(dx < 0 ? -1 : 1); }
  };
  const onUp = (e) => {
    if (!press) return;
    if (!press.moved) { const r = canvas.getBoundingClientRect(); move(e.clientX - r.left < r.width / 2 ? -1 : 1); }
    press = null;
  };
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { move(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { move(1); e.preventDefault(); }
    else if ((e.key === ' ' || e.key === 'Enter') && st.mode !== 'run' && !st.finished) { reset(); e.preventDefault(); }
  };
  const onVisibility = () => { paused = document.hidden; if (!paused) last = now(); };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', () => { press = null; });
  addEventListener('keydown', onKey);
  addEventListener('resize', layout);
  document.addEventListener('visibilitychange', onVisibility);

  // ── الحركة ──
  const laneBusy = (zMax) => new Set(st.cars.filter((c) => c.z < zMax).map((c) => c.lane));
  function spawnCar() {
    const busy = laneBusy(0.35);
    const open = [...Array(LANES).keys()].filter((i) => !busy.has(i));
    if (open.length <= 1) return; // يبقى مسار مفتوح دائماً
    const lane = pick(open);
    const r = Math.random();
    const kind = r < 0.18 ? 'truck' : r < 0.36 ? 'cone' : 'car';
    st.cars.push({ lane, z: 0, kind, color: pick(CAR_COLORS), len: kind === 'truck' ? 1.7 : kind === 'cone' ? 0.45 : 1, v: kind === 'cone' ? 0 : 0.28 + Math.random() * 0.12 });
  }
  function spawnItem() {
    const busy = laneBusy(0.3);
    const open = [...Array(LANES).keys()].filter((i) => !busy.has(i));
    if (!open.length) return;
    const r = Math.random();
    const kind = r < 0.78 ? 'star' : r < 0.87 ? 'shield' : r < 0.94 ? 'magnet' : 'nitro';
    st.items.push({ lane: pick(open), z: 0, kind, spin: 0, x: null });
  }
  function sparkle(x, y, color, n = 10) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random();
      const v = rnd(90, 190);
      st.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(0.35, 0.6), color });
    }
  }
  function floatText(text, x, y, color = '#ffb547') { st.texts.push({ text, x, y, life: 1, color }); }
  function crash(c) {
    if (nitro()) { sparkle(xOf(c.lane, c.z), yOf(c.z), '#ff7a8a', 14); c.dead = true; st.bonus += 15; return; } // النيترو يحطّم العوائق
    if (st.shield) { st.shield = false; st.flash = 0.6; st.shake = 0.5; c.dead = true; floatText('الدرع حماك', W / 2, H * 0.5, '#7cc8ff'); try { navigator.vibrate?.(40); } catch { /* غير مدعوم */ } return; }
    st.mode = 'over'; st.shake = 1; st.flash = 1;
    const sc = score();
    st.newBest = sc > st.best;
    if (st.newBest) { st.best = sc; saveBest(sc); }
    try { navigator.vibrate?.(90); } catch { /* غير مدعوم */ }
  }
  function bump() {
    // قمع: تباطؤ وضياع المضاعف بدل الاصطدام
    st.hitSlow = 0.9; st.shake = 0.35; st.combo = 1; st.streak = 0;
    floatText('قمع! ضاع المضاعف', W / 2, H * 0.55, '#ff7a8a');
    try { navigator.vibrate?.(25); } catch { /* غير مدعوم */ }
  }
  function take(it) {
    it.taken = true;
    const x = xOf(it.lane, it.z), y = yOf(it.z);
    if (it.kind === 'star') {
      st.streak++;
      if (st.streak % 5 === 0 && st.combo < 5) { st.combo++; floatText(`×${st.combo}`, x, y - 20, '#c4b3ff'); }
      const v = 25 * st.combo;
      st.bonus += v;
      floatText(`+${v}`, x, y, '#ffb547');
      sparkle(x, y, '#ffb547');
    } else {
      const p = POWERS[it.kind];
      if (it.kind === 'shield') st.shield = true;
      else if (it.kind === 'magnet') st.magnetUntil = now() + p.ms;
      else st.nitroUntil = now() + p.ms;
      floatText(p.label, x, y, p.color);
      sparkle(x, y, p.color, 14);
    }
  }

  function update(dt) {
    st.shake = Math.max(0, st.shake - dt * 2.5);
    st.flash = Math.max(0, st.flash - dt * 2);
    for (const p of st.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.life -= dt; }
    st.sparks = st.sparks.filter((p) => p.life > 0);
    for (const t of st.texts) { t.y -= 40 * dt; t.life -= dt * 0.9; }
    st.texts = st.texts.filter((t) => t.life > 0);
    const idle = st.mode !== 'run' || st.finished;
    const base = idle ? 0.12 : st.speed;
    st.dash = (st.dash + base * dt * 1.3) % 1;
    for (const f of st.flags) f.z += base * dt;
    st.flags = st.flags.filter((f) => f.z < 1.1);
    if (idle) return;

    st.time += dt;
    st.hitSlow = Math.max(0, st.hitSlow - dt);
    const target = (0.55 + Math.min(0.75, st.time * 0.009)) * (nitro() ? 1.55 : 1) * (st.hitSlow ? 0.55 : 1);
    st.speed += (target - st.speed) * Math.min(1, dt * 2.2);
    st.dist += st.speed * dt;
    st.x += (laneOffset(st.lane) - st.x) * Math.min(1, dt * 12);

    st.spawnIn -= dt;
    if (st.spawnIn <= 0) { spawnCar(); st.spawnIn = Math.max(0.55, 1.35 - st.time * 0.008) * rnd(0.7, 1.3); }
    st.itemIn -= dt;
    if (st.itemIn <= 0) { spawnItem(); st.itemIn = rnd(1.1, 2.2); }

    for (const c of st.cars) c.z += (st.speed - c.v) * dt;
    st.cars = st.cars.filter((c) => c.z < 1.15 && !c.dead);
    for (const it of st.items) {
      it.z += st.speed * dt;
      it.spin += dt * 3;
      // المغناطيس يسحب النجوم القريبة نحو مسار اللاعب
      if (magnet() && it.kind === 'star' && it.z > 0.55) it.lane += (st.lane - it.lane) * Math.min(1, dt * 6);
    }
    st.items = st.items.filter((it) => it.z < 1.1 && !it.taken);

    // التصادم عند عمق اللاعب: تداخل في المسار وفي العمق
    const pz0 = PLAYER_Z - 0.045, pz1 = PLAYER_Z + 0.045;
    for (const c of st.cars) {
      const len = 0.045 * c.len;
      const sameLane = Math.abs(laneOffset(c.lane) - st.x) < (c.kind === 'cone' ? 0.28 : 0.42);
      if (sameLane && c.z + len > pz0 && c.z - len < pz1) {
        if (c.kind === 'cone') { c.dead = true; bump(); } else { crash(c); return; }
      }
    }
    for (const it of st.items) {
      if (Math.abs(laneOffset(it.lane) - st.x) < 0.45 && it.z > pz0 - 0.02 && it.z < pz1 + 0.02) take(it);
    }
  }

  // ── الرسم ──
  function roundRect(x, y, w, hh, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, hh, r);
    else { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  }

  function drawVehicle(x, z, c, player) {
    const { w, h: hh } = carSize(z);
    const len = hh * (c?.len || 1);
    const y = yOf(z) - len / 2;
    const cx = x - w / 2;
    if (c?.kind === 'cone') {
      const r = w * 0.22;
      g.fillStyle = 'rgba(0,0,0,.3)'; g.beginPath(); g.ellipse(x, y + len, r * 1.3, r * 0.4, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ff8a3d'; g.beginPath(); g.moveTo(x, y + len * 0.1); g.lineTo(x + r, y + len); g.lineTo(x - r, y + len); g.closePath(); g.fill();
      g.fillStyle = '#fff'; g.fillRect(x - r * 0.55, y + len * 0.55, r * 1.1, len * 0.14);
      return;
    }
    const tilt = player ? (laneOffset(st.lane) - st.x) * 0.9 : 0;
    g.save();
    g.translate(x, y + len / 2); g.rotate(tilt); g.translate(-x, -(y + len / 2));
    g.fillStyle = 'rgba(0,0,0,.35)';
    roundRect(cx + w * 0.06, y + hh * 0.08, w, len, w * 0.28); g.fill();
    // العجلات
    g.fillStyle = '#05020b';
    const ww = w * 0.16, wh = len * 0.18;
    for (const wy of [0.12, 0.7]) { g.fillRect(cx - ww * 0.35, y + len * wy, ww, wh); g.fillRect(cx + w - ww * 0.65, y + len * wy, ww, wh); }
    // الجسم
    if (player) {
      const gr = g.createLinearGradient(cx, y, cx + w, y + len);
      gr.addColorStop(0, '#5433ec'); gr.addColorStop(0.55, '#8521d5'); gr.addColorStop(1, '#c923c1');
      g.fillStyle = gr;
    } else g.fillStyle = c.color;
    roundRect(cx, y, w, len, w * 0.3); g.fill();
    if (c?.kind === 'truck') { g.fillStyle = 'rgba(255,255,255,.18)'; roundRect(cx + w * 0.08, y + len * 0.3, w * 0.84, len * 0.6, w * 0.1); g.fill(); }
    // الزجاج
    g.fillStyle = player ? 'rgba(244, 240, 255, 0.9)' : 'rgba(10, 6, 24, 0.72)';
    roundRect(cx + w * 0.15, y + len * (c?.kind === 'truck' ? 0.08 : 0.18), w * 0.7, hh * 0.2, w * 0.12); g.fill();
    g.fillStyle = 'rgba(10, 6, 24, 0.72)';
    roundRect(cx + w * 0.18, y + len - hh * 0.32, w * 0.64, hh * 0.13, w * 0.1); g.fill();
    // أضواء
    g.fillStyle = '#ff5a6e';
    g.fillRect(cx + w * 0.12, y + len - 4, w * 0.2, 3); g.fillRect(cx + w * 0.68, y + len - 4, w * 0.2, 3);
    if (player) {
      g.fillStyle = 'rgba(255, 240, 180, 0.95)';
      g.fillRect(cx + w * 0.14, y + 1, w * 0.18, 3); g.fillRect(cx + w * 0.68, y + 1, w * 0.18, 3);
      if (st.shield) { g.strokeStyle = 'rgba(124, 200, 255, .9)'; g.lineWidth = 3; roundRect(cx - 6, y - 6, w + 12, len + 12, w * 0.4); g.stroke(); }
      if (nitro()) {
        g.fillStyle = 'rgba(255, 122, 138, .75)';
        for (let i = 0; i < 2; i++) { const fx = cx + w * (0.25 + i * 0.5); g.beginPath(); g.moveTo(fx - 5, y + len); g.lineTo(fx + 5, y + len); g.lineTo(fx, y + len + 14 + Math.random() * 16); g.closePath(); g.fill(); }
      }
    }
    g.restore();
  }

  function drawItem(it) {
    const z = it.z, x = xOf(it.lane, z), y = yOf(z), r = carSize(z).w * 0.26;
    g.save();
    g.translate(x, y);
    if (it.kind === 'star') {
      g.rotate(it.spin * 0.25);
      g.fillStyle = '#ffb547';
      g.beginPath();
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 - Math.PI / 2; const rr = i % 2 ? r * 0.45 : r; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      g.closePath(); g.fill();
    } else {
      const p = POWERS[it.kind];
      g.fillStyle = p.color;
      g.beginPath(); g.arc(0, 0, r * 1.05, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0a0618';
      if (it.kind === 'shield') { g.beginPath(); g.moveTo(0, -r * 0.6); g.lineTo(r * 0.55, -r * 0.3); g.lineTo(r * 0.45, r * 0.25); g.lineTo(0, r * 0.65); g.lineTo(-r * 0.45, r * 0.25); g.lineTo(-r * 0.55, -r * 0.3); g.closePath(); g.fill(); }
      else if (it.kind === 'magnet') { g.lineWidth = r * 0.32; g.strokeStyle = '#0a0618'; g.beginPath(); g.arc(0, 0, r * 0.45, Math.PI, 0); g.moveTo(-r * 0.45, 0); g.lineTo(-r * 0.45, r * 0.5); g.moveTo(r * 0.45, 0); g.lineTo(r * 0.45, r * 0.5); g.stroke(); }
      else { g.beginPath(); g.moveTo(r * 0.15, -r * 0.65); g.lineTo(-r * 0.4, r * 0.1); g.lineTo(0, r * 0.1); g.lineTo(-r * 0.15, r * 0.65); g.lineTo(r * 0.4, -r * 0.1); g.lineTo(0, -r * 0.1); g.closePath(); g.fill(); }
    }
    g.restore();
  }

  function drawFlag(f) {
    const z = f.z, y = yOf(z), hr = halfRoad(z), k = scaleOf(z);
    g.strokeStyle = 'rgba(244,240,255,.55)'; g.lineWidth = Math.max(1, 3 * k);
    g.beginPath(); g.moveTo(W / 2 - hr - 10 * k, y); g.lineTo(W / 2 - hr - 10 * k, y - 60 * k); g.moveTo(W / 2 + hr + 10 * k, y); g.lineTo(W / 2 + hr + 10 * k, y - 60 * k); g.stroke();
    g.fillStyle = 'rgba(111,227,180,.9)';
    g.fillRect(W / 2 - hr - 10 * k, y - 60 * k, 26 * k, 16 * k); g.fillRect(W / 2 + hr + 10 * k - 26 * k, y - 60 * k, 26 * k, 16 * k);
    g.fillStyle = `rgba(111,227,180,${0.35 * Math.min(1, z * 1.5)})`;
    g.fillRect(W / 2 - hr, y - 2 * k, hr * 2, 4 * k);
    g.font = `700 ${Math.round(Math.max(10, 24 * k))}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.direction = 'rtl';
    g.fillStyle = '#6fe3b4'; g.fillText(f.label, W / 2, y - 8 * k);
  }

  function road() {
    // السماء والأرض وجسم الطريق من اللوحة الجانبية
    if (bg) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(bg, 0, 0); g.restore(); }
    // الحواف والشرائط تتحرك نحو اللاعب
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const z0 = ((i + st.dash) / steps), z1 = ((i + st.dash + 0.5) / steps);
      if (z0 > 1.05) continue;
      const y0 = yOf(Math.min(1.1, z0)), y1 = yOf(Math.min(1.1, z1)), h0 = halfRoad(Math.min(1.1, z0)), h1 = halfRoad(Math.min(1.1, z1));
      g.fillStyle = i % 2 ? '#c923c1' : '#f4f0ff';
      g.beginPath(); g.moveTo(W / 2 - h0 - 7 * scaleOf(z0), y0); g.lineTo(W / 2 - h0, y0); g.lineTo(W / 2 - h1, y1); g.lineTo(W / 2 - h1 - 7 * scaleOf(z1), y1); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(W / 2 + h0 + 7 * scaleOf(z0), y0); g.lineTo(W / 2 + h0, y0); g.lineTo(W / 2 + h1, y1); g.lineTo(W / 2 + h1 + 7 * scaleOf(z1), y1); g.closePath(); g.fill();
      if (i % 2 === 0) {
        g.fillStyle = 'rgba(244,240,255,.28)';
        for (let l = 1; l < LANES; l++) {
          const off = (l - (LANES - 1) / 2) / LANES * 2 - 1 / LANES;
          const x0 = W / 2 + off * h0 + h0 / LANES, x1 = W / 2 + off * h1 + h1 / LANES;
          g.beginPath(); g.moveTo(x0 - 2 * scaleOf(z0), y0); g.lineTo(x0 + 2 * scaleOf(z0), y0); g.lineTo(x1 + 2 * scaleOf(z1), y1); g.lineTo(x1 - 2 * scaleOf(z1), y1); g.closePath(); g.fill();
        }
      }
    }
    // أعمدة إنارة على الجانبين
    for (let i = 0; i < 6; i++) {
      const z = ((i + st.dash * 0.5) / 6);
      if (z > 1) continue;
      const y = yOf(z), hr = halfRoad(z), k = scaleOf(z);
      g.fillStyle = 'rgba(196,179,255,.22)';
      g.fillRect(W / 2 - hr - 30 * k, y - 70 * k, 3 * k, 70 * k); g.fillRect(W / 2 + hr + 27 * k, y - 70 * k, 3 * k, 70 * k);
      g.fillStyle = 'rgba(255,214,102,.8)';
      g.fillRect(W / 2 - hr - 36 * k, y - 72 * k, 12 * k, 4 * k); g.fillRect(W / 2 + hr + 24 * k, y - 72 * k, 12 * k, 4 * k);
    }
    // خطوط السرعة مع النيترو
    if (nitro()) {
      g.strokeStyle = 'rgba(255,122,138,.35)'; g.lineWidth = 2;
      for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; g.beginPath(); g.moveTo(W / 2 + Math.cos(a) * W * 0.25, horizon + Math.sin(a) * H * 0.25); g.lineTo(W / 2 + Math.cos(a) * W * 0.9, horizon + Math.sin(a) * H * 0.9); g.stroke(); }
    }
  }

  function hud() {
    g.textBaseline = 'top';
    g.direction = 'ltr'; g.textAlign = 'left';
    g.font = `700 ${Math.round(Math.max(18, W * 0.055))}px ${FONT}`;
    g.fillStyle = '#f4f0ff';
    g.fillText(String(score()), 14, 10);
    g.direction = 'rtl'; g.textAlign = 'right';
    g.font = `500 ${Math.round(Math.max(12, W * 0.034))}px ${FONT}`;
    g.fillStyle = '#c2b6e6';
    g.fillText(`الأفضل ${st.best}`, W - 14, 14);
    if (st.mode === 'run') {
      let y = 44;
      if (st.combo > 1) { g.fillStyle = '#c4b3ff'; g.font = `700 ${Math.round(Math.max(13, W * 0.04))}px ${FONT}`; g.fillText(`مضاعف ×${st.combo}`, W - 14, y); y += 24; }
      g.font = `600 ${Math.round(Math.max(11, W * 0.03))}px ${FONT}`;
      const show = [];
      if (st.shield) show.push(['درع', POWERS.shield.color]);
      if (magnet()) show.push([`مغناطيس ${Math.ceil((st.magnetUntil - now()) / 1000)}`, POWERS.magnet.color]);
      if (nitro()) show.push(['نيترو', POWERS.nitro.color]);
      for (const [t, c] of show) { g.fillStyle = c; g.fillText(t, W - 14, y); y += 20; }
    }
  }

  function overlay() {
    g.fillStyle = 'rgba(10, 6, 24, 0.68)';
    g.fillRect(0, 0, W, H);
    g.direction = 'rtl'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const big = Math.round(Math.max(22, W * 0.075)), small = Math.round(Math.max(13, W * 0.038));
    const lines = st.finished
      ? [['الملزمة جاهزة!', big, '#6fe3b4'], ['أفتحها لك الآن…', small, '#c2b6e6']]
      : st.mode === 'ready'
        ? [['سباق ميدي فويز', big, '#f4f0ff'], ['تفادى السيارات والأقماع واجمع النجوم', small, '#c2b6e6'], ['الدرع يحميك مرة، والمغناطيس يجذب النجوم، والنيترو يحطّم كل شيء', small - 1, '#c2b6e6'], ['اضغط حتى تبدأ', small, '#ffb547']]
        : [['اصطدمت!', big, '#ff7a8a'], [`النتيجة ${score()}${st.newBest ? ' · رقم قياسي جديد' : ''}`, small + 2, '#f4f0ff'], [`الأفضل ${st.best}`, small, '#c2b6e6'], ['اضغط حتى تلعب مرة ثانية', small, '#ffb547']];
    let y = H / 2 - ((lines.length - 1) * small * 1.8) / 2;
    for (const [text, size, color] of lines) {
      g.font = `700 ${size}px ${FONT}`;
      g.fillStyle = color;
      g.fillText(text, W / 2, y, W - 30);
      y += Math.max(size, small) * 1.8;
    }
  }

  function draw() {
    g.save();
    if (st.shake) g.translate((Math.random() - 0.5) * 12 * st.shake, (Math.random() - 0.5) * 12 * st.shake);
    road();
    // الأبعد أولاً حتى يغطيه الأقرب
    const layer = [...st.cars.map((c) => ({ z: c.z, draw: () => drawVehicle(xOf(c.lane, c.z), c.z, c, false) })), ...st.items.map((it) => ({ z: it.z, draw: () => drawItem(it) })), ...st.flags.map((f) => ({ z: f.z, draw: () => drawFlag(f) }))];
    layer.sort((a, b) => a.z - b.z);
    let playerDrawn = false;
    for (const o of layer) {
      if (!playerDrawn && o.z > PLAYER_Z) { drawVehicle(W / 2 + st.x * halfRoad(PLAYER_Z), PLAYER_Z, null, true); playerDrawn = true; }
      o.draw();
    }
    if (!playerDrawn) drawVehicle(W / 2 + st.x * halfRoad(PLAYER_Z), PLAYER_Z, null, true);
    for (const p of st.sparks) { g.fillStyle = p.color; g.globalAlpha = Math.max(0, p.life * 2); g.fillRect(p.x - 2, p.y - 2, 4, 4); }
    g.globalAlpha = 1;
    g.direction = 'rtl'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const t of st.texts) { g.globalAlpha = Math.max(0, t.life); g.font = `700 ${Math.round(Math.max(14, W * 0.045))}px ${FONT}`; g.fillStyle = t.color; g.fillText(t.text, t.x, t.y); }
    g.globalAlpha = 1;
    g.restore();
    if (st.flash) { g.fillStyle = `rgba(255, 122, 138, ${st.flash * 0.35})`; g.fillRect(0, 0, W, H); }
    hud();
    if (st.mode !== 'run' || st.finished) overlay();
  }

  // نحو 30 إطاراً بالثانية تكفي، ونصف الإطارات يعني نصف الحمل على هاتف يحوّل محاضرة في الخلفية
  const FRAME_MS = 31;
  function frame(t) {
    if (!running) return;
    if (!paused) {
      if (t - last < FRAME_MS) { raf = requestAnimationFrame(frame); return; }
      const dt = Math.min(0.08, Math.max(0, (t - last) / 1000));
      last = t;
      if (!W) layout();
      if (W) { update(dt); draw(); }
    }
    raf = requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => { layout(); last = t; raf = requestAnimationFrame(frame); });

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey);
    removeEventListener('resize', layout);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  return {
    /** تقدم التحويل فوق اللعبة؛ وكل 10% تمر نقطة تفتيش على الطريق */
    update(pct, text) {
      const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      fill.style.width = `${v}%`;
      pctEl.textContent = `${v}%`;
      textEl.textContent = text || '';
      const mark = Math.floor(v / 10) * 10;
      if (mark > st.lastFlagPct && mark > 0 && mark < 100) {
        st.lastFlagPct = mark;
        if (st.mode === 'run') { st.flags.push({ z: 0, label: `الملزمة ${mark}%` }); st.bonus += 50; floatText('+50 نقطة تفتيش', W / 2, H * 0.4, '#6fe3b4'); }
      }
      st.lastPct = v;
    },
    /** الملزمة جاهزة: يتوقف السباق ويظهر الإعلان، ثم تُغلق اللعبة عند الانتقال للملزمة */
    done() {
      st.finished = true;
      this.update(100, 'الملزمة جاهزة');
    },
    close() { s.close(); },
  };
}
