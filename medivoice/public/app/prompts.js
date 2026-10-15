// prompts.js — نصوص التعليمات للنماذج. كل دالة ترجع { system, user }.

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

export function keywordList(meta) {
  return String(meta.keywords || '')
    .split(/[,،;\n]+/).map((s) => s.trim()).filter((s) => s.length > 1).slice(0, 30);
}

/** سياق قصير لـ Whisper بنفس أسلوب الكلام المتوقع (عربي مع مصطلحات إنجليزية). */
export function whisperPrompt(meta, prevTail = '') {
  const kws = keywordList(meta);
  if (meta.speech === 'en') {
    const base = `A medical lecture${meta.subject ? ' on ' + meta.subject : ''}${kws.length ? ', covering ' + kws.slice(0, 6).join(', ') : ''}.`;
    return clip(`${base} ${prevTail}`.trim(), 600);
  }
  const terms = (kws.filter((k) => /[A-Za-z]/.test(k)).length ? kws.filter((k) => /[A-Za-z]/.test(k)) : ['anatomy', 'diagnosis', 'CT scan']).slice(0, 3);
  const base = `محاضرة ${meta.subject ? 'في ' + meta.subject + ' ' : 'طبية '}عن ${terms.map((t) => 'الـ ' + t).join(' و')}.`;
  return clip(`${base} ${prevTail}`.trim(), 420);
}

function metaLine(meta) {
  const parts = [];
  if (meta.subject) parts.push(`المادة: ${meta.subject}`);
  if (meta.title) parts.push(`عنوان المحاضرة: ${meta.title}`);
  const kws = keywordList(meta);
  if (kws.length) parts.push(`مصطلحات متوقعة: ${kws.join('، ')}`);
  return parts.length ? `معلومات عن المحاضرة — ${parts.join(' | ')}` : '';
}

const STYLE = {
  verbatim: 'حافظ على كلمات المحاضر ولهجته كما هي ولا تحوّلها إلى فصحى. احذف فقط التأتأة وأصوات التردد (آآ، امم) والتكرار غير المقصود للكلمة نفسها.',
  formal: 'اكتب الكلام بعربية فصحى مبسّطة وواضحة، جملةً بجملة، مع الحفاظ على كل معلومة ومثال وعلى ترتيب الكلام. لا تختصر شيئاً.',
};

const FORMAT_RULES = `- المصطلحات الطبية والعلمية والاختصارات تُكتب بالحروف الإنجليزية وبإملائها الطبي الصحيح، وتوضع بين قوسين مزدوجين هكذا: [[pleural effusion]] و [[CT]]. حتى لو نطقها المحاضر بلكنة عربية فاكتبها بالإنجليزية.
- إذا تكلم المحاضر جملة كاملة بالإنجليزية فاكتبها بالإنجليزية كما قالها، وضع [[ ]] حول المصطلحات الطبية المهمة فيها فقط.
- قسّم النص إلى فقرات قصيرة يفصل بينها سطر فارغ.
- عند انتقال المحاضر إلى موضوع رئيسي جديد اكتب قبله سطر عنوان قصير يبدأ بـ "## " (بدون [[ ]] داخل العنوان).
- إذا عدّد المحاضر نقاطاً أو خطوات فاكتب كل واحدة في سطر يبدأ بـ "- ".
- إذا نبّه المحاضر أن معلومة مهمة أو تأتي بالامتحان فاكتب جملة تلك المعلومة كاملة مع تنبيهه في سطر مستقل يبدأ بـ "> ".
- الأرقام والنسب تُكتب أرقاماً: 50%، من 9 إلى 10.
- لا تكتب أي مقدمة أو خاتمة أو تعليق أو شرح من عندك. أخرج النص فقط.`;

/** تفريغ بالاستماع: الصوت + (اختيارياً) مسودة Whisper للمقطع نفسه. */
export function audioPrompt(meta, { draft = '', first = true, last = true, exact = false, insist = false, known = [] } = {}) {
  const style = STYLE[meta.style] || STYLE.verbatim;
  const system = `أنت مفرّغ صوتيات محترف متخصص بالمحاضرات الجامعية الطبية. تستمع إلى مقطع من تسجيل صوتي (غالباً محاضرة) وتكتب كل ما يُقال فيه كتابةً دقيقة وكاملة، كلمةً بكلمة.

القواعد:
- اكتب كل الكلام المسموع بالترتيب من أول المقطع إلى آخره، أياً كان نوعه: شرح، حوار، تعليق، هتاف، أو إنشاد وغناء فوق موسيقى. ممنوع التلخيص أو الحذف أو إضافة شيء لم يُقل.
- وجود موسيقى أو ضوضاء في الخلفية لا يعني عدم وجود كلام: اكتب الكلمات التي تسمعها.
- لا تكرر سطراً أو عبارة كتبتها من قبل إلا إذا سمعتها تُقال مرة أخرى فعلاً، وعندما ينتهي الكلام في المقطع توقّف عن الكتابة.
- الحوار القصير بين الأستاذ والطلبة (أسئلة وأجوبة) يُكتب متصلاً في فقرة واحدة لكل تبادل، لا سطراً منفصلاً لكل كلمة.
- ${style}
${FORMAT_RULES}
- إذا كان جزء غير مسموع فاكتب [غير واضح] ولا تخمّن. تجاهل همس الطلبة والضوضاء.
- إذا لم يكن في المقطع أي كلمات إطلاقاً (صمت تام أو موسيقى بلا كلام) فأخرج فقط: [لا يوجد كلام]`;

  const lines = [];
  const info = metaLine(meta);
  if (info) lines.push(info);
  if (!first) lines.push('هذا مقطع من وسط المحاضرة: لا تبدأ بعنوان إلا إذا بدأ موضوع جديد فعلاً.');
  if (known.length) lines.push(`مصطلحات وردت في الأجزاء السابقة من التسجيل نفسه. إذا سمعت أحدها فاكتبه بهذا الإملاء، ولا تُدخل منها شيئاً لم يُقل: ${known.join('، ')}`);
  if (draft) {
    lines.push(`هذه مسودة آلية للمقطع نفسه. فيها أخطاء كثيرة خصوصاً بالمصطلحات واللهجة وقد ينقصها كلام. اعتمد على ما تسمعه في الصوت، واستعن بالمسودة فقط لتتأكد أنك لم تفوّت شيئاً:
<<<
${draft}
>>>`);
    if (exact) {
      const words = draft.split(/\s+/);
      const head = words.slice(0, 6).join(' ');
      const tail = words.slice(-6).join(' ');
      const edges = [];
      if (!first) edges.push(`ابدأ الكتابة من الموضع الذي تبدأ عنده المسودة («${head}») وتجاهل ما قبله`);
      if (!last) edges.push(`توقّف عند الموضع الذي تنتهي عنده المسودة («${tail}») وتجاهل ما بعده`);
      if (edges.length) lines.push(`في الصوت ثوانٍ قليلة زائدة تابعة للمقاطع المجاورة. ${edges.join('، و')}.`);
    }
  } else if (!first || !last) {
    lines.push('قد يبدأ المقطع أو ينتهي بكلمة مقطوعة؛ اكتبها كما تسمعها.');
  }
  if (insist) lines.push('تنبيه: في هذا المقطع كلام أو غناء مسموع. اكتب كلماته كما تسمعها حتى لو كانت فوق موسيقى.');
  lines.push('اكتب الآن تفريغ المقطع كاملاً وفق القواعد.');
  return { system, user: lines.join('\n\n') };
}

/** تنقيح نصي فقط لمسودة Whisper (عند عدم توفر Gemini). */
export function cleanupPrompt(meta, draft, { first = true } = {}) {
  const style = STYLE[meta.style] || STYLE.verbatim;
  const system = `أنت مدقق تفريغ محاضرات طبية. يصلك نص مفرّغ آلياً من تسجيل محاضرة جامعية وفيه أخطاء تعرّف على الكلام. مهمتك إخراج النص نفسه كاملاً بعد تصحيحه وتنسيقه.

القواعد:
- أعد كتابة النص كاملاً بالترتيب نفسه. ممنوع التلخيص أو الحذف أو إضافة معلومات جديدة. عدد كلمات الناتج يجب أن يقارب عدد كلمات النص الأصلي.
- صحّح أخطاء التعرف الواضحة من السياق، خصوصاً المصطلحات الطبية المكتوبة بحروف عربية أو المشوّهة: اكتبها بالإنجليزية الصحيحة (مثال: «كارديوميجالي» ← [[cardiomegaly]]، «المنسكس ساين» ← [[meniscus sign]]).
- إذا لم تكن متأكداً من كلمة فاتركها كما هي.
- ${style}
${FORMAT_RULES}`;
  const info = metaLine(meta);
  const user = `${info ? info + '\n\n' : ''}${first ? '' : 'هذا جزء من وسط المحاضرة: لا تبدأ بعنوان إلا إذا بدأ موضوع جديد فعلاً.\n\n'}النص المفرّغ آلياً:
<<<
${draft}
>>>

أخرج النص المصحّح والمنسّق كاملاً.`;
  return { system, user };
}

/** قاموس المصطلحات: ترجمة وتعريف قصير لكل مصطلح. يرجع JSON. */
export function glossaryPrompt(meta, terms) {
  const system = `أنت أستاذ جامعي في العلوم الطبية ومترجم طبي متمرس تعدّ قاموس مصطلحات لطلبة عرب. تستخدم المصطلحات العربية المعتمدة في المعجم الطبي الموحد والكتب الطبية الجامعية، لا الترجمة الحرفية. أجب بصيغة JSON فقط.`;
  const user = `${metaLine(meta)}

لكل مصطلح في القائمة أعطِ:
- "en": المصطلح بالإملاء الطبي الصحيح بصيغة المفرد، ويبدأ بحرف كبير. إن كان اختصاراً فاكتبه مع فكّه مثل "CT (Computed Tomography)".
- "ar": المقابل العربي الطبي المعتمد حسب معناه في سياق المحاضرة (مثال: inspiration في التنفس = "الشهيق"، consolidation في الرئة = "تصلّد رئوي"، costophrenic angle = "الزاوية الضلعية الحجابية").
- "def": تعريف عربي دقيق وواضح لا يتجاوز 18 كلمة.
تجاهل ما ليس مصطلحاً علمياً (كلمات عامة أو أسماء أشخاص)، وادمج المفرد والجمع والصيغ المكررة في مدخل واحد.

المصطلحات:
${terms.map((t) => `- ${t}`).join('\n')}

أخرج: {"terms":[{"en":"...","ar":"...","def":"..."}]}`;
  return { system, user };
}

/** عنوان مقترح + مواضع الصور التوضيحية. يرجع JSON. */
export function figuresPrompt(meta, outline, maxFigures) {
  const system = `أنت محرر كتب جامعية (طبية غالباً). تضع عنواناً لنص مفرّغ من تسجيل وتقترح له صوراً توضيحية تُجلب من مكتبات صور مفتوحة (Wikimedia Commons و NIH Open-i). أجب بصيغة JSON فقط.`;
  const user = `${metaLine(meta)}

هذا مخطط المحاضرة. كل سطر يبدأ برقم الفقرة ثم نوعها (H عنوان، P فقرة، L قائمة، N ملاحظة) ثم بدايتها:

${outline}

المطلوب:
1. "title": عنوان دقيق وقصير يصف ما في النص فعلاً (بلغة النص؛ المصطلحات تبقى بالإنجليزية). لا تخترع موضوعاً طبياً أو علمياً غير موجود في النص.
2. "figures": حتى ${maxFigures} صور توضيحية لأهم المفاهيم التي تُفهم بالصورة (تشريح، صورة شعاعية، جهاز، مخطط آلية، شريحة مجهرية). لا تقترح صورة لمفهوم مجرد لا يُصوَّر. إذا لم يكن النص مادة علمية أو تعليمية (مثلاً أغنية أو حديث عام) فاجعلها قائمة فارغة []. لكل صورة:
   - "after": رقم الفقرة التي توضع الصورة بعدها مباشرة (الفقرة التي تشرح المفهوم).
   - "query": عبارة بحث إنجليزية قصيرة ودقيقة (2 إلى 5 كلمات) كما تُكتب في عنوان صورة طبية، مثل "pneumothorax chest radiograph" أو "circle of Willis diagram".
   - "alt": عبارة بحث بديلة أعم قليلاً.
   - "kind": واحد من "radiograph" (أشعة/CT/MRI/سونار) أو "diagram" (رسم تشريحي أو مخطط) أو "photo" (جهاز أو حالة سريرية) أو "micrograph" (مجهرية).
   - "show": ما يجب أن تُظهره الصورة بالضبط، بالإنجليزية وبدقة (العضو، المنطقة، نوع التصوير، والعلامة أو التفصيل المطلوب).
   - "caption": تعليق عربي قصير يصف ما تبيّنه الصورة (المصطلحات بالإنجليزية).
وزّع الصور على أقسام المحاضرة ولا تكرر المفهوم نفسه.

أخرج: {"title":"...","figures":[{"after":0,"query":"...","alt":"...","kind":"...","show":"...","caption":"..."}]}`;
  return { system, user };
}

// ───────────── الشرح المفصل (الملزمة المشروحة) ─────────────

const KIND_LABEL = {
  radiograph: 'صورة شعاعية (أشعة سينية أو CT أو MRI أو سونار)',
  diagram: 'رسم تشريحي أو مخطط توضيحي',
  photo: 'صورة حقيقية لجهاز أو أداة أو حالة سريرية',
  micrograph: 'صورة مجهرية (شريحة نسيجية)',
};

/** خطة المحاضرة: نوع التسجيل، العنوان، والأقسام حسب المواضيع. يرجع JSON. */
export function notesPlanPrompt(meta, numbered, { lang = 'ar', condensed = false, slides = null } = {}) {
  const system = `أنت أستاذ جامعي خبير ومحرر كتب جامعية طبية. يصلك تفريغ آلي لتسجيل محاضرة (فيه أخطاء سمع وتكرار)${slides ? ' ومعه نص سلايدات المحاضرة نفسها' : ''}. مهمتك أن تفهم المحاضرة كلها وتقسمها إلى أقسام حسب المواضيع التي شرحها المحاضر. أجب بصيغة JSON فقط.`;
  const slideList = slides ? `\n\nسلايدات المحاضرة (رقم الصفحة ثم بداية نصها):\n<<<\n${slides.map((p) => `[ص${p.page}] ${clip(String(p.text || '').replace(/\s+/g, ' '), 160)}`).join('\n')}\n>>>` : '';
  const user = `${metaLine(meta)}

هذا تفريغ المحاضرة مقسماً إلى فقرات مرقمة، رقم كل فقرة بين قوسين مربعين في أولها${condensed ? ' (من كل فقرة بدايتها فقط)' : ''}:
<<<
${numbered}
>>>${slideList}

المطلوب:
1. "kind": "lecture" إذا كان التسجيل محاضرة أو مادة تعليمية أو علمية، أو "other" إذا لم يكن كذلك (أغنية، حديث عام، تسجيل بلا محتوى تعليمي).
2. "title": عنوان المحاضرة كما يكتبه أستاذ على غلاف ملزمة: قصير (3 إلى 10 كلمات) ومحدد يصف موضوعها الفعلي كما شُرح (${lang === 'en' ? 'بالإنجليزية' : 'بالعربية، والمصطلحات بالإنجليزية'}، بدون [[ ]])، لا جملة طويلة ولا وصف لنوع النص (لا «مقال» ولا «دراسة حالة» ولا «محاضرة عن»). لا تخترع موضوعاً غير موجود.
3. "sections": أقسام المحاضرة بالترتيب. كل قسم موضوع رئيسي واحد متماسك. لكل قسم:
   - "from": رقم أول فقرة في القسم. القسم يمتد حتى الفقرة التي قبل بداية القسم التالي، والقسم الأول يبدأ من 0.
   - "title": عنوان واضح ومحدد لموضوع القسم (${lang === 'en' ? 'بالإنجليزية' : 'بالعربية، والمصطلحات بالإنجليزية'}، بدون [[ ]]).
   - "points": سطر واحد بأهم ما يشرحه القسم.${slides ? '\n   - "pages": أرقام صفحات السلايدات التي تخص هذا القسم [أول صفحة، آخر صفحة]. كل صفحة تخص قسماً واحداً، وصفحات العنوان والمراجع تُضم لأقرب قسم.' : ''}
   الأفضل أن يكون القسم بين 300 و 1500 كلمة تقريباً من التفريغ. الكلام الإداري في البداية (التحية والحضور والإعلانات) يُضم للقسم الذي يليه.

أخرج: {"kind":"lecture","title":"...","sections":[{"from":0,"title":"...","points":"..."${slides ? ',"pages":[1,4]' : ''}}]}`;
  return { system, user };
}

const NOTES_RULES = {
  ar: `أنت أستاذ جامعي خبير في العلوم الطبية ومؤلف ملازم دراسية مشهود له بالوضوح. يصلك جزء من تفريغ آلي لتسجيل محاضرة جامعية، وتكتب منه شرحاً مكتوباً مفصلاً يذاكر منه الطالب بدل سماع التسجيل، فيفهم منه كل ما قاله المحاضر.

1) الشمول، وهو أهم قاعدة:
- اكتب كل معلومة وردت في هذا الجزء: كل تعريف وشرح وسبب وآلية وعلامة وعرض وتصنيف ونوع وفرق ومثال وحالة ورقم ونسبة وقيمة وخطوة وعلاج وتنبيه.
- هذا شرح مفصل وليس ملخصاً: ممنوع اختصار الأفكار أو دمجها بطريقة تُضيع تفاصيلها، وممنوع إسقاط أي نقطة علمية حتى الصغيرة أو الجانبية منها.
- إذا وضّح المحاضر فكرة بمثال أو تشبيه أو حالة مريض فاكتبه أيضاً، لأنه يساعد على الفهم.
- احذف فقط ما ليس علماً: التحية والكلام الإداري والمزاح والنداء على الطلبة، والتكرار الحرفي للفكرة نفسها (اكتبها مرة واحدة بأوضح وأكمل صيغة).
- إذا كانت المحاضرة نقاشاً أو حالة سريرية بأسئلة وأجوبة بين الأستاذ والطلبة، فحوّل الحوار إلى شرح علمي منظم: المعلومة الصحيحة التي استقر عليها النقاش، وتصحيحات الأستاذ، وطريقة التفكير السريري؛ ولا تنقل الحوار سطراً بسطر.
- التفريغ الآلي قد يكرر السطر أو المقطع نفسه مرات متتالية (خلل في التفريغ وليس كلام المحاضر): اكتب معلومته مرة واحدة فقط، ولا تكرر أي جملة في ما تكتبه.

2) الصحة:
- التفريغ آلي وفيه أخطاء سمع، خصوصاً في المصطلحات والأرقام وأسماء التراكيب. افهم المقصود من السياق ومن معرفتك الطبية واكتبه صحيحاً (مثلاً «كارديو ميجالي» تُكتب [[cardiomegaly]]).
- إذا كانت جملة غير مفهومة بسبب خطأ التفريغ ولم تستطع الجزم بمعناها فلا تخترع لها معنى، واكتب منها ما تستطيع تأكيده من السياق فقط.
- لا تضف مواضيع أو معلومات لم يذكرها المحاضر. يُسمح فقط بتوضيح قصير جداً (تعريف مصطلح ذكره أو ربط بين فكرتين قالهما) إذا كان ضرورياً لفهم كلامه.

3) الوضوح والترتيب:
- اكتب بعربية فصحى مبسطة وواضحة بجمل قصيرة ومباشرة، لا باللهجة العامية، وبإملاء صحيح: انتبه للهمزات والتاء المربوطة والألف المقصورة، ولا تلصق كلمتين ببعض.
- رتّب المعلومات ترتيباً منطقياً يسهل فهمه وحفظه: الفكرة العامة أو التعريف أولاً ثم التفاصيل. إذا تنقّل المحاضر بين الأفكار ثم رجع إليها فاجمع كل ما قاله عن الفكرة الواحدة في مكان واحد.
- استخدم هذا الترميز فقط:
  ## عنوان القسم
  ### عنوان فرعي لكل فكرة أو موضوع داخل القسم
  فقرات شرح قصيرة، وبين كل فقرتين سطر فارغ
  - نقاط عند تعداد أسباب أو أعراض أو علامات أو أنواع أو خصائص
  1. خطوات أو مراحل مرتبة
  | عمود | عمود | جدول (أول صف للعناوين) عند المقارنة بين حالتين أو أكثر أو عرض أنواع مع خصائص كل نوع
  > ما شدّد عليه المحاضر أو قال إنه مهم أو يأتي بالامتحان (المعلومة نفسها كاملة في سطر واحد)
- كل مصطلح طبي أو علمي أو اختصار يُكتب بالإنجليزية بإملائه الصحيح بين قوسين مزدوجين، مثل [[pleural effusion]] و [[CT]]، ويجوز ذكر معناه العربي قبله عند أول ذكر. لا تضع [[ ]] داخل العناوين.
- العناوين (## و ###) تُكتب بالعربية دائماً، ويجوز إلحاق المصطلح الإنجليزي بها بين قوسين، مثل: ### فحص الرأس والوجه (Head and Face Examination). لا عناوين بالإنجليزية وحدها.`,
  en: `You are an expert medical professor and an outstanding author of study notes. You receive part of an automatic transcript of a recorded university lecture and write from it detailed written notes that a student can study from instead of listening to the recording, understanding everything the lecturer said.

1) Completeness, the most important rule:
- Write every piece of information in this part: every definition, explanation, cause, mechanism, sign, symptom, classification, type, difference, example, case, number, percentage, value, step, treatment and warning.
- These are detailed notes, not a short summary: do not compress ideas in a way that loses details, and never drop any scientific point, however small.
- If the lecturer explained an idea with an example, analogy or patient case, include it.
- Remove only what is not content: greetings, admin talk, jokes, calling on students, and literal repetition of the same idea (write it once, in its clearest and most complete form).
- If the lecture is a discussion or a clinical case with questions and answers between the teacher and students, turn the dialogue into organised notes: the correct information the discussion settled on, the teacher's corrections and the clinical reasoning; do not copy the dialogue line by line.
- An automatic transcript may repeat the same line or passage several times in a row (a transcription glitch, not the lecturer): write that information once only, and never repeat a sentence in your notes.

2) Correctness:
- The transcript is automatic and has mis-heard words, especially terms, numbers and structure names. Infer what was meant from context and your medical knowledge, and write it correctly.
- If a sentence is unintelligible because of transcription errors and you cannot be sure of its meaning, do not invent one; write only what you can confirm from context.
- Do not add topics or facts the lecturer did not mention. Only a very short clarification (defining a term he used, or linking two things he said) is allowed when needed to understand him.

3) Clarity and structure:
- Write in clear, simple English with short direct sentences and correct spelling.
- Order the information logically so it is easy to understand and memorise: the general idea or definition first, then the details. If the lecturer jumped between ideas and came back, gather everything he said about one idea in one place.
- Use only this markup:
  ## Section title
  ### Subheading for each idea or subtopic in the section
  Short explanatory paragraphs, separated by a blank line
  - bullets when listing causes, symptoms, signs, types or features
  1. ordered steps or stages
  | column | column | a table (first row = headers) when comparing two or more conditions or listing types with their features
  > what the lecturer stressed, called important, or said will be in the exam (the full fact on one line)
- Wrap every medical or scientific term and abbreviation in double brackets with correct spelling, like [[pleural effusion]] and [[CT]]. No [[ ]] inside headings.`,
};

const HIGH_YIELD_RULES = {
  ar: `أنت أستاذ جامعي خبير في العلوم الطبية ومؤلف ملخصات امتحانية (High-Yield Notes) مشهود لها بالدقة. يصلك جزء من تفريغ آلي لتسجيل محاضرة جامعية، وتستخرج منه أهم ما يحتاجه الطالب للامتحان: الأفكار الأساسية والمعلومات الامتحانية، مختصرة ومنظمة، بلا حشو ولا تفاصيل ثانوية.

1) ماذا تُبقي وماذا تحذف:
- أبقِ: التعريفات الأساسية، التصنيفات والأنواع، الأرقام والقيم والنسب، العلامات والأعراض المميزة، الفروق بين الحالات المتشابهة، الآليات باختصار، خطوات التشخيص والعلاج الأساسية، وكل ما شدّد عليه المحاضر أو قال إنه يأتي بالامتحان.
- احذف: الشرح المطوّل، التكرار، الأمثلة الطويلة والقصص، الكلام الإداري والمزاح، والتفاصيل التي لا تُسأل في الامتحان.
- لا تُسقط معلومة امتحانية مهمة بحجة الاختصار، ولا تضف معلومة لم يذكرها المحاضر.
- إذا كانت المحاضرة نقاشاً بأسئلة وأجوبة فاستخرج منها المعلومات الصحيحة التي استقر عليها النقاش، لا الحوار نفسه. والتفريغ قد يكرر السطر نفسه مرات (خلل آلي): اكتب المعلومة مرة واحدة، ولا تكرر أي نقطة.

2) الصحة:
- التفريغ آلي وفيه أخطاء سمع في المصطلحات والأرقام. افهم المقصود من السياق ومن معرفتك الطبية واكتبه صحيحاً.
- إذا لم تستطع الجزم بمعنى جملة فلا تخترع لها معنى.

3) الشكل:
- كل نقطة سطر واحد مكثّف يحمل معلومة واحدة كاملة. عربية فصحى واضحة بإملاء صحيح، لا لهجة.
- استخدم هذا الترميز فقط:
  ## عنوان القسم
  ### عنوان فرعي لكل موضوع
  - نقطة مكثفة (الغالب)
  1. خطوات أو مراحل مرتبة
  | عمود | عمود | جدول (أول صف للعناوين) للمقارنة بين حالات أو أنواع
  > معلومة شدّد عليها المحاضر أو قال إنها تأتي بالامتحان
- كل مصطلح طبي أو علمي أو اختصار بالإنجليزية بإملائه الصحيح بين قوسين مزدوجين، مثل [[pleural effusion]] و [[CT]]. لا [[ ]] داخل العناوين.
- العناوين (## و ###) بالعربية دائماً، ويجوز إلحاق المصطلح الإنجليزي بها بين قوسين. لا عناوين بالإنجليزية وحدها.
- حجم الناتج نحو ثلث حجم التفريغ أو أقل.`,
  en: `You are an expert medical professor and a trusted author of exam-focused High-Yield Notes. You receive part of an automatic transcript of a recorded university lecture and extract what a student needs for the exam: the core ideas and testable facts, concise and organised, with no filler or minor detail.

1) What to keep and what to drop:
- Keep: core definitions, classifications and types, numbers, values and percentages, distinguishing signs and symptoms, differences between similar conditions, mechanisms in brief, key diagnostic and treatment steps, and everything the lecturer stressed or said would be examined.
- Drop: long explanations, repetition, long examples and stories, admin talk and jokes, and details that are never examined.
- Never drop an exam-relevant fact for the sake of brevity, and never add a fact the lecturer did not mention.
- If the lecture is a question-and-answer discussion, extract the correct facts it settled on, not the dialogue. The transcript may repeat a line several times (a transcription glitch): state each fact once and never repeat a point.

2) Correctness:
- The transcript is automatic and mis-hears terms and numbers. Infer what was meant from context and medical knowledge and write it correctly.
- If a sentence cannot be understood with confidence, do not invent a meaning.

3) Form:
- Each bullet is one dense line carrying one complete fact. Clear English, correct spelling.
- Use only this markup:
  ## Section title
  ### Subheading per topic
  - dense bullet (most lines)
  1. ordered steps or stages
  | column | column | a table (first row = headers) to compare conditions or types
  > a fact the lecturer stressed or said will be examined
- Wrap every medical or scientific term and abbreviation in double brackets with correct spelling, like [[pleural effusion]] and [[CT]]. No [[ ]] inside headings.
- Output about a third of the transcript's length or less.`,
};

/** قواعد الدمج مع السلايدات (النوع المتكامل) */
const SLIDE_RULES = {
  ar: `5) دمج السلايدات مع التسجيل:
- مع التفريغ يصلك نص سلايدات هذا الجزء. السلايدات هي الهيكل الرسمي للمحاضرة: عناوينها وترتيبها وتعريفاتها وجداولها ومصطلحاتها بإملائها الصحيح. والتسجيل فيه شرح المحاضر وأمثلته وتنبيهاته.
- اكتب كل ما في السلايدات وكل ما شرحه المحاضر معاً في نص واحد مرتب: اتبع ترتيب السلايدات، وتحت كل فكرة اجمع ما كُتب في السلايد مع ما شرحه المحاضر عنها. لا تُسقط نقطة من السلايد ولا معلومة من الشرح.
- إذا اختلف إملاء مصطلح بين السلايد والتفريغ فاعتمد السلايد.
- حيث يوجد في السلايدات شكل أو صورة تخص الفكرة (القائمة أدناه)، ضع بعد فقرتها مباشرة سطراً مستقلاً بهذا الشكل:
  @slide: رقم الصفحة | تعليق عربي قصير يصف ما تُظهره الصورة (المصطلحات بالإنجليزية)
  استعمل كل صورة مناسبة مرة واحدة فقط، ولا تطلب صفحة ليس فيها صورة.`,
  en: `5) Integrating the slides with the recording:
- Along with the transcript you receive the text of this part's slides. The slides are the official skeleton of the lecture: their headings, order, definitions, tables and correctly spelled terms. The recording holds the lecturer's explanation, examples and warnings.
- Write everything on the slides and everything the lecturer explained together as one ordered text: follow the slide order, and under each idea merge what the slide says with what the lecturer explained about it. Drop no slide point and no explanation.
- If a term is spelled differently on the slide and in the transcript, use the slide.
- Where a slide contains a figure or image for the idea (listed below), add right after its paragraph a separate line in this form:
  @slide: page number | short caption describing what the image shows
  Use each suitable image once only, and never request a page that has no image.`,
};

const FIG_RULES = {
  ar: `4) الصور التوضيحية:
- إذا شرح هذا الجزء شيئاً يُفهم أفضل بالصورة (تركيب تشريحي، مظهر علامة أو حالة على الأشعة أو CT أو MRI أو السونار، مخطط لآلية، شريحة مجهرية، جهاز أو أداة) فأضف بعد الفقرة التي تشرحه مباشرة سطراً مستقلاً بهذا الشكل بالضبط:
  @fig: النوع | عبارة بحث إنجليزية دقيقة | عبارة بحث أعم | ما يجب أن تُظهره الصورة بالإنجليزية بدقة | تعليق عربي قصير
- النوع واحد من: radiograph (أشعة أو CT أو MRI أو سونار) أو diagram (رسم تشريحي أو مخطط) أو photo (جهاز أو حالة سريرية) أو micrograph (مجهرية).
- مثال:
  @fig: radiograph | pneumothorax chest x-ray | pneumothorax | frontal chest radiograph with a visible visceral pleural line and no lung markings beyond it | صورة أشعة للصدر تُظهر استرواح الصدر [[pneumothorax]]
- ضع صورة لكل مفهوم مهم يُفهم بالصورة، حتى 4 صور لهذا الجزء، كل صورة بعد فقرتها مباشرة. فقط لما شرحه المحاضر فعلاً، ولا صورة لمفهوم مجرد لا يُصوَّر.
- اكتب عبارة البحث كما تُكتب عادةً في عناوين الصور الطبية: اسم الحالة أو التركيب ثم نوع التصوير، مثل «pleural effusion chest x-ray» أو «heart anatomy diagram» أو «lung adenocarcinoma histology». والعبارة الأعم: اسم الحالة أو التركيب وحده.

أخرج نص الشرح فقط، بدون مقدمة أو خاتمة أو أي تعليق منك.`,
  en: `4) Illustrations:
- If this part explains something best understood with a picture (an anatomical structure, the appearance of a sign or condition on X-ray, CT, MRI or ultrasound, a mechanism diagram, a histology slide, a device), add right after the paragraph that explains it a separate line in exactly this form:
  @fig: kind | precise English search phrase | broader search phrase | exactly what the image must show, in English | short caption
- kind is one of: radiograph (X-ray, CT, MRI or ultrasound), diagram (anatomical drawing or schematic), photo (device or clinical case), micrograph (histology).
- Example:
  @fig: radiograph | pneumothorax chest x-ray | pneumothorax | frontal chest radiograph with a visible visceral pleural line and no lung markings beyond it | Chest X-ray showing a [[pneumothorax]] with the visceral pleural line
- Add an image for every important idea that is understood better with a picture, up to 4 images for this part, each right after its paragraph. Only for what the lecturer actually explained, and none for abstract ideas.
- Write the search phrase the way medical image titles are usually written: the condition or structure name, then the imaging type, like "pleural effusion chest x-ray", "heart anatomy diagram" or "lung adenocarcinoma histology". The broader phrase: the condition or structure name alone.

Output only the notes text, with no introduction, conclusion or comment of your own.`,
};

/**
 * كتابة شرح مفصل لقسم واحد من المحاضرة.
 * @param s { index, title, points, part, parts } القسم (part/parts عند تقسيم قسم طويل إلى أجزاء)
 * @param ctx { outline:[titles], source, words, known:[terms], images:boolean, retry:{ prevWords, missing } }
 */
export function notesSectionPrompt(meta, s, { lang = 'ar', outline = [], source = '', words = 0, known = [], images = true, retry = null, mode = 'notes', slides = null, slideFigs = [] } = {}) {
  const en = lang === 'en';
  const L = en ? 'en' : 'ar';
  const rules = mode === 'highyield' ? HIGH_YIELD_RULES[L] : NOTES_RULES[L];
  const tail = en ? 'Output only the notes text, with no introduction, conclusion or comment of your own.' : 'أخرج نص الشرح فقط، بدون مقدمة أو خاتمة أو أي تعليق منك.';
  const figRules = images ? FIG_RULES[L] : tail;
  const system = slides ? `${rules}\n\n${figRules}\n\n${SLIDE_RULES[L]}` : `${rules}\n\n${figRules}`;
  const cont = s.part > 1;
  const lines = [];
  const info = metaLine(meta);
  if (info) lines.push(info);
  if (outline.length > 1) {
    lines.push(`${en ? 'Full lecture plan (so you know where this part fits and leave other topics to their own sections)' : 'خطة المحاضرة كاملة (حتى تعرف موقع هذا الجزء وتترك المواضيع الأخرى لأقسامها)'}:\n${outline.map((t, i) => `${i + 1}. ${t}${i === s.index ? (en ? '   ← current section' : '   ← القسم الحالي') : ''}`).join('\n')}`);
  }
  lines.push(en
    ? `Now write section ${s.index + 1}: "${s.title}"${s.points ? ` — ${s.points}` : ''}.`
    : `المطلوب الآن القسم ${s.index + 1}: «${s.title}»${s.points ? ` — ${s.points}` : ''}.`);
  if (cont) {
    lines.push(en
      ? `This is part ${s.part} of ${s.parts} of the same section, continuing directly from the previous part: do not write the "##" line; start with subheadings and explanation.`
      : `هذا الجزء ${s.part} من ${s.parts} من القسم نفسه، وهو تكملة مباشرة لما قبله: لا تكتب سطر «##»، وابدأ بالعناوين الفرعية والشرح.`);
  } else {
    lines.push(en ? `Start with the heading line: ## ${s.title}` : `ابدأ بسطر العنوان: ## ${s.title}`);
  }
  if (known.length) {
    lines.push(en
      ? `Terms already used in this lecture with their correct spelling; use the same spelling if they come up: ${known.join(', ')}`
      : `مصطلحات وردت في المحاضرة بإملائها الصحيح؛ إذا وردت هنا فاكتبها بالإملاء نفسه: ${known.join('، ')}`);
  }
  lines.push(`${en ? `Transcript of this part (${words} words)` : `تفريغ هذا الجزء (${words} كلمة)`}:\n<<<\n${source}\n>>>`);
  if (slides) {
    lines.push(`${en ? 'Slides of this part' : 'سلايدات هذا الجزء'}:\n<<<\n${slides}\n>>>`);
    lines.push(slideFigs.length
      ? `${en ? 'Slides that contain a figure or image you may request with @slide:' : 'الصفحات التي فيها شكل أو صورة يمكنك طلبها بـ @slide:'}\n${slideFigs.map((f) => `- ${en ? 'page' : 'ص'}${f.page}: ${f.what}`).join('\n')}`
      : (en ? 'None of this part\'s slides contains a figure, so do not write any @slide line.' : 'لا توجد في سلايدات هذا الجزء صور، فلا تكتب أي سطر @slide.'));
  }
  if (retry?.prevWords) {
    lines.push(en
      ? `Warning: your previous attempt was too short (${retry.prevWords} words for a ${words}-word transcript) and dropped details. Write fuller notes that cover every point, example and number in the transcript.`
      : `تنبيه: محاولتك السابقة كانت مختصرة (${retry.prevWords} كلمة مقابل ${words} كلمة في التفريغ) وأسقطت تفاصيل. اكتب شرحاً أوفى يغطي كل نقطة ومثال ورقم في التفريغ.`);
  }
  if (retry?.tooLong) {
    lines.push(en
      ? `Warning: your previous attempt was longer than the transcript itself (${retry.tooLong} words for ${words}): these are High-Yield notes, not an explanation. Keep only exam-relevant facts, one dense line each, about ${retry.target} words in total, without dropping any exam-relevant fact and without adding anything not said.`
      : `تنبيه: محاولتك السابقة أطول من التفريغ نفسه (${retry.tooLong} كلمة مقابل ${words}): هذه نقاط امتحانية مكثفة لا شرح. أبقِ المعلومات الامتحانية فقط، كل معلومة سطر واحد مكثف، بمجموع نحو ${retry.target} كلمة، بدون إسقاط معلومة امتحانية وبدون إضافة شيء لم يُقل.`);
  }
  if (mode === 'highyield' && !retry?.tooLong) {
    lines.push(en ? `Target length: about ${Math.max(60, Math.round(words * 0.4))} words or less.` : `الحجم المطلوب: نحو ${Math.max(60, Math.round(words * 0.4))} كلمة أو أقل.`);
  }
  if (retry?.missing?.length) {
    lines.push(en
      ? `Warning: your previous attempt left out these terms from the transcript: ${retry.missing.join(', ')}. Make sure everything said about them is explained (unless one is clearly a mis-hearing).`
      : `تنبيه: محاولتك السابقة لم تذكر هذه المصطلحات الواردة في التفريغ: ${retry.missing.join('، ')}. تأكد أن كل ما قيل عنها مشروح (إلا إذا كان أحدها خطأ سمع واضحاً).`);
  }
  if (retry?.repeated) {
    lines.push(en
      ? 'Warning: your previous attempt repeated the same sentences and phrases many times. The transcript itself may contain repeated lines (a transcription loop): write each piece of information once only, never repeat a sentence, and stop when the content ends.'
      : 'تنبيه: محاولتك السابقة كررت الجمل والعبارات نفسها مرات كثيرة. قد يحتوي التفريغ نفسه على أسطر مكررة (خلل في التفريغ): اكتب كل معلومة مرة واحدة فقط، ولا تكرر أي جملة، وتوقف عندما ينتهي المحتوى.');
  }
  lines.push(mode === 'highyield'
    ? (en ? 'Now write the High-Yield notes for this part, following the rules.' : 'اكتب الآن النقاط الامتحانية المكثفة لهذا الجزء وفق القواعد.')
    : (en ? 'Now write the complete detailed notes for this part, following the rules.' : 'اكتب الآن الشرح المفصل لهذا الجزء كاملاً وفق القواعد.'));
  return { system, user: lines.join('\n\n') };
}

// ───────────── المراجعة النهائية، الأسئلة، الصور دفعة واحدة، صور السلايدات ─────────────

/**
 * مراجعة نهائية للملزمة كاملة مقابل التفريغ. يرجع JSON بتصحيحات محددة (بحث/استبدال) وإضافات لما سقط،
 * لا إعادة كتابة، حتى تبقى المراجعة سريعة وآمنة.
 */
export function reviewNotesPrompt(meta, notes, transcript, { lang = 'ar', mode = 'notes', condensed = false } = {}) {
  const en = lang === 'en';
  const system = en
    ? `You are a strict senior medical professor reviewing a student's lecture notes against the lecture transcript before they are delivered. You find real mistakes and omissions and report precise corrections. Answer in JSON only.`
    : `أنت أستاذ جامعي طبي دقيق تراجع ملزمة مكتوبة من محاضرة مقابل تفريغ المحاضرة نفسها قبل تسليمها للطالب. تجد الأخطاء الحقيقية والنواقص وتبلّغ عنها بتصحيحات محددة. أجب بصيغة JSON فقط.`;
  const high = mode === 'highyield';
  const user = en
    ? `${metaLine(meta)}

The transcript of the lecture${condensed ? ' (condensed)' : ''}:
<<<
${transcript}
>>>

The notes written from it (${high ? 'High-Yield exam notes, deliberately concise' : 'detailed study notes'}):
<<<
${notes}
>>>

Review the notes against the transcript and report:
1. "fixes": real errors only, as exact replacements. Each: "find" = an exact short quote from the notes (4 to 30 words, copied exactly including [[ ]]) and "replace" = the corrected text. Report: a fact or number that contradicts the lecturer, a wrong or misspelled medical term (inside or outside [[ ]]), a term spelled two different ways (unify to the correct one), a heading that does not match its content, an obviously garbled sentence. Do not report style, wording or ordering preferences, and never shorten content.
2. "missing": information the lecturer clearly explained that is absent from the notes${high ? ' and is exam-relevant' : ''}. Each: "after" = the exact text of an existing heading (## or ###) that the information belongs under, and "add" = the lines to append at the end of that heading's part, in the notes' own markup (bullets, paragraphs, > for stressed facts, terms in [[ ]]). Do not add what is already there, and do not invent anything.
3. "verdict": one short sentence on the overall quality.

Write every replacement and addition in the notes' own language and style (clear formal prose, terms in [[ ]]); never copy the lecturer's spoken wording, dialect or filler. Before adding, check the whole notes: if the information is already there in other words or in another part, do not add it.
Report at most 40 fixes and 15 additions. If the notes are correct and complete, return empty lists.
Output: {"fixes":[{"find":"...","replace":"..."}],"missing":[{"after":"...","add":"..."}],"verdict":"..."}`
    : `${metaLine(meta)}

تفريغ المحاضرة${condensed ? ' (مختصر)' : ''}:
<<<
${transcript}
>>>

الملزمة المكتوبة منه (${high ? 'نقاط امتحانية مكثفة، مختصرة عمداً' : 'شرح دراسي مفصل'}):
<<<
${notes}
>>>

راجع الملزمة مقابل التفريغ وأبلغ عن:
1. "fixes": الأخطاء الحقيقية فقط، كاستبدالات محددة. لكل واحد: "find" = اقتباس قصير حرفي من الملزمة (من 4 إلى 30 كلمة، منسوخ كما هو بما فيه [[ ]]) و "replace" = النص الصحيح. أبلغ عن: معلومة أو رقم يخالف ما قاله المحاضر، مصطلح طبي خاطئ أو بإملاء خاطئ (داخل [[ ]] أو خارجها)، مصطلح كُتب بإملائين مختلفين (وحّده على الصحيح)، عنوان لا يطابق محتواه، جملة مشوّهة لا تُفهم، خطأ إملائي أو نحوي واضح. لا تبلغ عن تفضيلات أسلوب أو صياغة أو ترتيب، ولا تختصر محتوى أبداً.
2. "missing": معلومات شرحها المحاضر بوضوح وغير موجودة في الملزمة${high ? ' وهي مهمة للامتحان' : ''}. لكل واحدة: "after" = النص الحرفي لعنوان موجود (## أو ###) تنتمي إليه المعلومة، و "add" = الأسطر التي تُضاف في آخر ذلك الجزء، بترميز الملزمة نفسه (نقاط - أو فقرات، و > لما شدّد عليه المحاضر، والمصطلحات بين [[ ]]). لا تضف ما هو موجود أصلاً، ولا تخترع شيئاً.
3. "verdict": جملة قصيرة عن جودة الملزمة عموماً.

اكتب كل تصحيح وإضافة بأسلوب الملزمة نفسه: عربية فصحى واضحة والمصطلحات بالإنجليزية بين [[ ]]، ولا تنسخ كلام المحاضر بلهجته العامية أو حشوه أبداً. وقبل أي إضافة افحص الملزمة كلها: إذا كانت المعلومة موجودة بصياغة أخرى أو في جزء آخر فلا تضفها.
أبلغ عن 40 تصحيحاً و 15 إضافة على الأكثر. إذا كانت الملزمة صحيحة وكاملة فأرجع القوائم فارغة.
أخرج: {"fixes":[{"find":"...","replace":"..."}],"missing":[{"after":"...","add":"..."}],"verdict":"..."}`;
  return { system, user };
}

/** أسئلة اختيار من متعدد من الملزمة. يرجع JSON. */
export function mcqPrompt(meta, notes, { lang = 'ar', count = 12 } = {}) {
  const en = lang === 'en';
  const system = en
    ? `You are a medical school examiner who writes high-quality single-best-answer MCQs that test understanding of a lecture, in the style of university exams. Answer in JSON only.`
    : `أنت أستاذ ممتحن في كلية طبية تكتب أسئلة اختيار من متعدد (أفضل إجابة واحدة) عالية الجودة تختبر فهم المحاضرة بأسلوب امتحانات الجامعة. أجب بصيغة JSON فقط.`;
  const user = en
    ? `${metaLine(meta)}

The lecture notes:
<<<
${notes}
>>>

Write ${count} MCQs covering the most examinable points of the notes, spread across its topics (facts, definitions, distinguishing signs, numbers, mechanisms, "which of the following" and short clinical scenarios). Each question: "q" the question, "options" exactly 4 options of similar length with one correct answer and three plausible distractors (no "all of the above"), "answer" the index of the correct option (0 to 3), "why" one sentence explaining the answer from the notes. Vary the position of the correct answer. Only from the notes; do not invent facts. Terms in [[ ]].
Output: {"questions":[{"q":"...","options":["...","...","...","..."],"answer":0,"why":"..."}]}`
    : `${metaLine(meta)}

الملزمة:
<<<
${notes}
>>>

اكتب ${count} سؤال اختيار من متعدد تغطي أهم النقاط الامتحانية في الملزمة موزعة على مواضيعها (حقائق، تعريفات، علامات مميزة، أرقام، آليات، «أي مما يلي»، وحالات سريرية قصيرة). لكل سؤال: "q" نص السؤال، "options" أربعة خيارات بالضبط متقاربة الطول فيها إجابة صحيحة واحدة وثلاثة مشتتات معقولة (بدون «كل ما سبق»)، "answer" رقم الخيار الصحيح (من 0 إلى 3)، "why" جملة واحدة تعلّل الجواب من الملزمة. نوّع موضع الإجابة الصحيحة. من الملزمة فقط ولا تخترع معلومات. الأسئلة بالعربية الفصحى والمصطلحات بالإنجليزية بين [[ ]].
أخرج: {"questions":[{"q":"...","options":["...","...","...","..."],"answer":0,"why":"..."}]}`;
  return { system, user };
}

/**
 * التحقق بالنظر من عدة أشكال دفعة واحدة (Gemini). تُرفق صور كل شكل بعد النص، قبل كل صورة رمزها (1A، 1B، 2A…).
 * @param figs [{ n, context, section, show, query, kind, labels:[rمز] }]
 */
export function figuresBatchPrompt(figs, { lang = 'ar' } = {}) {
  const system = `أنت طبيب ومحرر كتب طبية دقيق جداً تختار الصور التوضيحية لملزمة جامعية. الصورة غير المطابقة أسوأ من عدم وجود صورة، فلا تختر إلا صورة تُظهر المطلوب فعلاً. أجب بصيغة JSON فقط.`;
  const list = figs.map((f) => `الشكل ${f.n}${f.section ? ` (قسم «${f.section}»)` : ''}:
- الشرح الذي ستوضّحه: «${clip(String(f.context || ''), 600)}»
- المطلوب أن تُظهره: ${f.show || f.query}
- نوعها المطلوب: ${KIND_LABEL[f.kind] || KIND_LABEL.diagram}
- مرشحاتها: ${f.labels.join('، ')}`).join('\n\n');
  const user = `${figs.length === 1 ? 'شكل واحد مطلوب' : `${figs.length} أشكال مطلوبة`} لملزمة محاضرة، ولكل شكل عدة صور مرشحة مرفقة بعد هذا النص، قبل كل صورة رمزها (رقم الشكل ثم حرف) وعنوانها في مصدرها.

${list}

لكل شكل اختر الصورة التي تُظهر المطلوب نفسه بوضوح وبدقة علمية. تُقبل الصورة إذا أظهرت التركيب أو العلامة أو الحالة المطلوبة نفسها حتى لو اختلفت تفاصيل ثانوية (الجهة، زاوية التصوير، الألوان، أو وجود أسهم وتسميات). أجب "none" للشكل إذا:
- لم تُظهر أي صورة المطلوب بالتحديد (عضو آخر، أو حالة أخرى، أو منطقة أخرى، أو نوع تصوير آخر)،
- أو كانت الصورة المناسبة جدولاً أو لوحة من صور صغيرة كثيرة، أو مزدحمة بنصوص بلغة غير الإنجليزية أو العربية، أو رديئة الوضوح،
- أو لم تكن متأكداً.
ولكل شكل مختار اكتب "caption" تعليقاً ${lang === 'en' ? 'بالإنجليزية' : 'بالعربية'} دقيقاً من جملة أو جملتين يصف ما تُظهره الصورة المختارة فعلاً وعلاقته بالشرح، والمصطلحات بالإنجليزية بين [[ ]].

أخرج: {"picks":[{"fig":1,"choice":"1B","confidence":0.9,"caption":"..."},{"fig":2,"choice":"none"}]} حيث confidence رقم من 0 إلى 1 يعبّر عن تأكدك أن الصورة تُظهر المطلوب.`;
  return { system, user };
}

/**
 * فحص صفحات سلايدات المحاضرة بالنظر: أي الصفحات فيها شكل أو صورة تصلح للملزمة، وأين موضعه في الصفحة.
 * تُرفق الصفحات بعد النص، قبل كل صفحة رقمها.
 */
export function slideFiguresPrompt(pages, { lang = 'ar' } = {}) {
  const system = `أنت محرر كتب طبية تفحص سلايدات محاضرة جامعية لاستخراج الأشكال والصور التوضيحية منها (صور شعاعية، رسوم تشريحية، مخططات، صور مجهرية، صور أجهزة أو حالات). أجب بصيغة JSON فقط.`;
  const user = `مرفق ${pages.length} صفحة من سلايدات المحاضرة، قبل كل صفحة رقمها (${pages.map((p) => `ص${p.page}`).join('، ')}).

لكل صفحة فيها شكل أو صورة توضيحية حقيقية (لا شعار الجامعة، ولا زخرفة القالب، ولا أيقونات صغيرة، ولا نص فقط): أبلغ عنها بـ:
- "page": رقم الصفحة.
- "box": موضع الشكل في الصفحة كمربع إحداثياته [ymin, xmin, ymax, xmax] على مقياس من 0 إلى 1000، يحيط بالشكل وتسمياته ومفتاحه فقط بدون عنوان الصفحة ونصوصها الأخرى. إذا كانت الصفحة كلها شكلاً واحداً فالمربع يغطيها.
- "what": وصف ${lang === 'en' ? 'بالإنجليزية' : 'بالعربية (المصطلحات بالإنجليزية بين [[ ]])'} في جملة لما يُظهره الشكل بالضبط وأي مفهوم يوضّح.
- "kind": واحد من radiograph أو diagram أو photo أو micrograph.
إذا كانت في الصفحة عدة أشكال منفصلة ومهمة فأبلغ عن كل واحد على حدة (حتى 3 لكل صفحة). الصفحات التي لا شكل فيها لا تُذكر.

أخرج: {"figures":[{"page":3,"box":[120,80,900,920],"what":"...","kind":"diagram"}]}`;
  return { system, user };
}

/** نقاط مراجعة سريعة من الملزمة كاملة. */
export function reviewPrompt(meta, notes, { lang = 'ar' } = {}) {
  const en = lang === 'en';
  const system = en
    ? 'You are a university professor preparing a quick pre-exam revision list from a student\'s lecture notes.'
    : 'أنت أستاذ جامعي تُعدّ للطالب قائمة مراجعة سريعة قبل الامتحان من ملزمة محاضرته.';
  const info = metaLine(meta);
  const user = en
    ? `${info ? info + '\n\n' : ''}The notes:\n<<<\n${notes}\n>>>\n\nWrite 8 to 15 revision points, each on its own line starting with "- ": one clear sentence carrying a complete important fact from the notes (a key definition, an important difference, a number or value, a distinguishing sign, or what the lecturer stressed). Terms in [[ ]]. Add nothing that is not in the notes. Output only the points.`
    : `${info ? info + '\n\n' : ''}الملزمة:\n<<<\n${notes}\n>>>\n\nاكتب من 8 إلى 15 نقطة مراجعة، كل نقطة في سطر يبدأ بـ "- ": جملة واحدة واضحة تحمل معلومة مهمة كاملة من الملزمة (تعريف أساسي، فرق مهم، رقم أو قيمة، علامة مميزة، أو ما شدّد عليه المحاضر). المصطلحات بالإنجليزية بين [[ ]]. لا تضف شيئاً غير موجود في الملزمة. أخرج النقاط فقط.`;
  return { system, user };
}

/** التحقق بالنظر من مطابقة صورة لشرحها (Gemini). الصور تُرفق بعد النص، قبل كل صورة حرفها. */
export function figureVerifyPrompt(fig, letters, { lang = 'ar' } = {}) {
  const system = `أنت طبيب ومحرر كتب طبية دقيق جداً تختار صورة توضيحية لملزمة جامعية. الصورة غير المطابقة أسوأ من عدم وجود صورة، فلا تختر إلا صورة تُظهر المطلوب فعلاً. أجب بصيغة JSON فقط.`;
  const user = `الشرح الذي ستوضّحه الصورة${fig.section ? ` (من قسم «${fig.section}»)` : ''}:
«${clip(String(fig.context || ''), 900)}»

المطلوب أن تُظهره الصورة: ${fig.show || fig.query}
نوع الصورة المطلوب: ${KIND_LABEL[fig.kind] || KIND_LABEL.diagram}

مرفق ${letters.length} صور مرشحة، قبل كل صورة حرفها (${letters.join('، ')}) وعنوانها في مصدرها.
اختر الصورة التي تُظهر المطلوب نفسه بوضوح وبدقة علمية. تُقبل الصورة إذا أظهرت التركيب أو العلامة أو الحالة المطلوبة نفسها، حتى لو اختلفت تفاصيل ثانوية (الجهة، زاوية التصوير، الألوان، أو وجود أسهم وتسميات توضيحية). أجب "none" إذا:
- لم تُظهر أي صورة المطلوب بالتحديد (عضو آخر، أو حالة أخرى، أو منطقة أخرى من الجسم، أو نوع تصوير آخر)،
- أو كانت الصورة المناسبة جدولاً أو لوحة من صور صغيرة كثيرة أو مزدحمة بنصوص بلغة غير الإنجليزية أو رديئة الوضوح،
- أو لم تكن متأكداً.
ثم اكتب في "caption" تعليقاً ${lang === 'en' ? 'بالإنجليزية' : 'بالعربية'} دقيقاً من جملة أو جملتين يصف ما تُظهره الصورة المختارة فعلاً وعلاقته بالشرح، والمصطلحات بالإنجليزية بين [[ ]].

أخرج: {"choice":"A","confidence":0.9,"why":"...","caption":"..."} حيث confidence رقم من 0 إلى 1 يعبّر عن تأكدك أن الصورة تُظهر المطلوب.`;
  return { system, user };
}

/** اختيار صورة من عناوين المرشحات ووصفها فقط (عند عدم توفر نموذج يرى الصور). */
export function figureTextPickPrompt(fig, cands, { lang = 'ar' } = {}) {
  const system = `أنت طبيب ومحرر كتب طبية دقيق جداً تختار صورة توضيحية لملزمة جامعية. لا ترى الصور نفسها بل عناوينها ووصفها في مصدرها، فلا تختر إلا إذا دلّ العنوان أو الوصف بوضوح أنها تُظهر المطلوب بالتحديد. الصورة غير المطابقة أسوأ من عدم وجود صورة. أجب بصيغة JSON فقط.`;
  const user = `الشرح الذي ستوضّحه الصورة: «${clip(String(fig.context || ''), 700)}»
المطلوب أن تُظهره الصورة: ${fig.show || fig.query}
نوع الصورة المطلوب: ${KIND_LABEL[fig.kind] || KIND_LABEL.diagram}

المرشحات:
${cands.map((c, i) => `${String.fromCharCode(65 + i)}: ${c.title}${c.desc ? ` — ${clip(c.desc, 200)}` : ''}`).join('\n')}

أجب "none" إذا لم يدل أي عنوان بوضوح على المطلوب نفسه. اكتب في "caption" تعليقاً ${lang === 'en' ? 'بالإنجليزية' : 'بالعربية'} قصيراً يصف الصورة المختارة كما يدل عليها عنوانها ووصفها، والمصطلحات بين [[ ]].

أخرج: {"choice":"A","confidence":0.9,"caption":"..."}`;
  return { system, user };
}

/** تدقيق إملائي ولغوي لقسم مكتوب: يعيد النص نفسه بعد تصحيح الأخطاء فقط. */
export function proofreadPrompt(markup, { lang = 'ar' } = {}) {
  const system = lang === 'en'
    ? `You are a meticulous proofreader of medical study notes written in a simple markup. Return the notes exactly as they are, correcting only spelling, grammar and typos.

Fix: misspelled words, merged or split words, missing, extra or repeated letters, obvious grammar mistakes, and misspelled medical terms inside [[ ]].

Do not change:
- the meaning or the information: do not delete, add, shorten or rephrase anything;
- the markup: keep every ##, ###, -, 1., > and table | line as it is, the [[ ]] brackets, and the blank lines;
- lines starting with @fig: copy them exactly.

Output the complete corrected notes only, with no introduction or comment.`
    : `أنت مدقق لغوي محترف للعربية الفصحى وللمصطلحات الطبية الإنجليزية. تصلك ملزمة طبية مكتوبة بترميز بسيط، فتعيدها كما هي تماماً بعد تصحيح الأخطاء الإملائية والنحوية فقط.

صحّح:
- الهمزات (أ، إ، آ، ء، ؤ، ئ) وهمزة الوصل والقطع.
- التاء المربوطة والهاء، والألف المقصورة والياء.
- الكلمات الملتصقة أو المفصولة خطأً، والحروف الناقصة أو الزائدة أو المكررة.
- الأخطاء النحوية الواضحة، والتذكير والتأنيث.
- إملاء المصطلحات الإنجليزية داخل [[ ]] إذا كان فيها خطأ واضح.
- علامات الترقيم العربية (، ؛ ؟) بلا مسافة قبلها.
- عنوان (## أو ###) مكتوب بالإنجليزية وحدها: اكتبه بالعربية ثم الإنجليزية بين قوسين، مثل «### فحص البطن (Examination of the Abdomen)». هذا التغيير الوحيد المسموح في المحتوى.

لا تغيّر:
- المعنى والمعلومات: لا تحذف ولا تضف ولا تختصر ولا تعِد صياغة أي جملة.
- الترميز: أسطر ## و ### و - و 1. و > وأسطر الجداول | كما هي، والأقواس [[ ]]، والأسطر الفارغة.
- الأسطر التي تبدأ بـ @fig: انسخها حرفياً بلا أي تغيير.

أخرج الملزمة كاملة بعد التصحيح فقط، بدون أي مقدمة أو تعليق.`;
  const user = `${lang === 'en' ? 'The notes' : 'الملزمة'}:\n<<<\n${markup}\n>>>`;
  return { system, user };
}


// ───────────── الترجمة (النسخة الثانية من الملزمة) ─────────────

/**
 * ترجمة قسم من الملزمة إلى اللغة الأخرى مع إبقاء الترميز كما هو سطراً بسطر.
 * @param to 'en' | 'ar'
 */
export function translatePrompt(markup, { to = 'en', meta = {} } = {}) {
  const system = to === 'en'
    ? `You are a medical translator and editor producing the English edition of Arabic university study notes. Translate faithfully into clear, natural academic English for medical students: every fact, number, example and emphasis, nothing added and nothing dropped.

Markup rules (strict):
- Keep every line's kind and order exactly: "## " and "### " headings stay headings, "- " bullets stay bullets with the same number of items, "1." numbered items stay numbered, "> " lines stay "> " lines, table rows "| a | b |" stay rows with the same number of columns and rows, and blank lines between blocks stay.
- Medical terms appear in [[ ]] and are already English: keep them inside [[ ]] exactly as spelled. When the Arabic gives a term's meaning followed by the term in [[ ]], write the term once (inside [[ ]]) and do not repeat it.
- Headings written as "Arabic (English)" become the English only; keep letters, numbers and labels such as "(A: Airway)" or "Step 2".
- Never leave Arabic words in the output. Never add comments, notes or a preamble.

Output the translated notes only.`
    : `أنت مترجم طبي ومحرر تُعدّ النسخة العربية من ملزمة جامعية مكتوبة بالإنجليزية. ترجم بأمانة إلى عربية فصحى واضحة لطلبة الطب: كل معلومة ورقم ومثال وتأكيد، بلا إضافة ولا حذف.

قواعد الترميز (صارمة):
- أبقِ نوع كل سطر وترتيبه كما هو: عناوين "## " و "### " تبقى عناوين، النقاط "- " تبقى نقاطاً بنفس العدد، البنود المرقمة "1." تبقى مرقمة، أسطر "> " تبقى "> "، صفوف الجداول "| أ | ب |" تبقى صفوفاً بنفس عدد الأعمدة والصفوف، والأسطر الفارغة بين الكتل تبقى.
- المصطلحات الطبية بين [[ ]] تبقى بالإنجليزية داخل [[ ]] كما هي، ويُذكر معناها العربي قبلها عند أول ورود.
- العناوين تُكتب بالعربية ثم الإنجليزية بين قوسين.
- لا تترك جملاً إنجليزية في الناتج، ولا تضف تعليقاً أو مقدمة.

أخرج الملزمة المترجمة فقط.`;
  const ctx = meta.subject ? (to === 'en' ? `Subject: ${meta.subject}\n\n` : `المادة: ${meta.subject}\n\n`) : '';
  const user = `${ctx}${to === 'en' ? 'The notes' : 'الملزمة'}:\n<<<\n${markup}\n>>>`;
  return { system, user };
}

/** ترجمة عنوان الملزمة وتعليقات الصور (JSON). */
export function translateExtrasPrompt({ title = '', captions = [] }, { to = 'en', titleTo = to } = {}) {
  const name = (l) => (l === 'en' ? 'English' : 'Arabic (فصحى)');
  const system = 'You translate medical study-notes metadata between Arabic and English. Keep [[ ]] around medical terms exactly as they are (the terms stay in English). Answer in JSON only.';
  const user = `Translate the title into ${name(titleTo)} and each figure caption into ${name(to)} (keep the order; same count). A short cover title, not a sentence.
${JSON.stringify({ title, captions }, null, 1)}
Output: {"title":"...","captions":["...", ...]}`;
  return { system, user };
}
