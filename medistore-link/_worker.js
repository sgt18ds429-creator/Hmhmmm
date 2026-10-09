/* رابط قصير لموقع MediStore على Cloudflare Pages.
   يمرر كل طلب للـ Worker الأصلي «medistore» عن طريق Service binding اسمه SITE،
   فالموقع والطلبات ولوحة التحكم تبقى نفسها بدون أي تغيير. */
export default {
  async fetch(request, env) {
    if (!env.SITE) {
      return new Response(
        'باقي خطوة وحدة: من Settings ← Bindings أضف Service binding باسم SITE واختار medistore، وبعدين ارفع الملف مرة ثانية.',
        { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }
    return env.SITE.fetch(request);
  }
};
