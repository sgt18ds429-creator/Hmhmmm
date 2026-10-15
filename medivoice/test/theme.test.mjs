// التصميم من لوحة التحكم: تنظيف القيم، ضمان قراءة النص، وحقنه في كل صفحة HTML من الخادم.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THEME, THEME_PRESETS, THEME_FONTS, cleanTheme, themeCss, contrast } from '../public/theme-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('قيم غريبة أو ناقصة ترجع للأصل، ولا يدخل CSS أي نص حر', () => {
  for (const junk of [null, undefined, 'x', 42, [], { c1: 'red', c2: '#12345', font: 'comic', mode: 'neon', radius: 1, toggle: 'yes', ribbon: 0, splash: 'forever' }]) {
    assert.deepEqual(cleanTheme(junk), DEFAULT_THEME, JSON.stringify(junk));
  }
  // محاولة حقن عبر قيمة نصية
  const evil = cleanTheme({ c1: '#000000;}</style><script>', font: "messiri'}", mode: 'dark;--x:1', buttons: 'outline' });
  assert.equal(evil.c1, DEFAULT_THEME.c1);
  assert.equal(evil.font, 'messiri');
  assert.equal(evil.mode, DEFAULT_THEME.mode);
  assert.equal(evil.buttons, 'outline');
  const css = themeCss({ c1: '#000000;}</style>', font: 'cairo' });
  assert.doesNotMatch(css, /<|>\s*</, 'لا وسوم');
  assert.equal((css.match(/\{/g) || []).length, 1, 'كتلة :root واحدة فقط');
  assert.match(css, /^@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Cairo:wght@400;500;600;700&display=swap"\);\n:root\{/);
  assert.doesNotMatch(themeCss(DEFAULT_THEME), /@import/, 'خط المسيري من الموقع نفسه بلا طلب خارجي');
});

test('الألوان الجاهزة تُحفظ كما هي، والألوان الفاتحة جداً تُغمَّق حتى يبقى النص الأبيض مقروءاً', () => {
  for (const p of THEME_PRESETS) {
    const t = cleanTheme(p);
    for (const k of ['c1', 'c2', 'c3', 'splash1', 'splash2']) assert.equal(t[k], p[k], `${p.id}.${k}`);
  }
  const t = cleanTheme({ c1: '#FFF59D', c2: '#ffffff', c3: '#c923c1', splash1: '#fafafa', splash2: '#ffe0f0' });
  for (const k of ['c1', 'c2', 'c3']) assert.ok(contrast(t[k], '#ffffff') >= 3.2, `${k} ${t[k]}`);
  for (const k of ['splash1', 'splash2']) assert.ok(contrast(t[k], '#ffffff') >= 4.5, `${k} ${t[k]}`);
  assert.equal(t.c3, '#c923c1', 'لون مقروء أصلاً لا يتغير');
  assert.match(t.c1, /^#[0-9a-f]{6}$/);
  // لون التمييز: فاتح كفاية على الداكن، وغامق كفاية على الفاتح
  const css = themeCss(t);
  const v = (n) => css.match(new RegExp(`--${n}:(#[0-9a-f]{6})`))[1];
  assert.ok(contrast(v('accent-d'), '#140c2b') >= 8);
  assert.ok(contrast(v('accent-l'), '#f6f3ff') >= 6);
});

test('كل الخيارات تعطي متغيرات كاملة (الحواف، الأزرار، الحركة، مدة الافتتاحية، الخط)', () => {
  const need = ['--v1', '--v2', '--v3', '--v1-rgb', '--accent-d', '--accent-l', '--splash-1', '--splash-2', '--splash-m', '--r-s', '--r-m', '--r-l', '--r-btn', '--theme-default', '--theme-toggle', '--motion', '--ribbon', '--splash-ms', '--btn-style'];
  for (const radius of ['sharp', 'soft', 'round']) for (const buttons of ['gradient', 'solid', 'outline']) for (const motion of ['full', 'light', 'off']) {
    const css = themeCss({ radius, buttons, motion, splash: 'long', toggle: false, ribbon: false, mode: 'auto' });
    for (const n of need) assert.match(css, new RegExp(`${n}:`), `${radius}/${buttons}/${motion}: ${n}`);
    assert.match(css, new RegExp(`--btn-style:${buttons}`));
    assert.match(css, new RegExp(`--motion:${motion}`));
    assert.match(css, /--theme-toggle:0/);
    assert.match(css, /--ribbon:0/);
    assert.match(css, /--splash-ms:3400/);
    assert.match(css, /--theme-default:auto/);
  }
  for (const [id, f] of Object.entries(THEME_FONTS)) {
    const css = themeCss({ font: id });
    if (f.g) assert.match(css, new RegExp(`--font-body:'${f.name}'`), id);
    else assert.doesNotMatch(css, /--font-body/, id);
  }
});

// ── الخادم ──
async function loadWorker() {
  execFileSync(process.execPath, [join(root, 'tools', 'build.mjs')], { stdio: 'pipe', env: { ...process.env, MV_BUILD: 'test' } });
  const src = readFileSync(join(root, 'dist', 'worker.js'), 'utf8')
    .replace(/import \{ DurableObject \} from ['"]cloudflare:workers['"];/, 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
  const dir = mkdtempSync(join(tmpdir(), 'mv-theme-'));
  writeFileSync(join(dir, 'worker.mjs'), src);
  return (await import(join(dir, 'worker.mjs'))).default;
}
const envWith = (theme) => ({ STORE: { idFromName: () => 'x', get: () => ({ theme: async () => cleanTheme(theme) }) } });
const ctx = { waitUntil() {} };

test('كل صفحة HTML تحمل التصميم المحفوظ في <head>، والوضع النهاري الأصلي يُكتب على <html>', async () => {
  const worker = await loadWorker();
  const light = { ...THEME_PRESETS[1], mode: 'light', radius: 'sharp', font: 'tajawal' };
  for (const path of ['/', '/admin']) {
    const res = await worker.fetch(new Request(`https://mv.test${path}`), envWith(light), ctx);
    assert.equal(res.status, 200);
    const html = await res.text();
    const style = html.match(/<style id="mv-theme">([\s\S]*?)<\/style>\n<\/head>/);
    assert.ok(style, `${path}: التصميم محقون قبل </head>`);
    assert.equal(style[1], themeCss(light));
    assert.match(html, /<html data-theme="light" lang="ar" dir="rtl">/);
    assert.match(res.headers.get('etag'), /^"test\.[0-9a-f]{12}"$/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(res.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
    // نفس النسخة: 304 بلا جسم
    const again = await worker.fetch(new Request(`https://mv.test${path}`, { headers: { 'if-none-match': res.headers.get('etag') } }), envWith(light), ctx);
    assert.equal(again.status, 304);
  }
});

test('بدون قاعدة بيانات (أو عند خطأ): التصميم الأصلي، والوضع الليلي بلا سمة على <html>', async () => {
  const worker = await loadWorker();
  const broken = { STORE: { idFromName: () => 'x', get: () => ({ theme: async () => { throw new Error('down'); } }) } };
  const html = await (await worker.fetch(new Request('https://mv.test/'), broken, ctx)).text();
  assert.ok(html.includes(`<style id="mv-theme">${themeCss(DEFAULT_THEME)}</style>`));
  assert.match(html, /<html lang="ar" dir="rtl">/);
});
