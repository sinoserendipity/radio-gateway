/**
 * radio.cn HLS 网关 — Cloudflare Worker 版
 *
 * 用途：把 radio.0472.org/?id=<id>（302 → radio.cn 带 key+time 签名的 m3u8）
 *      暴露成 https://<你的域名>/r/<id>.m3u8，供 Lyrion Music Server + PlayHLS 播放。
 *
 * 与 NAS 上 radio-gateway 的差异：
 *   - 本 Worker 只代理 m3u8 列表（几 KB），把所有分片地址重写成绝对 URL，
 *     分片由播放器直连 CDN 拉取。实测 ytcast2.radio.cn 的 .ts/.aac 分片无需签名，
 *     直连返回 200，所以 Worker 不承担音频流量。
 *
 * 关键点（实测依据）：
 *   1. radio.0472.org 在 Cloudflare 后面，对浏览器 UA 会返回
 *      "Just a moment..." 挑战页（403）。用 VLC UA 请求则直接 200 放行。
 *      → 因此必须伪装 UA，否则 fetch 拿到的是挑战页而不是播放列表。
 *   2. 上游 Content-Type 是 application/octet-stream，必须改写为
 *      application/vnd.apple.mpegurl，否则 PlayHLS 不认。
 *   3. PlayHLS v2 靠 URL 是否以 .m3u8 结尾识别 HLS，
 *      所以对外路由必须是 /r/<id>.m3u8 这种带后缀的形式，
 *      不能用 /?url=xxx 这种查询串形式。
 *
 * v2.0.0 修复的实测缺陷：
 *   [P0] 空号/占位流：上游 302 到 live.fanmingming.com/assets/nosignal.mp3 时
 *        原实现把 ID3 二进制头当错误正文回吐 502。现判为 404（No Signal），
 *        正文只给一句话，不泄露上游内容。
 *   [P0] 错误体脱敏：原实现把含 key=…&time=… 的签名 URL 原样写进错误正文。
 *        现在所有对外错误只输出 protocol//host+path，query 一律剥离。
 *   [P0] 僵尸流：有 #EXTM3U 但分片全是 2023 年静态残骸（实拉 404），
 *        原实现照样返回 200，播放器拿到空流。现在抽查末尾分片，
 *        全不可达则返回 503 且带 Retry-After。
 *   [P0] 混合内容：上游分片为 http，https 入口播放器会拦。现在统一升级为 https
 *        （实测 ytcast/ytcast2/ytlive 三种落地域名 https 均 200）。
 *   [P1] 增加 caches.default 5 秒短缓存，播放器连续起播时不再重复换签。
 *   [P1] 上游 fetch 加 AbortSignal.timeout(8000)，并在网络异常时重试一次。
 *   [P1] 补齐 #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 的 URI="…" 属性重写，
 *        否则加密或 fMP4 流会指向相对路径而 404。
 *
 * 可选环境变量（Cloudflare Dashboard → Worker → Settings → Variables）：
 *   PROBE_SEGMENTS = "0"   关闭分片可用性抽查（默认开启）
 *   FORCE_HTTPS    = "0"   关闭分片强制 https（默认开启）
 */

const VERSION = "2.0.0";

const UPSTREAM_ENTRY = "https://radio.0472.org/?id=";
const UPSTREAM_UA = "VLC/3.0.20 LibVLC/3.0.20";
const HLS_MIME = "application/vnd.apple.mpegurl";

const FETCH_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 4000;
const PLAYLIST_TTL_SEC = 5;
const PROBE_SEGMENTS = 2; // 抽查末尾 2 个分片，命中任一即视为活流

const UPSTREAM_HEADERS = {
  "User-Agent": UPSTREAM_UA,
  "Accept": "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const NOSIGNAL_RE = /nosignal\.(mp3|aac|m4a)/i;

/* ---------------- 基础工具 ---------------- */

// 剥离 query（key/time 签名就在 query 里），只保留协议+主机+路径
function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparsable-url)";
  }
}

// 把任意字符串里出现的 URL 全部脱敏，用于异常消息
function redactText(s) {
  return String(s == null ? "" : s).replace(/https?:\/\/[^\s"'<>()]+/g, (m) => redact(m));
}

function isPlaylist(text) {
  return text.trimStart().startsWith("#EXTM3U");
}

function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host);
}

// 绝对化 + 可选强制 https（私有地址保持原协议）
function absolutize(ref, baseDir, baseProto, forceHttps) {
  let abs;
  if (/^https?:\/\//i.test(ref)) {
    abs = ref;
  } else if (ref.startsWith("//")) {
    abs = baseProto + ref;
  } else {
    try {
      abs = new URL(ref, baseDir).toString();
    } catch {
      abs = baseDir + ref;
    }
  }
  if (!forceHttps) return abs;
  try {
    const u = new URL(abs);
    if (u.protocol === "http:" && !isPrivateHost(u.hostname)) u.protocol = "https:";
    return u.toString();
  } catch {
    return abs;
  }
}

// 重写播放列表：普通分片行 + 带 URI="…" 的标签（KEY / MAP / MEDIA / I-FRAME-STREAM-INF）
function rewritePlaylist(text, baseUrl, forceHttps) {
  const u = new URL(baseUrl);
  const baseProto = u.protocol;
  const baseDir = baseUrl.slice(0, baseUrl.lastIndexOf("/") + 1);

  return text
    .split("\n")
    .map((line) => {
      const raw = line.trim();
      if (!raw) return line;

      if (raw.startsWith("#")) {
        // 仅处理含 URI="..." 属性的标签
        if (!/URI="/i.test(raw)) return line;
        return raw.replace(/URI="([^"]*)"/gi, (_all, uri) => {
          if (!uri || uri.startsWith("data:")) return `URI="${uri}"`;
          return `URI="${absolutize(uri, baseDir, baseProto, forceHttps)}"`;
        });
      }

      return absolutize(raw, baseDir, baseProto, forceHttps);
    })
    .join("\n");
}

function mediaLineUrls(text, baseUrl, forceHttps) {
  const u = new URL(baseUrl);
  const baseDir = baseUrl.slice(0, baseUrl.lastIndexOf("/") + 1);
  const out = [];
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    out.push(absolutize(raw, baseDir, u.protocol, forceHttps));
  }
  return out;
}

/* ---------------- 响应构造 ---------------- */

function playlistResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": HLS_MIME,
      "Cache-Control": `public, max-age=${PLAYLIST_TTL_SEC}`,
      "Access-Control-Allow-Origin": "*",
      "X-Gateway-Version": VERSION,
    },
  });
}

function errResponse(status, code, detail, extraHeaders = {}) {
  const body = JSON.stringify({
    error: code,
    status,
    detail: redactText(detail),
    gateway: VERSION,
  });
  return new Response(body + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Gateway-Version": VERSION,
      ...extraHeaders,
    },
  });
}

/* ---------------- 上游拉取 ---------------- */

async function fetchWithRetry(url, attempt = 0) {
  try {
    const resp = await fetch(url, {
      headers: UPSTREAM_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok && resp.status >= 500 && attempt < 1) {
      return fetchWithRetry(url, attempt + 1);
    }
    return resp;
  } catch (e) {
    if (attempt < 1) return fetchWithRetry(url, attempt + 1);
    throw e;
  }
}

// 抽查末尾若干分片：任一可达即视为活流
async function hasLiveSegment(segments) {
  if (segments.length === 0) return false;
  const tail = segments.slice(-PROBE_SEGMENTS).reverse();
  for (const seg of tail) {
    try {
      const r = await fetch(seg, {
        method: "GET",
        headers: { ...UPSTREAM_HEADERS, Range: "bytes=0-0" },
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // 206/200 视为存活；403 也可能是防盗链，不当作死亡判定之外的成功
      if (r.ok || r.status === 206) return true;
      if (r.status !== 403 && r.status !== 404 && r.status !== 410) return true; // 其它异常状态先放过，避免误杀
    } catch {
      // 单个分片超时/网络错误，继续看下一个
    }
  }
  return false;
}

/* ---------------- 主逻辑 ---------------- */

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return errResponse(405, "method_not_allowed", `method ${request.method} not supported`, {
        Allow: "GET, HEAD",
      });
    }

    if (path === "/health") {
      return new Response(`ok ${VERSION}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // ---------------- 路由 ----------------
    let upstream = null;
    let isIdRoute = false;

    const m = path.match(/^\/r\/(\d+)\.m3u8$/);
    if (m) {
      upstream = `${UPSTREAM_ENTRY}${m[1]}`;
      isIdRoute = true;
    }
    if (!upstream) {
      const u = reqUrl.searchParams.get("url");
      if (u) upstream = u;
    }

    if (!upstream) {
      return errResponse(
        400,
        "bad_request",
        "usage: GET /r/<id>.m3u8 (for LMS) | GET /?url=<m3u8 url> (debug) | GET /health"
      );
    }

    const forceHttps = !(env && env.FORCE_HTTPS === "0");
    const probeEnabled = isIdRoute && !(env && env.PROBE_SEGMENTS === "0");

    // ---------------- 短缓存（仅 GET 且仅 /r/ 路由）----------------
    const cache = typeof caches !== "undefined" ? caches.default : null;
    let cacheKey = null;
    if (cache && request.method === "GET") {
      cacheKey = new Request(reqUrl.toString(), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set("X-Gateway-Cache", "HIT");
        return new Response(hit.body, { status: hit.status, headers });
      }
    }

    // ---------------- 拉上游 ----------------
    let resp;
    try {
      resp = await fetchWithRetry(upstream);
    } catch (e) {
      return errResponse(
        502,
        "upstream_unreachable",
        `${e && e.name ? e.name : "Error"}: ${e && e.message ? e.message : "fetch failed"}`
      );
    }

    const finalUrl = resp.url || upstream;

    // 空号/占位流：上游 302 到 nosignal.mp3（音频而非播放列表）
    const ct = (resp.headers.get("Content-Type") || "").toLowerCase();
    if (NOSIGNAL_RE.test(finalUrl) || ct.startsWith("audio/")) {
      return errResponse(404, "no_signal", `upstream target is a placeholder stream (ct: ${ct})`, {
        "X-Upstream-Host": safeHost(finalUrl),
      });
    }

    if (!resp.ok) {
      // 403 通常是 Cloudflare 挑战页，404 是上游不存在
      const status = resp.status === 404 || resp.status === 410 ? 404 : 502;
      return errResponse(status, "upstream_error", `upstream ${resp.status} at ${redact(finalUrl)}`, {
        "X-Upstream-Host": safeHost(finalUrl),
      });
    }

    let text;
    try {
      text = await resp.text();
    } catch (e) {
      return errResponse(502, "upstream_read_failed", e && e.message);
    }

    // 上游返回挑战页/HTML：明确报错，不把 HTML 当播放列表吐出去
    if (!isPlaylist(text)) {
      const kind = ct.includes("html") ? "html_challenge" : "not_a_playlist";
      return errResponse(502, kind, `upstream content-type: ${ct || "(none)"} at ${redact(finalUrl)}`);
    }

    const segments = mediaLineUrls(text, finalUrl, forceHttps);

    // 无分片的空列表
    if (segments.length === 0) {
      return errResponse(503, "empty_playlist", "playlist has no segments", { "Retry-After": "30" });
    }

    // 僵尸流：有 #EXTM3U，但分片全是已下线的静态残骸
    if (probeEnabled && !(await hasLiveSegment(segments))) {
      return errResponse(
        503,
        "stale_stream",
        `tail ${Math.min(PROBE_SEGMENTS, segments.length)} segment(s) unreachable at ${redact(finalUrl)}`,
        { "Retry-After": "60" }
      );
    }

    const rewritten = rewritePlaylist(text, finalUrl, forceHttps);
    const out = playlistResponse(rewritten);

    if (cache && cacheKey) {
      try {
        await cache.put(cacheKey, out.clone());
      } catch {
        // 缓存失败不影响播放
      }
    }

    return out;
  },
};

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
