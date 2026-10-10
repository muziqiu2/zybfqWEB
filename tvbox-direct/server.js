#!/usr/bin/env node
/**
 * TVBox 直链搜索 — 零依赖本地服务
 * 职责：
 *  1. /api/config  拉取并解析 TVBox 配置（普通配置 / 多仓 / m3u 仓）
 *  2. /api/search  转发 MacCMS 搜索（type 0 JSON / type 1 XML）
 *  3. /api/detail  转发 MacCMS 详情，解析出各线路播放直链
 *  4. /api/stream  m3u8/分片流式代理（重写 m3u8 内部地址，附带 CORS 头）
 *  5. /api/m3u     直播源 m3u 拉取（文本化）
 * 用法：node server.js  （可选环境变量 PORT / FETCH_TIMEOUT）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

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

function proxUrl(abs) {
  return '/api/stream?url=' + encodeURIComponent(abs);
}

/* ---------------- 配置解析 ---------------- */

function normSite(s, i) {
  const api = typeof s.api === 'string' ? s.api.trim() : '';
  const type = Number(s.type) || 0;
  const supported = (type === 0 || type === 1) && /^https?:\/\//i.test(api);
  return {
    key: String(s.key || 'site' + i),
    name: String(s.name || s.key || '未命名源'),
    type,
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

function parsePlayUrls(fromStr, urlStr) {
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
      if (!/^https?:\/\//i.test(url)) return;
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

/* ---------------- m3u8 重写 / 流代理 ---------------- */

function rewriteM3u8(text, base) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // 重写 EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA 里的 URI
        return t.replace(/URI="([^"]+)"/g, (m, uri) => {
          if (!uri || uri.startsWith('#')) return m;
          try {
            return 'URI="' + proxUrl(new URL(uri, base).href) + '"';
          } catch (_) {
            return m;
          }
        });
      }
      try {
        return proxUrl(new URL(t, base).href);
      } catch (_) {
        return line;
      }
    })
    .join('\n');
}

async function handleStream(req, res, u) {
  if (!/^https?:\/\//i.test(u)) throw new Error('无效的流地址');
  const ac = new AbortController();
  req.on('close', () => ac.abort(new Error('客户端断开')));
  const upstream = await fetchRes(u, {
    signal: ac.signal,
    headers: { Referer: new URL(u).origin + '/', Range: req.headers.range || '' }
  });
  const ct = upstream.headers.get('content-type') || '';
  const finalUrl = upstream.url || u;
  let body = null;
  let isM3u8 = /\.m3u8?(\?|#|$)/i.test(finalUrl) || /mpegurl/i.test(ct);
  if (!isM3u8) {
    // 内容嗅探：部分直播源返回 text/html 但内容是 m3u
    try {
      const clone = upstream.clone();
      const head = (await clone.text()).slice(0, 512);
      if (head.trimStart().startsWith('#EXTM3U')) {
        isM3u8 = true;
        body = head + (await upstream.text()).slice(512);
      }
    } catch (_) { /* 忽略，按二进制流处理 */ }
  }

  if (isM3u8) {
    const text = body !== null ? body : await upstream.text();
    const out = rewriteM3u8(text, finalUrl);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(out);
    return;
  }

  const h = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (ct) h['Content-Type'] = ct;
  const cr = upstream.headers.get('content-range');
  if (cr) h['Content-Range'] = cr;
  const ar = upstream.headers.get('accept-ranges');
  if (ar) h['Accept-Ranges'] = ar;
  res.writeHead(upstream.status, h);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
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
    if (!site.supported) throw new Error('该源类型暂不支持（需要 TVBox 爬虫运行时）');
    const list = await cmsSearch(site, wd);
    return json(res, { ok: true, list });
  }

  if (route === '/api/detail') {
    const site = siteAt(q.get('cfg'), q.get('i'));
    const vid = (q.get('vid') || '').trim();
    if (!vid) throw new Error('参数不完整');
    if (!site.supported) throw new Error('该源类型暂不支持（需要 TVBox 爬虫运行时）');
    const data = await cmsDetail(site, vid);
    return json(res, { ok: true, ...data });
  }

  if (route === '/api/stream') {
    return handleStream(req, res, q.get('url') || '');
  }

  if (route === '/api/m3u') {
    const url = q.get('url') || '';
    const { text } = await fetchText(url, { timeout: 20000 });
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('不是有效的 M3U 列表');
    return json(res, { ok: true, text: rewriteM3u8(text, url) });
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
