// theme-core.js — تصميم الموقع من لوحة التحكم: القيم المسموحة، وتحويلها إلى متغيرات CSS.
// ملف واحد للطرفين: الخادم يضمّنه عند البناء (tools/build.mjs) فيحقن التصميم في كل صفحة، ولوحة التحكم
// تستورده فتعرض المعاينة مطابقة تماماً لما سيُحفظ. لا يعتمد على المتصفح ولا على الخادم.
// كل قيمة إما من قائمة ثابتة أو لون #rrggbb، فلا يدخل الصفحة أي نص حر.

export const THEME_FONTS = {
  messiri: { name: 'El Messiri', label: 'المسيري' }, // مضمَّن في الموقع (الأسرع)
  cairo: { name: 'Cairo', label: 'القاهرة', g: 'Cairo:wght@400;500;600;700' },
  tajawal: { name: 'Tajawal', label: 'تجوال', g: 'Tajawal:wght@400;500;700' },
  plex: { name: 'IBM Plex Sans Arabic', label: 'بلكس', g: 'IBM+Plex+Sans+Arabic:wght@400;500;600;700' },
  kufi: { name: 'Noto Kufi Arabic', label: 'كوفي', g: 'Noto+Kufi+Arabic:wght@400;500;600;700' },
  readex: { name: 'Readex Pro', label: 'ريدكس', g: 'Readex+Pro:wght@400;500;600;700' },
  almarai: { name: 'Almarai', label: 'المراعي', g: 'Almarai:wght@400;700' },
};

/** ألوان جاهزة: تدرّج الهوية (c1 → c2 → c3) ولونا شاشة الافتتاحية */
export const THEME_PRESETS = [
  { id: 'medi', label: 'بنفسجي ميدي', c1: '#5433ec', c2: '#8521d5', c3: '#c923c1', splash1: '#3a0ca3', splash2: '#a10fb4' },
  { id: 'ocean', label: 'أزرق طبي', c1: '#2563eb', c2: '#4f46e5', c3: '#7c3aed', splash1: '#1e3a8a', splash2: '#4c1d95' },
  { id: 'teal', label: 'فيروزي', c1: '#0f766e', c2: '#0e7490', c3: '#2563eb', splash1: '#134e4a', splash2: '#1e3a8a' },
  { id: 'rose', label: 'وردي', c1: '#db2777', c2: '#c026d3', c3: '#9333ea', splash1: '#831843', splash2: '#701a75' },
  { id: 'sunset', label: 'غروب', c1: '#ea580c', c2: '#e11d48', c3: '#be185d', splash1: '#7c2d12', splash2: '#881337' },
  { id: 'emerald', label: 'زمردي', c1: '#059669', c2: '#0d9488', c3: '#0891b2', splash1: '#064e3b', splash2: '#164e63' },
];

export const DEFAULT_THEME = {
  c1: '#5433ec', c2: '#8521d5', c3: '#c923c1', // تدرّج الهوية (من اللوكو)
  splash1: '#3a0ca3', splash2: '#a10fb4', // شاشة الافتتاحية
  mode: 'dark', // الوضع لمن لم يختر بنفسه: dark | light | auto (حسب إعداد الجهاز)
  toggle: true, // زر التبديل بين النهاري والليلي ظاهر للمستخدم
  font: 'messiri',
  radius: 'round', // sharp | soft | round
  buttons: 'gradient', // gradient | solid | outline
  motion: 'full', // full | light | off
  ribbon: true, // خط الصوت المتحرك خلف الواجهة
  splash: 'normal', // short | normal | long
};

export const THEME_ENUMS = {
  mode: ['dark', 'light', 'auto'],
  radius: ['sharp', 'soft', 'round'],
  buttons: ['gradient', 'solid', 'outline'],
  motion: ['full', 'light', 'off'],
  splash: ['short', 'normal', 'long'],
};
export const SPLASH_MS = { short: 1300, normal: 2300, long: 3400 };
const RADII = { sharp: [8, 10, 12, 12], soft: [12, 16, 22, 16], round: [14, 20, 28, 999] };

// ── ألوان ──
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hexOf = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const mixHex = (a, b, k) => { const x = rgbOf(a), y = rgbOf(b); return hexOf(x.map((v, i) => v + (y[i] - v) * k)); };
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** أقرب نسخة من اللون (بخلطه مع towards تدريجياً) تحقق التباين المطلوب مع against */
function reach(color, towards, against, ratio, from = 0) {
  for (let k = from; k < 1; k += 0.03) {
    const c = mixHex(color, towards, k);
    if (contrast(c, against) >= ratio) return c;
  }
  return towards;
}

/** التصميم المحفوظ بعد التنظيف: أي قيمة غير معروفة ترجع للأصل، والألوان تُضبط حتى يبقى كل نص مقروءاً */
export function cleanTheme(t = {}) {
  const out = { ...DEFAULT_THEME };
  if (!t || typeof t !== 'object') return out;
  // نص الأزرار أبيض فوق التدرّج، واسم الموقع أبيض فوق شاشة الافتتاحية: اللون الفاتح جداً يُغمَّق قليلاً
  for (const k of ['c1', 'c2', 'c3']) if (isHex(t[k])) out[k] = reach(t[k].toLowerCase(), '#000000', '#ffffff', 3.2);
  for (const k of ['splash1', 'splash2']) if (isHex(t[k])) out[k] = reach(t[k].toLowerCase(), '#000000', '#ffffff', 4.5);
  for (const [k, list] of Object.entries(THEME_ENUMS)) if (list.includes(t[k])) out[k] = t[k];
  if (Object.hasOwn(THEME_FONTS, t.font)) out.font = t.font;
  if (typeof t.toggle === 'boolean') out.toggle = t.toggle;
  if (typeof t.ribbon === 'boolean') out.ribbon = t.ribbon;
  return out;
}

/** متغيرات CSS للتصميم. تُحقن في <head> كل صفحة (بلا طلب إضافي عند الفتح) */
export function themeCss(theme) {
  const t = cleanTheme(theme);
  const f = THEME_FONTS[t.font];
  const R = RADII[t.radius];
  // لون التمييز: فاتح على الخلفية الداكنة وغامق على الفاتحة، بتباين مضمون مع النص المحيط
  const accD = reach(t.c1, '#ffffff', '#140c2b', 8, 0.3);
  const accL = reach(t.c1, '#000000', '#f6f3ff', 6);
  const font = f.g ? `--font-display:'${f.name}','El Messiri',system-ui,sans-serif;--font-body:'${f.name}','El Messiri',system-ui,-apple-system,sans-serif;` : '';
  const vars = [
    `--v1:${t.c1}`, `--v2:${t.c2}`, `--v3:${t.c3}`,
    `--v1-rgb:${rgbOf(t.c1)}`, `--v2-rgb:${rgbOf(t.c2)}`, `--v3-rgb:${rgbOf(t.c3)}`,
    `--accent-d:${accD}`, `--accent-d-rgb:${rgbOf(accD)}`, `--accent-l:${accL}`, `--accent-l-rgb:${rgbOf(accL)}`,
    `--splash-1:${t.splash1}`, `--splash-2:${t.splash2}`, `--splash-m:${mixHex(t.splash1, t.splash2, 0.5)}`,
    `--r-s:${R[0]}px`, `--r-m:${R[1]}px`, `--r-l:${R[2]}px`, `--r-btn:${R[3]}px`,
    `--theme-default:${t.mode}`, `--theme-toggle:${t.toggle ? 1 : 0}`, `--motion:${t.motion}`, `--ribbon:${t.ribbon ? 1 : 0}`,
    `--splash-ms:${SPLASH_MS[t.splash]}`, `--btn-style:${t.buttons}`,
  ].join(';');
  return `${f.g ? `@import url("https://fonts.googleapis.com/css2?family=${f.g}&display=swap");\n` : ''}:root{${vars};${font}}`;
}
