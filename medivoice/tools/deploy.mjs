// deploy.mjs — يرفع dist/worker.js إلى عامل Cloudflare الموجود بدون لمس إعداداته.
// يستخدم «Put script content» فتبقى الروابط (STORE و BROWSER) والأسرار (KEYS_SECRET و ADMIN_PASSWORD)
// وتاريخ التوافق كما هي على Cloudflare.
//
// CLOUDFLARE_API_TOKEN=... [CLOUDFLARE_ACCOUNT_ID=...] [MV_WORKER=medivoice] node tools/deploy.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.CLOUDFLARE_API_TOKEN;
const name = process.env.MV_WORKER || 'medivoice';
if (!token) { console.error('CLOUDFLARE_API_TOKEN غير موجود'); process.exit(1); }

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data.errors || data).slice(0, 400)}`);
  return data.result;
};

let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
  const list = await api('/accounts?per_page=50');
  if (list.length !== 1) throw new Error(`حدد CLOUDFLARE_ACCOUNT_ID (الحسابات: ${list.map((a) => `${a.id} ${a.name}`).join(' | ')})`);
  account = list[0].id;
}

// يتأكد أن العامل موجود ويطبع روابطه قبل الرفع
const settings = await api(`/accounts/${account}/workers/scripts/${name}/settings`);
console.log(`العامل ${name}: compatibility_date=${settings.compatibility_date || '?'} · الروابط: ${(settings.bindings || []).map((b) => `${b.name}(${b.type})`).join(', ') || '—'}`);

const code = readFileSync(join(root, 'dist', 'worker.js'));
// حماية: نسخة بلا رقم إصدار حقيقي ما تُنشر (ملفاتها تبقى مخزّنة عند الزبائن وتمنع وصول التحديثات)
const build = /var BUILD = "([^"]+)"/.exec(code.toString('utf8', 0, 4000))?.[1];
if (!build || !/^\d{12}$/.test(build)) { console.error(`dist/worker.js رقمه «${build}»: شغّل node tools/build.mjs قبل النشر`); process.exit(1); }
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js' })], { type: 'application/json' }));
form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
let result = null;
for (let attempt = 1; attempt <= 3 && !result; attempt++) {
  try {
    result = await api(`/accounts/${account}/workers/scripts/${name}/content`, { method: 'PUT', body: form });
  } catch (e) {
    if (attempt === 3) throw e;
    console.log(`تعذّر الرفع (${e.message || e})، أعيد المحاولة ${attempt + 1}/3…`);
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
}
console.log(`تم الرفع: ${result?.id || name} · ${(code.length / 1024).toFixed(0)} KB`);
