/**
 * radio.cn HLS 网关 — Cloudflare Worker 版
 *
 * 用途：把 radio.0472.org/?id=<id>（302 → radio.cn 带 key+time 签名的 m3u8）
 *      暴露成 https://<你的域名>/r/<id>.m3u8，供 Lyrion Music Server + PlayHLS 播放。
 *
 * 与 NAS 上 radio-gateway 的差异：
 *   - 本 Worker 只代理 m3u8 列表（几 KB），把所有分片地址重写成绝对 URL，
 *     分片由播放器直连 CDN 拉取。实测 ytcast2.radio.cn 的 .ts 分片无需签名，
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
 */

const UPSTREAM_UA = "VLC/3.0.20 LibVLC/3.0.20";
const HLS_MIME = "application/vnd.apple.mpegurl";

const UPSTREAM_HEADERS = {
  "User-Agent": UPSTREAM_UA,
  "Accept": "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

function isPlaylist(text) {
  return text.trimStart().startsWith("#EXTM3U");
}

function rewritePlaylist(text, baseUrl) {
  const proto = new URL(baseUrl).protocol;
  const baseDir = baseUrl.slice(0, baseUrl.lastIndexOf("/") + 1);

  return text
    .split("\n")
    .map((line) => {
      const raw = line.trim();
      if (!raw || raw.startsWith("#")) return line;

      // 已是绝对地址
      if (/^https?:\/\//i.test(raw)) return raw;

      // 协议相对地址 //host/path
      if (raw.startsWith("//")) return proto + raw;

      // 相对分片名，按上游目录拼接
      const abs = baseDir + raw;
      try {
        return new URL(abs).toString();
      } catch {
        return abs;
      }
    })
    .join("\n");
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname;

    // ---------------- 路由 ----------------
    let upstream = null;

    // 主路由：/r/<id>.m3u8  —— PlayHLS 能识别这种后缀
    const m = path.match(/^\/r\/(\d+)\.m3u8$/);
    if (m) {
      upstream = `https://radio.0472.org/?id=${m[1]}`;
    }

    // 兼容路由：/?url=<encoded>  —— 手动调试用，LMS 里不要用（无 .m3u8 后缀）
    if (!upstream) {
      const u = reqUrl.searchParams.get("url");
      if (u) upstream = u;
    }

    // 健康检查
    if (path === "/health") {
      return textResponse("ok");
    }

    if (!upstream) {
      return textResponse(
        "usage:\n  GET /r/<id>.m3u8      (LMS 收藏夹用这个)\n  GET /?url=<m3u8 url>  (仅调试用)\n  GET /health",
        400
      );
    }

    // ---------------- 拉上游 ----------------
    let resp;
    try {
      resp = await fetch(upstream, {
        headers: UPSTREAM_HEADERS,
        redirect: "follow", // 跟随 302 到 radio.cn 的签名地址
      });
    } catch (e) {
      return textResponse(`upstream fetch failed: ${e.message}`, 502);
    }

    if (!resp.ok) {
      return textResponse(`upstream ${resp.status} ${resp.statusText} for ${upstream}`, 502);
    }

    const text = await resp.text();

    // 上游若返回挑战页/HTML，说明 UA 被拦，明确报错而不是把 HTML 当播放列表吐出去
    if (!isPlaylist(text)) {
      return textResponse(
        `upstream did not return an m3u8 playlist (content-type: ${resp.headers.get("Content-Type")})\n` +
          `url: ${resp.url}\n` +
          `head: ${text.slice(0, 200)}`,
        502
      );
    }

    const finalUrl = resp.url || upstream;
    const rewritten = rewritePlaylist(text, finalUrl);

    return new Response(rewritten, {
      status: 200,
      headers: {
        "Content-Type": HLS_MIME,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
