/**
 * radio.cn HLS 网关 v3.0.0 — 云听自签 · 三地区（央广 / 浙江 / 上海）
 *
 * 设计参照 gitee.com/lx_studio/LX-FM-PC 的 backend/dedicated.py：
 *   - 接口   https://ytmsout.radio.cn/web/appBroadcast/list?categoryId=&provinceCode=
 *   - 密钥   SIGN_KEY = f0fc4c668392f9f9a447e48584c214ee
 *   - 头     equipmentId: 0000 / platformCode: WEB / sign / timestamp
 *   - 签名   MD5(按字段名升序拼接的参数串 + "&timestamp=" + ts + "&key=" + SIGN_KEY).upper()
 *   - 选流   mp3PlayUrlHigh(高品质专线) > playUrlLow(极速) > mp3PlayUrlLow(标准)
 *
 * 与 v2.x 的根本区别：
 *   v2.x 是 radio.0472.org 的壳层代理（每次多一跳 302 换签，中位 3.2s / 最差 6.6s）。
 *   v3.0.0 自己签名，直连云听，去掉 0472 依赖。且不再代理分片——
 *   实测云听分片本身带 Access-Control-Allow-Origin: * 与 Accept-Ranges: bytes，
 *   http/https 均可直连，任意 UA 放行，所以清单里把相对分片路径补成绝对地址即可，
 *   客户端（LMS + PlayHLS）直连分片，网关不参与媒体流量。
 *
 * 实测依据（2026-11-10，中国之声 639）：
 *   playUrlLow      ytlive  .aac  30 KB / 5s   首分片 180 ms   ← 极速
 *   mp3PlayUrlHigh  ytcast2 .ts  261 KB / 10s  首分片 868 ms   ← 192k 高音质
 *   mp3PlayUrlLow   ytcast2 .ts   68 KB / 10s  首分片 698 ms
 *   清单延迟：http ~195 ms / https ~1599 ms（分片 https 另加 ~360 ms）
 *   → 因 PlayHLS 是服务端拉流、不受混合内容限制，分片默认保持上游原协议（http），
 *     只有浏览器端播放才需要 https，届时用 ?https=1 或 FORCE_HTTPS=1。
 *
 * 路由：
 *   GET /r/<contentId>.m3u8   单台清单（LMS 收藏夹用这个）
 *   GET /list/cnr.m3u         央广三地区频道列表（cnr | zj | sh | all）
 *   GET /health               健康检查
 *   GET /                     说明
 */

const VERSION = "3.1.0";

/* ============================ 可调配置 ============================ */

const API_BASE = "https://ytmsout.radio.cn/web";
const SIGN_KEY = "f0fc4c668392f9f9a447e48584c214ee";
const CLIENT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 三地区：与 LX-FM-PC 的 PROVINCE_CODE_MAP 一致
const REGIONS = [
  { key: "cnr", name: "央广", province: 0 },
  { key: "zj", name: "浙江", province: 330000 },
  { key: "sh", name: "上海", province: 310000 },
];
const REGION_BY_PROVINCE = new Map(REGIONS.map((r) => [r.province, r]));

// 实测 categoryId=0 覆盖 94%，1 为少量专题频道；查两档以保证区域台不丢
const CATEGORY_IDS = [0, 1];

// 选流优先级 —— 与 LX-FM-PC lines 顺序一致
const STREAM_PREF = ["mp3PlayUrlHigh", "playUrlLow", "mp3PlayUrlLow"];

/*
 * 实测修正（2026-11-10，90 台全量探测）：
 *   ytcastmp3.radio.cn/xx/stream_xxxxx.mp3  → 61 台，实测 0 可达（全部 connect timeout / 404）
 *   ytcast2.radio.cn/110/radios/*.m3u8      → 18 台，全可达，p50 1233ms
 *   ytcast.radio.cn/129|/81/.../*.m3u8      → 11 台，全可达，p50 1440ms
 * 即 mp3PlayUrlHigh 字段里混着两类：一是真 HLS，二是已停用的 MP3 裸流。
 * 因此不能按字段名排序，必须**看 URL 本身是否 .m3u8**，mp3 一律降到最低优先级，
 * 否则每台要多等一个 4s 连接超时才降级（这是 v3.0.0 首测 p50 5s 的全部原因）。
 * 并对失败线路记 5 分钟黑名单，避免反复撞同一面墙。
 */
const MP3_PROBE_TIMEOUT_MS = 2000; // 兜底尝试 mp3 时用更短超时
const BAD_TTL_SEC = 300; // 故障线路冷却期

const HLS_MIME = "application/vnd.apple.mpegurl";
const API_TIMEOUT_MS = 4000; // 签名接口实测 ~1s，留足余量
const PLAYLIST_TIMEOUT_MS = 4000;
const API_TTL_SEC = 60; // 频道列表（含签名 URL）缓存时长
const URL_TTL_SEC = 45; // 单台签名 URL 缓存时长，须明显短于 key 有效期
const PLAYLIST_MEMO_SEC = 2; // 单台清单的 isolate 内去重窗口，须远小于 TARGETDURATION
const MAX_PLAYLIST_BYTES = 512 * 1024;

/* ============================ MD5 ============================ */
/* Workers 的 crypto.subtle 不支持 MD5，此处为纯 JS 实现。
   已用标准测试向量校验：""/"abc"/"The quick brown fox..." 全部通过。
   注意位运算必须用 Math.imul 语义的 |0 截断，否则超过 32 位会失真。*/

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = (() => {
  const k = new Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  return k;
})();

function md5(input) {
  const bytes = Array.from(new TextEncoder().encode(String(input)));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / Math.pow(2, 8 * i)) & 0xff);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < bytes.length; off += 64) {
    const M = new Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] =
        bytes[off + i * 4] |
        (bytes[off + i * 4 + 1] << 8) |
        (bytes[off + i * 4 + 2] << 16) |
        (bytes[off + i * 4 + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + MD5_K[i] + M[g]) | 0;
      B = (B + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const hex = (n) => {
    let s = "";
    for (let i = 0; i < 4; i++) s += ("0" + ((n >>> (i * 8)) & 0xff).toString(16)).slice(-2);
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/* ============================ 云听签名 ============================ */

function makeSign(params, ts) {
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const raw = sorted
    ? `${sorted}&timestamp=${ts}&key=${SIGN_KEY}`
    : `timestamp=${ts}&key=${SIGN_KEY}`;
  return md5(raw).toUpperCase();
}

/** 拉取某省某类的频道列表，返回原始 item 数组 */
async function fetchBroadcastList(provinceCode, categoryId) {
  const ts = String(Date.now());
  const params = { categoryId, provinceCode };
  const url = `${API_BASE}/appBroadcast/list?categoryId=${categoryId}&provinceCode=${provinceCode}`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": CLIENT_UA,
      "equipmentId": "0000",
      "platformCode": "WEB",
      "Accept": "application/json",
      "sign": makeSign(params, ts),
      "timestamp": ts,
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`list http ${resp.status}`);
  const body = await resp.json();
  if (body.code !== 0 || !Array.isArray(body.data)) {
    throw new Error(`list code ${body.code} ${body.message || ""}`.trim());
  }
  return body.data;
}

/**
 * 从 item 里收集全部候选线路，按“真 HLS 优先、字段优先级次序”排序。
 * 返回 [{ field, url, isHls }]
 */
function pickCandidates(item) {
  const list = [];
  STREAM_PREF.forEach((field, idx) => {
    const url = (item[field] || "").trim();
    if (!url) return;
    const isHls = /\.m3u8(\?|$)/i.test(url);
    list.push({ field, url, isHls, idx });
  });
  // isHls 优先，其次按 STREAM_PREF 次序
  list.sort((a, b) => (a.isHls === b.isHls ? a.idx - b.idx : a.isHls ? -1 : 1));
  return list;
}

/** 兼容旧调用：取排序后的首个 */
function pickStreamUrl(item) {
  const list = pickCandidates(item);
  return list.length ? list[0] : null;
}

/** 故障线路冷却 */
const badKey = (id, field) => `bad/${id}/${field}`;
const isBad = (id, field) => !!memGet(badKey(id, field));
function markBad(id, field) {
  memSet(badKey(id, field), 1, BAD_TTL_SEC);
}

/* ============================ 缓存 ============================ */
/* 两级：isolate 内存（微秒级，扛住 LMS 每 10s 重载清单的高频）→ Cache API（跨 isolate 持久） */

const MEM = new Map(); // key -> { v, exp }
const MEM_MAX = 400;

function memGet(key) {
  const hit = MEM.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    MEM.delete(key);
    return null;
  }
  return hit.v;
}

function memSet(key, v, ttlSec) {
  if (MEM.size > MEM_MAX) MEM.clear();
  MEM.set(key, { v, exp: Date.now() + ttlSec * 1000 });
}

function cacheStore() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

async function cacheGetJson(key) {
  const m = memGet(key);
  if (m) return m;
  const c = cacheStore();
  if (!c) return null;
  const hit = await c.match(new Request(`https://cache.internal/${key}`));
  if (!hit) return null;
  try {
    const v = await hit.json();
    memSet(key, v, 30);
    return v;
  } catch {
    return null;
  }
}

function cachePutJson(ctx, key, value, ttlSec) {
  memSet(key, value, ttlSec);
  const c = cacheStore();
  if (!c) return;
  const put = c
    .put(
      new Request(`https://cache.internal/${key}`),
      new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${ttlSec}`,
        },
      })
    )
    .catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
}

/* ============================ 频道索引 ============================ */

const indexKey = (province, cat) => `v${VERSION}/idx/${province}/${cat}`;

/**
 * 取某地区的全部频道（带缓存）。
 * 三地区总共 3 省 × 2 类 = 6 次并发请求，缓存命中后为 0 次。
 */
async function loadRegion(region, ctx, force = false) {
  const catResults = await Promise.all(
    CATEGORY_IDS.map(async (cat) => {
      const key = indexKey(region.province, cat);
      if (!force) {
        const cached = await cacheGetJson(key);
        if (cached && Array.isArray(cached.items)) return { cat, items: cached.items };
      }
      try {
        const items = await fetchBroadcastList(region.province, cat);
        cachePutJson(ctx, key, { items, at: Date.now() }, API_TTL_SEC);
        return { cat, items };
      } catch (e) {
        return { cat, items: [], error: (e && e.message) || "fetch failed" };
      }
    })
  );

  const merged = new Map();
  for (const { cat, items } of catResults) {
    for (const item of items) {
      const id = String(item.contentId || "").trim();
      const cands = pickCandidates(item);
      if (!id || cands.length === 0) continue;
      if (merged.has(id)) continue;
      merged.set(id, {
        id,
        title: (item.title || "").trim() || `频道 ${id}`,
        subtitle: (item.subtitle || "").trim(),
        image: (item.image || "").trim(),
        region: region.key,
        regionName: region.name,
        province: region.province,
        categoryId: cat,
        cands,
        // 供 m3u 生成/排障用：排第一的那条
        url: cands[0].url,
        field: cands[0].field,
      });
    }
  }
  return merged;
}

/** 单台查询：先查 URL 缓存，未命中再定位地区 */
async function resolveStation(id, ctx, force = false) {
  const sid = String(id);
  const uKey = `v${VERSION}/url/${sid}`;
  if (!force) {
    const cached = await cacheGetJson(uKey);
    if (cached && cached.url) return cached;
  }

  // 三地区索引并发载入；已缓存的地区不会发请求
  const maps = await Promise.all(REGIONS.map((r) => loadRegion(r, ctx, force)));
  for (const map of maps) {
    const st = map.get(sid);
    if (st) {
      cachePutJson(ctx, uKey, st, URL_TTL_SEC);
      return st;
    }
  }
  return null;
}

/* ============================ 播放清单重写 ============================ */

function absolutize(ref, baseUrl, forceHttps) {
  let abs = ref;
  if (!/^https?:\/\//i.test(ref)) {
    try {
      abs = new URL(ref, baseUrl).toString();
    } catch {
      return ref;
    }
  }
  if (!forceHttps) return abs;
  try {
    const u = new URL(abs);
    if (u.protocol === "http:") u.protocol = "https:";
    return u.toString();
  } catch {
    return abs;
  }
}

/**
 * 云听清单里分片全是相对路径且不带签名，直接把每行补成绝对地址。
 * 同时清掉 #EXT-X-ALLOW-CACHE，避免播放器自行缓存直播清单。
 */
function rewritePlaylist(text, baseUrl, forceHttps) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    if (raw.startsWith("#")) {
      if (/^#EXT-X-ALLOW-CACHE/i.test(raw)) continue;
      if (/URI="/i.test(raw)) {
        out.push(raw.replace(/URI="([^"]*)"/gi, (_m, uri) =>
          uri && !uri.startsWith("data:") ? `URI="${absolutize(uri, baseUrl, forceHttps)}"` : `URI="${uri}"`
        ));
      } else {
        out.push(raw);
      }
      continue;
    }
    out.push(absolutize(raw, baseUrl, forceHttps));
  }
  return out.join("\n");
}

/* ============================ HLS 序列号归一化 ============================ */
/*
 * PlayHLS 的 _parsePL 用 `if ($1 < _media_sequence_no)` 判 Broken media sequence，
 * 且只有 `chunknum > _played` 的分片才会入队（HLSPLAY.pm:363）。
 * 上游源重启时（分片时间基变化）MEDIA-SEQUENCE 会整体回退（实测 632 → 273），
 * 于是新分片全被过滤 → 队列为空 → chunkref 变 undef →
 * HLSPLAY.pm:582 `length($$chunkref)` 抛 "Can't use an undefined value as a SCALAR reference"
 * → sendStreamingResponse 异常 → 推给播放器的音频 HTTP 流中断。
 * 而 LMS 播放状态机不会切 stop，界面停在"正在播放"，实际一个字节都没输出。
 *
 * 对策：对外只暴露单调不减的 MEDIA-SEQUENCE。
 *   - 首次见到某台：用分片名里的时间基（segment<YYYYMMDDhhmmss>-<n>）算出绝对序号做基线，
 *     这样网关重启后也不会回退；
 *   - 之后只搬运上游增量（raw - lastRaw），上游回退时前进一步；
 *   - 上游未变化时保持不动，避免同一份清单被多次请求时序号虚涨。
 * 分片 URL 仍用上游真实地址，PlayHLS 不按序号推算 URL，改序号是安全的。
 */
const SEQ = new Map(); // stationId -> { raw, out }
const SEQ_MAX = 1000;

function absoluteSeq(text, targetDuration) {
  // radio.cn 分片名：segment20261113030703-00000315.ts（前 14 位＝该流实例的启动时刻）
  const m = text.match(/segment(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-(\d+)/);
  if (!m) return null;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const idx = Number(m[7]);
  if (!Number.isFinite(base) || !Number.isFinite(idx)) return null;
  // 时间基只是做单调锚点，时区偏差是常量，不影响单调性
  return Math.floor(base / (targetDuration * 1000)) + idx;
}

function normalizeSequence(id, text) {
  const mSeq = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/im);
  if (!mSeq) return { body: text, seq: null };

  const raw = Number(mSeq[1]);
  const td = Number((text.match(/^#EXT-X-TARGETDURATION:(\d+)/im) || [])[1]) || 10;
  const prev = SEQ.get(id);

  let out;
  let mode;
  if (!prev) {
    const abs = absoluteSeq(text, td);
    if (abs !== null && abs > raw) {
      out = abs;
      mode = "anchor";
    } else {
      out = raw;
      mode = "init";
    }
  } else if (raw > prev.raw) {
    out = prev.out + (raw - prev.raw);
    mode = "carry";
  } else if (raw < prev.raw) {
    out = prev.out + 1;
    mode = "reset";
  } else {
    out = prev.out;
    mode = "hold";
  }

  // 超限清空是安全的：清空后各台都走 anchor 分支，仍然单调
  if (SEQ.size > SEQ_MAX) SEQ.clear();
  SEQ.set(id, { raw, out });

  let body = text;
  if (out !== raw) {
    body = text.replace(/^#EXT-X-MEDIA-SEQUENCE:\d+\s*$/im, `#EXT-X-MEDIA-SEQUENCE:${out}`);
  }
  return { body, seq: { raw, out, mode } };
}

async function fetchPlaylist(url, forceHttps, timeoutMs = PLAYLIST_TIMEOUT_MS, seqKey = null) {
  // 直播清单必须实时，但吸收 2s 内的重复请求（< TARGETDURATION 10s，不会让播放器以为卡住）
  const memoKey = `pl:${url}:${forceHttps ? 1 : 0}`;
  const memo = memGet(memoKey);
  if (memo) return memo;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": CLIENT_UA,
      "Accept": "*/*",
      // 不要带 Range：上游支持 Range 但会返回 206 只给分片字节，清单会被截断
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`playlist http ${resp.status}`);

  const declared = Number(resp.headers.get("Content-Length") || 0);
  if (declared > MAX_PLAYLIST_BYTES) throw new Error(`playlist too large ${declared}`);

  const text = await resp.text();
  if (!text.replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U")) {
    throw new Error("not a playlist");
  }
  const base = resp.url || url;
  const rewritten = rewritePlaylist(text, base, forceHttps);
  const norm = seqKey ? normalizeSequence(seqKey, rewritten) : { body: rewritten, seq: null };
  const result = { finalUrl: base, body: norm.body, seq: norm.seq };
  memSet(memoKey, result, PLAYLIST_MEMO_SEC);
  return result;
}

/* ============================ 响应构造 ============================ */

const jsonHeaders = () => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "X-Gateway-Version": VERSION,
});

function errResponse(status, code, detail, extra = {}) {
  return new Response(JSON.stringify({ error: code, status, detail, gateway: VERSION }) + "\n", {
    status,
    headers: { ...jsonHeaders(), ...extra },
  });
}

function playlistResponse(body, extraHeaders = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": HLS_MIME,
      // 直播清单必须 no-store：CF 默认 Browser Cache TTL 会把它抬到数小时，导致卡死
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "X-Gateway-Version": VERSION,
      ...extraHeaders,
    },
  });
}

/* ============================ 主逻辑 ============================ */

async function handleRequest(request, env, ctx) {
  const started = Date.now();
  const reqUrl = new URL(request.url);
  const path = reqUrl.pathname;
  const forceHttps = reqUrl.searchParams.get("https") === "1" || (env && env.FORCE_HTTPS === "1");

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

  // ---------- 单台清单 ----------
  const m = path.match(/^\/r\/([A-Za-z0-9_-]{1,64})\.m3u8$/);
  if (m) {
    const id = m[1];

    let station = await resolveStation(id, ctx, false);
    if (!station) station = await resolveStation(id, ctx, true); // 缓存过期则强刷一次
    if (!station) {
      return errResponse(404, "not_found", `contentId ${id} 不在央广/浙江/上海目录中`);
    }

    // 按候选顺序尝试；命中黑名单的线路跳过，全部被跳过时再放开重试
    const cands = station.cands || [];
    const attempts = [];
    for (const c of cands) if (!isBad(id, c.field)) attempts.push(c);
    if (attempts.length === 0) attempts.push(...cands);

    let lastErr = "no candidate";
    for (const cand of attempts) {
      let got = null;
      try {
        got = await fetchPlaylist(
          cand.url,
          forceHttps,
          cand.isHls ? PLAYLIST_TIMEOUT_MS : MP3_PROBE_TIMEOUT_MS,
          id
        );
      } catch (e) {
        lastErr = `${cand.field}: ${(e && e.message) || "fetch failed"}`;
        markBad(id, cand.field); // 只有取流失败才算线路故障
        continue;
      }

      // 响应头一律 ASCII：中文必须 encodeURIComponent，否则 Response 构造抛 ByteString 错误
      let upstreamHost = "";
      try {
        upstreamHost = new URL(got.finalUrl).host;
      } catch {}
      return playlistResponse(got.body, {
        "X-Station": encodeURIComponent(station.title),
        "X-Region": encodeURIComponent(station.regionName || ""),
        "X-Line": cand.field,
        "X-Tried": String(attempts.length),
        "X-Upstream-Host": upstreamHost,
        "X-Timing": `total=${Date.now() - started}`,
        // 序列号归一化痕迹：raw=上游原值，out=对外值，mode=init/anchor/carry/hold/reset
        ...(got.seq
          ? { "X-Seq-Raw": String(got.seq.raw), "X-Seq-Out": String(got.seq.out), "X-Seq-Mode": got.seq.mode }
          : {}),
      });
    }

    return errResponse(502, "upstream_failed", `所有线路均失败：${lastErr}`, { "Retry-After": "10" });
  }

  // ---------- 地区频道列表 ----------
  const lm = path.match(/^\/list\/([a-z]+)\.m3u$/);
  if (lm) {
    const which = lm[1];
    const regions = which === "all" ? REGIONS : REGIONS.filter((r) => r.key === which);
    if (regions.length === 0) {
      return errResponse(404, "not_found", `未知地区 ${which}，可用：cnr / zj / sh / all`);
    }

    const origin = reqUrl.origin;
    const lines = ["#EXTM3U"];
    let count = 0;
    for (const region of regions) {
      const map = await loadRegion(region, ctx, false);
      const items = Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title, "zh"));
      if (items.length === 0) continue;
      lines.push(`\n# ${region.name}（${items.length} 台）`);
      for (const st of items) {
        lines.push(`#EXTINF:-1 group-title="${region.name}" tvg-id="${st.id}",${st.title}`);
        lines.push(`${origin}/r/${st.id}.m3u8`);
        count++;
      }
    }

    if (count === 0) return errResponse(503, "empty", "三个地区的频道列表均为空", { "Retry-After": "30" });
    return new Response(lines.join("\n") + "\n", {
      status: 200,
      headers: {
        "Content-Type": "audio/x-mpegurl; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "X-Gateway-Version": VERSION,
        "X-Station-Count": String(count),
        "X-Timing": `total=${Date.now() - started}`,
      },
    });
  }

  // ---------- 说明页 ----------
  if (path === "/") {
    const body = [
      `radio.cn HLS 网关 v${VERSION}`,
      "",
      "GET /r/<contentId>.m3u8     单台直播清单（LMS 收藏夹用）",
      "GET /list/cnr.m3u          央广频道列表（zj / sh / all 同理）",
      "GET /health                健康检查",
      "",
      "参数：?https=1 把分片强制升为 https（仅浏览器播放需要）",
    ].join("\n");
    return new Response(body + "\n", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Gateway-Version": VERSION,
      },
    });
  }

  return errResponse(400, "bad_request", "usage: /r/<id>.m3u8 | /list/cnr.m3u | /health");
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      return errResponse(500, "internal_error", `${(e && e.name) || "Error"}: ${(e && e.message) || ""}`);
    }
  },
};
