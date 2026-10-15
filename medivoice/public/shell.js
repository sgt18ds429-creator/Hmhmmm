// shell.js — الصفحة العامة: الافتتاحية، شريط الصوت المتحرك، شاشة القفل.
// بعد التفعيل يُحمَّل التطبيق من /app/main.js (محمي ولا يُخدَّم لغير المفعّلين).

import { logoEl } from '/brand.js';

const $ = (s, r = document) => r.querySelector(s);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ───────────── شريط الصوت ─────────────
// خط متعرج بزاوية ثابتة (ميل شيفرونات اللوكو)، يتغير ارتفاع قممه مثل موجة صوت.
class Ribbon {
  constructor(canvas) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    this.cur = { y: 0.4, energy: 0.5, alpha: 1 };
    this.to = { ...this.cur };
    this.t = 0;
    this.last = 0;
    this.pulse = 0;
    this.running = false;
    addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    this.resize();
  }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.25); // خطوط مسطحة: دقة أعلى تكلّف الهاتف بلا فائدة
    this.w = innerWidth; this.h = innerHeight;
    this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
    this.x.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  /** y: موضع عمودي (0..1)، energy: ارتفاع الموجة (0..1)، alpha: الظهور */
  set(o) { Object.assign(this.to, o); if (!this.running) this.start(); }
  kick(amount = 0.5) { this.pulse = Math.min(1, this.pulse + amount); }
  start() { if (this.running || document.hidden || this.paused) return; this.running = true; this.last = performance.now(); requestAnimationFrame((n) => this.frame(n)); }
  stop() { this.running = false; }
  /** إيقاف مؤقت (أثناء اللعبة مثلاً): لا رسم إطلاقاً حتى الاستئناف */
  pause() { this.paused = true; this.stop(); }
  resume() { this.paused = false; this.start(); }
  frame(now) {
    if (!this.running) return;
    if (now - this.last < 32) { requestAnimationFrame((n) => this.frame(n)); return; } // نحو 30 إطاراً بالثانية تكفي
    const dt = Math.min(0.08, (now - this.last) / 1000);
    this.last = now;
    const k = 1 - Math.pow(0.0025, dt);
    for (const key of ['y', 'energy', 'alpha']) this.cur[key] += (this.to[key] - this.cur[key]) * k;
    this.pulse *= Math.pow(0.12, dt);
    this.t += dt * (reduced ? 0 : 1);
    this.draw();
    const settled = Math.abs(this.to.alpha - this.cur.alpha) < 0.004 && this.cur.alpha < 0.01;
    if (settled || reduced && Math.abs(this.to.y - this.cur.y) < 0.002) { this.running = false; return; }
    requestAnimationFrame((n) => this.frame(n));
  }
  layer(cy, amp, speed, phase, width, style) {
    const { x: g, w, t } = this;
    const TAN = 0.79; // ميل شيفرونات اللوكو (نحو 38°)
    const env = (px) => {
      const a = Math.sin(px * 0.0041 + t * speed + phase);
      const b = Math.sin(px * 0.0017 - t * speed * 0.43 + phase * 2.1);
      const c = Math.sin(px * 0.011 + t * speed * 1.7 + phase * 0.6);
      return 0.16 + 0.84 * Math.pow(0.5 + 0.25 * a + 0.17 * b + 0.08 * c, 1.6);
    };
    // نبني من منتصف الشاشة للجهتين حتى يتنفّس الخط بتماثل
    const build = (dir) => {
      const pts = [];
      let px = w / 2, up = dir > 0;
      for (let i = 0; i < 240 && px > -80 && px < w + 80; i++) {
        const a = Math.max(3, amp * env(px));
        const dx = a / TAN;
        px += dir * dx; pts.push([px, cy + (up ? -a : a)]);
        px += dir * dx; up = !up;
      }
      return pts;
    };
    const left = build(-1).reverse(), right = build(1);
    g.beginPath();
    let first = true;
    for (const [px, py] of [...left, [w / 2, cy], ...right]) { first ? g.moveTo(px, py) : g.lineTo(px, py); first = false; }
    g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = style;
    g.stroke();
  }
  draw() {
    const { x: g, w, h } = this;
    g.clearRect(0, 0, w, h);
    const a = this.cur.alpha;
    if (a < 0.01) return;
    const cy = h * this.cur.y;
    const e = this.cur.energy * (1 + this.pulse * 0.9);
    const base = Math.min(w, 900) * 0.085 * e;
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#5433ec'); grad.addColorStop(0.5, '#8521d5'); grad.addColorStop(1, '#c923c1');
    g.globalAlpha = 0.32 * a; this.layer(cy + 10, base * 1.7, 0.32, 1.7, Math.max(10, w * 0.014), grad);
    g.globalAlpha = 0.85 * a; this.layer(cy, base, 0.5, 0, Math.max(5, w * 0.0075), grad);
    g.globalAlpha = 0.55 * a; this.layer(cy - 4, base * 0.55, 0.78, 4.2, 1.5, '#d9c8ff');
    g.globalAlpha = 1;
  }
}

// ───────────── أدوات مشتركة ─────────────
export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('bye'); setTimeout(() => el.remove(), 320); }, kind === 'err' ? 5200 : 3200);
}

export function fingerprint() {
  const plat = navigator.userAgentData?.platform || navigator.platform || '';
  const touch = navigator.maxTouchPoints || 0;
  let os = 'other';
  if (/iPhone|iPad|iPod/i.test(plat) || (/Mac/i.test(plat) && touch > 1)) os = 'iOS';
  else if (/Android/i.test(plat) || (/Linux/i.test(plat) && (touch > 0 || /arm|aarch/i.test(plat)))) os = 'Android';
  else if (/Win/i.test(plat)) os = 'Windows';
  else if (/Mac/i.test(plat)) os = 'macOS';
  else if (/CrOS/i.test(plat)) os = 'ChromeOS';
  else if (/Linux/i.test(plat)) os = 'Linux';
  const s = [screen.width, screen.height].sort((a, b) => a - b);
  return { os, scr: `${s[0]}x${s[1]}@${Math.round((devicePixelRatio || 1) * 10) / 10}` };
}

export async function api(path, { method = 'GET', body, raw, headers = {}, signal, timeoutMs = 45_000 } = {}) {
  // مهلة: اتصال متوقف يُعامل كانقطاع (status 0) ولا يعلّق الواجهة
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const init = { method, headers: { ...headers }, credentials: 'same-origin', signal: ctrl.signal };
  if (method !== 'GET') init.headers['x-mv'] = '1';
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  try {
    const res = await fetch(path, init);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : null;
    const ra = parseFloat(res.headers.get('retry-after'));
    return { ok: res.ok, status: res.status, data, res, retryAfter: Number.isFinite(ra) ? ra : null };
  } catch (e) {
    if (!timedOut && e?.name === 'AbortError') throw e;
    return { ok: false, status: 0, data: null, retryAfter: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MV = (window.MV = { ribbon: new Ribbon($('#ribbon')), toast, api, fingerprint, session: null });

// ───────────── القفل ─────────────
const REASONS = {
  invalid: 'الكود غير صحيح. تأكد من الحروف والأرقام.',
  in_use: 'هذا الكود مفعّل على جهاز آخر. اطلب من المسؤول إعادة تعيين الجهاز.',
  suspended: 'هذا الكود موقوف حالياً. راجع المسؤول.',
  expired: 'انتهت مدة هذا الكود. راجع المسؤول لتجديده.',
  too_many: 'محاولات كثيرة. جرّب بعد ربع ساعة.',
  device_mismatch: 'الكود مفعّل على جهاز مختلف. افتح الموقع من جهازك الأصلي أو اطلب إعادة تعيين الجهاز.',
  network: 'تعذّر الاتصال. تأكد من الإنترنت وحاول مرة ثانية.',
};

// الشريط يمر خلف مربع اللوكو تماماً
function lockRibbonY() {
  const tile = $('.brand-tile');
  const r = tile?.getBoundingClientRect();
  return r && r.height ? (r.top + r.height / 2) / innerHeight : 0.3;
}

function setupLock(info) {
  const lock = $('#lock'), input = $('#code'), box = $('#code-box'), msg = $('#lock-msg'), btn = $('#lock-btn');
  const cells = [...box.querySelectorAll('.cell')];
  const clean = (v) => { let s = v.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (s.length > 8 && s.startsWith('MV')) s = s.slice(2); return s.slice(0, 8); };
  const paint = () => {
    const v = clean(input.value);
    if (input.value !== v) input.value = v;
    cells.forEach((c, i) => {
      c.textContent = v[i] || '';
      c.classList.toggle('filled', !!v[i]);
      c.classList.toggle('on', document.activeElement === input && i === Math.min(v.length, 7));
    });
    btn.disabled = v.length !== 8;
  };
  input.addEventListener('input', () => { msg.textContent = ''; box.classList.remove('bad'); paint(); });
  input.addEventListener('focus', paint);
  input.addEventListener('blur', paint);
  input.addEventListener('keyup', paint);

  if (info?.support?.url) {
    $('#lock-help').hidden = false;
    const a = $('#lock-support');
    a.href = info.support.url;
    a.textContent = info.support.label || 'تواصل ويانه';
  }
  if (info?.reason && REASONS[info.reason] && info.reason !== 'none') msg.textContent = REASONS[info.reason];

  $('#lock-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const code = clean(input.value);
    if (code.length !== 8 || btn.disabled) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    const r = await api('/api/activate', { method: 'POST', body: { code, fp: fingerprint() } });
    btn.textContent = 'تفعيل';
    if (r.ok && r.data?.active) {
      box.classList.add('ok');
      msg.textContent = '';
      input.blur();
      MV.ribbon.kick(1);
      await sleep(reduced ? 0 : 520);
      await openApp(r.data, true);
      return;
    }
    btn.disabled = false;
    box.classList.add('bad');
    MV.ribbon.kick(0.35);
    msg.textContent = REASONS[r.data?.error] || REASONS.network;
    input.focus();
  });

  lock.hidden = false;
  MV.ribbon.set({ y: lockRibbonY(), energy: 0.8, alpha: 1 });
  addEventListener('resize', () => { if (!lock.hidden) MV.ribbon.set({ y: lockRibbonY() }); });
  requestAnimationFrame(() => requestAnimationFrame(() => lock.classList.add('in')));
  paint();
}

// فتح القفل: حافة على شكل V (وادي اللوكو) تصعد وتكشف التطبيق
async function unveil(el) {
  if (reduced) { el.hidden = true; return; }
  const start = performance.now(), dur = 780;
  await new Promise((done) => {
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const y = 100 - e * 175; // نسبة مئوية من الارتفاع
      const dip = 28 * (innerWidth / innerHeight); // عمق الـ V بميل 30°
      el.style.clipPath = `polygon(0 0, 100% 0, 100% ${y}%, 50% ${y + dip}%, 0 ${y}%)`;
      el.style.opacity = String(1 - e * 0.35);
      p < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  });
  el.hidden = true;
  el.style.clipPath = ''; el.style.opacity = '';
}

async function openApp(session, fromLock) {
  MV.session = session;
  const appEl = $('#app');
  let mod;
  try {
    mod = await import(`/app/main.js?v=${encodeURIComponent(session.build || '')}`);
  } catch (e) {
    console.error(e);
    // ملف لم يكتمل تحميله (شبكة ضعيفة): بطاقة واضحة بزر إعادة بدل شاشة فارغة
    $('#lock').hidden = true;
    appEl.hidden = false;
    const card = document.createElement('div');
    card.className = 'load-failed';
    const msg = document.createElement('p');
    msg.textContent = 'ما اكتمل تحميل التطبيق، غالباً بسبب ضعف الإنترنت.';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'إعادة التحميل';
    btn.onclick = () => location.reload();
    card.append(msg, btn);
    appEl.replaceChildren(card);
    return;
  }
  appEl.hidden = false;
  await mod.start(MV, appEl);
  if (fromLock) await unveil($('#lock'));
  else $('#lock').hidden = true;
}

// ───────────── الإقلاع ─────────────
(async function boot() {
  const intro = $('#intro');
  intro.querySelector('.intro-tile').append(logoEl());
  $('#lock .brand-tile').append(logoEl());
  const introDone = sleep(reduced ? 0 : 2300);
  const sessionReq = api(`/api/session?fp=${encodeURIComponent(JSON.stringify(fingerprint()))}`);
  MV.ribbon.set({ y: 0.5, energy: 0.2, alpha: 0 });
  const [, s] = await Promise.all([introDone, sessionReq]);
  const data = s.data || { active: false, reason: s.status === 0 ? 'network' : 'none' };
  if (data.active) {
    await openApp(data, false);
    intro.classList.add('out');
  } else {
    setupLock(data);
    intro.classList.add('out');
  }
  setTimeout(() => intro.remove(), 700);
})();
