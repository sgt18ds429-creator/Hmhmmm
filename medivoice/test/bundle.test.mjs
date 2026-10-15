// يبني dist/worker.js ويتأكد أنه يخدم الملفات كما هي في public/ ويحمي ملفات التطبيق.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadWorker() {
  execFileSync(process.execPath, [join(root, 'tools', 'build.mjs')], { stdio: 'pipe', env: { ...process.env, MV_BUILD: 'test' } });
  const src = readFileSync(join(root, 'dist', 'worker.js'), 'utf8')
    .replace(/import \{ DurableObject \} from ['"]cloudflare:workers['"];/, 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
  const dir = mkdtempSync(join(tmpdir(), 'mv-'));
  writeFileSync(join(dir, 'worker.mjs'), src);
  return (await import(join(dir, 'worker.mjs'))).default;
}

// البناء يضيف رقم الإصدار لروابط الوحدات والتنسيقات (?v=test في الاختبار)، والخادم يحقن التصميم في <head>
// صفحات HTML: يُزالان قبل المقارنة بالأصل
const unversion = (text) => text.replaceAll('?v=test', '').replace(/<style id="mv-theme">[\s\S]*?<\/style>\n(?=<\/head>)/, '');

const env = (active) => ({ STORE: { idFromName: () => 'x', get: () => ({
  isActive: async () => active,
  authorize: async () => (active ? { ok: true, code: 'x' } : { ok: false, status: 401, error: 'locked' }),
}) } });

test('يخدم كل الملفات العامة كما هي', async () => {
  const worker = await loadWorker();
  for (const [path, file, type] of [['/', 'index.html', 'text/html'], ['/shell.js', 'shell.js', 'text/javascript'], ['/app/ui.js', 'app/ui.js', 'text/javascript'], ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json']]) {
    const res = await worker.fetch(new Request(`https://mv.test${path}`), env(false), {});
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type').startsWith(type), path);
    const body = await res.text();
    if (type === 'text/html') assert.match(body, /<style id="mv-theme">:root\{--v1:#5433ec;/, 'التصميم محقون');
    assert.equal(unversion(body), readFileSync(join(root, 'public', file), 'utf8'), path);
  }
  const png = await worker.fetch(new Request('https://mv.test/icon-192.png'), env(false), {});
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), readFileSync(join(root, 'public', 'icon-192.png')));
});

test('ملفات التطبيق مقفلة لغير المفعّل ومفتوحة للمفعّل', async () => {
  const worker = await loadWorker();
  const cookie = { headers: { cookie: 'mv_dev=' + 'a'.repeat(40) } };
  assert.equal((await worker.fetch(new Request('https://mv.test/app/pipeline.js'), env(false), {})).status, 403);
  assert.equal((await worker.fetch(new Request('https://mv.test/app/pipeline.js', cookie), env(false), {})).status, 403);
  const ok = await worker.fetch(new Request('https://mv.test/app/pipeline.js', cookie), env(true), {});
  assert.equal(ok.status, 200);
  assert.equal(unversion(await ok.text()), readFileSync(join(root, 'public', 'app', 'pipeline.js'), 'utf8'));
});

test('روابط الوحدات تحمل رقم الإصدار، والرابط بالإصدار الحالي يُخزَّن سنة والقديم لا', async () => {
  const worker = await loadWorker();
  const html = await (await worker.fetch(new Request('https://mv.test/'), env(false), {})).text();
  assert.match(html, /src="\/shell\.js\?v=test"/);
  assert.match(html, /href="\/shell\.css\?v=test"/);
  assert.match(html, /href="\/fonts\.css\?v=test"/);
  const shell = await (await worker.fetch(new Request('https://mv.test/shell.js'), env(false), {})).text();
  assert.match(shell, /from '\/brand\.js\?v=test'/);
  // كل الاستيرادات النسبية والمطلقة في ملفات التطبيق تحمل الإصدار (وحدة واحدة لكل ملف، لا نسختان)
  const cookie = { headers: { cookie: 'mv_dev=' + 'a'.repeat(40) } };
  for (const f of ['main.js', 'run.js', 'doc.js', 'pipeline.js', 'game.js', 'game-worker.js']) {
    const text = await (await worker.fetch(new Request(`https://mv.test/app/${f}`, cookie), env(true), {})).text();
    const bare = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]((?:\.{1,2}\/|\/)[^'"]+\.js)['"]/g)].map((m) => m[1]).filter((u) => !u.includes('?v='));
    assert.deepEqual(bare, [], `${f}: استيراد بلا إصدار`);
  }
  const cur = await worker.fetch(new Request('https://mv.test/shell.js?v=test'), env(false), {});
  assert.match(cur.headers.get('cache-control'), /max-age=31536000, immutable/);
  const old = await worker.fetch(new Request('https://mv.test/shell.js?v=202001010000'), env(false), {});
  assert.equal(old.headers.get('cache-control'), 'no-cache', 'إصدار قديم: لا يُخزَّن محتوى جديد باسمه');
  const app = await worker.fetch(new Request('https://mv.test/app/run.js?v=test', cookie), env(true), {});
  assert.match(app.headers.get('cache-control'), /^private, max-age=31536000/);
  const font = await worker.fetch(new Request('https://mv.test/fonts/el-messiri-arabic.woff2'), env(false), {});
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.deepEqual(Buffer.from(await font.arrayBuffer()), readFileSync(join(root, 'public', 'fonts', 'el-messiri-arabic.woff2')));
});
