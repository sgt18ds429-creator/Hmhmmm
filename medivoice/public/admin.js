// admin.js — لوحة تحكم ميدي فويز: الأكواد، النشاط، الإعدادات.
// كل نص يأتي من الخادم يُدرج كنص (text node) عبر h()، ولا يُستعمل innerHTML.

import { h, icon, clear, sheet, confirm, fmtHM } from '/app/ui.js';
import { logoEl } from '/brand.js';
import { applyTheme, setMode, themeButton, ripples } from '/theme.js';
import { DEFAULT_THEME, THEME_PRESETS, THEME_FONTS, SPLASH_MS, cleanTheme, themeCss } from '/theme-core.js';

applyTheme();
ripples();

const DAY = 86400000;
// رابط الموقع في رسالة التفعيل: الرابط الرئيسي الذي يحقنه الخادم (HOME في src/server.js)
const SITE = document.querySelector('meta[name="mv-home"]')?.content || location.origin;
const TABS = [['codes', 'الأكواد', 'key'], ['activity', 'النشاط', 'pulse'], ['design', 'التصميم', 'palette'], ['settings', 'الإعدادات', 'gear']];

const root = document.getElementById('adm');
const state = { data: null, tab: 'codes', filter: 'all', query: '', loadedAt: 0 };

// ───────── أدوات ─────────
const logo = () => logoEl();

function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => { el.classList.add('bye'); setTimeout(() => el.remove(), 320); }, kind === 'err' ? 5200 : 2800);
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') init.headers['x-mv'] = '1';
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  try {
    const res = await fetch(path, init);
    const data = await res.json().catch(() => null);
    if (res.status === 401 && state.data && path !== '/api/admin/login') { state.data = null; viewLogin('انتهت الجلسة. ادخل من جديد.'); }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

const dateStr = (ts) => new Date(ts).toLocaleDateString('ar-IQ-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' });
const dateTime = (ts) => new Date(ts).toLocaleString('ar-IQ-u-nu-latn', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'الآن';
  if (s < 3600) return `قبل ${Math.floor(s / 60)} د`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} س`;
  if (s < 30 * 86400) return `قبل ${Math.floor(s / 86400)} يوم`;
  return dateStr(ts);
}
let regions = null;
try { regions = new Intl.DisplayNames(['ar'], { type: 'region' }); } catch { /* متصفح قديم */ }
function country(code) {
  if (!code) return '';
  try { return regions?.of(code) || code; } catch { return code; }
}
const place = (d) => [d.city, country(d.country)].filter(Boolean).join('، ');

async function copy(text, done = 'انتسخ') {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h('textarea', { value: text, readOnly: true, style: { position: 'fixed', top: '0', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* ممنوع */ }
    ta.remove();
  }
  toast(ok ? done : 'تعذّر النسخ. انسخ يدوياً.', ok ? 'ok' : 'err');
  return ok;
}
async function share(text) {
  if (navigator.share) { try { await navigator.share({ text }); } catch { /* أُلغيت */ } } else await copy(text, 'انتسخت الرسالة');
}

function statusOf(c) {
  if (c.status !== 'active') return { key: 'stop', label: 'موقوف', chip: 'red' };
  if (c.expired) return { key: 'end', label: 'منتهي', chip: 'warn' };
  if (c.devices.some((d) => !d.out)) return { key: 'on', label: 'مفعّل', chip: 'ok' };
  if (c.devices.length) return { key: 'wait', label: 'سجّل خروج', chip: '' };
  if (c.activated_at) return { key: 'wait', label: 'بانتظار جهاز جديد', chip: '' };
  return { key: 'wait', label: 'لم يُفعَّل بعد', chip: 'off' };
}
/** عدد الأيام بالعربي: يوم واحد، يومين، 3 أيام، 30 يوم */
const daysText = (n) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومين' : n >= 3 && n <= 10 ? `${n} أيام` : `${n} يوم`);
function validity(c) {
  if (!c.activated_at) return c.duration_days ? `${daysText(c.duration_days)} من أول تفعيل` : 'دائم';
  if (!c.expires_at) return 'دائم';
  const ms = c.expires_at - Date.now();
  if (ms <= 0) return `انتهى ${dateStr(c.expires_at)}`;
  if (ms < DAY) { const hrs = Math.ceil(ms / 3600000); return hrs <= 1 ? 'ينتهي خلال ساعة' : `باقي ${hrs} ساعة`; }
  const left = Math.ceil(ms / DAY);
  return left === 1 ? 'ينتهي خلال يوم' : `باقي ${daysText(left)}`;
}
function inviteText(c) {
  return [
    c.label ? `مرحباً ${c.label}،` : 'مرحباً،',
    'هذا كود تفعيلك في ميدي فويز:',
    '',
    c.display,
    '',
    `1) افتح الرابط من متصفح موبايلك (Chrome أو Safari): ${SITE}`,
    '2) اكتب الكود واضغط «تفعيل».',
    '3) اربط مفاتيحك المجانية من داخل الموقع، دقيقتين ومرة وحدة.',
    '',
    'الكود يشتغل على جهاز واحد فقط، ففعّله من الموبايل اللي تستخدمه دائماً.',
  ].join('\n');
}

function codeCells(display) {
  const raw = display.replace(/^MV-/, '').replace(/-/g, '');
  const cell = (ch, i) => h('span', { class: 'cell filled', style: { animationDelay: `${i * 45}ms` } }, ch);
  return h('div', { class: 'code-box', role: 'img', 'aria-label': display },
    h('span', { class: 'pre' }, 'MV'), h('span', { class: 'dash' }),
    [...raw.slice(0, 4)].map((ch, i) => cell(ch, i)), h('span', { class: 'dash' }), [...raw.slice(4)].map((ch, i) => cell(ch, i + 4)));
}

function stepper(start, min, max) {
  let value = start;
  const out = h('output', null, String(value));
  const minus = h('button', { type: 'button', 'aria-label': 'أقل', onclick: () => set(value - 1) }, '−');
  const plus = h('button', { type: 'button', 'aria-label': 'أكثر', onclick: () => set(value + 1) }, '+');
  function set(v) {
    value = Math.min(max, Math.max(min, v));
    out.textContent = String(value);
    minus.disabled = value <= min;
    plus.disabled = value >= max;
  }
  set(value);
  return { el: h('div', { class: 'stepper' }, minus, out, plus), get value() { return value; } };
}
const field = (label, control, hint) => h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', null, hint) : null);

/** الحد اليومي كنص: «2:30 ساعة» أو «بلا حد». */
const limitText = (sec) => (sec ? `${fmtHM(sec)} ساعة` : 'بلا حد');

/** الساعات المسموحة باليوم: عدد ساعات أو «بلا حد» (يُرسل 0). sec = الحد الحالي بالثواني، و 0 = بلا حد. */
function hoursControl(sec, label = 'الساعات المسموحة باليوم') {
  let unlimited = Number(sec) === 0;
  const input = h('input', { type: 'number', min: 0.5, max: 24, step: 0.5, value: unlimited ? 8 : Math.round((sec / 3600) * 100) / 100, inputMode: 'decimal', 'aria-label': 'عدد الساعات' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'الحد اليومي' });
  const hint = h('small', null);
  const paint = () => {
    clear(seg).append(
      h('button', { type: 'button', 'aria-pressed': String(!unlimited), onclick: () => { unlimited = false; paint(); input.focus(); } }, 'عدد ساعات'),
      h('button', { type: 'button', 'aria-pressed': String(unlimited), onclick: () => { unlimited = true; paint(); } }, 'بلا حد'));
    input.hidden = unlimited;
    hint.textContent = unlimited
      ? 'الموقع ما يوقفه. يبقى حد مفاتيحه المجانية، وكل مفتاح يضيفه يزيد حصته.'
      : 'تتجدد الساعات كل يوم الساعة 12 بالليل بتوقيت بغداد.';
  };
  paint();
  return { el: h('div', { class: 'field' }, h('span', null, label), seg, input, hint), get value() { return unlimited ? 0 : Number(input.value) || 8; } };
}

// ───────── الدخول ─────────
function viewLogin(message = '') {
  root.classList.remove('in');
  clear(root);
  const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'كلمة المرور', 'aria-label': 'كلمة مرور لوحة التحكم' });
  const msg = h('p', { class: 'gate-msg', role: 'alert' }, message);
  const btn = h('button', { class: 'btn wide', type: 'submit' }, 'دخول');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (!input.value || btn.disabled) return;
    btn.disabled = true;
    const r = await api('/api/admin/login', { method: 'POST', body: { password: input.value } });
    btn.disabled = false;
    if (r.ok) { msg.textContent = ''; await load(); return; }
    msg.textContent = r.status === 429 ? 'محاولات كثيرة. جرّب بعد ربع ساعة.' : r.status === 401 ? 'كلمة المرور غير صحيحة.' : 'تعذّر الاتصال. حاول مرة ثانية.';
    input.select();
  } }, h('label', { class: 'field' }, input), msg, btn);
  root.append(h('main', { class: 'gate' }, h('div', { class: 'gate-card' },
    h('div', { class: 'brand-tile' }, logo()),
    h('h1', { class: 'wordmark' }, 'ميدي فويز', h('small', { class: 'ltr' }, 'MediVoice')),
    h('p', { class: 'gate-kicker' }, icon('shield'), 'لوحة التحكم'),
    form)));
  input.focus();
}

// ───────── الهيكل ─────────
async function load(keepScroll = false) {
  const r = await api('/api/admin/overview');
  if (r.ok && r.data?.ok) {
    const y = scrollY;
    state.data = r.data;
    state.loadedAt = Date.now();
    renderApp();
    if (keepScroll) scrollTo(0, y);
    return true;
  }
  if (r.status === 401 || !state.data) viewLogin(r.status === 401 ? '' : 'تعذّر الاتصال. تأكد من الإنترنت.');
  else toast('تعذّر تحديث البيانات.', 'err');
  return false;
}

function renderApp() {
  root.classList.add('in');
  // تصميم لم يُحفظ والمسؤول ترك تبويب التصميم: ترجع المعاينة للمحفوظ
  if (state.tab !== 'design' && state.leaveDesign) { state.leaveDesign(); state.leaveDesign = null; }
  clear(root);
  const view = h('main', { class: 'view' });
  root.append(
    h('header', { class: 'bar' },
      h('span', { class: 'tile' }, logo(false)), h('span', { class: 'name' }, 'لوحة التحكم'), h('span', { class: 'grow' }),
      themeButton(),
      h('button', { class: 'icon-btn', 'aria-label': 'تحديث البيانات', onclick: async (e) => { e.currentTarget.disabled = true; if (await load(true)) toast('تحدّثت البيانات'); } }, icon('refresh'))),
    view,
    h('nav', { class: 'nav', 'aria-label': 'أقسام اللوحة' }, TABS.map(([id, label, ic]) =>
      h('button', { 'aria-current': state.tab === id ? 'page' : null, onclick: () => { if (state.tab === id) return; state.tab = id; renderApp(); scrollTo(0, 0); } }, icon(ic), label))));
  ({ codes: tabCodes, activity: tabActivity, design: tabDesign, settings: tabSettings })[state.tab](view);
}

const stat = (value, sub, label) => h('div', { class: 'stat' }, h('b', null, value, sub ? h('small', null, sub) : null), h('span', null, label));

// ───────── الأكواد ─────────
function tabCodes(view) {
  const d = state.data, t = d.totals;
  const counts = { all: d.codes.length, on: 0, wait: 0, off: 0 };
  for (const c of d.codes) { const k = statusOf(c).key; counts[k === 'on' ? 'on' : k === 'wait' ? 'wait' : 'off']++; }
  const FILTERS = [['all', 'الكل'], ['on', 'مفعّل'], ['wait', 'بانتظار التفعيل'], ['off', 'موقوف أو منتهي']];
  const listEl = h('div', { class: 'stack' });
  const filtersEl = h('div', { class: 'filters', role: 'group', 'aria-label': 'تصفية الأكواد' });

  function paintFilters() {
    clear(filtersEl).append(...FILTERS.map(([id, label]) =>
      h('button', { 'aria-pressed': String(state.filter === id), onclick: () => { state.filter = id; paintFilters(); paintList(); } }, label, h('b', null, String(counts[id])))));
  }
  function paintList() {
    const q = state.query.trim().toLowerCase();
    const qc = state.query.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const items = d.codes.filter((c) => {
      const k = statusOf(c).key;
      if (state.filter === 'on' && k !== 'on') return false;
      if (state.filter === 'wait' && k !== 'wait') return false;
      if (state.filter === 'off' && k !== 'stop' && k !== 'end') return false;
      if (!q) return true;
      return (c.label || '').toLowerCase().includes(q) || (c.note || '').toLowerCase().includes(q) || (qc.length >= 2 && `MV${c.code}`.includes(qc));
    });
    clear(listEl);
    if (!d.codes.length) listEl.append(h('div', { class: 'empty' }, 'ما عندك أكواد بعد. أنشئ أول كود وأرسله للمستخدم.'));
    else if (!items.length) listEl.append(h('div', { class: 'empty' }, 'ماكو كود يطابق البحث.'));
    for (const c of items) listEl.append(codeCard(c));
  }

  const search = h('input', { class: 'input', type: 'search', placeholder: 'ابحث بالاسم أو الكود', value: state.query, 'aria-label': 'بحث في الأكواد', oninput: () => { state.query = search.value; paintList(); } });
  view.append(h('div', { class: 'stack lg' },
    h('div', { class: 'stats' },
      stat(String(t.activated || 0), ` / ${t.codes}`, 'كود مفعّل'),
      stat(fmtHM(t.today_sec), '', 'ساعة اليوم'),
      stat(String(t.today_users || 0), '', 'مستخدم نشط اليوم'),
      stat(String(t.lectures || 0), '', 'محاضرة محوّلة')),
    h('button', { class: 'btn wide', onclick: openCreate }, icon('plus'), 'كود جديد'),
    d.codes.some((c) => c.gemini || c.groq) ? h('button', { class: 'btn ghost wide', onclick: openKeyCheck }, icon('shield'), 'فحص مفاتيح الطلاب') : null,
    h('div', { class: 'tools' },
      h('div', { class: 'sec-title' }, h('h2', { class: 'h-section' }, 'الأكواد'), h('small', null, `${d.codes.length} كود`)),
      d.codes.length > 4 ? h('div', { class: 'search' }, icon('search'), search) : null,
      d.codes.length ? filtersEl : null),
    listEl));
  paintFilters();
  paintList();
}

/** تنبيهات مفاتيح الكود كما شافها الخادم: كل سطر مشكلة ووش يسوي المسؤول */
function keyWarnings(c) {
  const w = c.warn;
  if (!w) return [];
  const names = (list) => (list.length > 3 ? `${list.slice(0, 3).join('، ')} و${list.length - 3} غيرهم` : list.join('، '));
  const out = [];
  if (w.restricted) out.push(`Google قفل الحصة المجانية لـ${w.restricted > 1 ? `${w.restricted} من مفاتيح Gemini` : 'مفتاح Gemini'}. سوّ مفتاح من حساب Google ثاني واربطه بداله.`);
  if (w.invalid) out.push(`${w.invalid > 1 ? `${w.invalid} مفاتيح مرفوضة` : 'مفتاح مرفوض'} (انحذف أو انقفل). اربط مفتاح جديد.`);
  if (w.shared?.length) out.push(`نفس المفتاح مربوط عند: ${names(w.shared)}. حصته المجانية تنقسم بينهم.`);
  if (w.same_org?.length) out.push(`مفاتيح Groq من نفس حساب Groq اللي عند: ${names(w.same_org)}. الحساب الواحد إله حصة وحدة بالساعة واليوم، فخلّي لكل طالب حساب Groq خاص.`);
  return out;
}

function codeCard(c) {
  const st = statusOf(c);
  const warns = keyWarnings(c);
  const dev = c.devices.find((d) => !d.out) || c.devices[0];
  const pct = c.daily_limit_sec ? Math.min(100, (c.used_sec / c.daily_limit_sec) * 100) : 0;
  return h('button', { class: `cc ${st.key}`, onclick: () => openCode(c) },
    h('div', { class: 'cc-top' }, h('b', { class: c.label ? '' : 'anon', dir: 'auto' }, c.label || 'بدون اسم'), h('span', { class: `chip ${st.chip}` }, st.label)),
    h('div', { class: 'cc-line' }, h('span', { class: 'cc-code ltr' }, c.display), h('time', null, validity(c))),
    dev ? h('div', { class: 'cc-line' }, icon('phone'), h('span', null, [dev.os, dev.browser, place(dev), dev.out ? 'سجّل خروج' : ''].filter(Boolean).join('، ')), h('time', null, ago(dev.last_seen))) : null,
    warns.length ? h('div', { class: 'cc-warn' }, icon('warn'), h('span', null, warns.length > 1 ? `${warns.length} مشاكل بالمفاتيح، افتحه للتفاصيل` : warns[0])) : null,
    c.activated_at ? h('div', { class: 'use' },
      c.daily_limit_sec ? h('div', { class: `track${pct > 85 ? ' hot' : ''}` }, h('i', { style: { width: `${pct}%` } })) : null,
      h('span', null, h('b', null, fmtHM(c.used_sec)), c.daily_limit_sec ? ` من ${fmtHM(c.daily_limit_sec)} اليوم` : ' اليوم، بلا حد')) : null);
}

async function mutate(request, done, sheets = []) {
  const r = await request;
  if (!r.ok) { toast('ما تم. تأكد من الإنترنت وحاول مرة ثانية.', 'err'); return false; }
  for (const s of sheets) s?.close();
  await load(true);
  if (done) toast(done, 'ok');
  return true;
}

function openCode(c) {
  const st = statusOf(c);
  const path = `/api/admin/codes/${c.code}`;
  const rows = [];
  const row = (k, v, cls) => { if (v !== '' && v !== null && v !== undefined) rows.push(h('dt', null, k), h('dd', { class: cls || '', dir: 'auto' }, v)); };
  row('الصلاحية', validity(c));
  row('الحد اليومي', limitText(c.daily_limit_sec));
  if (c.activated_at) {
    row('استخدام اليوم', `${fmtHM(c.used_sec)} ساعة`);
    row('المجموع', `${fmtHM(c.total_sec)} ساعة، ${c.lectures} محاضرة، ${c.pdfs} PDF`);
    const keys = (name, n) => (n ? (n > 1 ? `${name} (${n === 2 ? 'مفتاحين' : `${n} مفاتيح`})` : name) : '');
    row('المفاتيح', [keys('Gemini', c.gemini), keys('Groq', c.groq)].filter(Boolean).join(' و ') || 'لم يربط مفاتيحه بعد');
  }
  for (const dev of c.devices) {
    row('الجهاز', [dev.os, dev.browser, dev.out ? 'سجّل خروج (مكانه محجوز لنفس الهاتف)' : ''].filter(Boolean).join('، '));
    row('المكان', place(dev));
    row('فُعّل', dateTime(dev.first_seen));
    row('آخر ظهور', ago(dev.last_seen));
  }
  if (c.max_devices > 1) row('الأجهزة المسموحة', `${c.devices.length} من ${c.max_devices}`);
  row('أُنشئ', dateStr(c.created_at));
  row('ملاحظة', c.note);

  const item = (label, ic, fn, cls) => h('button', { class: cls || '', onclick: fn }, icon(ic), label);
  const warns = keyWarnings(c);
  const s = sheet({ title: c.label || 'كود بدون اسم', body: h('div', { class: 'stack lg' },
    h('div', { class: 'code-show' }, codeCells(c.display), h('span', { class: `chip ${st.chip}` }, st.label)),
    warns.length ? h('div', { class: 'key-warn' }, h('b', null, icon('warn'), 'مشاكل بمفاتيح هذا الطالب'), h('ul', null, warns.map((t) => h('li', null, t)))) : null,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => copy(inviteText(c), 'انتسخت رسالة التفعيل') }, icon('copy'), 'نسخ الرسالة'),
      h('button', { class: 'btn ghost small', onclick: () => share(inviteText(c)) }, icon('share'), 'مشاركة')),
    h('dl', { class: 'kv' }, rows),
    h('div', { class: 'menu' },
      item('نسخ الكود فقط', 'copy', () => copy(c.display, 'انتسخ الكود')),
      c.devices.length ? item('تصفير الجهاز', 'refresh', async () => {
        if (!(await confirm({ title: 'تصفير الجهاز؟', message: 'يُلغى التفعيل من جهازه الحالي، ويقدر يفعّل نفس الكود على جهاز جديد.', ok: 'تصفير' }))) return;
        mutate(api(`${path}/reset`, { method: 'POST' }), 'تصفّر الجهاز. الكود جاهز لتفعيل جديد.', [s]);
      }) : null,
      c.status === 'active'
        ? item('إيقاف مؤقت', 'pause', () => mutate(api(path, { method: 'PATCH', body: { status: 'suspended' } }), 'توقّف الكود.', [s]))
        : item('إعادة التشغيل', 'play', () => mutate(api(path, { method: 'PATCH', body: { status: 'active' } }), 'رجع الكود يشتغل.', [s])),
      item(c.expires_at || c.duration_days ? 'تمديد الصلاحية' : 'تحديد مدة للكود', 'calendar', () => openExtend(c, s)),
      item('تعديل البيانات', 'edit', () => openEdit(c, s)),
      item('حذف الكود', 'trash', async () => {
        if (!(await confirm({ title: 'حذف الكود؟', message: 'ينحذف الكود وسجل استخدامه نهائياً، وينقفل الموقع على صاحبه.', ok: 'حذف', danger: true }))) return;
        mutate(api(path, { method: 'DELETE' }), 'انحذف الكود.', [s]);
      }, 'red'))) });
}

function openExtend(c, parent) {
  const path = `/api/admin/codes/${c.code}`;
  const limited = !!(c.expires_at || c.duration_days);
  const add = (label, days) => h('button', { onclick: () => mutate(api(path, { method: 'PATCH', body: { extend_days: days } }), 'تحدّثت الصلاحية.', [s, parent]) }, icon('calendar'), label);
  const s = sheet({ title: limited ? 'تمديد الصلاحية' : 'تحديد مدة للكود', body: h('div', { class: 'stack' },
    h('p', { class: 'muted' }, limited ? `الحالي: ${validity(c)}. اختر المدة اللي تنضاف.` : c.activated_at ? 'الكود دائم الآن. اختر مدة تبدأ من اليوم.' : 'الكود دائم الآن. اختر مدة تبدأ من أول تفعيل.'),
    h('div', { class: 'menu' },
      add('يوم واحد', 1), add('أسبوع', 7), add('شهر', 30), add('3 أشهر', 90), add('6 أشهر', 180), add('سنة', 365),
      limited ? h('button', { onclick: () => mutate(api(path, { method: 'PATCH', body: { expires_at: null } }), 'صار الكود دائم.', [s, parent]) }, icon('check'), 'خلّيه دائم') : null)) });
}

function openEdit(c, parent) {
  const name = h('input', { type: 'text', value: c.label || '', maxLength: 80 });
  const note = h('input', { type: 'text', value: c.note || '', maxLength: 200, placeholder: 'اختياري' });
  const hours = hoursControl(c.daily_limit_sec);
  const devices = stepper(c.max_devices, 1, 5);
  const btn = h('button', { class: 'btn wide', type: 'submit' }, 'حفظ');
  const s = sheet({ title: 'تعديل البيانات', body: h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    const ok = await mutate(api(`/api/admin/codes/${c.code}`, { method: 'PATCH', body: { label: name.value.trim(), note: note.value.trim(), daily_hours: hours.value, max_devices: devices.value } }), 'انحفظ التعديل.', [s, parent]);
    if (!ok) btn.disabled = false;
  } },
    field('اسم المستخدم', name),
    field('ملاحظة', note),
    hours.el,
    h('div', { class: 'field' }, h('span', null, 'عدد الأجهزة المسموحة'), devices.el, h('small', null, 'الأصل جهاز واحد. زيده فقط لمن تريد تسمحله بأكثر.')),
    btn) });
}

function openCreate() {
  const cfg = state.data.settings;
  const name = h('input', { type: 'text', placeholder: 'مثلاً: أحمد علي، مرحلة ثالثة', maxLength: 80 });
  const note = h('input', { type: 'text', placeholder: 'اختياري', maxLength: 200 });
  const custom = h('input', { type: 'number', min: 1, max: 3650, inputMode: 'numeric', placeholder: 'عدد الأيام' });
  const customWrap = h('label', { class: 'field', hidden: true }, h('span', null, 'عدد الأيام'), custom);
  const DUR = [[1, 'يوم'], [7, 'أسبوع'], [30, 'شهر'], [90, '3 أشهر'], [365, 'سنة'], [null, 'دائم'], ['x', 'عدد أيام']];
  let dur = null;
  const seg = h('div', { class: 'seg wrap', role: 'group', 'aria-label': 'مدة الكود' });
  const paintSeg = () => clear(seg).append(...DUR.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(dur === v), onclick: () => { dur = v; customWrap.hidden = v !== 'x'; paintSeg(); if (v === 'x') custom.focus(); } }, label)));
  paintSeg();
  const hours = hoursControl(Math.round(Number(cfg.defaultDailyHours ?? 8) * 3600));
  const devices = stepper(1, 1, 5);
  const count = stepper(1, 1, 50);
  const btn = h('button', { class: 'btn wide', type: 'submit' }, icon('plus'), 'إنشاء الكود');
  const s = sheet({ title: 'كود جديد', body: h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const days = dur === 'x' ? parseInt(custom.value, 10) : dur;
    if (dur === 'x' && !(days >= 1)) { toast('اكتب عدد الأيام.', 'err'); custom.focus(); return; }
    btn.disabled = true;
    const r = await api('/api/admin/codes', { method: 'POST', body: { count: count.value, label: name.value.trim(), note: note.value.trim(), days, max_devices: devices.value, daily_hours: hours.value } });
    if (!r.ok || !r.data?.created?.length) { btn.disabled = false; toast('تعذّر إنشاء الكود. حاول مرة ثانية.', 'err'); return; }
    s.close();
    await load(true);
    openCreated(r.data.created);
  } },
    field('اسم المستخدم', name, 'يظهرلك في القائمة حتى تعرف الكود لمنو.'),
    h('div', { class: 'field' }, h('span', null, 'مدة الكود'), seg, h('small', null, 'المدة تبدأ من أول تفعيل، مو من الآن.')),
    customWrap,
    hours.el,
    h('details', { class: 'more' }, h('summary', null, 'خيارات إضافية'),
      h('div', { class: 'stack' },
        h('div', { class: 'field' }, h('span', null, 'عدد الأكواد'), count.el, h('small', null, 'لإنشاء دفعة أكواد بنفس الإعدادات. الأسماء تترقّم تلقائياً.')),
        h('div', { class: 'field' }, h('span', null, 'عدد الأجهزة لكل كود'), devices.el, h('small', null, 'الأصل جهاز واحد فقط.')),
        field('ملاحظة', note))),
    btn) });
  name.focus();
}

/**
 * فحص مفاتيح كل الطلاب من الخادم قبل ما تطلع المشكلة عندهم: Gemini هل قفلت Google حصته المجانية، و Groq هل
 * المفتاح شغّال. النتيجة تظهر على بطاقة كل طالب (تحذير أحمر). ثلاثة طلاب بنفس الوقت.
 */
function openKeyCheck() {
  const list = state.data.codes.filter((c) => c.status === 'active' && !c.expired && (c.gemini || c.groq));
  const text = h('p', { class: 'dim' }, `أفحص مفاتيح ${list.length} طالب من الخادم: هل Google قافل الحصة المجانية لمفتاح Gemini، وهل مفتاح Groq شغّال. الفحص ما يستهلك من حصصهم إلا طلب صغير لكل مفتاح.`);
  const bar = h('div', { class: 'check-bar', hidden: true }, h('i'));
  const out = h('div', { class: 'stack' });
  const startBtn = h('button', { class: 'btn wide', onclick: run }, icon('shield'), 'ابدأ الفحص');
  let stopped = false;
  sheet({ title: 'فحص مفاتيح الطلاب', body: h('div', { class: 'stack lg' }, text, bar, out, startBtn), onClose: () => { stopped = true; } });

  async function run() {
    startBtn.hidden = true;
    bar.hidden = false;
    const queue = [...list], bad = [];
    let done = 0, failed = 0;
    const worker = async () => {
      while (queue.length && !stopped) {
        const c = queue.shift();
        const r = await api(`/api/admin/codes/${c.code}/check-keys`, { method: 'POST' });
        done++;
        bar.firstChild.style.width = `${Math.round((done / list.length) * 100)}%`;
        text.textContent = `فحصت ${done} من ${list.length}…`;
        if (!r.ok || !r.data?.results) { failed++; continue; }
        const restricted = r.data.results.filter((x) => x.provider === 'gemini' && x.state === 'restricted').length;
        const invalid = r.data.results.filter((x) => x.state === 'invalid').length;
        if (restricted || invalid) bad.push({ c, restricted, invalid });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (stopped) return;
    text.textContent = (bad.length ? `خلص الفحص: ${bad.length} طالب مفاتيحهم تحتاج تبديل.` : 'خلص الفحص: كل المفاتيح شغّالة.')
      + (failed ? ` (${failed} ما انفحصوا، جرّب بعدين)` : '');
    clear(out).append(...bad.map(({ c, restricted, invalid }) => h('div', { class: 'key-warn' },
      h('b', null, icon('warn'), c.label || c.display),
      h('span', null, [restricted ? `Google قافل ${restricted === 1 ? 'مفتاح Gemini' : `${restricted} من مفاتيح Gemini`}، سوّ مفتاح من حساب Google ثاني` : '',
        invalid ? (invalid === 1 ? 'مفتاح مرفوض (انحذف أو انقفل)' : `${invalid} مفاتيح مرفوضة`) : ''].filter(Boolean).join('. ')))));
    await load(true);
  }
}

function openCreated(list) {
  const codes = list.map((disp) => state.data.codes.find((c) => c.display === disp)).filter(Boolean);
  if (!codes.length) return;
  if (codes.length === 1) {
    const c = codes[0];
    sheet({ title: 'الكود جاهز', body: h('div', { class: 'stack lg' },
      h('div', { class: 'code-show' }, codeCells(c.display)),
      h('div', { class: 'msg-preview', dir: 'auto' }, inviteText(c)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => copy(inviteText(c), 'انتسخت رسالة التفعيل') }, icon('copy'), 'نسخ الرسالة'),
        h('button', { class: 'btn ghost small', onclick: () => share(inviteText(c)) }, icon('share'), 'مشاركة')),
      h('p', { class: 'dim' }, 'أرسل الرسالة للمستخدم. أول جهاز يفعّل الكود ينقفل عليه.')) });
    return;
  }
  const all = codes.map((c) => `${c.label ? `${c.label}: ` : ''}${c.display}`).join('\n');
  sheet({ title: `${codes.length} كود جاهز`, body: h('div', { class: 'stack lg' },
    h('div', { class: 'code-list' }, codes.map((c) => h('div', null, h('span', { dir: 'auto' }, c.label || ''), h('code', { class: 'ltr' }, c.display)))),
    h('button', { class: 'btn wide', onclick: () => copy(all, 'انتسخت كل الأكواد') }, icon('copy'), 'نسخ الكل'),
    h('p', { class: 'dim' }, 'افتح أي كود من القائمة حتى تنسخ رسالة التفعيل الخاصة به.')) });
}

// ───────── النشاط ─────────
function eventView(e, byCode) {
  const c = e.code ? byCode.get(e.code) : null;
  const who = h('b', { dir: 'auto' }, c?.label || e.code || 'مستخدم');
  const detail = e.detail ? String(e.detail).replace(/ · /g, '، ') : '';
  switch (e.type) {
    case 'activated': return ['check', 'good', [who, ' فعّل الكود', detail ? ` من ${detail}` : '']];
    case 'device_moved': return ['swap', '', [who, ' نقل التفعيل لمتصفح آخر على نفس الجهاز', detail ? ` (${detail})` : '']];
    case 'activate_blocked': return ['lock', 'bad', ['محاولة تفعيل كود ', who, ' على جهاز ثانٍ ورُفضت', detail ? ` (${detail})` : '']];
    case 'activate_failed': return ['warn', 'bad', ['محاولة تفعيل بكود غير صحيح']];
    case 'device_mismatch': return ['warn', 'bad', ['جلسة ', who, ' فُتحت من نظام مختلف ورُفضت', detail ? ` (${detail})` : '']];
    case 'screen_changed': return ['phone', '', [who, ': تغيّر قياس شاشة الجهاز']];
    case 'key_linked': return ['key', '', [who, ` ربط مفتاح ${e.detail === 'groq' ? 'Groq' : 'Gemini'}`]];
    case 'codes_created': return ['plus', '', [e.detail === '1' ? 'أنشأت كوداً جديداً' : `أنشأت ${e.detail} كود`]];
    case 'devices_reset': return ['refresh', '', ['صفّرت جهاز ', who]];
    case 'code_deleted': return ['trash', '', [`حذفت الكود ${e.code || ''}`]];
    case 'code_suspended': return ['pause', '', ['أوقفت كود ', who]];
    case 'code_resumed': return ['play', '', ['شغّلت كود ', who, ' من جديد']];
    case 'admin_login': return ['shield', '', ['دخول إلى لوحة التحكم']];
    case 'admin_login_failed': return ['shield', 'bad', ['محاولة دخول فاشلة للوحة التحكم']];
    case 'admin_password_changed': return ['shield', 'good', ['تغيّرت كلمة مرور اللوحة']];
    default: return ['info', '', [e.type]];
  }
}

function tabActivity(view) {
  const d = state.data, t = d.totals;
  const byDay = new Map(d.days.map((x) => [x.day, x]));
  const today = Math.floor((d.now + 3 * 3600000) / DAY); // اليوم بتوقيت بغداد، مثل تجميع الخادم
  const cols = [];
  for (let i = 13; i >= 0; i--) cols.push({ sec: 0, lectures: 0, pdfs: 0, users: 0, ...(byDay.get(today - i) || {}), day: today - i });
  const max = Math.max(1800, ...cols.map((c) => c.sec));
  const dayLabel = (c) => new Date(c.day * DAY).toLocaleDateString('ar-IQ-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const note = h('p', { class: 'chart-note' });
  const chart = h('div', { class: 'chart' });
  let sel = cols.length - 1;
  const paint = () => {
    clear(chart).append(...cols.map((c, i) => h('button', { class: `col${c.sec > 0 ? ' has' : ''}${i === cols.length - 1 ? ' today' : ''}`, 'aria-pressed': String(i === sel), 'aria-label': dayLabel(c), onclick: () => { sel = i; paint(); } },
      h('i', { class: 'cbar', style: { height: `${Math.max(2, (c.sec / max) * 100)}%` } }), String(new Date(c.day * DAY).getUTCDate()))));
    const c = cols[sel];
    note.textContent = c.sec || c.lectures || c.pdfs
      ? `${dayLabel(c)}: ${fmtHM(c.sec)} ساعة، ${c.lectures} محاضرة، ${c.pdfs} ملف PDF، ${c.users} مستخدم.`
      : `${dayLabel(c)}: ماكو نشاط.`;
  };
  paint();

  const byCode = new Map(d.codes.map((c) => [c.display, c]));
  const events = h('div');
  if (!d.events.length) events.append(h('div', { class: 'empty' }, 'السجل فارغ.'));
  for (const e of d.events) {
    if (e.type === 'move_start') continue; // للتشخيص فقط
    if (e.type === 'client_error') {
      // خطأ غير متوقع عند زبون: تفاصيله تظهر هنا حتى تُرسل للمطوّر ويُصلح
      const who = byCode.get(e.code)?.label || e.code || 'زبون';
      events.append(h('div', { class: 'ev bad' }, h('span', { class: 'dot' }, icon('warn')),
        h('p', null, `توقف تحويل عند ${who}`, h('small', { class: 'ltr', style: { display: 'block', wordBreak: 'break-all', opacity: '0.8' } }, e.detail || '')),
        h('small', null, [ago(e.ts), country(e.country)].filter(Boolean).join('، '))));
      continue;
    }
    const [ic, tone, parts] = eventView(e, byCode);
    const where = [ago(e.ts), country(e.country), tone === 'bad' && e.ip ? e.ip : ''].filter(Boolean).join('، ');
    events.append(h('div', { class: `ev ${tone}` }, h('span', { class: 'dot' }, icon(ic)), h('p', null, parts), h('small', null, where)));
  }

  view.append(h('div', { class: 'stack lg' },
    h('div', { class: 'stats' },
      stat(fmtHM(t.total_sec), '', 'ساعة محوّلة بالمجموع'),
      stat(String(t.lectures || 0), '', 'محاضرة'),
      stat(String(t.pdfs || 0), '', 'ملف PDF'),
      stat(String(t.suspended || 0), '', 'كود موقوف')),
    h('section', { class: 'card stack' },
      h('div', { class: 'sec-title' }, h('h2', { class: 'h-section' }, 'ساعات التحويل'), h('small', null, 'آخر 14 يوم')),
      chart, note),
    h('section', { class: 'stack' },
      h('div', { class: 'sec-title' }, h('h2', { class: 'h-section' }, 'السجل'), h('small', null, 'آخر 80 حدث')),
      h('div', { class: 'card' }, events))));
}

// ───────── التصميم ─────────
/** يطبّق تصميماً على هذه الصفحة فوراً (معاينة)، بنفس المتغيرات التي يحقنها الخادم لكل الصفحات */
function previewTheme(t, { keepMode = false } = {}) {
  let st = document.getElementById('mv-theme');
  if (!st) { st = document.createElement('style'); st.id = 'mv-theme'; document.head.append(st); }
  st.textContent = themeCss(t);
  applyTheme({ mode: !keepMode });
}

/** شاشة الافتتاحية كاملة فوق اللوحة، بنفس شكلها وحركتها في الموقع (للمعاينة) */
function playSplash(ms) {
  document.getElementById('intro')?.remove();
  const mark = h('span', { class: 'logo-mark on-brand intro-mark' }, h('img', { class: 'lm-mic', src: '/mark-color-mic.webp', alt: '' }), h('img', { class: 'lm-bars', src: '/mark-color-bars.webp', alt: '' }));
  const intro = h('div', { id: 'intro', 'aria-hidden': 'true' },
    h('div', { class: 'intro-bg' }, h('img', { class: 'intro-ghost a', src: '/mark.png', alt: '' }), h('img', { class: 'intro-ghost b', src: '/mark.png', alt: '' })),
    h('div', { class: 'intro-center' }, h('span', { class: 'intro-glow' }), mark, h('span', { class: 'intro-name' }, 'ميدي فويز')));
  let gone = false;
  const leave = async () => {
    if (gone) return;
    gone = true;
    mark.style.animation = 'none';
    intro.classList.add('leave');
    await mark.animate?.([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(1.12)' }], { duration: 520, easing: 'ease', fill: 'forwards' }).finished.catch(() => {});
    intro.remove();
  };
  intro.addEventListener('click', leave);
  document.body.append(intro);
  setTimeout(leave, ms);
}

let fontsLinked = false;
/** عينات الخطوط تحتاج الخطوط نفسها: تُحمَّل مرة واحدة من Google Fonts عند فتح التبويب */
function linkFonts() {
  if (fontsLinked) return;
  fontsLinked = true;
  const fams = Object.values(THEME_FONTS).filter((f) => f.g).map((f) => `family=${f.g}`).join('&');
  document.head.append(h('link', { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?${fams}&display=swap` }));
}

function tabDesign(view) {
  linkFonts();
  let saved = cleanTheme(state.data.settings.theme);
  // تعديلات لم تُحفظ تبقى عند تحديث البيانات، وتُلغى عند ترك التبويب
  let draft = state.designDraft ? { ...state.designDraft } : { ...saved };
  const same = (a, b) => JSON.stringify(cleanTheme(a)) === JSON.stringify(cleanTheme(b));
  state.leaveDesign = () => { state.designDraft = null; if (!same(draft, saved)) previewTheme(saved); };

  const saveBtn = h('button', { class: 'btn wide', onclick: save }, icon('check'), 'حفظ التصميم');
  const cancelBtn = h('button', { class: 'btn ghost', onclick: () => { draft = { ...saved }; changed(); paintAll(); } }, 'إلغاء');
  const resetBtn = h('button', { class: 'btn ghost wide', onclick: () => { draft = { ...DEFAULT_THEME }; changed(); paintAll(); } }, icon('undo'), 'رجوع للتصميم الأصلي');
  // شريط الحفظ يظهر فقط عند وجود تعديل لم يُحفظ
  const saveBar = h('div', { class: 'save-bar', hidden: true },
    h('div', { class: 'save-row' }, saveBtn, cancelBtn),
    h('p', { class: 'dim save-note' }, 'المعاينة على هذه الصفحة فقط. اضغط حفظ حتى يظهر عند الكل.'));

  function changed({ animateMode = null } = {}) {
    state.designDraft = draft;
    previewTheme(draft, { keepMode: !!animateMode });
    if (animateMode) setMode('auto', animateMode); // جهاز المسؤول يتبع الوضع الأساسي الجديد، بحركة من الزر
    const dirty = !same(draft, saved);
    saveBar.hidden = !dirty;
    saveBtn.disabled = false;
    resetBtn.disabled = same(draft, DEFAULT_THEME);
  }
  async function save() {
    saveBtn.disabled = true;
    const r = await api('/api/admin/settings', { method: 'PUT', body: { theme: draft } });
    if (!r.ok || !r.data?.settings) { saveBtn.disabled = false; toast('ما انحفظ التصميم. حاول مرة ثانية.', 'err'); return; }
    state.data.settings = r.data.settings;
    saved = cleanTheme(r.data.settings.theme);
    draft = { ...saved };
    changed();
    paintAll();
    toast('انحفظ التصميم. يظهر عند كل المستخدمين خلال دقيقة.', 'ok');
  }

  // ── عناصر مشتركة ──
  const segOf = (key, options, { onPick } = {}) => {
    const el = h('div', { class: 'seg', role: 'group' });
    const paint = () => clear(el).append(...options.map(([v, label, ic]) =>
      h('button', { type: 'button', 'aria-pressed': String(draft[key] === v), onclick: (e) => { if (draft[key] === v) return; draft[key] = v; paint(); onPick ? onPick(e.currentTarget) : changed(); } }, ic ? icon(ic) : null, label)));
    paint();
    return { el, paint };
  };
  const switchOf = (key, label, hint) => {
    const input = h('input', { type: 'checkbox', checked: !!draft[key], onchange: () => { draft[key] = input.checked; changed(); } });
    return { el: h('label', { class: 'switch' }, input, h('i'), h('span', null, label, hint ? h('small', null, hint) : null)), paint: () => { input.checked = !!draft[key]; } };
  };

  // ── الألوان ──
  const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'ألوان جاهزة' });
  const KEYS = ['c1', 'c2', 'c3', 'splash1', 'splash2'];
  const paintSwatches = () => clear(swatches).append(...THEME_PRESETS.map((p) => {
    const on = KEYS.every((k) => cleanTheme(p)[k] === draft[k]);
    return h('button', { type: 'button', class: 'swatch', 'aria-pressed': String(on), onclick: () => { for (const k of KEYS) draft[k] = p[k]; changed(); paintAll(); } },
      h('i', { style: { background: `linear-gradient(135deg, ${p.c1}, ${p.c2} 52%, ${p.c3})` } }, icon('check')),
      h('span', null, p.label));
  }));
  const pickers = KEYS.map((k) => {
    const input = h('input', { type: 'color', value: draft[k], 'aria-label': k, oninput: () => { draft[k] = input.value; changed(); paintSwatches(); } });
    // اللون الفاتح جداً يُغمَّق حتى يبقى النص مقروءاً: الخانة تعرض ما سيُحفظ فعلاً
    input.addEventListener('change', () => { draft = cleanTheme(draft); input.value = draft[k]; changed(); });
    return { k, input };
  });
  const pickerLabel = { c1: 'بداية التدرّج', c2: 'وسطه', c3: 'نهايته', splash1: 'الافتتاحية: أعلى', splash2: 'الافتتاحية: أسفل' };
  const custom = h('details', { class: 'more' }, h('summary', null, 'ألوان مخصصة'),
    h('div', { class: 'pickers' }, pickers.map(({ k, input }) => h('label', { class: 'picker' }, input, h('span', null, pickerLabel[k])))));

  // ── الافتتاحية ──
  const splashTile = h('button', { type: 'button', class: 'splash-tile', 'aria-label': 'شغّل الافتتاحية', onclick: () => playSplash(SPLASH_MS[draft.splash]) },
    h('span', { class: 'logo-mark on-brand' }, h('img', { src: '/mark-color.webp', alt: '' })),
    h('b', null, 'ميدي فويز'),
    h('span', { class: 'splash-play' }, icon('play')));
  const splashSeg = segOf('splash', [['short', 'قصيرة'], ['normal', 'عادية'], ['long', 'طويلة']]);

  // ── الوضع ──
  const modeSeg = segOf('mode', [['dark', 'ليلي', 'moon'], ['light', 'نهاري', 'sun'], ['auto', 'حسب الجهاز']], { onPick: (btn) => changed({ animateMode: btn }) });
  const toggleSw = switchOf('toggle', 'زر التبديل يظهر للمستخدم', 'يقدر كل مستخدم يختار النهاري أو الليلي لجهازه.');

  // ── الخط ──
  const fonts = h('div', { class: 'fonts', role: 'radiogroup', 'aria-label': 'الخط' });
  const paintFonts = () => clear(fonts).append(...Object.entries(THEME_FONTS).map(([id, f]) =>
    h('button', { type: 'button', class: 'font-opt', role: 'radio', 'aria-checked': String(draft.font === id), onclick: () => { if (draft.font === id) return; draft.font = id; changed(); paintFonts(); } },
      h('b', { style: { fontFamily: `'${f.name}', 'El Messiri', sans-serif` } }, 'محاضرتك، ملزمة مشروحة'),
      h('small', null, f.label))));

  // ── الشكل ──
  const radiusSeg = segOf('radius', [['sharp', 'حادة'], ['soft', 'ناعمة'], ['round', 'دائرية']]);
  const buttonsSeg = segOf('buttons', [['gradient', 'متدرّجة'], ['solid', 'لون واحد'], ['outline', 'إطار']]);
  const sample = h('div', { class: 'btn-row sample' }, h('span', { class: 'btn small' }, icon('upload'), 'رفع تسجيل'), h('span', { class: 'btn ghost small' }, icon('mic'), 'تسجيل'));

  // ── الحركة ──
  const motionSeg = segOf('motion', [['full', 'كاملة'], ['light', 'خفيفة'], ['off', 'بدون']]);
  const ribbonSw = switchOf('ribbon', 'خط الصوت المتحرك', 'الموجة الملونة خلف الواجهة.');

  function paintAll() {
    paintSwatches();
    for (const { k, input } of pickers) input.value = draft[k];
    for (const seg of [splashSeg, modeSeg, radiusSeg, buttonsSeg, motionSeg]) seg.paint();
    toggleSw.paint(); ribbonSw.paint();
    paintFonts();
  }
  paintAll();
  changed();

  const section = (title, ...kids) => h('section', { class: 'card stack' }, h('h3', null, title), ...kids);
  view.append(h('div', { class: 'stack lg design' },
    section('شاشة الافتتاحية', splashTile, h('div', { class: 'field' }, h('span', null, 'مدتها'), splashSeg.el)),
    section('الألوان', swatches, custom),
    section('الوضع', h('div', { class: 'field' }, h('span', null, 'الوضع الأساسي'), modeSeg.el), toggleSw.el),
    section('الخط', fonts),
    section('الشكل', h('div', { class: 'field' }, h('span', null, 'الحواف'), radiusSeg.el), h('div', { class: 'field' }, h('span', null, 'الأزرار'), buttonsSeg.el), sample),
    section('الحركة', motionSeg.el, ribbonSw.el),
    resetBtn,
    saveBar));
}

// ───────── الإعدادات ─────────
function fixUrl(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (s.startsWith('@')) return `https://t.me/${s.slice(1)}`;
  if (/^\+?\d[\d\s-]{6,}$/.test(s)) return `https://wa.me/${s.replace(/\D/g, '')}`;
  if (!/^(https?:\/\/|tel:|mailto:)/i.test(s)) s = `https://${s}`;
  return s.replace(/^http:\/\//i, 'https://');
}
const lines = (v) => String(v || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

function tabSettings(view) {
  const d = state.data, cfg = d.settings;
  const supLabel = h('input', { type: 'text', value: cfg.support?.label || '', maxLength: 60, placeholder: 'تواصل ويانه على تيليكرام' });
  const supUrl = h('input', { type: 'text', value: cfg.support?.url || '', maxLength: 200, dir: 'ltr', placeholder: 'https://t.me/username', inputMode: 'url', autocapitalize: 'off' });
  const notice = h('textarea', { value: cfg.notice || '', maxLength: 300, placeholder: 'مثلاً: صيانة اليوم الساعة 10 بالليل' });
  const hours = hoursControl(Math.round(Number(cfg.defaultDailyHours ?? 8) * 3600), 'الساعات اليومية للكود الجديد');
  const pdfs = h('input', { type: 'number', min: 1, max: 500, value: cfg.pdfPerDay, inputMode: 'numeric' });
  const moves = stepper(cfg.moveLimit ?? 2, 0, 5);
  const chunk = h('input', { type: 'number', min: 60, max: 900, step: 30, value: cfg.chunkSec, inputMode: 'numeric' });
  const gem = h('textarea', { class: 'mono', value: cfg.geminiModels.join('\n'), rows: 6, spellcheck: false });
  const grq = h('textarea', { class: 'mono', value: cfg.groqModels.join('\n'), rows: 3, spellcheck: false });
  const stt = h('textarea', { class: 'mono', value: cfg.sttModels.join('\n'), rows: 2, spellcheck: false });
  const save = h('button', { class: 'btn wide', onclick: async () => {
    save.disabled = true;
    const r = await api('/api/admin/settings', { method: 'PUT', body: {
      support: { label: supLabel.value.trim(), url: fixUrl(supUrl.value) }, notice: notice.value.trim(),
      defaultDailyHours: hours.value, pdfPerDay: Number(pdfs.value), moveLimit: moves.value, chunkSec: Number(chunk.value),
      geminiModels: lines(gem.value), groqModels: lines(grq.value), sttModels: lines(stt.value),
    } });
    save.disabled = false;
    if (!r.ok) { toast('ما انحفظت الإعدادات. حاول مرة ثانية.', 'err'); return; }
    state.data.settings = r.data.settings;
    supUrl.value = r.data.settings.support?.url || '';
    toast('انحفظت الإعدادات', 'ok');
  } }, 'حفظ الإعدادات');

  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minLength: 8 });
  const pwBtn = h('button', { class: 'btn ghost wide', type: 'submit' }, 'تغيير كلمة المرور');
  const pwForm = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    if (next.value.length < 8) { toast('كلمة المرور الجديدة 8 أحرف على الأقل.', 'err'); next.focus(); return; }
    pwBtn.disabled = true;
    const r = await api('/api/admin/password', { method: 'POST', body: { current: cur.value, next: next.value } });
    pwBtn.disabled = false;
    if (r.ok) { cur.value = ''; next.value = ''; state.data.password_changed = true; toast('تغيّرت كلمة المرور', 'ok'); return; }
    toast(r.data?.error === 'wrong_password' ? 'كلمة المرور الحالية غير صحيحة.' : 'تعذّر التغيير. حاول مرة ثانية.', 'err');
  } }, field('كلمة المرور الحالية', cur), field('كلمة المرور الجديدة', next, '8 أحرف على الأقل.'), pwBtn);

  view.append(h('div', { class: 'stack lg' },
    !d.password_changed ? h('div', { class: 'banner' }, icon('shield'), h('span', null, 'ما زلت على كلمة المرور الأولى. غيّرها لكلمة تحفظها أنت فقط.')) : null,
    h('section', { class: 'card stack' },
      h('h3', null, 'التواصل وياك'),
      h('p', { class: 'dim' }, 'يظهر للمستخدم بشاشة القفل وبصفحة حسابه، حتى يطلب كود أو يبلغك بمشكلة.'),
      field('نص الرابط', supLabel),
      field('الرابط', supUrl, 'رابط تيليكرام أو واتساب. تقدر تكتب @username أو رقم الهاتف وأنا أرتّبه.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'إعلان لكل المستخدمين'),
      field('نص الإعلان', notice, 'يظهر كشريط بالصفحة الرئيسية. اتركه فارغ إذا ماكو شي.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'الحدود'),
      hours.el,
      field('ملفات PDF باليوم لكل مستخدم', pdfs, 'توليد PDF على الخادم المجاني محدود بـ 10 دقائق باليوم لكل الموقع، يعني تقريباً 250 ملف.'),
      h('div', { class: 'field' }, h('span', null, 'نقل التفعيل لمتصفح آخر على نفس الجهاز'), moves.el,
        h('small', null, 'عدد المرات المسموحة بالشهر. يفيد لمن يفتح الرابط من داخل تيليكرام وبعدين من Chrome. الصفر يمنعه نهائياً.'))),
    h('details', { class: 'more' }, h('summary', null, 'إعدادات متقدمة للمحركات'),
      h('div', { class: 'stack' },
        field('طول المقطع الصوتي بالثواني', chunk, 'الأقصر أدق وأبطأ، والأطول يوفر عدد الطلبات. من 60 إلى 900.'),
        field('نماذج Gemini بالترتيب', gem, 'نموذج بكل سطر. يُجرَّب الأول، وإذا خلصت حصته ينتقل للي بعده.'),
        field('نماذج Groq للنص', grq),
        field('نماذج Groq للصوت', stt))),
    save,
    h('section', { class: 'card stack' }, h('h3', null, 'كلمة مرور اللوحة'), pwForm),
    h('button', { class: 'btn danger wide', onclick: async () => { await api('/api/admin/logout', { method: 'POST' }); state.data = null; viewLogin(); } }, icon('logout'), 'تسجيل الخروج'),
    h('p', { class: 'dim', style: { textAlign: 'center' } }, `الإصدار ${d.build}`)));
}

// ───────── الإقلاع ─────────
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.data && Date.now() - state.loadedAt > 45000 && !document.querySelector('.sheet')) load(true);
});
load();
