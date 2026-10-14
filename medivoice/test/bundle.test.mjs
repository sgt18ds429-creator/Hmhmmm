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

const env = (active) => ({ STORE: { idFromName: () => 'x', get: () => ({ isActive: async () => active }) } });

test('يخدم كل الملفات العامة كما هي', async () => {
  const worker = await loadWorker();
  for (const [path, file, type] of [['/', 'index.html', 'text/html'], ['/shell.js', 'shell.js', 'text/javascript'], ['/app/ui.js', 'app/ui.js', 'text/javascript'], ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json']]) {
    const res = await worker.fetch(new Request(`https://mv.test${path}`), env(false), {});
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type').startsWith(type), path);
    assert.equal(await res.text(), readFileSync(join(root, 'public', file), 'utf8'), path);
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
  assert.equal(await ok.text(), readFileSync(join(root, 'public', 'app', 'pipeline.js'), 'utf8'));
});
