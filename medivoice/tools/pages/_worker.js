// رابط الموقع على Cloudflare Pages: كل طلب يمر كما هو للعامل medivoice عبر ربط خدمة (APP)، فالموقع نفسه
// وقاعدة بياناته واحدة. العامل يعرف أن هذا هو الرابط الرئيسي من اسم الرابط (HOME في src/server.js).
export default {
  async fetch(request, env) {
    if (env.APP) return env.APP.fetch(request);
    // بلا ربط الخدمة ما نمرّر للرابط الأصلي: العامل يعامله كرابط ثاني وينقل زائره هنا من جديد (حلقة)
    return new Response('الموقع يتحدّث الآن، جرّب بعد دقيقة.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' } });
  },
};
