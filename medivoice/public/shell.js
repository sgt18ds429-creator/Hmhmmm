// shell.js — الصفحة العامة: الافتتاحية، شريط الصوت المتحرك، شاشة القفل.
// بعد التفعيل يُحمَّل التطبيق من /app/main.js (محمي ولا يُخدَّم لغير المفعّلين).

import { logoEl } from '/brand.js';
import { applyTheme, design, motionOn, themeButton, ripples } from '/theme.js';

// الوضع (نهاري/ليلي) وإعدادات المسؤول قبل أي رسم
applyTheme();
ripples();
const DESIGN = design();
const $ = (s, r = document) => r.querySelector(s);
const reduced = !motionOn();

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
    this.enabled = DESIGN.ribbon; // المسؤول يقدر يطفيه من لوحة التحكم
    this.recolor();
    document.addEventListener('mv-theme', () => this.recolor());
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
  /** ألوان الهوية من متغيرات التصميم (تتغير مع الوضع ومع ألوان لوحة التحكم) */
  recolor() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    const light = document.documentElement.dataset.theme === 'light';
    this.colors = { v1: v('--v1', '#5433ec'), v2: v('--v2', '#8521d5'), v3: v('--v3', '#c923c1'), thin: light ? v('--accent', '#5433ec') : '#e2d6ff', light };
    if (this.w) this.draw();
  }
  /** y: موضع عمودي (0..1)، energy: ارتفاع الموجة (0..1)، alpha: الظهور */
  set(o) { Object.assign(this.to, o); if (!this.enabled) this.to.alpha = 0; if (!this.running) this.start(); }
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
    const base = Math.min(w, 900) * 0.062 * e;
    const { v1, v2, v3, thin, light } = this.colors;
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, v1); grad.addColorStop(0.5, v2); grad.addColorStop(1, v3);
    // ثلاث طبقات خافتة: موجة عريضة كظل، وخط الهوية، وخط رفيع فوقهما
    g.globalAlpha = (light ? 0.06 : 0.09) * a; this.layer(cy + 8, base * 1.6, 0.32, 1.7, Math.max(8, w * 0.011), grad);
    g.globalAlpha = (light ? 0.24 : 0.3) * a; this.layer(cy, base, 0.5, 0, Math.max(2.5, w * 0.0045), grad);
    g.globalAlpha = (light ? 0.16 : 0.18) * a; this.layer(cy - 3, base * 0.55, 0.78, 4.2, 1.1, thin);
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

  // زر النهاري/الليلي بزاوية الشاشة (إذا المسؤول سامح بالتبديل)
  if (DESIGN.toggle) $('#lock-corner').append(themeButton());

  lock.hidden = false;
  MV.ribbon.set({ y: lockRibbonY(), energy: 0.8, alpha: 1 });
  addEventListener('resize', () => { if (!lock.hidden) MV.ribbon.set({ y: lockRibbonY() }); });
  requestAnimationFrame(() => requestAnimationFrame(() => lock.classList.add('in')));
  paint();
}

// فتح القفل: شاشة القفل تطفو فوق التطبيق وتتلاشى صاعدة، والتطبيق تحتها يدخل بحركته (شفافية وتحريك فقط)
async function unveil(el) {
  if (reduced) { el.hidden = true; return; }
  const y = scrollY;
  Object.assign(el.style, { position: 'fixed', top: `${-y}px`, left: '0', right: '0', zIndex: '25', pointerEvents: 'none' });
  scrollTo(0, 0);
  const anim = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-26px) scale(0.985)' }],
    { duration: 520, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
  await anim.finished.catch(() => {});
  el.hidden = true;
  anim.cancel();
  for (const k of ['position', 'top', 'left', 'right', 'zIndex', 'pointerEvents']) el.style[k] = '';
}

/**
 * يبدأ تحميل التطبيق (وحداته وتنسيقه) فوراً، أثناء الافتتاحية لا بعدها. يُستدعى مرة واحدة لكل إصدار؛
 * openApp ينتظر الوعد نفسه.
 */
function preloadApp(session) {
  const v = encodeURIComponent(session.build || '');
  if (MV.appJob && MV.appJob.v === v) return MV.appJob;
  const css = document.createElement('link');
  css.rel = 'preload'; css.as = 'style'; css.href = `/app/app.css?v=${v}`;
  document.head.append(css);
  const job = import(`/app/main.js?v=${v}`);
  // الخطأ يُعرض في openApp؛ والوعد الفاشل لا يبقى محفوظاً حتى تعيد المحاولة التالية التحميل
  job.catch(() => { if (MV.appJob === job) MV.appJob = null; });
  MV.appJob = Object.assign(job, { v });
  return job;
}

async function openApp(session, fromLock) {
  MV.session = session;
  const appEl = $('#app');
  let mod;
  try {
    mod = await preloadApp(session);
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
  // تحت الافتتاحية: الشاشة تُبنى وحركات دخولها متوقفة عند أول إطار، وتبدأ لحظة انكشافها
  if (!fromLock) appEl.classList.add('hold');
  await mod.start(MV, appEl);
  if (fromLock) await unveil($('#lock'));
  else $('#lock').hidden = true;
}

// ───────────── الإقلاع ─────────────
/**
 * سطر حالة صغير تحت اسم الافتتاحية أثناء نقل البيانات من رابط قديم (move.js). يظهر فقط إذا طالت العملية،
 * فالنقل السريع (بلا محاضرات) يمر بدون أن يلاحظه أحد.
 */
function introNote(intro) {
  const center = intro?.querySelector('.intro-center');
  let el = null, bar = null, text = '', pct = 0.03, timer = 0;
  const make = () => {
    if (el || !center) return;
    el = document.createElement('div');
    el.className = 'intro-note';
    el.setAttribute('role', 'status');
    const p = document.createElement('p');
    p.textContent = text;
    const track = document.createElement('div');
    track.className = 'intro-track';
    bar = document.createElement('i');
    bar.style.transform = `scaleX(${pct})`;
    track.append(bar);
    el.append(p, track);
    center.append(el);
    intro.removeAttribute('aria-hidden');
  };
  return {
    show(t) { text = t; if (el) el.querySelector('p').textContent = t; else if (!timer) timer = setTimeout(make, 450); },
    progress(v) { pct = Math.max(0.03, Math.min(1, v)); if (bar) bar.style.transform = `scaleX(${pct})`; },
    fail(t, actions = []) {
      text = t;
      clearTimeout(timer);
      make();
      if (!el) return;
      el.querySelector('p').textContent = t;
      el.querySelector('.intro-track')?.remove();
      const row = document.createElement('div');
      row.className = 'intro-actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = a.primary ? 'btn small' : 'btn small ghost';
        b.textContent = a.label;
        b.addEventListener('click', a.run);
        row.append(b);
      }
      el.append(row);
    },
    done() { clearTimeout(timer); el?.remove(); el = null; },
  };
}

/**
 * خروج الافتتاحية: خلفيتها تتلاشى والاسم يختفي، والشعار يطير ويصغر حتى يستقر مكان شعار الشاشة التالية
 * (شعار القفل أو شعار الشريط العلوي) ثم يتبادل معه. تحريك وشفافية فقط، فتبقى ناعمة وحادة على الهواتف.
 */
async function leaveIntro(intro, dest) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
  const release = () => $('#app').classList.remove('hold');
  const mark = intro.querySelector('.intro-mark');
  if (reduced || !mark || typeof mark.animate !== 'function') { release(); intro.remove(); return; }
  mark.style.animation = 'none'; // دخوله انتهى: يثبت على حالته الأخيرة قبل الطيران
  const from = mark.getBoundingClientRect();
  const to = dest?.getBoundingClientRect?.();
  const landing = to && to.width > 4 && to.bottom > 0 && to.top < innerHeight;
  intro.classList.add('leave');
  release();
  if (landing) {
    dest.style.opacity = '0';
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const fly = mark.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${to.width / from.width})` }],
      { duration: 860, easing: 'cubic-bezier(0.65, 0, 0.22, 1)', fill: 'forwards' });
    await fly.finished.catch(() => {});
    dest.style.transition = 'opacity 0.24s ease';
    dest.style.opacity = '';
    await mark.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: 'forwards' }).finished.catch(() => {});
    setTimeout(() => { dest.style.transition = ''; }, 300);
  } else {
    await mark.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(1.12)' }], { duration: 520, easing: 'ease', fill: 'forwards' }).finished.catch(() => {});
  }
  intro.remove();
}

(async function boot() {
  const intro = $('#intro');
  $('#lock .brand-tile').append(logoEl());
  // شريط المتصفح بلون الافتتاحية أثناءها
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--splash-1').trim() || '#3a0ca3';
  // رابط ثاني للموقع (الخادم يعلّمه بـ mv-move): الصفحة تنقل زائرها ومعه تسجيل دخوله ومحاضراته للرابط الرئيسي
  const moveTo = document.querySelector('meta[name="mv-move"]')?.content;
  if (moveTo) {
    try {
      await (await import('/move.js')).leave(moveTo, introNote(intro));
    } catch (e) {
      console.error(e);
      location.replace(`${moveTo}/?mv-pulled=${encodeURIComponent(new URLSearchParams(location.search).get('mv-pull') || location.host)}`);
    }
    return;
  }
  // الافتتاحية بمدتها الكاملة أول فتح (حسب لوحة التحكم)؛ وإذا فُتح الموقع خلال آخر 12 ساعة فنسخة أقصر
  let lastIntro = 0;
  try { lastIntro = Number(localStorage.getItem('mv-intro-at')) || 0; } catch { /* تخزين ممنوع */ }
  const quick = Date.now() - lastIntro < 12 * 3600_000;
  if (!quick) try { localStorage.setItem('mv-intro-at', String(Date.now())); } catch { /* تخزين ممنوع */ }
  const ms = quick ? Math.min(1500, DESIGN.splashMs) : DESIGN.splashMs;
  const introDone = sleep(reduced ? 350 : ms);
  // رجع من رابط قديم (مر عليه الخادم ليسحب منه، أو فتحه الطالب بنفسه): نستلم تسجيل دخوله ومحاضراته قبل فحص الجلسة
  // (الخادم يدخله بنفس تفعيله)، ونمسح علامات الدورة من الرابط
  const query = new URLSearchParams(location.search);
  const arriving = /(?:^#|&)mv-move=/.test(location.hash);
  let moved = null;
  if (arriving || query.has('mv-pulled')) {
    query.delete('mv-pulled');
    const hash = location.hash;
    const rest = query.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
    if (arriving) {
      const note = introNote(intro);
      try {
        const m = await import('/move.js');
        for (const token of m.tokensIn(hash)) {
          const r = await m.arrive(token, note);
          if (r) moved = { ok: (moved?.ok ?? true) && r.ok, lectures: (moved?.lectures || 0) + r.lectures };
        }
      } catch (e) { console.error(e); }
      note.done();
    }
  }
  const sessionReq = api(`/api/session?fp=${encodeURIComponent(JSON.stringify(fingerprint()))}`);
  // الكود مفعّل: التطبيق يُحمَّل بالتوازي مع الافتتاحية
  sessionReq.then((r) => { if (r.data?.active) preloadApp(r.data); }).catch(() => {});
  MV.ribbon.set({ y: 0.5, energy: 0.2, alpha: 0 });
  const [, s] = await Promise.all([introDone, sessionReq]);
  const data = s.data || { active: false, reason: s.status === 0 ? 'network' : 'none' };
  if (data.active) {
    await openApp(data, false);
    await leaveIntro(intro, $('#app .bar .tile'));
  } else {
    setupLock(data);
    await leaveIntro(intro, $('#lock .brand-tile'));
  }
  if (moved?.lectures) toast('وصلت محاضراتك من الرابط القديم.', 'ok');
  else if (moved && !moved.ok) toast('ما وصلت كل محاضراتك من الرابط القديم. افتح الرابط القديم مرة ثانية حتى تكمل.', 'err');
})();
