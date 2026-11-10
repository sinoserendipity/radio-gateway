# radio.cn HLS 网关 v3.0.0 —— Cloudflare Worker 源码原样跑在 Node 里
# 纯 JS 无原生依赖，buildx 直接出 linux/amd64 + linux/arm64（NAS / 树莓派 / x86 服务器通用）

FROM node:22-alpine

WORKDIR /app

# 无第三方依赖，不需要 npm install
COPY package.json server.mjs worker_radio_gateway.js ./

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    TZ=Asia/Shanghai

EXPOSE 8787

# 降权运行：/app 由 root 创建，node 用户只需读权限
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
