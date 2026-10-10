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
- وجود موسيقى أو ضوضاء في الخلفية لا يعني عدم وجود كلام: اكتب الكلمات التي تسمعها. وإذا تكرر مقطع فاكتبه في كل مرة يتكرر.
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
export function notesPlanPrompt(meta, numbered, { lang = 'ar', condensed = false } = {}) {
  const system = `أنت أستاذ جامعي خبير ومحرر كتب جامعية طبية. يصلك تفريغ آلي لتسجيل محاضرة (فيه أخطاء سمع وتكرار). مهمتك أن تفهم المحاضرة كلها وتقسمها إلى أقسام حسب المواضيع التي شرحها المحاضر. أجب بصيغة JSON فقط.`;
  const user = `${metaLine(meta)}

هذا تفريغ المحاضرة مقسماً إلى فقرات مرقمة، رقم كل فقرة بين قوسين مربعين في أولها${condensed ? ' (من كل فقرة بدايتها فقط)' : ''}:
<<<
${numbered}
>>>

المطلوب:
1. "kind": "lecture" إذا كان التسجيل محاضرة أو مادة تعليمية أو علمية، أو "other" إذا لم يكن كذلك (أغنية، حديث عام، تسجيل بلا محتوى تعليمي).
2. "title": عنوان دقيق للمحاضرة يصف موضوعها الفعلي كما شُرح (${lang === 'en' ? 'بالإنجليزية' : 'بالعربية، والمصطلحات بالإنجليزية'}، بدون [[ ]]). لا تخترع موضوعاً غير موجود.
3. "sections": أقسام المحاضرة بالترتيب. كل قسم موضوع رئيسي واحد متماسك. لكل قسم:
   - "from": رقم أول فقرة في القسم. القسم يمتد حتى الفقرة التي قبل بداية القسم التالي، والقسم الأول يبدأ من 0.
   - "title": عنوان واضح ومحدد لموضوع القسم (${lang === 'en' ? 'بالإنجليزية' : 'بالعربية، والمصطلحات بالإنجليزية'}، بدون [[ ]]).
   - "points": سطر واحد بأهم ما يشرحه القسم.
   الأفضل أن يكون القسم بين 300 و 1500 كلمة تقريباً من التفريغ. الكلام الإداري في البداية (التحية والحضور والإعلانات) يُضم للقسم الذي يليه.

أخرج: {"kind":"lecture","title":"...","sections":[{"from":0,"title":"...","points":"..."}]}`;
  return { system, user };
}

const NOTES_RULES = {
  ar: `أنت أستاذ جامعي خبير في العلوم الطبية ومؤلف ملازم دراسية مشهود له بالوضوح. يصلك جزء من تفريغ آلي لتسجيل محاضرة جامعية، وتكتب منه شرحاً مكتوباً مفصلاً يذاكر منه الطالب بدل سماع التسجيل، فيفهم منه كل ما قاله المحاضر.

1) الشمول، وهو أهم قاعدة:
- اكتب كل معلومة وردت في هذا الجزء: كل تعريف وشرح وسبب وآلية وعلامة وعرض وتصنيف ونوع وفرق ومثال وحالة ورقم ونسبة وقيمة وخطوة وعلاج وتنبيه.
- هذا شرح مفصل وليس ملخصاً: ممنوع اختصار الأفكار أو دمجها بطريقة تُضيع تفاصيلها، وممنوع إسقاط أي نقطة علمية حتى الصغيرة أو الجانبية منها.
- إذا وضّح المحاضر فكرة بمثال أو تشبيه أو حالة مريض فاكتبه أيضاً، لأنه يساعد على الفهم.
- احذف فقط ما ليس علماً: التحية والكلام الإداري والمزاح والنداء على الطلبة، والتكرار الحرفي للفكرة نفسها (اكتبها مرة واحدة بأوضح وأكمل صيغة).

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
- كل مصطلح طبي أو علمي أو اختصار يُكتب بالإنجليزية بإملائه الصحيح بين قوسين مزدوجين، مثل [[pleural effusion]] و [[CT]]، ويجوز ذكر معناه العربي قبله عند أول ذكر. لا تضع [[ ]] داخل العناوين.`,
  en: `You are an expert medical professor and an outstanding author of study notes. You receive part of an automatic transcript of a recorded university lecture and write from it detailed written notes that a student can study from instead of listening to the recording, understanding everything the lecturer said.

1) Completeness, the most important rule:
- Write every piece of information in this part: every definition, explanation, cause, mechanism, sign, symptom, classification, type, difference, example, case, number, percentage, value, step, treatment and warning.
- These are detailed notes, not a short summary: do not compress ideas in a way that loses details, and never drop any scientific point, however small.
- If the lecturer explained an idea with an example, analogy or patient case, include it.
- Remove only what is not content: greetings, admin talk, jokes, calling on students, and literal repetition of the same idea (write it once, in its clearest and most complete form).

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

const FIG_RULES = {
  ar: `4) الصور التوضيحية:
- إذا شرح هذا الجزء شيئاً يُفهم أفضل بالصورة (تركيب تشريحي، مظهر علامة أو حالة على الأشعة أو CT أو MRI أو السونار، مخطط لآلية، شريحة مجهرية، جهاز أو أداة) فأضف بعد الفقرة التي تشرحه مباشرة سطراً مستقلاً بهذا الشكل بالضبط:
  @fig: النوع | عبارة بحث إنجليزية دقيقة | عبارة بحث أعم | ما يجب أن تُظهره الصورة بالإنجليزية بدقة | تعليق عربي قصير
- النوع واحد من: radiograph (أشعة أو CT أو MRI أو سونار) أو diagram (رسم تشريحي أو مخطط) أو photo (جهاز أو حالة سريرية) أو micrograph (مجهرية).
- مثال:
  @fig: radiograph | pneumothorax chest x-ray | pneumothorax | frontal chest radiograph with a visible visceral pleural line and no lung markings beyond it | صورة أشعة للصدر تُظهر استرواح الصدر [[pneumothorax]]
- صورتان كحد أقصى لهذا الجزء، فقط لما شرحه المحاضر فعلاً، ولا صورة لمفهوم مجرد لا يُصوَّر.

أخرج نص الشرح فقط، بدون مقدمة أو خاتمة أو أي تعليق منك.`,
  en: `4) Illustrations:
- If this part explains something best understood with a picture (an anatomical structure, the appearance of a sign or condition on X-ray, CT, MRI or ultrasound, a mechanism diagram, a histology slide, a device), add right after the paragraph that explains it a separate line in exactly this form:
  @fig: kind | precise English search phrase | broader search phrase | exactly what the image must show, in English | short caption
- kind is one of: radiograph (X-ray, CT, MRI or ultrasound), diagram (anatomical drawing or schematic), photo (device or clinical case), micrograph (histology).
- Example:
  @fig: radiograph | pneumothorax chest x-ray | pneumothorax | frontal chest radiograph with a visible visceral pleural line and no lung markings beyond it | Chest X-ray showing a [[pneumothorax]] with the visceral pleural line
- At most two images for this part, only for what the lecturer actually explained, and none for abstract ideas.

Output only the notes text, with no introduction, conclusion or comment of your own.`,
};

/**
 * كتابة شرح مفصل لقسم واحد من المحاضرة.
 * @param s { index, title, points, part, parts } القسم (part/parts عند تقسيم قسم طويل إلى أجزاء)
 * @param ctx { outline:[titles], source, words, known:[terms], images:boolean, retry:{ prevWords, missing } }
 */
export function notesSectionPrompt(meta, s, { lang = 'ar', outline = [], source = '', words = 0, known = [], images = true, retry = null } = {}) {
  const en = lang === 'en';
  const system = `${NOTES_RULES[en ? 'en' : 'ar']}\n\n${images ? FIG_RULES[en ? 'en' : 'ar'] : (en ? 'Output only the notes text, with no introduction, conclusion or comment of your own.' : 'أخرج نص الشرح فقط، بدون مقدمة أو خاتمة أو أي تعليق منك.')}`;
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
  if (retry?.prevWords) {
    lines.push(en
      ? `Warning: your previous attempt was too short (${retry.prevWords} words for a ${words}-word transcript) and dropped details. Write fuller notes that cover every point, example and number in the transcript.`
      : `تنبيه: محاولتك السابقة كانت مختصرة (${retry.prevWords} كلمة مقابل ${words} كلمة في التفريغ) وأسقطت تفاصيل. اكتب شرحاً أوفى يغطي كل نقطة ومثال ورقم في التفريغ.`);
  }
  if (retry?.missing?.length) {
    lines.push(en
      ? `Warning: your previous attempt left out these terms from the transcript: ${retry.missing.join(', ')}. Make sure everything said about them is explained (unless one is clearly a mis-hearing).`
      : `تنبيه: محاولتك السابقة لم تذكر هذه المصطلحات الواردة في التفريغ: ${retry.missing.join('، ')}. تأكد أن كل ما قيل عنها مشروح (إلا إذا كان أحدها خطأ سمع واضحاً).`);
  }
  lines.push(en ? 'Now write the complete detailed notes for this part, following the rules.' : 'اكتب الآن الشرح المفصل لهذا الجزء كاملاً وفق القواعد.');
  return { system, user: lines.join('\n\n') };
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
اختر الصورة التي تُظهر المطلوب نفسه بوضوح وبدقة علمية. أجب "none" إذا:
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

لا تغيّر:
- المعنى والمعلومات: لا تحذف ولا تضف ولا تختصر ولا تعِد صياغة أي جملة.
- الترميز: أسطر ## و ### و - و 1. و > وأسطر الجداول | كما هي، والأقواس [[ ]]، والأسطر الفارغة.
- الأسطر التي تبدأ بـ @fig: انسخها حرفياً بلا أي تغيير.

أخرج الملزمة كاملة بعد التصحيح فقط، بدون أي مقدمة أو تعليق.`;
  const user = `${lang === 'en' ? 'The notes' : 'الملزمة'}:\n<<<\n${markup}\n>>>`;
  return { system, user };
}

