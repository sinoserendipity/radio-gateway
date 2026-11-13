/**
 * radio.cn 专用 CORS API Worker  (v1.1.1)
 * ------------------------------------------------------------------
 * 骨架参考: SzeMeng76/CORSAPI  _worker.js (首页主题亦沿用其 LunaTV 深色绿风格)
 * 差异: 内建云听(radio.cn) SIGN_KEY 自签能力, 不再依赖 radio.0472.org / 第三方 corsapi。
 *
 * v1.1.1 变更(相对 v1.1.0):
 *   1. ★ 移除 /r/<contentId>.m3u8 路由 —— 全部播放统一走 /m3u8?url= 形态。
 *      配套: /api/list 的 play 字段由 `/r/<id>.m3u8` 改为 `/m3u8?url=<原始云听地址>`,
 *      避免目录接口输出死链。
 *   2. ★ 移除 /list.json 别名(与 /api/list 重复)。
 *   3. ★ 首页主题改为 SzeMeng76/CORSAPI 的 LunaTV 深色绿风格, 内容适配本服务。
 *
 * v1.1.0 变更(相对 v1.0.0):
 *   1. catalog 由「仅国家级 19 条」扩展为「央广 + 浙江 + 上海」三省合并(REGIONS 可继续加省)。
 *   2. /m3u8?url= 分支新增「自动换签」: 传入 ytcast*.radio.cn 的 index_<n>.m3u8 地址时,
 *      自动反查 contentId 并现签, 用户可长期保存 radio.cn 原始形态地址, 不会因 key/time 过期而 403。
 *      —— 非 radio.cn 源(cztv / ajmide / cnr.cn 等)仍按原样透传, 行为不变。
 *   3. /api/list 支持 ?province=330000|310000|all 过滤。
 *   4. 选流改为「.m3u8 线路优先, .mp3 裸流沉底」, 避免 mp3PlayUrlHigh 里的 MP3 流拉高延迟。
 *
 * 路由:
 *   GET /                          首页(自描述, LunaTV 风格主题)
 *   GET /health                    健康检查
 *   GET /api/list[?province=all]   云听目录 JSON(默认全部已配置省份)
 *   GET /m3u8?url=<encoded>        ★ 唯一播放入口, radio.cn 地址自动换签
 *   GET /s?url=<encoded>           分片/二进制透传(支持 Range 206)
 *
 * 关键设计(踩坑修正):
 *   1. 上游 m3u8 的 Content-Type 是 application/octet-stream, 不能用 Content-Type 判清单,
 *      必须按正文是否以 #EXTM3U 开头判断 —— 否则会被当文本处理而破坏结构。
 *   2. #EXTINF 行一律不重写; 并做兜底修正「#EXTINF:<dur>」→「#EXTINF:<dur>,」,
 *      PlayHLS 缺逗号会解析成空播放列表(mode=stop/time=0)。
 *   3. 云听清单里的分片是相对路径(segmentXXX.ts), 必须按清单 URL 绝对化后再改写。
 *   4. key 错/缺失上游返回 403, 因此签名必须每次现取, 不能硬编码 m3u8 地址。
 *   5. 对外路由以 .m3u8 收尾的参数形态为 /m3u8?url=, 满足 PlayHLS v2 只认 URL 后缀的识别逻辑
 *      (实测形如 /m3u8?url=xxx.m3u8 可被 PlayHLS 接纳)。
 *   6. 索引号不等于 contentId(如 contentId=897 → index_13480), 不能用算法反推,
 *      必须拿 index_<n> 到目录里做字符串匹配。
 */

const SIGN_KEY = "f0fc4c668392f9f9a447e48584c214ee";
const API_BASE = "https://ytmsout.radio.cn";
const LIST_PATH = "/web/appBroadcast/list";

const VERSION = "1.1.1";

/**
 * 已启用的地区目录。加省份只需在这里追加 6 位行政区划码, 无需改路由逻辑。
 *   "0"      = 国家级 / 央广系列(19 台)
 *   "330000" = 浙江
 *   "310000" = 上海
 *   例: 江苏 "320000"、广东 "440000"、北京 "110000"
 */
const REGIONS = ["0", "330000", "310000"];

/** 允许自动换签的上游主机(云听 CDN 集群) */
const RESIGN_HOST_RE = /^ytcast\d*\.radio\.cn$/i;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REFERER = "https://www.radio.cn/";

const FETCH_TIMEOUT_MS = 9000;
const CATALOG_TTL_MS = 60 * 1000; // 目录缓存 60s
const NOSIGNAL_RE = /nosignal\.(mp3|aac|m4a)/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,Range",
  "Access-Control-Max-Age": "86400",
};

const EXCLUDE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "set-cookie2",
];

// ---------------------------------------------------------------- 工具

function md5Hex(s) {
  return md5(s).toUpperCase();
}

function signedUrl(path, params) {
  const ts = String(Date.now());
  const q = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const sign = md5Hex(`${q}&timestamp=${ts}&key=${SIGN_KEY}`);
  return {
    url: `${API_BASE}${path}?${q}`,
    headers: {
      platformCode: "WEB",
      equipmentId: "0000",
      timestamp: ts,
      sign,
      "User-Agent": UA,
      Referer: REFERER,
    },
  };
}

async function fetchWithRetry(url, init, attempt = 0) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (e) {
    if (attempt < 1) return fetchWithRetry(url, init, attempt + 1);
    throw e;
  }
}

function corsResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, ...extra },
  });
}

function jsonResponse(obj, status = 200) {
  return corsResponse(JSON.stringify(obj, null, 2), status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function errResponse(status, code, detail) {
  return jsonResponse({ ok: false, error: code, detail }, status);
}

function redact(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname}`;
  } catch (_) {
    return "(invalid url)";
  }
}

function isPlaylist(text) {
  return text.trimStart().startsWith("#EXTM3U");
}

function abs(ref, baseUrl) {
  try {
    return new URL(ref, baseUrl).toString();
  } catch (_) {
    return ref;
  }
}

/** 从上游地址里取出 index_<n> 索引号(不是 contentId) */
function indexKeyOf(u) {
  const m = String(u || "").match(/index_(\d+)\.m3u8/i);
  return m ? m[1] : null;
}

/** 选流: .m3u8 线路优先, .mp3 裸流沉底 */
function pickUrl(it) {
  const cands = [it.mp3PlayUrlHigh, it.playUrlMulti, it.mp3PlayUrlLow, it.playUrlLow]
    .filter(Boolean)
    .map(String);
  const hls = cands.filter((u) => /\.m3u8(\?|$)/i.test(u));
  return (hls[0] || cands[0] || "").trim();
}

// ---------------------------------------------------------------- 目录

const catCache = new Map(); // provinceCode -> { at, data }

async function getCatalogFor(provinceCode, env) {
  const now = Date.now();
  const hit = catCache.get(provinceCode);
  if (hit && now - hit.at < CATALOG_TTL_MS) return hit.data;

  if (env && env.KV && typeof globalThis.KV === "undefined") globalThis.KV = env.KV;
  if (globalThis.KV) {
    try {
      const kvCache = await globalThis.KV.get(`radiocn:cat:${provinceCode}`, "json");
      if (kvCache && kvCache.at && now - kvCache.at < CATALOG_TTL_MS) {
        catCache.set(provinceCode, kvCache);
        return kvCache.data;
      }
    } catch (_) {}
  }

  const { url, headers } = signedUrl(LIST_PATH, { categoryId: "0", provinceCode });
  const res = await fetchWithRetry(url, { headers });
  const j = await res.json();
  const list = (j && j.data) || [];

  const data = list.map((it) => {
    const urls = [it.mp3PlayUrlHigh, it.playUrlMulti, it.mp3PlayUrlLow, it.playUrlLow]
      .filter(Boolean)
      .map(String);
    return {
      id: String(it.contentId),
      title: it.title,
      subtitle: it.subtitle || "",
      image: it.image || "",
      province: provinceCode,
      url: pickUrl(it),
      urls, // 保留全部线路, 供 /m3u8 换签时按 index_<n> 反查
    };
  });

  const payload = { at: now, data };
  catCache.set(provinceCode, payload);
  if (globalThis.KV) {
    try {
      await globalThis.KV.put(`radiocn:cat:${provinceCode}`, JSON.stringify(payload), {
        expirationTtl: 120,
      });
    } catch (_) {}
  }
  return data;
}

/** 合并所有已配置省份, 按 contentId 去重 */
async function getAllCatalog(env) {
  const groups = await Promise.all(
    REGIONS.map((p) => getCatalogFor(p, env).catch(() => []))
  );
  const seen = new Set();
  const out = [];
  for (const it of groups.flat()) {
    if (!it || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

/**
 * 核心: 把一个带过期签名的云听地址换成本次现签的新地址。
 * 返回 null 表示「不是可换签的云听地址」, 调用方应原样透传。
 */
async function resignUrl(targetUrl, env) {
  let host = "";
  try {
    host = new URL(targetUrl).hostname;
  } catch (_) {
    return null;
  }
  if (!RESIGN_HOST_RE.test(host)) return null;

  const idx = indexKeyOf(targetUrl);
  if (!idx) return null;

  const all = await getAllCatalog(env);
  const needle = `index_${idx}.m3u8`;
  const hit = all.find(
    (it) => (it.urls || []).some((u) => u.includes(needle))
  );
  if (!hit || !hit.url) return null;

  // 更新缓存里的引用, 方便日志/调试
  hit.__resignedAt = Date.now();
  return hit.url;
}

// ---------------------------------------------------------------- 清单重写

function rewritePlaylist(text, baseUrl, origin) {
  const out = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const raw = rawLine.trim();
    if (!raw) {
      out.push(rawLine);
      continue;
    }

    // 标签行: 原样保留, 仅重写带 URI="..." 的属性
    if (raw.startsWith("#")) {
      // EXTINF 兜底补逗号 (PlayHLS 必需)
      if (/^#EXTINF:\s*[\d.]+$/.test(raw)) {
        out.push(raw + ",");
        continue;
      }
      if (/URI="/.test(raw)) {
        out.push(
          rawLine.replace(/URI="([^"]+)"/g, (m, uri) => {
            if (!uri || uri.startsWith("data:")) return m;
            const a = abs(uri, baseUrl);
            return `URI="${origin}/s?url=${encodeURIComponent(a)}"`;
          })
        );
        continue;
      }
      out.push(rawLine);
      continue;
    }

    // 普通行: 分片 / 子清单 → 绝对化后走本 Worker
    const a = abs(raw, baseUrl);
    const isSub = /\.m3u8?(\?|$)/i.test(a);
    out.push(
      isSub
        ? `${origin}/m3u8?url=${encodeURIComponent(a)}`
        : `${origin}/s?url=${encodeURIComponent(a)}`
    );
  }

  return out.join("\n");
}

async function proxyPlaylist(targetUrl, origin) {
  const res = await fetchWithRetry(targetUrl, {
    headers: { "User-Agent": UA, Referer: REFERER },
  });

  if (!res.ok) {
    return errResponse(res.status === 403 ? 403 : 502, "upstream_error", {
      status: res.status,
      url: redact(targetUrl),
    });
  }

  const ct = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(buf);

  // 空号 / 占位流
  if (NOSIGNAL_RE.test(res.url || targetUrl) || ct.startsWith("audio/")) {
    return errResponse(404, "no_signal", "upstream returned a placeholder stream");
  }

  if (!isPlaylist(text)) {
    // 不是清单 → 原样透传(可能是 302 落地的二进制/HTML)
    return corsResponse(buf, res.status, {
      "Content-Type": ct || "application/octet-stream",
      "Cache-Control": "no-store",
    });
  }

  const body = rewritePlaylist(text, res.url || targetUrl, origin);
  return corsResponse(body, 200, {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store",
  });
}

async function proxySegment(targetUrl, req) {
  const h = { "User-Agent": UA, Referer: REFERER };
  const rng = req.headers.get("range");
  if (rng) h["Range"] = rng;

  const res = await fetchWithRetry(targetUrl, { headers: h });
  const outHeaders = new Headers(CORS_HEADERS);
  for (const [k, v] of res.headers) {
    if (!EXCLUDE_HEADERS.includes(k.toLowerCase())) outHeaders.set(k, v);
  }
  outHeaders.set("Cache-Control", "no-store");
  if (!outHeaders.get("content-type")) {
    outHeaders.set("content-type", "application/octet-stream");
  }

  return new Response(res.body, { status: res.status, headers: outHeaders });
}

// ---------------------------------------------------------------- 主逻辑

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

async function handleRequest(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const reqUrl = new URL(request.url);
  const origin = reqUrl.origin;
  const path = reqUrl.pathname;
  const targetParam = reqUrl.searchParams.get("url");

  if (path === "/health") {
    return jsonResponse({
      ok: true,
      service: "radio-cn-corsapi",
      version: VERSION,
      regions: REGIONS,
      resign: true,
    });
  }

  // 目录
  if (path === "/api/list") {
    try {
      const prov = reqUrl.searchParams.get("province");
      const cat =
        prov && prov !== "all"
          ? await getCatalogFor(prov, env)
          : await getAllCatalog(env);
      return jsonResponse({
        ok: true,
        count: cat.length,
        regions: REGIONS,
        items: cat.map((it) => ({
          id: it.id,
          title: it.title,
          subtitle: it.subtitle,
          image: it.image,
          province: it.province,
          // 统一走 /m3u8?url= 形态, 与 OPML 收藏夹一致
          play: it.url ? `${origin}/m3u8?url=${encodeURIComponent(it.url)}` : "",
        })),
      });
    } catch (e) {
      return errResponse(502, "catalog_error", String((e && e.message) || e));
    }
  }

  // ★ 通用 m3u8 代理(云听地址自动换签) —— 唯一播放入口
  if (path === "/m3u8" || path === "/m3u8.m3u8") {
    if (!targetParam) return errResponse(400, "missing_url", "?url= required");
    if (targetParam.startsWith(origin)) {
      return errResponse(400, "loop_detected", "self-referencing url");
    }

    let finalUrl = targetParam;
    let resigned = false;
    try {
      const fresh = await resignUrl(targetParam, env);
      if (fresh) {
        finalUrl = fresh;
        resigned = true;
      }
    } catch (_) {
      // 换签失败(目录拉取异常) → 退回原样透传, 不阻断播放
    }

    try {
      const resp = await proxyPlaylist(finalUrl, origin);
      if (resigned) resp.headers.set("X-Resigned", "1");
      return resp;
    } catch (e) {
      return errResponse(502, "fetch_error", String((e && e.message) || e));
    }
  }

  // 分片透传
  if (path === "/s") {
    if (!targetParam) return errResponse(400, "missing_url", "?url= required");
    if (targetParam.startsWith(origin)) {
      return errResponse(400, "loop_detected", "self-referencing url");
    }
    try {
      return await proxySegment(targetParam, request);
    } catch (e) {
      return errResponse(502, "fetch_error", String((e && e.message) || e));
    }
  }

  if (path === "/") {
    return corsResponse(handleHomePage(origin), 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  }

  return errResponse(404, "not_found", path);
}

// ---------------------------------------------------------------- 首页 (LunaTV 风格: 深色 + 绿主色 #22C55E)

function handleHomePage(currentOrigin) {
  const regions = REGIONS.map((r) => (r === "0" ? "国家级" : r)).join(" / ");
  const sampleResign = `${currentOrigin}/m3u8?url=${encodeURIComponent(
    "http://ytcast.radio.cn/69/radios/10843/index_10843.m3u8?type=1&key=x&time=x"
  )}`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>radio.cn CORS API v${VERSION}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --luna-green: #22C55E;
      --luna-green-deep: #10B981;
      --bg: #0F1117;
      --card: #1F2937;
      --border: #374151;
      --text: #FFFFFF;
      --sub: #9ca3af;
      --muted: #6b7280;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
      padding: 24px 16px;
    }
    .container {
      max-width: 880px;
      margin: 0 auto;
    }
    /* 顶部条 (跟 LunaTV Web 顶栏同款) */
    .topbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 4px 24px 4px;
    }
    .logo {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: linear-gradient(135deg, var(--luna-green), var(--luna-green-deep));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #052e16;
      font-size: 14px;
    }
    .brand {
      font-size: 16px;
      font-weight: 700;
      color: var(--text);
    }
    .pill {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: rgba(34, 197, 94, 0.12);
      color: var(--luna-green);
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }
    .pill .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--luna-green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    /* 头部 */
    .hero {
      padding: 32px 28px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .hero h1 {
      font-size: 28px;
      font-weight: 800;
      margin-bottom: 8px;
      color: var(--text);
    }
    .hero h1 .accent {
      color: var(--luna-green);
    }
    .hero p {
      color: var(--sub);
      font-size: 14px;
      margin-bottom: 16px;
    }
    .url-card {
      background: #0b0e14;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      font-family: 'SF Mono', Consolas, Monaco, monospace;
      font-size: 13px;
      color: var(--luna-green);
      word-break: break-all;
      margin-bottom: 8px;
    }
    .url-card .label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
      font-family: -apple-system, sans-serif;
    }
    /* 章节 */
    .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 16px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 14px;
    }
    .section-title::before {
      content: "";
      width: 3px;
      height: 14px;
      background: linear-gradient(180deg, var(--luna-green), var(--luna-green-deep));
      border-radius: 2px;
    }
    .section p {
      color: var(--sub);
      font-size: 14px;
      margin-bottom: 10px;
    }
    .section p:last-child {
      margin-bottom: 0;
    }
    pre {
      background: #0b0e14;
      color: #d1d5db;
      padding: 14px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      overflow-x: auto;
      font-family: 'SF Mono', Consolas, Monaco, monospace;
      font-size: 12.5px;
      line-height: 1.6;
      margin: 10px 0;
      white-space: pre;
    }
    pre .g { color: var(--luna-green); }
    pre .d { color: var(--muted); }
    code {
      background: rgba(34, 197, 94, 0.12);
      color: var(--luna-green);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Consolas, Monaco, monospace;
      font-size: 12.5px;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 8px 0;
    }
    li {
      color: var(--sub);
      font-size: 14px;
      padding: 6px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    li::before {
      content: "";
      width: 5px;
      height: 5px;
      background: var(--luna-green);
      border-radius: 50%;
      flex-shrink: 0;
    }
    /* 网格 */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      margin-top: 8px;
    }
    .feat {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13.5px;
      color: var(--sub);
    }
    .feat b {
      color: var(--luna-green);
      font-weight: 600;
    }
    /* 底部 */
    .footer {
      text-align: center;
      padding: 20px 0 4px 0;
      color: var(--muted);
      font-size: 12.5px;
    }
    .footer a {
      color: var(--luna-green);
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
    @media (max-width: 600px) {
      body { padding: 16px 12px; }
      .hero { padding: 22px 18px; }
      .hero h1 { font-size: 22px; }
      .section { padding: 16px 18px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- 顶部条 -->
    <div class="topbar">
      <div class="logo">R</div>
      <span class="brand">radio.cn CORS API</span>
      <span class="pill"><span class="dot"></span>运行中</span>
    </div>

    <!-- 头部 -->
    <div class="hero">
      <h1>云听电台中转代理 <span class="accent">/ 内建签名</span></h1>
      <p>云听(radio.cn) 专用跨域代理, 服务端现签 key/time, 上游地址可长期保存不失效。已启用地区: ${regions}。</p>
      <div class="url-card">
        <div class="label">播放入口 · 唯一入口, radio.cn 地址自动换签</div>
        ${currentOrigin}/m3u8?url=&lt;encoded 云听 m3u8&gt;
      </div>
      <div class="url-card">
        <div class="label">分片透传 · 支持 Range 206</div>
        ${currentOrigin}/s?url=&lt;encoded 分片地址&gt;
      </div>
    </div>

    <!-- 端点 -->
    <div class="section">
      <div class="section-title">端点</div>
      <ul>
        <li><code>GET /m3u8?url=&lt;encoded&gt;</code> m3u8 代理, ytcast*.radio.cn 地址自动换签, 分片重写为 <code>/s?url=...</code></li>
        <li><code>GET /s?url=&lt;encoded&gt;</code> 分片 / 二进制透传, 支持 Range</li>
        <li><code>GET /api/list[?province=all|330000|310000]</code> 云听目录 JSON</li>
        <li><code>GET /health</code> 健康检查</li>
      </ul>
    </div>

    <!-- 用法示例 -->
    <div class="section">
      <div class="section-title">用法示例</div>
      <p>云听原始地址(含过期 key)直接交给网关, key/time 可随意填, 网关每次现签:</p>
      <pre>原始: <span class="d">http://ytcast.radio.cn/69/radios/10843/index_10843.m3u8?type=1&amp;key=x&amp;time=x</span>
代理: <span class="g">${sampleResign}</span></pre>
      <p>非 radio.cn 源(cztv / ajmide / cnr.cn 等)按原样透传, 不做换签:</p>
      <pre>请求: <span class="g">${currentOrigin}/m3u8?url=https%3A%2F%2Fexample.com%2Flive.m3u8</span>
处理: <span class="d">拉清单 → 分片绝对化 → 重写为 /s?url=</span></pre>
    </div>

    <!-- 特性 -->
    <div class="section">
      <div class="section-title">功能特性</div>
      <div class="grid">
        <div class="feat"><b>内建现签</b><br>md5(sorted_query + timestamp + key)</div>
        <div class="feat"><b>自动换签</b><br>index_&lt;n&gt; 反查目录取新地址</div>
        <div class="feat"><b>EXTINF 补逗号</b><br>规避 PlayHLS 空列表</div>
        <div class="feat"><b>按正文判清单</b><br>不依赖 octet-stream Content-Type</div>
        <div class="feat"><b>Range 206</b><br>分片拖动 / 续传可用</div>
        <div class="feat"><b>自反循环检测</b><br>防止 worker 套 worker</div>
        <div class="feat"><b>多省合并</b><br>REGIONS 追加区划码即可</div>
        <div class="feat"><b>CORS 完整</b><br>Access-Control-* 全套</div>
      </div>
    </div>

    <!-- 配套 -->
    <div class="section">
      <div class="section-title">配套客户端</div>
      <p>收藏夹条目直接写 <code>/m3u8?url=</code> 形态即可, PlayHLS 依赖 URL 内含 <code>.m3u8</code> 后缀识别 HLS。</p>
      <pre>Lyrion / piCorePlayer → <span class="g">PlayHLS v2</span> 插件
收藏夹 OPML          → <span class="g">url 参数内含 .m3u8</span>
分片拉流            → 走 <span class="g">/s?url=</span>, 无需额外配置</pre>
    </div>

    <div class="footer">
      <a href="https://github.com/SzeMeng76/CORSAPI" target="_blank">SzeMeng76/CORSAPI</a>
      &nbsp;·&nbsp;
      <a href="https://www.radio.cn/" target="_blank">云听 radio.cn</a>
      <br>
      <span style="margin-top: 6px; display: inline-block;">radio.cn CORS API v${VERSION} · Powered by Cloudflare Workers / Node.js</span>
    </div>
  </div>
</body>
</html>`;

  return html;
}

// ---------------------------------------------------------------- md5 (精简实现, 仅用于签名)

function md5(str) {
  function rl(n, c) {
    return (n << c) | (n >>> (32 - c));
  }
  function au(x, y) {
    const l = (x & 0xffff) + (y & 0xffff);
    const m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xffff);
  }
  function cmn(q, a, b, x, s, t) {
    return au(rl(au(au(a, q), au(x, t)), s), b);
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function sb(s) {
    const n = s.length;
    const w = [];
    for (let i = 0; i < n * 8; i += 8) w[i >> 5] |= (s.charCodeAt(i / 8) & 0xff) << i % 32;
    return w;
  }
  function utf8(s) {
    return unescape(encodeURIComponent(s));
  }
  const x = sb(utf8(str));
  const len = utf8(str).length * 8;
  x[len >> 5] |= 0x80 << len % 32;
  x[(((len + 64) >>> 9) << 4) + 14] = len;

  let a = 1732584193,
    b = -271733879,
    c = -1732584194,
    d = 271733878;

  for (let i = 0; i < x.length; i += 16) {
    const oa = a,
      ob = b,
      oc = c,
      od = d;
    a = ff(a, b, c, d, x[i] || 0, 7, -680876936);
    d = ff(d, a, b, c, x[i + 1] || 0, 12, -389564586);
    c = ff(c, d, a, b, x[i + 2] || 0, 17, 606105819);
    b = ff(b, c, d, a, x[i + 3] || 0, 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4] || 0, 7, -176418897);
    d = ff(d, a, b, c, x[i + 5] || 0, 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6] || 0, 17, -1473231341);
    b = ff(b, c, d, a, x[i + 7] || 0, 22, -45705983);
    a = ff(a, b, c, d, x[i + 8] || 0, 7, 1770035416);
    d = ff(d, a, b, c, x[i + 9] || 0, 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10] || 0, 17, -42063);
    b = ff(b, c, d, a, x[i + 11] || 0, 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12] || 0, 7, 1804603682);
    d = ff(d, a, b, c, x[i + 13] || 0, 12, -40341101);
    c = ff(c, d, a, b, x[i + 14] || 0, 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15] || 0, 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1] || 0, 5, -165796510);
    d = gg(d, a, b, c, x[i + 6] || 0, 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11] || 0, 14, 643717713);
    b = gg(b, c, d, a, x[i] || 0, 20, -373897302);
    a = gg(a, b, c, d, x[i + 5] || 0, 5, -701558691);
    d = gg(d, a, b, c, x[i + 10] || 0, 9, 38016083);
    c = gg(c, d, a, b, x[i + 15] || 0, 14, -660478335);
    b = gg(b, c, d, a, x[i + 4] || 0, 20, -405537848);
    a = gg(a, b, c, d, x[i + 9] || 0, 5, 568446438);
    d = gg(d, a, b, c, x[i + 14] || 0, 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3] || 0, 14, -187363961);
    b = gg(b, c, d, a, x[i + 8] || 0, 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13] || 0, 5, -1444681467);
    d = gg(d, a, b, c, x[i + 2] || 0, 9, -51403784);
    c = gg(c, d, a, b, x[i + 7] || 0, 14, 1735328473);
    b = gg(b, c, d, a, x[i + 12] || 0, 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5] || 0, 4, -378558);
    d = hh(d, a, b, c, x[i + 8] || 0, 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11] || 0, 16, 1839030562);
    b = hh(b, c, d, a, x[i + 14] || 0, 23, -35309556);
    a = hh(a, b, c, d, x[i + 1] || 0, 4, -1530992060);
    d = hh(d, a, b, c, x[i + 4] || 0, 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7] || 0, 16, -155497632);
    b = hh(b, c, d, a, x[i + 10] || 0, 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13] || 0, 4, 681279174);
    d = hh(d, a, b, c, x[i] || 0, 11, -358537222);
    c = hh(c, d, a, b, x[i + 3] || 0, 16, -722521979);
    b = hh(b, c, d, a, x[i + 6] || 0, 23, 76029189);
    a = hh(a, b, c, d, x[i + 9] || 0, 4, -640364487);
    d = hh(d, a, b, c, x[i + 12] || 0, 11, -421815835);
    c = hh(c, d, a, b, x[i + 15] || 0, 16, 530742520);
    b = hh(b, c, d, a, x[i + 2] || 0, 23, -995338651);
    a = ii(a, b, c, d, x[i] || 0, 6, -198630844);
    d = ii(d, a, b, c, x[i + 7] || 0, 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14] || 0, 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5] || 0, 21, -57434055);
    a = ii(a, b, c, d, x[i + 12] || 0, 6, 1700485571);
    d = ii(d, a, b, c, x[i + 3] || 0, 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10] || 0, 15, -1051523);
    b = ii(b, c, d, a, x[i + 1] || 0, 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8] || 0, 6, 1873313359);
    d = ii(d, a, b, c, x[i + 15] || 0, 10, -30611744);
    c = ii(c, d, a, b, x[i + 6] || 0, 15, -1560198380);
    b = ii(b, c, d, a, x[i + 13] || 0, 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4] || 0, 6, -145523070);
    d = ii(d, a, b, c, x[i + 11] || 0, 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2] || 0, 15, 718787259);
    b = ii(b, c, d, a, x[i + 9] || 0, 21, -343485551);

    a = au(a, oa);
    b = au(b, ob);
    c = au(c, oc);
    d = au(d, od);
  }

  const hex = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
  const words = [a, b, c, d];
  let out = "";
  for (let i = 0; i < words.length * 4; i++) {
    const v = words[i >> 2];
    out += hex[(v >> ((i % 4) * 8 + 4)) & 0x0f] + hex[(v >> ((i % 4) * 8)) & 0x0f];
  }
  return out;
}
