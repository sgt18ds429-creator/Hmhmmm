// build.mjs — يجمع الخادم وكل ملفات public/ في ملف واحد: dist/worker.js
// node tools/build.mjs
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
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

const entries = [];
for (const file of walk(pub)) {
  const path = '/' + relative(pub, file).split('\\').join('/');
  const type = TYPES[extname(file)];
  if (!type) throw new Error(`نوع ملف غير معروف: ${path}`);
  const binary = !type.startsWith('text/') && type !== 'image/svg+xml' && type !== 'application/manifest+json';
  const body = binary
    ? `bin(${JSON.stringify(readFileSync(file).toString('base64'))})`
    : JSON.stringify(readFileSync(file, 'utf8'));
  const gated = path.startsWith('/app/') && !OPEN_APP_FILES.has(path);
  entries.push(`  ${JSON.stringify(path)}: { body: ${body}, type: ${JSON.stringify(type)}, gated: ${gated}, immutable: ${binary} }`);
}

const assets = `var BUILD = ${JSON.stringify(BUILD)};
var bin = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
var ASSETS = {
${entries.join(',\n')}
};`;

const server = readFileSync(join(root, 'src', 'server.js'), 'utf8');
if (!server.includes('/*__ASSETS__*/')) throw new Error('src/server.js: علامة /*__ASSETS__*/ مفقودة');
mkdirSync(join(root, 'dist'), { recursive: true });
const out = server.replace('/*__ASSETS__*/', () => assets);
writeFileSync(join(root, 'dist', 'worker.js'), out);
console.log(`dist/worker.js · build ${BUILD} · ${entries.length} ملف · ${(out.length / 1024).toFixed(0)} KB`);
