// APA 7 and MLA 9 formatter. Input: a record from parsers.js. Output: {text, html} pieces.
(function (global) {
  'use strict';
  const P = global.CiteParsers || (typeof require !== 'undefined' ? require('./parsers.js') : null);

  const APA_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
  const STANDALONE = new Set(['book', 'report', 'thesis', 'webpage', 'post-weblog']);
  const PERIODICAL = new Set(['article-journal', 'article-newspaper', 'article-magazine']);
  const WEB = new Set(['webpage', 'post-weblog']);

  // italics are marked with \u0001 ... \u0002 while building, then rendered to HTML or stripped for plain text
  const I = s => (s ? '\u0001' + s + '\u0002' : '');
  const visible = s => String(s).replace(/[\u0001\u0002]/g, '');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function dot(s) {
    if (!s) return '';
    s = s.trim();
    return /[.?!]$/.test(visible(s).trim()) ? s : s + '.';
  }
  function out(s) {
    return { text: visible(s), html: esc(s).replace(/\u0001/g, '<i>').replace(/\u0002/g, '</i>') };
  }

  // ---------- capitalization ----------
  const MINOR_MLA = new Set('a an the and but or nor for so yet as at by from in into of off on onto out over per to up upon via with vs vs. v. than between among through without within across after before under against during toward towards about like near'.split(' '));
  const MINOR_APA = new Set('a an the and but or nor for so yet as at by in of off on per to up via vs vs. v.'.split(' '));
  const capFirst = w => w.replace(/^([^\p{L}]*)(\p{L})/u, (m, a, b) => a + b.toUpperCase());
  const keepCase = p => /[A-Z]{2,}/.test(p) || /[a-z][A-Z]/.test(p) || (/\d/.test(p) && /[A-Z]/.test(p));

  // a whole title shouted in capitals (not a single acronym like "WWF")
  const shouty = s => s === s.toUpperCase() && /[A-Z]{3,}/.test(s) && /\s/.test(s.trim());

  function titleCase(s, style) {
    if (!s) return '';
    const allCaps = shouty(s);
    const src = allCaps ? s.toLowerCase() : s;
    const minor = style === 'apa' ? MINOR_APA : MINOR_MLA;
    const words = src.split(/(\s+)/);
    const idx = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter(i => i >= 0);
    let startNext = true;
    idx.forEach((i, k) => {
      let w = words[i];
      const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, '').toLowerCase();
      const first = startNext, last = k === idx.length - 1;
      if (!first && !last && minor.has(core)) w = w.toLowerCase() === w || !keepCase(w) ? w.toLowerCase() : w;
      else w = w.split('-').map(p => (keepCase(p) && !allCaps ? p : capFirst(p))).join('-');
      words[i] = w;
      startNext = /[:?!—]$/.test(w);
    });
    return words.join('');
  }

  // APA wants sentence case for titles of works. Only convert titles that are clearly in Title Case.
  function sentenceCase(s) {
    if (!s) return '';
    const allCaps = shouty(s);
    const words = s.split(/(\s+)/);
    const longWords = words.filter(w => /[A-Za-z]{4,}/.test(w));
    const capped = longWords.filter(w => /^[^A-Za-z]*[A-Z]/.test(w)).length;
    if (!allCaps && (longWords.length < 2 || capped / longWords.length < 0.6)) return s;
    let start = true;
    return words.map(w => {
      if (!/\S/.test(w)) return w;
      let o = w.split('-').map((p, j) => {
        if (!allCaps && keepCase(p)) return p;
        if (/^I('|’|$)/.test(p)) return p;
        const low = p.toLowerCase();
        return start && j === 0 ? capFirst(low) : low;
      }).join('-');
      start = /[:?!.—]$/.test(w);
      return o;
    }).join('');
  }

  // ---------- names ----------
  const initials = given => String(given || '')
    .replace(/\./g, '. ').split(/\s+/).filter(Boolean)
    .map(part => part.split('-').filter(Boolean).map(x => x[0].toUpperCase() + '.').join('-'))
    .join(' ');
  const isLit = a => !!a.literal && !a.family;

  function apaName(a) {
    if (isLit(a)) return a.literal;
    let s = a.family;
    if (a.given) s += ', ' + initials(a.given);
    if (a.suffix) s += ', ' + a.suffix;
    return s;
  }
  function apaAuthors(list) {
    const n = list.map(apaName);
    if (n.length === 1) return n[0];
    if (n.length === 2) return `${n[0]}, & ${n[1]}`;
    if (n.length <= 20) return n.slice(0, -1).join(', ') + ', & ' + n[n.length - 1];
    return n.slice(0, 19).join(', ') + ', . . . ' + n[n.length - 1];
  }
  function apaEditors(list) {
    const n = list.map(a => (isLit(a) ? a.literal : [initials(a.given), a.family].filter(Boolean).join(' ')));
    const names = n.length === 1 ? n[0] : n.length === 2 ? `${n[0]} & ${n[1]}` : n.slice(0, -1).join(', ') + ', & ' + n[n.length - 1];
    return `${names} (${n.length > 1 ? 'Eds.' : 'Ed.'})`;
  }
  function mlaFirst(a) {
    if (isLit(a)) return a.literal;
    return [a.family, a.given, a.suffix].filter(Boolean).join(', ');
  }
  const mlaPlain = a => (isLit(a) ? a.literal : [a.given, a.family].filter(Boolean).join(' ') + (a.suffix ? ', ' + a.suffix : ''));
  function mlaAuthors(list) {
    if (list.length === 1) return mlaFirst(list[0]);
    if (list.length === 2) return `${mlaFirst(list[0])}, and ${mlaPlain(list[1])}`;
    return `${mlaFirst(list[0])}, et al`;
  }
  const surname = a => (isLit(a) ? a.literal : a.family || a.given);

  // ---------- helpers ----------
  const pagesDash = (p, d) => String(p || '').replace(/\s*[-–—]+\s*/g, d);
  const multiPage = p => /[-–—,]/.test(p);
  const ordinal = e => {
    if (!/^\d+$/.test(e)) return e.replace(/\s*(ed\.?|edition)$/i, '');
    const n = +e, s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';
    return n + s;
  };
  const doiURL = d => (d ? 'https://doi.org/' + d : '');
  const noProto = u => String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const same = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  function shortTitle(t) {
    const words = t.split(/\s+/);
    let s = words.slice(0, 4).join(' ');
    const colon = t.indexOf(':');
    if (colon > 0 && colon < s.length) s = t.slice(0, colon);
    return s.replace(/[.,:;]+$/, '');
  }
  function names(r) { return (r.authors || []).filter(a => a && (a.literal || a.family || a.given)); }

  // ================= APA 7 =================
  function apaDate(r, t) {
    if (!r.year) return '(n.d.).';
    const withDay = WEB.has(t) || t === 'article-newspaper' || t === 'article-magazine';
    if (withDay && r.month) return `(${r.year}, ${APA_MONTHS[+r.month - 1]}${r.day ? ' ' + r.day : ''}).`;
    return `(${r.year}).`;
  }

  function apaReference(r) {
    const t = P.effType(r);
    const au = names(r);
    const title = sentenceCase(r.title || '');
    const italic = STANDALONE.has(t);
    let titleBlock = '';
    if (title) {
      let tb = italic ? I(title) : title;
      if (t === 'book' && r.edition) tb += ` (${ordinal(r.edition)} ed.)`;
      if (t === 'report' && r.number) tb += ` (${r.number})`;
      if (t === 'thesis') tb += ` [${[r.genre || 'Doctoral dissertation', r.institution].filter(Boolean).join(', ')}]`;
      titleBlock = dot(tb);
    }
    const pages = pagesDash(r.pages, '–');
    const parts = [];
    if (PERIODICAL.has(t)) {
      if (r.containerTitle) {
        let s = I(r.containerTitle);
        if (r.volume) s += ', ' + I(r.volume);
        if (r.issue) s += r.volume ? `(${r.issue})` : `, (${r.issue})`;
        if (pages) s += ', ' + pages;
        parts.push(dot(s));
      }
    } else if (t === 'chapter' || t === 'paper-conference') {
      if (r.containerTitle) {
        let s = 'In ' + ((r.editors || []).length ? apaEditors(r.editors) + ', ' : '') + I(r.containerTitle);
        if (pages) s += ` (${multiPage(pages) ? 'pp.' : 'p.'} ${pages})`;
        parts.push(dot(s));
      }
      if (r.publisher) parts.push(dot(r.publisher));
    } else if (WEB.has(t)) {
      const site = r.siteName || r.containerTitle;
      if (site && !(au.length === 1 && same(apaName(au[0]), site))) parts.push(dot(site));
    } else {
      const pub = t === 'thesis' ? (same(r.publisher, r.institution) ? '' : r.publisher) : r.publisher;
      if (pub && !(au.length === 1 && same(apaName(au[0]), pub))) parts.push(dot(pub));
    }
    const link = WEB.has(t) ? r.url : (doiURL(r.doi) || r.url);
    const date = apaDate(r, t);
    const seq = au.length ? [dot(apaAuthors(au)), date, titleBlock, ...parts, link] : [titleBlock, date, ...parts, link];
    return out(seq.filter(Boolean).join(' '));
  }

  function apaInText(r, page) {
    const t = P.effType(r);
    const au = names(r);
    const year = r.year || 'n.d.';
    const loc = page ? `, ${multiPage(page) ? 'pp.' : 'p.'} ${pagesDash(page, '–')}` : '';
    let paren, narr;
    if (au.length) {
      const s = au.map(surname);
      paren = au.length === 1 ? s[0] : au.length === 2 ? `${s[0]} & ${s[1]}` : `${s[0]} et al.`;
      narr = au.length === 1 ? s[0] : au.length === 2 ? `${s[0]} and ${s[1]}` : `${s[0]} et al.`;
      return { paren: out(`(${paren}, ${year}${loc})`), narr: out(`${narr} (${year})${loc ? ` … (${loc.slice(2)})` : ''}`) };
    }
    const st = titleCase(shortTitle(r.title || 'Untitled'), 'apa');
    if (STANDALONE.has(t)) {
      return { paren: out(`(${I(st)}, ${year}${loc})`), narr: out(`${I(st)} (${year})${loc ? ` … (${loc.slice(2)})` : ''}`) };
    }
    return { paren: out(`(“${st},” ${year}${loc})`), narr: out(`“${st}” (${year})${loc ? ` … (${loc.slice(2)})` : ''}`) };
  }

  // ================= MLA 9 =================
  function mlaDateOf(y, m, d) {
    if (!y) return '';
    if (!m) return y;
    return `${d ? d + ' ' : ''}${MLA_MONTHS[+m - 1]} ${y}`;
  }
  function mlaAccessed(s) {
    const d = P.parseDate(s);
    return mlaDateOf(d.year, d.month, d.day);
  }

  function mlaReference(r) {
    const t = P.effType(r);
    const au = names(r);
    const title = titleCase(r.title || '', 'mla');
    const standalone = STANDALONE.has(t) && !WEB.has(t);
    let titleBlock = '';
    if (title) titleBlock = standalone ? dot(I(title)) : (/[?!]$/.test(title) ? `“${title}”` : `“${title}.”`);

    const els = [];
    const pages = pagesDash(r.pages, '-');
    // scholarly journals: year only (export files often pad the day); news, magazines and web: full date
    const date = t === 'article-journal' || t === 'book' || t === 'chapter' || t === 'paper-conference'
      ? (r.year || '') : mlaDateOf(r.year, r.month, r.day);
    if (t === 'thesis') {
      const seq = [au.length ? dot(mlaAuthors(au)) : '', titleBlock, r.year ? dot(r.year) : '',
        dot([r.institution, r.genre === "Master's thesis" ? 'MA thesis' : 'PhD dissertation'].filter(Boolean).join(', ')),
        r.doi ? dot(doiURL(r.doi)) : r.url ? dot(noProto(r.url)) : ''];
      return out(seq.filter(Boolean).join(' '));
    }
    const container = WEB.has(t) ? (r.siteName || r.containerTitle) : standalone ? '' : r.containerTitle;
    if (container) els.push(I(titleCase(container, 'mla')));
    if ((t === 'chapter' || t === 'paper-conference') && (r.editors || []).length) {
      const ed = r.editors.map(mlaPlain);
      els.push('edited by ' + (ed.length === 1 ? ed[0] : ed.length === 2 ? `${ed[0]} and ${ed[1]}` : `${ed[0]} et al.`));
    }
    if (r.edition) els.push(`${ordinal(r.edition)} ed.`);
    if (r.volume) els.push('vol. ' + r.volume);
    if (r.issue) els.push('no. ' + r.issue);
    const pubOK = !PERIODICAL.has(t) && r.publisher && !same(r.publisher, container) && !(au.length === 1 && same(mlaFirst(au[0]), r.publisher));
    if (pubOK) els.push(r.publisher);
    if (date) els.push(date);
    if (pages && !WEB.has(t)) els.push((multiPage(pages) ? 'pp. ' : 'p. ') + pages);
    const loc = r.doi ? doiURL(r.doi) : (t === 'book' ? '' : noProto(r.url));
    if (loc) els.push(loc);
    const accessed = WEB.has(t) && !r.year && r.accessed ? `Accessed ${mlaAccessed(r.accessed)}.` : '';
    const seq = [au.length ? dot(mlaAuthors(au)) : '', titleBlock, els.length ? dot(els.join(', ')) : '', accessed];
    return out(seq.filter(Boolean).join(' '));
  }

  function mlaInText(r, page) {
    const t = P.effType(r);
    const au = names(r);
    const pg = page ? ' ' + pagesDash(page, '-') : '';
    if (au.length) {
      const s = au.map(surname);
      const n = au.length === 1 ? s[0] : au.length === 2 ? `${s[0]} and ${s[1]}` : `${s[0]} et al.`;
      return { paren: out(`(${n}${pg})`), narr: out(`${n}${pg ? ` … (${pg.trim()})` : ''}`) };
    }
    const st = titleCase(shortTitle(r.title || 'Untitled'), 'mla');
    const tt = STANDALONE.has(t) && !WEB.has(t) ? I(st) : `“${st}”`;
    return { paren: out(`(${tt}${pg})`), narr: out(`${tt}${pg ? ` … (${pg.trim()})` : ''}`) };
  }

  function format(rec, style, page) {
    const r = P.normRec(rec);
    r.accessed = rec.accessed || '';
    if (style === 'mla') {
      const it = mlaInText(r, page);
      return { reference: mlaReference(r), paren: it.paren, narr: it.narr };
    }
    const it = apaInText(r, page);
    return { reference: apaReference(r), paren: it.paren, narr: it.narr };
  }

  const api = { format, titleCase, sentenceCase };
  global.CiteFormat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
