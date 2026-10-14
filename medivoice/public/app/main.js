// main.js — التطبيق بعد التفعيل: التنقل، الرئيسية، ربط المفاتيح، الإعدادات.

import { h, icon, clear, sheet, closeTopSheet, confirm, fmtHM, fmtAgo, svgEl } from './ui.js';
import { makeIO } from './api.js';
import * as db from './db.js';
import { LOGO_PATH, fmtDuration } from './pdf.js';
import { viewNew, viewRun, viewRewrite, openRecorder } from './run.js';
import { viewDoc } from './doc.js';

const ACCEPT = 'audio/*,video/*,.m4a,.mp3,.wav,.ogg,.oga,.opus,.aac,.flac,.mp4,.mov,.m4v,.webm,.mkv,.3gp,.amr,.wma';

const PROVIDERS = {
  gemini: {
    badge: 'G', name: 'Gemini', role: 'محرك الدقة',
    desc: 'يسمع التسجيل نفسه ويكتب المصطلحات الطبية صح.',
    url: 'https://aistudio.google.com/apikey', site: 'Google AI Studio',
    steps: ['افتح Google AI Studio وسجّل دخول بحساب Google.', 'اضغط Create API key ثم انسخ المفتاح.', 'ارجع لهنا واضغط «لصق المفتاح».'],
  },
  groq: {
    badge: 'Q', name: 'Groq', role: 'محرك الساعات',
    desc: 'يحوّل الصوت إلى مسودة بثوانٍ: 8 ساعات كل يوم.',
    url: 'https://console.groq.com/keys', site: 'Groq Console',
    steps: ['افتح Groq Console وسجّل دخول (بحساب Google أسرع).', 'اضغط Create API Key، سمِّه أي اسم، ثم Copy.', 'ارجع لهنا واضغط «لصق المفتاح».'],
  },
};

export async function start(MV, root) {
  // الأنماط أولاً حتى لا تظهر الواجهة بلا تنسيق
  await new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: `/app/app.css?v=${encodeURIComponent(MV.session.build || '')}` });
    link.onload = resolve; link.onerror = resolve;
    document.head.append(link);
  });

  const ctx = {
    MV, root, toast: MV.toast, api: MV.api, ribbon: MV.ribbon, io: makeIO(),
    session: MV.session, caps: null, view: null, guard: null,
    go, back, refreshSession, loadCaps, openSettings, openLink: () => go('link'), pickFile,
  };
  const bar = h('header', { class: 'bar' });
  const main = h('div', { class: 'view-host' });
  const fileInput = h('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f) go('new', { file: f }); } });
  root.append(bar, main, fileInput);

  function pickFile() { fileInput.click(); }

  // ── الجلسة والقدرات ──
  async function refreshSession() {
    const r = await MV.api(`/api/session?fp=${encodeURIComponent(JSON.stringify(MV.fingerprint()))}`);
    if (r.data?.active) { ctx.session = MV.session = r.data; paintMeter(); }
    else if (r.status === 200 && r.data && !r.data.active) location.reload(); // أُوقف الكود أو تغيّر الجهاز
    return ctx.session;
  }
  async function loadCaps() {
    const s = ctx.session, cfg = s.config;
    const caps = { groq: s.keys.groq.linked, gemini: s.keys.gemini.linked, sttModels: cfg.sttModels, groqModels: cfg.groqModels, geminiModels: cfg.geminiModels, transcribeModels: cfg.transcribeModels || [] };
    if (caps.groq || caps.gemini) {
      const r = await MV.api('/api/models');
      if (r.ok && r.data) {
        const keep = (want, have) => { const f = want.filter((m) => have.includes(m)); return f.length ? f : want; };
        if (r.data.groq?.length) { caps.sttModels = keep(cfg.sttModels, r.data.groq); caps.groqModels = keep(cfg.groqModels, r.data.groq); }
        if (r.data.gemini?.length) {
          caps.geminiModels = keep(cfg.geminiModels, r.data.gemini);
          caps.transcribeModels = (cfg.transcribeModels || []).filter((m) => r.data.gemini.includes(m));
        }
      }
    }
    ctx.caps = caps;
    return caps;
  }

  // ── عدّاد الرصيد اليومي ──
  let meterEl = null;
  function paintMeter() {
    if (!meterEl) return;
    const u = ctx.session.usage;
    const left = Math.max(0, u.limit_sec - u.used_sec);
    const frac = u.limit_sec ? left / u.limit_sec : 0;
    const C = 2 * Math.PI * 12;
    meterEl.querySelector('.fill').style.strokeDashoffset = String(C * (1 - frac));
    meterEl.querySelector('b').textContent = fmtHM(left);
    meterEl.classList.toggle('low', frac < 0.15);
    meterEl.setAttribute('aria-label', `المتبقي اليوم ${fmtHM(left)} ساعة`);
  }
  function meter() {
    const C = 2 * Math.PI * 12;
    meterEl = h('button', { class: 'meter', onclick: openSettings },
      h('span', null, h('b', { class: 'num' }, '0:00'), h('small', null, 'متبقي اليوم')),
      svgEl('svg', { viewBox: '0 0 30 30' },
        svgEl('circle', { class: 'track', cx: 15, cy: 15, r: 12 }),
        svgEl('circle', { class: 'fill', cx: 15, cy: 15, r: 12, 'stroke-dasharray': C, 'stroke-dashoffset': C })));
    requestAnimationFrame(paintMeter);
    return meterEl;
  }
  const logoTile = () => h('span', { class: 'tile' }, svgEl('svg', { viewBox: '0 0 300 300' }, svgEl('path', { d: LOGO_PATH })));

  function setBar(kind, opts = {}) {
    clear(bar);
    if (kind === 'home') {
      bar.append(logoTile(), h('span', { class: 'name' }, 'ميدي فويز'), h('span', { class: 'grow' }), meter(),
        h('button', { class: 'icon-btn', 'aria-label': 'القائمة', onclick: openSettings }, icon('menu')));
    } else {
      meterEl = null;
      bar.append(h('button', { class: 'icon-btn back', 'aria-label': 'رجوع', onclick: () => history.back() }, icon('back')),
        h('span', { class: 'title' }, opts.title || ''), ...(opts.actions || []));
    }
  }
  ctx.setBar = setBar;

  // ── التنقل ──
  async function go(name, params = {}, { replace = false } = {}) {
    closeTopSheet();
    ctx.view = name;
    ctx.guard = null;
    if (name !== 'home') { replace ? history.replaceState({ v: name }, '') : history.pushState({ v: name }, ''); }
    clear(main);
    scrollTo(0, 0);
    const el = h('main', { class: 'view' });
    main.append(el);
    if (name === 'home') await viewHome(el);
    else if (name === 'link') viewLink(el, params);
    else if (name === 'new') viewNew(ctx, el, params);
    else if (name === 'run') viewRun(ctx, el, params);
    else if (name === 'rewrite') await viewRewrite(ctx, el, params);
    else if (name === 'doc') await viewDoc(ctx, el, params);
  }
  function back() { history.back(); }
  addEventListener('popstate', async () => {
    if (closeTopSheet()) { history.pushState({ v: ctx.view }, ''); return; }
    if (ctx.guard) {
      history.pushState({ v: ctx.view }, '');
      if (!(await ctx.guard())) return;
      history.back();
      ctx.guard = null;
      return;
    }
    if (ctx.view !== 'home') go('home');
  });

  // ── الرئيسية ──
  async function viewHome(el) {
    setBar('home');
    ctx.ribbon.set({ y: Math.min(0.2, 132 / innerHeight), energy: 0.5, alpha: 1 });
    const s = ctx.session;
    const noKeys = !s.keys.groq.linked && !s.keys.gemini.linked;

    const glyph = svgEl('svg', { class: 'glyph', viewBox: '0 0 132 64', fill: 'none', stroke: 'currentColor', 'stroke-width': 3.2, 'stroke-linejoin': 'miter', 'stroke-linecap': 'square' },
      svgEl('path', { d: 'M4 32 L12 27 L24 41 L38 14 L52 50 L62 26 L70 32' }),
      svgEl('path', { d: 'M82 20 H128 M82 32 H120 M82 44 H126', 'stroke-width': 3.2, opacity: 0.9 }));
    const slab = h('button', { class: 'slab', onclick: () => (noKeys ? go('link') : pickFile()) },
      glyph, h('strong', null, 'اختر تسجيل المحاضرة'), h('span', null, 'صوت أو فيديو، بأي مدة'),
      h('span', { class: 'btn cta' }, icon('upload'), 'رفع تسجيل'));
    slab.addEventListener('dragover', (e) => { e.preventDefault(); slab.classList.add('over'); });
    slab.addEventListener('dragleave', () => slab.classList.remove('over'));
    slab.addEventListener('drop', (e) => { e.preventDefault(); slab.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) (noKeys ? go('link') : go('new', { file: f })); });

    const list = h('div', { class: 'stack' });
    el.append(h('div', { class: 'stack lg' },
      h('div', { class: 'stack hero' },
        h('h1', { class: 'h-display' }, 'محاضرتك الصوتية، ملزمة مشروحة'),
        h('p', { class: 'lead' }, 'ارفع التسجيل، يفهم الشرح ويكتبه لك ملزمة مفصّلة ومرتبة بدون اختصار، بمصطلحاتها الطبية وصور مطابقة، جاهزة PDF.')),
      s.notice ? h('div', { class: 'banner info' }, icon('info'), h('span', null, s.notice)) : null,
      noKeys
        ? h('div', { class: 'banner' }, icon('key'), h('span', null, 'قبل أول محاضرة اربط مفاتيحك المجانية. دقيقتين ومرة وحدة.'), h('button', { class: 'btn small amber', onclick: () => go('link') }, 'ربط'))
        : !s.keys.gemini.linked
          ? h('div', { class: 'banner' }, icon('warn'), h('span', null, 'بدون Gemini تقل دقة المصطلحات الطبية. اربطه مجاناً.'), h('button', { class: 'btn small amber', onclick: () => go('link') }, 'ربط'))
          : !s.keys.groq.linked
            ? h('div', { class: 'banner info' }, icon('info'), h('span', null, 'اربط Groq حتى تضمن 8 ساعات يومياً ويشتغل الاثنين سوا.'), h('button', { class: 'btn small ghost', onclick: () => go('link') }, 'ربط'))
            : null,
      slab,
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => (noKeys ? go('link') : openRecorder(ctx)) }, icon('mic'), 'تسجيل مباشر')),
      h('div', { class: 'stack' }, h('h2', { class: 'h-section' }, 'محاضراتي'), list)));

    const items = await db.listLectures().catch(() => []);
    if (!items.length) list.append(h('div', { class: 'empty' }, 'ما عندك محاضرات بعد. ارفع أول تسجيل وتظهر هنا.'));
    for (const it of items) {
      list.append(h('button', { class: 'lec', onclick: () => go('doc', { id: it.id }) },
        h('b', { dir: 'auto' }, it.title || 'محاضرة بدون عنوان'),
        icon('back'),
        h('small', null, [it.mode === 'notes' ? 'شرح مفصّل' : 'نص مفرّغ', it.subject, fmtDuration(it.duration), `${it.words.toLocaleString('en-US')} كلمة`, fmtAgo(it.createdAt)].filter(Boolean).join('  ·  '))));
    }
  }

  // ── ربط المفاتيح ──
  function viewLink(el) {
    setBar('sub', { title: 'ربط المفاتيح' });
    ctx.ribbon.set({ alpha: 0 });
    const cards = h('div', { class: 'stack' });
    const done = h('button', { class: 'btn wide', onclick: () => go('home') }, 'تم، رجّعني للرئيسية');

    function card(id) {
      const p = PROVIDERS[id];
      const state = ctx.session.keys[id];
      const box = h('section', { class: 'card prov' });
      const input = h('input', { class: 'input', type: 'text', placeholder: 'الصق المفتاح هنا', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, 'aria-label': `مفتاح ${p.name}` });
      const pasteBtn = h('button', { class: 'btn small', onclick: paste }, icon('paste'), 'لصق المفتاح');
      async function submit(raw) {
        const key = String(raw || '').trim().replace(/^["']|["']$/g, '');
        if (key.length < 20) { ctx.toast('الصق المفتاح كاملاً.', 'err'); return; }
        pasteBtn.disabled = true;
        const label = pasteBtn.lastChild;
        label.textContent = 'أتحقق…';
        const r = await ctx.api('/api/keys', { method: 'POST', body: { key } }); // الخادم يميّز المزوّد من شكل المفتاح
        pasteBtn.disabled = false;
        label.textContent = 'لصق المفتاح';
        if (r.ok && r.data?.active) {
          ctx.session = MV.session = r.data;
          ctx.caps = null;
          ctx.ribbon.kick(0.8);
          ctx.toast(`تم ربط ${PROVIDERS[r.data.linked]?.name || p.name}`, 'ok');
          render();
        } else {
          const e = r.data?.error;
          ctx.toast(e === 'bad_key' ? 'المفتاح غير صحيح. انسخه كاملاً من صفحة المفاتيح.' : e === 'provider_down' ? 'تعذّر التحقق من المفتاح الآن. جرّب بعد قليل.' : 'تعذّر الحفظ. تأكد من الإنترنت.', 'err');
        }
      }
      async function paste() {
        if (input.value.trim()) return submit(input.value);
        try {
          const text = await navigator.clipboard.readText();
          if (text && text.trim().length >= 20) { input.value = text.trim(); return submit(text); }
          ctx.toast('الحافظة فارغة. انسخ المفتاح أولاً.', 'err');
        } catch {
          input.focus();
          ctx.toast('اضغط مطولاً داخل الحقل واختر «لصق».');
        }
      }
      input.addEventListener('paste', () => setTimeout(() => { if (input.value.trim().length >= 20) submit(input.value); }, 30));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(input.value); });

      box.append(h('div', { class: 'prov-head' },
        h('span', { class: 'prov-badge' }, p.badge),
        h('div', null, h('h3', null, p.name), h('p', null, h('b', null, `${p.role}. `), p.desc)),
        state.linked ? h('span', { class: 'chip ok' }, icon('check'), 'مربوط') : h('span', { class: 'chip off' }, 'غير مربوط')));
      if (state.linked) {
        box.append(h('div', { class: 'linked-row' }, h('span', null, 'المفتاح'), h('code', null, state.hint),
          h('button', { class: 'btn ghost small', onclick: async () => {
            if (!(await confirm({ title: `فك ربط ${p.name}`, message: 'تقدر تربطه مرة ثانية بأي وقت.', ok: 'فك الربط', danger: true }))) return;
            const r = await ctx.api(`/api/keys?provider=${id}`, { method: 'DELETE' });
            if (r.ok && r.data?.active) { ctx.session = MV.session = r.data; ctx.caps = null; render(); }
          } }, 'فك الربط')));
      } else {
        box.append(
          h('ol', { class: 'steps' }, p.steps.map((t) => h('li', null, t))),
          h('a', { class: 'btn ghost', href: p.url, target: '_blank', rel: 'noopener' }, icon('external'), `فتح ${p.site}`),
          h('div', { class: 'paste-row' }, input, pasteBtn));
      }
      return box;
    }
    function render() {
      clear(cards).append(card('gemini'), card('groq'));
      const any = ctx.session.keys.groq.linked || ctx.session.keys.gemini.linked;
      done.disabled = !any;
    }
    render();
    el.append(h('div', { class: 'stack lg' },
      h('div', { class: 'stack' },
        h('h1', { class: 'h-display' }, 'اربط محركاتك المجانية'),
        h('p', { class: 'lead' }, 'المفتاحان مجانيان ومن حسابك أنت، فحصتك اليومية إلك وحدك. الأفضل تربط الاثنين: Gemini للدقة و Groq للساعات.')),
      cards,
      h('p', { class: 'dim' }, 'المفاتيح تنحفظ مشفّرة وتُستخدم لمحاضراتك فقط. النسخة المجانية من Google قد تستعمل المحتوى لتحسين خدماتها، فلا ترفع تسجيلات خاصة.'),
      done));
  }

  // ── الإعدادات ──
  function openSettings() {
    const s = ctx.session, u = s.usage;
    const left = Math.max(0, u.limit_sec - u.used_sec);
    const keyRow = (id) => h('div', { class: 'row between' },
      h('span', null, h('b', { class: 'ltr' }, PROVIDERS[id].name), `  ${PROVIDERS[id].role}`),
      s.keys[id].linked ? h('span', { class: 'chip ok' }, icon('check'), 'مربوط') : h('span', { class: 'chip warn' }, 'غير مربوط'));
    const sh = sheet({
      title: 'حسابي',
      body: h('div', { class: 'stack lg' },
        h('dl', { class: 'kv' },
          s.user.label ? [h('dt', null, 'الاسم'), h('dd', null, s.user.label)] : null,
          h('dt', null, 'الكود'), h('dd', { class: 'ltr num' }, s.user.code),
          h('dt', null, 'الصلاحية'), h('dd', null, s.user.expires_at ? `حتى ${new Date(s.user.expires_at).toLocaleDateString('ar-IQ-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' })}` : 'دائمة'),
          h('dt', null, 'المتبقي اليوم'), h('dd', { class: 'num' }, `${fmtHM(left)} من ${fmtHM(u.limit_sec)} ساعة`),
          h('dt', null, 'مجموع ما حوّلته'), h('dd', { class: 'num' }, `${fmtHM(u.total_sec)} ساعة، ${u.lectures} محاضرة`)),
        h('div', { class: 'card stack' }, keyRow('gemini'), keyRow('groq'),
          h('button', { class: 'btn ghost small', onclick: () => { sh.close(); go('link'); } }, icon('key'), 'إدارة المفاتيح')),
        h('p', { class: 'dim' }, 'المحاضرات محفوظة على هذا الجهاز فقط. نزّل PDF لكل محاضرة حتى تبقى عندك. لتثبيت الموقع كتطبيق: من قائمة المتصفح اختر «إضافة إلى الشاشة الرئيسية».'),
        s.support?.url ? h('a', { class: 'btn ghost', href: s.support.url, target: '_blank', rel: 'noopener' }, icon('external'), s.support.label || 'تواصل مع المسؤول') : null),
    });
  }

  db.prune().catch(() => {});
  history.replaceState({ v: 'home' }, '');
  const fresh = !ctx.session.keys.groq.linked && !ctx.session.keys.gemini.linked;
  await go(fresh ? 'link' : 'home');
  if (!fresh) loadCaps().catch(() => {});
}
