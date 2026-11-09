#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
radio.0472.org -> Lyrion Music Server HLS 网关（容器版，零第三方依赖）

要解决的问题
------------
https://radio.0472.org/?id=xxx 会 302 跳转到 HLS 直播流，但落地 URL 不带
.m3u8 后缀、Content-Type 是 application/octet-stream。LMS 的 PlayHLS 插件
靠 .m3u8 后缀识别 HLS，这种地址直接填进 Tune In 放不出来。

通用 CORS 代理也不行：它们只转发第一个 m3u8 文本，不重写里面相对的分片路径，
分片请求落到代理域名根、返回 HTML 页面，于是同样无法播放。

本服务负责三件事
----------------
1. 把 ?id=xxx 映射成 http://<host>:8787/r/<id>.m3u8，自动跟随 302；
2. 用 application/vnd.apple.mpegurl 返回播放列表，让 PlayHLS 认出来；
3. 把 m3u8 内所有分片地址（相对 / 绝对）重写为网关地址并代为拉取。

路由
----
GET /r/<id>.m3u8          播放列表（已重写分片路径）
GET /r/<id>/seg/<b64url>  分片代理（TS / fMP4 / AAC）
GET /health               健康检查

环境变量
--------
PORT   监听端口，默认 8787
BIND   监听地址，默认 0.0.0.0
UA     请求上游时使用的 User-Agent
"""

import base64
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROXY_HOST = os.environ.get("PROXY_HOST", "radio.0472.org").strip()
UA = os.environ.get("UA", "VLC/3.0.20 LibVLC/3.0.20").strip()
HLS_MIME = "application/vnd.apple.mpegurl"
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "20"))
RETRIES = int(os.environ.get("UPSTREAM_RETRIES", "2"))

BASES = {}  # rid -> 上游播放列表所在目录，用于拼接相对分片名


# ------------------------------------------------------------------ 工具
def b64enc(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def b64dec(s: str) -> str:
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode("ascii")).decode("utf-8")


def http_get(url: str, timeout: float) -> bytes:
    """带上游重试的 GET，返回 body"""
    last = None
    for attempt in range(RETRIES + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Accept": "*/*"}
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < RETRIES:
                time.sleep(0.6 * (attempt + 1))
    raise last  # type: ignore[misc]


def fetch_playlist(rid: str):
    """跟随 302 拉取真实 m3u8，记录 base 目录"""
    req = urllib.request.Request(
        f"https://{PROXY_HOST}/?id={urllib.parse.quote(rid)}",
        headers={"User-Agent": UA, "Accept": "*/*"},
    )
    with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as r:
        body = r.read()
        final = r.geturl()
    base = final.rsplit("/", 1)[0] + "/"
    BASES[rid] = base
    return body.decode("utf-8", "replace"), base


def guess_seg_mime(url: str) -> str:
    p = url.split("?")[0].lower()
    if p.endswith((".m4s", ".mp4", ".cmfv", ".cmfa", ".m4v")):
        return "video/mp4"
    if p.endswith((".aac", ".m4a")):
        return "audio/aac"
    if p.endswith((".mp3",)):
        return "audio/mpeg"
    if p.endswith((".ts", ".mts")):
        return "video/mp2t"
    return "video/mp2t"


def rewrite_m3u8(text: str, rid: str) -> str:
    """把 m3u8 里的相对 / 绝对分片地址统一改写为网关地址"""
    base = BASES.get(rid, "")
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append("")
            continue
        if s.startswith("#"):
            # 处理 EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA 里的 URI="..."
            def _sub(m):
                u = m.group(1)
                if not u.startswith(("http://", "https://")):
                    u = urllib.parse.urljoin(base, u)
                return f'URI="/r/{rid}/seg/{b64enc(u)}"'

            out.append(re.sub(r'URI="([^"]+)"', _sub, s))
            continue
        u = s if s.startswith(("http://", "https://")) else urllib.parse.urljoin(base, s)
        out.append(f"/r/{rid}/seg/{b64enc(u)}")
    return "\n".join(out).rstrip("\n") + "\n"


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "radio-gateway/2.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        sys.stderr.write(
            "[%s] %s %s\n" % (self.log_date_time_string(), self.address_string(), fmt % args)
        )
        sys.stderr.flush()

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?")[0]

        # 播放列表
        m = re.match(r"^/r/(\d+)\.m3u8$", path)
        if m:
            rid = m.group(1)
            try:
                text, _base = fetch_playlist(rid)
            except Exception as e:  # noqa: BLE001
                return self._send(502, f"upstream error: {e}".encode())
            if "#EXTM3U" not in text[:400].upper():
                return self._send(502, b"upstream did not return an HLS playlist")
            return self._send(200, rewrite_m3u8(text, rid).encode(), HLS_MIME)

        # 分片
        m = re.match(r"^/r/(\d+)/seg/([A-Za-z0-9_\-]+)$", path)
        if m:
            try:
                url = b64dec(m.group(2))
            except Exception:  # noqa: BLE001
                return self._send(400, b"bad segment ref")
            try:
                data = http_get(url, 25)
            except Exception as e:  # noqa: BLE001
                return self._send(502, f"segment error: {e}".encode())
            return self._send(200, data, guess_seg_mime(url))

        if path in ("/", "/health"):
            return self._send(200, b"radio-gateway OK\n")

        return self._send(404, b"not found")


def main():
    bind = os.environ.get("BIND", "0.0.0.0")
    port = int(os.environ.get("PORT", "8787"))
    srv = ThreadingHTTPServer((bind, port), Handler)
    srv.daemon_threads = True
    print(f"radio-gateway listening on http://{bind}:{port}/  (upstream {PROXY_HOST})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("stopped", flush=True)


if __name__ == "__main__":
    main()
