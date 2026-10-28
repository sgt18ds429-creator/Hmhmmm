// ميدي فويز — MediVoice
// Cloudflare Worker + Durable Object (SQLite)
//
//  • أكواد التفعيل: كل كود يُربط بجهاز واحد (أو بالعدد اللي يحدده المدير).
//  • مفاتيح المستخدم (Groq / Gemini) تُحفظ مشفّرة AES-GCM وتُستخدم فقط لطلبات صاحبها.
//  • بروكسي بثّ مباشر للصوت والذكاء (بدون تخزين المحتوى على الخادم).
//  • توليد PDF عبر Browser Run.
//  • لوحة تحكم المدير على /admin
//
// الملفات الثابتة (الواجهة) تُدمج في dist/worker.js بواسطة tools/build.mjs.

import { DurableObject } from 'cloudflare:workers';

// الملفات الثابتة (BUILD و ASSETS) يولّدها tools/build.mjs مكان السطر التالي.
/*__ASSETS__*/

const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 86400_000;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const DEVICE_COOKIE = 'mv_dev';
const ADMIN_COOKIE = 'mv_adm';
const TZ_OFFSET = 3 * HOUR; // بغداد، لتجميع الإحصائيات اليومية
/** بداية اليوم الحالي بتوقيت بغداد: الساعات اليومية وملفات PDF اليومية تتجدد منتصف الليل، لا بعد 24 ساعة من الاستعمال */
const dayStart = (now = Date.now()) => Math.floor((now + TZ_OFFSET) / DAY) * DAY - TZ_OFFSET;

// الرابط الرئيسي للموقع. أي رابط ثاني يوصل لنفس العامل (workers.dev، رابط Pages، دومين قديم) ينقل زائره إليه ومعه
// تسجيل دخوله وكل ما حفظه متصفحه على ذاك الرابط (public/move.js): المتصفح يفصل تخزين كل رابط عن غيره، فبدون النقل
// يطلب الرابط الثاني الكود من جديد وتبدو المحاضرات محذوفة. التشغيل المحلي يحدده بالمتغير MV_HOME.
const HOME = 'https://medivoice.pages.dev';
const homeUrl = (env) => new URL(env?.MV_HOME || HOME);
// كل الروابط التي استُعمل عليها الموقع. أول فتح للرابط الرئيسي من متصفح يمر عليها بسرعة (تحويل واحد لكل رابط، مرة
// واحدة لكل متصفح) فيسحب منها تسجيل دخوله ومحاضراته تلقائياً، حتى لو ما فتح الرابط القديم بنفسه. محلياً: MV_OLD
const OLD_ORIGINS = ['https://medivoice.nukhba-uni.workers.dev', 'https://medivoice.pages.dev'];
const PULL_COOKIE = 'mv_pull2'; // على الرئيسي: الروابط القديمة التي سُحب منها هذا المتصفح (تغيير الاسم يعيد السحب للكل مرة)
const MOVE_CHUNK = 1024 * 1024; // قطعة نقل واحدة (حد SQLite للقيمة الواحدة 2 ميغا)
const MOVE_MAX = 600 * 1024 * 1024; // أقصى حجم لنقلة واحدة
const MOVE_TOKEN = /^[\w-]{20,80}$/;

const DEFAULT_SETTINGS = {
  support: { label: '', url: '' },
  notice: '',
  defaultDailyHours: 8, // 0 = بلا حد
  pdfPerDay: 20,
  moveLimit: 2, // كم مرة بالشهر يُسمح بنقل التفعيل لمتصفح آخر على نفس الجهاز (0 = ممنوع)
  chunkSec: 480, // 8 دقائق: أقصر من 10 حتى لا ينزلق الاستماع إلى حلقات تكرار، والمسودات متوازية فلا يبطئ
  overlapSec: 3,
  // أقوى النماذج المجانية أولاً؛ عند نفاد حصة نموذج ينتقل للذي بعده
  sttModels: ['whisper-large-v3', 'whisper-large-v3-turbo'],
  geminiModels: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
  transcribeModels: ['gemini-3.5-transcribe'],
  groqModels: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
};

// ───────────────────────── التصميم (من لوحة التحكم) ─────────────────────────
// DEFAULT_THEME و cleanTheme و themeCss من public/theme-core.js، يضمّنها tools/build.mjs هنا حرفياً
// (نفس الملف تستورده لوحة التحكم للمعاينة، فما يراه المسؤول هو ما يُحفظ)
/*__THEME__*/

const enc = new TextEncoder();
const dec = new TextDecoder();

/** ساعات يومية (من لوحة التحكم) إلى ثوانٍ: 0 = بلا حد، وغيرها بين ربع ساعة و 24 ساعة. */
function hoursToLimit(hours) {
  if (isUnlimited(hours)) return 0;
  return Math.round(Math.min(Math.max(Number(hours) || 8, 0.25), 24) * 3600);
}
/** «بلا حد» فقط إذا أُرسل صفر صريح (حقل فارغ أو قيمة غريبة لا تفتح الحد بالغلط). */
const isUnlimited = (hours) => hours === 0 || hours === '0';

// ───────────────────────── أدوات عامة ─────────────────────────

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setCookie(name, value, { maxAge, sameSite = 'Lax' } = {}) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}` + (maxAge !== undefined ? `; Max-Age=${maxAge}` : '');
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function normalizeCode(input) {
  let s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 10 && s.startsWith('MV')) s = s.slice(2);
  return s;
}
const displayCode = (c) => `MV-${c.slice(0, 4)}-${c.slice(4)}`;

function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of r) s += CODE_ALPHABET[b % 32];
  return s;
}

function parseUA(ua = '') {
  let os = 'other', browser = 'other';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'Chrome';
  else if (/FxiOS|Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return { os, browser };
}

function clientMeta(request, fp = {}) {
  const ua = request.headers.get('user-agent') || '';
  const parsed = parseUA(ua);
  const osOk = ['iOS', 'Android', 'Windows', 'macOS', 'Linux', 'ChromeOS'].includes(fp.os);
  return {
    ua: ua.slice(0, 300),
    os: osOk ? fp.os : parsed.os,
    browser: parsed.browser,
    screen: typeof fp.scr === 'string' ? fp.scr.slice(0, 24) : '',
    ip: request.headers.get('cf-connecting-ip') || '',
    country: request.cf?.country || '',
    city: request.cf?.city || '',
  };
}

// ───────────────────────── Durable Object ─────────────────────────

export class MediVoiceStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS codes (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        max_devices INTEGER NOT NULL DEFAULT 1,
        daily_limit_sec INTEGER NOT NULL DEFAULT 28800,
        duration_days INTEGER,
        created_at INTEGER NOT NULL,
        activated_at INTEGER,
        expires_at INTEGER,
        groq_enc TEXT, groq_hint TEXT,
        gemini_enc TEXT, gemini_hint TEXT,
        total_sec REAL NOT NULL DEFAULT 0,
        lectures INTEGER NOT NULL DEFAULT 0,
        pdfs INTEGER NOT NULL DEFAULT 0,
        last_active INTEGER
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        os TEXT, browser TEXT, screen TEXT, ua TEXT,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        ip TEXT, country TEXT, city TEXT
      );
      CREATE INDEX IF NOT EXISTS devices_code ON devices(code);
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, sec REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS usage_code_ts ON usage(code, ts);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, type TEXT NOT NULL, code TEXT, ip TEXT, country TEXT, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_key ON attempts(key, ts);
      CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, exp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS key_health (code TEXT NOT NULL, k TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (code, k));
      CREATE TABLE IF NOT EXISTS moves (token TEXT PRIMARY KEY, secret TEXT, ip TEXT, created INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0, claimed INTEGER, done INTEGER);
      CREATE TABLE IF NOT EXISTS move_parts (token TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (token, n));
    `);
    // ثوانٍ قيد الحساب: مقاطع أُذن بها ولم يصل خبر اكتمالها بعد (حتى لا يتجاوز الحد اليومي بمقاطع متوازية)
    this.pending = new Map();
  }

  // ── أدوات داخلية ──

  #row(query, ...args) {
    const rows = this.sql.exec(query, ...args).toArray();
    return rows[0] || null;
  }
  #all(query, ...args) {
    return this.sql.exec(query, ...args).toArray();
  }
  #setting(key, fallback = null) {
    const r = this.#row('SELECT value FROM settings WHERE key = ?', key);
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch { return fallback; }
  }
  #putSetting(key, value) {
    this.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }
  #config() {
    const c = { ...DEFAULT_SETTINGS, ...(this.#setting('config', {}) || {}) };
    c.theme = cleanTheme(c.theme);
    return c;
  }
  #event(type, { code = null, ip = '', country = '', detail = '' } = {}) {
    this.sql.exec('INSERT INTO events (ts, type, code, ip, country, detail) VALUES (?, ?, ?, ?, ?, ?)', Date.now(), type, code, ip, country, String(detail).slice(0, 300));
  }
  // يحسب المحاولات ضمن نافذة زمنية. يرجع true إذا مسموح.
  #allow(key, windowMs, max) {
    const since = Date.now() - windowMs;
    const r = this.#row('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND ts > ?', key, since);
    return (r?.n || 0) < max;
  }
  #hit(key) {
    this.sql.exec('INSERT INTO attempts (key, ts) VALUES (?, ?)', key, Date.now());
  }
  async #ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
  async alarm() {
    const now = Date.now();
    this.sql.exec('DELETE FROM usage WHERE ts < ?', now - 60 * DAY);
    this.sql.exec("DELETE FROM attempts WHERE (ts < ? AND key NOT LIKE 'mv:%') OR ts < ?", now - DAY, now - 31 * DAY);
    this.sql.exec('DELETE FROM admin_sessions WHERE exp < ?', now);
    this.sql.exec('DELETE FROM key_health WHERE until < ?', now);
    this.sql.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 3000)');
    // نقلات قديمة: بياناتها تُحذف بعد يوم، وسجلها (هل وصلت؟) بعد شهر
    this.sql.exec('DELETE FROM move_parts WHERE token IN (SELECT token FROM moves WHERE created < ? OR done IS NOT NULL)', now - DAY);
    this.sql.exec('UPDATE moves SET secret = NULL WHERE created < ?', now - DAY);
    this.sql.exec('DELETE FROM moves WHERE created < ?', now - 31 * DAY);
    await this.ctx.storage.setAlarm(now + DAY);
  }

  async #aesKey() {
    if (!this.env.KEYS_SECRET) throw new Error('KEYS_SECRET is not configured');
    if (!this._aes) {
      const raw = await crypto.subtle.digest('SHA-256', enc.encode(this.env.KEYS_SECRET));
      this._aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    return this._aes;
  }
  async #seal(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.#aesKey(), enc.encode(text));
    return b64u(iv) + '.' + b64u(ct);
  }
  async #open(sealed) {
    if (!sealed) return null;
    try {
      const [iv, ct] = sealed.split('.');
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await this.#aesKey(), unb64u(ct));
      return dec.decode(pt);
    } catch {
      return null;
    }
  }

  /** ثواني الصوت المحوّلة اليوم (من منتصف الليل بتوقيت بغداد) */
  #usedToday(code) {
    const r = this.#row("SELECT COALESCE(SUM(sec), 0) AS s FROM usage WHERE code = ? AND kind = 'audio' AND ts >= ?", code, dayStart());
    return r?.s || 0;
  }
  /** الثواني المأذون بها لهذا الكود ولم تُسجَّل بعد (طلبات صوت جارية). ما مضى عليه 10 دقائق يُعدّ منتهياً */
  #pendingSec(code) {
    const old = Date.now() - 10 * MIN;
    let sum = 0;
    for (const [req, p] of this.pending) {
      if (p.at < old) { this.pending.delete(req); continue; }
      if (p.code === code) sum += p.sec;
    }
    return sum;
  }

  // يتحقق من الجهاز والكود. يرجع { ok, dev, code } أو { ok:false, reason }
  #check(deviceId) {
    if (!deviceId) return { ok: false, reason: 'none' };
    const dev = this.#row('SELECT * FROM devices WHERE id = ?', deviceId);
    if (!dev) return { ok: false, reason: 'none' };
    const code = this.#row('SELECT * FROM codes WHERE code = ?', dev.code);
    if (!code) {
      this.sql.exec('DELETE FROM devices WHERE id = ?', deviceId);
      return { ok: false, reason: 'none' };
    }
    if (code.status !== 'active') return { ok: false, reason: 'suspended' };
    if (code.expires_at && Date.now() > code.expires_at) return { ok: false, reason: 'expired' };
    return { ok: true, dev, code };
  }

  #publicInfo() {
    const cfg = this.#config();
    return { support: cfg.support, build: BUILD };
  }

  /** التصميم الحالي (منظَّف) لتضمينه في الصفحات */
  theme() { return cleanTheme(this.#config().theme); }

  #sessionPayload(code) {
    const cfg = this.#config();
    return {
      active: true,
      build: BUILD,
      support: cfg.support,
      notice: cfg.notice || '',
      user: { label: code.label, code: displayCode(code.code), expires_at: code.expires_at || null },
      keys: {
        groq: { linked: !!code.groq_enc, hint: code.groq_hint || '', count: keyCount(code.groq_hint) },
        gemini: { linked: !!code.gemini_enc, hint: code.gemini_hint || '', count: keyCount(code.gemini_hint) },
      },
      usage: {
        used_sec: Math.round(this.#usedToday(code.code)),
        limit_sec: code.daily_limit_sec,
        total_sec: Math.round(code.total_sec),
        lectures: code.lectures,
      },
      config: {
        chunkSec: cfg.chunkSec, overlapSec: cfg.overlapSec,
        sttModels: cfg.sttModels, geminiModels: cfg.geminiModels, groqModels: cfg.groqModels, transcribeModels: cfg.transcribeModels || [],
      },
    };
  }

  // ── النقل من رابط قديم للرابط الرئيسي (public/move.js) ──

  /** الرابط القديم يبدأ النقل: رمز لمرة واحدة، ومعه سر جهازه مشفّراً إذا كان مفعّلاً، حتى يدخل الرابط الرئيسي بلا كود */
  async moveStart(deviceId, secret, ip, info = {}) {
    await this.#ensureAlarm();
    const key = `move:${ip || 'x'}`;
    if (!this.#allow(key, HOUR, 30)) return { ok: false, status: 429, error: 'too_many' };
    this.#hit(key);
    const token = randomToken(24);
    const c = deviceId ? this.#check(deviceId) : { ok: false };
    const live = c.ok && /^[\w-]{30,80}$/.test(secret || '');
    this.sql.exec('INSERT INTO moves (token, secret, ip, created) VALUES (?, ?, ?, ?)', token, live ? await this.#seal(secret) : null, ip || '', Date.now());
    // للتشخيص (لا يظهر في نشاط اللوحة): ماذا وجد المتصفح على الرابط القديم
    const n = (v) => Math.max(0, Math.min(1e9, Math.round(Number(v) || 0)));
    const detail = [`${n(info.n)} محاضرة`, `${(n(info.b) / 1048576).toFixed(1)} ميغا`, info.pull ? 'سحب تلقائي' : 'فتح الرابط القديم',
      deviceId ? (live ? 'مفعّل' : 'تفعيل منتهي') : 'بلا تفعيل', info.err ? `خطأ: ${String(info.err).slice(0, 80)}` : ''].filter(Boolean).join(' · ');
    this.#event('move_start', { code: c.ok ? c.code.code : null, ip, detail });
    return { ok: true, token, session: live };
  }
  #move(token, maxAge) {
    if (typeof token !== 'string' || !MOVE_TOKEN.test(token)) return null;
    const m = this.#row('SELECT * FROM moves WHERE token = ?', token);
    return m && !m.done && Date.now() - m.created < maxAge ? m : null;
  }
  /** قطعة من بيانات المتصفح (حتى 1 ميغا). تُقبل قبل الاستلام فقط */
  movePut(token, n, data) {
    const m = this.#move(token, 6 * HOUR);
    if (!m || m.claimed) return { ok: false, status: 404, error: 'gone' };
    const size = data?.byteLength ?? -1;
    if (!Number.isInteger(n) || n < 0 || n >= MOVE_MAX / MOVE_CHUNK || size < 1 || size > MOVE_CHUNK) return { ok: false, status: 400, error: 'bad_request' };
    const old = this.#row('SELECT LENGTH(data) AS s FROM move_parts WHERE token = ? AND n = ?', token, n)?.s || 0;
    if (m.size - old + size > MOVE_MAX) return { ok: false, status: 413, error: 'too_large' };
    this.sql.exec('INSERT OR REPLACE INTO move_parts (token, n, data) VALUES (?, ?, ?)', token, n, data);
    this.sql.exec('UPDATE moves SET size = ? WHERE token = ?', m.size - old + size, token);
    return { ok: true };
  }
  /**
   * الرابط الرئيسي يستلم: عدد القطع وحجمها، وسر الجهاز إذا هذا المتصفح ما عنده تفعيل صالح هنا (تفعيل موجود لا
   * يُستبدل). السر يُعطى خلال 10 دقائق من أول استلام فقط، حتى يتحمل إعادة الطلب إذا ضاع الرد.
   */
  async moveClaim(token, deviceId) {
    const m = this.#move(token, DAY);
    if (!m) return { ok: false, status: 404, error: 'gone' };
    const now = Date.now();
    const parts = this.#row('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS s FROM move_parts WHERE token = ?', token);
    let secret = null;
    if (m.secret && (!m.claimed || now - m.claimed < 10 * MIN) && !(deviceId && this.#check(deviceId).ok)) secret = await this.#open(m.secret);
    if (!m.claimed) this.sql.exec('UPDATE moves SET claimed = ? WHERE token = ?', now, token);
    return { ok: true, parts: parts.n, size: parts.s, secret };
  }
  moveGet(token, n) {
    const m = this.#move(token, DAY);
    if (!m || !m.claimed || !Number.isInteger(n)) return null;
    return this.#row('SELECT data FROM move_parts WHERE token = ? AND n = ?', token, n)?.data ?? null;
  }
  /** وصلت: تُحذف البيانات والسر، ويبقى السجل حتى يعرف الرابط القديم أن نقلته اكتملت */
  moveDone(token) {
    if (!this.#move(token, DAY)) return { ok: true };
    this.sql.exec('DELETE FROM move_parts WHERE token = ?', token);
    this.sql.exec('UPDATE moves SET done = ?, secret = NULL WHERE token = ?', Date.now(), token);
    return { ok: true };
  }
  moveStatus(token) {
    if (typeof token !== 'string' || !MOVE_TOKEN.test(token)) return { done: false };
    return { done: !!this.#row('SELECT done FROM moves WHERE token = ?', token)?.done };
  }

  // ── واجهة المستخدم ──

  isActive(deviceId) {
    return this.#check(deviceId).ok;
  }

  session(deviceId, meta) {
    const c = this.#check(deviceId);
    if (!c.ok) return { active: false, reason: c.reason, ...this.#publicInfo() };
    const { dev, code } = c;
    if (meta.os && dev.os && meta.os !== 'other' && dev.os !== 'other' && meta.os !== dev.os) {
      if (this.#allow(`mm:${deviceId}`, HOUR, 1)) {
        this.#hit(`mm:${deviceId}`);
        this.#event('device_mismatch', { code: code.code, ip: meta.ip, country: meta.country, detail: `${dev.os} → ${meta.os}` });
      }
      return { active: false, reason: 'device_mismatch', ...this.#publicInfo() };
    }
    const now = Date.now();
    if (now - dev.last_seen > 5 * MIN || dev.ip !== meta.ip) {
      if (meta.screen && dev.screen && meta.screen !== dev.screen) {
        this.#event('screen_changed', { code: code.code, ip: meta.ip, country: meta.country, detail: `${dev.screen} → ${meta.screen}` });
      }
      this.sql.exec('UPDATE devices SET last_seen = ?, ip = ?, country = ?, city = ?, browser = ?, ua = ?, screen = ? WHERE id = ?',
        now, meta.ip, meta.country, meta.city, meta.browser, meta.ua, meta.screen || dev.screen, deviceId);
    }
    return this.#sessionPayload(code);
  }

  /**
   * تسجيل خروج الزبون: الكوكي يُمسح من متصفحه، وسجل جهازه يبقى محجوزاً لنفس الهاتف (علامة out:) حتى ما يصير الكود
   * قابلاً للمشاركة بالخروج والدخول من هاتف ثاني. رجوعه بالكود على نفس الهاتف يحل محل هذه العلامة بلا ما يُحسب نقلاً.
   */
  logout(deviceId, meta = {}) {
    const dev = deviceId ? this.#row('SELECT * FROM devices WHERE id = ?', deviceId) : null;
    if (!dev) return { ok: true };
    this.sql.exec('UPDATE devices SET id = ? WHERE id = ?', `out:${randomToken(12)}`, deviceId);
    this.#event('logout', { code: dev.code, ip: meta.ip, country: meta.country, detail: `${dev.os} · ${dev.browser}` });
    return { ok: true };
  }

  async activate(deviceId, rawCode, meta) {
    await this.#ensureAlarm();
    const ipKey = `act:${meta.ip || 'x'}`;
    // شبكة واحدة لعشرات الطلاب (واي فاي الكلية): الحد يمنع التخمين الآلي فقط، لا الأخطاء المطبعية لصف كامل
    if (!this.#allow(ipKey, 15 * MIN, 25)) return { ok: false, error: 'too_many', status: 429 };
    const codeStr = normalizeCode(rawCode);
    const code = codeStr.length === 8 ? this.#row('SELECT * FROM codes WHERE code = ?', codeStr) : null;
    if (!code) {
      this.#hit(ipKey);
      this.#event('activate_failed', { ip: meta.ip, country: meta.country, detail: 'invalid' });
      return { ok: false, error: 'invalid', status: 404 };
    }
    if (code.status !== 'active') return { ok: false, error: 'suspended', status: 403 };
    if (code.expires_at && Date.now() > code.expires_at) return { ok: false, error: 'expired', status: 403 };

    const now = Date.now();
    const mine = this.#row('SELECT * FROM devices WHERE id = ?', deviceId);
    if (mine && mine.code === codeStr) return { ok: true, session: this.#sessionPayload(code) }; // نفس الجهاز

    // نفس الهاتف رجع بعد تسجيل خروج: مكانه المحجوز يرجع له (ولا يتكرر سجله ولا يُحسب نقلاً)
    if (meta.os !== 'other' && meta.screen) {
      this.sql.exec("DELETE FROM devices WHERE code = ? AND os = ? AND screen = ? AND id LIKE 'out:%'", codeStr, meta.os, meta.screen);
    }
    const used = this.#row('SELECT COUNT(*) AS n FROM devices WHERE code = ?', codeStr).n;
    if (used >= code.max_devices) {
      // نفس الجهاز من متصفح آخر (فتح الرابط داخل تيليكرام ثم Chrome، أو تثبيته كتطبيق): ننقل التفعيل
      // بدل الرفض ويُلغى من المتصفح القديم. العدد محدود حتى لا يصير باباً لمشاركة الكود بين
      // جهازين من نفس الموديل.
      const limit = this.#config().moveLimit;
      const twin = limit > 0 && meta.os !== 'other' && meta.screen
        ? this.#row('SELECT id, browser FROM devices WHERE code = ? AND os = ? AND screen = ? ORDER BY last_seen LIMIT 1', codeStr, meta.os, meta.screen)
        : null;
      const moveKey = `mv:${codeStr}`;
      if (!twin || !this.#allow(moveKey, 30 * DAY, limit)) {
        this.#hit(ipKey);
        this.#event('activate_blocked', { code: codeStr, ip: meta.ip, country: meta.country, detail: `${meta.os} · ${meta.browser}` });
        return { ok: false, error: 'in_use', status: 409 };
      }
      this.#hit(moveKey);
      this.sql.exec('DELETE FROM devices WHERE id = ?', twin.id);
      this.#event('device_moved', { code: codeStr, ip: meta.ip, country: meta.country, detail: `${twin.browser} → ${meta.browser}` });
    }
    // الجهاز يحمل كوداً واحداً فقط
    if (mine) this.sql.exec('DELETE FROM devices WHERE id = ?', deviceId);
    this.sql.exec('INSERT INTO devices (id, code, os, browser, screen, ua, first_seen, last_seen, ip, country, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      deviceId, codeStr, meta.os, meta.browser, meta.screen, meta.ua, now, now, meta.ip, meta.country, meta.city);
    let expires = code.expires_at;
    if (!code.activated_at) {
      if (code.duration_days) expires = now + code.duration_days * DAY;
      this.sql.exec('UPDATE codes SET activated_at = ?, expires_at = ? WHERE code = ?', now, expires, codeStr);
    }
    this.#event('activated', { code: codeStr, ip: meta.ip, country: meta.country, detail: `${meta.os} · ${meta.browser}` });
    return { ok: true, session: this.#sessionPayload(this.#row('SELECT * FROM codes WHERE code = ?', codeStr)) };
  }

  // قبل كل طلب بروكسي: يتأكد من الصلاحية والحد اليومي ويرجع مفاتيح المستخدم
  async authorize(deviceId, { kind, sec = 0, req = '' } = {}) {
    const c = this.#check(deviceId);
    if (!c.ok) return { ok: false, status: 401, error: c.reason === 'none' ? 'locked' : c.reason };
    const code = c.code;
    if (sec > 0 && code.daily_limit_sec > 0) { // 0 = بلا حد يومي
      // طلب أُعيد (رده ضاع) لا يُحجز له مرة ثانية
      const used = this.#usedToday(code.code) + (req && this.pending.has(req) ? 0 : this.#pendingSec(code.code));
      if (used + sec > code.daily_limit_sec + 30) {
        // الرصيد يرجع كاملاً منتصف الليل بتوقيت بغداد
        const retry = Math.max(60, Math.ceil((dayStart() + DAY - Date.now()) / 1000));
        return { ok: false, status: 429, error: 'daily_limit', retry_after: retry, used_sec: Math.round(used), limit_sec: code.daily_limit_sec };
      }
      if (req) this.pending.set(req, { code: code.code, sec, at: Date.now() });
    }
    const out = { ok: true, code: code.code };
    if (kind === 'groq' || kind === 'gemini' || kind === 'both') {
      // ما تعلّمه الخادم عن مفاتيح هذا الكود (حصة نفدت، مفتاح ملغى) يبقى هنا لا في ذاكرة خادم واحد
      out.health = this.#all('SELECT k, until FROM key_health WHERE code = ? AND until > ?', code.code, Date.now()).map((r) => [r.k, r.until]);
    }
    if (kind === 'pdf') {
      const cfg = this.#config();
      const today = this.#row("SELECT COUNT(*) AS n FROM usage WHERE code = ? AND kind = 'pdf' AND ts >= ?", code.code, dayStart()).n;
      if (today >= cfg.pdfPerDay) return { ok: false, status: 429, error: 'pdf_limit' };
      // Browser Run المجاني: طلب واحد كل 10 ثوانٍ للحساب كله
      const last = this.#setting('pdf_next', 0);
      const now = Date.now();
      const slot = Math.max(now, last);
      this.#putSetting('pdf_next', slot + 10_500);
      out.wait_ms = slot - now;
      if (out.wait_ms > 90_000) return { ok: false, status: 429, error: 'pdf_busy' };
      return out;
    }
    if (kind === 'groq' || kind === 'both') {
      out.groqKeys = parseKeys(await this.#open(code.groq_enc));
      out.groq = out.groqKeys[0] || null;
    }
    if (kind === 'gemini' || kind === 'both') {
      out.geminiKeys = parseKeys(await this.#open(code.gemini_enc));
      out.gemini = out.geminiKeys[0] || null;
    }
    return out;
  }

  logUsage(code, kind, sec = 0, req = '') {
    // طلب أُعيد بعد ضياع رده (الطالب طلع من الموقع أثناءه): ثوانيه حُسبت مرة، فلا تُحسب ثانية
    if (req) {
      this.pending.delete(req);
      this.seenReq ??= new Map();
      if (this.seenReq.has(req)) return;
      this.seenReq.set(req, Date.now());
      // الأقدم أولاً (ترتيب الإدراج): الحجم محدود مهما كثر الطلاب
      if (this.seenReq.size > 5000) for (const k of this.seenReq.keys()) { if (this.seenReq.size <= 4000) break; this.seenReq.delete(k); }
    }
    const now = Date.now();
    this.sql.exec('INSERT INTO usage (code, ts, kind, sec) VALUES (?, ?, ?, ?)', code, now, kind, sec);
    if (kind === 'audio') this.sql.exec('UPDATE codes SET total_sec = total_sec + ?, last_active = ? WHERE code = ?', sec, now, code);
    else if (kind === 'pdf') this.sql.exec('UPDATE codes SET pdfs = pdfs + 1, last_active = ? WHERE code = ?', now, code);
    else if (kind === 'lecture') this.sql.exec('UPDATE codes SET lectures = lectures + 1, last_active = ? WHERE code = ?', now, code);
  }

  /** خطأ غير متوقع أثناء تحويل عند الطالب: يُسجَّل للتشخيص (لا يظهر في سجل النشاط)، 12 بالساعة لكل كود */
  clientError(code, detail) {
    if (!this.#allow(`diag:${code}`, 3600_000, 12)) return;
    this.#event('client_error', { code, detail });
  }

  /** طلب صوت فشل عند المزوّد: ثوانيه المحجوزة تُحرَّر فوراً */
  release(req) { if (req) this.pending.delete(req); }

  /** يتذكّر حالة مفتاح+نموذج (حصة نفدت أو مفتاح ملغى) حتى موعدها، لكل خوادم Cloudflare */
  noteKey(code, k, until) {
    this.sql.exec('INSERT INTO key_health (code, k, until) VALUES (?, ?, ?) ON CONFLICT(code, k) DO UPDATE SET until = MAX(until, excluded.until)', code, String(k).slice(0, 120), until);
  }

  /**
   * يحفظ مفتاحاً. Gemini يقبل عدة مفاتيح (من حسابات Google مختلفة) تُخزَّن معاً كقائمة JSON مشفرة؛
   * add=true يضيف إلى الموجود بدل استبداله. الحصة اليومية المجانية لكل مفتاح مستقلة، فالخادم يتنقل بينها.
   */
  async setKey(deviceId, provider, keys, opts = {}) {
    // التشفير ينتظر (والانتظار لا يمنع طلباً متزامناً): إضافتان في وقت واحد تُنفَّذان واحدة بعد الأخرى
    const prev = this.keyLock || Promise.resolve();
    let done;
    this.keyLock = new Promise((r) => { done = r; });
    try { await prev; return await this.#setKey(deviceId, provider, keys, opts); } finally { done(); }
  }
  async #setKey(deviceId, provider, keys, { add = false } = {}) {
    const c = this.#check(deviceId);
    if (!c.ok) return { ok: false, status: 401, error: 'locked' };
    const list = Array.isArray(keys) ? keys : [keys];
    const hintOf = (k) => k.slice(0, 4) + '…' + k.slice(-4);
    const col = provider === 'groq' ? 'groq' : 'gemini';
    // عدة مفاتيح من حسابات مختلفة: لكل حساب حصته اليومية، والخادم يتنقل بينها
    const current = add ? parseKeys(await this.#open(c.code[`${col}_enc`])) : [];
    const all = [...new Set([...current, ...list])];
    if (all.length > MAX_GEMINI_KEYS) return { ok: false, status: 400, error: 'too_many_keys' };
    this.sql.exec(`UPDATE codes SET ${col}_enc = ?, ${col}_hint = ? WHERE code = ?`, await this.#seal(JSON.stringify(all)), all.map(hintOf).join(' · '), c.code.code);
    this.sql.exec('DELETE FROM key_health WHERE code = ?', c.code.code);
    this.#event('key_linked', { code: c.code.code, detail: provider });
    return { ok: true, session: this.#sessionPayload(this.#row('SELECT * FROM codes WHERE code = ?', c.code.code)) };
  }

  removeKey(deviceId, provider) {
    const c = this.#check(deviceId);
    if (!c.ok) return { ok: false, status: 401, error: 'locked' };
    if (provider === 'groq') this.sql.exec('UPDATE codes SET groq_enc = NULL, groq_hint = NULL WHERE code = ?', c.code.code);
    else this.sql.exec('UPDATE codes SET gemini_enc = NULL, gemini_hint = NULL WHERE code = ?', c.code.code);
    this.sql.exec('DELETE FROM key_health WHERE code = ?', c.code.code);
    return { ok: true, session: this.#sessionPayload(this.#row('SELECT * FROM codes WHERE code = ?', c.code.code)) };
  }

  // ── المدير ──

  async #hashPassword(password, salt) {
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(salt), iterations: 60000 }, key, 256);
    return b64u(bits);
  }
  async #checkPassword(password) {
    const stored = this.#setting('admin_pw');
    if (stored?.hash) return timingSafeEqual(await this.#hashPassword(password, stored.salt), stored.hash);
    const initial = this.env.ADMIN_PASSWORD;
    return !!initial && timingSafeEqual(password, initial);
  }

  async adminLogin(password, ip) {
    await this.#ensureAlarm();
    const key = `adm:${ip || 'x'}`;
    if (!this.#allow(key, 15 * MIN, 6)) return { ok: false, status: 429, error: 'too_many' };
    if (typeof password !== 'string' || !(await this.#checkPassword(password))) {
      this.#hit(key);
      this.#event('admin_login_failed', { ip });
      return { ok: false, status: 401, error: 'wrong_password' };
    }
    const token = randomToken();
    this.sql.exec('INSERT INTO admin_sessions (id, exp) VALUES (?, ?)', await sha256hex(token), Date.now() + 12 * HOUR);
    this.#event('admin_login', { ip });
    return { ok: true, token };
  }

  async #admin(token) {
    if (!token) return false;
    const r = this.#row('SELECT exp FROM admin_sessions WHERE id = ?', await sha256hex(token));
    return !!r && r.exp > Date.now();
  }

  async adminLogout(token) {
    if (token) this.sql.exec('DELETE FROM admin_sessions WHERE id = ?', await sha256hex(token));
    return { ok: true };
  }

  async adminOverview(token) {
    if (!(await this.#admin(token))) return { ok: false, status: 401, error: 'unauthorized' };
    const now = Date.now();
    const codes = this.#all(`
      SELECT c.code, c.label, c.note, c.status, c.max_devices, c.daily_limit_sec, c.duration_days, c.created_at, c.activated_at,
             c.expires_at, c.groq_hint, c.gemini_hint, c.total_sec, c.lectures, c.pdfs, c.last_active,
             (SELECT COALESCE(SUM(sec), 0) FROM usage u WHERE u.code = c.code AND u.kind = 'audio' AND u.ts >= ?) AS used_sec
      FROM codes c ORDER BY c.created_at DESC`, dayStart(now));
    const devices = this.#all('SELECT id, code, os, browser, screen, first_seen, last_seen, ip, country, city FROM devices');
    const byCode = {};
    for (const d of devices) (byCode[d.code] ||= []).push({ id: d.id.slice(0, 10), out: d.id.startsWith('out:'), os: d.os, browser: d.browser, screen: d.screen, first_seen: d.first_seen, last_seen: d.last_seen, country: d.country, city: d.city });
    const list = codes.map((c) => ({
      ...c,
      display: displayCode(c.code),
      groq: keyCount(c.groq_hint), gemini: keyCount(c.gemini_hint), // عدد المفاتيح المربوطة (0 = لا شيء)
      expired: !!(c.expires_at && now > c.expires_at),
      devices: byCode[c.code] || [],
    }));
    for (const c of list) { delete c.groq_hint; delete c.gemini_hint; }
    const days = this.#all(`
      SELECT CAST((ts + ?) / ? AS INTEGER) AS day,
             SUM(CASE WHEN kind = 'audio' THEN sec ELSE 0 END) AS sec,
             SUM(CASE WHEN kind = 'lecture' THEN 1 ELSE 0 END) AS lectures,
             SUM(CASE WHEN kind = 'pdf' THEN 1 ELSE 0 END) AS pdfs,
             COUNT(DISTINCT code) AS users
      FROM usage WHERE ts > ? GROUP BY day ORDER BY day`, TZ_OFFSET, DAY, now - 14 * DAY);
    const totals = this.#row(`
      SELECT COUNT(*) AS codes,
             SUM(CASE WHEN activated_at IS NOT NULL THEN 1 ELSE 0 END) AS activated,
             SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) AS suspended,
             COALESCE(SUM(total_sec), 0) AS total_sec, COALESCE(SUM(lectures), 0) AS lectures, COALESCE(SUM(pdfs), 0) AS pdfs
      FROM codes`);
    const today = this.#row("SELECT COALESCE(SUM(CASE WHEN kind = 'audio' THEN sec ELSE 0 END), 0) AS sec, COUNT(DISTINCT code) AS users FROM usage WHERE ts >= ?", dayStart(now));
    const events = this.#all('SELECT ts, type, code, ip, country, detail FROM events ORDER BY id DESC LIMIT 80')
      .map((e) => ({ ...e, code: e.code ? displayCode(e.code) : null }));
    return {
      ok: true, now, build: BUILD,
      totals: { ...totals, today_sec: today.sec, today_users: today.users },
      days: days.map((d) => ({ ...d, date: d.day * DAY - TZ_OFFSET })),
      codes: list, events,
      settings: this.#config(),
      password_changed: !!this.#setting('admin_pw'),
      // تشخيص النقل بين الروابط (لا يظهر في اللوحة)
      moves: this.#all('SELECT created, size, claimed, done, ip FROM moves ORDER BY created DESC LIMIT 40'),
    };
  }

  async adminCreateCodes(token, { count = 1, label = '', note = '', days = null, max_devices = 1, daily_hours = null } = {}) {
    if (!(await this.#admin(token))) return { ok: false, status: 401, error: 'unauthorized' };
    const cfg = this.#config();
    const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 200);
    const limit = hoursToLimit(daily_hours === null || daily_hours === undefined || daily_hours === '' ? cfg.defaultDailyHours : daily_hours);
    const dur = days ? Math.min(Math.max(parseInt(days, 10) || 0, 1), 3650) : null;
    const maxDev = Math.min(Math.max(parseInt(max_devices, 10) || 1, 1), 10);
    const created = [];
    for (let i = 0; i < n; i++) {
      let code;
      do { code = newCode(); } while (this.#row('SELECT 1 AS x FROM codes WHERE code = ?', code));
      const lbl = n > 1 && label ? `${label} ${i + 1}` : label;
      this.sql.exec('INSERT INTO codes (code, label, note, max_devices, daily_limit_sec, duration_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        code, String(lbl).slice(0, 80), String(note).slice(0, 200), maxDev, limit, dur, Date.now());
      created.push(displayCode(code));
    }
    this.#event('codes_created', { detail: `${n}` });
    return { ok: true, created };
  }

  async adminUpdateCode(token, rawCode, patch = {}) {
    if (!(await this.#admin(token))) return { ok: false, status: 401, error: 'unauthorized' };
    const code = normalizeCode(rawCode);
    const row = this.#row('SELECT * FROM codes WHERE code = ?', code);
    if (!row) return { ok: false, status: 404, error: 'not_found' };
    if (typeof patch.label === 'string') this.sql.exec('UPDATE codes SET label = ? WHERE code = ?', patch.label.slice(0, 80), code);
    if (typeof patch.note === 'string') this.sql.exec('UPDATE codes SET note = ? WHERE code = ?', patch.note.slice(0, 200), code);
    if ((patch.status === 'active' || patch.status === 'suspended') && patch.status !== row.status) {
      this.sql.exec('UPDATE codes SET status = ? WHERE code = ?', patch.status, code);
      this.#event(patch.status === 'active' ? 'code_resumed' : 'code_suspended', { code });
    }
    if (patch.max_devices !== undefined) this.sql.exec('UPDATE codes SET max_devices = ? WHERE code = ?', Math.min(Math.max(parseInt(patch.max_devices, 10) || 1, 1), 10), code);
    if (patch.daily_hours !== undefined) this.sql.exec('UPDATE codes SET daily_limit_sec = ? WHERE code = ?', hoursToLimit(patch.daily_hours), code);
    if (patch.expires_at !== undefined) {
      // null = دائم، رقم = تاريخ انتهاء بالمللي ثانية
      const v = patch.expires_at === null ? null : Number(patch.expires_at) || null;
      this.sql.exec('UPDATE codes SET expires_at = ?, duration_days = NULL WHERE code = ?', v, code);
    }
    if (patch.extend_days) {
      const base = Math.max(Date.now(), row.expires_at || 0);
      if (row.activated_at) this.sql.exec('UPDATE codes SET expires_at = ? WHERE code = ?', base + Number(patch.extend_days) * DAY, code);
      else this.sql.exec('UPDATE codes SET duration_days = COALESCE(duration_days, 0) + ? WHERE code = ?', Number(patch.extend_days), code);
    }
    return { ok: true };
  }

  async adminResetDevices(token, rawCode) {
    if (!(await this.#admin(token))) return { ok: false, status: 401, error: 'unauthorized' };
    const code = normalizeCode(rawCode);
    this.sql.exec('DELETE FROM devices WHERE code = ?', code);
    this.sql.exec('DELETE FROM attempts WHERE key = ?', `mv:${code}`);
    this.#event('devices_reset', { code });
    return { ok: true };
  }

  async adminDeleteCode(token, rawCode) {
    if (!(await this.#admin(token))) return { ok: false, status: 401, error: 'unauthorized' };
    const code = normalizeCode(rawCode);
    this.sql.exec('DELETE FROM devices WHERE code = ?', code);
    this.sql.exec('DELETE FROM usage WHERE code = ?', code);
    this.sql.exec('DELETE FROM codes WHERE code = ?', code);
    this.#event('code_deleted', { code });
    return { ok: true };
  }

  async adminSaveSettings(token, patch = {}) {
    if (!(await this.#admin(token))) return { ok: false, status: 401, error: 'unauthorized' };
    const cur = this.#setting('config', {}) || {};
    const next = { ...cur };
    const strList = (v) => Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && /^[\w./:-]{2,80}$/.test(x));
    if (patch.support && typeof patch.support === 'object') {
      const url = String(patch.support.url || '').trim().slice(0, 200);
      next.support = { label: String(patch.support.label || '').slice(0, 60), url: /^(https:\/\/|tel:|mailto:)/i.test(url) ? url : '' };
    }
    if (typeof patch.notice === 'string') next.notice = patch.notice.slice(0, 300);
    if (patch.defaultDailyHours !== undefined) next.defaultDailyHours = isUnlimited(patch.defaultDailyHours) ? 0 : Math.min(Math.max(Number(patch.defaultDailyHours) || 8, 0.25), 24);
    if (patch.pdfPerDay !== undefined) next.pdfPerDay = Math.min(Math.max(parseInt(patch.pdfPerDay, 10) || 20, 1), 500);
    if (patch.moveLimit !== undefined) next.moveLimit = Math.min(Math.max(parseInt(patch.moveLimit, 10) || 0, 0), 10);
    if (patch.chunkSec !== undefined) next.chunkSec = Math.min(Math.max(parseInt(patch.chunkSec, 10) || 360, 60), 900);
    if (patch.overlapSec !== undefined) next.overlapSec = Math.min(Math.max(Number(patch.overlapSec) || 3, 0), 10);
    for (const k of ['sttModels', 'geminiModels', 'groqModels']) if (strList(patch[k])) next[k] = patch[k].slice(0, 12);
    if (Array.isArray(patch.transcribeModels)) next.transcribeModels = strList(patch.transcribeModels) ? patch.transcribeModels.slice(0, 4) : [];
    if (patch.theme && typeof patch.theme === 'object') next.theme = cleanTheme(patch.theme);
    this.#putSetting('config', next);
    return { ok: true, settings: this.#config() };
  }

  async adminChangePassword(token, current, next) {
    if (!(await this.#admin(token))) return { ok: false, status: 401, error: 'unauthorized' };
    if (typeof next !== 'string' || next.length < 8) return { ok: false, status: 400, error: 'weak' };
    if (!(await this.#checkPassword(String(current || '')))) return { ok: false, status: 403, error: 'wrong_password' };
    const salt = randomToken(16);
    this.#putSetting('admin_pw', { salt, hash: await this.#hashPassword(next, salt) });
    const keep = await sha256hex(token);
    this.sql.exec('DELETE FROM admin_sessions WHERE id != ?', keep);
    this.#event('admin_password_changed', {});
    return { ok: true };
  }
}

// ───────────────────────── Worker ─────────────────────────

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(self)',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // الخطوط من الموقع نفسه؛ وخطوط Google تبقى مسموحة لمستند الـ PDF عند طباعته من الجهاز (إطار داخل الصفحة)
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://upload.wikimedia.org https://thumb.wikimedia.org https://api.openverse.org",
  "media-src 'self' blob:",
  "connect-src 'self' https://commons.wikimedia.org https://en.wikipedia.org https://upload.wikimedia.org https://thumb.wikimedia.org https://api.openverse.org",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function store(env) {
  return env.STORE.get(env.STORE.idFromName('main'), { locationHint: 'enam' });
}

async function deviceId(request) {
  const secret = cookies(request)[DEVICE_COOKIE];
  return secret && /^[\w-]{30,80}$/.test(secret) ? sha256hex(secret) : null;
}

/**
 * التصميم الحالي لكل صفحة HTML (يُحقن في <head>): نسخة في ذاكرة الخادم تُستعمل فوراً وتُحدَّث بالخلفية كل
 * 20 ثانية، فلا تنتظر الصفحة قاعدة البيانات إلا أول طلب على خادم جديد.
 */
let themeCache = { at: 0, css: '', tag: '', mode: 'dark', refreshing: false };
async function loadTheme(env) {
  try {
    const theme = await store(env).theme();
    const css = themeCss(theme);
    themeCache = { at: Date.now(), css, tag: (await sha256hex(css)).slice(0, 12), mode: theme.mode, refreshing: false };
  } catch {
    if (!themeCache.css) themeCache = { at: Date.now() - 15_000, css: themeCss(DEFAULT_THEME), tag: 'd', mode: DEFAULT_THEME.mode, refreshing: false };
  }
}
async function currentTheme(env, ctx) {
  if (!themeCache.css) await loadTheme(env);
  else if (Date.now() - themeCache.at > 20_000 && !themeCache.refreshing) {
    themeCache.refreshing = true;
    const job = loadTheme(env).finally(() => { themeCache.refreshing = false; });
    try { ctx.waitUntil(job); } catch { /* */ }
  }
  return themeCache;
}
const forgetTheme = () => { themeCache = { at: 0, css: '', tag: '', mode: 'dark', refreshing: false }; };

async function serveHtml(request, asset, env, ctx, { home = '', move = false, cookie = '' } = {}) {
  const th = await currentTheme(env, ctx);
  const etag = `"${BUILD}.${th.tag}${move ? '.m' : ''}"`;
  const headers = { 'content-type': asset.type, etag, 'cache-control': 'no-cache', ...SECURITY_HEADERS, 'content-security-policy': CSP };
  if (cookie) headers['set-cookie'] = cookie;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  // الوضع النهاري هو الأصل: يُكتب على <html> من الخادم حتى لا تومض الصفحة بالداكن قبل تشغيل السكربت
  // mv-home: الرابط الرئيسي (رسالة التفعيل في لوحة التحكم). mv-move: هذا رابط ثاني، فالصفحة تنقل زائرها للرئيسي
  const metas = (home ? `<meta name="mv-home" content="${home}">` : '') + (move ? `<meta name="mv-move" content="${home}">` : '');
  let html = asset.body.replace('</head>', () => `${metas}<style id="mv-theme">${th.css}</style>\n</head>`);
  if (th.mode === 'light') html = html.replace(/<html\b/, '<html data-theme="light"');
  return new Response(html, { headers });
}

const bounce = (location, cookie = '') => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) } });

/** الروابط القديمة (ما عدا الرئيسي)، بأسماء مضيفيها */
function oldHosts(env, home) {
  const list = env?.MV_OLD !== undefined ? String(env.MV_OLD).split(',') : OLD_ORIGINS;
  return list.map((o) => o.trim().replace(/\/+$/, '')).filter((o) => /^https?:\/\/[\w.-]+(:\d+)?$/.test(o)).map((o) => new URL(o))
    .filter((u) => u.host !== home.host);
}

/**
 * الرابط الرئيسي: هذا المتصفح ما مر بعد على رابط قديم؟ يتحول له (?mv-pull=القائمة) ويرجع (?mv-pulled=القائمة)، ومعه
 * رموز النقل في #mv-move إذا كان عنده شي هناك. القائمة تمشي مع الدورة والكوكي يحفظها، فكل رابط يُزار مرة واحدة حتى
 * لو الكوكيز ممنوعة (بلا حلقة). يرجّع { redirect } أو { cookie } للصفحة.
 */
function pullStep(request, env, home, url) {
  const olds = oldHosts(env, home);
  if (!olds.length) return {};
  const known = new Set(olds.map((u) => u.host));
  const listed = (v) => String(v || '').split('|').filter((h) => known.has(h));
  const done = new Set([...listed(cookies(request)[PULL_COOKIE]), ...listed(url.searchParams.get('mv-pulled'))]);
  const next = olds.find((u) => !done.has(u.host));
  if (next) done.add(next.host);
  const cookie = setCookie(PULL_COOKIE, [...done].join('|'), { maxAge: 400 * 86400 });
  if (next) return { redirect: bounce(`${next.origin}/?mv-pull=${encodeURIComponent([...done].join('|'))}`, cookie) };
  return url.searchParams.has('mv-pulled') ? { cookie } : {};
}

function serveAsset(request, asset) {
  const etag = `"${BUILD}"`;
  // رابط يحمل رقم هذا البناء (?v=): لا يتغير محتواه أبداً، فيخزّنه المتصفح سنة بلا طلب تحقق عند كل فتح.
  // الرابط بلا رقم يُتحقق منه كل مرة (304). ملفات التطبيق المحمية خاصة بالجهاز (private)
  const versioned = new URL(request.url).searchParams.get('v') === BUILD;
  const headers = {
    'content-type': asset.type,
    etag,
    'cache-control': versioned ? `${asset.gated ? 'private' : 'public'}, max-age=31536000, immutable` : asset.immutable ? 'public, max-age=604800' : 'no-cache',
    ...SECURITY_HEADERS,
  };
  if (asset.type.startsWith('text/html')) headers['content-security-policy'] = CSP;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(asset.body, { headers });
}

function relay(upstream, extra = {}) {
  const headers = { 'cache-control': 'no-store', ...extra };
  for (const h of ['content-type', 'retry-after', 'x-ratelimit-remaining-audio-seconds', 'x-ratelimit-reset-audio-seconds',
    'x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset-requests']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

// مصادر الصور المفتوحة المسموح جلبها عبر الخادم (عندما يُمنع الجلب المباشر من المتصفح)
const FETCH_ALLOW = [
  [/^commons\.wikimedia\.org$/, /^\/w\/api\.php$/],
  [/^en\.wikipedia\.org$/, /^\/w\/api\.php$/],
  [/^upload\.wikimedia\.org$/, /^\/wikipedia\//],
  [/^thumb\.wikimedia\.org$/, /^\//],
  [/^openi\.nlm\.nih\.gov$/, /^\/(api\/search$|imgs\/)/],
  [/^api\.openverse\.org$/, /^\/v1\/images\//],
];
const fetchAllowed = (u) => u.protocol === 'https:' && !u.username && !u.port && FETCH_ALLOW.some(([host, path]) => host.test(u.hostname) && path.test(u.pathname));

const FETCH_MAX_BYTES = 25 * 1024 * 1024;

async function proxyFetch(request, target) {
  const ua = `MediVoice/1.0 (${new URL(request.url).origin}; medical lecture notes tool)`;
  let up, url = target;
  // التحويلات تُتبع يدوياً: كل وجهة تُفحص قبل طلبها (لا يُطلب من الخادم أي نطاق خارج القائمة)
  for (let hop = 0; hop < 4; hop++) {
    try {
      up = await fetch(url.href, { headers: { 'user-agent': ua, 'api-user-agent': ua, accept: 'application/json, image/*' }, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    } catch {
      return json({ error: 'upstream' }, 502);
    }
    if (up.status < 300 || up.status >= 400) break;
    let next;
    try { next = new URL(up.headers.get('location') || '', url); } catch { return json({ error: 'upstream' }, 502); }
    if (!fetchAllowed(next)) return json({ error: 'forbidden' }, 403);
    url = next;
    up = null;
  }
  if (!up) return json({ error: 'upstream' }, 502);
  if (!up.ok) return json({ error: 'upstream' }, up.status === 429 ? 429 : 502);
  const type = (up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // لا نمرر SVG أو HTML من نطاقنا إطلاقاً
  if (!/^(application\/json|image\/(jpeg|png|webp|gif))$/.test(type)) return json({ error: 'unsupported_type' }, 415);
  if (Number(up.headers.get('content-length') || 0) > FETCH_MAX_BYTES) return json({ error: 'too_large' }, 413);
  // حد الحجم أثناء التمرير أيضاً (الرد بلا content-length)
  let seen = 0;
  const cap = new TransformStream({
    transform(chunk, ctrl) {
      seen += chunk.byteLength;
      if (seen > FETCH_MAX_BYTES) ctrl.error(new Error('too large'));
      else ctrl.enqueue(chunk);
    },
  });
  return new Response(up.body.pipeThrough(cap), {
    headers: {
      'content-type': type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin',
    },
  });
}

const MAX_GEMINI_KEYS = 6;
/** القيمة المخزنة إما مفتاح واحد (قديم) أو قائمة JSON. */
function parseKeys(text) {
  if (!text) return [];
  if (text.startsWith('[')) { try { return JSON.parse(text).filter((k) => typeof k === 'string' && k); } catch { return []; } }
  return [text];
}
const keyCount = (hint) => (hint ? hint.split(' · ').length : 0);

/**
 * حالة المفاتيح في ذاكرة هذا الـ Isolate فقط (لا تُحفظ): مفتاح+نموذج نفدت حصته اليومية يُتخطى 20 دقيقة،
 * ومفتاح رفضته Google (ملغى أو محذوف) يُتخطى 30 دقيقة، حتى لا يضيع الوقت على أخطاء متكررة.
 */
const exhausted = new Map();
const deadKeys = new Map();
const EXHAUST_MS = 20 * 60_000;
const DAY_MS = 24 * 3600_000;
const DEAD_MS = 30 * 60_000;
const isExhausted = (key, model) => (exhausted.get(`${key}|${model}`) || 0) > Date.now();
const isDead = (key) => (deadKeys.get(key) || 0) > Date.now();
function remember(map, k, ms) {
  map.set(k, Date.now() + ms);
  if (map.size > 4000) { const now = Date.now(); for (const [x, t] of map) if (t <= now) map.delete(x); }
}
/** معرّف مفتاح لا يكشفه (أول وآخر 4 حروف، كما يُعرض للطالب) */
const hintOf = (k) => k.slice(0, 4) + '…' + k.slice(-4);
/**
 * حالة المفاتيح تعيش في قاعدة البيانات (كل خوادم Cloudflare وبعد إعادة التشغيل)، وذاكرة هذا الخادم نسخة سريعة
 * منها: ما يُتعلَّم هنا يُرسل إليها، وما جاء مع التصريح يُدمج هنا.
 */
function mergeHealth(auth) {
  if (!auth?.health?.length) return;
  const keys = [...(auth.geminiKeys || []), ...(auth.groqKeys || [])];
  const byHint = new Map(keys.map((k) => [hintOf(k), k]));
  for (const [k, until] of auth.health) {
    const bar = k.indexOf('|');
    const key = byHint.get(bar < 0 ? k : k.slice(0, bar));
    if (!key) continue;
    const model = bar < 0 ? '' : k.slice(bar + 1);
    const map = model === '*' ? deadKeys : exhausted;
    const id = model === '*' ? key : `${key}|${model}`;
    if ((map.get(id) || 0) < until) map.set(id, until);
  }
}
/** يُستدعى عند تعلّم حالة جديدة: تُحفظ في قاعدة البيانات دون انتظار */
const learn = (ctx, db, code) => (key, model, until) => { try { ctx.waitUntil(db.noteKey(code, `${hintOf(key)}|${model}`, until)); } catch {} };

/** خطأ يخص المفتاح نفسه (لا الطلب ولا النموذج): مفتاح غير صالح أو ملغى أو بلا صلاحية. */
const keyRejected = (status, text) => status === 401
  || (status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(text))
  || (status === 403 && /PERMISSION_DENIED|API key|SERVICE_DISABLED|has not been used|suspended/i.test(text));

/** يرد بخطأ JSON بصيغة Google حتى يعامله المتصفح كأي رد من المزوّد. */
const upstreamError = (status, message) => new Response(JSON.stringify({ error: { code: status, message } }), { status, headers: { 'content-type': 'application/json' } });

/**
 * يرسل طلب Gemini بمفاتيح المستخدم بالتناوب: عند نفاد حصة مفتاح (429) أو رفضه (مفتاح ملغى) يجرّب التالي،
 * فلا يُفشل مفتاحٌ واحد معطوب محاضرةً كاملة ما دام غيره يعمل.
 */
async function geminiWithKeys(keys, model, body, onLearn = () => {}) {
  const start = Math.floor(Math.random() * keys.length);
  const order = keys.map((_, i) => keys[(i + start) % keys.length]);
  const usable = order.filter((k) => !isDead(k));
  const pool = usable.length ? usable : order;
  const live = pool.filter((k) => !isExhausted(k, model));
  // حصة اليوم لهذا النموذج خلصت بكل المفاتيح: نرد فوراً بنفس خطأ Google (فينتقل المتصفح للنموذج التالي)
  // بدل طلب نعرف نتيجته. الذاكرة لكل مفتاح حتى موعد التجدد الذي ذكرته Google
  if (!live.length && usable.length) return dayLimitError(model);
  let last = null, minute = null;
  for (const key of live.length ? live : pool.slice(0, 1)) {
    let up;
    try {
      up = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(400_000),
      });
    } catch {
      return upstreamError(504, 'upstream timeout');
    }
    if (up.ok) return up;
    if (up.status !== 429 && up.status !== 400 && up.status !== 401 && up.status !== 403) return up; // 5xx/404: لا يخص المفتاح
    const text = await up.clone().text().catch(() => '');
    if (up.status === 429) {
      // 429 قد تكون حصة الدقيقة (مؤقتة) أو حصة اليوم؛ في الحالتين المفتاح التالي أفضل الآن
      // قد يذكر الرد حدّي الدقيقة واليوم معاً: ذكر اليوم يكفي (المفتاح لن ينفع لهذا النموذج حتى التجدد)
      if (/per_day|PerDay|daily/i.test(text)) {
        const delay = parseFloat((text.match(/"retryDelay"\s*:\s*"([\d.]+)s"/) || [])[1]) || 0;
        const ms = Math.max(EXHAUST_MS, Math.min(delay * 1000, DAY_MS));
        remember(exhausted, `${key}|${model}`, ms);
        onLearn(key, model, Date.now() + ms);
      } else minute = up;
      last = up;
      continue;
    }
    if (keyRejected(up.status, text)) { if (keys.length > 1) { remember(deadKeys, key, DEAD_MS); onLearn(key, '*', Date.now() + DEAD_MS); } last = up; continue; }
    return up; // طلب غير صالح (400 عادي): المفتاح الآخر لن يغيّر شيئاً
  }
  // مفتاح في حد الدقيقة (يرجع بعد ثوانٍ) أفضل للمتصفح من خبر نفاد اليوم بمفتاح آخر: ينتظر بدل أن يترك النموذج
  return minute || last;
}

/** معرّف الطلب من المتصفح (ثابت عبر إعادته)، مقيّد الطول والحروف */
const reqTag = (request) => (request.headers.get('x-mv-req') || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);

/** نفس رد Google عند نفاد الحصة اليومية للنموذج (المتصفح يميّزه من quotaId فيترك النموذج لباقي المحاضرة). */
const dayLimitError = (model) => new Response(JSON.stringify({ error: {
  code: 429, status: 'RESOURCE_EXHAUSTED', message: `Daily quota exhausted for ${model} on every linked key.`,
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model } }] }],
} }), { status: 429, headers: { 'content-type': 'application/json' } });

/**
 * تصريح الطلبات المتكررة يُحفظ دقيقة في ذاكرة الـ Isolate: محاضرة واحدة ترسل نحو 150 طلباً، وكل تصريح طلبٌ على
 * قاعدة البيانات (Durable Object) التي حصتها المجانية 100 ألف طلب يومياً للموقع كله. طلبات الصوت (عليها الحد اليومي)
 * و PDF تُفحص دائماً من جديد. ربط مفتاح أو فكّه يمسح نسخة الجهاز.
 */
const AUTH_TTL = 60_000;
const authCache = new Map();
async function authorizeCached(db, id, opts) {
  if (opts.sec > 0 || opts.kind === 'pdf') { const v = await db.authorize(id, opts); mergeHealth(v); return v; }
  const k = `${id}|${opts.kind || ''}`;
  const hit = authCache.get(k);
  if (hit && Date.now() - hit.at < AUTH_TTL) return hit.value;
  const value = await db.authorize(id, opts);
  mergeHealth(value);
  if (value.ok) {
    authCache.set(k, { at: Date.now(), value });
    if (authCache.size > 3000) { const old = Date.now() - AUTH_TTL; for (const [x, v] of authCache) if (v.at < old) authCache.delete(x); }
  }
  return value;
}
const forgetAuth = (id) => { for (const k of authCache.keys()) if (k.startsWith(`${id}|`)) authCache.delete(k); };

/**
 * طلب Groq بمفاتيح المستخدم بالتناوب: عند حد (429) أو رفض المفتاح يجرّب التالي. حد طويل (حصة الساعات اليومية)
 * يُتذكّر لذلك المفتاح والنموذج حتى موعد تجدده، فلا يُضيَّع وقت عليه.
 * @param body ArrayBuffer (يُرسل كما هو لكل مفتاح)
 */
async function groqWithKeys(keys, url, contentType, body, model = '', onLearn = () => {}) {
  const start = Math.floor(Math.random() * keys.length);
  const order = keys.map((_, i) => keys[(i + start) % keys.length]);
  const usable = order.filter((k) => !isDead(k));
  const pool = usable.length ? usable : order;
  const tag = `groq:${model}`;
  const live = pool.filter((k) => !isExhausted(k, tag));
  if (model && !live.length && usable.length) {
    // كل المفاتيح بلغت حدها الطويل لهذا النموذج: نرد فوراً بموعد أقرب تجدد، فيهدّئه المتصفح وينتقل لغيره
    const soon = Math.min(...usable.map((k) => exhausted.get(`${k}|${tag}`) || 0));
    const wait = Math.max(1, Math.ceil((soon - Date.now()) / 1000));
    return new Response(JSON.stringify({ error: { message: `Rate limit reached for model \`${model}\` on every linked key. Please try again in ${wait}s.`, type: 'tokens', code: 'rate_limit_exceeded' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(wait) } });
  }
  let last = null, soonest = null;
  for (const key of live.length ? live : pool.slice(0, 1)) {
    let up;
    try {
      up = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': contentType }, body, signal: AbortSignal.timeout(230_000) });
    } catch {
      return upstreamError(504, 'upstream timeout');
    }
    if (up.ok) return up;
    if (up.status === 429) {
      // «request too large» يخص الطلب لا المفتاح: مفتاح آخر لن يقبله أيضاً
      const text = await up.clone().text().catch(() => '');
      if (/request too large|reduce your message/i.test(text)) return up;
      const wait = parseFloat(up.headers.get('retry-after')) || 0;
      // حد طويل (ساعات الصوت أو رموز اليوم): يُتذكّر لهذا المفتاح والنموذج حتى موعده
      if (wait > 120 && model) { const ms = Math.min(wait, 24 * 3600) * 1000; remember(exhausted, `${key}|${tag}`, ms); onLearn(key, tag, Date.now() + ms); }
      // يرجع للمتصفح أقرب موعد بين المفاتيح، فينتظر أقصر مدة ممكنة
      if (!soonest || wait < (parseFloat(soonest.headers.get('retry-after')) || 0)) soonest = up;
      last = up;
      continue;
    }
    if (up.status === 401) { if (keys.length > 1) { remember(deadKeys, key, DEAD_MS); onLearn(key, '*', Date.now() + DEAD_MS); } last = up; continue; } // مفتاح ملغى أو محذوف
    if (up.status === 403) { last = up; continue; } // حساب مقيّد أو نموذج غير متاح له: نجرب حساباً آخر
    return up;
  }
  return soonest || last;
}

async function verifyKey(provider, key) {
  try {
    const signal = AbortSignal.timeout(15_000);
    const res = provider === 'groq'
      ? await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` }, signal })
      : await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403 || res.status === 400) return { ok: false, error: 'bad_key' };
    return { ok: false, error: 'provider_down', status: res.status };
  } catch {
    return { ok: false, error: 'provider_down' };
  }
}

async function listModels(auth) {
  const out = { groq: [], gemini: [] };
  // مفتاح ملغى بين عدة: نجرب التالي حتى يرد واحد (قائمة النماذج ليست لها حصة تُذكر)
  const firstOk = async (keys, fetchOne) => {
    for (const key of (keys || []).filter((k) => !isDead(k)).slice(0, 3)) {
      const d = await fetchOne(key).catch(() => null);
      if (d) return d;
    }
    return null;
  };
  const jobs = [
    firstOk(auth.groqKeys, (key) => fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.json() : null))).then((d) => { if (d?.data) out.groq = d.data.filter((m) => m.active !== false).map((m) => m.id); }),
    firstOk(auth.geminiKeys, (key) => fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=300', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.json() : null))).then((d) => {
      if (d?.models) out.gemini = d.models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
    }),
  ];
  await Promise.all(jobs);
  return out;
}

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const db = store(env);

  // حماية CSRF: كل طلب مغيِّر يحتاج ترويسة خاصة لا يمكن إرسالها من موقع آخر بدون CORS
  if (method !== 'GET' && request.headers.get('x-mv') !== '1') return json({ error: 'bad_request' }, 400);

  // ── المدير ──
  if (path.startsWith('/api/admin/')) {
    const token = cookies(request)[ADMIN_COOKIE] || '';
    const ip = request.headers.get('cf-connecting-ip') || '';
    const body = method === 'GET' || method === 'DELETE' ? {} : await request.json().catch(() => ({}));
    const reply = (r, headers) => json(r, r.ok ? 200 : r.status || 400, headers);
    if (path === '/api/admin/login' && method === 'POST') {
      const r = await db.adminLogin(body.password, ip);
      if (!r.ok) return reply(r);
      return json({ ok: true }, 200, { 'set-cookie': setCookie(ADMIN_COOKIE, r.token, { maxAge: 43200, sameSite: 'Strict' }) });
    }
    if (path === '/api/admin/logout' && method === 'POST') {
      await db.adminLogout(token);
      return json({ ok: true }, 200, { 'set-cookie': setCookie(ADMIN_COOKIE, '', { maxAge: 0, sameSite: 'Strict' }) });
    }
    if (path === '/api/admin/overview' && method === 'GET') return reply(await db.adminOverview(token));
    if (path === '/api/admin/codes' && method === 'POST') return reply(await db.adminCreateCodes(token, body));
    if (path === '/api/admin/settings' && method === 'PUT') { const r = await db.adminSaveSettings(token, body); if (r.ok) forgetTheme(); return reply(r); }
    if (path === '/api/admin/password' && method === 'POST') return reply(await db.adminChangePassword(token, body.current, body.next));
    const m = path.match(/^\/api\/admin\/codes\/([\w-]{8,14})(\/reset)?$/);
    if (m) {
      if (m[2] && method === 'POST') return reply(await db.adminResetDevices(token, m[1]));
      if (!m[2] && method === 'PATCH') return reply(await db.adminUpdateCode(token, m[1], body));
      if (!m[2] && method === 'DELETE') return reply(await db.adminDeleteCode(token, m[1]));
    }
    return json({ error: 'not_found' }, 404);
  }

  // ── الجلسة والتفعيل ──
  if (path === '/api/session' && method === 'GET') {
    let fp = {};
    try { fp = JSON.parse(url.searchParams.get('fp') || '{}'); } catch {}
    const id = await deviceId(request);
    return json(await db.session(id, clientMeta(request, fp)));
  }

  if (path === '/api/activate' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    let secret = cookies(request)[DEVICE_COOKIE];
    if (!secret || !/^[\w-]{30,80}$/.test(secret)) secret = randomToken();
    const r = await db.activate(await sha256hex(secret), body.code, clientMeta(request, body.fp || {}));
    if (!r.ok) return json({ error: r.error }, r.status || 400);
    return json(r.session, 200, { 'set-cookie': setCookie(DEVICE_COOKIE, secret, { maxAge: 400 * 86400 }) });
  }

  // ── تسجيل خروج الزبون: يمسح كوكي الجهاز ويرجعه لصفحة الكود (قبل بوابة التفعيل: يشتغل حتى لو انتهى التفعيل) ──
  if (path === '/api/logout' && method === 'POST') {
    const id = await deviceId(request);
    if (id) {
      await db.logout(id, clientMeta(request));
      forgetAuth(id);
    }
    return json({ ok: true }, 200, { 'set-cookie': setCookie(DEVICE_COOKIE, '', { maxAge: 0 }) });
  }

  // ── النقل من رابط قديم للرابط الرئيسي: قبل بوابة التفعيل، فالرابط القديم قد لا يكون مفعّلاً وعليه محاضرات ──
  if (path.startsWith('/api/move/')) {
    const t = url.searchParams.get('t') || '';
    const n = Number(url.searchParams.get('n'));
    const reply = (r) => json(r, r.ok === false ? r.status || 400 : 200);
    if (path === '/api/move/start' && method === 'POST') {
      const q = url.searchParams;
      const info = { n: q.get('n'), b: q.get('b'), pull: q.get('pull') === '1', err: q.get('err') || '' };
      return reply(await db.moveStart(await deviceId(request), cookies(request)[DEVICE_COOKIE] || '', request.headers.get('cf-connecting-ip') || '', info));
    }
    if (path === '/api/move/part' && method === 'PUT') {
      if (Number(request.headers.get('content-length') || 0) > MOVE_CHUNK) return json({ error: 'too_large' }, 413);
      return reply(await db.movePut(t, n, await request.arrayBuffer()));
    }
    if (path === '/api/move/part' && method === 'GET') {
      const data = await db.moveGet(t, n);
      if (!data) return json({ error: 'gone' }, 404);
      return new Response(data, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }
    if (path === '/api/move/claim' && method === 'POST') {
      const r = await db.moveClaim(t, await deviceId(request));
      if (!r.ok) return reply(r);
      const login = !!r.secret && /^[\w-]{30,80}$/.test(r.secret);
      return json({ ok: true, parts: r.parts, size: r.size, session: login }, 200,
        login ? { 'set-cookie': setCookie(DEVICE_COOKIE, r.secret, { maxAge: 400 * 86400 }) } : {});
    }
    if (path === '/api/move/done' && method === 'POST') return reply(await db.moveDone(t));
    if (path === '/api/move/status' && method === 'GET') return reply(await db.moveStatus(t));
    return json({ error: 'not_found' }, 404);
  }

  // ── ما بعده يحتاج جهازاً مفعّلاً ──
  const id = await deviceId(request);
  if (!id) return json({ error: 'locked' }, 401);

  if (path === '/api/keys' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    // يُقبل مفتاح واحد أو عدة مفاتيح Gemini مفصولة بمسافات أو أسطر أو فواصل
    const keys = [...new Set(String(body.key || '').split(/[\s,;]+/).map((k) => k.replace(/^["']|["']$/g, '')).filter(Boolean))];
    if (!keys.length || keys.some((k) => k.length < 20 || k.length > 300)) return json({ error: 'bad_key' }, 400);
    let provider = body.provider;
    if (provider !== 'groq' && provider !== 'gemini') provider = keys[0].startsWith('gsk_') ? 'groq' : 'gemini';
    if (keys.length > MAX_GEMINI_KEYS) return json({ error: 'too_many_keys' }, 400);
    if (!(await db.isActive(id))) return json({ error: 'locked' }, 401);
    for (const key of keys) {
      const v = await verifyKey(provider, key);
      if (!v.ok) return json({ error: v.error, provider, hint: key.slice(0, 4) + '…' + key.slice(-4) }, v.error === 'bad_key' ? 400 : 502);
    }
    const r = await db.setKey(id, provider, keys, { add: body.add === true });
    forgetAuth(id);
    return r.ok ? json({ ...r.session, linked: provider }) : json({ error: r.error }, r.status);
  }

  if (path === '/api/keys' && method === 'DELETE') {
    const provider = url.searchParams.get('provider');
    if (provider !== 'groq' && provider !== 'gemini') return json({ error: 'bad_request' }, 400);
    const r = await db.removeKey(id, provider);
    forgetAuth(id);
    return r.ok ? json(r.session) : json({ error: r.error }, r.status);
  }

  if (path === '/api/fetch' && method === 'GET') {
    if (!(await authorizeCached(db, id, { kind: 'active' })).ok) return json({ error: 'locked' }, 401);
    let target;
    try { target = new URL(url.searchParams.get('u') || ''); } catch { return json({ error: 'bad_request' }, 400); }
    if (!fetchAllowed(target)) return json({ error: 'forbidden' }, 403);
    return proxyFetch(request, target);
  }

  if (path === '/api/models' && method === 'GET') {
    const auth = await authorizeCached(db, id, { kind: 'both' });
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    return json(await listModels(auth));
  }

  const sec = Math.min(Math.max(Number(url.searchParams.get('sec')) || 0, 0), 1800);

  // تحويل الصوت إلى نص (Groq Whisper) — الجسم multipart يمر كما هو بدون قراءة
  const req = reqTag(request);
  // ثوانٍ محجوزة لطلب فشل عند المزوّد تُحرَّر فوراً (لا تبقى محسوبة 10 دقائق على الطالب)
  const settle = (auth, up) => {
    if (sec <= 0) return;
    if (up.ok) ctx.waitUntil(db.logUsage(auth.code, 'audio', sec, req));
    else if (req) ctx.waitUntil(db.release(req));
  };

  if (path === '/api/stt' && method === 'POST') {
    const auth = await authorizeCached(db, id, { kind: 'groq', sec, req });
    if (!auth.ok) return json(auth, auth.status);
    if (!auth.groq) { if (sec > 0 && req) ctx.waitUntil(db.release(req)); return json({ error: 'no_key', provider: 'groq' }, 412); }
    // الجسم يُقرأ مرة (نحو 2MB) حتى يُعاد إرساله بمفتاح آخر إذا بلغ الأول حده
    const body = auth.groqKeys.length > 1 ? await request.arrayBuffer() : request.body;
    const up = await groqWithKeys(auth.groqKeys, 'https://api.groq.com/openai/v1/audio/transcriptions', request.headers.get('content-type') || '', body, url.searchParams.get('m') || '', learn(ctx, db, auth.code));
    settle(auth, up);
    return relay(up);
  }

  if (path === '/api/groq' && method === 'POST') {
    const auth = await authorizeCached(db, id, { kind: 'groq' });
    if (!auth.ok) return json(auth, auth.status);
    if (!auth.groq) return json({ error: 'no_key', provider: 'groq' }, 412);
    const body = auth.groqKeys.length > 1 ? await request.arrayBuffer() : request.body;
    return relay(await groqWithKeys(auth.groqKeys, 'https://api.groq.com/openai/v1/chat/completions', 'application/json', body, url.searchParams.get('m') || '', learn(ctx, db, auth.code)));
  }

  if (path === '/api/gemini' && method === 'POST') {
    const model = url.searchParams.get('model') || '';
    if (!/^[a-z0-9][a-z0-9.-]{2,60}$/.test(model)) return json({ error: 'bad_model' }, 400);
    const auth = await authorizeCached(db, id, { kind: 'gemini', sec, req });
    if (!auth.ok) return json(auth, auth.status);
    if (!auth.geminiKeys?.length) { if (sec > 0 && req) ctx.waitUntil(db.release(req)); return json({ error: 'no_key', provider: 'gemini' }, 412); }
    const up = await geminiWithKeys(auth.geminiKeys, model, await request.arrayBuffer(), learn(ctx, db, auth.code));
    settle(auth, up);
    return relay(up);
  }

  if (path === '/api/diag' && method === 'POST') {
    const auth = await db.authorize(id, {});
    if (!auth.ok) return json(auth, auth.status);
    const b = await request.json().catch(() => ({}));
    const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    await db.clientError(auth.code, [clip(b.m, 280), clip(b.at, 90), clip(b.st, 20), clip(b.b, 14)].filter(Boolean).join(' | '));
    return json({ ok: true });
  }

  if (path === '/api/done' && method === 'POST') {
    const auth = await db.authorize(id, {});
    if (!auth.ok) return json(auth, auth.status);
    await db.logUsage(auth.code, 'lecture', 0);
    return json({ ok: true });
  }

  // HTML → PDF عبر متصفح Cloudflare
  if (path === '/api/pdf' && method === 'POST') {
    if (!env.BROWSER?.quickAction) return json({ error: 'pdf_unavailable' }, 503);
    // المستند يمر كنص عبر الخادم (حدّ الربط 16 مليون حرف)، والواجهة تصغّر الصور حتى يبقى خفيفاً
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 12 * 1024 * 1024) return json({ error: 'too_large' }, 413);
    const auth = await db.authorize(id, { kind: 'pdf' });
    if (!auth.ok) return json(auth, auth.status);
    const html = await request.text();
    if (html.length > 14_000_000) return json({ error: 'too_large' }, 413);
    if (auth.wait_ms > 0) await new Promise((r) => setTimeout(r, auth.wait_ms));
    // المستند يبني صفحاته بسكربت داخله ويعلن جاهزيته بإضافة mv-ready (الواجهة تعلن ذلك بترويسة، بدل البحث
    // في نص بحجم ميغابايتات على وقت المعالج المحدود)
    const flag = request.headers.get('x-mv-paged');
    const paged = flag ? flag === '1' : html.lastIndexOf('mv-ready') > 0;
    let res;
    try {
      res = await env.BROWSER.quickAction('pdf', {
        html,
        pdfOptions: { format: 'a4', printBackground: true, preferCSSPageSize: true },
        ...(paged
          ? { gotoOptions: { waitUntil: 'load', timeout: 45000 }, waitForSelector: { selector: 'html.mv-ready', timeout: 30000 } }
          : { gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 } }),
      });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 300);
      console.error('pdf_failed', msg);
      // حد الحساب اليومي أو ازدحام المتصفحات يأتي أحياناً كاستثناء لا كرد 429: نميّزه حتى يعيد المتصفح المحاولة
      // أو يشرح للطالب، ولا يُحسب على الطالب (لم يُفتح متصفح)
      if (/time limit|for today|daily|quota/i.test(msg)) return json({ error: 'pdf_quota' }, 429);
      if (/too many|concurren|rate ?limit|429|busy/i.test(msg)) return json({ error: 'pdf_busy' }, 429);
      // المتصفح فُتح واستهلك من الحصة المشتركة: تُحسب على الطالب حتى لا تُستنزف الحصة بمحاولات فاشلة متكررة
      ctx.waitUntil(db.logUsage(auth.code, 'pdf', 0));
      return json({ error: 'pdf_failed' }, 502);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      console.error('pdf_status', res.status, detail);
      // 429 نوعان: طلب كل 10 ثوانٍ (نعيد المحاولة)، أو انتهاء دقائق المتصفح اليومية للحساب. غيرها استهلك متصفحاً
      if (res.status !== 429) ctx.waitUntil(db.logUsage(auth.code, 'pdf', 0));
      const error = res.status !== 429 ? 'pdf_failed' : /time limit|for today/i.test(detail) ? 'pdf_quota' : 'pdf_busy';
      return json({ error }, res.status === 429 ? 429 : 502);
    }
    ctx.waitUntil(db.logUsage(auth.code, 'pdf', 0));
    return new Response(res.body, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } });
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, ctx, url);

      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
      let path = url.pathname;
      if (path === '/') path = '/index.html';
      if (path === '/admin' || path === '/admin/') path = '/admin.html';
      const asset = ASSETS[path];
      if (!asset) return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });
      if (asset.type.startsWith('text/html')) {
        const home = homeUrl(env);
        const foreign = url.host !== home.host;
        // رابط ثاني للموقع: لوحة التحكم تتحول للرابط الرئيسي مباشرة (ما عليها بيانات)، والتطبيق تنقل صفحته زائرها
        // ومعه تسجيل دخوله ومحاضراته
        if (foreign && path === '/admin.html') return Response.redirect(`${home.origin}/admin`, 302);
        let cookie = '';
        if (path === '/index.html') {
          if (!foreign) {
            const step = pullStep(request, env, home, url);
            if (step.redirect) return step.redirect;
            cookie = step.cookie || '';
          }
          // الرابط القديم تُخدم صفحته دائماً (حتى للسحب): سفاري ما يرسل كوكي الرابط القديم مع التحويل من رابط ثاني،
          // فالقرار من الصفحة نفسها حسب ما محفوظ فعلاً في المتصفح
        }
        return serveHtml(request, asset, env, ctx, { home: home.origin, move: foreign && path === '/index.html', cookie });
      }
      // نسخة الجهاز من هذا الإصدار صالحة: 304 لا يكشف شيئاً، فلا داعي لفحص التفعيل (طلب أقل على قاعدة البيانات)
      if (request.headers.get('if-none-match') === `"${BUILD}"`) return serveAsset(request, asset);
      if (asset.gated) {
        const id = await deviceId(request);
        if (!id || !(await authorizeCached(store(env), id, { kind: 'active' })).ok) return new Response('Locked', { status: 403, headers: SECURITY_HEADERS });
      }
      return serveAsset(request, asset);
    } catch (e) {
      console.error('unhandled', e?.stack || e);
      return json({ error: 'server_error' }, 500);
    }
  },
};
