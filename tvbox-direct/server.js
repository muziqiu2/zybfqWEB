#!/usr/bin/env node
/**
 * TVBox 直链搜索 — 零依赖本地服务
 * 职责：
 *  1. /api/config  拉取并解析 TVBox 配置（普通配置 / 多仓 / m3u 仓）
 *  2. /api/search  搜索（type 0 JSON / type 1 XML / type 3 T3-HTTP 源）
 *  3. /api/detail  详情，解析出各线路剧集
 *  4. /api/play    解析单集最终直链（T3 play 端点 / 嵌套 m3u8 跟随）
 *  5. /api/m3u     直播源 m3u 拉取（文本化，URL 绝对化）
 * 源类型：cms（type 0/1，MacCMS 标准 HTTP）、t3（type 3 且 api 为 http URL）、
 *        t4（type 4）、js（js:/ .js 脚本源）、jar（csp_ 爬虫，需安卓运行时）
 * 用法：node server.js  （可选环境变量 PORT / FETCH_TIMEOUT）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const PUB = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = Number(process.env.FETCH_TIMEOUT || 15000);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/* ---------------- 小工具 ---------------- */

function json(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function fail(res, e) {
  console.error('[api-error]', (e && e.stack) || e);
  json(res, { ok: false, error: String((e && e.message) || e) });
}

async function fetchRes(url, { timeout = TIMEOUT, headers = {}, signal } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), timeout);
  if (signal) signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  try {
    return await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': UA, ...headers } });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, opt) {
  const r = await fetchRes(url, opt);
  const text = await r.text();
  if (!r.ok && !text) throw new Error('HTTP ' + r.status);
  return { status: r.status, text, finalUrl: r.url || url, headers: r.headers };
}

function qs(query) {
  return Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => k + '=' + encodeURIComponent(v))
    .join('&');
}

function buildUrl(api, params) {
  const sep = api.includes('?') ? '&' : '?';
  const q = qs(params);
  return q ? api + sep + q : api;
}

/* ---------------- 配置解析 ---------------- */

const KIND_NAME = { cms: 'CMS', t3: 'T3', t4: 'T4', js: 'JS', jar: 'SPIDER', bili: 'B站' };

function normSite(s, i) {
  const api = typeof s.api === 'string' ? s.api.trim() : '';
  const type = Number(s.type) || 0;
  let kind = 'jar';
  let supported = false;
  if (type === 0 || type === 1) {
    kind = 'cms';
    supported = /^https?:\/\//i.test(api);
  } else if (type === 3) {
    // js:/ .js 结尾的是 JS 脚本爬虫（可能在 http 地址上），优先于 T3 判断
    const base = api.split(';')[0];
    if (/^js:/i.test(base) || /\.js(\?|#|$)/i.test(base)) kind = 'js';
    else if (/^csp_Bili/i.test(api)) { kind = 'bili'; supported = true; } // B 站官方 API 解析器
    else if (/^https?:\/\//i.test(api)) { kind = 't3'; supported = true; }
  } else if (type === 4) {
    kind = 't4';
  }
  return {
    key: String(s.key || 'site' + i),
    name: String(s.name || s.key || '未命名源'),
    type,
    kind,
    api,
    searchable: !(s.searchable === 0 || s.searchable === '0'),
    supported
  };
}

async function loadConfig(urlStr) {
  const { text } = await fetchText(urlStr);
  const t = text.trim();

  // 多仓 txt：每行 "名称$地址"
  if (!t.startsWith('{') && !t.startsWith('[')) {
    const warehouse = t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.lastIndexOf('$');
        return i > 0 ? { name: l.slice(0, i).trim(), url: l.slice(i + 1).trim() } : null;
      })
      .filter((x) => x && /^https?:\/\//i.test(x.url));
    if (warehouse.length) return { kind: 'warehouse', warehouse };
    throw new Error('配置内容无法识别（不是 JSON 也不是多仓列表）');
  }

  let cfg;
  try {
    cfg = JSON.parse(t);
  } catch (e) {
    throw new Error('JSON 解析失败：' + e.message);
  }

  // 多仓 JSON：{ urls: [{sourceName, sourceUrl}] } 或 { storeHouse: [...] }
  if (Array.isArray(cfg.urls)) {
    const warehouse = cfg.urls
      .map((u) => ({ name: u.name || u.sourceName || '', url: u.url || u.sourceUrl || '' }))
      .filter((x) => /^https?:\/\//i.test(x.url));
    return { kind: 'warehouse', name: cfg.sourceName || cfg.name || '', warehouse };
  }
  if (Array.isArray(cfg.storeHouse)) {
    const warehouse = cfg.storeHouse
      .map((s) => ({ name: s.sourceName || s.name || '', url: s.sourceUrl || s.url || '' }))
      .filter((x) => /^https?:\/\//i.test(x.url));
    return { kind: 'warehouse', name: cfg.name || '', warehouse };
  }

  const sites = (Array.isArray(cfg.sites) ? cfg.sites : []).map(normSite);
  const lives = (Array.isArray(cfg.lives) ? cfg.lives : [])
    .filter((l) => l && /^https?:\/\//i.test(String(l.url || '')))
    .map((l) => ({ name: String(l.name || '直播源'), url: String(l.url) }));
  return { kind: 'config', sites, lives };
}

/* ---------------- MacCMS 搜索 / 详情 ---------------- */

function xmlAttrs(s) {
  const o = {};
  String(s || '').replace(/([\w:-]+)="([^"]*)"/g, (_, k, v) => {
    o[k] = v;
    return '';
  });
  return o;
}

function parseXmlVideos(xml) {
  const list = [];
  const re = /<video\b([^>]*?)(?:\/>|>([\s\S]*?)<\/video>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = xmlAttrs(m[1]);
    const inner = m[2] || '';
    const eps = [];
    if (inner) {
      const dre = /<dd\b([^>]*)>([\s\S]*?)<\/dd>/g;
      let d;
      while ((d = dre.exec(inner))) {
        eps.push({ flag: xmlAttrs(d[1]).flag || '', data: d[2] });
      }
    }
    list.push({ attrs, eps });
  }
  return list;
}

function xmlRemarks(a) {
  return a.note || a.state || '';
}

async function cmsSearch(site, wd) {
  if (site.type === 1) {
    let xml = (await fetchText(buildUrl(site.api, { wd }))).text;
    let vids = parseXmlVideos(xml);
    if (!vids.length) {
      xml = (await fetchText(buildUrl(site.api, { ac: 'videolist', wd }))).text;
      vids = parseXmlVideos(xml);
    }
    return vids.slice(0, 60).map((v) => {
      const a = v.attrs;
      return {
        id: String(a.id || ''),
        name: a.name || '',
        year: String(a.year || '').trim() || String(a.dt || '').slice(0, 4),
        remarks: xmlRemarks(a)
      };
    }).filter((x) => x.id);
  }

  // type 0 JSON：先 ac=list，空则回退 ac=detail
  let list = [];
  try {
    const j = JSON.parse((await fetchText(buildUrl(site.api, { ac: 'list', wd }))).text);
    list = j.list || j.data || [];
  } catch (_) { /* 尝试回退 */ }
  if (!list.length) {
    try {
      const j = JSON.parse((await fetchText(buildUrl(site.api, { ac: 'detail', wd }))).text);
      list = j.list || [];
    } catch (_) { /* 放弃 */ }
  }
  return list.slice(0, 60).map((v) => ({
    id: String(v.vod_id || ''),
    name: v.vod_name || '',
    year: String(v.vod_year || ''),
    remarks: v.vod_remarks || v.vod_class || ''
  })).filter((x) => x.id);
}

function parsePlayUrls(fromStr, urlStr, keepAll) {
  const flags = String(fromStr || '').split('$').map((x) => x.trim()).filter(Boolean);
  const groups = String(urlStr || '').split('$$$');
  const froms = [];
  groups.forEach((g, gi) => {
    const eps = [];
    let n = 0;
    g.split('#').forEach((e) => {
      e = e.trim();
      if (!e) return;
      const k = e.indexOf('$');
      const name = k >= 0 ? e.slice(0, k).trim() : '第' + (n + 1) + '集';
      const url = k >= 0 ? e.slice(k + 1).trim() : e;
      // CMS 源只保留 http 直链；T3 源保留全部（非 http 的是 play 端点集数标识）
      if (!keepAll && !/^https?:\/\//i.test(url)) return;
      eps.push({ name: name || '第' + (n + 1) + '集', url });
      n++;
    });
    if (eps.length) froms.push({ flag: flags[gi] || '线路' + (gi + 1), episodes: eps });
  });
  return froms;
}

async function cmsDetail(site, id) {
  if (site.type === 1) {
    let xml = (await fetchText(buildUrl(site.api, { ac: 'videolist', ids: id }))).text;
    let vids = parseXmlVideos(xml);
    if (!vids.length) {
      xml = (await fetchText(buildUrl(site.api, { ac: 'detail', ids: id }))).text;
      vids = parseXmlVideos(xml);
    }
    const v = vids[0];
    if (!v) throw new Error('未找到对应详情');
    const a = v.attrs;
    const froms = v.eps
      .map((e, i) => {
        const eps = [];
        let n = 0;
        String(e.data).split('#').forEach((s) => {
          s = s.trim();
          if (!s) return;
          const k = s.indexOf('$');
          const name = k >= 0 ? s.slice(0, k).trim() : '第' + (n + 1) + '集';
          const url = k >= 0 ? s.slice(k + 1).trim() : s;
          if (/^https?:\/\//i.test(url)) eps.push({ name, url });
          n++;
        });
        return { flag: e.flag || '线路' + (i + 1), episodes: eps };
      })
      .filter((f) => f.episodes.length);
    return { name: a.name || '', year: String(a.year || ''), remarks: xmlRemarks(a), pic: '', froms };
  }

  let item = null;
  try {
    const j = JSON.parse((await fetchText(buildUrl(site.api, { ac: 'detail', ids: id }))).text);
    item = (j.list || [])[0];
  } catch (_) { /* 回退 */ }
  if (!item) {
    try {
      const j = JSON.parse((await fetchText(buildUrl(site.api, { ac: 'videolist', ids: id }))).text);
      item = (j.list || [])[0];
    } catch (_) { /* 放弃 */ }
  }
  if (!item) throw new Error('未找到对应详情');
  return {
    name: item.vod_name || '',
    year: String(item.vod_year || ''),
    remarks: item.vod_remarks || '',
    pic: item.vod_pic || '',
    froms: parsePlayUrls(item.vod_play_from, item.vod_play_url)
  };
}

/* ---------------- T3 HTTP 源（猫影视 / drpy / hipy 协议） ----------------
 * type 3 且 api 为 http URL：搜索 ?wd=、详情 ?ids=、播放 ?flag=&play=
 * 返回 MacCMS 风格 JSON（class/list 字段）
 */

function pickList(j) {
  if (Array.isArray(j.list)) return j.list;
  if (Array.isArray(j.data)) return j.data;
  return [];
}

function t3Map(list) {
  return list.slice(0, 60).map((v) => ({
    id: String(v.vod_id != null ? v.vod_id : (v.id != null ? v.id : '')),
    name: String(v.vod_name || v.name || ''),
    year: String(v.vod_year || v.year || ''),
    remarks: String(v.vod_remarks || v.remarks || '')
  })).filter((x) => x.id && x.name);
}

async function t3Search(site, wd) {
  const j = JSON.parse((await fetchText(buildUrl(site.api, { wd }))).text);
  return t3Map(pickList(j));
}

async function t3Detail(site, id) {
  const j = JSON.parse((await fetchText(buildUrl(site.api, { ids: id }))).text);
  const v = pickList(j)[0] || {};
  return {
    name: String(v.vod_name || v.name || ''),
    year: String(v.vod_year || v.year || ''),
    remarks: String(v.vod_remarks || v.remarks || ''),
    pic: String(v.vod_pic || v.pic || ''),
    froms: parsePlayUrls(v.vod_play_from || v.play_from, v.vod_play_url || v.play_url, true)
  };
}

/* ---------------- B 站源（csp_Bili，官方 API） ----------------
 * 搜索：/x/web-interface/wbi/search/type（wbi 签名 + buvid cookie）
 * 详情：/x/web-interface/view（取 cid 与分 P）
 * 直链：/x/player/playurl platform=html5 → mp4 直链（需 Referer）
 */

const WBI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const biliState = { b3: '', b4: '', wbi: null, expire: 0 };

function biliHeaders(extra) {
  return Object.assign({
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com'
  }, extra || {});
}

async function biliBootstrap() {
  if (biliState.wbi && Date.now() < biliState.expire) return biliState;
  const spi = await (await fetchRes('https://api.bilibili.com/x/frontend/finger/spi', { headers: biliHeaders() })).json();
  biliState.b3 = (spi.data && spi.data.b_3) || '';
  biliState.b4 = (spi.data && spi.data.b_4) || '';
  const cookie = 'buvid3=' + biliState.b3 + '; buvid4=' + biliState.b4;
  const nav = await (await fetchRes('https://api.bilibili.com/x/web-interface/nav', { headers: biliHeaders({ Cookie: cookie }) })).json();
  const img = nav.data && nav.data.wbi_img ? nav.data.wbi_img : {};
  const imgKey = String(img.img_url || '').split('/').pop().split('.')[0];
  const subKey = String(img.sub_url || '').split('/').pop().split('.')[0];
  if (!imgKey || !subKey) throw new Error('B站引导失败：拿不到 wbi 密钥');
  biliState.wbi = imgKey + subKey;
  biliState.expire = Date.now() + 12 * 3600 * 1000;
  return biliState;
}

function wbiSign(params, wbiKey) {
  const mixinKey = WBI_TAB.map((i) => wbiKey[i]).join('').slice(0, 32);
  const all = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const q = Object.keys(all).sort()
    .map((k) => k + '=' + encodeURIComponent(String(all[k]).replace(/[!'()*]/g, '')))
    .filter((kv) => kv.slice(kv.indexOf('=') + 1) !== '')
    .join('&');
  return q + '&w_rid=' + crypto.createHash('md5').update(q + mixinKey).digest('hex');
}

function biliCookie() {
  return 'buvid3=' + biliState.b3 + '; buvid4=' + biliState.b4;
}

function biliClean(t) {
  return String(t || '').replace(/<[^>]+>/g, '').trim();
}

function biliDur(d) {
  if (typeof d === 'number') {
    const m = Math.floor(d / 60), s = d % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  return String(d || '');
}

async function biliSearch(site, wd) {
  await biliBootstrap();
  const qs = wbiSign({ search_type: 'video', keyword: wd, page: 1 }, biliState.wbi);
  const r = await (await fetchRes('https://api.bilibili.com/x/web-interface/wbi/search/type?' + qs, { headers: biliHeaders({ Cookie: biliCookie() }) })).json();
  if (r.code !== 0) throw new Error('B站搜索失败: ' + (r.message || r.code));
  const result = (r.data && r.data.result) || [];
  return result.filter((x) => x.type === 'video').slice(0, 30).map((v) => ({
    id: String(v.bvid || ''),
    name: biliClean(v.title),
    year: '',
    remarks: [biliDur(v.duration), v.author].filter(Boolean).join(' · ')
  })).filter((x) => x.id && x.name);
}

async function biliDetail(site, vid) {
  const r = await (await fetchRes('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(vid), { headers: biliHeaders() })).json();
  if (r.code !== 0) throw new Error('B站详情失败: ' + (r.message || r.code));
  const v = r.data;
  const pages = Array.isArray(v.pages) && v.pages.length ? v.pages : [{ page: 1, part: '正片', cid: v.cid }];
  const multi = pages.length > 1;
  return {
    name: v.title,
    year: v.pubdate ? new Date(v.pubdate * 1000).getFullYear() + '' : '',
    remarks: 'UP: ' + (v.owner ? v.owner.name : ''),
    pic: v.pic || '',
    froms: [{
      flag: 'B站',
      episodes: pages.map((p) => ({
        name: multi ? 'P' + p.page + ' ' + (p.part || '') : '正片',
        url: v.bvid + '@' + p.cid
      }))
    }]
  };
}

async function biliPlay(site, epUrl) {
  await biliBootstrap();
  const i = String(epUrl).indexOf('@');
  if (i < 0) throw new Error('无效的 B 站集数标识');
  const bvid = epUrl.slice(0, i);
  const cid = epUrl.slice(i + 1);
  const u = 'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
    '&cid=' + encodeURIComponent(cid) + '&platform=html5&high_quality=1&qn=64';
  const r = await (await fetchRes(u, { headers: biliHeaders({ Cookie: biliCookie() }) })).json();
  if (r.code !== 0) throw new Error('B站取直链失败: ' + (r.message || r.code));
  const durl = (r.data && r.data.durl || [])[0];
  if (!durl || !durl.url) throw new Error('B站未返回 mp4 直链');
  const qd = ((r.data.accept_description || [])[r.data.quality] || '') || (r.data.quality === 16 ? '流畅 360P' : r.data.quality === 32 ? '清晰 480P' : r.data.quality === 64 ? '高清 720P' : '清晰度 ' + r.data.quality);
  return {
    url: durl.url,
    header: { Referer: 'https://www.bilibili.com/', 'User-Agent': UA },
    notes: ['B站官方 API 直链 · ' + qd + ' · 链接有时效，尽快使用']
  };
}

/* ---------------- m3u 文本 / 直链解析 ---------------- */

// m3u / m3u8 内相对地址转绝对（不做代理重写，仅保证复制出去的链接可直接用）
function absM3u(text, base) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return t.replace(/URI="([^"]+)"/g, (m, uri) => {
          if (!uri || uri.startsWith('#')) return m;
          try {
            return 'URI="' + new URL(uri, base).href + '"';
          } catch (_) {
            return m;
          }
        });
      }
      try {
        return new URL(t, base).href;
      } catch (_) {
        return line;
      }
    })
    .join('\n');
}

const MEDIA_RE = /\.(m3u8?|mp4|mkv|flv|avi|mov|webm|ts|mp3|aac|m4a)(\?|#|$)/i;

/**
 * 解析单集最终直链：
 *  - T3 源：集数标识不是 http 时走 ?flag=&play= 端点换取真实 URL
 *  - m3u8：请求清单内容，若是主清单（EXT-X-STREAM-INF）则跟随到媒体清单
 *  - 返回 notes 说明解析过程，header 为源站要求的请求头
 */
async function resolveDirect(site, flag, epUrl) {
  let target = String(epUrl || '');
  let header = null;
  const notes = [];

  if (site.kind === 't3') {
    if (!/^https?:\/\//i.test(target)) {
      const j = JSON.parse((await fetchText(buildUrl(site.api, { flag, play: target }))).text);
      target = String(j.url || j.play_url || '');
      if (j.header && typeof j.header === 'object') header = j.header;
      if (j.jx === 1 || j.parse === 1) notes.push('源站标记为网页解析（jx/parse），可能需要嗅探');
    } else {
      notes.push('T3 直出链接');
    }
  }
  if (!/^https?:\/\//i.test(target)) throw new Error('未能解析出 http 直链');

  const looksM3u8 = /\.m3u8?(\?|#|$)/i.test(target);
  const looksMedia = MEDIA_RE.test(target);

  // 非二进制媒体链接（m3u8 / 无扩展名 / T3）：预检内容，自动跟随重定向与主清单
  if (!looksMedia || looksM3u8) {
    try {
      const { text, finalUrl, headers } = await fetchText(target);
      const ct = headers.get('content-type') || '';
      if (/mpegurl/i.test(ct) || text.includes('#EXTM3U')) {
        if (text.includes('#EXT-X-STREAM-INF')) {
          const child = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
          if (child) {
            notes.push(looksM3u8 ? '已跟随 m3u8 主清单 → 媒体清单' : '链接经预检为 m3u8，已跟随到媒体清单');
            return { url: new URL(child, finalUrl).href, header, notes };
          }
        }
        notes.push(looksM3u8 ? (text.includes('#EXTINF') ? '已是媒体清单直链' : 'm3u8 清单直链') : '链接经预检为媒体清单直链');
        return { url: finalUrl || target, header, notes };
      }
      if (looksM3u8) notes.push('m3u8 预检异常，返回原始链接');
      else {
        // 网页嗅探：share 播放页通常把真实 m3u8/mp4 内嵌在页面脚本里，直接提取
        const mm = text.match(/["']([^"']*\.(?:m3u8|mp4|mkv)[^"']*)["']/i);
        if (mm && mm[1] && !/^data:/i.test(mm[1])) {
          try {
            notes.push('已从网页中提取真实直链');
            return { url: new URL(mm[1], finalUrl).href, header, notes };
          } catch (_) { /* 提取失败，按网页处理 */ }
        }
        notes.push('内容不是媒体（' + (ct.split(';')[0] || '未知类型') + '），可能是需嗅探的网页链接');
      }
    } catch (e) {
      notes.push('预检失败（' + e.message + '），返回原始链接');
    }
    return { url: target, header, notes };
  }

  return { url: target, header, notes };
}

/* ---------------- HTTP 服务 ---------------- */

// 内存中的配置注册表：cfgId -> sites[]
const CFGS = new Map();
let CFG_SEQ = 0;

async function api(req, res, u) {
  const q = u.searchParams;
  const route = u.pathname;
  console.log('[api]', route, [...q.keys()].map((k) => k + '=' + String(q.get(k)).slice(0, 40)).join(' '));

  if (route === '/api/config') {
    const url = q.get('url');
    if (!url) throw new Error('缺少 url 参数');
    const data = await loadConfig(url);
    if (data.kind === 'config') {
      const cfgId = 'c' + (++CFG_SEQ);
      CFGS.set(cfgId, data.sites);
      data.cfgId = cfgId;
    }
    return json(res, { ok: true, ...data });
  }

  function siteAt(cfgId, i) {
    const sites = CFGS.get(String(cfgId || ''));
    const site = sites && sites[Number(i)];
    if (!site) throw new Error('配置已过期，请重新加载');
    return site;
  }

  if (route === '/api/search') {
    const site = siteAt(q.get('cfg'), q.get('i'));
    const wd = (q.get('wd') || '').trim().slice(0, 60);
    if (!wd) throw new Error('参数不完整');
    if (!site.supported) throw new Error('该源类型暂不支持（' + KIND_NAME[site.kind] + ' 源需要爬虫运行时）');
    const list = site.kind === 'bili' ? await biliSearch(site, wd)
      : site.kind === 't3' ? await t3Search(site, wd)
        : await cmsSearch(site, wd);
    return json(res, { ok: true, list });
  }

  if (route === '/api/detail') {
    const site = siteAt(q.get('cfg'), q.get('i'));
    const vid = (q.get('vid') || '').trim();
    if (!vid) throw new Error('参数不完整');
    if (!site.supported) throw new Error('该源类型暂不支持（' + KIND_NAME[site.kind] + ' 源需要爬虫运行时）');
    const data = site.kind === 'bili' ? await biliDetail(site, vid)
      : site.kind === 't3' ? await t3Detail(site, vid)
        : await cmsDetail(site, vid);
    return json(res, { ok: true, ...data });
  }

  if (route === '/api/play') {
    const site = siteAt(q.get('cfg'), q.get('i'));
    const flag = q.get('flag') || '';
    const url = q.get('url') || '';
    if (!url) throw new Error('参数不完整');
    if (!site.supported) throw new Error('该源类型暂不支持（' + KIND_NAME[site.kind] + ' 源需要爬虫运行时）');
    const r = site.kind === 'bili' ? await biliPlay(site, url) : await resolveDirect(site, flag, url);
    return json(res, { ok: true, ...r });
  }

  if (route === '/api/m3u') {
    const url = q.get('url') || '';
    const { text } = await fetchText(url, { timeout: 20000 });
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('不是有效的 M3U 列表');
    return json(res, { ok: true, text: absM3u(text, url) });
  }

  json(res, { ok: false, error: '未知接口 ' + route });
}

function serveStatic(req, res, u) {
  let p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (e, buf) => {
    if (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    return serveStatic(req, res, u);
  } catch (e) {
    if (!res.headersSent) return fail(res, e);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log('TVBox 直链搜索已启动: http://localhost:' + PORT);
});
