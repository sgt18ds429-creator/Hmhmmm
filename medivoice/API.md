# ميدي فويز — دليل الـ API للمبرمج

هذا الملف يشرح كيف تتصل الواجهة بالخادم. كل الكود الموجود هنا هو نفس الكود الشغّال على https://medivoice.pages.dev.

## الصورة الكاملة باختصار

```
الهاتف (المتصفح / التطبيق)                         الخادم (Cloudflare Worker: src/server.js)
──────────────────────────                          ─────────────────────────────────────────
public/index.html + shell.js   ── /api/session ──►  التفعيل والأجهزة والأكواد
 (شاشة الكود والافتتاحية)       ── /api/activate ─►  Durable Object «MediVoiceStore» (SQLite)
                                                    
public/app/*.js  (المحرك كله)  ── /api/stt ──────►  بروكسي → Groq Whisper
 تقطيع الصوت، الاستماع،          ── /api/gemini ───►  بروكسي → Google Gemini
 الكتابة، الترجمة، الصور،        ── /api/groq ─────►  بروكسي → Groq Chat
 الملزمة، قالب الـ PDF          ── /api/fetch ────►  بروكسي صور (Wikimedia / NIH Open-i)
                                ── /api/pdf ──────►  HTML → PDF (Cloudflare Browser Run)
IndexedDB «medivoice» على الجهاز                    
 (المحاضرات والتسجيلات)                              
public/admin.*                 ── /api/admin/* ──►  لوحة المدير
```

**مهم جداً:** «الذكاء» كله بالواجهة، داخل `public/app/`، والخادم بس:
- يتحقق من الكود والجهاز؛
- يحفظ مفاتيح الطالب مشفّرة؛
- يمرّر الطلبات للمزوّدين بمفاتيح الطالب؛
- يحسب الحد اليومي؛
- يولّد الـ PDF.

المحاضرات نفسها ما تنحفظ بالخادم أبداً. تنحفظ على جهاز الطالب فقط.

| الملف | شنو بيه |
| --- | --- |
| `public/app/pipeline.js` | المسار الكامل: الاستماع، تقسيم الأقسام، الكتابة، المراجعة، الترجمة، الصور، بوابة الجودة |
| `public/app/prompts.js` | كل تعليمات النماذج |
| `public/app/chunker.js` + `memfile.js` + `vendor.js` | تقطيع التسجيل وضغطه بالمتصفح (mediabunny 1.61.3) |
| `public/app/api.js` | **كل اتصال بالخادم يمر من هنا** (`makeIO()`) |
| `public/app/run.js` / `main.js` / `ui.js` | الشاشات |
| `public/app/doc.js` / `pdf.js` / `paged.js` | عرض الملزمة وقالب الـ PDF |
| `public/app/db.js` | التخزين على الجهاز (IndexedDB) |
| `public/app/slides.js` + `pdfjs*.js` | قراءة سلايدات PDF (pdf.js) |
| `public/shell.js` | الافتتاحية وشاشة التفعيل والجلسة |
| `public/admin.*` | لوحة المدير |
| `src/server.js` | الخادم كامل: كل المسارات بالدالة `handleApi` |

## قواعد عامة لكل الطلبات

- كل الردود JSON: `content-type: application/json`. الاستثناءات بالجدول تحت: ردود المزوّدين تمر كما هي، و `/api/pdf` يرجع PDF.
- **كل طلب غير GET لازم يحمل الترويسة `x-mv: 1`**، وإلا يرجع `400 {"error":"bad_request"}`. هذي حماية CSRF.
- **الهوية بالكوكي `mv_dev`.** هي سر عشوائي يصنعه الخادم عند التفعيل، بخصائص HttpOnly و Secure و SameSite=Lax، ومدتها 400 يوم. الخادم يحفظ الـ SHA-256 مالته فقط كمعرّف للجهاز.
- **المدير بالكوكي `mv_adm`** (SameSite=Strict، مدتها 12 ساعة).
- الخطأ دائماً بهذا الشكل: `{"error":"<رمز>"}` مع رمز HTTP مناسب. جدول الرموز بآخر الملف.
- رقم الإصدار `build` يرجع بكل جلسة. الواجهة تستعمله حتى تعرف إذا نزل تحديث.

## 1) الجلسة والتفعيل

### `GET /api/session?fp=<JSON>`
`fp` بصمة بسيطة للجهاز: `{"os":"iOS|Android|Windows|macOS|Linux|ChromeOS","scr":"390x844"}`، وتجي من `fingerprint()` بملف `shell.js`.

**إذا الجهاز مو مفعّل:**
```json
{ "active": false, "reason": "none|suspended|expired|device_mismatch", "support": {"label":"…","url":"…"}, "build": "202610281421" }
```

**إذا مفعّل:**
```json
{
  "active": true, "build": "202610281421",
  "support": { "label": "الدعم", "url": "https://t.me/…" }, "notice": "",
  "user": { "label": "اسم الطالب", "code": "MV-ABCD-EFGH", "expires_at": 1767225600000 },
  "keys": {
    "groq":   { "linked": true, "hint": "gsk_…ab12", "count": 1 },
    "gemini": { "linked": true, "hint": "AIza…cd34", "count": 2 }
  },
  "usage": { "used_sec": 1200, "limit_sec": 28800, "total_sec": 54000, "lectures": 9 },
  "config": { "chunkSec": 480, "overlapSec": 3, "sttModels": ["…"], "geminiModels": ["…"], "groqModels": ["…"], "transcribeModels": ["…"] }
}
```
- `limit_sec = 0` معناها بلا حد يومي.
- `config` قوائم النماذج اللي يضبطها المدير من اللوحة، والمحرك يقرأها من هنا.

### `POST /api/activate`
الجسم: `{"code":"MV-ABCD-EFGH","fp":{…}}`. الكود يُقبل بأي شكل، بشرطة أو بدونها، بحروف صغيرة أو كبيرة.

- **نجاح:** يرجع نفس رد الجلسة المفعّلة، ومعه `Set-Cookie: mv_dev=…`.
- **فشل:**

| الخطأ | الرمز |
| --- | --- |
| `invalid` | 404 |
| `suspended` | 403 |
| `expired` | 403 |
| `in_use` (الكود مستعمل على أجهزة بعدد الحد) | 409 |
| `too_many` (أكثر من 25 محاولة فاشلة من نفس الشبكة خلال 15 دقيقة) | 429 |

- مدة الكود تبدأ من أول تفعيل.
- نفس الهاتف إذا رجع بعد تسجيل خروج، أو من متصفح ثاني على نفس الهاتف، ياخذ مكانه وما يُحسب جهاز جديد. هذا محدود بعدد مرات يضبطه المدير.

### `POST /api/logout`
يمسح الكوكي. مكان الجهاز يبقى محجوز لنفس الهاتف.

## 2) مفاتيح الطالب

كل طالب يربط مفاتيحه من Google AI Studio و Groq. ممكن يربط لحد 6 مفاتيح من كل مزوّد. المفاتيح تنحفظ مشفّرة (AES-GCM بالسر `KEYS_SECRET`)، وما ترجع للواجهة أبداً، فقط تلميح مثل `AIza…cd34`.

### `POST /api/keys`
الجسم: `{"key":"<مفتاح أو عدة مفاتيح مفصولة بمسافة أو سطر أو فاصلة>","provider":"gemini|groq","add":false}`
- `provider` اختياري: المفتاح اللي يبدأ بـ `gsk_` يُعتبر Groq.
- `add: true` يضيف المفاتيح الجديدة للمربوطة. بدونه تتبدّل كلها.
- الخادم يفحص كل مفتاح عند المزوّد قبل ما يحفظه.

**نجاح:** يرجع رد الجلسة ومعه `"linked":"gemini","shared":0`.

**فشل:**

| الخطأ | الرمز | المعنى |
| --- | --- | --- |
| `bad_key` | 400 | مع `hint` |
| `key_restricted` | 400 | Google قفلت الحصة المجانية لهذا المشروع، فلازم مفتاح من حساب Google ثاني |
| `too_many_keys` | 400 | |
| `provider_down` | 502 | |
| `locked` | 401 | |

### `DELETE /api/keys?provider=gemini|groq`
يفك ربط المفاتيح، ويرجع الجلسة.

### `GET /api/models`
يرجع النماذج المتاحة على مفاتيح الطالب: `{"groq":["whisper-large-v3",…],"gemini":["gemini-…",…]}`.

## 3) بروكسي الذكاء الاصطناعي (قلب التحويل)

كل هذي المسارات تحتاج جهاز مفعّل. ترجع **رد المزوّد نفسه كما هو** (الرمز والجسم)، ومعه ترويسات الحدود: `retry-after` و `x-ratelimit-*`. الخادم يجرب مفاتيح الطالب بالترتيب: إذا مفتاح وصل حده أو انلغى، ينتقل للي بعده تلقائياً، ويتذكر المفتاح المستنفَد لحد ما يتجدد.

مسار الصوت (`/api/stt`) ومسار Gemini (`/api/gemini`) ياخذون معامل `sec`: عدد ثواني الصوت بهذا الطلب، وينحسب من الحد اليومي. ويحتاجون الترويسة `x-mv-req: <معرّف عشوائي ثابت للطلب>`، حتى إذا أُعيد نفس الطلب ما تنحسب ثوانيه مرتين.

### `POST /api/stt?sec=<ثواني>&m=<نموذج>` (تحويل الصوت لنص، Groq Whisper)
- الجسم `multipart/form-data` بنفس صيغة Groq / OpenAI `audio/transcriptions`:
  - `file`
  - `model`
  - `language`
  - `prompt`
  - `response_format=verbose_json`
  - `timestamp_granularities[]=word` و `timestamp_granularities[]=segment`
  - `temperature=0`
- المقطع حوالي 8 دقائق مضغوط Opus، وحجمه تقريباً 2 ميغا. التقطيع والضغط بـ `chunker.js`.

### `POST /api/gemini?model=<اسم النموذج>&sec=<ثواني>`
- الجسم JSON بصيغة Gemini `generateContent` الأصلية: `contents`، `systemInstruction`، `generationConfig`…
- الصوت يرسل `inline_data` بـ Base64.
- مثال على النموذج: `gemini-3.5-flash`.

### `POST /api/groq?m=<نموذج>`
الجسم JSON بصيغة OpenAI `chat/completions` (Groq).

### `GET /api/fetch?u=<رابط>`
- بروكسي صور ومعلومات، **فقط لنطاقات محددة**: Wikimedia Commons، Wikipedia API، upload.wikimedia.org، NIH Open-i، Openverse.
- الحد 25 ميغا.
- أي نطاق ثاني يرجع `403 forbidden`.

### أخطاء البروكسي (قبل ما يوصل الطلب للمزوّد)

| الخطأ | الرمز | المعنى |
| --- | --- | --- |
| `locked` | 401 | الجهاز مو مفعّل |
| `suspended` / `expired` | 401 | الكود موقوف أو منتهي |
| `no_key` | 412 | ماكو مفتاح مربوط لهذا المزوّد (مع `provider`) |
| `daily_limit` | 429 | الطالب وصل حده اليومي. الرد فيه: `retry_after` (ثواني لحد نص الليل بتوقيت بغداد)، و `used_sec`، و `limit_sec` |
| `bad_model` | 400 | اسم نموذج غير صالح |

## 4) الـ PDF والتسجيل

### `POST /api/pdf`
- الجسم: **مستند HTML كامل** كنص. تبنيه `pdf.js` و `paged.js`، والصور تكون مضمّنة داخله.
- الترويسة `x-mv-paged: 1` إذا المستند يرقّم صفحاته بنفسه ويضيف الصنف `mv-ready` على `<html>` لما يجهز.
- الحد 12 ميغا.
- **الرد:** `application/pdf` (بايتات الملف).

| الخطأ | الرمز | المعنى |
| --- | --- | --- |
| `pdf_limit` | 429 | الحد اليومي لملفات الطالب، يضبطه المدير |
| `pdf_busy` | 429 | المتصفح مشغول. أعد المحاولة بعد ثواني |
| `pdf_quota` | 429 | خلصت دقائق Cloudflare اليومية للموقع كله |
| `pdf_failed` | 502 | |
| `too_large` | 413 | |
| `pdf_unavailable` | 503 | |

- **البديل بالواجهة:** نافذة الطباعة من الجهاز.

### `POST /api/done`
يسجّل محاضرة مكتملة بالإحصائيات. الجسم فارغ.

### `POST /api/diag`
تقرير خطأ من الواجهة يظهر للمدير. الجسم:
```json
{"m":"الرسالة","at":"المكان","st":"المرحلة","b":"الإصدار"}
```

## 5) نقل البيانات من الروابط القديمة (`/api/move/*`)

هذا خاص بالموقع: ينقل محاضرات الزبائن القدماء من الرابط القديم للرابط الجديد. التطبيق ما يحتاجه. الكود بـ `public/move.js`.

## 6) لوحة المدير (`/api/admin/*`)

كل هذي المسارات تحتاج كوكي `mv_adm`، والطلبات غير GET تحتاج `x-mv: 1`.

| الطلب | الجسم | الرد |
| --- | --- | --- |
| `POST /api/admin/login` | `{"password":"…"}` | `Set-Cookie: mv_adm`. أخطاء: `wrong_password` 401، `too_many` 429 (6 محاولات خلال 15 دقيقة) |
| `POST /api/admin/logout` | — | |
| `GET /api/admin/overview` | — | كل الأكواد والأجهزة والاستهلاك والأحداث والإعدادات وتنبيهات المفاتيح |
| `GET /api/admin/diag` | — | تشخيص: الأحداث، صحة المفاتيح، أحجام الجداول |
| `POST /api/admin/codes` | `{"count":1,"label":"","note":"","days":30,"max_devices":1,"daily_hours":8}` | `{"ok":true,"created":[…]}` |
| `PATCH /api/admin/codes/<CODE>` | أي حقل من هذي: `label`، `note`، `status` (`active` أو `suspended`)، `max_devices`، `daily_hours`، `extend_days`، `expires_at` | |
| `DELETE /api/admin/codes/<CODE>` | — | |
| `POST /api/admin/codes/<CODE>/reset` | — | يمسح أجهزة الكود |
| `POST /api/admin/codes/<CODE>/check-keys` | — | يفحص مفاتيح الطالب: `{"results":[{"provider":"gemini","hint":"…cd34","state":"ok|restricted|invalid|unknown"}]}` |
| `PUT /api/admin/settings` | `support`، `notice`، `defaultDailyHours`، `pdfPerDay`، `moveLimit`، `chunkSec`، `overlapSec`، `sttModels`، `geminiModels`، `groqModels`، `transcribeModels`، `theme` | `{"ok":true,"settings":{…}}` |
| `POST /api/admin/password` | `{"current":"…","next":"…"}` (8 أحرف على الأقل) | أخطاء: `weak`، `wrong_password` |

## 7) مكان البيانات

### بالخادم: Durable Object «MediVoiceStore»، قاعدة SQLite واحدة

| الجدول | شنو بيه |
| --- | --- |
| `codes` | الأكواد: الاسم، الحالة، عدد الأجهزة، الحد اليومي، المدة، المفاتيح مشفّرة، الإحصائيات |
| `devices` | الأجهزة المفعّلة: SHA-256 لسر الكوكي، النظام، المتصفح، الشاشة، آخر ظهور |
| `usage` | ثواني الصوت والـ PDF والمحاضرات لكل كود (للحد اليومي) |
| `events` | سجل النشاط للوحة |
| `settings` | إعدادات الموقع والتصميم وكلمة سر المدير (hash + salt) |
| `key_health` / `key_notes` | ما تعلّمه الخادم عن مفاتيح كل طالب (حصة نفدت، مفتاح مقيّد أو ملغى) |
| `attempts` / `admin_sessions` | حدود المحاولات وجلسات المدير |
| `moves` / `move_parts` | النقل المؤقت من الروابط القديمة، وينمسح بعد الاستلام |

### على جهاز الطالب
- IndexedDB باسم `medivoice`، بالمخازن `lectures`، `index`، `parts`، `kv`. هنا المحاضرات والملازم والتسجيلات والتحويلات غير المكتملة.
- `localStorage` بمفاتيح تبدأ بـ `mv-`، للتفضيلات.

## 8) تشغيل نسخة خاصة للتطوير

```sh
npm ci
npm test                                      # 103 اختبار، بدون إنترنت ولا مفاتيح
npm run build                                 # يولّد dist/worker.js
npx wrangler dev -c wrangler.dev.jsonc        # http://127.0.0.1:8787
```

- **محلياً:** لازم ملف `.dev.vars` بجنب `wrangler.dev.jsonc`، وهذا الملف ما يُرفع لـ git. القيم من اختيارك، مو قيم الموقع الحقيقي:
  ```
  ADMIN_PASSWORD=<كلمة سر تختارها>
  KEYS_SECRET=<نص عشوائي طويل>
  ```
- توليد الـ PDF على الخادم ما يشتغل محلياً، فالواجهة تستعمل نافذة الطباعة.
- **لنسخة على حساب Cloudflare ثاني**، يحتاج عامل بهذي الأشياء:
  - ربط Durable Object باسم `STORE`، الصنف `MediVoiceStore`، و migration من نوع `new_sqlite_classes`؛
  - ربط Browser Run باسم `BROWSER`؛
  - السرّين `KEYS_SECRET` و `ADMIN_PASSWORD`؛
  - إذا اختلف الرابط الرئيسي، يتغيّر `HOME` بـ `src/server.js`.

**ممنوع تشغيل `tools/deploy.mjs` على الموقع الحقيقي إلا بموافقة صاحب المشروع.** هذا الأمر يبدّل كود الموقع الشغّال.

## 9) إذا تبني تطبيق أصلي (Native) يكلم الـ API مباشرة

الخادم الحالي مصمم لمتصفح يفتح نفس الرابط، فلازم تنتبه لهذي النقاط:

1. **الكوكيز:** الهوية بكوكي `mv_dev`، وهي HttpOnly و SameSite=Lax.
   - **WebView** يفتح `https://medivoice.pages.dev` يشتغل مثل ما هو.
   - **تطبيق أصلي** (Flutter، React Native، Swift، Kotlin) لازم يحفظ الكوكي من رد `/api/activate` ويرسلها بكل طلب (`Cookie: mv_dev=…`)، عن طريق cookie jar بمكتبة HTTP، ويرسل `x-mv: 1`.
   - هذا يشتغل بدون أي تعديل بالخادم، لأن الطلب من تطبيق أصلي ما يخضع لـ CORS.
2. **CORS:** الخادم ما يرسل ترويسات CORS. أي واجهة ويب على **رابط ثاني**، مثل تطبيق Capacitor أو Ionic يشتغل من `capacitor://localhost` أو `https://localhost`، رح ينمنع. الحل يحتاج تعديل بالخادم:
   - السماح لـ Origin التطبيق؛
   - ترويسة توكن بدل الكوكي.

   هذا التعديل **مو موجود**، ومقصود حتى ما يتأثر الموقع الحالي. إذا احتجته، يُضاف بشكل إضافي بدون ما يغيّر سلوك الموقع.
3. **المحرك:** إعادة كتابة `public/app/` بلغة ثانية شغل كبير جداً، تقريباً 9,700 سطر من المنطق والتعليمات. الأسهل والأضمن تشغيل نفس ملفات `public/` داخل WebView، فكل تحديث للموقع يوصل للتطبيق مباشرة.
4. **الخلفية:** التحويل يشتغل بالجهاز. إذا الهاتف وقّف التطبيق بالخلفية، التحويل يتوقف ويكمل عند الرجوع. لهذا الشاشة تبقى مضاءة أثناء التحويل.

## جدول رموز الأخطاء

| الرمز | المعنى |
| --- | --- |
| `bad_request` | ترويسة `x-mv` ناقصة أو جسم غير صالح |
| `locked` | الجهاز مو مفعّل، فاعرض شاشة الكود |
| `invalid` / `suspended` / `expired` / `in_use` | أخطاء التفعيل |
| `device_mismatch` | (بالجلسة) نفس الكوكي من نظام تشغيل مختلف، فلازم تفعيل جديد |
| `too_many` | محاولات كثيرة، انتظر |
| `bad_key` / `key_restricted` / `too_many_keys` / `provider_down` | ربط المفاتيح |
| `no_key` | ماكو مفتاح لهذا المزوّد |
| `daily_limit` | انتهت ساعات اليوم (`retry_after`) |
| `bad_model` | اسم النموذج غير صالح |
| `pdf_limit` / `pdf_busy` / `pdf_quota` / `pdf_failed` / `pdf_unavailable` / `too_large` | توليد الـ PDF |
| `forbidden` | رابط غير مسموح بـ `/api/fetch` |
| `unauthorized` / `wrong_password` / `weak` | لوحة المدير |
| `not_found` | مسار غير موجود |
