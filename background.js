// Service worker: fetches the citation data a site provides (DOI registry, RIS/BibTeX exports, cite pages),
// asks Claude to turn it into clean metadata, and runs Claude web search when the user asks for it.
importScripts('parsers.js');
const P = self.CiteParsers;

const DEFAULTS = { apiKey: '', model: 'claude-opus-5-5', style: 'mla' };
const getSettings = async () => Object.assign({}, DEFAULTS, await chrome.storage.local.get(Object.keys(DEFAULTS)));

const setCache = (url, val) => chrome.storage.session.set({ [P.cacheKey(url)]: val });
const getCache = async url => (await chrome.storage.session.get(P.cacheKey(url)))[P.cacheKey(url)];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'resolve') sendResponse({ ok: true, data: await resolve(msg.page) });
      else if (msg.type === 'search') sendResponse({ ok: true, data: await search(msg.url) });
      else sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// ---------------- network helpers ----------------
async function fetchText(url, opts = {}, ms = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, Object.assign({ credentials: 'include', redirect: 'follow', signal: ctl.signal }, opts));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    const text = (await res.text()).slice(0, 60000);
    return { text, type };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCSL(doi) {
  const { text } = await fetchText('https://doi.org/' + encodeURIComponent(doi).replace(/%2F/g, '/'), {
    headers: { Accept: 'application/vnd.citationstyles.csl+json' }, credentials: 'omit'
  });
  return JSON.parse(text);
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// ---------------- resolve: site-provided citation + page metadata (+ Claude) ----------------
async function resolve(page) {
  await setCache(page.url, { status: 'pending', at: Date.now() });
  try {
    const out = await doResolve(page);
    const full = Object.assign({ status: 'done', at: Date.now(), page: slimPage(page) }, out);
    // still incomplete: Claude searches the web right away (no asking); the popup picks up the result from the cache
    // credibility is analysed once the record is final (after the search, when there is one)
    const settings = await getSettings();
    if (settings.apiKey) full.credStatus = 'pending';
    if (settings.apiKey && P.missingFields(full.rec).length) {
      full.searching = true;
      await setCache(page.url, full);
      search(page.url).catch(() => {});
    } else {
      await setCache(page.url, full);
      if (settings.apiKey) assess(page.url);
    }
    return full;
  } catch (e) {
    await setCache(page.url, { status: 'error', error: String(e.message || e) });
    throw e;
  }
}

function slimPage(p) {
  return { url: p.url, canonical: p.canonical, host: p.host, title: p.title, doi: p.doi, text: (p.text || '').slice(0, 6000) };
}

async function doResolve(page) {
  const settings = await getSettings();
  const strong = [];   // structured records the site / DOI registry provides
  const raw = [];      // raw citation material for Claude
  const sources = [];

  // 1) DOI registry (Crossref / DataCite) — the publisher's own citation data
  const doi = P.cleanDOI(page.doi);
  if (doi) {
    try {
      const csl = await fetchCSL(doi);
      const r = P.fromCSL(csl);
      const pageTitle = page.title + ' ' + ((page.meta.citation_title || [])[0] || '');
      if (r.title && (page.doiSource !== 'text' || P.titleSimilar(r.title, pageTitle))) {
        strong.push(r);
        sources.push('DOI');
        raw.push('CSL-JSON from doi.org for ' + doi + ':\n' + JSON.stringify(csl).slice(0, 5000));
      }
    } catch (e) { /* DOI lookup failed — keep going */ }
  }

  // 2) the site's own export links (RIS / BibTeX / CSL) or cite page
  const links = [...((page.citeDialog && page.citeDialog.links) || []), ...(page.exportLinks || [])];
  let htmlPages = 0;
  for (const link of links.slice(0, 8)) {
    try {
      const { text, type } = await fetchText(link.href);
      let r = null, label = '';
      if (/^\s*TY {1,2}- /m.test(text)) { r = P.parseRIS(text); label = 'RIS'; }
      else if (/@\w+\s*[{(]/.test(text) && /title\s*=/i.test(text) && !/<html/i.test(text)) { r = P.parseBibTeX(text); label = 'BibTeX'; }
      else if (/^\s*[{[]/.test(text) && /json/i.test(type)) {
        try { const j = JSON.parse(text); const c = Array.isArray(j) ? j[0] : j; if (c && c.title) { r = P.fromCSL(c); label = 'CSL'; } } catch (e) { /* not CSL */ }
      } else if (/html/i.test(type) && link.citeLike && htmlPages < 2) {
        htmlPages++;
        const t = htmlToText(text).slice(0, 5000);
        if (/\b(APA|MLA|Chicago|Harvard)\b/.test(t) && /\b(1[5-9]|20)\d{2}\b/.test(t)) {
          raw.push(`Text of the site's citation page (${link.href}):\n${t}`);
          if (!sources.includes('网站引用页')) sources.push('网站引用页');
        }
      }
      if (r && r.title) {
        strong.push(r);
        sources.push('网站 ' + label);
        raw.push(`${label} export from the site (${link.href}):\n${text.slice(0, 4000)}`);
        break;
      }
    } catch (e) { /* try the next link */ }
  }

  // 3) the site's "Cite" dialog text and on-page citation snippets
  if (page.citeDialog && page.citeDialog.text) {
    raw.push(`Text copied from the site's "${page.citeDialog.button}" dialog:\n${page.citeDialog.text}`);
    sources.push('网站 Cite 窗口');
  }
  if (page.snippets && page.snippets.length) raw.push('Suggested-citation text shown on the page:\n' + page.snippets.join('\n---\n'));

  // 4) page meta tags & JSON-LD
  const metaRec = P.fromMeta(page);
  const ldRec = P.fromJSONLD(page.jsonld);
  if (page.hasScholarMeta) sources.push('网页元数据');

  const hasSiteCitation = strong.length > 0 || page.hasScholarMeta || !!(page.citeDialog && page.citeDialog.text) || raw.length > 0;
  let rec = P.mergeRecs([...strong, metaRec, ldRec]);

  // 5) Claude reads everything and copies out a clean record
  let usedClaude = false, claudeError = '';
  if (settings.apiKey) {
    try {
      const c = await claudeExtract(page, raw, rec);
      rec = P.mergeRecs([...strong, c, rec]);
      usedClaude = true;
      sources.push('Claude 整理');
    } catch (e) {
      claudeError = String(e.message || e);
    }
  }

  finalize(rec, page);
  return { rec, sources, hasSiteCitation, usedClaude, claudeError, searched: false, notes: '', filled: [], corrected: [], filledKeys: [], searchError: '' };
}

function finalize(rec, page) {
  if (!rec.url) rec.url = page.canonical || page.url;
  if (!rec.accessed) {
    const d = new Date();
    rec.accessed = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  return rec;
}

// ---------------- search: Claude looks the work up on the web ----------------
async function search(url) {
  const cached = await getCache(url);
  if (!cached || !cached.rec) throw new Error('请先识别当前页面');
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('请先在设置里填写 Anthropic API Key');
  await setCache(url, Object.assign({}, cached, { searching: true, at: Date.now() }));
  try {
    const found = await claudeSearch(cached.page, cached.rec, settings.model);
    let rec = P.mergeRecs([found.rec, cached.rec]);
    // a DOI turned up: let the registry confirm the details
    if (found.rec.doi && found.rec.doi !== cached.rec.doi) {
      try {
        const r = P.fromCSL(await fetchCSL(found.rec.doi));
        if (r.title && P.titleSimilar(r.title, found.rec.title || cached.rec.title)) rec = P.mergeRecs([r, rec]);
      } catch (e) { /* ignore */ }
    }
    finalize(rec, cached.page);
    const d = diffRecs(cached.rec, rec);
    const out = Object.assign({}, cached, {
      rec, searched: true, searching: false, notes: found.notes, searchError: '', editStamp: 0,
      filled: d.filled, corrected: d.corrected, filledKeys: d.keys, credStatus: 'pending',
      sources: [...(cached.sources || []).filter(s => s !== 'Claude 搜索'), 'Claude 搜索']
    });
    await setCache(url, out);
    assess(url);
    return out;
  } catch (e) {
    await setCache(url, Object.assign({}, cached, { searching: false, editStamp: 0, credStatus: 'pending', searchError: String((e && e.message) || e) }));
    assess(url);
    throw e;
  }
}

// ---------------- credibility: Claude rates how trustworthy the source is (低 / 中 / 高) ----------------
async function assess(url) {
  const cached = await getCache(url);
  if (!cached || !cached.rec) return;
  let patch;
  try {
    const cred = await claudeCredibility(cached.page || {}, cached.rec, cached.sources || []);
    patch = { cred, credStatus: 'done', credError: '' };
  } catch (e) {
    patch = { credStatus: 'error', credError: String((e && e.message) || e) };
  }
  const latest = (await getCache(url)) || cached; // keep anything written meanwhile (e.g. the user's edits)
  await setCache(url, Object.assign({}, latest, patch, { editStamp: 0 }));
}

const CRED_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    reasons: { type: 'array', items: { type: 'string' } }
  },
  required: ['level', 'summary', 'reasons'],
  additionalProperties: false
};

async function claudeCredibility(page, rec, sources) {
  const content = [
    `Page URL: ${page.url || rec.url}`,
    `Tab title: ${page.title || ''}`,
    `Citation metadata (from ${sources.join(', ') || 'the page'}):\n${JSON.stringify(rec)}`,
    page.text ? `Start of the page text:\n"""\n${page.text.slice(0, 6000)}\n"""` : 'Page text unavailable.'
  ].join('\n\n');

  const system = `You rate how credible a source is for a student who wants to cite it in academic writing. The user is looking at this page in their browser.
Weigh: the kind of source and venue (peer-reviewed journal, academic press, government or intergovernmental body, established news outlet, encyclopedia, company/marketing page, personal blog, forum, content farm); the reputation of the publisher, journal or site (known predatory or low-quality venues, retractions you know of); whether authors are named and have relevant expertise; whether claims are backed by evidence, data or references; how current it is for the topic; and signs of commercial purpose, advocacy or one-sided framing.
level: "high" = peer-reviewed research, academic books, official statistics or a reputable institution with clear authorship and evidence; "medium" = generally reliable but not scholarly or with some limits (quality journalism, reputable organisations' reports and explainers, encyclopedias, preprints not yet peer reviewed, dated material); "low" = anonymous or unverifiable, opinion or marketing, user-generated content, predatory venues, or little or no evidence.
Judge the source as presented — do not invent facts about it. When the information is thin, say so and lean toward the lower level.
summary: one short sentence in Simplified Chinese (under 40 characters) giving the main reason for the rating.
reasons: 2-3 short points in Simplified Chinese (each under 30 characters), e.g. "经同行评审的期刊论文", "作者为该领域研究者", "没有注明作者和来源".`;

  const text = await callClaude({ system, content, schema: CRED_SCHEMA, effort: 'low', maxTokens: 4000 });
  const o = JSON.parse(text);
  return {
    level: ['low', 'medium', 'high'].includes(o.level) ? o.level : 'medium',
    summary: P.clean(o.summary),
    reasons: (o.reasons || []).map(P.clean).filter(Boolean).slice(0, 3)
  };
}

// which fields the search filled in (were empty) or corrected (were different)
const DIFF_FIELDS = [
  ['type', '类型'], ['authors', '作者'], ['title', '标题'], ['containerTitle', '出处'], ['siteName', '网站名'],
  ['editors', '编者'], ['publisher', '出版社'], ['volume', '卷号'], ['issue', '期号'], ['pages', '页码'],
  ['edition', '版次'], ['number', '编号'], ['institution', '授予学校'], ['genre', '论文类型'],
  ['date', '出版日期'], ['doi', 'DOI']
];
function diffRecs(before, after) {
  const names = list => (list || []).map(a => (a.literal || [a.given, a.family].join(' ')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).join('|');
  const val = (r, k) => {
    if (k === 'authors' || k === 'editors') return names(r[k]);
    if (k === 'date') return [r.year, r.month, r.day].map(x => String(x || '').replace(/^0+/, '')).join('-').replace(/-+$/, '');
    return String(r[k] || '').toLowerCase().replace(/[\s.,:;"'“”‘’]+/g, ' ').trim();
  };
  const filled = [], corrected = [], keys = [];
  for (const [k, label] of DIFF_FIELDS) {
    const a = val(before, k), b = val(after, k);
    if (!b || a === b) continue;
    if (k === 'type' && !before.type) continue; // a type guess is not worth reporting
    (a ? corrected : filled).push(label);
    if (k === 'date') keys.push('year', 'month', 'day'); else keys.push(k);
  }
  return { filled, corrected, keys };
}

// ---------------- Claude API ----------------
const API = 'https://api.anthropic.com/v1/messages';

async function callClaude({ system, content, schema, tools, effort, maxTokens }) {
  const s = await getSettings();
  const model = s.model || DEFAULTS.model;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': s.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    // if a safety classifier declines, the API retries on a fallback model by itself
    'anthropic-beta': 'server-side-fallback-2026-07-01'
  };
  const body = {
    model,
    max_tokens: maxTokens || 8000,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort: effort || 'low' },
    fallbacks: 'default'
  };
  if (schema) body.output_config.format = { type: 'json_schema', schema };
  if (tools) body.tools = tools;

  for (let i = 0; i < 5; i++) {
    let res;
    try {
      res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('无法连接 Claude（网络错误）');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || '';
      if (res.status === 401) throw new Error('API Key 无效');
      if (res.status === 429) throw new Error('请求太频繁，请稍后再试');
      if (res.status === 529 || res.status >= 500) throw new Error('Claude 暂时繁忙，请稍后再试');
      throw new Error(`Claude 出错 (${res.status}) ${msg}`.trim());
    }
    if (data.stop_reason === 'refusal') throw new Error('Claude 拒绝了这个请求');
    if (data.stop_reason === 'pause_turn') {
      // long server-tool turn: send it back so Claude can continue
      body.messages = [body.messages[0], { role: 'assistant', content: data.content }];
      continue;
    }
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }
  throw new Error('Claude 搜索时间过长，请重试');
}

const NAME_SCHEMA = {
  type: 'object',
  properties: { given: { type: 'string' }, family: { type: 'string' }, literal: { type: 'string' } },
  required: ['given', 'family', 'literal'],
  additionalProperties: false
};
const REC_FIELDS = ['type', 'title', 'containerTitle', 'siteName', 'publisher', 'volume', 'issue', 'pages', 'edition', 'number', 'institution', 'genre', 'year', 'month', 'day', 'doi', 'url'];
const REC_SCHEMA = {
  type: 'object',
  properties: Object.assign(
    { authors: { type: 'array', items: NAME_SCHEMA }, editors: { type: 'array', items: NAME_SCHEMA } },
    Object.fromEntries(REC_FIELDS.map(k => [k, k === 'type' ? { type: 'string', enum: P.TYPES } : { type: 'string' }]))
  ),
  required: ['authors', 'editors', ...REC_FIELDS],
  additionalProperties: false
};

const FIELD_GUIDE = `Fields:
- type: one of ${P.TYPES.join(', ')} (article-journal also covers preprints; webpage for ordinary web pages, encyclopedia entries, reports-as-webpages; post-weblog for blog posts).
- authors: each person separately with given and family names (keep full given names when known; family name only goes in family). Organizations as authors go in literal with given/family empty. Put people's names in the order published.
- editors: editors of the book/proceedings (chapters, conference papers only).
- title: the work's own title exactly as published (keep its capitalization, include the subtitle after a colon, no trailing period, no quotes or markup).
- containerTitle: journal, newspaper, magazine, book (for a chapter) or proceedings name. Empty for ordinary webpages and books.
- siteName: name of the website for webpages/blog posts (e.g. "Wikipedia", "BBC News"). Empty when not a webpage.
- publisher, volume, issue, pages (e.g. "45-67" or "e1234"), edition, number (report number), institution (thesis-granting school), genre (e.g. "Doctoral dissertation").
- year, month, day: publication date as numbers ("2021", "3", "14"); month/day empty if unknown.
- doi: bare DOI like 10.1234/abcd (no https://doi.org/). url: canonical URL of the work.
Use an empty string (or empty array) for anything you cannot find. Never guess or invent values.`;

async function claudeExtract(page, raw, merged) {
  const metaLines = Object.entries(page.meta || {}).slice(0, 80)
    .map(([k, v]) => `${k}: ${v.slice(0, k.includes('author') ? 40 : 3).join(' | ').slice(0, 1500)}`).join('\n');
  const content = [
    `Page URL: ${page.url}`,
    `Browser tab title: ${page.title}`,
    page.doi ? `DOI found on page: ${page.doi}` : '',
    page.bylines && page.bylines.length ? `Author/byline elements: ${page.bylines.join(' | ')}` : '',
    metaLines ? `Meta tags:\n${metaLines}` : '',
    page.jsonld && page.jsonld.length ? `JSON-LD:\n${JSON.stringify(page.jsonld).slice(0, 4000)}` : '',
    raw.length ? `Citation material the website / DOI registry provides:\n\n${raw.join('\n\n=====\n\n')}` : 'The website provides no citation export.',
    `What the extension parsed so far (may be incomplete or wrong):\n${JSON.stringify(merged)}`,
    `Visible page text (start):\n"""\n${(page.text || '').slice(0, 7000)}\n"""`
  ].filter(Boolean).join('\n\n');

  const system = `You extract bibliographic metadata inside a browser extension that builds APA 7 and MLA 9 citations for the web page the user is viewing.
Describe the work this page IS (the article, paper, book, chapter or web page itself) — not works it cites in its reference list, not related articles, not the website as a whole.
Priority of evidence: (1) citation data the site or the DOI registry provides (RIS/BibTeX/CSL exports, the site's Cite dialog, citation meta tags) — copy names, titles, numbers and dates from it exactly; (2) the page's visible text, bylines and dates; (3) other meta tags.
${FIELD_GUIDE}`;

  const text = await callClaude({ system, content, schema: REC_SCHEMA, effort: 'low', maxTokens: 6000 });
  return P.normRec(JSON.parse(text));
}

async function claudeSearch(page, rec, model) {
  const content = [
    `The user is viewing: ${page.url}`,
    `Tab title: ${page.title}`,
    `What we know so far (may be incomplete or wrong):\n${JSON.stringify(rec)}`,
    page.text ? `Start of the page text:\n"""\n${page.text.slice(0, 2500)}\n"""` : ''
  ].filter(Boolean).join('\n\n');

  const system = `You complete citation metadata for a browser extension that builds APA 7 and MLA 9 citations.
Use web search to identify the exact work the user is viewing and find complete, authoritative details: the publisher's or journal's page, the DOI record (Crossref/DataCite), PubMed, Google Scholar, library catalogs, the author's own site, or — for an ordinary web page — the page itself and its site's about/author pages for author, publication date and site name.
Only report values you confirmed from a reliable source; leave the rest empty. If the "known" values are wrong, correct them.
${FIELD_GUIDE}

When finished, reply with ONLY a JSON object (no prose, no code fence) with exactly these keys: authors, editors, ${REC_FIELDS.join(', ')}, notes.
"notes" is one short sentence in Simplified Chinese saying where the information was confirmed (e.g. "已在出版社页面和 Crossref 核对").`;

  const text = await callClaude({
    system,
    content,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
    effort: 'medium',
    maxTokens: 12000
  });
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('Claude 没有返回可用的结果');
  let obj;
  try { obj = JSON.parse(text.slice(s, e + 1)); } catch (err) { throw new Error('Claude 返回的结果无法解析'); }
  return { rec: P.normRec(obj), notes: P.clean(obj.notes || '') };
}
