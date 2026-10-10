// run.js — تفاصيل المحاضرة، شاشة التحويل الحية، والتسجيل المباشر.

import { h, icon, clear, sheet, confirm, fmtHM, fmtSize } from './ui.js';
import { probeAudio } from './chunker.js';
import { runLecture, PipelineError } from './pipeline.js';
import { parseMarkup, splitInline, fmtTime } from './text.js';
import { fmtDuration } from './pdf.js';
import * as db from './db.js';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function hash(str) {
  let a = 2166136261;
  for (let i = 0; i < str.length; i++) { a ^= str.charCodeAt(i); a = Math.imul(a, 16777619); }
  return (a >>> 0).toString(36);
}

function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'group' });
  const paint = () => [...el.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
  for (const [v, label] of options) el.append(h('button', { type: 'button', dataset: { v }, onclick: () => { value = v; paint(); onChange(v); } }, label));
  paint();
  return el;
}
function toggle(label, hint, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
  return h('label', { class: 'switch' }, input, h('i'), h('span', null, label, h('small', null, hint)));
}

// ───────────── تفاصيل المحاضرة ─────────────
export function viewNew(ctx, el, { file }) {
  ctx.setBar('sub', { title: 'محاضرة جديدة' });
  ctx.ribbon.set({ alpha: 0 });
  const form = { title: '', subject: '', lecturer: '', date: today(), keywords: '', speech: 'ar', style: 'verbatim', images: true, glossary: true };
  let info = null;

  const fileMeta = h('small', null, `${fmtSize(file.size)} · أقرأ الملف…`);
  const startBtn = h('button', { class: 'btn wide', disabled: true, onclick: start }, 'ابدأ التحويل');
  const warn = h('div');
  const field = (label, key, attrs = {}, hint) => {
    const input = h(attrs.rows ? 'textarea' : 'input', { type: 'text', value: form[key], dir: 'auto', ...attrs, oninput: () => { form[key] = input.value; } });
    return { input, el: h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null) };
  };
  const fTitle = field('عنوان المحاضرة', 'title', { placeholder: 'اتركه فارغاً ويُقترح تلقائياً', maxLength: 140 });
  const fSubject = field('المادة', 'subject', { placeholder: 'مثال: التشريح الشعاعي', maxLength: 80, list: 'mv-subjects' });
  const fLecturer = field('اسم التدريسي', 'lecturer', { placeholder: 'اختياري', maxLength: 80 });
  const fKeywords = field('مصطلحات متوقعة', 'keywords', { rows: 2, placeholder: 'chest X-ray, pneumothorax, pleural effusion', dir: 'ltr', maxLength: 400 }, 'اختياري. بعض مصطلحات المحاضرة بالإنجليزية تزيد الدقة.');
  const subjects = h('datalist', { id: 'mv-subjects' });
  const speechSeg = h('div');
  const styleSeg = h('div');
  const toggles = h('div', { class: 'stack' });

  function paintOptions() {
    clear(speechSeg).append(segmented([['ar', 'عربي ومصطلحات إنجليزية'], ['en', 'إنجليزي'], ['auto', 'تلقائي']], form.speech, (v) => { form.speech = v; }));
    clear(styleSeg).append(segmented([['verbatim', 'كما قال المحاضر'], ['formal', 'فصحى مرتبة']], form.style, (v) => { form.style = v; }));
    clear(toggles).append(
      toggle('صور توضيحية', 'من Wikimedia Commons و NIH مع ذكر المصدر', form.images, (v) => { form.images = v; }),
      toggle('قاموس المصطلحات', 'ترجمة وتعريف لكل مصطلح بآخر الملزمة', form.glossary, (v) => { form.glossary = v; }));
  }
  paintOptions();

  el.append(h('div', { class: 'stack lg' },
    h('div', { class: 'filecard' }, icon('file'), h('div', null, h('b', { dir: 'auto' }, file.name || 'تسجيل'), fileMeta)),
    warn,
    h('div', { class: 'stack' }, fTitle.el, h('div', { class: 'grid2' }, fSubject.el, fLecturer.el), subjects),
    h('div', { class: 'field' }, h('span', null, 'لغة الشرح'), speechSeg),
    h('div', { class: 'field' }, h('span', null, 'أسلوب النص'), styleSeg, h('small', null, 'بالحالتين يُكتب الكلام كاملاً بدون اختصار.')),
    toggles,
    fKeywords.el,
    startBtn));

  db.getPref('form').then((saved) => {
    if (!saved) return;
    for (const k of ['subject', 'lecturer', 'speech', 'style', 'images', 'glossary']) if (saved[k] !== undefined) form[k] = saved[k];
    fSubject.input.value = form.subject; fLecturer.input.value = form.lecturer;
    paintOptions();
  });
  db.getPref('subjects', []).then((list) => { for (const s of list || []) subjects.append(h('option', { value: s })); });

  probeAudio(file).then((i) => {
    info = i;
    const left = Math.max(0, ctx.session.usage.limit_sec - ctx.session.usage.used_sec);
    fileMeta.textContent = `${fmtSize(file.size)} · ${fmtDuration(i.duration)}${i.hasVideo ? ' · فيديو (يُؤخذ الصوت فقط)' : ''}`;
    if (i.duration > left + 30) {
      warn.append(h('div', { class: 'banner' }, icon('warn'), h('span', null, `مدة التسجيل ${fmtHM(i.duration)} ورصيدك المتبقي اليوم ${fmtHM(left)}. يتحوّل اللي يكفيه الرصيد ويتوقف، وتكمل الباقي بعدين من نفس الملف.`)));
    }
    startBtn.disabled = false;
  }).catch((e) => {
    fileMeta.textContent = fmtSize(file.size);
    const msg = e?.code === 'no-audio' ? 'هذا الملف ما بيه صوت.' : 'ما قدرت أقرأ هذا الملف. جرّب صيغة m4a أو mp3 أو wav أو mp4.';
    clear(warn).append(h('div', { class: 'banner' }, icon('warn'), h('span', null, msg), h('button', { class: 'btn small amber', onclick: () => { history.back(); setTimeout(ctx.pickFile, 250); } }, 'ملف آخر')));
  });

  async function start() {
    if (!info) return;
    const meta = { ...form, title: form.title.trim(), subject: form.subject.trim(), lecturer: form.lecturer.trim(), keywords: form.keywords.trim() };
    db.setPref('form', { subject: meta.subject, lecturer: meta.lecturer, speech: meta.speech, style: meta.style, images: meta.images, glossary: meta.glossary });
    if (meta.subject) db.getPref('subjects', []).then((list) => db.setPref('subjects', [meta.subject, ...(list || []).filter((s) => s !== meta.subject)].slice(0, 12)));
    ctx.go('run', { file, meta, info }, { replace: true });
  }
}

// ───────────── شاشة التحويل ─────────────
const ERRORS = {
  key_groq: ['مفتاح Groq ما يشتغل', 'ممكن انحذف أو انتهى. اربطه من جديد.', 'link'],
  key_gemini: ['مفتاح Gemini ما يشتغل', 'ممكن انحذف أو انتهى. اربطه من جديد.', 'link'],
  no_engine: ['ماكو محرك متاح الآن', 'وصلت حدود اليوم عند المحركات المربوطة، أو ما مربوط أي مفتاح. اربط المفتاح الثاني أو جرّب بعدين.', 'link'],
  daily_limit: ['خلص رصيد اليوم', 'المقاطع المكتملة محفوظة. ارجع ارفع نفس الملف بعدين ويكمل من مكانه.', 'home'],
  rate_limit: ['وصلت حد Groq للصوت', 'المقاطع المكتملة محفوظة. جرّب بعد شوية بنفس الملف ويكمل من مكانه.', 'retry'],
  locked: ['توقف الكود', 'الكود موقوف أو انتهت مدته. راجع المسؤول.', 'reload'],
  audio: ['مشكلة بالملف', 'ما قدرت أقرأ الصوت من هذا الملف. جرّب صيغة ثانية.', 'home'],
  empty: ['ماكو كلام بالتسجيل', 'ما لقيت كلام واضح. تأكد إنه تسجيل محاضرة وصوته مسموع.', 'home'],
  network: ['انقطع الاتصال', 'المقاطع المكتملة محفوظة. تأكد من الإنترنت وكمّل.', 'retry'],
};

export function viewRun(ctx, el, { file, meta, info }) {
  ctx.setBar('sub', { title: 'جارِ التحويل' });
  const cfg = { chunkSec: ctx.session.config.chunkSec, overlapSec: ctx.session.config.overlapSec };
  const job = hash([file.name, file.size, file.lastModified, meta.speech, meta.style, cfg.chunkSec].join('|'));
  const controller = new AbortController();
  let running = true, wakeLock = null, waitTimer = null;
  const t0 = Date.now();

  const pct = h('span', null, '0');
  const status = h('p', { class: 'run-status' }, 'أقرأ الملف…');
  const sub = h('p', { class: 'run-sub num' }, '');
  const strip = h('div', { class: 'strip', 'aria-hidden': 'true' });
  const live = h('div', { class: 'live', dir: 'auto' });
  const stageNames = [['transcribe', 'التفريغ'], ['glossary', 'القاموس'], ['figures', 'الصور'], ['done', 'جاهز']];
  const stages = h('ul', { class: 'stages' }, stageNames.map(([k, label]) => h('li', { dataset: { k } }, label)));
  const cancelBtn = h('button', { class: 'btn ghost', onclick: () => history.back() }, 'إلغاء');
  const body = h('div', { class: 'run' },
    h('div', { class: 'run-head' }, h('div', { class: 'run-pct num' }, pct, h('small', null, '%')), status, sub),
    strip, stages, live, h('div', { class: 'row', style: { justifyContent: 'center' } }, cancelBtn));
  el.append(body);

  ctx.ribbon.set({ y: Math.min(0.24, 170 / innerHeight), energy: 1, alpha: 1 });
  ctx.guard = async () => {
    if (!running) return true;
    const yes = await confirm({ title: 'إيقاف التحويل؟', message: 'المقاطع المكتملة تبقى محفوظة، وإذا رفعت نفس الملف يكمل من مكانه.', ok: 'إيقاف', cancel: 'أكمل', danger: true });
    if (yes) controller.abort();
    return yes;
  };
  const beforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
  addEventListener('beforeunload', beforeUnload);
  const grabWake = async () => { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* غير مدعوم */ } };
  const onVisible = () => { if (!document.hidden && running) grabWake(); };
  grabWake();
  document.addEventListener('visibilitychange', onVisible);
  const tick = setInterval(() => { if (running && !waitTimer) sub.textContent = `${fmtTime((Date.now() - t0) / 1000)} · خلّي الصفحة مفتوحة`; }, 1000);

  // ── تقدم ──
  const P = { total: 1, chunk: [], extra: 0 };
  const WEIGHT = { cut: 0.04, stt: 0.2, listen: 0.45, clean: 0.45, done: 1 };
  let shown = 0;
  function paintPct() {
    const done = P.chunk.reduce((a, s) => a + (WEIGHT[s] || 0), 0) / P.total;
    const value = Math.min(99, Math.round((done * 0.86 + P.extra) * 100));
    if (value > shown) { shown = value; pct.textContent = String(value); }
  }
  function setStage(k) {
    const order = stageNames.map(([n]) => n);
    const at = order.indexOf(k);
    [...stages.children].forEach((li, i) => { li.classList.toggle('ok', i < at); li.classList.toggle('on', i === at); });
  }
  const pending = new Map();
  let nextLive = 0;
  function showParts() {
    while (pending.has(nextLive)) {
      const blocks = parseMarkup(pending.get(nextLive).markup);
      pending.delete(nextLive); nextLive++;
      for (const b of blocks.slice(-14)) {
        const node = b.t === 'h' ? h('h3') : b.items ? h('ul') : h('p');
        const fill = (target, text) => { for (const part of splitInline(text)) target.append(part.term ? h('span', { class: 't' }, part.text) : part.text); };
        if (b.items) b.items.forEach((it) => { const li = h('li'); fill(li, it); node.append(li); });
        else fill(node, b.text);
        node.dir = 'auto';
        live.append(node);
      }
      while (live.children.length > 60) live.firstChild.remove();
      live.scrollTop = live.scrollHeight;
    }
  }

  function emit(e) {
    if (!running) return;
    if (e.type === 'plan') {
      P.total = e.chunks;
      clear(strip);
      for (let i = 0; i < e.chunks; i++) strip.append(h('i'));
      setStage('transcribe');
    } else if (e.type === 'chunk') {
      // قد يختلف العدد الفعلي قليلاً عن التقدير
      while (strip.children.length <= e.index) { strip.append(h('i')); P.total = strip.children.length; }
      P.chunk[e.index] = e.stage;
      strip.children[e.index].className = e.stage;
      const n = `${e.index + 1} من ${P.total}`;
      if (e.stage === 'stt') status.textContent = `أحوّل المقطع ${n} إلى مسودة`;
      else if (e.stage === 'listen') status.textContent = `أستمع للمقطع ${n} وأدقّق المصطلحات`;
      else if (e.stage === 'clean') status.textContent = `أنقّح المقطع ${n}`;
      ctx.ribbon.kick(0.25);
      paintPct();
    } else if (e.type === 'part') {
      P.chunk[e.index] = 'done';
      if (strip.children[e.index]) strip.children[e.index].className = e.part.review ? 'review' : 'done';
      pending.set(e.index, e.part);
      showParts();
      ctx.ribbon.kick(0.5);
      paintPct();
    } else if (e.type === 'stage') {
      if (e.name === 'glossary') { setStage('glossary'); status.textContent = 'أجهّز قاموس المصطلحات'; P.extra = 0.03; }
      else if (e.name === 'figures') { setStage('figures'); status.textContent = 'أحدد مواضع الصور التوضيحية'; P.extra = 0.07; }
      else if (e.name === 'images') { status.textContent = 'أجلب الصور من المصادر المفتوحة'; P.extra = 0.09; }
      else if (e.name === 'done') { setStage('done'); P.extra = 0.14; }
      paintPct();
    } else if (e.type === 'images') {
      if (e.picked) status.textContent = `أختار أنسب الصور (${e.picked})`;
      P.extra = Math.min(0.13, P.extra + 0.01);
      paintPct();
    } else if (e.type === 'wait') {
      let left = e.seconds;
      clearInterval(waitTimer);
      const what = e.what === 'stt' ? 'Groq' : e.what === 'gemini' ? 'Gemini' : e.what === 'llm' ? 'Groq' : 'الشبكة';
      const paint = () => { sub.textContent = `وصلنا حد الطلبات المجانية عند ${what}، نكمل بعد ${left} ثانية`; };
      paint();
      waitTimer = setInterval(() => { left--; if (left <= 0) { clearInterval(waitTimer); waitTimer = null; } else paint(); }, 1000);
    } else if (e.type === 'resume') {
      clearInterval(waitTimer); waitTimer = null;
    }
  }

  function cleanup() {
    running = false;
    clearInterval(tick); clearInterval(waitTimer);
    removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('visibilitychange', onVisible);
    wakeLock?.release?.().catch(() => {});
    ctx.guard = null;
  }

  function fail(code, extra = {}) {
    cleanup();
    ctx.ribbon.set({ energy: 0.25, alpha: 0.5 });
    const [title, message, action] = ERRORS[code] || ['توقف التحويل', 'صار خطأ غير متوقع. المقاطع المكتملة محفوظة، جرّب مرة ثانية.', 'retry'];
    let msg = message;
    if (code === 'daily_limit' && extra.retryAfter) msg += ` يتجدد الرصيد تدريجياً خلال ${fmtHM(extra.retryAfter)} ساعة.`;
    const actions = [];
    if (action === 'link') actions.push(h('button', { class: 'btn', onclick: () => ctx.go('link', {}, { replace: true }) }, 'ربط المفاتيح'));
    if (action === 'retry') actions.push(h('button', { class: 'btn', onclick: () => ctx.go('run', { file, meta, info }, { replace: true }) }, 'أكمل التحويل'));
    if (action === 'reload') actions.push(h('button', { class: 'btn', onclick: () => location.reload() }, 'تحديث'));
    actions.push(h('button', { class: 'btn ghost', onclick: () => history.back() }, 'رجوع'));
    clear(body).append(h('div', { class: 'result' }, icon('warn', 'icon big'), h('h2', { class: 'h-section' }, title), h('p', { class: 'muted' }, msg), h('div', { class: 'row', style: { justifyContent: 'center' } }, actions)));
    ctx.setBar('sub', { title: 'توقف التحويل' });
  }

  (async () => {
    try {
      const caps = ctx.caps || await ctx.loadCaps();
      const resumed = await db.countParts(job).catch(() => 0);
      if (resumed) ctx.toast(`أكمل من حيث توقفنا: ${resumed} مقطع جاهز.`);
      const doc = await runLecture({
        file, meta, cfg, caps, io: ctx.io, emit, signal: controller.signal,
        checkpoint: { get: (i) => db.getPart(job, i).catch(() => null), set: (i, p) => db.setPart(job, i, p).catch(() => {}) },
      });
      doc.partial = false;
      await db.saveLecture(doc);
      await db.clearParts(job).catch(() => {});
      ctx.api('/api/done', { method: 'POST', body: {} }).then(() => ctx.refreshSession()).catch(() => {});
      shown = 100; pct.textContent = '100';
      status.textContent = 'الملزمة جاهزة';
      ctx.ribbon.kick(1);
      cleanup();
      setTimeout(() => ctx.go('doc', { id: doc.id, fresh: true }, { replace: true }), 650);
    } catch (e) {
      if (e?.name === 'AbortError' || e?.code === 'aborted') { cleanup(); return; }
      console.error(e);
      if (e instanceof PipelineError) fail(e.code, e);
      else fail(navigator.onLine === false ? 'network' : 'unknown');
      ctx.refreshSession().catch(() => {});
    }
  })();
}

// ───────────── تسجيل مباشر ─────────────
export function openRecorder(ctx) {
  let recorder = null, stream = null, chunks = [], started = 0, timer = null, wake = null, audioCtx = null, raf = 0;
  const time = h('div', { class: 'rec-time num' }, '0:00');
  const hint = h('p', { class: 'dim' }, 'خلّي الشاشة مفتوحة أثناء التسجيل. للمحاضرات الطويلة مسجّل الهاتف أضمن، وبعدها ارفع الملف.');
  const btn = h('button', { class: 'btn', onclick: () => (recorder ? stop(true) : begin()) }, icon('mic'), 'ابدأ التسجيل');
  const s = sheet({ title: 'تسجيل مباشر', body: h('div', { class: 'rec' }, time, hint, btn), onClose: () => stop(false) });

  async function begin() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, channelCount: 1 } });
    } catch {
      ctx.toast('لازم تسمح للموقع باستخدام المايكروفون.', 'err');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    try { recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined); }
    catch { ctx.toast('التسجيل غير مدعوم بهذا المتصفح.', 'err'); stream.getTracks().forEach((t) => t.stop()); return; }
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.start(5000);
    started = Date.now();
    timer = setInterval(() => { time.textContent = fmtTime((Date.now() - started) / 1000); }, 500);
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* غير مدعوم */ }
    // مستوى الصوت يحرّك الشريط
    try {
      audioCtx = new AudioContext();
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        ctx.ribbon.set({ energy: 0.35 + Math.min(1, peak / 60) * 0.9, alpha: 1 });
        raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* اختياري */ }
    clear(btn).append(icon('stop'), 'إنهاء وتحويل');
    btn.classList.add('amber');
    clear(hint).append(h('span', { class: 'rec-dot' }), 'أسجّل الآن…');
  }

  function stop(use) {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    wake?.release?.().catch(() => {});
    audioCtx?.close?.().catch(() => {});
    const rec = recorder;
    recorder = null;
    const finish = () => {
      stream?.getTracks().forEach((t) => t.stop());
      if (!use || !chunks.length) return;
      const type = rec?.mimeType || chunks[0].type || 'audio/webm';
      const ext = /mp4/.test(type) ? 'm4a' : 'webm';
      const stamp = new Date().toLocaleString('en-GB', { hour12: false }).replace(/[/,: ]+/g, '-');
      const file = new File(chunks, `تسجيل-${stamp}.${ext}`, { type, lastModified: Date.now() });
      s.close();
      ctx.go('new', { file });
    };
    if (rec && rec.state !== 'inactive') { rec.onstop = finish; rec.stop(); } else finish();
  }
}
