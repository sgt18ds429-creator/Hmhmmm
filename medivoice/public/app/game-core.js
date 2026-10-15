// game-core.js — محرك «سباق ميدي فويز» ورسمه.
// يعمل داخل عامل خلفي على OffscreenCanvas (فلا يتأثر بعمل التحويل في الصفحة: الإطارات ثابتة حتى لو انشغلت)،
// أو في الصفحة نفسها على المتصفحات التي لا تدعم ذلك. لا يعتمد على DOM: النصوص والأزرار في الصفحة (game.js).
// الرسوم الثابتة (السماء والمدينة والسيارات والنجوم والقوى) تُرسم مرة واحدة بدقة الشاشة ثم تُنسخ في كل إطار.

const LANES = 3;
const TAU = Math.PI * 2;
const CAR_COLORS = ['#ffb547', '#6fe3b4', '#ff7a8a', '#7cc8ff', '#ffd166', '#c9b8ff'];
const POWER_COLORS = { shield: '#7cc8ff', magnet: '#ffb547', nitro: '#ff7a8a' };
const POWER_MS = { magnet: 9000, nitro: 3200 };
const PLAYER_Z = 0.9;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** لون أفتح أو أغمق (k بين -1 و 1) */
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

function surface(w, hh) {
  w = Math.max(1, Math.ceil(w)); hh = Math.max(1, Math.ceil(hh));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, hh);
  const c = document.createElement('canvas');
  c.width = w; c.height = hh;
  return c;
}

function rrect(x, left, top, w, hh, r) {
  r = Math.max(0, Math.min(r, w / 2, hh / 2));
  x.beginPath();
  x.moveTo(left + r, top);
  x.arcTo(left + w, top, left + w, top + hh, r);
  x.arcTo(left + w, top + hh, left, top + hh, r);
  x.arcTo(left, top + hh, left, top, r);
  x.arcTo(left, top, left + w, top, r);
  x.closePath();
}

/**
 * @param canvas HTMLCanvasElement أو OffscreenCanvas
 * @param emit (رسالة) → للصفحة: hud (النقاط والقوى)، mode (جاهز/اصطدام)، buzz (اهتزاز)، best (رقم قياسي)
 */
export function createRace(canvas, { emit = () => {}, best = 0, reduced = false } = {}) {
  const g = canvas.getContext('2d', { alpha: false });
  let W = 0, H = 0, dpr = 1, horizon = 0, roadBottom = 0, roadTop = 0;
  let sky = null, skyPad = 0, sprites = null, roadFill = null, groundFill = null;

  const st = {
    mode: 'ready', finished: false,
    lane: 1, x: 0, speed: 0, dist: 0, bonus: 0, time: 0, combo: 1, streak: 0,
    best, newBest: false,
    cars: [], items: [], sparks: [], flags: [], texts: [],
    dash: 0, spawnIn: 0, itemIn: 0, shake: 0, flash: 0, shield: false, magnetUntil: 0, nitroUntil: 0, hitSlow: 0,
    lastFlagPct: 0, clock: 0,
  };
  // الوقت داخل اللعبة (يتوقف مع الإيقاف المؤقت فلا تنتهي القوى والصفحة مخفية)
  const now = () => st.clock * 1000;
  const nitro = () => now() < st.nitroUntil;
  const magnet = () => now() < st.magnetUntil;
  const score = () => Math.floor(st.dist * 5) + st.bonus;

  // ── المنظور: z من 0 (الأفق) إلى 1 (أسفل الشاشة) ──
  const yOf = (z) => horizon + (H - horizon) * Math.pow(z, 1.55);
  const halfRoad = (z) => roadTop + (roadBottom - roadTop) * Math.pow(z, 1.55);
  const scaleOf = (z) => 0.16 + 0.84 * Math.pow(z, 1.35);
  const laneOffset = (lane) => (lane - (LANES - 1) / 2) / LANES * 2;
  const xOf = (lane, z) => W / 2 + laneOffset(lane) * halfRoad(z);
  const carW = (z) => roadBottom * 0.36 * scaleOf(z);

  // ── الرسوم الجاهزة ──
  function makeSky() {
    skyPad = Math.round(W * 0.06);
    const sw = W + skyPad * 2, sh = horizon + 2;
    const c = surface(sw * dpr, sh * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    const grad = x.createLinearGradient(0, 0, 0, sh);
    grad.addColorStop(0, '#080314'); grad.addColorStop(0.55, '#1a0c3f'); grad.addColorStop(1, '#3a1569');
    x.fillStyle = grad; x.fillRect(0, 0, sw, sh);
    // نجوم ثابتة البذرة (نفس السماء كل مرة)
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 70; i++) {
      const sx = r() * sw, sy = r() * sh * 0.8, s = r() < 0.15 ? 1.6 : 1;
      x.fillStyle = `rgba(244, 240, 255, ${0.25 + r() * 0.6})`;
      x.fillRect(sx, sy, s, s);
    }
    // توهج الأفق
    const glow = x.createRadialGradient(sw / 2, sh, 4, sw / 2, sh, sw * 0.62);
    glow.addColorStop(0, 'rgba(201, 35, 193, 0.65)'); glow.addColorStop(0.45, 'rgba(133, 33, 213, 0.22)'); glow.addColorStop(1, 'rgba(84, 51, 236, 0)');
    x.fillStyle = glow; x.fillRect(0, 0, sw, sh);
    // شمس الأفق بخطوط
    const sunR = Math.min(sw * 0.17, sh * 0.62), sunY = sh - 2;
    const sun = x.createLinearGradient(0, sunY - sunR, 0, sunY);
    sun.addColorStop(0, '#ffd166'); sun.addColorStop(0.55, '#ff7a8a'); sun.addColorStop(1, '#c923c1');
    x.save();
    x.beginPath(); x.arc(sw / 2, sunY, sunR, Math.PI, 0); x.closePath(); x.clip();
    x.fillStyle = sun; x.fillRect(sw / 2 - sunR, sunY - sunR, sunR * 2, sunR);
    x.fillStyle = '#2c1158';
    for (let i = 0; i < 6; i++) { const yy = sunY - sunR * (0.08 + i * 0.12); x.fillRect(sw / 2 - sunR, yy, sunR * 2, 1 + i * 0.7); }
    x.restore();
    // جبال بعيدة ثم مدينة قريبة بنوافذ مضاءة
    x.fillStyle = '#25114f';
    x.beginPath(); x.moveTo(0, sh);
    for (let px = 0; px <= sw; px += sw / 12) x.lineTo(px, sh - sh * (0.12 + 0.18 * Math.abs(Math.sin(px * 0.013 + 1.3))));
    x.lineTo(sw, sh); x.closePath(); x.fill();
    let bx = 0;
    while (bx < sw) {
      const bw = 10 + r() * 22, bh = sh * (0.08 + r() * 0.3);
      if (Math.abs(bx + bw / 2 - sw / 2) > sunR * 0.75 || r() < 0.3) {
        x.fillStyle = '#140934'; x.fillRect(bx, sh - bh, bw, bh);
        for (let wy = sh - bh + 4; wy < sh - 3; wy += 5) {
          for (let wx = bx + 3; wx < bx + bw - 3; wx += 5) {
            if (r() < 0.22) { x.fillStyle = r() < 0.7 ? 'rgba(255, 209, 102, 0.75)' : 'rgba(124, 200, 255, 0.7)'; x.fillRect(wx, wy, 1.6, 1.6); }
          }
        }
      }
      bx += bw + r() * 6;
    }
    return c;
  }

  function carSprite(color, len, kind) {
    const w = carW(1.08), hh = w * (0.62 / 0.36) * len;
    const pad = w * 0.32;
    const c = surface((w + pad * 2) * dpr, (hh + pad * 2) * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr); x.translate(pad, pad);
    // ظل على الطريق
    x.fillStyle = 'rgba(0, 0, 0, 0.42)';
    x.beginPath(); x.ellipse(w / 2, hh * 0.98, w * 0.6, Math.min(hh * 0.12, w * 0.2), 0, 0, TAU); x.fill();
    // العجلات
    x.fillStyle = '#06030c';
    for (const wy of [0.14, 0.68]) { rrect(x, -w * 0.06, hh * wy, w * 0.2, hh * 0.18, w * 0.05); x.fill(); rrect(x, w * 0.86, hh * wy, w * 0.2, hh * 0.18, w * 0.05); x.fill(); }
    if (kind === 'truck') {
      // مقصورة ثم صندوق شحن
      const cab = x.createLinearGradient(0, 0, w, 0);
      cab.addColorStop(0, shade(color, -0.4)); cab.addColorStop(0.2, color); cab.addColorStop(0.8, color); cab.addColorStop(1, shade(color, -0.4));
      x.fillStyle = cab; rrect(x, w * 0.04, 0, w * 0.92, hh * 0.3, w * 0.22); x.fill();
      x.fillStyle = 'rgba(160, 190, 255, 0.4)'; rrect(x, w * 0.18, hh * 0.05, w * 0.64, hh * 0.1, w * 0.06); x.fill();
      const box = x.createLinearGradient(0, 0, w, 0);
      box.addColorStop(0, '#9c93b8'); box.addColorStop(0.15, '#e9e4f7'); box.addColorStop(0.85, '#e9e4f7'); box.addColorStop(1, '#9c93b8');
      x.fillStyle = box; rrect(x, 0, hh * 0.27, w, hh * 0.73, w * 0.08); x.fill();
      x.fillStyle = color; x.fillRect(0, hh * 0.52, w, hh * 0.06);
      x.strokeStyle = 'rgba(40, 30, 70, 0.35)'; x.lineWidth = 1;
      for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(w * i / 4, hh * 0.62); x.lineTo(w * i / 4, hh * 0.95); x.stroke(); }
    } else {
      const body = x.createLinearGradient(0, 0, w, 0);
      body.addColorStop(0, shade(color, -0.42)); body.addColorStop(0.16, color); body.addColorStop(0.84, color); body.addColorStop(1, shade(color, -0.42));
      x.fillStyle = body; rrect(x, 0, 0, w, hh, w * 0.3); x.fill();
      const hl = x.createLinearGradient(0, 0, 0, hh);
      hl.addColorStop(0, 'rgba(255, 255, 255, 0.38)'); hl.addColorStop(0.28, 'rgba(255, 255, 255, 0)');
      x.fillStyle = hl; rrect(x, 0, 0, w, hh, w * 0.3); x.fill();
      // سقف وزجاج
      x.fillStyle = shade(color, -0.2); rrect(x, w * 0.14, hh * 0.24, w * 0.72, hh * 0.48, w * 0.2); x.fill();
      x.fillStyle = 'rgba(170, 200, 255, 0.42)'; rrect(x, w * 0.2, hh * 0.26, w * 0.6, hh * 0.12, w * 0.08); x.fill();
      const glass = x.createLinearGradient(0, hh * 0.56, 0, hh * 0.72);
      glass.addColorStop(0, '#221a3f'); glass.addColorStop(1, '#0a0716');
      x.fillStyle = glass; rrect(x, w * 0.18, hh * 0.56, w * 0.64, hh * 0.15, w * 0.08); x.fill();
      x.fillStyle = 'rgba(255, 255, 255, 0.22)'; x.fillRect(w * 0.24, hh * 0.585, w * 0.3, hh * 0.018);
    }
    // أضواء خلفية متوهجة ولوحة
    x.shadowColor = '#ff2d55'; x.shadowBlur = w * 0.3; x.fillStyle = '#ff5470';
    rrect(x, w * 0.07, hh * 0.875, w * 0.25, hh * 0.055, 2); x.fill();
    rrect(x, w * 0.68, hh * 0.875, w * 0.25, hh * 0.055, 2); x.fill();
    x.shadowBlur = 0;
    x.fillStyle = 'rgba(255, 255, 255, 0.6)'; x.fillRect(w * 0.4, hh * 0.9, w * 0.2, hh * 0.045);
    return { img: c, w: w + pad * 2, h: hh + pad * 2, cw: w, ch: hh, pad };
  }

  function playerSprite() {
    const w = carW(PLAYER_Z), hh = w * (0.62 / 0.36);
    const pad = w * 0.35;
    const c = surface((w + pad * 2) * dpr, (hh + pad * 2) * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr); x.translate(pad, pad);
    x.fillStyle = 'rgba(0, 0, 0, 0.45)';
    x.beginPath(); x.ellipse(w / 2, hh * 0.98, w * 0.62, w * 0.2, 0, 0, TAU); x.fill();
    x.fillStyle = '#06030c';
    for (const wy of [0.12, 0.68]) { rrect(x, -w * 0.07, hh * wy, w * 0.21, hh * 0.19, w * 0.05); x.fill(); rrect(x, w * 0.86, hh * wy, w * 0.21, hh * 0.19, w * 0.05); x.fill(); }
    const body = x.createLinearGradient(0, 0, w, hh);
    body.addColorStop(0, '#5433ec'); body.addColorStop(0.55, '#8521d5'); body.addColorStop(1, '#c923c1');
    x.fillStyle = body; rrect(x, 0, 0, w, hh, w * 0.32); x.fill();
    const side = x.createLinearGradient(0, 0, w, 0);
    side.addColorStop(0, 'rgba(0, 0, 0, 0.35)'); side.addColorStop(0.18, 'rgba(0, 0, 0, 0)'); side.addColorStop(0.82, 'rgba(0, 0, 0, 0)'); side.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
    x.fillStyle = side; rrect(x, 0, 0, w, hh, w * 0.32); x.fill();
    // خطا السباق
    x.fillStyle = 'rgba(244, 240, 255, 0.85)';
    x.fillRect(w * 0.4, 0, w * 0.07, hh); x.fillRect(w * 0.53, 0, w * 0.07, hh);
    // زجاج أمامي (أعلى) وخلفي
    x.fillStyle = 'rgba(244, 240, 255, 0.9)'; rrect(x, w * 0.16, hh * 0.2, w * 0.68, hh * 0.13, w * 0.1); x.fill();
    const glass = x.createLinearGradient(0, hh * 0.6, 0, hh * 0.74);
    glass.addColorStop(0, '#2a1d55'); glass.addColorStop(1, '#0d0820');
    x.fillStyle = glass; rrect(x, w * 0.18, hh * 0.6, w * 0.64, hh * 0.13, w * 0.08); x.fill();
    // جناح خلفي
    x.fillStyle = '#1a0f38'; rrect(x, -w * 0.04, hh * 0.84, w * 1.08, hh * 0.07, 3); x.fill();
    x.shadowColor = '#ff2d55'; x.shadowBlur = w * 0.32; x.fillStyle = '#ff5470';
    rrect(x, w * 0.06, hh * 0.92, w * 0.26, hh * 0.05, 2); x.fill();
    rrect(x, w * 0.68, hh * 0.92, w * 0.26, hh * 0.05, 2); x.fill();
    x.shadowBlur = 0;
    return { img: c, w: w + pad * 2, h: hh + pad * 2, cw: w, ch: hh, pad };
  }

  function coneSprite() {
    const w = carW(1.08) * 0.5, hh = w * 1.3;
    const pad = w * 0.3;
    const c = surface((w + pad * 2) * dpr, (hh + pad * 2) * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr); x.translate(pad, pad);
    x.fillStyle = 'rgba(0, 0, 0, 0.4)'; x.beginPath(); x.ellipse(w / 2, hh, w * 0.62, w * 0.18, 0, 0, TAU); x.fill();
    x.fillStyle = '#2b1a0a'; rrect(x, 0, hh * 0.86, w, hh * 0.14, 3); x.fill();
    const body = x.createLinearGradient(0, 0, w, 0);
    body.addColorStop(0, '#c4561c'); body.addColorStop(0.4, '#ff9a4d'); body.addColorStop(1, '#c4561c');
    x.fillStyle = body; x.beginPath(); x.moveTo(w * 0.5, 0); x.lineTo(w * 0.85, hh * 0.88); x.lineTo(w * 0.15, hh * 0.88); x.closePath(); x.fill();
    x.fillStyle = '#fff'; x.beginPath(); x.moveTo(w * 0.36, hh * 0.42); x.lineTo(w * 0.64, hh * 0.42); x.lineTo(w * 0.7, hh * 0.58); x.lineTo(w * 0.3, hh * 0.58); x.closePath(); x.fill();
    return { img: c, w: w + pad * 2, h: hh + pad * 2, cw: w, ch: hh, pad };
  }

  function itemSprite(kind) {
    const r = carW(1.08) * 0.3;
    const pad = r * 1.1;
    const size = (r + pad) * 2;
    const c = surface(size * dpr, size * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr); x.translate(size / 2, size / 2);
    const color = kind === 'star' ? '#ffb547' : POWER_COLORS[kind];
    const halo = x.createRadialGradient(0, 0, r * 0.3, 0, 0, r + pad);
    halo.addColorStop(0, `${color}88`); halo.addColorStop(1, `${color}00`);
    x.fillStyle = halo; x.beginPath(); x.arc(0, 0, r + pad, 0, TAU); x.fill();
    if (kind === 'star') {
      const fill = x.createLinearGradient(0, -r, 0, r);
      fill.addColorStop(0, '#fff1c2'); fill.addColorStop(0.5, '#ffc04d'); fill.addColorStop(1, '#ff8f3d');
      x.fillStyle = fill;
      x.beginPath();
      for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU - Math.PI / 2; const rr = i % 2 ? r * 0.46 : r; x.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      x.closePath(); x.fill();
      x.strokeStyle = 'rgba(255, 255, 255, 0.85)'; x.lineWidth = Math.max(1, r * 0.08); x.stroke();
    } else {
      const disc = x.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
      disc.addColorStop(0, shade(color, 0.45)); disc.addColorStop(1, shade(color, -0.25));
      x.fillStyle = disc; x.beginPath(); x.arc(0, 0, r, 0, TAU); x.fill();
      x.strokeStyle = 'rgba(255, 255, 255, 0.9)'; x.lineWidth = Math.max(1, r * 0.1); x.stroke();
      x.fillStyle = '#0a0618'; x.strokeStyle = '#0a0618';
      if (kind === 'shield') {
        x.beginPath(); x.moveTo(0, -r * 0.6); x.lineTo(r * 0.52, -r * 0.32); x.lineTo(r * 0.42, r * 0.24); x.lineTo(0, r * 0.62); x.lineTo(-r * 0.42, r * 0.24); x.lineTo(-r * 0.52, -r * 0.32); x.closePath(); x.fill();
      } else if (kind === 'magnet') {
        x.lineWidth = r * 0.3; x.lineCap = 'butt';
        x.beginPath(); x.arc(0, -r * 0.05, r * 0.4, Math.PI, 0); x.moveTo(-r * 0.4, -r * 0.05); x.lineTo(-r * 0.4, r * 0.48); x.moveTo(r * 0.4, -r * 0.05); x.lineTo(r * 0.4, r * 0.48); x.stroke();
      } else {
        x.beginPath(); x.moveTo(r * 0.16, -r * 0.66); x.lineTo(-r * 0.4, r * 0.1); x.lineTo(0, r * 0.1); x.lineTo(-r * 0.16, r * 0.66); x.lineTo(r * 0.4, -r * 0.1); x.lineTo(0, -r * 0.1); x.closePath(); x.fill();
      }
    }
    return { img: c, size, r };
  }

  function glowSprite(color, radius) {
    const c = surface(radius * 2 * dpr, radius * 2 * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    const gr = x.createRadialGradient(radius, radius, 0, radius, radius, radius);
    gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(0, 0, 0, 0)');
    x.fillStyle = gr; x.fillRect(0, 0, radius * 2, radius * 2);
    return { img: c, radius };
  }

  function beamSprite() {
    // ضوء المصابيح الأمامية على الطريق أمام سيارة اللاعب
    const w = carW(PLAYER_Z) * 1.6, hh = (yOf(PLAYER_Z) - yOf(0.55));
    const c = surface(w * dpr, Math.max(4, hh) * dpr);
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    const gr = x.createLinearGradient(0, hh, 0, 0);
    gr.addColorStop(0, 'rgba(255, 236, 190, 0.2)'); gr.addColorStop(1, 'rgba(255, 236, 190, 0)');
    x.fillStyle = gr;
    x.beginPath(); x.moveTo(w * 0.3, hh); x.lineTo(w * 0.7, hh); x.lineTo(w, 0); x.lineTo(0, 0); x.closePath(); x.fill();
    return { img: c, w, h: hh };
  }

  function buildSprites() {
    sky = makeSky();
    const cars = {};
    for (const color of CAR_COLORS) { cars[color] = carSprite(color, 1, 'car'); cars[`t${color}`] = carSprite(color, 1.7, 'truck'); }
    sprites = {
      cars, cone: coneSprite(), player: playerSprite(), beam: beamSprite(),
      star: itemSprite('star'), shield: itemSprite('shield'), magnet: itemSprite('magnet'), nitro: itemSprite('nitro'),
      lamp: glowSprite('rgba(255, 209, 102, 0.55)', Math.max(8, roadBottom * 0.14)),
    };
    roadFill = g.createLinearGradient(0, horizon, 0, H);
    roadFill.addColorStop(0, '#150d2e'); roadFill.addColorStop(1, '#271c47');
    groundFill = g.createLinearGradient(0, horizon, 0, H);
    groundFill.addColorStop(0, '#1d0b3c'); groundFill.addColorStop(1, '#0b0619');
  }

  function resize(w, hh, ratio) {
    if (!w || !hh) return;
    W = w; H = hh; dpr = Math.max(1, Math.min(2, ratio || 1));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    horizon = H * 0.22;
    roadBottom = Math.min(W * 0.5, 280);
    roadTop = roadBottom * 0.12;
    st.x = laneOffset(st.lane);
    buildSprites();
    draw();
  }

  // ── اللعب ──
  function reset() {
    Object.assign(st, {
      mode: 'run', lane: 1, x: laneOffset(1), speed: 0.55, dist: 0, bonus: 0, time: 0, combo: 1, streak: 0, newBest: false,
      cars: [], items: [], sparks: [], flags: [], texts: [], spawnIn: 1.1, itemIn: 1.8, shake: 0, flash: 0, shield: false, magnetUntil: 0, nitroUntil: 0, hitSlow: 0,
    });
    emit({ type: 'mode', mode: 'run' });
    hud(true);
  }
  function move(dir) { if (st.mode === 'run' && !st.finished) st.lane = Math.max(0, Math.min(LANES - 1, st.lane + dir)); }
  function tap() { if (!st.finished && st.mode !== 'run') reset(); }

  const laneBusy = (zMax) => new Set(st.cars.filter((c) => c.z < zMax).map((c) => c.lane));
  function spawnCar() {
    const busy = laneBusy(0.35);
    const open = [...Array(LANES).keys()].filter((i) => !busy.has(i));
    if (open.length <= 1) return; // يبقى مسار مفتوح دائماً
    const r = Math.random();
    const kind = r < 0.18 ? 'truck' : r < 0.36 ? 'cone' : 'car';
    st.cars.push({ lane: pick(open), z: 0, kind, color: pick(CAR_COLORS), len: kind === 'truck' ? 1.7 : kind === 'cone' ? 0.45 : 1, v: kind === 'cone' ? 0 : 0.28 + Math.random() * 0.12 });
  }
  function spawnItem() {
    const busy = laneBusy(0.3);
    const open = [...Array(LANES).keys()].filter((i) => !busy.has(i));
    if (!open.length) return;
    const r = Math.random();
    st.items.push({ lane: pick(open), z: 0, kind: r < 0.78 ? 'star' : r < 0.87 ? 'shield' : r < 0.94 ? 'magnet' : 'nitro', spin: Math.random() * TAU });
  }
  function sparkle(x, y, color, n = 12) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random();
      const v = rnd(90, 200);
      st.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(0.35, 0.65), color });
    }
  }
  function floatText(text, x, y, color) { st.texts.push({ text, x, y, life: 1, color }); }

  function crash(c) {
    if (nitro()) { sparkle(xOf(c.lane, c.z), yOf(c.z), '#ff7a8a', 16); c.dead = true; st.bonus += 15; return; }
    if (st.shield) { st.shield = false; st.flash = 0.5; st.shake = reduced ? 0 : 0.5; c.dead = true; floatText('الدرع حماك', W / 2, H * 0.5, '#7cc8ff'); emit({ type: 'buzz', ms: 40 }); hud(true); return; }
    st.mode = 'over'; st.shake = reduced ? 0 : 1; st.flash = 1;
    const sc = score();
    st.newBest = sc > st.best;
    if (st.newBest) { st.best = sc; emit({ type: 'best', best: sc }); }
    emit({ type: 'buzz', ms: 90 });
    emit({ type: 'mode', mode: 'over', score: sc, best: st.best, newBest: st.newBest });
    hud(true);
  }
  /** سباق انتهى بجاهزية الملزمة أو بإغلاق اللعبة (لا باصطدام): رقمه القياسي يُحفظ أيضاً */
  function keepBest() {
    if (st.mode !== 'run' || st.finished) return;
    const sc = score();
    if (sc > st.best) { st.best = sc; emit({ type: 'best', best: sc }); }
  }
  function bump() {
    st.hitSlow = 0.9; st.shake = reduced ? 0 : 0.35; st.combo = 1; st.streak = 0;
    floatText('قمع! ضاع المضاعف', W / 2, H * 0.56, '#ff7a8a');
    emit({ type: 'buzz', ms: 25 });
  }
  function take(it) {
    it.taken = true;
    const x = xOf(it.lane, it.z), y = yOf(it.z);
    if (it.kind === 'star') {
      st.streak++;
      if (st.streak % 5 === 0 && st.combo < 5) { st.combo++; floatText(`×${st.combo}`, x, y - 24, '#c4b3ff'); }
      const v = 25 * st.combo;
      st.bonus += v;
      floatText(`+${v}`, x, y, '#ffd166');
      sparkle(x, y, '#ffb547');
    } else {
      if (it.kind === 'shield') st.shield = true;
      else if (it.kind === 'magnet') st.magnetUntil = now() + POWER_MS.magnet;
      else st.nitroUntil = now() + POWER_MS.nitro;
      floatText(it.kind === 'shield' ? 'درع' : it.kind === 'magnet' ? 'مغناطيس' : 'نيترو', x, y, POWER_COLORS[it.kind]);
      sparkle(x, y, POWER_COLORS[it.kind], 16);
    }
    hud(true);
  }

  function update(dt) {
    st.clock += dt;
    st.shake = Math.max(0, st.shake - dt * 2.5);
    st.flash = Math.max(0, st.flash - dt * 2);
    for (const p of st.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 320 * dt; p.life -= dt; }
    st.sparks = st.sparks.filter((p) => p.life > 0);
    for (const t of st.texts) { t.y -= 42 * dt; t.life -= dt * 0.9; }
    st.texts = st.texts.filter((t) => t.life > 0);
    const idle = st.mode !== 'run' || st.finished;
    const base = idle ? 0.14 : st.speed;
    st.dash = (st.dash + base * dt * 1.3) % 1;
    for (const f of st.flags) f.z += base * dt;
    st.flags = st.flags.filter((f) => f.z < 1.12);
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
      if (magnet() && it.kind === 'star' && it.z > 0.55) it.lane += (st.lane - it.lane) * Math.min(1, dt * 6);
    }
    st.items = st.items.filter((it) => it.z < 1.1 && !it.taken);

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
    hud(false);
  }

  // ── لوحة النقاط تُرسل للصفحة عند التغيّر فقط (وبحد أقصى 8 مرات بالثانية) ──
  let lastHud = '', lastHudAt = -1;
  function hud(force) {
    if (!force && st.clock - lastHudAt < 0.12) return;
    lastHudAt = st.clock;
    const powers = [];
    if (st.shield) powers.push({ kind: 'shield' });
    if (magnet()) powers.push({ kind: 'magnet', left: Math.ceil((st.magnetUntil - now()) / 1000) });
    if (nitro()) powers.push({ kind: 'nitro' });
    const data = { score: score(), best: st.best, combo: st.combo, powers };
    const key = JSON.stringify(data);
    if (key === lastHud) return;
    lastHud = key;
    emit({ type: 'hud', ...data });
  }

  // ── الرسم ──
  function road() {
    // السماء والمدينة (تتحرك قليلاً مع المسار)
    const shift = -st.x * skyPad * 0.8 - skyPad;
    g.drawImage(sky, 0, 0, sky.width, sky.height, shift, 0, W + skyPad * 2, horizon + 2);
    g.fillStyle = groundFill; g.fillRect(0, horizon, W, H - horizon);
    // شبكة الأرض على الجانبين: خطوط عرضية تقترب، وخطوط طولية من نقطة الأفق
    g.strokeStyle = 'rgba(201, 35, 193, 0.28)'; g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const z = (i + st.dash) / 10;
      const y = yOf(z);
      g.moveTo(0, y); g.lineTo(W / 2 - halfRoad(z), y);
      g.moveTo(W / 2 + halfRoad(z), y); g.lineTo(W, y);
    }
    for (let k = 1; k <= 5; k++) {
      const spread = 1 + k * 0.55;
      g.moveTo(W / 2 - roadTop * spread, horizon); g.lineTo(W / 2 - roadBottom * spread * 1.15, H);
      g.moveTo(W / 2 + roadTop * spread, horizon); g.lineTo(W / 2 + roadBottom * spread * 1.15, H);
    }
    g.stroke();
    // جسم الطريق
    g.fillStyle = roadFill;
    g.beginPath(); g.moveTo(W / 2 - roadTop, horizon); g.lineTo(W / 2 + roadTop, horizon); g.lineTo(W / 2 + roadBottom, H); g.lineTo(W / 2 - roadBottom, H); g.closePath(); g.fill();
    // حافة متوهجة
    g.lineWidth = 6; g.strokeStyle = 'rgba(201, 35, 193, 0.25)';
    g.beginPath(); g.moveTo(W / 2 - roadTop, horizon); g.lineTo(W / 2 - roadBottom, H); g.moveTo(W / 2 + roadTop, horizon); g.lineTo(W / 2 + roadBottom, H); g.stroke();
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(255, 140, 240, 0.9)'; g.stroke();
    // أشرطة الحافة وخطوط المسارات تتحرك نحو اللاعب
    const steps = 16;
    for (let i = 0; i < steps; i++) {
      const z0 = (i + st.dash) / steps, z1 = (i + st.dash + 0.5) / steps;
      if (z0 > 1.05) continue;
      const y0 = yOf(z0), y1 = yOf(Math.min(1.1, z1)), h0 = halfRoad(z0), h1 = halfRoad(Math.min(1.1, z1));
      const e0 = 6 * scaleOf(z0), e1 = 6 * scaleOf(Math.min(1.1, z1));
      g.fillStyle = i % 2 ? '#c923c1' : '#f4f0ff';
      g.beginPath(); g.moveTo(W / 2 - h0 - e0, y0); g.lineTo(W / 2 - h0, y0); g.lineTo(W / 2 - h1, y1); g.lineTo(W / 2 - h1 - e1, y1); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(W / 2 + h0 + e0, y0); g.lineTo(W / 2 + h0, y0); g.lineTo(W / 2 + h1, y1); g.lineTo(W / 2 + h1 + e1, y1); g.closePath(); g.fill();
      if (i % 2 === 0) {
        g.fillStyle = 'rgba(244, 240, 255, 0.55)';
        for (let l = 1; l < LANES; l++) {
          const off = (l / LANES) * 2 - 1;
          const x0 = W / 2 + off * h0, x1 = W / 2 + off * h1;
          const t0 = 1.6 * scaleOf(z0), t1 = 1.6 * scaleOf(Math.min(1.1, z1));
          g.beginPath(); g.moveTo(x0 - t0, y0); g.lineTo(x0 + t0, y0); g.lineTo(x1 + t1, y1); g.lineTo(x1 - t1, y1); g.closePath(); g.fill();
        }
      }
    }
    // أعمدة إنارة مع توهج
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const z = (i + st.dash * 0.5) / 6;
      if (z > 1.02) continue;
      const y = yOf(z), hr = halfRoad(z), k = scaleOf(z), top = y - 74 * k;
      const lr = sprites.lamp.radius * k * 1.6;
      g.drawImage(sprites.lamp.img, W / 2 - hr - 30 * k - lr, top - lr, lr * 2, lr * 2);
      g.drawImage(sprites.lamp.img, W / 2 + hr + 30 * k - lr, top - lr, lr * 2, lr * 2);
    }
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 6; i++) {
      const z = (i + st.dash * 0.5) / 6;
      if (z > 1.02) continue;
      const y = yOf(z), hr = halfRoad(z), k = scaleOf(z);
      g.fillStyle = 'rgba(196, 179, 255, 0.45)';
      g.fillRect(W / 2 - hr - 31.5 * k, y - 74 * k, 3 * k, 74 * k); g.fillRect(W / 2 + hr + 28.5 * k, y - 74 * k, 3 * k, 74 * k);
      g.fillStyle = '#ffe2a0';
      g.fillRect(W / 2 - hr - 36 * k, y - 76 * k, 12 * k, 4 * k); g.fillRect(W / 2 + hr + 24 * k, y - 76 * k, 12 * k, 4 * k);
    }
    // ضوء مصابيح اللاعب على الطريق (تحت السيارات كلها)
    const pcx = W / 2 + st.x * halfRoad(PLAYER_Z), pBottom = yOf(PLAYER_Z) + sprites.player.ch * 0.5;
    const beam = sprites.beam;
    g.globalCompositeOperation = 'lighter';
    g.drawImage(beam.img, pcx - beam.w / 2, pBottom - sprites.player.ch - beam.h, beam.w, beam.h);
    g.globalCompositeOperation = 'source-over';
    if (nitro()) {
      g.strokeStyle = 'rgba(255, 122, 138, 0.35)'; g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU + st.clock * 3;
        g.moveTo(W / 2 + Math.cos(a) * W * 0.28, horizon + Math.sin(a) * H * 0.28);
        g.lineTo(W / 2 + Math.cos(a) * W * 0.95, horizon + Math.sin(a) * H * 0.95);
      }
      g.stroke();
    }
  }

  function drawSprite(sp, cx, bottomY, k, rot = 0) {
    const s = k / scaleOf(sp === sprites.player ? PLAYER_Z : 1.08);
    const w = sp.w * s, hh = sp.h * s;
    const left = cx - w / 2, top = bottomY - (sp.pad + sp.ch) * s;
    if (!rot) { g.drawImage(sp.img, left, top, w, hh); return; }
    g.save();
    g.translate(cx, top + hh / 2); g.rotate(rot);
    g.drawImage(sp.img, -w / 2, -hh / 2, w, hh);
    g.restore();
  }

  function drawCar(c) {
    const k = scaleOf(c.z);
    const sp = c.kind === 'cone' ? sprites.cone : sprites.cars[c.kind === 'truck' ? `t${c.color}` : c.color];
    // أسفل السيارة عند عمقها، ونصف طولها خلفه
    const len = carW(c.z) * (0.62 / 0.36) * c.len;
    drawSprite(sp, xOf(c.lane, c.z), yOf(c.z) + len * 0.5, k);
  }

  function drawItem(it) {
    const sp = sprites[it.kind];
    const k = scaleOf(it.z) / scaleOf(1.08);
    const size = sp.size * k;
    const x = xOf(it.lane, it.z), y = yOf(it.z) - sp.r * k * 0.4;
    const bob = Math.sin(it.spin * 1.4) * 3 * k;
    if (it.kind === 'star') {
      g.save(); g.translate(x, y + bob); g.rotate(Math.sin(it.spin * 0.6) * 0.35);
      g.drawImage(sp.img, -size / 2, -size / 2, size, size);
      g.restore();
    } else g.drawImage(sp.img, x - size / 2, y - size / 2 + bob, size, size);
  }

  function drawFlag(f) {
    const z = f.z, y = yOf(z), hr = halfRoad(z), k = scaleOf(z);
    const top = y - 66 * k, left = W / 2 - hr - 12 * k, right = W / 2 + hr + 12 * k;
    g.fillStyle = 'rgba(111, 227, 180, 0.9)';
    g.fillRect(left - 2 * k, top, 4 * k, y - top); g.fillRect(right - 2 * k, top, 4 * k, y - top);
    g.fillStyle = 'rgba(16, 60, 48, 0.85)';
    g.fillRect(left, top, right - left, 20 * k);
    g.fillStyle = '#6fe3b4';
    g.fillRect(left, top + 18 * k, right - left, 2 * k);
    g.font = `700 ${Math.max(9, Math.round(15 * k))}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#eafff6';
    g.fillText(`${f.pct}%`, W / 2, top + 10 * k);
    g.fillStyle = `rgba(111, 227, 180, ${0.3 * Math.min(1, z * 1.5)})`;
    g.fillRect(W / 2 - hr, y - 2 * k, hr * 2, 4 * k);
  }

  function drawPlayer() {
    const k = scaleOf(PLAYER_Z);
    const cx = W / 2 + st.x * halfRoad(PLAYER_Z);
    const tilt = (laneOffset(st.lane) - st.x) * 0.9;
    const sp = sprites.player;
    const bottom = yOf(PLAYER_Z) + sp.ch * 0.5;
    drawSprite(sp, cx, bottom, k, tilt);
    if (nitro()) {
      g.fillStyle = 'rgba(255, 122, 138, 0.8)';
      for (let i = 0; i < 2; i++) {
        const fx = cx + sp.cw * (i ? 0.22 : -0.22);
        const flame = 14 + Math.random() * 18;
        g.beginPath(); g.moveTo(fx - 5, bottom - 2); g.lineTo(fx + 5, bottom - 2); g.lineTo(fx, bottom + flame); g.closePath(); g.fill();
      }
    }
    if (st.shield) {
      const pulse = 0.65 + Math.sin(st.clock * 6) * 0.25;
      g.strokeStyle = `rgba(124, 200, 255, ${pulse})`; g.lineWidth = 3;
      g.beginPath(); g.ellipse(cx, bottom - sp.ch / 2, sp.cw * 0.85, sp.ch * 0.68, 0, 0, TAU); g.stroke();
    }
  }

  function draw() {
    if (!W || !sprites) return;
    g.save();
    if (st.shake) g.translate((Math.random() - 0.5) * 12 * st.shake, (Math.random() - 0.5) * 12 * st.shake);
    road();
    const layer = [];
    for (const c of st.cars) layer.push({ z: c.z, c });
    for (const it of st.items) layer.push({ z: it.z, it });
    for (const f of st.flags) layer.push({ z: f.z, f });
    layer.sort((a, b) => a.z - b.z);
    let playerDrawn = false;
    for (const o of layer) {
      if (!playerDrawn && o.z > PLAYER_Z) { drawPlayer(); playerDrawn = true; }
      if (o.c) drawCar(o.c); else if (o.it) drawItem(o.it); else drawFlag(o.f);
    }
    if (!playerDrawn) drawPlayer();
    for (const p of st.sparks) { g.globalAlpha = Math.max(0, Math.min(1, p.life * 2)); g.fillStyle = p.color; g.fillRect(p.x - 2, p.y - 2, 4, 4); }
    g.globalAlpha = 1;
    if (st.texts.length) {
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.direction = 'rtl';
      g.font = `800 ${Math.round(Math.max(15, W * 0.048))}px system-ui, sans-serif`;
      for (const t of st.texts) {
        g.globalAlpha = Math.max(0, t.life);
        g.fillStyle = 'rgba(10, 6, 24, 0.6)'; g.fillText(t.text, t.x + 1, t.y + 2);
        g.fillStyle = t.color; g.fillText(t.text, t.x, t.y);
      }
      g.globalAlpha = 1;
    }
    g.restore();
    if (st.flash) { g.fillStyle = `rgba(255, 122, 138, ${st.flash * 0.35})`; g.fillRect(0, 0, W, H); }
    if (st.mode !== 'run' || st.finished) { g.fillStyle = 'rgba(8, 4, 20, 0.45)'; g.fillRect(0, 0, W, H); }
  }

  // ── الحلقة: بمعدل الشاشة، والزمن بين الإطارات محدود حتى لا تقفز اللعبة بعد توقف ──
  const scope = typeof self !== 'undefined' ? self : globalThis;
  const nextFrame = typeof scope.requestAnimationFrame === 'function'
    ? (f) => scope.requestAnimationFrame(f)
    : (f) => setTimeout(() => f(performance.now()), 16);
  let running = true, paused = false, last = 0;
  const frames = [];
  function frame(t) {
    if (!running) return;
    if (!paused) {
      const gap = last ? t - last : 16;
      last = t;
      if (frames.length >= 240) frames.shift();
      frames.push(gap);
      let dt = Math.min(0.05, Math.max(0, gap / 1000));
      // خطوات فيزياء صغيرة ثابتة: الحركة نفسها على شاشة 60 أو 120 هرتز
      while (dt > 0) { const step = Math.min(dt, 1 / 60); update(step); dt -= step; }
      draw();
    }
    nextFrame(frame);
  }
  nextFrame(frame);

  return {
    resize,
    move,
    tap,
    pause(v) { paused = !!v; last = 0; },
    /** تقدم الملزمة: كل 10% تمر بوابة تفتيش تمنح نقاطاً */
    progress(pct) {
      const mark = Math.floor(Math.max(0, Math.min(100, pct)) / 10) * 10;
      if (mark > st.lastFlagPct && mark > 0 && mark < 100) {
        st.lastFlagPct = mark;
        if (st.mode === 'run' && !st.finished) { st.flags.push({ z: 0, pct: mark }); st.bonus += 50; floatText('+50 نقطة تفتيش', W / 2, H * 0.42, '#6fe3b4'); hud(true); }
      }
    },
    finish() { keepBest(); st.finished = true; emit({ type: 'mode', mode: 'finished' }); },
    stats() {
      const f = frames.slice(5).sort((a, b) => a - b);
      return { frames: f.length, p50: f[Math.floor(f.length * 0.5)] || 0, p95: f[Math.floor(f.length * 0.95)] || 0, max: f[f.length - 1] || 0, over50: f.filter((x) => x > 50).length };
    },
    stop() { keepBest(); running = false; },
  };
}
