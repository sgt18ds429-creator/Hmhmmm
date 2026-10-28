// قاعدة البيانات (Durable Object) على SQLite حقيقية، وتناوب مفاتيح Groq في البروكسي:
// الحد اليومي «بلا حد»، تعدد مفاتيح Groq، والانتقال للمفتاح التالي عند نفاد حصة مفتاح.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let mod = null;
async function loadModule() {
  if (mod) return mod;
  execFileSync(process.execPath, [join(root, 'tools', 'build.mjs')], { stdio: 'pipe', env: { ...process.env, MV_BUILD: 'test' } });
  const src = readFileSync(join(root, 'dist', 'worker.test.js'), 'utf8')
    .replace(/import \{ DurableObject \} from ['"]cloudflare:workers['"];/, 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
  const dir = mkdtempSync(join(tmpdir(), 'mv-store-'));
  writeFileSync(join(dir, 'worker.mjs'), src);
  mod = await import(join(dir, 'worker.mjs'));
  return mod;
}

/** ctx.storage بقاعدة SQLite في الذاكرة بنفس واجهة Cloudflare (exec → toArray). */
function makeStore(Store) {
  const db = new DatabaseSync(':memory:');
  // مثل Cloudflare: BLOB يدخل ويخرج ArrayBuffer (node:sqlite يتعامل بـ Uint8Array)
  const toDb = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  const fromDb = (v) => (v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);
  const sql = {
    exec(query, ...args) {
      if (!args.length && /;\s*\S/.test(query.trim().replace(/;\s*$/, ''))) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...args.map(toDb)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fromDb(v)])));
      return { toArray: () => rows };
    },
  };
  let alarm = null;
  const ctx = { storage: { sql, getAlarm: async () => alarm, setAlarm: async (t) => { alarm = t; } } };
  return new Store(ctx, { KEYS_SECRET: 'store-test-secret-0123456789abcdef', ADMIN_PASSWORD: 'admin-pass-123' });
}
const META = { ip: '10.0.0.1', os: 'android', browser: 'chrome', screen: '390x844', ua: 'test', country: 'IQ', city: 'Baghdad' };
const compact = (display) => display.replace(/^MV-/, '').replace(/-/g, '');

test('«بلا حد»: الكود لا يتوقف مهما حوّل، والحد يرجع إذا عدّله المسؤول', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { label: 'طالب', daily_hours: 0 });
  assert.equal(made.ok, true);
  const act = await store.activate('dev-1', made.created[0], META);
  assert.equal(act.ok, true);
  assert.equal(act.session.usage.limit_sec, 0, 'الجلسة تقول بلا حد');
  const code = compact(made.created[0]);
  store.logUsage(code, 'audio', 20 * 3600); // 20 ساعة اليوم
  const big = await store.authorize('dev-1', { kind: 'gemini', sec: 1800 });
  assert.equal(big.ok, true, 'لا حد يومي');
  // المسؤول يرجّع حداً: ساعة واحدة
  assert.equal((await store.adminUpdateCode(token, code, { daily_hours: 1 })).ok, true);
  const blocked = await store.authorize('dev-1', { kind: 'gemini', sec: 600 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'daily_limit');
  // ثم «بلا حد» من جديد
  await store.adminUpdateCode(token, code, { daily_hours: 0 });
  assert.equal((await store.authorize('dev-1', { kind: 'gemini', sec: 600 })).ok, true);
  // القيم الغريبة لا تصير «بلا حد» بالغلط: الفارغ يأخذ الافتراضي، والسالب أقل حد
  await store.adminUpdateCode(token, code, { daily_hours: -3 });
  const limitOf = async (c) => (await store.adminOverview(token)).codes.find((x) => x.code === c).daily_limit_sec;
  assert.equal(await limitOf(code), 900);
  for (const v of ['', null, 'abc']) {
    await store.adminUpdateCode(token, code, { daily_hours: v });
    assert.equal(await limitOf(code), 8 * 3600, `«${v}» يأخذ 8 ساعات لا «بلا حد»`);
  }
  assert.equal((await store.adminSaveSettings(token, { defaultDailyHours: '' })).settings.defaultDailyHours, 8);
  // الإعداد الافتراضي للأكواد الجديدة «بلا حد»
  const saved = await store.adminSaveSettings(token, { defaultDailyHours: 0 });
  assert.equal(saved.ok, true);
  const next = await store.adminCreateCodes(token, { label: 'ثاني' });
  const fresh = (await store.adminOverview(token)).codes.find((c) => c.code === compact(next.created[0]));
  assert.equal(fresh.daily_limit_sec, 0);
});

test('التصميم: المسؤول يحفظه منظّفاً، ويبقى مع حفظ باقي الإعدادات، والقيم الغريبة ترجع للأصل', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  assert.equal((await store.theme()).mode, 'dark', 'الأصل قبل أي حفظ');
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  assert.equal((await store.adminSaveSettings('bad-token', { theme: { mode: 'light' } })).ok, false, 'بلا دخول لا يُحفظ');
  const r = await store.adminSaveSettings(token, { theme: { c1: '#2563eb', mode: 'light', font: 'cairo', motion: 'light', radius: 'evil', toggle: false } });
  assert.equal(r.ok, true);
  assert.equal(r.settings.theme.c1, '#2563eb');
  assert.equal(r.settings.theme.radius, 'round', 'قيمة غير معروفة ترجع للأصل');
  const t = await store.theme();
  assert.deepEqual([t.mode, t.font, t.motion, t.toggle], ['light', 'cairo', 'light', false]);
  // حفظ إعداد آخر لا يمس التصميم
  await store.adminSaveSettings(token, { notice: 'صيانة' });
  assert.equal((await store.theme()).c1, '#2563eb');
});

test('أكثر من مفتاح Groq: تُضاف وتُحفظ مشفّرة، والتكرار لا يُحسب، والحد 6', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { daily_hours: 8 });
  await store.activate('dev-2', made.created[0], META);
  const k = (n) => `gsk_${String(n).repeat(30)}`;
  let r = await store.setKey('dev-2', 'groq', [k(1)]);
  assert.equal(r.session.keys.groq.count, 1);
  r = await store.setKey('dev-2', 'groq', [k(2)], { add: true });
  assert.equal(r.session.keys.groq.count, 2);
  assert.match(r.session.keys.groq.hint, / · /);
  r = await store.setKey('dev-2', 'groq', [k(2)], { add: true });
  assert.equal(r.session.keys.groq.count, 2, 'نفس المفتاح مرتين يُحسب مرة');
  const auth = await store.authorize('dev-2', { kind: 'groq' });
  assert.deepEqual(auth.groqKeys, [k(1), k(2)]);
  assert.equal(auth.groq, k(1));
  r = await store.setKey('dev-2', 'groq', [k(3), k(4), k(5), k(6), k(7)], { add: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too_many_keys');
  // الربط بدون «إضافة» يستبدل القائمة
  r = await store.setKey('dev-2', 'groq', [k(8)]);
  assert.equal(r.session.keys.groq.count, 1);
  assert.deepEqual((await store.authorize('dev-2', { kind: 'groq' })).groqKeys, [k(8)]);
  const listed = (await store.adminOverview(token)).codes[0];
  assert.equal(listed.groq, 1);
});

function proxyEnv(keys, extra = {}) {
  return { STORE: { idFromName: () => 'x', get: () => ({ authorize: async () => ({ ok: true, code: 'c', groq: keys[0], groqKeys: keys, gemini: keys[0], geminiKeys: keys }), logUsage: async () => {}, ...extra }) } };
}
const sttReq = (cookie, model = 'whisper-large-v3') => new Request(`https://mv.test/api/stt?sec=0&m=${model}`, {
  method: 'POST', headers: { cookie: `mv_dev=${cookie}`, 'x-mv': '1', 'content-type': 'multipart/form-data; boundary=zz' }, body: '--zz\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper\r\n--zz--',
});

test('بروكسي Groq: حصة مفتاح تخلص ← المفتاح التالي فوراً، ويُتذكّر حتى موعده؛ وإذا خلص الكل يرجع أقرب موعد', async () => {
  const worker = (await loadModule()).default;
  const realFetch = globalThis.fetch, realRandom = Math.random;
  const calls = [];
  let k2Left = 1;
  Math.random = () => 0;
  globalThis.fetch = async (url, init) => {
    const key = init.headers.authorization.slice(7);
    calls.push(key);
    const body = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body);
    assert.match(body, /whisper/, 'الجسم نفسه يصل لكل مفتاح');
    if (key === 'k1' || (key === 'k2' && k2Left-- <= 0)) {
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached ... seconds of audio per day (ASD)' } }), { status: 429, headers: { 'retry-after': key === 'k1' ? '7000' : '3000', 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const env = proxyEnv(['k1', 'k2']);
    const ctx = { waitUntil() {} };
    const r1 = await worker.fetch(sttReq('a'.repeat(40)), env, ctx);
    assert.equal(r1.status, 200);
    assert.deepEqual(calls, ['k1', 'k2']);
    calls.length = 0;
    // k1 متذكَّر: لا طلب عليه، و k2 الآن يبلغ حده أيضاً → يرجع 429 بأقرب موعد (3000 ثانية)
    const r2 = await worker.fetch(sttReq('a'.repeat(40)), env, ctx);
    assert.deepEqual(calls, ['k2']);
    assert.equal(r2.status, 429);
    assert.equal(r2.headers.get('retry-after'), '3000');
    calls.length = 0;
    // كل المفاتيح متذكَّرة: رد فوري بلا طلب، والموعد الأقرب
    const r3 = await worker.fetch(sttReq('a'.repeat(40)), env, ctx);
    assert.deepEqual(calls, []);
    assert.equal(r3.status, 429);
    assert.ok(Number(r3.headers.get('retry-after')) <= 3000);
    // نموذج آخر (turbo) حصته منفصلة: يُطلب عادي
    k2Left = 1;
    const r4 = await worker.fetch(sttReq('a'.repeat(40), 'whisper-large-v3-turbo'), env, ctx);
    assert.equal(r4.status, 200);
  } finally { globalThis.fetch = realFetch; Math.random = realRandom; }
});

test('بروكسي Groq: مفتاح ملغى (401) يُتخطى للتالي، ومفتاح واحد يرجع رده كما هو', async () => {
  const worker = (await loadModule()).default;
  const realFetch = globalThis.fetch, realRandom = Math.random;
  const calls = [];
  Math.random = () => 0;
  globalThis.fetch = async (url, init) => {
    const key = init.headers.authorization.slice(7);
    calls.push(key);
    if (key === 'bad') return new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const chat = (cookie) => new Request('https://mv.test/api/groq?m=openai/gpt-oss-120b', { method: 'POST', headers: { cookie: `mv_dev=${cookie}`, 'x-mv': '1', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [] }) });
  try {
    const r = await worker.fetch(chat('b'.repeat(40)), proxyEnv(['bad', 'good']), { waitUntil() {} });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ['bad', 'good']);
    calls.length = 0;
    const one = await worker.fetch(chat('c'.repeat(40)), proxyEnv(['bad']), { waitUntil() {} });
    assert.equal(one.status, 401, 'المفتاح الوحيد المرفوض يصل للمتصفح فيطلب ربطه من جديد');
  } finally { globalThis.fetch = realFetch; Math.random = realRandom; }
});

test('بروكسي Gemini: نفاد حصة اليوم بكل المفاتيح يُتذكّر فيرد فوراً بنفس خطأ Google، وحد الدقيقة يُفضَّل', async () => {
  const worker = (await loadModule()).default;
  const realFetch = globalThis.fetch, realRandom = Math.random;
  const calls = [];
  Math.random = () => 0;
  const day = JSON.stringify({ error: { code: 429, message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '79525s' }] } });
  const minute = JSON.stringify({ error: { code: 429, message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' }] } });
  globalThis.fetch = async (url, init) => {
    const key = init.headers['x-goog-api-key'];
    calls.push(`${key}@${url.match(/models\/([^:]+)/)[1]}`);
    if (/strong/.test(url)) return new Response(key === 'g2' && /strong-b/.test(url) ? minute : day, { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const gem = (model) => new Request(`https://mv.test/api/gemini?model=${model}&sec=0`, { method: 'POST', headers: { cookie: `mv_dev=${'d'.repeat(40)}`, 'x-mv': '1', 'content-type': 'application/json' }, body: '{}' });
  try {
    const env = proxyEnv(['g1', 'g2']);
    const r1 = await worker.fetch(gem('gemini-strong-a'), env, { waitUntil() {} });
    assert.equal(r1.status, 429);
    assert.deepEqual(calls, ['g1@gemini-strong-a', 'g2@gemini-strong-a']);
    assert.match(await r1.text(), /PerDay/);
    calls.length = 0;
    const r2 = await worker.fetch(gem('gemini-strong-a'), env, { waitUntil() {} });
    assert.equal(r2.status, 429);
    assert.deepEqual(calls, [], 'رد فوري بلا طلب');
    assert.match(await r2.text(), /PerDay/, 'المتصفح يميّزه كنفاد يومي');
    calls.length = 0;
    // مفتاح خلصت حصته اليومية وآخر في حد الدقيقة: يرجع رد الدقيقة (ينتظر النموذج بدل أن يتركه)
    const r3 = await worker.fetch(gem('gemini-strong-b'), env, { waitUntil() {} });
    assert.match(await r3.text(), /PerMinute/);
    // النموذج الخفيف يعمل
    assert.equal((await worker.fetch(gem('gemini-x-lite'), env, { waitUntil() {} })).status, 200);
  } finally { globalThis.fetch = realFetch; Math.random = realRandom; }
});

test('الحد اليومي يحسب المقاطع الجارية: 6 مقاطع متوازية لا تتجاوزه، وفشل المقطع يحرّر حجزه', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { daily_hours: 1 });
  await store.activate('dev-p', made.created[0], META);
  const code = compact(made.created[0]);
  store.logUsage(code, 'audio', 3000); // بقي 600 ثانية (+30 سماحاً)
  // ثلاثة مقاطع متوازية من 300 ثانية: الأول والثاني يُقبلان، الثالث يتجاوز الحد وهو محجوز
  assert.equal((await store.authorize('dev-p', { kind: 'groq', sec: 300, req: 'r1' })).ok, true);
  assert.equal((await store.authorize('dev-p', { kind: 'groq', sec: 300, req: 'r2' })).ok, true);
  const third = await store.authorize('dev-p', { kind: 'groq', sec: 300, req: 'r3' });
  assert.equal(third.ok, false); assert.equal(third.error, 'daily_limit');
  // نفس الطلب يُعاد (رده ضاع): لا يُحجز مرة ثانية
  assert.equal((await store.authorize('dev-p', { kind: 'groq', sec: 300, req: 'r2' })).ok, true);
  // المقطع الثاني فشل عند المزوّد: حجزه يتحرر فيُقبل الثالث
  store.release('r2');
  assert.equal((await store.authorize('dev-p', { kind: 'groq', sec: 300, req: 'r3' })).ok, true);
  // تسجيل الأول يحوّل حجزه إلى استهلاك فعلي: المجموع نفسه، ولا يُحسب مرتين
  store.logUsage(code, 'audio', 300, 'r1');
  store.logUsage(code, 'audio', 300, 'r1');
  assert.equal((await store.authorize('dev-p', { kind: 'groq', sec: 100, req: 'r4' })).ok, false, '3300 فعلي + 300 محجوز = الحد');
  assert.equal((await store.adminOverview(token)).codes[0].total_sec, 3300);
});

test('حالة المفاتيح تُحفظ في قاعدة البيانات وتُرجع مع التصريح، وتُمسح عند تغيير المفاتيح', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { daily_hours: 8 });
  await store.activate('dev-h', made.created[0], META);
  const code = compact(made.created[0]);
  const k = `AIza${'x'.repeat(30)}`;
  await store.setKey('dev-h', 'gemini', [k]);
  const until = Date.now() + 3600_000;
  store.noteKey(code, 'AIza…xxxx|gemini-strong', until);
  store.noteKey(code, 'AIza…xxxx|gemini-strong', until - 1000); // الأبعد يبقى
  store.noteKey(code, 'AIza…xxxx|old', Date.now() - 10);
  const auth = await store.authorize('dev-h', { kind: 'gemini' });
  assert.deepEqual(auth.health, [['AIza…xxxx|gemini-strong', until]]);
  await store.setKey('dev-h', 'gemini', [k], { add: true });
  assert.deepEqual((await store.authorize('dev-h', { kind: 'gemini' })).health, [], 'ربط مفتاح يمسح ما تُعلِّم');
});

test('إضافة مفتاحين في وقت واحد لا تضيع أحدهما', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { daily_hours: 8 });
  await store.activate('dev-c', made.created[0], META);
  const k = (n) => `gsk_${String(n).repeat(30)}`;
  await store.setKey('dev-c', 'groq', [k(1)]);
  await Promise.all([store.setKey('dev-c', 'groq', [k(2)], { add: true }), store.setKey('dev-c', 'groq', [k(3)], { add: true })]);
  const keys = (await store.authorize('dev-c', { kind: 'groq' })).groqKeys;
  assert.deepEqual([...keys].sort(), [k(1), k(2), k(3)]);
});

test('بروكسي Gemini: 429 يذكر حدّي الدقيقة واليوم معاً يُعدّ نفاد يوم، والحالة تُرسل لقاعدة البيانات', async () => {
  const worker = (await loadModule()).default;
  const realFetch = globalThis.fetch, realRandom = Math.random;
  Math.random = () => 0;
  const both = JSON.stringify({ error: { code: 429, message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }, { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '50000s' }] } });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(both, { status: 429, headers: { 'content-type': 'application/json' } }); };
  const noted = [];
  const gem = () => new Request('https://mv.test/api/gemini?model=gemini-mixed&sec=0', { method: 'POST', headers: { cookie: `mv_dev=${'e'.repeat(40)}`, 'x-mv': '1', 'content-type': 'application/json' }, body: '{}' });
  try {
    const env = proxyEnv(['k1'], { noteKey: async (code, k, until) => noted.push([code, k, until > Date.now() + 3600_000]) });
    const r1 = await worker.fetch(gem(), env, { waitUntil(p) { p.catch(() => {}); } });
    assert.equal(r1.status, 429); assert.equal(calls, 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(noted, [['c', 'k1…k1|gemini-mixed', true]]);
    const r2 = await worker.fetch(gem(), env, { waitUntil(p) { p.catch(() => {}); } });
    assert.equal(r2.status, 429); assert.equal(calls, 1, 'يُتذكّر: لا طلب ثانٍ');
  } finally { globalThis.fetch = realFetch; Math.random = realRandom; }
});

test('بروكسي: حالة مفتاح جاءت من قاعدة البيانات (خادم آخر تعلّمها) تُطبَّق بلا طلب', async () => {
  const worker = (await loadModule()).default;
  const realFetch = globalThis.fetch, realRandom = Math.random;
  Math.random = () => 0;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const gem = () => new Request('https://mv.test/api/gemini?model=gemini-remembered&sec=0', { method: 'POST', headers: { cookie: `mv_dev=${'f'.repeat(40)}`, 'x-mv': '1', 'content-type': 'application/json' }, body: '{}' });
  try {
    const env = { STORE: { idFromName: () => 'x', get: () => ({ authorize: async () => ({ ok: true, code: 'c', gemini: 'zz9', geminiKeys: ['zz9'], health: [['zz9…zz9|gemini-remembered', Date.now() + 3600_000]] }), logUsage: async () => {} }) } };
    const r = await worker.fetch(gem(), env, { waitUntil() {} });
    assert.equal(r.status, 429); assert.equal(calls, 0);
    assert.match(await r.text(), /PerDay/);
  } finally { globalThis.fetch = realFetch; Math.random = realRandom; }
});

test('الحد اليومي يتجدد منتصف الليل بتوقيت بغداد، لا بعد 24 ساعة من الاستعمال', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { label: 'طالب', daily_hours: 2 });
  await store.activate('dev-1', made.created[0], META);
  const code = compact(made.created[0]);
  const DAY = 86400000, TZ = 3 * 3600000;
  const midnight = Math.floor((Date.now() + TZ) / DAY) * DAY - TZ;
  // البارحة قبل منتصف الليل بدقيقة: ساعة ونص لا تُحسب اليوم
  store.sql.exec("INSERT INTO usage (code, ts, kind, sec) VALUES (?, ?, 'audio', ?)", code, midnight - 60_000, 5400);
  assert.equal(store.session('dev-1', META).usage.used_sec, 0);
  // اليوم بعد منتصف الليل: نص ساعة
  store.sql.exec("INSERT INTO usage (code, ts, kind, sec) VALUES (?, ?, 'audio', ?)", code, midnight + 60_000, 1800);
  assert.equal(store.session('dev-1', META).usage.used_sec, 1800);
  // ساعة و40 دقيقة زيادة تتجاوز الساعتين: يرفض، والرصيد يرجع منتصف الليل الجاي
  const r = await store.authorize('dev-1', { kind: 'gemini', sec: 6000 });
  assert.equal(r.error, 'daily_limit');
  const left = Math.max(60, Math.ceil((midnight + DAY - Date.now()) / 1000));
  assert.ok(Math.abs(r.retry_after - left) <= 2, `${r.retry_after} ≈ ${left}`);
  // لوحة التحكم تعرض نفس الحساب
  const ov = await store.adminOverview(token);
  assert.equal(ov.codes[0].used_sec, 1800);
});

test('النقل لرابط ثاني: رمز لمرة واحدة، يدخل بنفس التفعيل إذا ما عنده تفعيل، والبيانات تنزل كاملة ثم تنمسح', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { label: 'طالب' });
  const secret = 'S'.repeat(43);
  const dev = createHash('sha256').update(secret).digest('hex');
  assert.equal((await store.activate(dev, made.created[0], META)).ok, true);

  // الرابط القديم مفعّل: الرمز يحمل دخوله
  const st = await store.moveStart(dev, secret, '1.2.3.4');
  assert.equal(st.ok, true);
  assert.equal(st.session, true);
  assert.equal(store.movePut(st.token, 0, new Uint8Array(1024 * 1024).fill(7).buffer).ok, true);
  assert.equal(store.movePut(st.token, 1, new Uint8Array(10).fill(9).buffer).ok, true);
  assert.equal(store.movePut(st.token, 2, new ArrayBuffer(1024 * 1024 + 1)).ok, false, 'قطعة أكبر من 1 ميغا');
  assert.equal(store.movePut('x'.repeat(30), 0, new ArrayBuffer(4)).ok, false, 'رمز غير موجود');
  assert.equal(store.moveGet(st.token, 0), null, 'لا تنزيل قبل الاستلام');

  // الرابط الرئيسي بلا تفعيل: يستلم السر ويدخل بنفس الجهاز
  const c = await store.moveClaim(st.token, null);
  assert.equal(c.ok, true);
  assert.equal(c.parts, 2);
  assert.equal(c.size, 1024 * 1024 + 10);
  assert.equal(c.secret, secret);
  assert.equal(store.movePut(st.token, 2, new ArrayBuffer(4)).ok, false, 'لا رفع بعد الاستلام');
  assert.equal(new Uint8Array(store.moveGet(st.token, 1))[0], 9);
  assert.equal(store.moveGet(st.token, 0).byteLength, 1024 * 1024);

  // متصفح عنده تفعيل صالح على الرئيسي: تفعيله لا يُستبدل
  const st2 = await store.moveStart(dev, secret, '1.2.3.4');
  assert.equal((await store.moveClaim(st2.token, dev)).secret, null);

  // وصلت: البيانات تنمسح، والحالة «وصلت» تبقى للرابط القديم، والرمز ما يُستعمل مرة ثانية
  assert.equal(store.moveDone(st.token).ok, true);
  assert.equal(store.moveGet(st.token, 0), null);
  assert.equal(store.moveStatus(st.token).done, true);
  assert.equal((await store.moveClaim(st.token, null)).ok, false);
  assert.equal(store.moveStatus(st2.token).done, false);

  // رابط قديم انتهى تفعيله (أو انتقل): ينقل البيانات بلا دخول
  const st3 = await store.moveStart('no-such-device', secret, '1.2.3.4');
  assert.equal(st3.session, false);
  assert.equal((await store.moveClaim(st3.token, null)).secret, null);
});

test('تسجيل خروج الزبون: يرجع لصفحة الكود، ورجوعه على نفس الهاتف بلا ما يُحسب نقلاً، وهاتف ثاني ما ياخذ مكانه', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { label: 'طالب' }); // جهاز واحد مسموح
  const code = made.created[0];
  assert.equal((await store.activate('dev-1', code, META)).ok, true);
  assert.equal(store.session('dev-1', META).active, true);

  assert.equal(store.logout('dev-1', META).ok, true);
  assert.equal(store.session('dev-1', META).active, false, 'بعد الخروج يطلب الكود');
  let ov = await store.adminOverview(token);
  assert.equal(ov.codes[0].devices.length, 1, 'مكانه محجوز');
  assert.equal(ov.codes[0].devices[0].out, true);

  // هاتف ثاني (موديل آخر) ما ياخذ مكانه: الكود ما يصير قابلاً للمشاركة بالخروج
  const other = { ...META, os: 'iOS', screen: '430x932' };
  assert.equal((await store.activate('dev-2', code, other)).error, 'in_use');

  // نفس الهاتف يرجع بالكود (بمتصفح جديد): يدخل، بلا تكرار سجل، وثلاث مرات بالشهر ما تخلص حد النقل (2)
  for (const id of ['dev-3', 'dev-4', 'dev-5']) {
    assert.equal((await store.activate(id, code, META)).ok, true, id);
    assert.equal(store.logout(id, META).ok, true);
  }
  assert.equal((await store.activate('dev-6', code, META)).ok, true);
  ov = await store.adminOverview(token);
  assert.equal(ov.codes[0].devices.length, 1);
  assert.equal(ov.codes[0].devices[0].out, false);
  assert.equal(ov.events.filter((e) => e.type === 'device_moved').length, 0, 'ما انحسب نقل');
});

test('مشاكل المفاتيح للمسؤول: مفتاح Gemini قفلت Google حصته، مفتاح مشترك، ومفاتيح Groq من نفس الحساب', async () => {
  const { MediVoiceStore } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { count: 3, label: 'طالب' });
  const [a, b, c] = made.created;
  for (const [i, code] of made.created.entries()) await store.activate(`dev-${i}`, code, { ...META, screen: `${400 + i}x900` });
  const gem = (n) => `AIza${String(n).repeat(35)}`;
  const grq = (n) => `gsk_${String(n).repeat(40)}`;
  await store.setKey('dev-0', 'gemini', [gem(1), gem(2)]);
  const shared = await store.setKey('dev-1', 'gemini', [gem(2)]); // نفس مفتاح الطالب الأول
  assert.equal(shared.shared, 1, 'من يربطه يُنبَّه أنه مربوط عند طالب ثاني');
  await store.setKey('dev-1', 'groq', [grq(3)]);
  await store.setKey('dev-2', 'groq', [grq(4)]);
  const hint = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;
  store.keyNote(compact(a), hint(gem(1)), 'restricted');
  store.keyNote(compact(b), hint(grq(3)), 'org:org_SAME');
  store.keyNote(compact(c), hint(grq(4)), 'org:org_SAME');
  const ov = await store.adminOverview(token);
  const by = Object.fromEntries(ov.codes.map((x) => [x.display, x]));
  assert.equal(by[a].warn.restricted, 1);
  assert.equal(by[b].warn.restricted || 0, 0, 'مفتاح الطالب الثاني المشترك سليم');
  assert.deepEqual(by[a].warn.shared, ['طالب 2']);
  assert.deepEqual(by[b].warn.shared, ['طالب 1']);
  assert.deepEqual(by[b].warn.same_org, ['طالب 3']);
  assert.deepEqual(by[c].warn.same_org, ['طالب 2']);
  assert.equal(ov.codes.some((x) => 'gemini_hint' in x || 'groq_hint' in x), false, 'أجزاء المفاتيح ما تطلع للوحة');
  // المفتاح المشترك نفسه مقفول (شافه الخادم عند الطالب الأول): يظهر عند الثاني أيضاً
  store.keyNote(compact(a), hint(gem(2)), 'restricted');
  const ovs = await store.adminOverview(token);
  assert.equal(ovs.codes.find((x) => x.display === b).warn.restricted, 1);
  assert.equal(ovs.codes.find((x) => x.display === a).warn.restricted, 2);
  // تبديل المفتاح المقفول يمسح تنبيهه، والمفتاح المشترك المقفول يبقى مقفولاً عند الطالب الثاني
  await store.setKey('dev-0', 'gemini', [gem(5)]);
  const ov2 = await store.adminOverview(token);
  assert.equal(ov2.codes.find((x) => x.display === a).warn, undefined, 'ما بقى تنبيه (ولا مشترك بعد التبديل)');
  assert.equal(ov2.codes.find((x) => x.display === b).warn.restricted, 1, 'المفتاح نفسه ما زال مقفولاً عند الثاني');
  // حذف كود يمسح ملاحظاته
  await store.adminDeleteCode(token, compact(c));
  const ov3 = await store.adminOverview(token);
  assert.deepEqual(ov3.codes.find((x) => x.display === b).warn?.same_org || [], [], 'ما بقى طالب ثاني بنفس حساب Groq');
});

test('بروكسي: رد Google «free tier is not available» يُسجَّل للمفتاح، وحد Groq يسجّل حسابه (org)', async () => {
  const worker = (await loadModule()).default;
  const realFetch = globalThis.fetch, realRandom = Math.random;
  Math.random = () => 0;
  const notes = [];
  globalThis.fetch = async (url) => {
    if (/googleapis/.test(url)) return new Response(JSON.stringify({ error: { code: 403, message: 'The Gemini API free tier is not available for this project. Please set up billing to upgrade to the paid tier.', status: 'PERMISSION_DENIED' } }), { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: { message: 'Rate limit reached for model `whisper-large-v3` in organization `org_01abcXYZ` service tier `on_demand` on seconds of audio per hour (ASH): Limit 7200, Used 7100, Requested 480. Please try again in 9m31s.', type: 'seconds', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '571' } });
  };
  const ctx = { waitUntil(p) { p?.catch?.(() => {}); } };
  try {
    const env = proxyEnv(['AIzaRESTRICTED0000000000000000000wxyz'], { keyNote: async (code, hint, note) => notes.push([code, hint, note]), noteKey: async () => {} });
    const r = await worker.fetch(new Request('https://mv.test/api/gemini?model=gemini-x&sec=0', { method: 'POST', headers: { cookie: `mv_dev=${'g'.repeat(40)}`, 'x-mv': '1', 'content-type': 'application/json' }, body: '{}' }), env, ctx);
    assert.equal(r.status, 403, 'المتصفح يستلم نفس رد Google فيكشفه');
    const s = await worker.fetch(sttReq('h'.repeat(40)), env, ctx);
    assert.equal(s.status, 429);
    await new Promise((res) => setTimeout(res, 5));
    assert.deepEqual(notes, [['c', 'AIza…wxyz', 'restricted'], ['c', 'AIza…wxyz', 'org:org_01abcXYZ']]);
  } finally { globalThis.fetch = realFetch; Math.random = realRandom; }
});

test('ربط مفتاح Gemini قفلت Google حصته المجانية يُرفض برسالة واضحة، وحد الدقيقة لا يرفض مفتاحاً سليماً', async () => {
  const worker = (await loadModule()).default;
  const realFetch = globalThis.fetch;
  let mode = 'restricted';
  const probes = [];
  globalThis.fetch = async (url, init) => {
    if (/\/models\?/.test(url)) return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite-preview-tts', supportedGenerationMethods: ['generateContent'] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    probes.push(url.match(/models\/([^:]+):/)[1]);
    if (mode === 'restricted') return new Response(JSON.stringify({ error: { code: 403, message: 'The Gemini API free tier is not available for this project.', status: 'PERMISSION_DENIED' } }), { status: 403 });
    if (mode === 'minute') return new Response(JSON.stringify({ error: { code: 429, message: 'quota' } }), { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), { status: 200 });
  };
  let saved = 0;
  const env = { STORE: { idFromName: () => 'x', get: () => ({ isActive: async () => true, setKey: async () => { saved++; return { ok: true, shared: 0, session: { active: true } }; } }) } };
  const link = () => worker.fetch(new Request('https://mv.test/api/keys', { method: 'POST', headers: { cookie: `mv_dev=${'k'.repeat(40)}`, 'x-mv': '1', 'content-type': 'application/json' }, body: JSON.stringify({ key: `AIza${'q'.repeat(35)}` }) }), env, { waitUntil() {} });
  try {
    const r = await link();
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'key_restricted');
    assert.equal(saved, 0, 'ما انحفظ');
    assert.deepEqual(probes, ['gemini-3.5-flash-lite'], 'طلب واحد بأخف نموذج عادي');
    mode = 'minute';
    assert.equal((await link()).status, 200, 'حد الدقيقة ما يعني المفتاح خربان');
    mode = 'ok';
    assert.equal((await link()).status, 200);
    assert.equal(saved, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('فحص الربط الإضافي لا يمنع ربط مفتاح سليم إذا تأخر رد Google', async () => {
  const worker = (await loadModule()).default;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/\/models\?/.test(url)) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
    throw new DOMException('The operation timed out.', 'TimeoutError');
  };
  const env = { STORE: { idFromName: () => 'x', get: () => ({ isActive: async () => true, setKey: async () => ({ ok: true, shared: 0, session: { active: true } }) }) } };
  try {
    const r = await worker.fetch(new Request('https://mv.test/api/keys', { method: 'POST', headers: { cookie: `mv_dev=${'t'.repeat(40)}`, 'x-mv': '1', 'content-type': 'application/json' }, body: JSON.stringify({ key: `AIza${'w'.repeat(35)}` }) }), env, { waitUntil() {} });
    assert.equal(r.status, 200);
  } finally { globalThis.fetch = realFetch; }
});

test('فحص مفاتيح طالب من لوحة التحكم: المفاتيح ما تطلع للمتصفح، المقفول يُسجَّل، والسليم تنمسح ملاحظته القديمة', async () => {
  const { MediVoiceStore, default: worker } = await loadModule();
  const store = makeStore(MediVoiceStore);
  const { token } = await store.adminLogin('admin-pass-123', '10.0.0.9');
  const made = await store.adminCreateCodes(token, { label: 'طالب' });
  await store.activate('dev-k', made.created[0], META);
  const good = `AIza${'g'.repeat(35)}`, bad = `AIza${'b'.repeat(35)}`, grq = `gsk_${'q'.repeat(40)}`;
  await store.setKey('dev-k', 'gemini', [good, bad]);
  await store.setKey('dev-k', 'groq', [grq]);
  const code = compact(made.created[0]);
  store.keyNote(code, `${good.slice(0, 4)}…${good.slice(-4)}`, 'restricted'); // ملاحظة قديمة: Google رجّع الحصة بعدها
  assert.equal((await store.adminKeysFor('wrong', code)).ok, false, 'بلا دخول المسؤول ما يطلع شي');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const key = init?.headers?.['x-goog-api-key'] || String(init?.headers?.authorization || '').slice(7);
    if (/\/models\?/.test(url)) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
    if (/groq/.test(url)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (key === bad) return new Response(JSON.stringify({ error: { code: 403, message: 'The Gemini API free tier is not available for this project.' } }), { status: 403 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), { status: 200 });
  };
  const env = { STORE: { idFromName: () => 'x', get: () => store } };
  try {
    const r = await worker.fetch(new Request(`https://mv.test/api/admin/codes/${code}/check-keys`, { method: 'POST', headers: { cookie: `mv_adm=${token}`, 'x-mv': '1' } }), env, { waitUntil() {} });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.results.map((x) => [x.provider, x.state]), [['gemini', 'ok'], ['gemini', 'restricted'], ['groq', 'ok']]);
    assert.ok(j.results.every((x) => /^….{4}$/.test(x.hint)), 'آخر 4 حروف فقط');
    assert.ok(!JSON.stringify(j).includes(good) && !JSON.stringify(j).includes(bad));
  } finally { globalThis.fetch = realFetch; }
  const w = (await store.adminOverview(token)).codes[0].warn;
  assert.equal(w.restricted, 1, 'المقفول فقط (السليم انمسحت ملاحظته)');
});
