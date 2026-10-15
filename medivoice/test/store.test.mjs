// قاعدة البيانات (Durable Object) على SQLite حقيقية، وتناوب مفاتيح Groq في البروكسي:
// الحد اليومي «بلا حد»، تعدد مفاتيح Groq، والانتقال للمفتاح التالي عند نفاد حصة مفتاح.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
  const src = readFileSync(join(root, 'dist', 'worker.js'), 'utf8')
    .replace(/import \{ DurableObject \} from ['"]cloudflare:workers['"];/, 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
  const dir = mkdtempSync(join(tmpdir(), 'mv-store-'));
  writeFileSync(join(dir, 'worker.mjs'), src);
  mod = await import(join(dir, 'worker.mjs'));
  return mod;
}

/** ctx.storage بقاعدة SQLite في الذاكرة بنفس واجهة Cloudflare (exec → toArray). */
function makeStore(Store) {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...args) {
      if (!args.length && /;\s*\S/.test(query.trim().replace(/;\s*$/, ''))) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...args).map((r) => ({ ...r }));
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
