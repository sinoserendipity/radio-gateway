---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 7bbacff6a13d1c14f228fc219ab631a5_2a5ccdeadbf211f19232525400248c00
    ReservedCode1: CuygLkURJt1WbBoUCc3CRRtrXByMMwnjevYtEv8TcklEqys+uA3a4Ed+OTbr8/rUpve4cnZyccDJerodJwv4yONW4kDXGh0m4TumN/Fj858TFoyZkhN8UTo4FQmFreyCztT+PQQ1YEVhK6oQ+loudTaZlRS8S82uIqYBIy9Mv5doa7aWOWk4/wsVifU=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 7bbacff6a13d1c14f228fc219ab631a5_2a5ccdeadbf211f19232525400248c00
    ReservedCode2: CuygLkURJt1WbBoUCc3CRRtrXByMMwnjevYtEv8TcklEqys+uA3a4Ed+OTbr8/rUpve4cnZyccDJerodJwv4yONW4kDXGh0m4TumN/Fj858TFoyZkhN8UTo4FQmFreyCztT+PQQ1YEVhK6oQ+loudTaZlRS8S82uIqYBIy9Mv5doa7aWOWk4/wsVifU=
---

# radio-gateway

把 `https://radio.0472.org/?id=xxx` 这类"302 到 HLS 但 URL 不带 `.m3u8` 后缀"
的链接，转换成 Lyrion Music Server（LMS）PlayHLS 能识别的标准 HLS 地址。

## 为什么需要它

| 环节 | 现象 | 后果 |
| --- | --- | --- |
| 上游 | `?id=xxx` 302 到真实 m3u8，落地 URL 无 `.m3u8` 后缀，Content-Type 为 `application/octet-stream` | PlayHLS 靠后缀识别 HLS，判不出来 |
| 通用 CORS 代理 | 只转发首个 m3u8 文本，不重写分片相对路径 | 分片请求落到代理域名根，返回 HTML，播放失败 |
| 本网关 | 跟随 302 + 补 `application/vnd.apple.mpegurl` + 重写分片路径并代拉 | 正常出声 |

## 路由

| 路径 | 作用 |
| --- | --- |
| `GET /r/<id>.m3u8` | 返回重写后的播放列表 |
| `GET /r/<id>/seg/<b64url>` | 代拉真实分片（TS / fMP4 / AAC） |
| `GET /health` | 健康检查，返回 `radio-gateway OK` |

## 构建（GitHub Actions 自动出镜像）

推送到 `main` 分支或打 `v*` 标签，`.github/workflows/build.yml` 会用 buildx
构建 `linux/amd64` + `linux/arm64` 双架构镜像并推送到 GitHub Container Registry：

```
ghcr.io/<你的GitHub用户名小写>/radio-gateway:latest
ghcr.io/<你的GitHub用户名小写>/radio-gateway:sha-xxxxxxx
ghcr.io/<你的GitHub用户名小写>/radio-gateway:v1.0.0
```

首次推送后，到 GitHub 仓库 → Packages → `radio-gateway` → Package settings，
把可见性设为 **Public**，否则 NAS 拉取需要 `docker login ghcr.io`。

无凭据的 NAS 想直接拉公开镜像，下面的步骤即可。

## 部署到 NAS

1. 把 `docker-compose.yml` 里的 `GHCR_OWNER` 换成你的 GitHub 用户名（小写）。
2. 把 `docker-compose.yml` 传到 NAS，例如 `/volume1/docker/radio-gateway/`。
3. 在 NAS 上执行：

```bash
cd /volume1/docker/radio-gateway
docker compose up -d
docker compose logs -f
```

4. 验证：

```bash
curl -I http://127.0.0.1:8787/health
curl -I http://192.168.1.1:8787/r/1308.m3u8
```

第二条应返回 `HTTP/1.1 200 OK` 和 `Content-Type: application/vnd.apple.mpegurl`。

5. `restart: unless-stopped` 保证 NAS 重启后自动上线，Windows 开机与否无关。

## 收藏夹地址要跟着改

镜像跑在 NAS 上后，收藏夹里的地址前缀从 `192.168.1.102:8787` 换成
`192.168.1.1:8787`。两种改法：

- 在 LMS Web UI 里逐条编辑（59 条不现实）；
- 或者直接替换 `favorites.opml` 里的 IP 后放回
  `/usr/local/slimserver/prefs/`，重启 LMS 容器。

```bash
sed -i 's/192\.168\.1\.102:8787/192.168.1.1:8787/g' favorites.opml
```

### 备选：NAS 拉不到 ghcr.io 时本地构建

国内访问 ghcr.io 常被限速或阻断。此时把本目录（含 `Dockerfile`、`gateway.py`）
整个传到 NAS，直接在 NAS 上构建，效果与 Actions 产出的镜像一致：

```bash
cd /volume1/docker/radio-gateway
docker build -t radio-gateway:latest .
docker rm -f radio-gateway 2>/dev/null
docker run -d --name radio-gateway --restart unless-stopped \
  -p 8787:8787 -e TZ=Asia/Shanghai radio-gateway:latest
```

## 本地无 Docker 时验证

```bash
python gateway.py
curl -i http://127.0.0.1:8787/r/1308.m3u8
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `BIND` | `0.0.0.0` | 监听地址 |
| `PROXY_HOST` | `radio.0472.org` | 上游代理域名 |
| `UA` | `VLC/3.0.20 LibVLC/3.0.20` | 请求上游的 User-Agent |
| `UPSTREAM_TIMEOUT` | `20` | 上游超时（秒） |
| `UPSTREAM_RETRIES` | `2` | 分片拉取重试次数 |
*（内容由AI生成，仅供参考）*
