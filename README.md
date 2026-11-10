---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 7bbacff6a13d1c14f228fc219ab631a5_2b48dd87dccd11f19280525400393706
    ReservedCode1: Zclck/4Zzv7uzRr0hu4q9CZxgVtqVBSUTdjEbcFm+5DoGWpU4V5Wv2WEWNhb7MP31JXYjiQh74kWZ1VDqqzUeUtBWJZrf7d3IN6TVVuaWOMgOLTi45ww3wc77NsaPQ1TRXwRmm6irQ7xsvh+1Oae/QPYXj92dFfmCFkhW/5Ia0+IBa/SYoaBbrTttEI=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 7bbacff6a13d1c14f228fc219ab631a5_2b48dd87dccd11f19280525400393706
    ReservedCode2: Zclck/4Zzv7uzRr0hu4q9CZxgVtqVBSUTdjEbcFm+5DoGWpU4V5Wv2WEWNhb7MP31JXYjiQh74kWZ1VDqqzUeUtBWJZrf7d3IN6TVVuaWOMgOLTi45ww3wc77NsaPQ1TRXwRmm6irQ7xsvh+1Oae/QPYXj92dFfmCFkhW/5Ia0+IBa/SYoaBbrTttEI=
---

# radio-gateway v3.0.0（Docker 部署）

把 Cloudflare Worker 版 `worker_radio_gateway.js` v3.0.0 **原封不动**跑在 Node 容器里。
业务逻辑零改动，只加了一层 HTTP 适配。

## 为什么能直接跑

| Worker 运行时能力 | v3.0.0 用法 | Node 情况 |
|---|---|---|
| `fetch` / `Request` / `Response` / `Headers` / `URL` | 全部路由与上游请求 | Node 18+ 原生 |
| `AbortSignal.timeout` | 上游超时控制 | Node 17.3+ 原生 |
| `TextEncoder` | MD5 实现 | 原生 |
| `crypto.subtle` | 未使用（自带纯 JS MD5） | 不涉及 |
| `caches.default` | 二级缓存 | **源码已判空**，缺失时退回纯内存 |
| `ctx.waitUntil` | 异步写缓存 | **源码已判函数**，无则同步跳过 |
| `env.KV / D1 / R2` | **完全不依赖** | 无绑定需求 |
| `env.FORCE_HTTPS` | 可选开关 | 由环境变量注入 |

## 文件

- `worker_radio_gateway.js` — v3.0.0 源码，未修改
- `server.mjs` — Node HTTP ↔ Web Request/Response 适配层
- `Dockerfile` — node:22-alpine，无 npm install，非 root 运行，带 HEALTHCHECK
- `docker-compose.yml` — 端口 8787，自动重启
- `.github/workflows/docker.yml` — buildx 多架构构建并推 GHCR

## 构建 / 运行

本地：

```bash
docker compose up -d --build
curl http://127.0.0.1:8787/health          # ok 3.0.0
curl http://127.0.0.1:8787/list/cnr.m3u
curl http://127.0.0.1:8787/r/639.m3u8
```

多架构构建推送：

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/sinoserendipity/radio-gateway:3.0.0 \
  -t ghcr.io/sinoserendipity/radio-gateway:latest --push .
```

## 接口

| 路由 | 说明 |
|---|---|
| `GET /health` | 健康检查，返回 `ok 3.0.0` |
| `GET /r/<contentId>.m3u8` | 单台 HLS 清单（LMS 收藏夹用） |
| `GET /list/cnr.m3u` | 央广列表（`zj` / `sh` / `all` 同理） |
| `GET /` | 用法说明 |

参数：`?https=1` 把分片升为 https（仅浏览器端需要）。

## 与 Worker 版的差异

1. **无边缘节点**：清单延迟取决于容器所在网络到 `ytmsout.radio.cn` 的链路，不再有 CF 边缘就近。
2. **缓存只在进程内**：Cache API 缺失，容器重启后首次请求需回源一次（约 1~2s），之后内存命中。
3. **单点**：容器挂了就没了。同一局域网内有多个消费端时，本地部署反而比公网 CF 少一跳。

LMS 收藏夹里的 `${origin}/r/<id>.m3u8` 由 `/list/*.m3u` 动态生成，**改成容器地址后需重新导出 OPML**；
若仍用 `https://hls.571998.xyz` 则无需任何改动。
*（内容由AI生成，仅供参考）*
