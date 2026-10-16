// رابط قصير للموقع (Cloudflare Pages): كل طلب يمر كما هو للعامل medivoice عبر ربط خدمة (APP)،
// فالموقع نفسه وقاعدة بياناته واحدة، والرابطان يعملان معاً.
export default {
  async fetch(request, env) {
    if (env.APP) return env.APP.fetch(request);
    // احتياط: بلا ربط الخدمة، يمر الطلب عبر الرابط الأصلي
    const url = new URL(request.url);
    url.hostname = 'medivoice.nukhba-uni.workers.dev';
    return fetch(new Request(url, request));
  },
};
