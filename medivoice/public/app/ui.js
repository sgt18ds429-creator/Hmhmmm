// ui.js — أدوات بناء الواجهة: عناصر DOM، أيقونات، نوافذ سفلية.
// لا يُستخدم innerHTML مع أي نص خارجي: كل النصوص تدخل كـ text nodes.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

const ICONS = {
  upload: 'M12 16V4m0 0 4.5 4.5M12 4 7.500 8.500M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  back: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  dots: 'M12 5.500v.010M12 12v.010M12 18.500v.010',
  menu: 'M4 7h16M4 12h16M4 17h16',
  image: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm0 10 4.500-4.500 3.500 3.500 3-3 5 5M9 9.500v.010',
  trash: 'M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13M10 11v6M14 11v6',
  download: 'M12 4v11m0 0 4.500-4.500M12 15l-4.500-4.500M5 19.500h14',
  key: 'M14.500 9.500a4 4 0 1 0-3.870 4.990L12 13l1.500 1.500L15 13l1.500 1.500L18 13l2-2-1.500-1.500h-4Z',
  check: 'M5 12.500 10 17.500 19.500 7',
  clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  book: 'M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2V5Zm0 15a2 2 0 0 0 2 2h12v-4',
  plus: 'M12 5v14M5 12h14',
  warn: 'M12 9v4m0 3.500v.010M10.300 4.300 2.800 17.500A2 2 0 0 0 4.500 20.500h15a2 2 0 0 0 1.700-3L13.700 4.300a2 2 0 0 0-3.400 0Z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  print: 'M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z',
  swap: 'M4 8h13m0 0-3.500-3.500M17 8l-3.500 3.500M20 16H7m0 0 3.500-3.500M7 16l3.500 3.500',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4.200-4.200',
  external: 'M14 5h5v5M19 5l-8 8M11 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-5',
  paste: 'M9 5h6v3H9zM9 6H6v14h12V6h-3',
  stop: 'M7 7h10v10H7z',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Zm10-13 4 4',
  heading: 'M6 5v14M18 5v14M6 12h12',
  text: 'M5 7h14M5 12h14M5 17h9',
  info: 'M12 11v6m0-9.500v.010M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  refresh: 'M20 5v5h-5M4 19v-5h5M19 10a7.500 7.500 0 0 0-13-2.500M5 14a7.500 7.500 0 0 0 13 2.500',
  share: 'M12 15V4m0 0 3.500 3.500M12 4 8.500 7.500M6 11H5v9h14v-9h-1',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7.500 8a7.500 7.500 0 0 1 15 0',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm3 15h2',
  pause: 'M9 5v14M15 5v14',
  play: 'M8 5v14l11-7L8 5Z',
  logout: 'M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h9',
  gear: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 4.500v5M9 14.500v5',
  pulse: 'M3 12h4l2.500-6 4 12 2.500-6H21',
  shield: 'M12 3 5 6v5.500c0 4.300 2.900 7.700 7 9 4.100-1.300 7-4.700 7-9V6l-7-3Z',
  calendar: 'M5 6h14v14H5zM5 10h14M9 3.500v4M15 3.500v4',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
};

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

export function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

// ───────────── نافذة سفلية ─────────────
const openSheets = [];
let sheetHistory = false;
/**
 * التطبيق يفعّلها: كل نافذة تأخذ خطوة في سجل التصفح، فزر الرجوع في الهاتف يغلقها بدل أن يغادر الموقع
 * (كان الرجوع والنافذة مفتوحة في الرئيسية يغلق التطبيق كله).
 */
export function enableSheetHistory() { sheetHistory = true; }

/** @param persistent نافذة لا تُغلق بلمسة خارجها ولا بـ Esc (مثل التسجيل الجاري)؛ قيمة أو دالة */
export function sheet({ title, body, wide = false, onClose, persistent = false } = {}) {
  const panel = h('div', { class: `sheet-panel${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    h('div', { class: 'sheet-head' },
      h('h2', null, title || ''),
      h('button', { class: 'icon-btn', 'aria-label': 'إغلاق', onclick: () => api.close() }, icon('close'))),
    h('div', { class: 'sheet-body' }, body));
  const root = h('div', { class: 'sheet', onclick: (e) => { if (e.target === root && !api.locked()) api.close(); } }, panel);
  let closed = false;
  const api = {
    el: root, panel,
    locked: () => (typeof persistent === 'function' ? !!persistent() : !!persistent),
    close(result) {
      if (closed) return;
      closed = true;
      const i = openSheets.indexOf(api);
      if (i >= 0) openSheets.splice(i, 1);
      root.classList.remove('open');
      setTimeout(() => root.remove(), 260);
      onClose?.(result);
    },
  };
  document.body.append(root);
  openSheets.push(api);
  if (sheetHistory) { try { history.pushState({ ...(history.state || {}), sheet: true }, ''); } catch { /* السجل غير متاح */ } }
  requestAnimationFrame(() => root.classList.add('open'));
  return api;
}
/** يغلق أعلى نافذة مفتوحة. يرجع true إذا أغلق شيئاً (يستخدمه زر الرجوع). */
export function closeTopSheet() {
  const top = openSheets[openSheets.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = openSheets[openSheets.length - 1];
  if (top && !top.locked()) top.close();
});

export function confirm({ title, message, ok = 'تأكيد', cancel = 'إلغاء', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet({
      title,
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, message),
        h('div', { class: 'row end' },
          h('button', { class: 'btn ghost', onclick: () => s.close() }, cancel),
          h('button', { class: `btn ${danger ? 'danger' : ''}`, onclick: () => { answered = true; s.close(); resolve(true); } }, ok))),
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

export const fmtHM = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60);
  return `${hh}:${String(mm).padStart(2, '0')}`;
};
export const fmtSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes >= 104857600 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const fmtAgo = (ts) => {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return 'اليوم';
  if (d === 1) return 'أمس';
  if (d < 30) return `قبل ${d} يوم`;
  return new Date(ts).toLocaleDateString('ar-IQ-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' });
};

/** عدد مع معدوده بالعربية: countOf(3, ['قسم واحد', 'قسمان', 'أقسام', 'قسماً']) ← «3 أقسام». */
export function countOf(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  return `${n} ${n >= 3 && n <= 10 ? few : many}`;
}
