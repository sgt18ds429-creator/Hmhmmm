// game.js — «سباق ميدي فويز»: لعبة سباق بمنظور عمق تُلعب أثناء انتظار الملزمة.
// تفتح في نافذة سفلية فوق شاشة التحويل وتعرض تقدّمه، وتنغلق وحدها عندما تجهز الملزمة.
// الرسم في عامل خلفي (game-worker.js) فلا يتقطّع حين تنشغل الصفحة بالتحويل؛ والنصوص (النقاط واللوحات)
// عناصر صفحة عادية بخط الموقع. المتصفح الذي لا يدعم الرسم في الخلفية يشغّل المحرك نفسه في الصفحة.

import { h, sheet, clear, svgEl } from './ui.js';
export { openXO } from './xo.js';

const GAME_KEY = 'mv-game';
/**
 * نافذة «اختر لعبة»: سباق السيارات أو إكس أو. ترجع 'race' أو 'xo'، أو null إذا أُغلقت.
 * آخر لعبة اختارها الطالب تظهر مميزة.
 */
export function chooseGame() {
  let last = null;
  try { last = localStorage.getItem(GAME_KEY); } catch { /* تخزين غير متاح */ }
  return new Promise((resolve) => {
    let picked = null;
    const pick = (id) => { picked = id; try { localStorage.setItem(GAME_KEY, id); } catch { /* */ } s.close(); };
    const raceArt = h('span', { class: 'gp-art race-art', 'aria-hidden': 'true' }, h('i', { class: 'sun' }), h('i', { class: 'road' }), h('i', { class: 'car' }));
    const cell = (v) => h('i', null, v === 'x' ? svgEl('svg', { viewBox: '0 0 100 100', class: 'x' }, svgEl('path', { d: 'M28 28 72 72M72 28 28 72' })) : v === 'o' ? svgEl('svg', { viewBox: '0 0 100 100', class: 'o' }, svgEl('circle', { cx: 50, cy: 50, r: 24 })) : null);
    const xoArt = h('span', { class: 'gp-art xo-art', 'aria-hidden': 'true' }, ...['x', 'o', '', '', 'x', 'o', '', '', 'x'].map(cell));
    const card = (id, art, title, sub) => h('button', { type: 'button', class: `game-pick${last === id ? ' last' : ''}`, onclick: () => pick(id) },
      art, h('span', { class: 'gp-text' }, h('b', null, title), h('small', null, sub)));
    const s = sheet({
      title: 'اختر لعبة',
      body: h('div', { class: 'game-picks' },
        card('race', raceArt, 'سباق السيارات', 'تفادى السيارات واجمع النجوم'),
        card('xo', xoArt, 'إكس أو', 'تحدَّ الكمبيوتر بثلاث مستويات')),
      onClose: () => resolve(picked),
    });
  });
}

const BEST_KEY = 'mv-race-best';
function loadBest() { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } }
function saveBest(v) { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* تخزين غير متاح */ } }

const POWER_LABEL = { shield: 'درع', magnet: 'مغناطيس', nitro: 'نيترو' };

/**
 * @param onClose يُستدعى عند إغلاق اللعبة (بزر الإغلاق أو الرجوع أو عند جاهزية الملزمة)
 * @param build نسخة الموقع (لتحميل ملف العامل الصحيح بعد كل تحديث)
 * @returns { update(pct, text), done(), close(), stats() }
 */
export function openGame({ onClose, build = '' } = {}) {
  const fill = h('i');
  const pctEl = h('b', { class: 'num' }, '0%');
  const textEl = h('small');
  const bar = h('div', { class: 'game-progress', role: 'status' }, fill, pctEl, textEl);

  let canvas = h('canvas', { class: 'game-canvas', 'aria-hidden': 'true' });
  const scoreEl = h('b', { class: 'num' }, '0');
  const bestEl = h('span', { class: 'num' }, String(loadBest()));
  const comboEl = h('span', { class: 'race-combo', hidden: true });
  const chips = h('span', { class: 'race-chips' });
  const hudEl = h('div', { class: 'race-hud' },
    h('div', { class: 'race-meta' }, h('small', null, 'الأفضل ', bestEl), comboEl, chips),
    h('div', { class: 'race-score' }, scoreEl, h('small', null, 'نقطة')));
  const card = h('div', { class: 'race-card' });
  const stage = h('div', { class: 'race force-dark', role: 'application', 'aria-label': 'لعبة سباق: اضغط يمين اللعبة أو يسارها أو اسحب حتى تغيّر المسار' }, canvas, hudEl, card);
  const hint = h('p', { class: 'game-hint' }, 'اضغط يمين أو يسار، أو اسحب، حتى تغيّر المسار. الملزمة تكمل بالخلفية.');
  const s = sheet({ title: 'سباق لحد ما تجهز الملزمة', body: h('div', { class: 'game' }, bar, stage, hint), onClose: () => { stop(); onClose?.(); } });
  s.panel.classList.add('game-panel');

  let mode = 'ready', closed = false, engine = null, pendingStats = null;
  const reduced = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // ── اللوحات فوق اللعبة ──
  function paintCard(m = {}) {
    clear(card);
    card.hidden = mode === 'run';
    card.dataset.mode = mode;
    if (mode === 'run') return;
    if (mode === 'finished') {
      card.append(h('h3', null, 'الملزمة جاهزة!'), h('p', null, 'أفتحها لك الآن…'));
      return;
    }
    if (mode === 'over') {
      card.append(
        h('h3', null, 'اصطدمت!'),
        h('p', { class: 'race-result' }, 'النتيجة ', h('b', { class: 'num' }, String(m.score ?? 0))),
        m.newBest ? h('p', { class: 'race-record' }, 'رقم قياسي جديد') : h('p', null, 'الأفضل ', h('b', { class: 'num' }, String(m.best ?? loadBest()))),
        h('span', { class: 'race-cta' }, 'اضغط حتى تلعب مرة ثانية'));
      return;
    }
    card.append(
      h('h3', null, 'سباق ميدي فويز'),
      h('p', null, 'تفادى السيارات والأقماع، واجمع النجوم.'),
      h('ul', { class: 'race-powers' },
        h('li', { class: 'shield' }, h('i'), 'درع يحميك من اصطدام واحد'),
        h('li', { class: 'magnet' }, h('i'), 'مغناطيس يجذب النجوم'),
        h('li', { class: 'nitro' }, h('i'), 'نيترو يحطّم أي عائق')),
      h('span', { class: 'race-cta' }, 'اضغط حتى تبدأ'));
  }
  paintCard();

  function onEngine(m) {
    if (m.type === 'best') { saveBest(m.best); return; } // حتى بعد الإغلاق: نتيجة آخر سباق تُحفظ
    if (closed) return;
    if (m.type === 'hud') {
      scoreEl.textContent = String(m.score);
      bestEl.textContent = String(m.best);
      comboEl.hidden = !(m.combo > 1);
      comboEl.textContent = `مضاعف ×${m.combo}`;
      clear(chips).append(...m.powers.map((p) => h('span', { class: `race-chip ${p.kind}` }, p.left ? `${POWER_LABEL[p.kind]} ${p.left}` : POWER_LABEL[p.kind])));
    } else if (m.type === 'mode') {
      mode = m.mode;
      paintCard(m);
    } else if (m.type === 'buzz') {
      try { navigator.vibrate?.(m.ms); } catch { /* غير مدعوم */ }
    } else if (m.type === 'stats' && pendingStats) {
      pendingStats(m.stats); pendingStats = null;
    }
  }

  // ── المحرك: في عامل خلفي إن أمكن، وإلا في الصفحة ──
  const size = () => {
    const r = canvas.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), dpr: Math.min(2, globalThis.devicePixelRatio || 1) };
  };
  async function startLocal() {
    if (closed) return;
    // لوحة جديدة: اللوحة التي نُقل رسمها للعامل لا تُرسم من الصفحة
    const fresh = h('canvas', { class: 'game-canvas', 'aria-hidden': 'true' });
    canvas.replaceWith(fresh);
    canvas = fresh;
    const { createRace } = await import('./game-core.js');
    if (closed) return;
    const race = createRace(canvas, { emit: onEngine, best: loadBest(), reduced });
    const z = size();
    race.resize(z.w, z.h, z.dpr);
    engine = {
      send(m) {
        if (m.type === 'resize') race.resize(m.w, m.h, m.dpr);
        else if (m.type === 'move') race.move(m.dir);
        else if (m.type === 'tap') race.tap();
        else if (m.type === 'pause') race.pause(m.paused);
        else if (m.type === 'progress') race.progress(m.pct);
        else if (m.type === 'finish') race.finish();
        else if (m.type === 'stats') onEngine({ type: 'stats', stats: race.stats() });
      },
      stop() { race.stop(); },
      kind: 'page',
    };
    flush();
  }
  let workerRef = null;
  function startWorker() {
    let worker, ready = false, dead = false;
    try {
      if (typeof Worker === 'undefined' || !canvas.transferControlToOffscreen || typeof OffscreenCanvas === 'undefined') return false;
      worker = new Worker(`/app/game-worker.js?v=${encodeURIComponent(build)}`, { type: 'module' });
    } catch { return false; }
    let off;
    try { off = canvas.transferControlToOffscreen(); } catch { worker.terminate(); return false; }
    workerRef = worker;
    // العامل لم يحمّل خلال 5 ثوانٍ أو تعطّل (قبل الجاهزية أو بعدها): المحرك نفسه في الصفحة، والرسائل المنتظرة تُعاد إليه
    const fail = () => {
      if (dead || closed) return;
      dead = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* */ }
      workerRef = null;
      engine = null;
      startLocal();
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'ready') {
        if (dead) return;
        ready = true;
        clearTimeout(timer);
        engine = { send: (m) => worker.postMessage(m), stop: () => { try { worker.postMessage({ type: 'stop' }); } catch { /* أُغلق */ } setTimeout(() => worker.terminate(), 80); }, kind: 'worker' };
        flush();
        return;
      }
      onEngine(d);
    };
    const timer = setTimeout(() => { if (!ready) fail(); }, 5000);
    const z = size();
    worker.postMessage({ type: 'init', canvas: off, w: z.w, h: z.h, dpr: z.dpr, best: loadBest(), reduced }, [off]);
    return true;
  }
  // رسائل قبل جاهزية المحرك تُحفظ وتُرسل بعده
  const queue = [];
  const send = (m) => { if (engine) engine.send(m); else queue.push(m); };
  function flush() { while (queue.length && engine) engine.send(queue.shift()); }
  requestAnimationFrame(() => { if (!closed && !startWorker()) startLocal(); });

  // ── الإدخال: ضغط على نصف اللعبة، أو سحب، أو الأسهم ──
  let press = null;
  const onDown = (e) => {
    e.preventDefault();
    if (mode === 'finished') return;
    if (mode !== 'run') { send({ type: 'tap' }); return; }
    press = { x: e.clientX, moved: false };
  };
  const onMove = (e) => {
    if (!press || press.moved) return;
    const dx = e.clientX - press.x;
    if (Math.abs(dx) > 22) { press.moved = true; send({ type: 'move', dir: dx < 0 ? -1 : 1 }); }
  };
  const onUp = (e) => {
    if (!press) return;
    if (!press.moved) { const r = stage.getBoundingClientRect(); send({ type: 'move', dir: e.clientX - r.left < r.width / 2 ? -1 : 1 }); }
    press = null;
  };
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { send({ type: 'move', dir: -1 }); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { send({ type: 'move', dir: 1 }); e.preventDefault(); }
    else if ((e.key === ' ' || e.key === 'Enter') && mode !== 'run' && mode !== 'finished') { send({ type: 'tap' }); e.preventDefault(); }
  };
  const onVisibility = () => send({ type: 'pause', paused: document.hidden });
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', () => { press = null; });
  addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  let lastSize = '';
  const onResize = () => {
    const z = size();
    const key = `${z.w}x${z.h}@${z.dpr}`;
    if (!z.w || !z.h || key === lastSize) return;
    lastSize = key;
    send({ type: 'resize', ...z });
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(stage);
  addEventListener('resize', onResize);

  function stop() {
    if (closed) return;
    closed = true;
    if (engine) engine.stop();
    else if (workerRef) { try { workerRef.terminate(); } catch { /* */ } }
    pendingStats?.(null); pendingStats = null;
    ro?.disconnect();
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  return {
    /** تقدم التحويل فوق اللعبة؛ وكل 10% تمر بوابة تفتيش */
    update(pct, text) {
      const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      fill.style.width = `${v}%`;
      pctEl.textContent = `${v}%`;
      textEl.textContent = text || '';
      send({ type: 'progress', pct: v });
    },
    /** الملزمة جاهزة: يتوقف السباق وتظهر اللوحة، ثم تُغلق اللعبة عند الانتقال للملزمة */
    done() {
      this.update(100, 'الملزمة جاهزة');
      send({ type: 'finish' });
    },
    close() { s.close(); },
    /** قياس سلاسة الرسم (للاختبار): زمن الإطارات */
    stats() { return new Promise((resolve) => { pendingStats = (x) => resolve(x && { ...x, engine: engine?.kind || 'none' }); send({ type: 'stats' }); }); },
  };
}
