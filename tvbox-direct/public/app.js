/* TVBox 直链搜索 - 前端逻辑 */
'use strict';

const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;

const state = {
  cfgUrl: '',
  cfgId: null,
  sites: [],
  lives: [],
  warehouse: null,
  liveIdx: 0,
  searchCtrl: null,
  detail: null,
  routeIdx: 0,
  hls: null
};

const DEFAULT_CFG = 'https://jijietvbox.lol/jieluntan-fty.json';

/* ---------------- 基础工具 ---------------- */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 1800);
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
    return ok;
  }
}

function proxy(u) {
  return '/api/stream?url=' + enc(u);
}

function siteJson(s) {
  return enc(JSON.stringify(s));
}

async function api(path) {
  const r = await fetch(path);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '请求失败');
  return j;
}

const TYPE_NAME = { 0: 'JSON', 1: 'XML', 3: 'SPIDER', 4: 'JS' };

/* ---------------- 配置加载 ---------------- */

async function loadConfig(url) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('请输入 http(s):// 开头的配置地址');
  const btn = $('#btnLoad');
  btn.disabled = true;
  btn.textContent = '加载中…';
  try {
    const data = await api('/api/config?url=' + enc(url));
    state.cfgUrl = url;
    localStorage.setItem('tvd.cfg', url);
    renderConfig(data);
    toast('配置加载成功');
  } finally {
    btn.disabled = false;
    btn.textContent = '加载配置';
  }
}

function renderConfig(data) {
  const info = $('#cfgInfo');
  info.hidden = false;

  if (data.kind === 'warehouse') {
    state.cfgId = null;
    state.warehouse = data.warehouse;
    state.sites = [];
    state.lives = [];
    info.innerHTML = '<span>多仓配置 · <b>' + data.warehouse.length + '</b> 个子配置</span>';
    $('#tabs').hidden = false;
    showTab('wh');
    renderWarehouse();
    return;
  }

  state.cfgId = data.cfgId || null;
  state.warehouse = null;
  state.sites = (data.sites || []).map((s, i) => Object.assign(s, { _i: i }));
  state.lives = data.lives || [];
  state.sites.forEach((s) => { if (s.supported) s.checked = true; });

  const ok = state.sites.filter((s) => s.supported);
  const uns = state.sites.length - ok.length;
  info.innerHTML =
    '<span>站点 <b>' + state.sites.length + '</b></span>' +
    '<span>可搜索 <b>' + ok.length + '</b></span>' +
    (uns ? '<span class="err">爬虫源 ' + uns + '（不支持）</span>' : '') +
    '<span>直播 <b>' + state.lives.length + '</b></span>';

  $('#tabs').hidden = false;
  $('#tabLive').hidden = state.lives.length === 0;
  $('#tabWh').hidden = true;
  showTab('search');
  renderSites();
  renderLiveSrc();
  if (state.lives.length) loadLive();
}

function renderWarehouse() {
  const box = $('#whList');
  box.innerHTML = '';
  state.warehouse.forEach((w) => {
    const d = document.createElement('div');
    d.className = 'wh-item';
    d.innerHTML = '<b>' + esc(w.name || '未命名') + '</b><span>' + esc(w.url) + '</span>';
    d.onclick = () => {
      $('#cfgUrl').value = w.url;
      loadConfig(w.url).catch((e) => toast(e.message));
    };
    box.appendChild(d);
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 源列表 ---------------- */

function renderSites() {
  const list = $('#siteList');
  const kw = ($('#siteFilter').value || '').trim().toLowerCase();
  list.innerHTML = '';
  const sup = state.sites.filter((s) => s.supported);
  const uns = state.sites.filter((s) => !s.supported);

  sup.forEach((s) => {
    if (kw && !s.name.toLowerCase().includes(kw) && !s.key.toLowerCase().includes(kw)) return;
    const row = document.createElement('label');
    row.className = 'site-item';
    row.innerHTML =
      '<input type="checkbox" ' + (s.checked !== false ? 'checked' : '') + '>' +
      '<span class="nm" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
      '<span class="bd ok">' + (TYPE_NAME[s.type] || s.type) + '</span>';
    row.querySelector('input').onchange = (e) => { s.checked = e.target.checked; updateSiteStat(); };
    list.appendChild(row);
  });
  if (!list.children.length) list.innerHTML = '<div class="empty">' + (kw ? '无匹配源' : '没有可搜索的源') + '</div>';

  updateSiteStat();

  const box = $('#unsBox');
  if (uns.length) {
    box.hidden = false;
    $('#unsCount').textContent = uns.length;
    $('#unsList').innerHTML = uns.map((s) => '<span class="uns-tag" title="' + esc(s.api) + '">' + esc(s.name) + '</span>').join('');
  } else {
    box.hidden = true;
  }
}

function updateSiteStat() {
  const sup = state.sites.filter((s) => s.supported);
  const sel = sup.filter((s) => s.checked);
  $('#siteStat').textContent = sel.length + '/' + sup.length + ' 已选';
}

function checkedSites() {
  return state.sites.filter((s) => s.supported && s.checked);
}

/* ---------------- 搜索 ---------------- */

async function doSearch() {
  const kw = $('#kw').value.trim();
  if (!kw) { $('#kw').focus(); return; }
  const sites = checkedSites();
  if (!sites.length) { toast('请先在左侧勾选要搜索的源'); return; }
  if (state.searchCtrl) state.searchCtrl.abort();
  const ctrl = new AbortController();
  state.searchCtrl = ctrl;

  const bar = $('#statusBar');
  const res = $('#results');
  res.innerHTML = '';
  bar.hidden = false;
  bar.innerHTML = '';

  let total = 0;
  let hitSites = 0;
  const chips = new Map();

  sites.forEach((s) => {
    const c = document.createElement('span');
    c.className = 'chip loading';
    c.innerHTML = '<span class="nm">' + esc(s.name) + '</span>';
    bar.appendChild(c);
    chips.set(s, c);
  });

  let idx = 0;
  const workers = Array.from({ length: Math.min(8, sites.length) }, async () => {
    while (idx < sites.length) {
      if (ctrl.signal.aborted) return;
      const s = sites[idx++];
      try {
        const data = await api('/api/search?cfg=' + state.cfgId + '&i=' + s._i + '&wd=' + enc(kw));
        const chip = chips.get(s);
        chip.className = 'chip ' + (data.list.length ? 'done' : 'empty');
        chip.innerHTML = '<span class="nm">' + esc(s.name) + '</span>' + data.list.length;
        if (data.list.length && !ctrl.signal.aborted) {
          hitSites++;
          total += data.list.length;
          renderGroup(s, data.list);
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const chip = chips.get(s);
        chip.className = 'chip fail';
        chip.title = e.message;
        chip.innerHTML = '<span class="nm">' + esc(s.name) + '</span><span class="em">' + esc(String(e.message).slice(0, 24)) + '</span>';
      }
    }
  });
  await Promise.all(workers);
  if (!ctrl.signal.aborted) {
    if (!total) {
      res.innerHTML = '<div class="empty">所有源都没有搜到「' + esc(kw) + '」，试试换个关键词或换源</div>';
    }
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.borderColor = 'var(--acc)';
    chip.style.color = 'var(--acc)';
    chip.textContent = '共 ' + total + ' 条 · ' + hitSites + ' 个源有结果';
    bar.prepend(chip);
  }
}

function renderGroup(site, list) {
  const wrap = document.createElement('div');
  wrap.className = 'grp';
  wrap.innerHTML =
    '<div class="grp-head"><b>' + esc(site.name) + '</b><span>' + list.length + ' 条</span></div>' +
    '<div class="cards"></div>';
  const cards = wrap.querySelector('.cards');
  list.forEach((item) => {
    const c = document.createElement('div');
    c.className = 'card';
    c.innerHTML =
      '<div class="t" title="' + esc(item.name) + '">' + esc(item.name) + '</div>' +
      '<div class="s">' +
      (item.year ? '<span>' + esc(item.year) + '</span>' : '') +
      (item.remarks ? '<span class="r">' + esc(item.remarks) + '</span>' : '') +
      '</div>';
    c.onclick = () => openDetail(site, item);
    cards.appendChild(c);
  });
  $('#results').appendChild(wrap);
}

/* ---------------- 详情 / 播放 ---------------- */

async function openDetail(site, item) {
  openModal();
  $('#mTitle').textContent = item.name;
  $('#mSub').textContent = '加载详情中…';
  $('#mUrl').value = '';
  $('#mRoutes').hidden = true;
  $('#mRoutes').innerHTML = '';
  $('#mEps').innerHTML = '<div class="empty">加载中…</div>';
  $('#mPic').hidden = true;
  setVideoHint('正在获取播放直链…');
  try {
    const d = await api('/api/detail?cfg=' + state.cfgId + '&i=' + site._i + '&vid=' + enc(item.id));
    state.detail = d;
    $('#mTitle').textContent = d.name || item.name;
    const sub = [d.year, d.remarks, site.name].filter(Boolean).join(' · ');
    $('#mSub').textContent = sub;
    if (d.pic) { $('#mPic').src = proxy(d.pic); $('#mPic').hidden = false; $('#mPic').onerror = () => { $('#mPic').hidden = true; }; }
    state.routeIdx = 0;
    renderRoutes();
    renderEps();
    const eps = currentEps();
    if (!eps.length) {
      $('#mEps').innerHTML = '<div class="empty">该源没有返回可播放的直链（可能只有片段或需要解析）</div>';
      setVideoHint('没有可用直链');
    } else {
      playEp(0);
    }
  } catch (e) {
    $('#mSub').textContent = '获取失败';
    $('#mEps').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    setVideoHint('获取详情失败：' + e.message);
  }
}

function renderEps() {
  const box = $('#mEps');
  const eps = currentEps();
  box.innerHTML = '';
  eps.forEach((ep, i) => {
    const b = document.createElement('button');
    b.className = 'ep';
    b.textContent = ep.name;
    b.title = ep.url;
    b.onclick = () => playEp(i);
    box.appendChild(b);
  });
}

function renderRoutes() {
  const d = state.detail;
  if (!d) return;
  const box = $('#mRoutes');
  box.innerHTML = '';
  if (!d.froms || d.froms.length <= 1) {
    box.hidden = d.froms && d.froms.length === 1 ? false : true;
    if (d.froms && d.froms.length === 1) {
      box.hidden = false;
      box.innerHTML = '<span class="dim mono" style="font-size:12px">线路：' + esc(d.froms[0].flag) + '</span>';
    }
    return;
  }
  box.hidden = false;
  d.froms.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'route-btn' + (i === state.routeIdx ? ' on' : '');
    b.textContent = f.flag + '（' + f.episodes.length + '集）';
    b.onclick = () => { state.routeIdx = i; renderRoutes(); renderEps(); playEp(0); };
    box.appendChild(b);
  });
}

function currentEps() {
  const d = state.detail;
  if (!d || !d.froms || !d.froms.length) return [];
  return d.froms[Math.min(state.routeIdx, d.froms.length - 1)].episodes;
}

function playEp(i) {
  const eps = currentEps();
  const ep = eps[i];
  if (!ep) return;
  document.querySelectorAll('.ep.on').forEach((x) => x.classList.remove('on'));
  const btns = $('#mEps').querySelectorAll('.ep');
  if (btns[i]) btns[i].classList.add('on');
  $('#mUrl').value = ep.url;
  playUrl(ep.url);
}

function setVideoHint(msg) {
  const h = $('#vHint');
  if (!msg) { h.hidden = true; return; }
  h.textContent = msg;
  h.hidden = false;
}

function destroyHls() {
  if (state.hls) {
    try { state.hls.destroy(); } catch (_) { /* ignore */ }
    state.hls = null;
  }
}

function playUrl(url) {
  const v = $('#video');
  destroyHls();
  v.removeAttribute('src');
  v.load();
  const isM3u8 = /\.m3u8?(\?|#|$)/i.test(url) || /m3u/i.test(url);

  if (isM3u8) {
    const src = proxy(url);
    if (window.Hls && Hls.isSupported()) {
      setVideoHint('正在加载流…');
      const hls = new Hls({ maxBufferLength: 30, manifestLoadingTimeOut: 15000 });
      state.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { setVideoHint(''); v.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) {
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setVideoHint('网络错误：直链可能已失效或源站限制，可复制直链到外部播放器');
          } else {
            setVideoHint('流解析失败，可复制直链到外部播放器播放');
          }
        }
      });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
      v.play().catch(() => {});
    } else {
      setVideoHint('当前浏览器不支持 HLS，可复制直链到播放器');
    }
  } else {
    v.src = url;
    setVideoHint('');
    v.play().catch(() => setVideoHint('无法自动播放，点播放器按钮试试'));
  }
}

function openModal() {
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  $('#modal').hidden = true;
  document.body.style.overflow = '';
  const v = $('#video');
  destroyHls();
  v.pause();
  v.removeAttribute('src');
  v.load();
}

/* ---------------- 直播 ---------------- */

function renderLiveSrc() {
  const sel = $('#liveSrc');
  sel.innerHTML = '';
  state.lives.forEach((l, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = l.name;
    sel.appendChild(o);
  });
  sel.onchange = () => { state.liveIdx = Number(sel.value); loadLive(); };
}

function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const groups = new Map();
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.toUpperCase().startsWith('#EXTINF')) {
      const gm = t.match(/group-title="([^"]*)"/i);
      const name = t.slice(t.lastIndexOf(',') + 1).trim() || '未命名频道';
      cur = { name, group: (gm && gm[1].trim()) || '未分组' };
    } else if (!t.startsWith('#') && cur) {
      if (!groups.has(cur.group)) groups.set(cur.group, []);
      groups.get(cur.group).push({ name: cur.name, url: t });
      cur = null;
    }
  }
  return [...groups.entries()].map(([g, chs]) => ({ group: g, channels: chs }));
}

async function loadLive() {
  const l = state.lives[state.liveIdx];
  const wrap = $('#liveWrap');
  if (!l) { wrap.innerHTML = '<div class="empty">该配置没有直播源</div>'; return; }
  wrap.innerHTML = '<div class="empty">加载 ' + esc(l.name) + ' …</div>';
  try {
    const data = await api('/api/m3u?url=' + enc(l.url));
    const gs = parseM3u(data.text);
    if (!gs.length) { wrap.innerHTML = '<div class="empty">列表为空</div>'; return; }
    wrap.innerHTML = '';
    gs.forEach((g) => {
      const det = document.createElement('details');
      det.className = 'live-g';
      det.innerHTML = '<summary><span>' + esc(g.group) + '</span><i>' + g.channels.length + '</i></summary>';
      const chs = document.createElement('div');
      chs.className = 'live-chs';
      g.channels.forEach((c) => {
        const b = document.createElement('button');
        b.className = 'live-ch';
        b.textContent = c.name;
        b.onclick = () => {
          openModal();
          $('#mTitle').textContent = c.name;
          $('#mSub').textContent = '直播 · ' + l.name;
          $('#mPic').hidden = true;
          $('#mUrl').value = c.url;
          $('#mRoutes').hidden = true;
          $('#mEps').innerHTML = '';
          playUrl(c.url);
        };
        chs.appendChild(b);
      });
      det.appendChild(chs);
      wrap.appendChild(det);
    });
  } catch (e) {
    wrap.innerHTML = '<div class="empty">直播源加载失败：' + esc(e.message) + '</div>';
  }
}

/* ---------------- Tab ---------------- */

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $('#panel-search').hidden = name !== 'search';
  $('#panel-live').hidden = name !== 'live';
  $('#panel-wh').hidden = name !== 'wh';
  if (name === 'live' && state.lives.length && !$('#liveWrap').querySelector('.live-g')) loadLive();
}

/* ---------------- 事件绑定 ---------------- */

$('#btnLoad').onclick = () => loadConfig($('#cfgUrl').value).catch((e) => toast(e.message));
$('#cfgUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnLoad').click(); });
$('#btnSearch').onclick = doSearch;
$('#kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
$('#btnAll').onclick = () => { state.sites.forEach((s) => { if (s.supported) s.checked = true; }); renderSites(); };
$('#btnNone').onclick = () => { state.sites.forEach((s) => { if (s.supported) s.checked = false; }); renderSites(); };
$('#siteFilter').addEventListener('input', renderSites);
$('#mClose').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
$('#mCopy').onclick = async () => {
  const u = $('#mUrl').value;
  if (!u) { toast('还没有直链'); return; }
  await copyText(u);
  toast('直链已复制');
};
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });

/* ---------------- 启动 ---------------- */

(function init() {
  const saved = localStorage.getItem('tvd.cfg') || DEFAULT_CFG;
  $('#cfgUrl').value = saved;
  loadConfig(saved).catch((e) => {
    $('#cfgInfo').hidden = false;
    $('#cfgInfo').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  });
})();
