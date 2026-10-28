// build.mjs — يجمع الخادم وكل ملفات public/ في ملف واحد: dist/worker.js
// node tools/build.mjs
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
// ملفات التطبيق لا تُخدم إلا لجهاز مفعّل (الواجهة والتنسيق يبقيان مفتوحين لشاشة القفل)
const OPEN_APP_FILES = new Set(['/app/ui.js', '/app/app.css']);

function walk(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const BUILD = process.env.MV_BUILD || `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;

const entries = [], aliases = [];
const seen = new Map(); // الملفات المتطابقة بايتاً (مثل logo.png و icon-512.png) تُضمَّن مرة واحدة
for (const file of walk(pub)) {
  const path = '/' + relative(pub, file).split('\\').join('/');
  const type = TYPES[extname(file)];
  if (!type) throw new Error(`نوع ملف غير معروف: ${path}`);
  const binary = !type.startsWith('text/') && type !== 'image/svg+xml' && type !== 'application/manifest+json';
  let raw = readFileSync(file);
  // روابط الوحدات والتنسيقات تحمل رقم الإصدار (?v=البناء): يخزّنها المتصفح سنة بلا إعادة تحقق، وكل بناء جديد روابطه
  // جديدة. ملفات المكتبات الخارجية (pdfjs/vendor) لا تُمس
  if (!binary && !/\/(pdfjs(\.worker)?|vendor)\.js$/.test(path)) {
    let text = raw.toString('utf8');
    if (type.startsWith('text/javascript')) {
      text = text.replace(/((?:from|import)\s*\(?\s*)(['"])((?:\.{1,2}\/|\/)[^'"?]+\.js)\2/g, (m, pre, q, spec) => `${pre}${q}${spec}?v=${BUILD}${q}`);
    } else if (type.startsWith('text/html')) {
      text = text.replace(/((?:href|src)=")(\/[^"?]+\.(?:css|js))"/g, (m, pre, spec) => `${pre}${spec}?v=${BUILD}"`);
    }
    raw = Buffer.from(text, 'utf8');
  }
  const key = `${type}:${createHash('sha256').update(raw).digest('hex')}`;
  if (seen.has(key)) { aliases.push(`ASSETS[${JSON.stringify(path)}] = ASSETS[${JSON.stringify(seen.get(key))}];`); continue; }
  seen.set(key, path);
  // الملف الثنائي يُفك من base64 عند أول طلب له فقط (لا عند إقلاع الخادم كله)
  const body = binary ? `get body() { return this._b ??= bin(${JSON.stringify(raw.toString('base64'))}); }` : `body: ${JSON.stringify(raw.toString('utf8'))}`;
  const gated = path.startsWith('/app/') && !OPEN_APP_FILES.has(path);
  entries.push(`  ${JSON.stringify(path)}: { ${body}, type: ${JSON.stringify(type)}, gated: ${gated}, immutable: ${binary} }`);
}

const assets = `var BUILD = ${JSON.stringify(BUILD)};
var bin = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
var ASSETS = {
${entries.join(',\n')}
};
${aliases.join('\n')}`;

const server = readFileSync(join(root, 'src', 'server.js'), 'utf8');
if (!server.includes('/*__ASSETS__*/')) throw new Error('src/server.js: علامة /*__ASSETS__*/ مفقودة');
if (!server.includes('/*__THEME__*/')) throw new Error('src/server.js: علامة /*__THEME__*/ مفقودة');
// منطق التصميم مشترك مع لوحة التحكم: يُضمَّن حرفياً بلا كلمة export (الخادم ملف واحد بلا استيراد)
const themeCore = readFileSync(join(pub, 'theme-core.js'), 'utf8').replace(/^export\s+(?=(?:const|function|let)\b)/gm, '');
if (/^\s*(?:import|export)\b/m.test(themeCore)) throw new Error('public/theme-core.js: لا يُسمح باستيراد أو تصدير غير مباشر');
mkdirSync(join(root, 'dist'), { recursive: true });
const out = server.replace('/*__ASSETS__*/', () => assets).replace('/*__THEME__*/', () => themeCore);
// بناء الاختبارات (MV_BUILD=test) يُكتب بملف منفصل: لا يحل محل النسخة المعدّة للنشر أبداً. نسخة «test» لو نُشرت
// تُخزَّن ملفاتها عند الزبائن سنة كاملة (?v=test) فلا يوصلهم أي إصلاح بعدها
writeFileSync(join(root, 'dist', BUILD === 'test' ? 'worker.test.js' : 'worker.js'), out);
console.log(`dist/worker.js · build ${BUILD} · ${entries.length} ملف${aliases.length ? ` (+${aliases.length} مكرر)` : ''} · ${(out.length / 1024).toFixed(0)} KB`);
