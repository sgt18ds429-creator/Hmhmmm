// theme.js — الوضع النهاري والليلي وإعدادات التصميم من لوحة التحكم.
// الخادم يحقن متغيرات التصميم في <head> كل صفحة (--theme-default، --motion، ...)، وهنا تُقرأ وتُطبَّق
// كسمات على <html>: data-theme (dark|light)، data-motion (full|light|off)، data-buttons.
// كل تغيير يُعلَن بحدث 'mv-theme' على document (الشريط المتحرك يعيد تلوين نفسه).

const KEY = 'mv-theme';
const root = document.documentElement;
const cssVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();
const BG = { dark: '#0b0716', light: '#f6f3ff' };

/** إعدادات التصميم الحالية (من المتغيرات التي حقنها الخادم أو معاينة لوحة التحكم) */
export function design() {
  const def = cssVar('--theme-default'), motion = cssVar('--motion'), buttons = cssVar('--btn-style');
  return {
    def: ['dark', 'light', 'auto'].includes(def) ? def : 'dark',
    toggle: cssVar('--theme-toggle') !== '0',
    motion: ['full', 'light', 'off'].includes(motion) ? motion : 'full',
    ribbon: cssVar('--ribbon') !== '0',
    splashMs: parseInt(cssVar('--splash-ms'), 10) || 2300,
    buttons: ['gradient', 'solid', 'outline'].includes(buttons) ? buttons : 'gradient',
  };
}

const stored = () => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; } };
const systemMode = () => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** اختيار المستخدم على هذا الجهاز: 'light' أو 'dark'، أو 'auto' (يتبع الأصل الذي اختاره المسؤول) */
export function choice(d = design()) { return (d.toggle && stored()) || 'auto'; }

/** الوضع الذي يجب أن يظهر الآن: اختيار المستخدم (إذا مسموح)، ثم أصل المسؤول، ثم إعداد الجهاز */
export function wantedMode(d = design()) {
  const pref = d.toggle ? stored() : null;
  if (pref) return pref;
  return d.def === 'auto' ? systemMode() : d.def;
}

function paint(mode) {
  root.dataset.theme = mode;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta); }
  meta.content = BG[mode] || BG.dark;
  document.dispatchEvent(new CustomEvent('mv-theme', { detail: { mode } }));
}

/** يطبّق التصميم والوضع (أول الإقلاع، وبعد كل تغيير من لوحة التحكم). mode: false يترك الوضع كما هو */
export function applyTheme({ mode = true } = {}) {
  const d = design();
  root.dataset.motion = reducedMotion() ? 'off' : d.motion;
  root.dataset.buttons = d.buttons;
  if (!mode) { document.dispatchEvent(new CustomEvent('mv-theme', { detail: { mode: root.dataset.theme } })); return root.dataset.theme; }
  const want = wantedMode(d);
  paint(want);
  return want;
}

/** الحركة مسموحة الآن؟ (المسؤول لم يوقفها، والجهاز لا يطلب تقليلها) */
export const motionOn = () => root.dataset.motion !== 'off';

/**
 * ينتقل إلى وضع بحركة: الوضع الجديد ينكشف بدائرة تتسع من الزر الذي ضُغط (View Transitions)،
 * وبدونها يتبدل فوراً.
 */
function reveal(next, from) {
  if (next === root.dataset.theme) return;
  if (typeof document.startViewTransition !== 'function' || !motionOn()) { paint(next); return; }
  const r = from?.getBoundingClientRect?.();
  const x = r ? r.left + r.width / 2 : innerWidth / 2;
  const y = r ? r.top + r.height / 2 : 0;
  root.style.setProperty('--vt-x', `${x}px`);
  root.style.setProperty('--vt-y', `${y}px`);
  root.style.setProperty('--vt-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
  root.classList.add('vt-theme');
  try {
    const t = document.startViewTransition(() => paint(next));
    t.finished.finally(() => root.classList.remove('vt-theme'));
  } catch { paint(next); root.classList.remove('vt-theme'); }
}

/** اختيار المستخدم: 'light' | 'dark' | 'auto'. يُحفظ لهذا الجهاز */
export function setMode(mode, from) {
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem(KEY, mode);
    else localStorage.removeItem(KEY);
  } catch { /* تخزين ممنوع: يبقى لهذه الجلسة */ }
  const d = design();
  reveal(mode === 'light' || mode === 'dark' ? mode : d.def === 'auto' ? systemMode() : d.def, from);
}

/** زر التبديل: عكس الوضع الظاهر الآن */
export function toggleTheme(from) {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  setMode(next, from);
  return next;
}

// الجهاز غيّر وضعه (ليلاً تلقائياً مثلاً) والمستخدم ما اختار بنفسه والأصل «حسب الجهاز»: نتبعه
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  const d = design();
  if (d.def === 'auto' && !(d.toggle && stored())) reveal(systemMode());
});

// ── عناصر مشتركة ──
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON = {
  sun: 'M12 3.5v1.6M12 18.9v1.6M3.5 12h1.6M18.9 12h1.6M6 6l1.15 1.15M16.85 16.85 18 18M6 18l1.15-1.15M16.85 7.15 18 6M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  moon: 'M19.6 14.4A7.9 7.9 0 0 1 9.6 4.4a7.9 7.9 0 1 0 10 10Z',
};
function svgIcon(d, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${cls}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
const toggleLabel = () => (root.dataset.theme === 'light' ? 'الوضع الليلي' : 'الوضع النهاري');
/** زر الشمس/القمر: يبدّل الوضع ويكشفه بدائرة من مكانه */
export function themeButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn theme-btn';
  b.setAttribute('aria-label', toggleLabel());
  b.append(svgIcon(ICON.sun, 'sun'), svgIcon(ICON.moon, 'moon'));
  b.addEventListener('click', () => toggleTheme(b));
  return b;
}
document.addEventListener('mv-theme', () => {
  for (const b of document.querySelectorAll('.theme-btn')) b.setAttribute('aria-label', toggleLabel());
});

/** موجة من مكان اللمسة على الأزرار والبطاقات القابلة للضغط (مستمع واحد للصفحة كلها) */
const RIPPLE_ON = '.btn, .icon-btn, .menu button, .lec, .type, .slab, .cc, .seg button, .filters button, .pick, .swatch, .font-opt';
let rippling = false;
export function ripples() {
  if (rippling) return;
  rippling = true;
  document.addEventListener('pointerdown', (e) => {
    if (!motionOn() || e.button > 0) return;
    const el = e.target.closest?.(RIPPLE_ON);
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const r = el.getBoundingClientRect();
    const size = Math.hypot(r.width, r.height) * 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    el.append(dot);
    setTimeout(() => dot.remove(), 650);
  }, { passive: true });
}
