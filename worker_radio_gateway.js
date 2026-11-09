/**
 * radio.cn HLS 网关 — Cloudflare Worker 版 v2.1.2
 *
 * 用途：把 radio.0472.org/?id=<id>（302 → radio.cn 带 key+time 签名的 m3u8）
 *      暴露成 https://<你的域名>/r/<id>.m3u8，供 Lyrion Music Server + PlayHLS 播放。
 *
 * v2.1.2（在 v2.1.1 上的修正）：
 *   [P0] 播放列表响应改 Cache-Control: no-store（原 public, max-age=2）。
 *        实测线上：v2.1.1 的 max-age=2 被 Cloudflare 默认 Browser Cache TTL（4h）
 *        覆盖成 max-age=14400，LMS/PlayHLS 会拿同一份 #EXT-X-MEDIA-SEQUENCE
 *        重放几小时，直播卡死。no-store 不被该设置改写（错误响应一直是 no-store
 *        且线上原样返回，可作证据）。内部 caches.default 的去重仍保留——缓存对象
 *        单独用 max-age=5，只有回给客户端的响应头是 no-store。
 *   [P0] 加 CDN-Cache-Control: no-store，显式禁止边缘层二次缓存播放列表。
 *   [P1] 新增响应头 X-Timing（entry/playlist/probe/total 毫秒），线上延迟瓶颈
 *        可直接定位，不必靠盲猜。命中缓存时输出 cache=HIT 与 age。
 *
 * v2.1.1（在 v2.1.0 上的修正）：
 *   [P0] 分片抽查改三态 alive/dead/unknown：只有明确死亡（404/410/451）才判僵尸流，
 *        5xx/403/400/超时等一律 unknown 并放行（fail-open）。v2.1.0 把 500/403
 *        也当死，云听 CDN 边缘抖动时会把可播流误杀成 503 stale_stream。
 *   [P0] 上游超时 6000→4000 且允许重试一次（总预算 ≤8s）：v2.1.0 的 6s 单发
 *        在冷启动/抖动下没有兜底，比 v2.0.0 的 8s×2 更脆。重试对 radio.0472.org
 *        安全，每次请求都会重新签发 key/time。
 *   [P1] 占位流判定改用 peek：CT 命中 audio/* 时先读正文前 512 字节，以 #EXTM3U
 *        开头就按播放列表继续（有源把 m3u8 标成 audio/mpeg），否则才判 no_signal。
 *        nosignal.mp3 是无限流，仍靠落地 URL 直接判，绝不读 body。
 *   [P1] 客户端 Cache-Control 降为 2s（内部 caches.default 仍 5s），
 *        列表刷新更快，减少叠加的直播延迟。
 *   [P2] 416 归为 dead（0~1 字节分片是坏片）；移除无意义的 e.code === 23 判断。
 *
 * v2.1.0（在 v2.0.0 上的修正，部分已被 v2.1.1 覆盖）：
 *   [P0] audio/* 不再一律当占位流：audio/mpegurl、audio/x-mpegurl 是播放列表。
 *        注：实测 radio.0472.org 落地 m3u8 的 CT 恒为 application/octet-stream，
 *        该误判在主链路本不会触发，属防御性修正（?url= 调试他源时有用）。
 *   [P0] 顶层 try/catch：任何意外异常都返回 JSON 错误，不再抛 CF 1101 HTML。
 *   [P0] 分片抽查判定反转：只有 2xx/206/416 才算活；原实现把 500/429/401 也算活，
 *        僵尸流照样 200。且并行抽查 + 立即 cancel body，不再把整段音频拉下来。
 *   [P1] 超时不再重试：AbortSignal.timeout 的 TimeoutError 被原 fetchWithRetry
 *        当成网络错误重试，最坏 8s×2。现在只对非 abort 的异常和 502/503/504 重试。
 *   [P1] 缓存只作用于 /r/ 路由（原注释这么写但代码没判断），cache.put 交给
 *        ctx.waitUntil，不阻塞响应；key 里带版本与配置位。
 *   [P1] ?url= 目标做协议 + 私网 + 主机白名单校验（原实现是任意 URL 的开放抓取）。
 *   [P1] 403 单独归类 cf_challenge；429 带 Retry-After；502 也带 Retry-After。
 *   [P1] 上游 body 加大小上限，避免异常大响应打爆内存。
 *   [P2] 行尾统一 \n；baseDir 用 new URL(".", base) 计算；补 nosniff。
 *
 * 已知未覆盖（需要另外设计）：
 *   若上游返回的是 master playlist（#EXT-X-STREAM-INF 指向子列表）或加密流，
 *   子列表 / #EXT-X-KEY 的 URI 目前只做绝对化、不做代理，播放器直连时若同样需要
 *   VLC UA 或签名就会 403/404。要彻底解决需加一条带 HMAC 的 /p/ 代理路由。
 *
 * 可选环境变量：
 *   PROBE_SEGMENTS = "0"     关闭分片可用性抽查（默认开启）
 *   FORCE_HTTPS    = "0"     关闭分片强制 https（默认开启）
 *   ALLOW_HOSTS    = "a.com,b.com"   追加 ?url= 允许的主机后缀（如 cnr.cn,cri.cn）
 *   ALLOW_ANY_URL  = "1"     完全放开 ?url= 的主机限制（仍拒绝私网）
 *   LOG            = "0"     关闭每请求日志
 */

const VERSION = "2.1.2";

const UPSTREAM_ENTRY = "https://radio.0472.org/?id=";
const UPSTREAM_UA = "VLC/3.0.20 LibVLC/3.0.20";
const HLS_MIME = "application/vnd.apple.mpegurl";

const FETCH_TIMEOUT_MS = 4000; // 允许重试一次，总预算 ≤8s
const PROBE_TIMEOUT_MS = 3000;
const PLAYLIST_CACHE_TTL_SEC = 5; // 内部 caches.default 存活时间（客户端一律 no-store）
const PROBE_TAIL = 2;
const MAX_PLAYLIST_BYTES = 512 * 1024;
const PEEK_BYTES = 512;

const UPSTREAM_HEADERS = {
  "User-Agent": UPSTREAM_UA,
  "Accept": "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

// 只有明确的音频容器才算 no-signal；audio/mpegurl 是播放列表，必须放行
const NOSIGNAL_RE = /nosignal\.(mp3|aac|m4a)/i;
const AUDIO_CONTAINER_RE = /^audio\/(mpeg|mp3|mp4|aac|x-m4a|ogg|opus|flac|webm)(;|$|\s)/i;

const DEFAULT_ALLOWED_HOSTS = ["radio.0472.org", "0472.org", "radio.cn"];
const RETRYABLE_STATUS = new Set([502, 503, 504]);
// 只有这些状态算"明确死亡的僵尸分片"，其余都算 unknown → 放行
const DEAD_SEGMENT_STATUS = new Set([404, 410, 451]);

/* ---------------- 基础工具 ---------------- */

function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparsable-url)";
  }
}

function redactText(s) {
  return String(s == null ? "" : s).replace(/https?:\/\/[^\s"'<>()]+/g, (m) => redact(m));
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function isPlaylist(text) {
  return String(text).replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U");
}

function isAllowedHost(host, env) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  const extra = String((env && env.ALLOW_HOSTS) || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  return DEFAULT_ALLOWED_HOSTS.concat(extra).some((s) => h === s || h.endsWith("." + s));
}

function isPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / 云元数据
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(v6)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]?:/.test(v6)) return true; // fe80::/10
    if (v6.startsWith("::ffff:")) return isPrivateHost(v6.slice(7));
  }
  return false;
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
  const base = new URL(baseUrl);
  const baseProto = base.protocol;
  const baseDir = new URL(".", base).toString();

  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const raw = line.trim();
      if (!raw) return "";

      if (raw.startsWith("#")) {
        if (!/URI="/i.test(raw)) return raw;
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
  const base = new URL(baseUrl);
  const baseDir = new URL(".", base).toString();
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    out.push(absolutize(raw, baseDir, base.protocol, forceHttps));
  }
  return out;
}

function isAbortError(e) {
  return !!e && (e.name === "TimeoutError" || e.name === "AbortError");
}

async function discardBody(resp) {
  try {
    if (resp && resp.body && !resp.bodyUsed) await resp.body.cancel();
  } catch {
    // 连接已经断了，忽略
  }
}

// 只读前 maxBytes 字节就断开分支流：用于在 CT 像音频时确认正文是不是播放列表
async function peekText(resp, maxBytes = PEEK_BYTES) {
  if (!resp || !resp.body) return "";
  let reader;
  try {
    reader = resp.clone().body.getReader();
  } catch {
    return "";
  }
  let buf = new Uint8Array(0);
  try {
    while (buf.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  } catch {
    // 读到一半断了，用已有内容判断
  }
  try {
    await reader.cancel();
  } catch {
    // 忽略
  }
  return new TextDecoder().decode(buf.subarray(0, maxBytes));
}

/* ---------------- 响应构造 ---------------- */

function playlistResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": HLS_MIME,
      // 必须 no-store：Cloudflare 默认 Browser Cache TTL = 4h 会把 public/max-age
      // 覆盖成 max-age=14400，LMS 会重放同一份播放列表直到直播卡死。
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
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
      "X-Content-Type-Options": "nosniff",
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
    if (RETRYABLE_STATUS.has(resp.status) && attempt < 1) {
      await discardBody(resp);
      return fetchWithRetry(url, attempt + 1);
    }
    return resp;
  } catch (e) {
    // 超时与网络错误都重试一次：单发 4s 失败就放弃太脆，两次合计 ≤8s
    if (attempt < 1) return fetchWithRetry(url, attempt + 1);
    throw e;
  }
}

// 单个分片探测：读 2 字节就断开，不落盘
// 返回 "alive" | "dead" | "unknown"
//   alive  : 2xx（含 206，实测 ytcast/ytcast2 对 Range 请求返回 206）
//   dead   : 404 / 410 / 451，明确下线
//   unknown: 5xx / 403 / 400 / 416 / 超时 / 网络错误 —— 边缘抖动，不能据此判死
async function probeSegment(url) {
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { ...UPSTREAM_HEADERS, Range: "bytes=0-1" },
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const status = r.status;
    await discardBody(r);
    if (status >= 200 && status < 300) return "alive";
    if (DEAD_SEGMENT_STATUS.has(status)) return "dead";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// 并行抽查末尾若干分片：
//   任一 alive      → 活流
//   全部明确 dead   → 僵尸流
//   其余（含 unknown）→ 放行（fail-open，宁可让播放器自己重试）
async function hasLiveSegment(segments) {
  if (segments.length === 0) return false;
  const tail = segments.slice(-PROBE_TAIL).reverse();
  const results = await Promise.all(tail.map((s) => probeSegment(s)));
  if (results.some((r) => r === "alive")) return true;
  return !results.every((r) => r === "dead");
}

/* ---------------- 主逻辑 ---------------- */

async function handle(request, env, ctx) {
  const started = Date.now();
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
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Gateway-Version": VERSION,
      },
    });
  }

  // ---------------- 路由 ----------------
  let upstream = null;
  let kind = null;

  const m = path.match(/^\/r\/([A-Za-z0-9_-]{1,64})\.m3u8$/);
  if (m) {
    upstream = `${UPSTREAM_ENTRY}${m[1]}`;
    kind = "id";
  }

  if (!upstream) {
    const raw = reqUrl.searchParams.get("url");
    if (raw) {
      let target;
      try {
        target = new URL(raw);
      } catch {
        return errResponse(400, "bad_url", "url parameter is not a valid absolute URL");
      }
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        return errResponse(400, "bad_url", `unsupported scheme ${target.protocol}`);
      }
      if (isPrivateHost(target.hostname)) {
        return errResponse(400, "bad_url", "private/loopback targets are not allowed");
      }
      if (!(env && env.ALLOW_ANY_URL === "1") && !isAllowedHost(target.hostname, env)) {
        return errResponse(
          400,
          "host_not_allowed",
          `?url= is restricted to radio hosts (${target.hostname}); set ALLOW_HOSTS or ALLOW_ANY_URL=1 to widen`
        );
      }
      upstream = target.toString();
      kind = "debug";
    }
  }

  if (!upstream) {
    return errResponse(
      400,
      "bad_request",
      "usage: GET /r/<id>.m3u8 (for LMS) | GET /?url=<m3u8 url> (debug) | GET /health"
    );
  }

  const forceHttps = !(env && env.FORCE_HTTPS === "0");
  const probeEnabled = kind === "id" && request.method === "GET" && !(env && env.PROBE_SEGMENTS === "0");

  // ---------------- 短缓存（仅 GET + /r/ 路由）----------------
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  let cacheKey = null;
  if (cache && kind === "id" && request.method === "GET") {
    cacheKey = new Request(
      `${reqUrl.origin}/__cache/v${VERSION}/${forceHttps ? 1 : 0}${probeEnabled ? 1 : 0}${path}`,
      { method: "GET" }
    );
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("X-Gateway-Cache", "HIT");
      // 缓存里存的是 max-age=5 的副本，回给客户端时必须换回 no-store，
      // 否则 CF 会按 zone 的 Browser Cache TTL 把它抬到 4h。
      headers.set("Cache-Control", "no-store");
      headers.set("CDN-Cache-Control", "no-store");
      const ageMs = Date.now() - parseInt(headers.get("X-Cached-At") || "0", 10) || 0;
      headers.delete("X-Cached-At");
      headers.set("X-Timing", `cache=HIT;age=${ageMs};total=${Date.now() - started}`);
      log(env, { evt: "req", id: m && m[1], status: hit.status, cache: "HIT", ms: Date.now() - started });
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  // ---------------- 拉上游 ----------------
  let resp;
  let tEntry = 0;
  try {
    resp = await fetchWithRetry(upstream);
    tEntry = Date.now() - started; // 含入口 302 + 落地 m3u8 两跳
  } catch (e) {
    log(env, { evt: "upstream_error", id: m && m[1], err: (e && e.name) || "Error", ms: Date.now() - started });
    return errResponse(
      502,
      isAbortError(e) ? "upstream_timeout" : "upstream_unreachable",
      `${(e && e.name) || "Error"}: ${(e && e.message) || "fetch failed"}`,
      { "Retry-After": "10" }
    );
  }

  const finalUrl = resp.url || upstream;
  const ct = (resp.headers.get("Content-Type") || "").toLowerCase().split(";")[0].trim();

  // 空号/占位流：上游 302 到 nosignal.mp3。它可能是无限音频流，
  // 所以先按落地 URL 判定，绝不先读 body。
  if (NOSIGNAL_RE.test(finalUrl)) {
    await discardBody(resp);
    return errResponse(404, "no_signal", `upstream target is a placeholder stream (ct: ${ct || "(none)"})`, {
      "X-Upstream-Host": safeHost(finalUrl),
    });
  }

  // CT 像音频容器时再 peek 正文：有源把 m3u8 标成 audio/mpeg，
  // 正文以 #EXTM3U 开头就按播放列表继续，否则才算占位流。
  if (AUDIO_CONTAINER_RE.test(ct)) {
    const head = await peekText(resp);
    if (!isPlaylist(head)) {
      await discardBody(resp);
      return errResponse(404, "no_signal", `upstream target is a placeholder stream (ct: ${ct || "(none)"})`, {
        "X-Upstream-Host": safeHost(finalUrl),
      });
    }
  }

  if (!resp.ok) {
    await discardBody(resp);
    if (resp.status === 404 || resp.status === 410) {
      return errResponse(404, "upstream_gone", `upstream ${resp.status} at ${redact(finalUrl)}`, {
        "X-Upstream-Host": safeHost(finalUrl),
      });
    }
    if (resp.status === 403) {
      // radio.0472.org 的 CF 挑战页：说明 VLC UA 那套放行规则变了
      return errResponse(502, "cf_challenge", `upstream 403 at ${redact(finalUrl)} — UA allowlist may have changed`, {
        "X-Upstream-Host": safeHost(finalUrl),
      });
    }
    if (resp.status === 429) {
      return errResponse(503, "upstream_rate_limited", `upstream 429 at ${redact(finalUrl)}`, {
        "Retry-After": "60",
      });
    }
    return errResponse(502, "upstream_error", `upstream ${resp.status} at ${redact(finalUrl)}`, {
      "Retry-After": "15",
      "X-Upstream-Host": safeHost(finalUrl),
    });
  }

  const declared = Number(resp.headers.get("Content-Length") || 0);
  if (declared > MAX_PLAYLIST_BYTES) {
    await discardBody(resp);
    return errResponse(502, "playlist_too_large", `declared ${declared} bytes at ${redact(finalUrl)}`);
  }

  let text;
  try {
    text = await resp.text();
  } catch (e) {
    return errResponse(502, "upstream_read_failed", (e && e.message) || "read failed");
  }
  // 兜底：Content-Length 可能缺失或撒谎，按 UTF-16 码元再粗判一次
  if (text.length > MAX_PLAYLIST_BYTES) {
    return errResponse(502, "playlist_too_large", `read ${text.length} chars at ${redact(finalUrl)}`);
  }

  // 上游返回挑战页/HTML：明确报错，不把 HTML 当播放列表吐出去
  if (!isPlaylist(text)) {
    const kindOfFail = ct.includes("html") ? "html_challenge" : "not_a_playlist";
    return errResponse(502, kindOfFail, `upstream content-type: ${ct || "(none)"} at ${redact(finalUrl)}`);
  }

  const segments = mediaLineUrls(text, finalUrl, forceHttps);

  if (segments.length === 0) {
    return errResponse(503, "empty_playlist", "playlist has no segments", { "Retry-After": "30" });
  }

  // 僵尸流：有 #EXTM3U，但末尾分片全部明确下线（404/410/451）。
  // 5xx/403/超时属于 unknown，不判僵尸流，直接放行。
  const tBeforeProbe = Date.now() - started;
  if (probeEnabled && !(await hasLiveSegment(segments))) {
    return errResponse(
      503,
      "stale_stream",
      `tail ${Math.min(PROBE_TAIL, segments.length)} segment(s) all 404/410/451 at ${redact(finalUrl)}`,
      {
        "Retry-After": "60",
        "X-Timing": `entry=${tEntry};probe=${Date.now() - started - tBeforeProbe};total=${Date.now() - started}`,
      }
    );
  }
  const tProbe = Date.now() - started - tBeforeProbe;

  const rewritten = rewritePlaylist(text, finalUrl, forceHttps);
  const out = playlistResponse(rewritten);
  out.headers.set("X-Gateway-Cache", "MISS");
  out.headers.set(
    "X-Timing",
    `entry=${tEntry};playlist=${tBeforeProbe - tEntry};probe=${tProbe};total=${Date.now() - started}`
  );

  if (cache && cacheKey) {
    // 内部去重 5s：缓存对象必须留 max-age（Cache API 的存活时间取自它），
    // 但这份头只在缓存层内有效，回客户端时会被换回 no-store。
    const cached = new Response(out.clone().body, {
      status: out.status,
      headers: new Headers(out.headers),
    });
    cached.headers.set("Cache-Control", `public, max-age=${PLAYLIST_CACHE_TTL_SEC}`);
    cached.headers.delete("CDN-Cache-Control");
    cached.headers.set("X-Cached-At", String(Date.now()));
    const put = cache.put(cacheKey, cached).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
    else await put;
  }

  log(env, {
    evt: "req",
    id: m && m[1],
    status: out.status,
    cache: "MISS",
    segs: segments.length,
    probe: probeEnabled ? 1 : 0,
    ms: Date.now() - started,
  });

  return out;
}

function log(env, fields) {
  if (env && env.LOG === "0") return;
  try {
    console.log(JSON.stringify(fields));
  } catch {
    // 日志失败不影响响应
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      log(env, { evt: "fatal", err: (e && e.name) || "Error", msg: redactText((e && e.message) || "") });
      return errResponse(500, "internal_error", `${(e && e.name) || "Error"}: ${(e && e.message) || ""}`);
    }
  },
};
