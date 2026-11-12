// Shared metadata helpers: record shape, name/date parsing, RIS / BibTeX / CSL-JSON / meta-tag parsers, merging.
// Loaded by background.js (importScripts) and popup.html (<script>).
(function (global) {
  'use strict';

  const TYPES = [
    'article-journal', 'article-newspaper', 'article-magazine', 'webpage', 'post-weblog',
    'book', 'chapter', 'paper-conference', 'report', 'thesis'
  ];

  function emptyRec() {
    return {
      type: '', title: '', authors: [], editors: [], containerTitle: '', siteName: '', publisher: '',
      volume: '', issue: '', pages: '', edition: '', number: '', institution: '', genre: '',
      year: '', month: '', day: '', doi: '', url: '', accessed: ''
    };
  }

  const STR_FIELDS = Object.keys(emptyRec()).filter(k => k !== 'authors' && k !== 'editors');

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanDOI(s) {
    if (!s) return '';
    s = String(s).trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep */ }
    const m = s.match(/10\.\d{4,9}\/[^\s"'<>]+/);
    if (!m) return '';
    let d = m[0].replace(/[.,;:\]}>]+$/, '');
    // strip an unbalanced closing parenthesis
    while (d.endsWith(')') && (d.match(/\(/g) || []).length < (d.match(/\)/g) || []).length) d = d.slice(0, -1);
    d = d.replace(/\/(full|abstract|pdf|epdf|html)$/i, '');
    return d;
  }

  const ORG_RE = /\b(university|universit[äé]|institute|institution|association|organi[sz]ation|society|council|committee|department|ministry|agency|foundation|center|centre|corporation|company|inc\.?|ltd\.?|llc|group|office|bureau|team|staff|board|commission|consortium|collaboration|network|school|college|academy|library|museum|government|news|press|times|post|journal|wikipedia|world health)\b/i;
  const PARTICLES = /^(van|von|de|der|den|da|di|del|della|du|la|le|st\.?|bin|ibn|al|el|ten|ter|dos|das)$/i;
  const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv)$/i;

  function parseName(s) {
    if (s && typeof s === 'object') return normName(s);
    s = clean(s).replace(/^(by|作者[:：]?)\s+/i, '').replace(/[,;]\s*$/, '');
    if (!s) return null;
    const lit = s.match(/^\{(.+)\}$/);
    if (lit) return { literal: lit[1].trim() };
    if (/[぀-ヿ㐀-鿿가-힯]/.test(s)) return { literal: s };
    if (ORG_RE.test(s) || s.split(' ').length > 5) return { literal: s };
    if (s.includes(',')) {
      const parts = s.split(',').map(x => x.trim()).filter(Boolean);
      const family = parts[0];
      let suffix = '';
      let rest = parts.slice(1);
      if (rest.length && SUFFIX.test(rest[0])) { suffix = rest.shift(); }
      if (rest.length && SUFFIX.test(rest[rest.length - 1])) { suffix = rest.pop(); }
      return { family, given: rest.join(' '), suffix };
    }
    const parts = s.split(' ');
    if (parts.length === 1) return { family: s, given: '' };
    // PubMed style "Smith JA"
    const last = parts[parts.length - 1];
    if (parts.length >= 2 && /^[A-Z]{1,3}$/.test(last) && /[a-z]/.test(parts[0])) {
      return { family: parts.slice(0, -1).join(' '), given: last.split('').join('. ') + '.' };
    }
    let suffix = '';
    if (SUFFIX.test(parts[parts.length - 1])) suffix = parts.pop().replace(/^,/, '');
    let i = parts.length - 1;
    while (i > 1 && PARTICLES.test(parts[i - 1])) i--;
    return { given: parts.slice(0, i).join(' '), family: parts.slice(i).join(' '), suffix };
  }

  function normName(a) {
    if (!a) return null;
    if (typeof a === 'string') return parseName(a);
    const literal = clean(a.literal || '');
    const family = clean(a.family || '');
    const given = clean(a.given || '');
    const suffix = clean(a.suffix || '');
    if (literal && !family) return { literal };
    if (!family && !given) return null;
    if (!family) return parseName(given);
    return { family, given, suffix };
  }

  function nameList(arr) {
    const out = [];
    const seen = new Set();
    for (const a of arr || []) {
      const n = normName(a);
      if (!n) continue;
      const key = (n.literal || (n.family + '|' + n.given)).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
    return out;
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function monthNum(m) {
    if (!m) return '';
    m = String(m).trim().toLowerCase();
    if (/^\d{1,2}$/.test(m)) { const n = +m; return n >= 1 && n <= 12 ? String(n) : ''; }
    const i = MONTHS.indexOf(m.slice(0, 3));
    return i >= 0 ? String(i + 1) : '';
  }

  function parseDate(s) {
    const out = { year: '', month: '', day: '' };
    if (!s) return out;
    if (Array.isArray(s)) {
      out.year = s[0] ? String(s[0]) : '';
      out.month = s[1] ? String(+s[1]) : '';
      out.day = s[2] ? String(+s[2]) : '';
      return out;
    }
    s = String(s).trim();
    let m;
    if ((m = s.match(/^(\d{4})(?:[-\/.](\d{1,2}))?(?:[-\/.](\d{1,2}))?/))) {
      out.year = m[1]; out.month = m[2] ? String(+m[2]) : ''; out.day = m[3] ? String(+m[3]) : '';
    } else if ((m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/))) {
      out.day = String(+m[1]); out.month = monthNum(m[2]); out.year = m[3];
    } else if ((m = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
      out.month = monthNum(m[1]); out.day = String(+m[2]); out.year = m[3];
    } else if ((m = s.match(/([A-Za-z]{3,})\.?\s+(\d{4})/)) && monthNum(m[1])) {
      out.month = monthNum(m[1]); out.year = m[2];
    } else if ((m = s.match(/(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?(?:\s*(\d{1,2})\s*日)?/))) {
      out.year = m[1]; out.month = m[2] ? String(+m[2]) : ''; out.day = m[3] ? String(+m[3]) : '';
    } else if ((m = s.match(/\b(1[5-9]\d{2}|20\d{2})\b/))) {
      out.year = m[1];
    }
    if (!out.month) out.day = '';
    return out;
  }

  function setDate(rec, s) {
    const d = parseDate(s);
    rec.year = d.year; rec.month = d.month; rec.day = d.day;
    return rec;
  }

  function normRec(r) {
    const out = emptyRec();
    if (!r) return out;
    for (const k of STR_FIELDS) out[k] = clean(r[k]);
    out.authors = nameList(r.authors);
    out.editors = nameList(r.editors);
    out.doi = cleanDOI(out.doi);
    if (!TYPES.includes(out.type)) out.type = mapType(out.type);
    if (out.month) out.month = monthNum(out.month);
    if (out.day && !/^\d{1,2}$/.test(out.day)) out.day = '';
    if (out.year) { const y = out.year.match(/\d{4}/); out.year = y ? y[0] : ''; }
    return out;
  }

  function mapType(t) {
    t = String(t || '').toLowerCase();
    if (!t) return '';
    if (TYPES.includes(t)) return t;
    if (/newspaper|news/.test(t)) return 'article-newspaper';
    if (/magazine/.test(t)) return 'article-magazine';
    if (/blog/.test(t)) return 'post-weblog';
    if (/chapter|incollection|inbook|section/.test(t)) return 'chapter';
    if (/conference|proceedings|inproceedings/.test(t)) return 'paper-conference';
    if (/thesis|dissertation/.test(t)) return 'thesis';
    if (/report/.test(t)) return 'report';
    if (/book|monograph/.test(t)) return 'book';
    if (/article|journal|scholarly|preprint|posted-content/.test(t)) return 'article-journal';
    if (/web|page|site|online|electronic/.test(t)) return 'webpage';
    return '';
  }

  // ---------- CSL-JSON (doi.org content negotiation) ----------
  function fromCSL(c) {
    const r = emptyRec();
    if (!c) return r;
    const first = v => Array.isArray(v) ? (v[0] || '') : (v || '');
    r.type = mapType(c.type);
    if (c.type === 'posted-content' || c.subtype === 'preprint') r.type = 'article-journal';
    r.title = clean(first(c.title));
    if (c.subtitle && first(c.subtitle) && !r.title.includes(':')) r.title += ': ' + clean(first(c.subtitle));
    r.authors = (c.author || []).map(a => a.literal ? { literal: a.literal } : { family: a.family || '', given: a.given || '', suffix: a.suffix || '' });
    r.editors = (c.editor || []).map(a => a.literal ? { literal: a.literal } : { family: a.family || '', given: a.given || '' });
    r.containerTitle = clean(first(c['container-title']));
    r.publisher = clean(c.publisher);
    r.volume = clean(c.volume);
    r.issue = clean(c.issue);
    r.pages = clean(c.page || c['article-number'] || '');
    r.edition = clean(c.edition);
    r.number = clean(c.number);
    r.doi = cleanDOI(c.DOI);
    r.url = clean(c.URL);
    const dp = (c.issued || c['published-print'] || c['published-online'] || c.created || {})['date-parts'];
    if (dp && dp[0]) Object.assign(r, parseDate(dp[0]));
    if (r.type === 'thesis') { r.institution = r.publisher; r.genre = clean(c.genre); }
    return normRec(r);
  }

  // ---------- RIS ----------
  const RIS_TYPES = {
    JOUR: 'article-journal', JFULL: 'article-journal', EJOUR: 'article-journal', ABST: 'article-journal',
    BOOK: 'book', EBOOK: 'book', CHAP: 'chapter', ECHAP: 'chapter',
    CONF: 'paper-conference', CPAPER: 'paper-conference', RPRT: 'report', THES: 'thesis',
    ELEC: 'webpage', WEB: 'webpage', NEWS: 'article-newspaper', MGZN: 'article-magazine', BLOG: 'post-weblog'
  };

  function parseRIS(text) {
    const tags = {};
    const lines = String(text).split(/\r?\n/);
    let started = false;
    for (const line of lines) {
      const m = line.match(/^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/);
      if (!m) continue;
      const [, tag, val] = m;
      if (tag === 'TY') { if (started) break; started = true; }
      if (tag === 'ER') break;
      (tags[tag] = tags[tag] || []).push(val.trim());
    }
    const g = (...ks) => { for (const k of ks) if (tags[k] && tags[k][0]) return tags[k][0]; return ''; };
    const r = emptyRec();
    r.type = RIS_TYPES[g('TY')] || '';
    r.title = g('TI', 'T1', 'CT');
    r.authors = [...(tags.AU || []), ...(tags.A1 || [])];
    r.editors = [...(tags.ED || []), ...(tags.A2 || [])];
    r.containerTitle = r.type === 'chapter' ? g('BT', 'T2') : g('JF', 'T2', 'JO', 'JA', 'J2', 'BT');
    r.publisher = g('PB');
    r.volume = g('VL');
    r.issue = g('IS', 'CP');
    const sp = g('SP'), ep = g('EP');
    r.pages = sp && ep && sp !== ep ? `${sp}-${ep}` : sp;
    r.edition = g('ET');
    r.number = g('SN') && r.type === 'report' ? '' : '';
    r.doi = cleanDOI(g('DO', 'M3', 'N1'));
    r.url = g('UR', 'L2');
    setDate(r, g('PY', 'Y1', 'DA', 'Y2'));
    if (!r.month) { const d = parseDate(g('DA')); if (d.year === r.year) Object.assign(r, d); }
    if (r.type === 'thesis') r.institution = r.publisher;
    return normRec(r);
  }

  // ---------- BibTeX ----------
  function delatex(s) {
    return String(s || '')
      .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\\$/g, '$')
      .replace(/\\["'`^~=.uvHckr]\s*\{?([A-Za-z])\}?/g, '$1')
      .replace(/\\[a-zA-Z]+\s*/g, '')
      .replace(/[{}]/g, '')
      .replace(/---/g, '—').replace(/--/g, '–')
      .replace(/\s+/g, ' ').trim();
  }

  function parseBibTeX(text) {
    text = String(text);
    const start = text.search(/@\w+\s*[{(]/);
    if (start < 0) return emptyRec();
    const head = text.slice(start).match(/^@(\w+)\s*[{(]\s*([^,]*),/);
    if (!head) return emptyRec();
    const btype = head[1].toLowerCase();
    let i = start + head[0].length;
    const fields = {};
    while (i < text.length) {
      const fm = text.slice(i).match(/^\s*([A-Za-z][\w-]*)\s*=\s*/);
      if (!fm) break;
      i += fm[0].length;
      const name = fm[1].toLowerCase();
      let val = '';
      if (text[i] === '{') {
        let depth = 0, j = i;
        for (; j < text.length; j++) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}') { depth--; if (depth === 0) break; }
        }
        val = text.slice(i + 1, j); i = j + 1;
      } else if (text[i] === '"') {
        let j = i + 1;
        for (; j < text.length; j++) if (text[j] === '"' && text[j - 1] !== '\\') break;
        val = text.slice(i + 1, j); i = j + 1;
      } else {
        const m = text.slice(i).match(/^[^,}\n]+/);
        val = m ? m[0] : ''; i += val.length;
      }
      fields[name] = val.trim();
      const sep = text.slice(i).match(/^\s*,?/);
      i += sep[0].length;
      if (/^\s*[})]/.test(text.slice(i))) break;
    }
    const f = k => delatex(fields[k]);
    const r = emptyRec();
    r.type = ({
      article: 'article-journal', book: 'book', inbook: 'chapter', incollection: 'chapter',
      inproceedings: 'paper-conference', conference: 'paper-conference', techreport: 'report',
      phdthesis: 'thesis', mastersthesis: 'thesis', online: 'webpage', electronic: 'webpage', www: 'webpage'
    })[btype] || '';
    r.title = f('title');
    const splitNames = s => (fields[s] || '').split(/\s+and\s+/i).map(x => delatex(x)).filter(Boolean)
      .map(x => /^\{.*\}$/.test((fields[s] || '').trim()) && !x.includes(',') && x.split(' ').length > 3 ? { literal: x } : x);
    r.authors = splitNames('author');
    r.editors = splitNames('editor');
    r.containerTitle = f('journal') || f('journaltitle') || f('booktitle');
    r.publisher = f('publisher');
    r.volume = f('volume');
    r.issue = f('number') || f('issue');
    r.pages = f('pages').replace(/–/g, '-');
    r.edition = f('edition');
    r.doi = cleanDOI(f('doi'));
    r.url = f('url');
    r.institution = f('school') || f('institution');
    if (btype === 'phdthesis') r.genre = 'Doctoral dissertation';
    if (btype === 'mastersthesis') r.genre = "Master's thesis";
    if (btype === 'techreport') { r.publisher = r.publisher || r.institution; r.number = f('number'); r.issue = ''; }
    if (f('date')) setDate(r, f('date'));
    else { r.year = f('year'); r.month = monthNum(f('month')); }
    return normRec(r);
  }

  // ---------- meta tags & JSON-LD (gathered by extractor.js) ----------
  function fromMeta(page) {
    const M = page.meta || {};
    const g = (...ks) => { for (const k of ks) if (M[k] && M[k][0]) return M[k][0]; return ''; };
    const all = (...ks) => { for (const k of ks) if (M[k] && M[k].length) return M[k]; return []; };
    const r = emptyRec();
    r.title = g('citation_title', 'bepress_citation_title', 'dc.title', 'dcterms.title', 'eprints.title', 'og:title', 'parsely-title');
    let authors = all('citation_author', 'bepress_citation_author', 'dc.creator', 'dcterms.creator', 'eprints.creators_name');
    if (!authors.length && g('citation_authors')) authors = g('citation_authors').split(/\s*;\s*/);
    if (!authors.length) authors = all('article:author', 'author', 'parsely-author', 'sailthru.author').filter(a => !/^https?:/.test(a));
    if (authors.length === 1 && /;| and |\s&\s/.test(authors[0]) && !authors[0].includes(',')) authors = authors[0].split(/\s*(?:;|\band\b|&)\s*/);
    if (!authors.length && page.bylines) authors = page.bylines;
    r.authors = authors;
    r.containerTitle = g('citation_journal_title', 'bepress_citation_journal_title', 'citation_conference_title', 'citation_book_title', 'citation_inbook_title', 'prism.publicationname', 'dc.source', 'eprints.publication');
    r.publisher = g('citation_publisher', 'dc.publisher', 'dcterms.publisher', 'eprints.publisher');
    r.volume = g('citation_volume', 'prism.volume', 'eprints.volume');
    r.issue = g('citation_issue', 'prism.number', 'prism.issueidentifier', 'eprints.number');
    const fp = g('citation_firstpage', 'prism.startingpage'), lp = g('citation_lastpage', 'prism.endingpage');
    r.pages = fp && lp && fp !== lp ? `${fp}-${lp}` : (fp || g('eprints.pagerange'));
    r.doi = cleanDOI(page.doi || g('citation_doi', 'prism.doi', 'dc.identifier', 'bepress_citation_doi'));
    r.institution = g('citation_dissertation_institution', 'citation_technical_report_institution', 'eprints.institution');
    r.number = g('citation_technical_report_number');
    setDate(r, g('citation_publication_date', 'citation_date', 'bepress_citation_date', 'citation_cover_date', 'citation_online_date', 'prism.publicationdate', 'dc.date', 'dcterms.issued', 'dcterms.date', 'eprints.date', 'article:published_time', 'parsely-pub-date', 'datepublished') || page.timeDatetime || '');
    r.siteName = g('og:site_name', 'application-name') || '';
    r.url = page.canonical || page.url || '';
    if (g('citation_journal_title', 'prism.publicationname', 'bepress_citation_journal_title')) r.type = 'article-journal';
    else if (g('citation_conference_title')) r.type = 'paper-conference';
    else if (g('citation_inbook_title') || (g('citation_book_title') && r.pages)) r.type = 'chapter';
    else if (g('citation_dissertation_institution')) r.type = 'thesis';
    else if (g('citation_technical_report_institution')) r.type = 'report';
    else if (g('citation_isbn') || g('citation_book_title')) { r.type = 'book'; if (!r.containerTitle || r.containerTitle === r.title) r.containerTitle = ''; }
    else if (g('citation_title')) r.type = 'article-journal';
    else r.type = 'webpage';
    return normRec(r);
  }

  function ldName(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return ldName(v[0]);
    return v.name || '';
  }

  function fromJSONLD(list) {
    const r = emptyRec();
    if (!list || !list.length) return r;
    const pri = t => /scholarly|medicalscholarly/i.test(t) ? 0 : /article|posting|report|thesis|chapter|book/i.test(t) ? 1 : /webpage/i.test(t) ? 2 : 3;
    const nodes = list.slice().sort((a, b) => pri(String(a['@type'])) - pri(String(b['@type'])));
    const o = nodes[0];
    const t = String(Array.isArray(o['@type']) ? o['@type'].join(' ') : o['@type'] || '');
    if (pri(t) > 2) return r;
    r.type = /newsarticle|reportagenews/i.test(t) ? 'article-newspaper' : /blog/i.test(t) ? 'post-weblog' :
      /scholarly/i.test(t) ? 'article-journal' : /chapter/i.test(t) ? 'chapter' : /book/i.test(t) ? 'book' :
      /thesis/i.test(t) ? 'thesis' : /report/i.test(t) ? 'report' : 'webpage';
    r.title = clean(o.headline || o.name || '');
    const au = o.author || o.creator;
    r.authors = (Array.isArray(au) ? au : au ? [au] : []).map(a => {
      if (typeof a === 'string') return a;
      if (a.givenName || a.familyName) return { given: a.givenName || '', family: a.familyName || '' };
      if (/organization/i.test(String(a['@type'])) && a.name) return { literal: a.name };
      return a.name || '';
    }).filter(Boolean);
    setDate(r, o.datePublished || o.dateCreated || o.dateModified || '');
    r.publisher = ldName(o.publisher);
    // walk isPartOf chain: PublicationIssue -> PublicationVolume -> Periodical
    let p = o.isPartOf, guard = 0;
    while (p && guard++ < 5) {
      if (Array.isArray(p)) p = p[0];
      const pt = String(p['@type'] || '');
      if (/issue/i.test(pt)) r.issue = r.issue || String(p.issueNumber || '');
      else if (/volume/i.test(pt)) r.volume = r.volume || String(p.volumeNumber || '');
      else if (p.name) r.containerTitle = r.containerTitle || p.name;
      if (p.volumeNumber) r.volume = r.volume || String(p.volumeNumber);
      p = p.isPartOf;
    }
    if (o.pageStart) r.pages = o.pageEnd ? `${o.pageStart}-${o.pageEnd}` : String(o.pageStart);
    else if (o.pagination) r.pages = String(o.pagination);
    const ids = [].concat(o.identifier || [], o.sameAs || [], o['@id'] || []);
    for (const id of ids) { const d = cleanDOI(typeof id === 'string' ? id : (id.value || id['@id'] || '')); if (d) { r.doi = d; break; } }
    r.url = typeof o.url === 'string' ? o.url : '';
    if (r.type === 'webpage' || r.type === 'article-newspaper' || r.type === 'post-weblog') {
      if (!r.containerTitle && r.type === 'article-newspaper') r.containerTitle = r.publisher;
    }
    return normRec(r);
  }

  // ---------- merging & completeness ----------
  function mergeRecs(list) {
    const out = emptyRec();
    for (const raw of list) {
      if (!raw) continue;
      const r = normRec(raw);
      for (const k of STR_FIELDS) if (!out[k] && r[k]) out[k] = r[k];
      if (!out.authors.length && r.authors.length) out.authors = r.authors;
      if (!out.editors.length && r.editors.length) out.editors = r.editors;
      // day/month belong with the year they came with
    }
    return out;
  }

  const PERIODICAL = new Set(['article-journal', 'article-newspaper', 'article-magazine']);
  const WEB = new Set(['webpage', 'post-weblog']);

  function effType(r) {
    if (r.type) return r.type;
    if (r.containerTitle && (r.volume || r.doi || r.issue)) return 'article-journal';
    if (r.publisher && !r.url) return 'book';
    return 'webpage';
  }

  function missingFields(r) {
    const t = effType(r);
    const miss = [];
    if (!r.authors || !r.authors.length) miss.push('作者');
    if (!r.title) miss.push('标题');
    if (!r.year) miss.push('出版年份');
    if (PERIODICAL.has(t)) {
      if (!r.containerTitle) miss.push(t === 'article-journal' ? '期刊名' : '报刊名');
      if (t === 'article-journal' && !r.volume) miss.push('卷号');
      if (t === 'article-journal' && !r.pages && !r.doi) miss.push('页码');
      if (t === 'article-journal' && !r.doi && !r.url) miss.push('DOI / 链接');
    } else if (WEB.has(t)) {
      if (!r.siteName && !r.containerTitle) miss.push('网站名');
      if (!r.url) miss.push('链接');
    } else if (t === 'book' || t === 'report') {
      if (!r.publisher) miss.push('出版社');
    } else if (t === 'chapter' || t === 'paper-conference') {
      if (!r.containerTitle) miss.push(t === 'chapter' ? '书名' : '会议论文集名');
      if (!r.pages) miss.push('页码');
    } else if (t === 'thesis') {
      if (!r.institution) miss.push('授予学校');
    }
    return miss;
  }

  function titleSimilar(a, b) {
    const toks = s => new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3));
    const A = toks(a), B = toks(b);
    if (!A.size || !B.size) return false;
    let hit = 0;
    for (const w of A) if (B.has(w)) hit++;
    return hit / Math.min(A.size, B.size) >= 0.5;
  }

  function cacheKey(url) {
    return 'cite:' + String(url || '').split('#')[0];
  }

  const api = {
    TYPES, emptyRec, normRec, clean, cleanDOI, parseName, normName, nameList, parseDate, monthNum, mapType,
    fromCSL, parseRIS, parseBibTeX, fromMeta, fromJSONLD, mergeRecs, missingFields, effType, titleSimilar, cacheKey,
    PERIODICAL, WEB
  };
  global.CiteParsers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
