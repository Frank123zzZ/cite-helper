const P = window.CiteParsers;
const F = window.CiteFormat;
const $ = id => document.getElementById(id);

const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
const STYLES = ['mla', 'apa'];
const TYPE_LABELS = {
  'article-journal': '期刊论文', 'article-newspaper': '报纸文章', 'article-magazine': '杂志文章', 'webpage': '网页',
  'post-weblog': '博客文章', 'book': '书籍', 'chapter': '书籍章节', 'paper-conference': '会议论文', 'report': '报告', 'thesis': '学位论文'
};

const state = { tab: null, key: '', data: null, rec: null, style: 'mla', page: '', settings: {}, editStamp: 0, outputs: null, timer: null };

// ---------------- settings ----------------
async function loadSettings() {
  state.settings = Object.assign({ apiKey: '', model: 'claude-opus-5-5', style: 'mla' }, await chrome.storage.local.get(['apiKey', 'model', 'style']));
  state.style = STYLES.includes(state.settings.style) ? state.settings.style : 'mla';
  setSeg($('styleSeg'), STYLES.indexOf(state.style));
  setSeg($('modelSeg'), Math.max(0, MODELS.indexOf(state.settings.model)));
  $('key').value = state.settings.apiKey || '';
}

function setSeg(seg, v) {
  seg.dataset.v = String(v);
  seg.querySelectorAll('button').forEach(b => {
    const on = b.dataset.v === String(v);
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
}

$('styleSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  setSeg($('styleSeg'), b.dataset.v);
  state.style = STYLES[+b.dataset.v];
  chrome.storage.local.set({ style: state.style });
  render();
});
$('modelSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  setSeg($('modelSeg'), b.dataset.v);
  chrome.storage.local.set({ model: MODELS[+b.dataset.v] });
});
$('gear').addEventListener('click', () => toggleSettings());
function toggleSettings(force) {
  const show = force !== undefined ? force : $('settings').classList.contains('hidden');
  $('settings').classList.toggle('hidden', !show);
  $('main').classList.toggle('hidden', show);
  $('heading').textContent = show ? '设置' : '引用助手';
  $('gear').textContent = show ? '✕' : '⚙';
  $('saveMsg').textContent = '';
}
$('save').addEventListener('click', async () => {
  const apiKey = $('key').value.trim();
  await chrome.storage.local.set({ apiKey });
  state.settings.apiKey = apiKey;
  $('saveMsg').textContent = apiKey ? '已保存' : '已清除 Key';
  if (state.data) updateMeta();
});

// ---------------- status ----------------
function status(text, isError, slim) {
  clearInterval(state.timer);
  const el = $('status');
  if (!text) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.classList.toggle('err', !!isError);
  el.classList.toggle('slim', !!slim);
  el.querySelector('.spin').classList.toggle('hidden', !!isError);
  const t0 = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    $('statusText').textContent = text + (!isError && s >= 3 ? `  ${s}s` : '');
  };
  tick();
  if (!isError) state.timer = setInterval(tick, 1000);
}

// ---------------- main flow ----------------
async function init() {
  await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    status('这个页面无法生成引用（浏览器内置页面）', true);
    return;
  }
  state.key = P.cacheKey(tab.url);
  chrome.storage.session.onChanged.addListener(changes => {
    const c = changes[state.key];
    if (!c || !c.newValue) return;
    if (c.newValue.editStamp && c.newValue.editStamp === state.editStamp) return; // our own edit
    applyCache(c.newValue);
  });
  const cached = (await chrome.storage.session.get(state.key))[state.key];
  if (cached && cached.status === 'done') applyCache(cached);
  else if (cached && cached.status === 'pending' && Date.now() - cached.at < 120000) status(stepText());
  else run();
}

function stepText() {
  return state.settings.apiKey ? '正在获取引用，Claude 整理中…' : '正在获取网站提供的引用…';
}

function applyCache(c) {
  if (c.status === 'pending') { status(stepText()); return; }
  if (c.status === 'error') { status('识别失败：' + c.error, true); return; }
  if (c.status === 'done') show(c);
}

async function run() {
  $('result').classList.add('hidden');
  status('正在读取页面…');
  const tabId = state.tab.id;
  let page;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['extractor.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__citeExtract() });
    page = r.result;
  } catch (e) {
    page = null;
  }
  if (!page) {
    page = { url: state.tab.url, title: state.tab.title || '', host: new URL(state.tab.url).hostname, meta: {}, jsonld: [], exportLinks: [], bylines: [], snippets: [], text: '' };
  }
  // the site has a "Cite" button but no direct export link: open it and copy what it shows
  if (page.citeButton && !page.exportLinks.length && !page.doi) {
    status('正在打开网站的「' + page.citeButton + '」窗口…');
    try {
      const [r2] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__citeOpenDialog() });
      if (r2 && r2.result) page.citeDialog = r2.result;
    } catch (e) { /* ignore */ }
  }
  status(stepText());
  const resp = await chrome.runtime.sendMessage({ type: 'resolve', page });
  if (!resp || !resp.ok) status('识别失败：' + ((resp && resp.error) || '未知错误'), true);
  else show(resp.data);
}

function show(data) {
  // a search the service worker never finished (e.g. browser closed mid-way) is not still running
  if (data.searching && Date.now() - (data.at || 0) > 240000) data.searching = false;
  state.data = data;
  state.rec = data.rec;
  $('result').classList.remove('hidden');
  render();
  buildForm();
  updateMeta();
  if (data.searching) {
    const miss = P.missingFields(state.rec);
    status('信息不全' + (miss.length ? '（缺' + miss.join('、') + '）' : '') + '，Claude 正在上网搜索补全…', false, true);
  } else {
    status('');
  }
}

$('searchBtn').addEventListener('click', () => {
  if (!state.settings.apiKey) return toggleSettings(true);
  doSearch();
});
$('redo').addEventListener('click', () => run());

async function doSearch() {
  state.data.searching = true;
  state.data.at = Date.now();
  status('Claude 正在上网搜索补全…', false, true);
  const resp = await chrome.runtime.sendMessage({ type: 'search', url: state.tab.url });
  if (!resp || !resp.ok) {
    state.data.searching = false;
    status('搜索失败：' + ((resp && resp.error) || '未知错误'), true, true);
  } else show(resp.data);
}

// ---------------- rendering ----------------
function render() {
  if (!state.rec) return;
  const o = F.format(state.rec, state.style, state.page.trim());
  state.outputs = o;
  $('reference').innerHTML = o.reference.html;
  $('paren').innerHTML = o.paren.html;
  $('narr').innerHTML = o.narr.html;
  $('refLabel').textContent = state.style === 'mla' ? 'Works Cited' : 'References';
}

function updateMeta() {
  const miss = P.missingFields(state.rec);
  const m = $('missing');
  m.classList.toggle('hidden', !miss.length);
  if (miss.length) {
    m.innerHTML = '缺少：<b>' + miss.join('、') + '</b>';
    if (!state.settings.apiKey) m.innerHTML += '（填写 API Key 后会自动让 Claude 搜索补全）';
    else if (state.data.searched && !state.data.searching) m.innerHTML += '（Claude 也没找到，可点「编辑」手动填写）';
  }

  // which fields Claude's web search filled in / corrected
  const d = state.data;
  const parts = [];
  if (d.filled && d.filled.length) parts.push('Claude 补全了：<b>' + d.filled.join('、') + '</b>');
  if (d.corrected && d.corrected.length) parts.push('更正了：<b>' + d.corrected.join('、') + '</b>');
  if (d.searched && !parts.length) parts.push('Claude 已搜索核对，没有需要补充的信息');
  const f = $('filled');
  f.innerHTML = parts.join('；');
  f.classList.toggle('hidden', !parts.length);

  const notes = [];
  if (d.notes) notes.push(d.notes);
  if (d.searchError && !d.searching) notes.push('自动搜索未完成（' + d.searchError + '）');
  if (d.claudeError) notes.push('Claude 整理未完成（' + d.claudeError + '），已使用网站数据');
  const n = notes.filter(Boolean).join(' ');
  $('note').textContent = n;
  $('note').classList.toggle('hidden', !n);
  const src = state.data.sources && state.data.sources.length ? state.data.sources.join(' · ') : '网页信息';
  $('src').textContent = '来源：' + src;
  $('src').title = '来源：' + src;
}

$('page').addEventListener('input', e => { state.page = e.target.value; render(); });

document.querySelectorAll('.copy').forEach(btn => btn.addEventListener('click', async () => {
  if (!state.outputs) return;
  const o = state.outputs[btn.dataset.copy];
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([o.html], { type: 'text/html' }),
      'text/plain': new Blob([o.text], { type: 'text/plain' })
    })]);
  } catch (e) {
    await navigator.clipboard.writeText(o.text);
  }
  btn.textContent = '已复制';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('done'); }, 1200);
}));

// ---------------- edit form ----------------
const FIELDS = [
  ['type', '类型', 'w3'], ['authors', '作者（每行一位：姓, 名；机构写成 {机构名}）', 'w3'], ['title', '标题', 'w3'],
  ['containerTitle', '期刊 / 报刊 / 书名', 'w2'], ['siteName', '网站名', ''],
  ['volume', '卷', ''], ['issue', '期', ''], ['pages', '页码', ''],
  ['year', '年', ''], ['month', '月', ''], ['day', '日', ''],
  ['publisher', '出版社 / 机构', 'w2'], ['edition', '版次', ''],
  ['doi', 'DOI', 'w3'], ['url', '链接', 'w3']
];

const authorLine = a => (a.literal && !a.family ? `{${a.literal}}` : [a.family, a.given].filter(Boolean).join(', ') + (a.suffix ? ', ' + a.suffix : ''));

function buildForm() {
  const form = $('form');
  form.innerHTML = '';
  const r = state.rec;
  const byClaude = new Set(state.data.filledKeys || []);
  for (const [k, label, cls] of FIELDS) {
    const wrap = document.createElement('div');
    wrap.className = [cls, byClaude.has(k) ? 'cl' : ''].filter(Boolean).join(' ');
    const l = document.createElement('label');
    l.textContent = label + (byClaude.has(k) ? ' · Claude' : '');
    let input;
    if (k === 'type') {
      input = document.createElement('select');
      for (const t of P.TYPES) input.add(new Option(TYPE_LABELS[t], t));
      input.value = P.effType(r);
    } else if (k === 'authors') {
      input = document.createElement('textarea');
      input.rows = Math.min(6, Math.max(2, r.authors.length));
      input.value = r.authors.map(authorLine).join('\n');
    } else {
      input = document.createElement('input');
      input.value = r[k] || '';
    }
    input.dataset.k = k;
    l.appendChild(input);
    wrap.appendChild(l);
    form.appendChild(wrap);
  }
}

$('form').addEventListener('input', e => {
  const k = e.target.dataset.k;
  if (!k) return;
  const v = e.target.value;
  if (k === 'authors') state.rec.authors = v.split('\n').map(P.parseName).filter(Boolean);
  else state.rec[k] = v.trim();
  render();
  updateMeta();
  saveCache();
});

$('editBtn').addEventListener('click', () => {
  const hidden = $('form').classList.toggle('hidden');
  $('editBtn').textContent = hidden ? '编辑' : '收起';
});

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    state.editStamp = Date.now();
    chrome.storage.session.set({ [state.key]: Object.assign({}, state.data, { rec: state.rec, editStamp: state.editStamp }) });
  }, 300);
}

init();
