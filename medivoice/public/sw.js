// sw.js — عامل الخدمة. وظيفته الوحيدة: استلام تسجيل يشاركه الطالب من تطبيق ثاني (المسجل، الواتساب، التيليكرام،
// الملفات) عن طريق «مشاركة ← ميدي فويز» بالأندرويد (Web Share Target، معرّف بـ manifest.webmanifest).
// ما يخزّن ملفات الموقع ولا يتدخل بأي طلب ثاني: كل الطلبات الأخرى تمر للشبكة كما هي.

const BOX = 'mv-shared';
const SLOT = '/__mv-shared';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'POST') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname !== '/share') return;
  e.respondWith(receive(req));
});

async function receive(req) {
  try {
    const form = await req.formData();
    const file = form.getAll('audio').find((f) => f && typeof f === 'object' && f.size > 0);
    if (!file) return Response.redirect('/#mv-share-empty', 303);
    const cache = await caches.open(BOX);
    // تسجيل واحد ينتظر بكل مرة: الجديد يحل محل القديم
    await cache.put(SLOT, new Response(file, {
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-mv-name': encodeURIComponent(file.name || ''),
        'x-mv-at': String(Date.now()),
      },
    }));
    return Response.redirect('/#mv-share', 303);
  } catch {
    return Response.redirect('/#mv-share-fail', 303);
  }
}
