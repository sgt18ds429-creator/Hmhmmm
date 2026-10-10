// images.js — البحث عن صور توضيحية من مصادر مفتوحة:
//   Wikimedia Commons  ·  NIH Open-i (صور من أبحاث PubMed Central)  ·  Openverse
// الدوال هنا لا تعتمد على المتصفح: تأخذ دالة net.json(url, {proxy}) لجلب JSON.

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const short = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

const JUNK_TITLE = /\b(logo|icon|flag|locator|signature|stub|barnstar|coat of arms|pictogram|emoji|wikipedia|wikimedia|commons-|symbol|button|banner|map of|portrait of)\b/i;
const OK_MIME = /^image\/(jpeg|png|svg\+xml|webp|gif|tiff)$/;

export async function searchCommons(query, net, limit = 6) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrnamespace: '6', gsrlimit: String(limit + 4),
    gsrsearch: `${query} filetype:bitmap|drawing`,
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '500',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ImageDescription|Credit', iiextmetadatalanguage: 'en',
  });
  const data = await net.json(`https://commons.wikimedia.org/w/api.php?${params}`, { kind: 'wiki' });
  const pages = (data?.query?.pages || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  const out = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || !OK_MIME.test(ii.mime || '') || (ii.width || 0) < 320 || (ii.height || 0) < 200) continue;
    const title = String(p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]{3,5}$/i, '').replace(/_/g, ' ');
    if (JUNK_TITLE.test(title)) continue;
    const em = ii.extmetadata || {};
    const license = stripHtml(em.LicenseShortName?.value);
    if (!license) continue; // بدون ترخيص واضح لا نستخدمها
    const small = ii.thumburl || ii.url;
    out.push({
      id: `c${p.pageid}`, source: 'Wikimedia Commons', title,
      desc: short(stripHtml(em.ImageDescription?.value), 220),
      small, large: ii.responsiveUrls?.['2'] || ii.responsiveUrls?.['1.5'] || small, original: ii.url,
      page: ii.descriptionurl, author: short(stripHtml(em.Artist?.value) || stripHtml(em.Credit?.value) || 'Wikimedia Commons', 80),
      license, licenseUrl: em.LicenseUrl?.value || '', w: ii.width, h: ii.height,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchOpenI(query, net, { kind = 'radiograph', limit = 3 } = {}) {
  const params = new URLSearchParams({ query, m: '1', n: String(limit + 9), it: kind === 'micrograph' ? 'mc' : 'x,c,m,u' });
  const data = await net.json(`https://openi.nlm.nih.gov/api/search?${params}`, { kind: 'openi', proxy: true });
  const out = [];
  for (const it of data?.list || []) {
    if (!it.imgLarge || !it.licenseType) continue; // فقط ما له ترخيص معلن (CC أو وصول مفتوح من PubMed Central)
    const caption = stripHtml(it.image?.caption);
    if (/\b(a|b|c)\)|\(a\)|\bpanel\b/i.test(caption) && caption.length > 260) continue; // لوحات متعددة غالباً
    const first = String(it.authors || '').split(',')[0].trim();
    out.push({
      id: `o${it.uid}_${out.length}`, source: 'NIH Open-i', title: short(stripHtml(it.title), 110), desc: short(caption, 220),
      small: `https://openi.nlm.nih.gov${it.imgLarge}`, large: `https://openi.nlm.nih.gov${it.imgLarge}`, original: `https://openi.nlm.nih.gov${it.imgLarge}`,
      page: (it.pmc_url || '').replace(/^http:/, 'https:'), author: short(`${first ? first + ' et al.' : ''}${it.journal_abbr ? ' — ' + it.journal_abbr : ''}`.trim() || 'PubMed Central', 80),
      license: /^open/i.test(it.licenseType) ? 'Open access (PMC)' : it.licenseType, licenseUrl: (it.licenseURL || '').replace(/^http:/, 'https:'), w: 512, h: 512, proxy: true,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchOpenverse(query, net, limit = 3) {
  const params = new URLSearchParams({ q: query, page_size: String(limit + 6), mature: 'false' });
  const data = await net.json(`https://api.openverse.org/v1/images/?${params}`, { kind: 'openverse' });
  const out = [];
  for (const r of data?.results || []) {
    if (r.provider === 'wikimedia' || r.source === 'wikimedia') continue; // تُجلب من Commons مباشرة
    if ((r.width || 0) < 320 || JUNK_TITLE.test(r.title || '')) continue;
    out.push({
      id: `v${r.id}`, source: `Openverse · ${r.provider || r.source}`, title: short(String(r.title || ''), 110), desc: '',
      small: r.thumbnail, large: `${r.thumbnail}?full_size=true`, original: r.url,
      page: r.foreign_landing_url, author: short(String(r.creator || r.provider || ''), 80),
      license: `CC ${String(r.license || '').toUpperCase()}${r.license_version ? ' ' + r.license_version : ''}`.replace('CC CC0', 'CC0').replace('CC PDM', 'Public domain'),
      licenseUrl: r.license_url || '', w: r.width, h: r.height,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * مرشحات لشكل واحد من كل المصادر، بدون تكرار.
 * figure = { query, alt, kind }
 */
export async function findCandidates(figure, net, max = 6) {
  const jobs = [
    searchCommons(figure.query, net, 5).catch(() => []),
    figure.alt && figure.alt !== figure.query ? searchCommons(figure.alt, net, 3).catch(() => []) : Promise.resolve([]),
    figure.kind === 'radiograph' || figure.kind === 'micrograph' ? searchOpenI(figure.query, net, { kind: figure.kind, limit: 4 }).catch(() => []) : Promise.resolve([]),
    searchOpenverse(figure.query, net, 2).catch(() => []),
  ];
  const [main, alt, openi, ov] = await Promise.all(jobs);
  const seen = new Set();
  const out = [];
  // تداخل المصادر: Commons أولاً ثم Open-i للصور الشعاعية
  const order = figure.kind === 'radiograph' || figure.kind === 'micrograph'
    ? [main.slice(0, 2), openi.slice(0, 2), main.slice(2), alt, openi.slice(2), ov]
    : [main, alt, ov, openi];
  for (const group of order) {
    for (const c of group) {
      const key = c.original || c.id;
      if (seen.has(key)) continue;
      seen.add(key); out.push(c);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** سطر نسب الصورة لمصدرها. */
export function creditLine(c) {
  return [c.source, c.author && c.author !== c.source ? c.author : '', c.license].filter(Boolean).join(' · ');
}
