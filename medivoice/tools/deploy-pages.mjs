// deploy-pages.mjs — الرابط القصير https://<name>.pages.dev: مشروع Cloudflare Pages صغير يمرّر كل الطلبات
// للعامل medivoice (ربط خدمة APP). يُنشأ المشروع أول مرة ثم يُرفع tools/pages/_worker.js.
// التوكن يحتاج صلاحية Account → Cloudflare Pages → Edit.
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... NODE_USE_ENV_PROXY=1 node tools/deploy-pages.mjs [name]
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] || 'medivoice';
const acc = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
if (!acc || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID و CLOUDFLARE_API_TOKEN مطلوبان');
const api = async (path, init = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ...d };
};

let p = await api(`/pages/projects/${name}`);
if (p.status === 404 || p.errors?.some((e) => e.code === 8000007)) {
  const binding = { services: { APP: { service: 'medivoice', environment: 'production' } } };
  p = await api('/pages/projects', { method: 'POST', body: JSON.stringify({ name, production_branch: 'main', deployment_configs: { production: binding, preview: binding } }) });
  if (!p.success) throw new Error(`إنشاء المشروع: ${JSON.stringify(p.errors)}`);
  console.log('أُنشئ المشروع', name);
} else if (!p.success) throw new Error(`قراءة المشروع: ${JSON.stringify(p.errors)}`);
const subdomain = p.result.subdomain;
execFileSync('npx', ['wrangler', 'pages', 'deploy', join(root, 'tools', 'pages'), '--project-name', name, '--branch', 'main', '--commit-dirty=true'], { stdio: 'inherit', env: process.env });
console.log(`الرابط: https://${subdomain}`);
