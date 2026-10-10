// game.js — لعبة سباق بسيطة تُلعب أثناء انتظار الملزمة: سيارتك أسفل الطريق، تتفادى السيارات وتجمع النجوم.
// تفتح في نافذة سفلية فوق شاشة التحويل وتعرض تقدّمه، وتنغلق وحدها عندما تجهز الملزمة.
// خفيفة عمداً (أشكال بسيطة على canvas) حتى لا تبطئ التحويل الذي يعمل بالخلفية.

import { h, sheet } from './ui.js';

const LANES = 3;
const BEST_KEY = 'mv-race-best';
const CAR_COLORS = ['#ffb547', '#6fe3b4', '#ff7a8a', '#7cc8ff', '#f3eeff', '#c9b8ff'];
const FONT = '"IBM Plex Sans Arabic", "IBM Plex Sans", system-ui, sans-serif';

function loadBest() { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } }
function saveBest(v) { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* تخزين غير متاح */ } }

/**
 * @param onClose يُستدعى عند إغلاق اللعبة (بزر الإغلاق أو الرجوع أو عند جاهزية الملزمة)
 * @returns { update(pct, text), done(), close() }
 */
export function openGame({ onClose } = {}) {
  const fill = h('i');
  const pctEl = h('b', { class: 'num' }, '0%');
  const textEl = h('small');
  const bar = h('div', { class: 'game-progress', role: 'status' }, fill, pctEl, textEl);
  const canvas = h('canvas', { class: 'game-canvas', 'aria-label': 'لعبة سباق سيارات: اضغط يمين اللعبة أو يسارها حتى تغيّر المسار' });
  const hint = h('p', { class: 'game-hint' }, 'اضغط يمين اللعبة أو يسارها حتى تغيّر المسار. الملزمة تكمل بالخلفية.');
  const s = sheet({ title: 'سباق لحد ما تجهز الملزمة', body: h('div', { class: 'game' }, bar, canvas, hint), onClose: () => { stop(); onClose?.(); } });
  s.panel.classList.add('game-panel');

  const g = canvas.getContext('2d');
  let W = 0, H = 0, roadX = 0, roadW = 0, laneW = 0, carW = 0, carH = 0, playerY = 0;
  const st = {
    mode: 'ready', finished: false, lane: 1, x: 0, speed: 0, dist: 0, bonus: 0, time: 0,
    best: loadBest(), newBest: false, cars: [], stars: [], sparks: [], dash: 0, spawnIn: 0, starIn: 0, shake: 0, flash: 0,
  };
  let raf = 0, last = 0, running = true;

  const laneX = (i) => roadX + laneW * (i + 0.5);
  const score = () => Math.floor(st.dist / 12) + st.bonus;

  function layout() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    roadW = Math.min(W * 0.82, 380); roadX = (W - roadW) / 2; laneW = roadW / LANES;
    carW = laneW * 0.54; carH = carW * 1.8; playerY = H - carH - Math.max(18, H * 0.06);
    st.x = laneX(st.lane);
  }

  function reset() {
    Object.assign(st, { mode: 'run', lane: 1, x: laneX(1), speed: H * 0.55, dist: 0, bonus: 0, time: 0, newBest: false, cars: [], stars: [], sparks: [], spawnIn: 0.8, starIn: 1.5, shake: 0, flash: 0 });
  }

  function move(dir) {
    if (st.mode === 'run' && !st.finished) st.lane = Math.max(0, Math.min(LANES - 1, st.lane + dir));
  }

  // الضغط على يسار اللعبة يحرك السيارة يساراً، وعلى يمينها يميناً. خارج السباق: يبدأ أو يعيد
  const onPointer = (e) => {
    e.preventDefault();
    if (st.finished) return;
    if (st.mode !== 'run') { reset(); return; }
    const r = canvas.getBoundingClientRect();
    move(e.clientX - r.left < r.width / 2 ? -1 : 1);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { move(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { move(1); e.preventDefault(); }
    else if ((e.key === ' ' || e.key === 'Enter') && st.mode !== 'run' && !st.finished) { reset(); e.preventDefault(); }
  };
  canvas.addEventListener('pointerdown', onPointer);
  addEventListener('keydown', onKey);
  addEventListener('resize', layout);

  // ── الحركة ──
  // كل السيارات الأخرى تنزل بالسرعة نفسها، فلا تلحق سيارةٌ أخرى، ويبقى مسار مفتوح دائماً
  function spawnCar() {
    const busy = new Set(st.cars.filter((c) => c.y < carH * 2.4).map((c) => c.lane));
    const open = [...Array(LANES).keys()].filter((i) => !busy.has(i));
    if (open.length <= 1) return;
    const lane = open[Math.floor(Math.random() * open.length)];
    st.cars.push({ lane, y: -carH * 1.2, color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)] });
  }
  function spawnStar() {
    const busy = new Set(st.cars.filter((c) => c.y < carH * 3).map((c) => c.lane));
    const open = [...Array(LANES).keys()].filter((i) => !busy.has(i));
    if (open.length) st.stars.push({ lane: open[Math.floor(Math.random() * open.length)], y: -30, spin: 0 });
  }
  function sparkle(x, y) {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      st.sparks.push({ x, y, vx: Math.cos(a) * 140, vy: Math.sin(a) * 140, life: 0.5 });
    }
  }
  function crash() {
    st.mode = 'over'; st.shake = 1; st.flash = 1;
    const sc = score();
    st.newBest = sc > st.best;
    if (st.newBest) { st.best = sc; saveBest(sc); }
    try { navigator.vibrate?.(90); } catch { /* غير مدعوم */ }
  }

  function update(dt) {
    st.shake = Math.max(0, st.shake - dt * 2.5);
    st.flash = Math.max(0, st.flash - dt * 2);
    for (const p of st.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    st.sparks = st.sparks.filter((p) => p.life > 0);
    if (st.mode !== 'run' || st.finished) { st.dash = (st.dash + H * 0.12 * dt) % 48; return; }
    st.time += dt;
    st.speed = Math.min(H * 1.5, H * (0.55 + st.time * 0.012));
    st.dist += st.speed * dt;
    st.dash = (st.dash + st.speed * dt) % 48;
    st.x += (laneX(st.lane) - st.x) * Math.min(1, dt * 14);
    st.spawnIn -= dt;
    if (st.spawnIn <= 0) { spawnCar(); st.spawnIn = Math.max(0.42, 1 - st.time * 0.006) * (0.75 + Math.random() * 0.5); }
    st.starIn -= dt;
    if (st.starIn <= 0) { spawnStar(); st.starIn = 1.6 + Math.random() * 1.4; }
    const flow = st.speed * 0.6; // السيارات الأخرى أبطأ منك فتقترب منك
    for (const c of st.cars) c.y += flow * dt;
    for (const s of st.stars) { s.y += st.speed * dt; s.spin += dt * 4; }
    st.cars = st.cars.filter((c) => c.y < H + carH);
    st.stars = st.stars.filter((s) => s.y < H + 40 && !s.taken);
    // صندوق تصادم أصغر قليلاً من الرسم حتى يكون السباق عادلاً
    const inset = carW * 0.12;
    const px = st.x - carW / 2 + inset, pw = carW - inset * 2, py = playerY + carH * 0.06, ph = carH * 0.88;
    for (const c of st.cars) {
      const cx = laneX(c.lane) - carW / 2 + inset;
      if (px < cx + pw && px + pw > cx && py < c.y + ph && py + ph > c.y) { crash(); return; }
    }
    for (const s of st.stars) {
      const sx = laneX(s.lane);
      if (Math.abs(sx - st.x) < carW * 0.7 && s.y > playerY - 10 && s.y < playerY + carH) { s.taken = true; st.bonus += 25; sparkle(sx, s.y); }
    }
  }

  // ── الرسم ──
  function roundRect(x, y, w, hh, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, hh, r);
    else { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  }

  function drawCar(cx, y, color, player) {
    const w = carW, hh = carH, x = cx - w / 2;
    g.fillStyle = 'rgba(0, 0, 0, 0.35)';
    roundRect(x + 3, y + 6, w, hh, w * 0.28); g.fill();
    g.fillStyle = '#05020b';
    const ww = w * 0.16, wh = hh * 0.2;
    for (const wy of [0.14, 0.66]) { g.fillRect(x - ww * 0.35, y + hh * wy, ww, wh); g.fillRect(x + w - ww * 0.65, y + hh * wy, ww, wh); }
    if (player) {
      const gr = g.createLinearGradient(x, y, x + w, y + hh);
      gr.addColorStop(0, '#4d1ace'); gr.addColorStop(0.55, '#7a19c4'); gr.addColorStop(1, '#b01fb0');
      g.fillStyle = gr;
    } else g.fillStyle = color;
    roundRect(x, y, w, hh, w * 0.3); g.fill();
    g.fillStyle = player ? 'rgba(243, 238, 255, 0.88)' : 'rgba(12, 6, 24, 0.72)';
    roundRect(x + w * 0.15, y + hh * 0.2, w * 0.7, hh * 0.2, w * 0.12); g.fill();
    g.fillStyle = 'rgba(12, 6, 24, 0.72)';
    roundRect(x + w * 0.18, y + hh * 0.66, w * 0.64, hh * 0.14, w * 0.1); g.fill();
    g.fillStyle = '#ff5a6e';
    g.fillRect(x + w * 0.12, y + hh - 5, w * 0.2, 3); g.fillRect(x + w * 0.68, y + hh - 5, w * 0.2, 3);
    if (player) {
      g.fillStyle = 'rgba(255, 240, 180, 0.95)';
      g.fillRect(x + w * 0.14, y + 2, w * 0.18, 3); g.fillRect(x + w * 0.68, y + 2, w * 0.18, 3);
    }
  }

  function drawStar(x, y, r, spin) {
    g.save();
    g.translate(x, y); g.rotate(spin * 0.25);
    g.shadowColor = 'rgba(255, 181, 71, 0.8)'; g.shadowBlur = 12;
    g.fillStyle = '#ffb547';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 ? r * 0.45 : r;
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath(); g.fill();
    g.restore();
  }

  function hud() {
    g.textBaseline = 'top';
    g.direction = 'ltr'; g.textAlign = 'left';
    g.font = `700 ${Math.round(Math.max(16, W * 0.05))}px ${FONT}`;
    g.fillStyle = '#f3eeff';
    g.fillText(String(score()), 14, 12);
    g.direction = 'rtl'; g.textAlign = 'right';
    g.font = `500 ${Math.round(Math.max(12, W * 0.034))}px ${FONT}`;
    g.fillStyle = '#bbaedb';
    g.fillText(`الأفضل ${st.best}`, W - 14, 16);
  }

  function overlay() {
    g.fillStyle = 'rgba(12, 6, 24, 0.66)';
    g.fillRect(0, 0, W, H);
    g.direction = 'rtl'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const big = Math.round(Math.max(22, W * 0.075)), small = Math.round(Math.max(13, W * 0.038));
    const lines = st.finished
      ? [['الملزمة جاهزة!', big, '#6fe3b4'], ['أفتحها لك الآن…', small, '#bbaedb']]
      : st.mode === 'ready'
        ? [['سباق المحاضرة', big, '#f3eeff'], ['تفادى السيارات واجمع النجوم', small, '#bbaedb'], ['اضغط حتى تبدأ', small, '#ffb547']]
        : [['اصطدمت!', big, '#ff7a8a'], [`النتيجة ${score()}${st.newBest ? ' · رقم قياسي جديد' : ''}`, small + 2, '#f3eeff'], [`الأفضل ${st.best}`, small, '#bbaedb'], ['اضغط حتى تلعب مرة ثانية', small, '#ffb547']];
    let y = H / 2 - ((lines.length - 1) * small * 1.7) / 2;
    for (const [text, size, color] of lines) {
      g.font = `700 ${size}px ${FONT}`;
      g.fillStyle = color;
      g.fillText(text, W / 2, y);
      y += Math.max(size, small) * 1.7;
    }
  }

  function draw() {
    g.save();
    if (st.shake) g.translate((Math.random() - 0.5) * 12 * st.shake, (Math.random() - 0.5) * 12 * st.shake);
    g.fillStyle = '#0f0820';
    g.fillRect(-12, -12, W + 24, H + 24);
    // علامات على جانبي الطريق تتحرك مع السرعة
    g.fillStyle = 'rgba(183, 156, 255, 0.08)';
    for (let y = -48 + st.dash; y < H; y += 48) { g.fillRect(roadX * 0.3, y, 3, 22); g.fillRect(W - roadX * 0.3 - 3, y, 3, 22); }
    g.fillStyle = '#1d1430';
    g.fillRect(roadX, -12, roadW, H + 24);
    for (let y = -48 + st.dash; y < H; y += 48) {
      g.fillStyle = '#7a19c4'; g.fillRect(roadX - 6, y, 6, 24); g.fillRect(roadX + roadW, y, 6, 24);
      g.fillStyle = '#f3eeff'; g.fillRect(roadX - 6, y + 24, 6, 24); g.fillRect(roadX + roadW, y + 24, 6, 24);
    }
    g.fillStyle = 'rgba(243, 238, 255, 0.32)';
    for (let i = 1; i < LANES; i++) for (let y = -48 + st.dash; y < H; y += 48) g.fillRect(roadX + laneW * i - 2, y, 4, 26);
    for (const s of st.stars) drawStar(laneX(s.lane), s.y, carW * 0.24, s.spin);
    for (const c of st.cars) drawCar(laneX(c.lane), c.y, c.color, false);
    drawCar(st.x, playerY, null, true);
    for (const p of st.sparks) { g.fillStyle = `rgba(255, 181, 71, ${Math.max(0, p.life * 2)})`; g.fillRect(p.x - 2, p.y - 2, 4, 4); }
    g.restore();
    if (st.flash) { g.fillStyle = `rgba(255, 122, 138, ${st.flash * 0.35})`; g.fillRect(0, 0, W, H); }
    hud();
    if (st.mode !== 'run' || st.finished) overlay();
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (!W) layout();
    if (W) { update(dt); draw(); }
    raf = requestAnimationFrame(frame);
  }
  requestAnimationFrame((now) => { layout(); last = now; raf = requestAnimationFrame(frame); });

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey);
    removeEventListener('resize', layout);
  }

  return {
    /** تقدم التحويل فوق اللعبة */
    update(pct, text) {
      const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      fill.style.width = `${v}%`;
      pctEl.textContent = `${v}%`;
      textEl.textContent = text || '';
    },
    /** الملزمة جاهزة: يتوقف السباق ويظهر الإعلان، ثم تُغلق اللعبة عند الانتقال للملزمة */
    done() {
      st.finished = true;
      this.update(100, 'الملزمة جاهزة');
    },
    close() { s.close(); },
  };
}
