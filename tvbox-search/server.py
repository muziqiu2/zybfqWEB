# -*- coding: utf-8 -*-
"""TVBox 线路解析 + 资源搜索 + 直链提取服务

支持配置形态：
- 明文 JSON
- 整体 base64 编码
- JPEG 图片尾部藏 base64 数据（如 饭太硬：图片尾部 b64 + `**` 干扰 + 前缀垃圾字节）
- JS 风格 // 注释行、尾随逗号

站点支持范围：
- type 0/1（苹果CMS xml/json）：搜索 + 详情 + 直链提取，完整支持
- type 3 csp_ jar 蜘蛛 / drpy js / py：解析展示，标注暂不支持
"""
import base64
import json
import re
import xml.etree.ElementTree as ET
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

UA = "okhttp/3.15"
TIMEOUT = 20.0

app = FastAPI(title="TVBox 线路直链工具")


# ---------- 配置抓取与解码 ----------

def fetch_bytes(url: str) -> bytes:
    try:
        r = httpx.get(url, headers={"User-Agent": UA}, follow_redirects=True, timeout=TIMEOUT)
        r.raise_for_status()
        return r.content
    except httpx.HTTPError as e:
        raise HTTPException(502, f"下载线路失败: {e}")


def _clean_json_text(text: str) -> str:
    """去掉 // 整行注释与尾随逗号"""
    lines = [l for l in text.split("\n") if not l.lstrip().startswith("//")]
    text = "\n".join(lines)
    return re.sub(r",(\s*[}\]])", r"\1", text)


def _try_parse_json_bytes(data: bytes) -> dict | None:
    """对一段字节流尝试解码为配置 JSON，失败返回 None"""
    candidates = [data]
    # 文本整体可能是 base64
    stripped = bytes(data.strip())
    if stripped and len(stripped) > 16 and re.fullmatch(rb"[A-Za-z0-9+/=\r\n\*_`~\-]+", stripped):
        for chunk in (stripped, stripped.split(b"**")[-1]):
            try:
                candidates.append(base64.b64decode(chunk + b"=" * (-len(chunk) % 4)))
            except Exception:
                pass
    for cand in candidates:
        # 解码结果可能带垃圾前缀：从每个 { 位置尝试解析（最多前 60 个）
        brace_positions = [i for i, b in enumerate(cand) if b == ord("{")][:60]
        for pos in brace_positions:
            try:
                text = cand[pos:].decode("utf-8")
            except UnicodeDecodeError:
                break
            try:
                cfg = json.loads(_clean_json_text(text))
            except json.JSONDecodeError:
                continue
            if isinstance(cfg, dict) and "sites" in cfg:
                return cfg
            if isinstance(cfg, dict) and cfg:  # 无 sites 的 json 也接受
                return cfg
    return None


def decode_config(raw: bytes) -> dict:
    # 1) 直接尝试（JSON / base64 / 图片藏数据统一走这条）
    cfg = _try_parse_json_bytes(raw)
    if cfg:
        return cfg
    # 2) JPEG：截取 FFD9 之后的数据重试
    if raw[:2] == b"\xff\xd8":
        idx = raw.rfind(b"\xff\xd9")
        if idx != -1 and _try_parse_json_bytes(raw[idx + 2:]):
            return _try_parse_json_bytes(raw[idx + 2:])
    raise HTTPException(422, "无法解析该线路：不是 JSON / base64 / 图片藏数据的配置格式")


def site_support(s: dict) -> tuple[bool, str]:
    t = s.get("type")
    api = str(s.get("api", ""))
    if t in (0, 1):
        return True, "苹果CMS接口"
    if t == 3:
        if api.startswith("csp_"):
            return False, "jar 蜘蛛站点，服务端无法运行"
        if ".js" in api:
            return False, "drpy JS 站点暂不支持"
        if ".py" in api:
            return False, "python 蜘蛛暂不支持"
        return False, "type3 未知形态"
    return False, f"type{t} 暂不支持"


# ---------- CMS 搜索 / 详情 ----------

def _join(api: str, **params: str) -> str:
    sep = "&" if "?" in api else "?"
    qs = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
    return f"{api}{sep}{qs}"


def cms_search(site: dict, wd: str) -> list[dict]:
    api = site["api"].rstrip("/")
    if site.get("type") == 0:
        xml_text = httpx.get(_join(api, wd=wd, pg=1), headers={"User-Agent": UA},
                             follow_redirects=True, timeout=TIMEOUT).text
        root = ET.fromstring(re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]", b"", xml_text.encode("utf-8", "ignore")))
        out = []
        for v in root.iter("video"):
            out.append({
                "id": (v.findtext("id") or "").strip(),
                "name": (v.findtext("name") or "").strip(),
                "pic": (v.findtext("pic") or "").strip(),
                "remarks": (v.findtext("note") or "").strip(),
            })
        return out
    # type 1 json
    r = httpx.get(_join(api, ac="videolist", wd=wd), headers={"User-Agent": UA},
                  follow_redirects=True, timeout=TIMEOUT)
    data = r.json()
    return [{
        "id": str(v.get("vod_id", "")),
        "name": v.get("vod_name", ""),
        "pic": v.get("vod_pic", ""),
        "remarks": v.get("vod_remarks", "") or v.get("vod_class", ""),
    } for v in data.get("list", [])]


def _parse_play_urls(play_from: str, play_url: str) -> list[dict]:
    """vod_play_url: 源1$$$源2 ；每源: 第01集$url#第02集$url"""
    froms = (play_from or "").split("$$$")
    sources = (play_url or "").split("$$$")
    result = []
    for i, src in enumerate(sources):
        name = froms[i].strip() if i < len(froms) and froms[i].strip() else f"播放源{i + 1}"
        eps = []
        for item in src.split("#"):
            item = item.strip()
            if not item:
                continue
            if "$" in item:
                ep_name, ep_url = item.split("$", 1)
            else:
                ep_name, ep_url = f"第{len(eps) + 1}集", item
            ep_name, ep_url = ep_name.strip(), ep_url.strip()
            if ep_url.startswith("http"):
                eps.append({"name": ep_name, "url": ep_url})
        if eps:
            result.append({"from": name, "episodes": eps})
    return result


def cms_detail(site: dict, vid: str) -> dict:
    api = site["api"].rstrip("/")
    if site.get("type") == 0:
        xml_text = httpx.get(_join(api, ac="videolist", ids=vid), headers={"User-Agent": UA},
                             follow_redirects=True, timeout=TIMEOUT).text
        root = ET.fromstring(re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]", b"", xml_text.encode("utf-8", "ignore")))
        v = next(root.iter("video"), None)
        if v is None:
            raise HTTPException(404, "未找到该视频详情")
        dl = v.find("dl")
        play_url = "".join((dd.text or "") for dd in dl.findall("dd")) if dl is not None else ""
        flags = [dd.get("flag", "") for dd in dl.findall("dd")] if dl is not None else []
        from_names = "$$$".join(flags)
        return {
            "name": (v.findtext("name") or "").strip(),
            "pic": (v.findtext("pic") or "").strip(),
            "content": (v.findtext("des") or "").strip(),
            "sources": _parse_play_urls(from_names, play_url),
        }
    r = httpx.get(_join(api, ac="videolist", ids=vid), headers={"User-Agent": UA},
                  follow_redirects=True, timeout=TIMEOUT)
    data = r.json()
    lst = data.get("list", [])
    if not lst:
        raise HTTPException(404, "未找到该视频详情")
    v = lst[0]
    return {
        "name": v.get("vod_name", ""),
        "pic": v.get("vod_pic", ""),
        "content": (v.get("vod_content") or "").strip()[:500],
        "sources": _parse_play_urls(v.get("vod_play_from", ""), v.get("vod_play_url", "")),
    }


# ---------- API ----------

class LoadReq(BaseModel):
    url: str


class SearchReq(BaseModel):
    api: str
    type: int
    wd: str


class DetailReq(BaseModel):
    api: str
    type: int
    id: str


@app.post("/api/load")
def load_config(req: LoadReq):
    raw = fetch_bytes(req.url.strip())
    cfg = decode_config(raw)
    sites = cfg.get("sites", []) or []
    out = []
    ok = 0
    for s in sites:
        supported, reason = site_support(s)
        ok += supported
        out.append({
            "key": s.get("key", ""),
            "name": s.get("name", s.get("key", "")),
            "type": s.get("type"),
            "api": s.get("api", ""),
            "supported": supported,
            "reason": reason,
        })
    return {
        "spider": cfg.get("spider", ""),
        "total": len(out),
        "supported": ok,
        "sites": out,
    }


@app.post("/api/search")
def search(req: SearchReq):
    site = {"api": req.api, "type": req.type}
    if not site_support(site)[0]:
        raise HTTPException(400, "该站点类型暂不支持搜索")
    try:
        return {"list": cms_search(site, req.wd.strip())}
    except (httpx.HTTPError, ET.ParseError, ValueError) as e:
        raise HTTPException(502, f"搜索失败: {e}")


@app.post("/api/detail")
def detail(req: DetailReq):
    site = {"api": req.api, "type": req.type}
    try:
        return cms_detail(site, req.id.strip())
    except (httpx.HTTPError, ET.ParseError, ValueError) as e:
        raise HTTPException(502, f"获取详情失败: {e}")


app.mount("/", StaticFiles(directory="static", html=True), name="static")
