// paged.js — تقسيم متن الملزمة إلى صفحات A4 ثابتة (ترويسة، تذييل، رقم صفحة).
//
// pagedRuntime لا تُستدعى هنا: يُحقن نصها داخل مستند الـ PDF وتعمل في المتصفح الذي يولّده
// (متصفح الخادم)، لذلك يجب أن تبقى مكتفية بذاتها ولا تستعمل أي شيء من خارجها.
//
// لماذا لا نعتمد على ‎@page‎ وحدها؟ متصفح الخادم لا يرسم ترويسات الصفحات ولا أرقامها،
// فنبني الصفحات بأنفسنا: كل صفحة عنصر بقياس الورقة تماماً، ونثبّت فواصل الأسطر كما حسبها
// المتصفح وقت القياس حتى لا يتغيّر عددها عند الطباعة.

export function pagedRuntime(cfg, win) {
  // win: نافذة المستند المطلوب تقسيمه. على الخادم يُحقن السكربت داخل المستند نفسه (win فارغة)،
  // وفي المتصفح تستدعيه الصفحة الأم على إطار الطباعة (سياسة الأمان تمنع السكربتات المضمّنة فيه)
  const W = win || window;
  const d = W.document;
  const getComputedStyle = (el) => W.getComputedStyle(el);
  const root = d.documentElement;
  const flow = d.getElementById('flow');
  // العناصر التي تحمل نصاً يلتف على أسطر
  const TEXT = 'p, h2, h3, li, .note, figcaption, figcaption small, td, th, .endnote, .sources a';
  const MIN_KEEP = 2; // أقل عدد أسطر يبقى أسفل الصفحة
  const MIN_REST = 2; // أقل عدد أسطر ينتقل للصفحة التالية
  const wait = (ms) => new Promise((r) => W.setTimeout(r, ms));

  async function assetsReady() {
    const text = (d.body.textContent || '').slice(0, 400000);
    try {
      await Promise.race([Promise.all(cfg.fonts.map((f) => d.fonts.load(f, text).catch(() => null))), wait(9000)]);
      void d.body.offsetHeight; // تخطيط أول يطلب أي خط ناقص
      await Promise.race([d.fonts.ready, wait(6000)]);
    } catch { /* نكمل بالخطوط المتوفرة */ }
    await Promise.race([Promise.all([...d.images].map((im) => (im.decode ? im.decode().catch(() => null) : null))), wait(9000)]);
  }

  // ───────── تثبيت الأسطر ─────────

  // نصوص العنصر نفسه، بدون نصوص العناصر النصية المتداخلة داخله (تُثبَّت لوحدها)
  function ownTexts(block) {
    const out = [];
    const w = d.createTreeWalker(block, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.parentElement.closest(TEXT) === block) out.push(n);
    return out;
  }

  // يقسم النص إلى كلمات، كل كلمة عقدة نصية (مع فراغها)
  function atomize(block) {
    const atoms = [];
    for (const t of ownTexts(block)) {
      const tokens = t.nodeValue.match(/\s*\S+\s*/g);
      if (!tokens) continue;
      let node = t;
      for (let i = 0; i < tokens.length - 1; i++) {
        const next = node.splitText(tokens[i].length);
        atoms.push(node);
        node = next;
      }
      atoms.push(node);
    }
    return atoms;
  }

  // أول حرف من الكلمة يقع على السطر الذي قمته top (لكلمة انكسرت داخلياً، مثل رابط طويل)
  function offsetAtLine(atom, top, half) {
    const range = d.createRange();
    const len = atom.nodeValue.length;
    for (let i = 1; i < len; i++) {
      range.setStart(atom, i);
      range.setEnd(atom, i + 1);
      const r = range.getClientRects()[0];
      if (r && (r.width > 0 || r.height > 0) && Math.abs(r.top - top) < half) return i;
    }
    return -1;
  }

  // مواضع بدايات الأسطر (قراءة فقط)
  function lineBreaks(block, atoms) {
    const cs = getComputedStyle(block);
    let lh = parseFloat(cs.lineHeight);
    if (!(lh > 0)) lh = (parseFloat(cs.fontSize) || 15) * 1.4;
    const half = lh * 0.5;
    const range = d.createRange();
    const breaks = [];
    let lineTop = null;
    for (const atom of atoms) {
      range.selectNodeContents(atom);
      let first = true;
      for (const r of range.getClientRects()) {
        if (!(r.width > 0 || r.height > 0)) continue;
        if (lineTop === null) lineTop = r.top;
        else if (r.top - lineTop > half) {
          const offset = first ? 0 : offsetAtLine(atom, r.top, half);
          if (offset < 0) return null; // موضع غير محدد: نترك العنصر على التفافه الطبيعي
          breaks.push({ node: atom, offset });
          lineTop = r.top;
        }
        first = false;
      }
    }
    return breaks;
  }

  function prevLeaf(node, stop) {
    let n = node;
    for (;;) {
      while (!n.previousSibling) { n = n.parentNode; if (!n || n === stop) return null; }
      n = n.previousSibling;
      while (n.lastChild) n = n.lastChild;
      if (n.nodeType === 3 && !n.nodeValue.trim()) continue;
      return n;
    }
  }

  function applyBreaks(block, breaks) {
    block.dataset.fz = '1';
    if (!breaks) { block.style.whiteSpace = 'normal'; return; }
    for (let i = breaks.length - 1; i >= 0; i--) {
      let node = breaks[i].node;
      if (breaks[i].offset > 0) node = node.splitText(breaks[i].offset);
      const prev = prevLeaf(node, block);
      if (prev && prev.nodeName === 'BR') continue; // فاصل سطر موجود أصلاً
      node.parentNode.insertBefore(d.createElement('br'), node);
    }
    block.style.whiteSpace = 'nowrap';
  }

  // يثبّت كل النصوص داخل عنصر وُضع للتو في صفحته (كتابة ثم قراءة واحدة ثم كتابة)
  function prepare(node) {
    const targets = node.matches(TEXT) ? [node] : [];
    targets.push(...node.querySelectorAll(TEXT));
    const jobs = targets.filter((t) => !t.dataset.fz).map((b) => ({ b, atoms: atomize(b) }));
    if (!jobs.length) return;
    for (const j of jobs) j.breaks = lineBreaks(j.b, j.atoms);
    for (const j of jobs) applyBreaks(j.b, j.breaks);
    node.normalize();
  }

  // ───────── بناء الصفحات ─────────
  const pages = [];
  const deferred = []; // صور لم تسعها الصفحة: تنتقل لبداية التالية ويكمل النص مكانها
  let page = null;
  let curDir = cfg.dir; // اتجاه الجزء الحالي (الملزمة بلغتين: كل جزء باتجاهه)

  const limit = () => page.body.getBoundingClientRect().bottom;
  const fits = (node) => node.getBoundingClientRect().bottom <= limit() + 0.6;
  const isHeading = (n) => !!n && /^H[23]$/.test(n.nodeName);
  // «وحيد»: لا شيء قبله في الصفحة غير عناوين، فلن يفيد نقله لصفحة جديدة
  function alone(node) {
    for (let p = node.previousElementSibling; p; p = p.previousElementSibling) if (!isHeading(p)) return false;
    return true;
  }

  function newPage() {
    const el = d.createElement('section');
    el.className = 'pg';
    el.dir = curDir;
    el.innerHTML = cfg.pageHtml;
    d.body.append(el);
    page = { el, body: el.querySelector('.pg-body') };
    pages.push(page);
    const waiting = deferred.splice(0);
    for (const fig of waiting) place(fig);
  }

  // يقسم فقرة مثبّتة عند حدّ سطر. يرجع الباقي، أو العنصر نفسه إذا لم يمكن التقسيم.
  function splitLines(block) {
    if (block.querySelector(TEXT)) return block; // فيه عناصر نصية متداخلة: يُنقل كاملاً
    const brs = [...block.querySelectorAll('br')];
    const total = brs.length + 1;
    if (total < MIN_KEEP + MIN_REST) return block;
    const r = block.getBoundingClientRect();
    const cs = getComputedStyle(block);
    const extra = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const lineH = (r.height - extra) / total;
    if (!(lineH > 0)) return block;
    let keep = Math.floor((limit() - r.top - extra + 0.6) / lineH);
    keep = Math.min(keep, total - MIN_REST);
    if (keep < MIN_KEEP) return block;
    const br = brs[keep - 1];
    const range = d.createRange();
    range.setStartAfter(br);
    range.setEndAfter(block.lastChild);
    const rest = block.cloneNode(false);
    rest.append(range.extractContents());
    br.remove();
    rest.classList.add('cont');
    return rest;
  }

  function splitList(list) {
    const items = [...list.children];
    let i = items.findIndex((li) => !fits(li));
    if (i < 0) return null;
    let part = null;
    const piece = splitLines(items[i]);
    if (piece !== items[i]) { part = piece; i += 1; } // البند نفسه انقسم: بدايته تبقى
    if (i === 0) return list;
    const rest = list.cloneNode(false);
    // القائمة قد تبدأ من رقم غير 1 (تكملة قائمة قطعتها فقرة): التكملة على الصفحة التالية تتبعها
    if (list.nodeName === 'OL') rest.style.counterReset = `n ${(parseInt(String(list.style.counterReset || '').split(' ')[1], 10) || 0) + i}`;
    if (part) rest.append(part);
    rest.append(...items.slice(i));
    if (!rest.firstChild) return null;
    return rest;
  }

  function splitTable(table) {
    const rows = [...table.tBodies[0].rows];
    const i = rows.findIndex((tr) => !fits(tr));
    if (i < 0) return null;
    if (i === 0) return table;
    const rest = table.cloneNode(false);
    if (table.tHead) rest.append(table.tHead.cloneNode(true));
    const body = d.createElement('tbody');
    body.append(...rows.slice(i));
    rest.append(body);
    return rest;
  }

  function split(node) {
    if (node.nodeName === 'UL' || node.nodeName === 'OL') return splitList(node);
    if (node.nodeName === 'TABLE') return splitTable(node);
    if (node.nodeName === 'P' || node.classList.contains('note')) return splitLines(node);
    return node;
  }

  function place(node) {
    if (node.dataset && node.dataset.dir) curDir = node.dataset.dir;
    const breaks = node.classList.contains('section-break') || node.classList.contains('part');
    if (breaks && page.body.firstElementChild) newPage();
    else if (node.dataset && node.dataset.dir && !page.body.firstElementChild) page.el.dir = curDir;
    page.body.append(node);
    prepare(node);
    if (fits(node)) return;

    if (node.nodeName === 'FIGURE') {
      if (!alone(node)) { node.remove(); deferred.push(node); return; }
      // صورة أطول من الصفحة: نصغّرها حتى تسع
      const img = node.querySelector('img');
      for (let k = 0; img && k < 8 && !fits(node); k++) img.style.maxHeight = `${Math.max(60, img.getBoundingClientRect().height * 0.85)}px`;
      return;
    }

    const rest = split(node);
    if (!rest) return;
    if (rest !== node) { newPage(); place(rest); return; }
    if (alone(node)) return; // أطول من صفحة ولا يُقسم: يبقى كما هو
    // لا يسع منه شيء: ينتقل كاملاً ومعه أي عنوان قبله حتى لا يبقى العنوان يتيماً
    node.remove();
    const carry = [];
    while (isHeading(page.body.lastElementChild)) { carry.unshift(page.body.lastElementChild); page.body.lastElementChild.remove(); }
    newPage();
    for (const h of carry) place(h);
    place(node);
  }

  function paginate() {
    const blocks = [...flow.children];
    newPage();
    for (const b of blocks) place(b);
    for (let guard = 0; deferred.length && guard < 50; guard++) newPage();
    while (pages.length > 1 && !pages[pages.length - 1].body.firstElementChild) pages.pop().el.remove();
    const total = pages.length + cfg.firstPage - 1;
    pages.forEach((p, i) => {
      p.el.querySelector('.pg-num').textContent = String(i + cfg.firstPage);
      p.el.querySelector('.pg-total').textContent = `/ ${total}`;
    });
    flow.remove();
    const style = d.createElement('style');
    style.textContent = cfg.pagedCss;
    d.head.append(style);
    root.dataset.pages = String(total);
  }

  (async () => {
    try {
      await assetsReady();
      if (flow) paginate();
    } catch (e) {
      root.dataset.pagedError = String((e && e.message) || e).slice(0, 200);
    }
    root.classList.add('mv-ready');
  })();
}
