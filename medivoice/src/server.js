var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// dist/worker.js
import { DurableObject } from "cloudflare:workers";

// الملفات الثابتة (BUILD و ASSETS) يولّدها tools/build.mjs مكان السطر التالي.
/*__ASSETS__*/

var MIN = 6e4;
var HOUR = 36e5;
var DAY = 864e5;
var CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
var DEVICE_COOKIE = "mv_dev";
var ADMIN_COOKIE = "mv_adm";
var TZ_OFFSET = 3 * HOUR;
var DEFAULT_SETTINGS = {
  support: { label: "", url: "" },
  notice: "",
  defaultDailyHours: 8,
  pdfPerDay: 20,
  moveLimit: 2,
  // كم مرة بالشهر يُسمح بنقل التفعيل لمتصفح آخر على نفس الجهاز (0 = ممنوع)
  chunkSec: 480,
  overlapSec: 3,
  sttModels: ["whisper-large-v3", "whisper-large-v3-turbo"],
  geminiModels: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
  groqModels: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]
};
var enc = new TextEncoder();
var dec = new TextDecoder();
var b64u = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "b64u");
var unb64u = /* @__PURE__ */ __name((s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), "unb64u");
var randomToken = /* @__PURE__ */ __name((n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n))), "randomToken");
async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
__name(cookies, "cookies");
function setCookie(name, value, { maxAge, sameSite = "Lax" } = {}) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}` + (maxAge !== void 0 ? `; Max-Age=${maxAge}` : "");
}
__name(setCookie, "setCookie");
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
__name(json, "json");
function normalizeCode(input) {
  let s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === 10 && s.startsWith("MV")) s = s.slice(2);
  return s;
}
__name(normalizeCode, "normalizeCode");
var displayCode = /* @__PURE__ */ __name((c) => `MV-${c.slice(0, 4)}-${c.slice(4)}`, "displayCode");
function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of r) s += CODE_ALPHABET[b % 32];
  return s;
}
__name(newCode, "newCode");
function parseUA(ua = "") {
  let os = "other", browser = "other";
  if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "macOS";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Linux/.test(ua)) os = "Linux";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/SamsungBrowser/.test(ua)) browser = "Samsung Internet";
  else if (/CriOS|Chrome\//.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return { os, browser };
}
__name(parseUA, "parseUA");
function clientMeta(request, fp = {}) {
  const ua = request.headers.get("user-agent") || "";
  const parsed = parseUA(ua);
  const osOk = ["iOS", "Android", "Windows", "macOS", "Linux", "ChromeOS"].includes(fp.os);
  return {
    ua: ua.slice(0, 300),
    os: osOk ? fp.os : parsed.os,
    browser: parsed.browser,
    screen: typeof fp.scr === "string" ? fp.scr.slice(0, 24) : "",
    ip: request.headers.get("cf-connecting-ip") || "",
    country: request.cf?.country || "",
    city: request.cf?.city || ""
  };
}
__name(clientMeta, "clientMeta");
var MediVoiceStore = class extends DurableObject {
  static {
    __name(this, "MediVoiceStore");
  }
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
    `);
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
    const r = this.#row("SELECT value FROM settings WHERE key = ?", key);
    if (!r) return fallback;
    try {
      return JSON.parse(r.value);
    } catch {
      return fallback;
    }
  }
  #putSetting(key, value) {
    this.sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }
  #config() {
    return { ...DEFAULT_SETTINGS, ...this.#setting("config", {}) || {} };
  }
  #event(type, { code = null, ip = "", country = "", detail = "" } = {}) {
    this.sql.exec("INSERT INTO events (ts, type, code, ip, country, detail) VALUES (?, ?, ?, ?, ?, ?)", Date.now(), type, code, ip, country, String(detail).slice(0, 300));
  }
  // يحسب المحاولات ضمن نافذة زمنية. يرجع true إذا مسموح.
  #allow(key, windowMs, max) {
    const since = Date.now() - windowMs;
    const r = this.#row("SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND ts > ?", key, since);
    return (r?.n || 0) < max;
  }
  #hit(key) {
    this.sql.exec("INSERT INTO attempts (key, ts) VALUES (?, ?)", key, Date.now());
  }
  async #ensureAlarm() {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
  async alarm() {
    const now = Date.now();
    this.sql.exec("DELETE FROM usage WHERE ts < ?", now - 60 * DAY);
    this.sql.exec("DELETE FROM attempts WHERE (ts < ? AND key NOT LIKE 'mv:%') OR ts < ?", now - DAY, now - 31 * DAY);
    this.sql.exec("DELETE FROM admin_sessions WHERE exp < ?", now);
    this.sql.exec("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 3000)");
    await this.ctx.storage.setAlarm(now + DAY);
  }
  async #aesKey() {
    if (!this.env.KEYS_SECRET) throw new Error("KEYS_SECRET is not configured");
    if (!this._aes) {
      const raw = await crypto.subtle.digest("SHA-256", enc.encode(this.env.KEYS_SECRET));
      this._aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    return this._aes;
  }
  async #seal(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.#aesKey(), enc.encode(text));
    return b64u(iv) + "." + b64u(ct);
  }
  async #open(sealed) {
    if (!sealed) return null;
    try {
      const [iv, ct] = sealed.split(".");
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await this.#aesKey(), unb64u(ct));
      return dec.decode(pt);
    } catch {
      return null;
    }
  }
  #usedSec(code, sinceMs) {
    const r = this.#row("SELECT COALESCE(SUM(sec), 0) AS s FROM usage WHERE code = ? AND kind = 'audio' AND ts > ?", code, Date.now() - sinceMs);
    return r?.s || 0;
  }
  // يتحقق من الجهاز والكود. يرجع { ok, dev, code } أو { ok:false, reason }
  #check(deviceId2) {
    if (!deviceId2) return { ok: false, reason: "none" };
    const dev = this.#row("SELECT * FROM devices WHERE id = ?", deviceId2);
    if (!dev) return { ok: false, reason: "none" };
    const code = this.#row("SELECT * FROM codes WHERE code = ?", dev.code);
    if (!code) {
      this.sql.exec("DELETE FROM devices WHERE id = ?", deviceId2);
      return { ok: false, reason: "none" };
    }
    if (code.status !== "active") return { ok: false, reason: "suspended" };
    if (code.expires_at && Date.now() > code.expires_at) return { ok: false, reason: "expired" };
    return { ok: true, dev, code };
  }
  #publicInfo() {
    const cfg = this.#config();
    return { support: cfg.support, build: BUILD };
  }
  #sessionPayload(code) {
    const cfg = this.#config();
    return {
      active: true,
      build: BUILD,
      support: cfg.support,
      notice: cfg.notice || "",
      user: { label: code.label, code: displayCode(code.code), expires_at: code.expires_at || null },
      keys: {
        groq: { linked: !!code.groq_enc, hint: code.groq_hint || "" },
        gemini: { linked: !!code.gemini_enc, hint: code.gemini_hint || "" }
      },
      usage: {
        used_sec: Math.round(this.#usedSec(code.code, DAY)),
        limit_sec: code.daily_limit_sec,
        total_sec: Math.round(code.total_sec),
        lectures: code.lectures
      },
      config: {
        chunkSec: cfg.chunkSec,
        overlapSec: cfg.overlapSec,
        sttModels: cfg.sttModels,
        geminiModels: cfg.geminiModels,
        groqModels: cfg.groqModels
      }
    };
  }
  // ── واجهة المستخدم ──
  isActive(deviceId2) {
    return this.#check(deviceId2).ok;
  }
  session(deviceId2, meta) {
    const c = this.#check(deviceId2);
    if (!c.ok) return { active: false, reason: c.reason, ...this.#publicInfo() };
    const { dev, code } = c;
    if (meta.os && dev.os && meta.os !== "other" && dev.os !== "other" && meta.os !== dev.os) {
      if (this.#allow(`mm:${deviceId2}`, HOUR, 1)) {
        this.#hit(`mm:${deviceId2}`);
        this.#event("device_mismatch", { code: code.code, ip: meta.ip, country: meta.country, detail: `${dev.os} \u2192 ${meta.os}` });
      }
      return { active: false, reason: "device_mismatch", ...this.#publicInfo() };
    }
    const now = Date.now();
    if (now - dev.last_seen > 5 * MIN || dev.ip !== meta.ip) {
      if (meta.screen && dev.screen && meta.screen !== dev.screen) {
        this.#event("screen_changed", { code: code.code, ip: meta.ip, country: meta.country, detail: `${dev.screen} \u2192 ${meta.screen}` });
      }
      this.sql.exec(
        "UPDATE devices SET last_seen = ?, ip = ?, country = ?, city = ?, browser = ?, ua = ?, screen = ? WHERE id = ?",
        now,
        meta.ip,
        meta.country,
        meta.city,
        meta.browser,
        meta.ua,
        meta.screen || dev.screen,
        deviceId2
      );
    }
    return this.#sessionPayload(code);
  }
  async activate(deviceId2, rawCode, meta) {
    await this.#ensureAlarm();
    const ipKey = `act:${meta.ip || "x"}`;
    if (!this.#allow(ipKey, 15 * MIN, 8)) return { ok: false, error: "too_many", status: 429 };
    const codeStr = normalizeCode(rawCode);
    const code = codeStr.length === 8 ? this.#row("SELECT * FROM codes WHERE code = ?", codeStr) : null;
    if (!code) {
      this.#hit(ipKey);
      this.#event("activate_failed", { ip: meta.ip, country: meta.country, detail: "invalid" });
      return { ok: false, error: "invalid", status: 404 };
    }
    if (code.status !== "active") return { ok: false, error: "suspended", status: 403 };
    if (code.expires_at && Date.now() > code.expires_at) return { ok: false, error: "expired", status: 403 };
    const now = Date.now();
    const mine = this.#row("SELECT * FROM devices WHERE id = ?", deviceId2);
    if (mine && mine.code === codeStr) return { ok: true, session: this.#sessionPayload(code) };
    const used = this.#row("SELECT COUNT(*) AS n FROM devices WHERE code = ?", codeStr).n;
    if (used >= code.max_devices) {
      const limit = this.#config().moveLimit;
      const twin = limit > 0 && meta.os !== "other" && meta.screen ? this.#row("SELECT id, browser FROM devices WHERE code = ? AND os = ? AND screen = ? ORDER BY last_seen LIMIT 1", codeStr, meta.os, meta.screen) : null;
      const moveKey = `mv:${codeStr}`;
      if (!twin || !this.#allow(moveKey, 30 * DAY, limit)) {
        this.#hit(ipKey);
        this.#event("activate_blocked", { code: codeStr, ip: meta.ip, country: meta.country, detail: `${meta.os} \xB7 ${meta.browser}` });
        return { ok: false, error: "in_use", status: 409 };
      }
      this.#hit(moveKey);
      this.sql.exec("DELETE FROM devices WHERE id = ?", twin.id);
      this.#event("device_moved", { code: codeStr, ip: meta.ip, country: meta.country, detail: `${twin.browser} \u2192 ${meta.browser}` });
    }
    if (mine) this.sql.exec("DELETE FROM devices WHERE id = ?", deviceId2);
    this.sql.exec(
      "INSERT INTO devices (id, code, os, browser, screen, ua, first_seen, last_seen, ip, country, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      deviceId2,
      codeStr,
      meta.os,
      meta.browser,
      meta.screen,
      meta.ua,
      now,
      now,
      meta.ip,
      meta.country,
      meta.city
    );
    let expires = code.expires_at;
    if (!code.activated_at) {
      if (code.duration_days) expires = now + code.duration_days * DAY;
      this.sql.exec("UPDATE codes SET activated_at = ?, expires_at = ? WHERE code = ?", now, expires, codeStr);
    }
    this.#event("activated", { code: codeStr, ip: meta.ip, country: meta.country, detail: `${meta.os} \xB7 ${meta.browser}` });
    return { ok: true, session: this.#sessionPayload(this.#row("SELECT * FROM codes WHERE code = ?", codeStr)) };
  }
  // قبل كل طلب بروكسي: يتأكد من الصلاحية والحد اليومي ويرجع مفاتيح المستخدم
  async authorize(deviceId2, { kind, sec = 0 } = {}) {
    const c = this.#check(deviceId2);
    if (!c.ok) return { ok: false, status: 401, error: c.reason === "none" ? "locked" : c.reason };
    const code = c.code;
    if (sec > 0) {
      const used = this.#usedSec(code.code, DAY);
      if (used + sec > code.daily_limit_sec + 30) {
        const oldest = this.#row("SELECT MIN(ts) AS t FROM usage WHERE code = ? AND kind = 'audio' AND ts > ?", code.code, Date.now() - DAY);
        const retry = oldest?.t ? Math.max(60, Math.ceil((oldest.t + DAY - Date.now()) / 1e3)) : 3600;
        return { ok: false, status: 429, error: "daily_limit", retry_after: retry, used_sec: Math.round(used), limit_sec: code.daily_limit_sec };
      }
    }
    const out = { ok: true, code: code.code };
    if (kind === "pdf") {
      const cfg = this.#config();
      const today = this.#row("SELECT COUNT(*) AS n FROM usage WHERE code = ? AND kind = 'pdf' AND ts > ?", code.code, Date.now() - DAY).n;
      if (today >= cfg.pdfPerDay) return { ok: false, status: 429, error: "pdf_limit" };
      const last = this.#setting("pdf_next", 0);
      const now = Date.now();
      const slot = Math.max(now, last);
      this.#putSetting("pdf_next", slot + 10500);
      out.wait_ms = slot - now;
      if (out.wait_ms > 9e4) return { ok: false, status: 429, error: "pdf_busy" };
      return out;
    }
    if (kind === "groq" || kind === "both") out.groq = await this.#open(code.groq_enc);
    if (kind === "gemini" || kind === "both") out.gemini = await this.#open(code.gemini_enc);
    return out;
  }
  logUsage(code, kind, sec = 0) {
    const now = Date.now();
    this.sql.exec("INSERT INTO usage (code, ts, kind, sec) VALUES (?, ?, ?, ?)", code, now, kind, sec);
    if (kind === "audio") this.sql.exec("UPDATE codes SET total_sec = total_sec + ?, last_active = ? WHERE code = ?", sec, now, code);
    else if (kind === "pdf") this.sql.exec("UPDATE codes SET pdfs = pdfs + 1, last_active = ? WHERE code = ?", now, code);
    else if (kind === "lecture") this.sql.exec("UPDATE codes SET lectures = lectures + 1, last_active = ? WHERE code = ?", now, code);
  }
  async setKey(deviceId2, provider, key) {
    const c = this.#check(deviceId2);
    if (!c.ok) return { ok: false, status: 401, error: "locked" };
    const hint = key.slice(0, 4) + "\u2026" + key.slice(-4);
    const sealed = await this.#seal(key);
    if (provider === "groq") this.sql.exec("UPDATE codes SET groq_enc = ?, groq_hint = ? WHERE code = ?", sealed, hint, c.code.code);
    else this.sql.exec("UPDATE codes SET gemini_enc = ?, gemini_hint = ? WHERE code = ?", sealed, hint, c.code.code);
    this.#event("key_linked", { code: c.code.code, detail: provider });
    return { ok: true, session: this.#sessionPayload(this.#row("SELECT * FROM codes WHERE code = ?", c.code.code)) };
  }
  removeKey(deviceId2, provider) {
    const c = this.#check(deviceId2);
    if (!c.ok) return { ok: false, status: 401, error: "locked" };
    if (provider === "groq") this.sql.exec("UPDATE codes SET groq_enc = NULL, groq_hint = NULL WHERE code = ?", c.code.code);
    else this.sql.exec("UPDATE codes SET gemini_enc = NULL, gemini_hint = NULL WHERE code = ?", c.code.code);
    return { ok: true, session: this.#sessionPayload(this.#row("SELECT * FROM codes WHERE code = ?", c.code.code)) };
  }
  // ── المدير ──
  async #hashPassword(password, salt) {
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64u(salt), iterations: 6e4 }, key, 256);
    return b64u(bits);
  }
  async #checkPassword(password) {
    const stored = this.#setting("admin_pw");
    if (stored?.hash) return timingSafeEqual(await this.#hashPassword(password, stored.salt), stored.hash);
    const initial = this.env.ADMIN_PASSWORD;
    return !!initial && timingSafeEqual(password, initial);
  }
  async adminLogin(password, ip) {
    await this.#ensureAlarm();
    const key = `adm:${ip || "x"}`;
    if (!this.#allow(key, 15 * MIN, 6)) return { ok: false, status: 429, error: "too_many" };
    if (typeof password !== "string" || !await this.#checkPassword(password)) {
      this.#hit(key);
      this.#event("admin_login_failed", { ip });
      return { ok: false, status: 401, error: "wrong_password" };
    }
    const token = randomToken();
    this.sql.exec("INSERT INTO admin_sessions (id, exp) VALUES (?, ?)", await sha256hex(token), Date.now() + 12 * HOUR);
    this.#event("admin_login", { ip });
    return { ok: true, token };
  }
  async #admin(token) {
    if (!token) return false;
    const r = this.#row("SELECT exp FROM admin_sessions WHERE id = ?", await sha256hex(token));
    return !!r && r.exp > Date.now();
  }
  async adminLogout(token) {
    if (token) this.sql.exec("DELETE FROM admin_sessions WHERE id = ?", await sha256hex(token));
    return { ok: true };
  }
  async adminOverview(token) {
    if (!await this.#admin(token)) return { ok: false, status: 401, error: "unauthorized" };
    const now = Date.now();
    const codes = this.#all(`
      SELECT c.code, c.label, c.note, c.status, c.max_devices, c.daily_limit_sec, c.duration_days, c.created_at, c.activated_at,
             c.expires_at, c.groq_hint, c.gemini_hint, c.total_sec, c.lectures, c.pdfs, c.last_active,
             (SELECT COALESCE(SUM(sec), 0) FROM usage u WHERE u.code = c.code AND u.kind = 'audio' AND u.ts > ?) AS used_sec
      FROM codes c ORDER BY c.created_at DESC`, now - DAY);
    const devices = this.#all("SELECT id, code, os, browser, screen, first_seen, last_seen, ip, country, city FROM devices");
    const byCode = {};
    for (const d of devices) (byCode[d.code] ||= []).push({ id: d.id.slice(0, 10), os: d.os, browser: d.browser, screen: d.screen, first_seen: d.first_seen, last_seen: d.last_seen, country: d.country, city: d.city });
    const list = codes.map((c) => ({
      ...c,
      display: displayCode(c.code),
      groq: !!c.groq_hint,
      gemini: !!c.gemini_hint,
      expired: !!(c.expires_at && now > c.expires_at),
      devices: byCode[c.code] || []
    }));
    for (const c of list) {
      delete c.groq_hint;
      delete c.gemini_hint;
    }
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
    const today = this.#row("SELECT COALESCE(SUM(CASE WHEN kind = 'audio' THEN sec ELSE 0 END), 0) AS sec, COUNT(DISTINCT code) AS users FROM usage WHERE ts > ?", now - DAY);
    const events = this.#all("SELECT ts, type, code, ip, country, detail FROM events ORDER BY id DESC LIMIT 80").map((e) => ({ ...e, code: e.code ? displayCode(e.code) : null }));
    return {
      ok: true,
      now,
      build: BUILD,
      totals: { ...totals, today_sec: today.sec, today_users: today.users },
      days: days.map((d) => ({ ...d, date: d.day * DAY - TZ_OFFSET })),
      codes: list,
      events,
      settings: this.#config(),
      password_changed: !!this.#setting("admin_pw")
    };
  }
  async adminCreateCodes(token, { count = 1, label = "", note = "", days = null, max_devices = 1, daily_hours = null } = {}) {
    if (!await this.#admin(token)) return { ok: false, status: 401, error: "unauthorized" };
    const cfg = this.#config();
    const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 200);
    const limit = Math.round(Math.min(Math.max(Number(daily_hours) || cfg.defaultDailyHours, 0.25), 24) * 3600);
    const dur = days ? Math.min(Math.max(parseInt(days, 10) || 0, 1), 3650) : null;
    const maxDev = Math.min(Math.max(parseInt(max_devices, 10) || 1, 1), 10);
    const created = [];
    for (let i = 0; i < n; i++) {
      let code;
      do {
        code = newCode();
      } while (this.#row("SELECT 1 AS x FROM codes WHERE code = ?", code));
      const lbl = n > 1 && label ? `${label} ${i + 1}` : label;
      this.sql.exec(
        "INSERT INTO codes (code, label, note, max_devices, daily_limit_sec, duration_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        code,
        String(lbl).slice(0, 80),
        String(note).slice(0, 200),
        maxDev,
        limit,
        dur,
        Date.now()
      );
      created.push(displayCode(code));
    }
    this.#event("codes_created", { detail: `${n}` });
    return { ok: true, created };
  }
  async adminUpdateCode(token, rawCode, patch = {}) {
    if (!await this.#admin(token)) return { ok: false, status: 401, error: "unauthorized" };
    const code = normalizeCode(rawCode);
    const row = this.#row("SELECT * FROM codes WHERE code = ?", code);
    if (!row) return { ok: false, status: 404, error: "not_found" };
    if (typeof patch.label === "string") this.sql.exec("UPDATE codes SET label = ? WHERE code = ?", patch.label.slice(0, 80), code);
    if (typeof patch.note === "string") this.sql.exec("UPDATE codes SET note = ? WHERE code = ?", patch.note.slice(0, 200), code);
    if ((patch.status === "active" || patch.status === "suspended") && patch.status !== row.status) {
      this.sql.exec("UPDATE codes SET status = ? WHERE code = ?", patch.status, code);
      this.#event(patch.status === "active" ? "code_resumed" : "code_suspended", { code });
    }
    if (patch.max_devices !== void 0) this.sql.exec("UPDATE codes SET max_devices = ? WHERE code = ?", Math.min(Math.max(parseInt(patch.max_devices, 10) || 1, 1), 10), code);
    if (patch.daily_hours !== void 0) this.sql.exec("UPDATE codes SET daily_limit_sec = ? WHERE code = ?", Math.round(Math.min(Math.max(Number(patch.daily_hours) || 8, 0.25), 24) * 3600), code);
    if (patch.expires_at !== void 0) {
      const v = patch.expires_at === null ? null : Number(patch.expires_at) || null;
      this.sql.exec("UPDATE codes SET expires_at = ?, duration_days = NULL WHERE code = ?", v, code);
    }
    if (patch.extend_days) {
      const base = Math.max(Date.now(), row.expires_at || 0);
      if (row.activated_at) this.sql.exec("UPDATE codes SET expires_at = ? WHERE code = ?", base + Number(patch.extend_days) * DAY, code);
      else this.sql.exec("UPDATE codes SET duration_days = COALESCE(duration_days, 0) + ? WHERE code = ?", Number(patch.extend_days), code);
    }
    return { ok: true };
  }
  async adminResetDevices(token, rawCode) {
    if (!await this.#admin(token)) return { ok: false, status: 401, error: "unauthorized" };
    const code = normalizeCode(rawCode);
    this.sql.exec("DELETE FROM devices WHERE code = ?", code);
    this.sql.exec("DELETE FROM attempts WHERE key = ?", `mv:${code}`);
    this.#event("devices_reset", { code });
    return { ok: true };
  }
  async adminDeleteCode(token, rawCode) {
    if (!await this.#admin(token)) return { ok: false, status: 401, error: "unauthorized" };
    const code = normalizeCode(rawCode);
    this.sql.exec("DELETE FROM devices WHERE code = ?", code);
    this.sql.exec("DELETE FROM usage WHERE code = ?", code);
    this.sql.exec("DELETE FROM codes WHERE code = ?", code);
    this.#event("code_deleted", { code });
    return { ok: true };
  }
  async adminSaveSettings(token, patch = {}) {
    if (!await this.#admin(token)) return { ok: false, status: 401, error: "unauthorized" };
    const cur = this.#setting("config", {}) || {};
    const next = { ...cur };
    const strList = /* @__PURE__ */ __name((v) => Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && /^[\w./:-]{2,80}$/.test(x)), "strList");
    if (patch.support && typeof patch.support === "object") {
      const url = String(patch.support.url || "").trim().slice(0, 200);
      next.support = { label: String(patch.support.label || "").slice(0, 60), url: /^(https:\/\/|tel:|mailto:)/i.test(url) ? url : "" };
    }
    if (typeof patch.notice === "string") next.notice = patch.notice.slice(0, 300);
    if (patch.defaultDailyHours !== void 0) next.defaultDailyHours = Math.min(Math.max(Number(patch.defaultDailyHours) || 8, 0.25), 24);
    if (patch.pdfPerDay !== void 0) next.pdfPerDay = Math.min(Math.max(parseInt(patch.pdfPerDay, 10) || 20, 1), 500);
    if (patch.moveLimit !== void 0) next.moveLimit = Math.min(Math.max(parseInt(patch.moveLimit, 10) || 0, 0), 10);
    if (patch.chunkSec !== void 0) next.chunkSec = Math.min(Math.max(parseInt(patch.chunkSec, 10) || 360, 60), 900);
    if (patch.overlapSec !== void 0) next.overlapSec = Math.min(Math.max(Number(patch.overlapSec) || 3, 0), 10);
    for (const k of ["sttModels", "geminiModels", "groqModels"]) if (strList(patch[k])) next[k] = patch[k].slice(0, 12);
    this.#putSetting("config", next);
    return { ok: true, settings: this.#config() };
  }
  async adminChangePassword(token, current, next) {
    if (!await this.#admin(token)) return { ok: false, status: 401, error: "unauthorized" };
    if (typeof next !== "string" || next.length < 8) return { ok: false, status: 400, error: "weak" };
    if (!await this.#checkPassword(String(current || ""))) return { ok: false, status: 403, error: "wrong_password" };
    const salt = randomToken(16);
    this.#putSetting("admin_pw", { salt, hash: await this.#hashPassword(next, salt) });
    const keep = await sha256hex(token);
    this.sql.exec("DELETE FROM admin_sessions WHERE id != ?", keep);
    this.#event("admin_password_changed", {});
    return { ok: true };
  }
};
var SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), geolocation=(), microphone=(self)"
};
var CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://upload.wikimedia.org https://thumb.wikimedia.org https://api.openverse.org",
  "media-src 'self' blob:",
  "connect-src 'self' https://commons.wikimedia.org https://en.wikipedia.org https://upload.wikimedia.org https://thumb.wikimedia.org https://api.openverse.org",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");
function store(env) {
  return env.STORE.get(env.STORE.idFromName("main"), { locationHint: "enam" });
}
__name(store, "store");
async function deviceId(request) {
  const secret = cookies(request)[DEVICE_COOKIE];
  return secret && /^[\w-]{30,80}$/.test(secret) ? sha256hex(secret) : null;
}
__name(deviceId, "deviceId");
function serveAsset(request, asset) {
  const etag = `"${BUILD}"`;
  const headers = {
    "content-type": asset.type,
    etag,
    "cache-control": asset.immutable ? "public, max-age=604800" : "no-cache",
    ...SECURITY_HEADERS
  };
  if (asset.type.startsWith("text/html")) headers["content-security-policy"] = CSP;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(asset.body, { headers });
}
__name(serveAsset, "serveAsset");
function relay(upstream, extra = {}) {
  const headers = { "cache-control": "no-store", ...extra };
  for (const h of [
    "content-type",
    "retry-after",
    "x-ratelimit-remaining-audio-seconds",
    "x-ratelimit-reset-audio-seconds",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-requests"
  ]) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
__name(relay, "relay");
var FETCH_ALLOW = [
  [/^commons\.wikimedia\.org$/, /^\/w\/api\.php$/],
  [/^en\.wikipedia\.org$/, /^\/w\/api\.php$/],
  [/^upload\.wikimedia\.org$/, /^\/wikipedia\//],
  [/^thumb\.wikimedia\.org$/, /^\//],
  [/^openi\.nlm\.nih\.gov$/, /^\/(api\/search$|imgs\/)/],
  [/^api\.openverse\.org$/, /^\/v1\/images\//]
];
var fetchAllowed = /* @__PURE__ */ __name((u) => u.protocol === "https:" && !u.username && !u.port && FETCH_ALLOW.some(([host, path]) => host.test(u.hostname) && path.test(u.pathname)), "fetchAllowed");
async function proxyFetch(request, target) {
  const ua = `MediVoice/1.0 (${new URL(request.url).origin}; medical lecture notes tool)`;
  let up;
  try {
    up = await fetch(target.href, { headers: { "user-agent": ua, "api-user-agent": ua, accept: "application/json, image/*" }, redirect: "follow", signal: AbortSignal.timeout(25e3) });
  } catch {
    return json({ error: "upstream" }, 502);
  }
  let final;
  try {
    final = new URL(up.url || target.href);
  } catch {
    final = target;
  }
  if (!fetchAllowed(final)) return json({ error: "forbidden" }, 403);
  if (!up.ok) return json({ error: "upstream", status: up.status }, up.status === 429 ? 429 : 502);
  const type = (up.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!/^(application\/json|image\/(jpeg|png|webp|gif))$/.test(type)) return json({ error: "unsupported_type" }, 415);
  if (Number(up.headers.get("content-length") || 0) > 25 * 1024 * 1024) return json({ error: "too_large" }, 413);
  return new Response(up.body, {
    headers: {
      "content-type": type,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin"
    }
  });
}
__name(proxyFetch, "proxyFetch");
async function verifyKey(provider, key) {
  try {
    const res = provider === "groq" ? await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${key}` } }) : await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key } });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403 || res.status === 400) return { ok: false, error: "bad_key" };
    return { ok: false, error: "provider_down", status: res.status };
  } catch {
    return { ok: false, error: "provider_down" };
  }
}
__name(verifyKey, "verifyKey");
async function listModels(auth) {
  const out = { groq: [], gemini: [] };
  const jobs = [];
  if (auth.groq) {
    jobs.push(fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${auth.groq}` } }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.data) out.groq = d.data.filter((m) => m.active !== false).map((m) => m.id);
    }).catch(() => {
    }));
  }
  if (auth.gemini) {
    jobs.push(fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=300", { headers: { "x-goog-api-key": auth.gemini } }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.models) out.gemini = d.models.filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
    }).catch(() => {
    }));
  }
  await Promise.all(jobs);
  return out;
}
__name(listModels, "listModels");
async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const db = store(env);
  if (method !== "GET" && request.headers.get("x-mv") !== "1") return json({ error: "bad_request" }, 400);
  if (path.startsWith("/api/admin/")) {
    const token = cookies(request)[ADMIN_COOKIE] || "";
    const ip = request.headers.get("cf-connecting-ip") || "";
    const body = method === "GET" || method === "DELETE" ? {} : await request.json().catch(() => ({}));
    const reply = /* @__PURE__ */ __name((r, headers) => json(r, r.ok ? 200 : r.status || 400, headers), "reply");
    if (path === "/api/admin/login" && method === "POST") {
      const r = await db.adminLogin(body.password, ip);
      if (!r.ok) return reply(r);
      return json({ ok: true }, 200, { "set-cookie": setCookie(ADMIN_COOKIE, r.token, { maxAge: 43200, sameSite: "Strict" }) });
    }
    if (path === "/api/admin/logout" && method === "POST") {
      await db.adminLogout(token);
      return json({ ok: true }, 200, { "set-cookie": setCookie(ADMIN_COOKIE, "", { maxAge: 0, sameSite: "Strict" }) });
    }
    if (path === "/api/admin/overview" && method === "GET") return reply(await db.adminOverview(token));
    if (path === "/api/admin/codes" && method === "POST") return reply(await db.adminCreateCodes(token, body));
    if (path === "/api/admin/settings" && method === "PUT") return reply(await db.adminSaveSettings(token, body));
    if (path === "/api/admin/password" && method === "POST") return reply(await db.adminChangePassword(token, body.current, body.next));
    const m = path.match(/^\/api\/admin\/codes\/([\w-]{8,14})(\/reset)?$/);
    if (m) {
      if (m[2] && method === "POST") return reply(await db.adminResetDevices(token, m[1]));
      if (!m[2] && method === "PATCH") return reply(await db.adminUpdateCode(token, m[1], body));
      if (!m[2] && method === "DELETE") return reply(await db.adminDeleteCode(token, m[1]));
    }
    return json({ error: "not_found" }, 404);
  }
  if (path === "/api/session" && method === "GET") {
    let fp = {};
    try {
      fp = JSON.parse(url.searchParams.get("fp") || "{}");
    } catch {
    }
    const id2 = await deviceId(request);
    return json(await db.session(id2, clientMeta(request, fp)));
  }
  if (path === "/api/activate" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    let secret = cookies(request)[DEVICE_COOKIE];
    if (!secret || !/^[\w-]{30,80}$/.test(secret)) secret = randomToken();
    const r = await db.activate(await sha256hex(secret), body.code, clientMeta(request, body.fp || {}));
    if (!r.ok) return json({ error: r.error }, r.status || 400);
    return json(r.session, 200, { "set-cookie": setCookie(DEVICE_COOKIE, secret, { maxAge: 400 * 86400 }) });
  }
  const id = await deviceId(request);
  if (!id) return json({ error: "locked" }, 401);
  if (path === "/api/keys" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const key = String(body.key || "").trim();
    if (key.length < 20 || key.length > 300 || /\s/.test(key)) return json({ error: "bad_key" }, 400);
    let provider = body.provider;
    if (provider !== "groq" && provider !== "gemini") provider = key.startsWith("gsk_") ? "groq" : "gemini";
    if (!await db.isActive(id)) return json({ error: "locked" }, 401);
    const v = await verifyKey(provider, key);
    if (!v.ok) return json({ error: v.error, provider }, v.error === "bad_key" ? 400 : 502);
    const r = await db.setKey(id, provider, key);
    return r.ok ? json({ ...r.session, linked: provider }) : json({ error: r.error }, r.status);
  }
  if (path === "/api/keys" && method === "DELETE") {
    const provider = url.searchParams.get("provider");
    if (provider !== "groq" && provider !== "gemini") return json({ error: "bad_request" }, 400);
    const r = await db.removeKey(id, provider);
    return r.ok ? json(r.session) : json({ error: r.error }, r.status);
  }
  if (path === "/api/fetch" && method === "GET") {
    if (!await db.isActive(id)) return json({ error: "locked" }, 401);
    let target;
    try {
      target = new URL(url.searchParams.get("u") || "");
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    if (!fetchAllowed(target)) return json({ error: "forbidden" }, 403);
    return proxyFetch(request, target);
  }
  if (path === "/api/models" && method === "GET") {
    const auth = await db.authorize(id, { kind: "both" });
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    return json(await listModels(auth));
  }
  const sec = Math.min(Math.max(Number(url.searchParams.get("sec")) || 0, 0), 1800);
  if (path === "/api/stt" && method === "POST") {
    const auth = await db.authorize(id, { kind: "groq", sec });
    if (!auth.ok) return json(auth, auth.status);
    if (!auth.groq) return json({ error: "no_key", provider: "groq" }, 412);
    const up = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${auth.groq}`, "content-type": request.headers.get("content-type") || "" },
      body: request.body
    });
    if (up.ok && sec > 0) ctx.waitUntil(db.logUsage(auth.code, "audio", sec));
    return relay(up);
  }
  if (path === "/api/groq" && method === "POST") {
    const auth = await db.authorize(id, { kind: "groq" });
    if (!auth.ok) return json(auth, auth.status);
    if (!auth.groq) return json({ error: "no_key", provider: "groq" }, 412);
    const up = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${auth.groq}`, "content-type": "application/json" },
      body: request.body
    });
    return relay(up);
  }
  if (path === "/api/gemini" && method === "POST") {
    const model = url.searchParams.get("model") || "";
    if (!/^[a-z0-9][a-z0-9.-]{2,60}$/.test(model)) return json({ error: "bad_model" }, 400);
    const auth = await db.authorize(id, { kind: "gemini", sec });
    if (!auth.ok) return json(auth, auth.status);
    if (!auth.gemini) return json({ error: "no_key", provider: "gemini" }, 412);
    const up = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": auth.gemini, "content-type": "application/json" },
      body: request.body
    });
    if (up.ok && sec > 0) ctx.waitUntil(db.logUsage(auth.code, "audio", sec));
    return relay(up);
  }
  if (path === "/api/done" && method === "POST") {
    const auth = await db.authorize(id, {});
    if (!auth.ok) return json(auth, auth.status);
    await db.logUsage(auth.code, "lecture", 0);
    return json({ ok: true });
  }
  if (path === "/api/pdf" && method === "POST") {
    if (!env.BROWSER?.quickAction) return json({ error: "pdf_unavailable" }, 503);
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 12 * 1024 * 1024) return json({ error: "too_large" }, 413);
    const auth = await db.authorize(id, { kind: "pdf" });
    if (!auth.ok) return json(auth, auth.status);
    const html = await request.text();
    if (html.length > 14e6) return json({ error: "too_large" }, 413);
    if (auth.wait_ms > 0) await new Promise((r) => setTimeout(r, auth.wait_ms));
    const paged = html.lastIndexOf("mv-ready") > 0;
    let res;
    try {
      res = await env.BROWSER.quickAction("pdf", {
        html,
        pdfOptions: { format: "a4", printBackground: true, preferCSSPageSize: true },
        ...paged ? { gotoOptions: { waitUntil: "load", timeout: 45e3 }, waitForSelector: { selector: "html.mv-ready", timeout: 3e4 } } : { gotoOptions: { waitUntil: "networkidle0", timeout: 45e3 } }
      });
    } catch (e) {
      return json({ error: "pdf_failed", detail: String(e?.message || e).slice(0, 200) }, 502);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      const error = res.status !== 429 ? "pdf_failed" : /time limit|for today/i.test(detail) ? "pdf_quota" : "pdf_busy";
      return json({ error, detail }, res.status === 429 ? 429 : 502);
    }
    ctx.waitUntil(db.logUsage(auth.code, "pdf", 0));
    return new Response(res.body, { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
  }
  return json({ error: "not_found" }, 404);
}
__name(handleApi, "handleApi");
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, ctx, url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
      let path = url.pathname;
      if (path === "/") path = "/index.html";
      if (path === "/admin" || path === "/admin/") path = "/admin.html";
      const asset = ASSETS[path];
      if (!asset) return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
      if (asset.gated) {
        const id = await deviceId(request);
        if (!id || !await store(env).isActive(id)) return new Response("Locked", { status: 403, headers: SECURITY_HEADERS });
      }
      return serveAsset(request, asset);
    } catch (e) {
      console.error("unhandled", e?.stack || e);
      return json({ error: "server_error" }, 500);
    }
  }
};
export {
  MediVoiceStore,
  worker_default as default
};
