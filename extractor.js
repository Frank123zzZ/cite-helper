// Injected into the current tab on demand. Defines two functions in the extension's isolated world:
//   window.__citeExtract()      -> gathers metadata from the page (meta tags, JSON-LD, DOI, export links, text)
//   window.__citeOpenDialog()   -> clicks the site's own "Cite" button (if any) and copies the dialog's text
(() => {
  if (window.__citeExtract) return;

  const META_RE = /^(citation_|bepress_citation_|dc\.|dcterms\.|prism\.|eprints\.|og:|article:|author$|parsely-|sailthru\.|datepublished$|application-name$)/;

  function visible(el) {
    if (!el || !el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }

  function collectMeta() {
    const m = {};
    document.querySelectorAll('meta').forEach(el => {
      const k = (el.getAttribute('name') || el.getAttribute('property') || el.getAttribute('itemprop') || '').trim().toLowerCase();
      const v = (el.getAttribute('content') || '').trim();
      if (!k || !v || !META_RE.test(k)) return;
      (m[k] = m[k] || []);
      if (m[k].length < 300) m[k].push(v.slice(0, 600));
    });
    return m;
  }

  function collectJSONLD() {
    const out = [];
    const DROP = new Set(['articleBody', 'text', 'description', 'image', 'thumbnailUrl', 'associatedMedia', 'video', 'comment', 'potentialAction', 'mainEntityOfPage', 'breadcrumb', 'speakable', 'hasPart', 'citation', 'review']);
    const prune = (o, depth) => {
      if (depth > 5 || o == null) return o;
      if (Array.isArray(o)) return o.slice(0, 50).map(x => prune(x, depth + 1));
      if (typeof o !== 'object') return typeof o === 'string' ? o.slice(0, 500) : o;
      const r = {};
      for (const [k, v] of Object.entries(o)) if (!DROP.has(k)) r[k] = prune(v, depth + 1);
      return r;
    };
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (node['@graph']) visit(node['@graph']);
      const t = String(Array.isArray(node['@type']) ? node['@type'].join(' ') : node['@type'] || '');
      if (/article|scholarly|book|chapter|thesis|report|posting|webpage|creativework/i.test(t) && !/^(website|breadcrumblist|organization|person)$/i.test(t)) out.push(prune(node, 0));
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try { visit(JSON.parse(s.textContent)); } catch (e) { /* ignore broken JSON-LD */ }
    });
    return out.slice(0, 6);
  }

  const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/;

  function findDOI(meta, topText) {
    for (const k of ['citation_doi', 'bepress_citation_doi', 'prism.doi', 'dc.identifier.doi', 'dc.identifier', 'dcterms.identifier']) {
      for (const v of meta[k] || []) { const m = v.match(DOI_RE); if (m) return { doi: m[0], source: 'meta' }; }
    }
    let href = location.href;
    try { href = decodeURIComponent(href); } catch (e) { /* keep */ }
    const u = href.match(/(?:\/doi\/(?:abs\/|full\/|pdf\/|epdf\/|book\/)?|doi\.org\/|[?&]doi=)(10\.\d{4,9}\/[^?#&\s]+)/i);
    if (u) return { doi: u[1], source: 'url' };
    const t = topText.match(/\bdoi\s*[:：]?\s*(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"'<>]+)|https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s"'<>]+)/i);
    if (t) return { doi: t[1] || t[2], source: 'text' };
    return { doi: '', source: '' };
  }

  const EXPORT_HREF = /(\.ris\b|\.bib\b|\.enw\b|\.nbib\b|[?&/](format|type|fmt|citationformat)=(ris|bibtex|bib|refworks|endnote|csl)|bibtex|endnote|export[-_]?citation|downloadcitation|citation[-_]?export|showcit|\/cite\b|\/citation\b|exportcitation|citationexport)/i;
  const EXPORT_TEXT = /^(ris|bibtex|bib ?tex|endnote|refworks|ris \(.*\)|export citations?|download citations?|cite this|cite|citation|how to cite|引用|导出引用|引用本文)\b/i;

  function collectExportLinks(root) {
    const out = [];
    const seen = new Set();
    (root || document).querySelectorAll('a[href], link[rel="alternate"][type]').forEach(a => {
      const href = a.href;
      if (!href || !/^https?:/i.test(href) || seen.has(href)) return;
      const text = (a.innerText || a.getAttribute('title') || a.getAttribute('aria-label') || a.getAttribute('type') || '').trim().slice(0, 60);
      const typed = a.tagName === 'LINK' && /research-info-systems|bibtex|citationstyles/i.test(a.getAttribute('type'));
      if (!typed && !EXPORT_HREF.test(href) && !EXPORT_TEXT.test(text)) return;
      if (/\.pdf(\?|$)/i.test(href) || /mailto:|javascript:/i.test(href)) return;
      seen.add(href);
      const score = (/\.ris\b|=ris|research-info-systems/i.test(href + ' ' + (a.getAttribute('type') || '')) ? 0 : /bib/i.test(href) ? 1 : /csl/i.test(href) ? 1 : 2) + (/^ris|bibtex/i.test(text) ? -0.5 : 0);
      out.push({ href, text, score, citeLike: /cite|citation|引用/i.test(href + ' ' + text) });
    });
    return out.sort((a, b) => a.score - b.score).slice(0, 10);
  }

  function collectBylines() {
    const names = [];
    const sel = '[rel="author"], [itemprop="author"] [itemprop="name"], [itemprop="author"], .author-name, .byline__name, .byline-name, [class*="AuthorName"], [data-testid*="author" i]';
    document.querySelectorAll(sel).forEach(el => {
      const t = (el.innerText || el.getAttribute('content') || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 80 && !/^(by|author|authors|作者)$/i.test(t) && !names.includes(t)) names.push(t);
    });
    return names.slice(0, 12);
  }

  function citeSnippets() {
    const out = [];
    document.querySelectorAll('[class*="cite-this" i], [id*="cite-this" i], [class*="how-to-cite" i], [id*="how-to-cite" i], [class*="citation-text" i], [class*="suggested-citation" i], [id*="suggested-citation" i]').forEach(el => {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length > 30 && t.length < 1500 && /\b(1[5-9]|20)\d{2}\b/.test(t) && !out.includes(t)) out.push(t);
    });
    return out.slice(0, 4);
  }

  const CITE_BTN = /^\s*(cite|cite this|cite this (article|paper|page|item|work|chapter|book)|get (a )?citation|citations? tools?|how to cite|export citations?|引用|引用本文|导出引用)\s*$/i;

  function findCiteButton() {
    const els = document.querySelectorAll('button, [role="button"], summary, a');
    for (const el of els) {
      const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 40 || !CITE_BTN.test(t) || !visible(el)) continue;
      if (el.tagName === 'A') {
        const raw = el.getAttribute('href') || '';
        // only click anchors that don't navigate away from this page
        if (raw && !raw.startsWith('#') && !/^javascript:/i.test(raw)) continue;
      }
      return el;
    }
    return null;
  }

  window.__citeExtract = () => {
    const meta = collectMeta();
    const main = document.querySelector('article, main, [role="main"]');
    let text = (main && main.innerText && main.innerText.length > 800 ? main.innerText : document.body.innerText) || '';
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    const topText = (document.body.innerText || '').slice(0, 6000);
    const doi = findDOI(meta, topText);
    const canonical = (document.querySelector('link[rel="canonical"]') || {}).href || '';
    const time = document.querySelector('article time[datetime], main time[datetime], time[datetime]');
    const hasScholarMeta = !!(meta['citation_title'] || meta['bepress_citation_title'] || meta['prism.publicationname'] || (meta['dc.title'] && meta['dc.creator']));
    const citeBtn = findCiteButton();
    return {
      url: location.href,
      canonical: canonical && /^https?:/.test(canonical) ? canonical : '',
      host: location.hostname.replace(/^www\./, ''),
      title: document.title,
      lang: document.documentElement.lang || '',
      meta,
      jsonld: collectJSONLD(),
      doi: doi.doi,
      doiSource: doi.source,
      exportLinks: collectExportLinks(),
      bylines: collectBylines(),
      snippets: citeSnippets(),
      timeDatetime: time ? time.getAttribute('datetime') : '',
      hasScholarMeta,
      citeButton: citeBtn ? (citeBtn.innerText || citeBtn.getAttribute('aria-label') || 'Cite').trim().slice(0, 40) : '',
      text: text.slice(0, 9000)
    };
  };

  window.__citeOpenDialog = async () => {
    const btn = findCiteButton();
    if (!btn) return null;
    const before = new Set(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], .modal, [class*="popup" i], [class*="cite" i], [class*="citation" i]'));
    btn.click();
    const sel = '[role="dialog"], dialog[open], [aria-modal="true"], .modal, [class*="modal" i], [class*="popup" i], [class*="popover" i], [class*="cite" i], [class*="citation" i]';
    let found = null;
    for (let i = 0; i < 20 && !found; i++) {
      await new Promise(r => setTimeout(r, 200));
      const cands = [...document.querySelectorAll(sel)].filter(el => visible(el));
      const scored = cands.map(el => {
        const t = (el.innerText || '') + ' ' + [...el.querySelectorAll('textarea, input[type="text"]')].map(x => x.value).join(' ');
        const hits = (/\bAPA\b/.test(t) ? 1 : 0) + (/\bMLA\b/.test(t) ? 1 : 0) + (/\b(1[5-9]|20)\d{2}\b/.test(t) ? 1 : 0) + (before.has(el) ? 0 : 1);
        return { el, t, hits, len: t.length };
      }).filter(x => x.hits >= 2 && x.len > 40 && x.len < 20000);
      scored.sort((a, b) => b.hits - a.hits || a.len - b.len);
      if (scored.length) found = scored[0];
    }
    if (!found) return null;
    const text = found.t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
    const links = collectExportLinks(found.el);
    // close the dialog again
    const close = found.el.querySelector('[aria-label*="close" i], [title*="close" i], .close, [class*="close" i], [data-dismiss="modal"]');
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    return { text, links, button: btn.innerText.trim().slice(0, 40) };
  };
})();
