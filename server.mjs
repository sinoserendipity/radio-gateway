/**
 * Node 适配层 —— 让 Cloudflare Worker 版 worker_radio_gateway.js v3.0.0
 * 原样跑在 Node HTTP 服务器里（Docker 容器内）。
 *
 * 为什么不需要改 Worker 源码：
 *   v3.0.0 对 Workers 运行时的依赖只有 fetch / Request / Response / Headers /
 *   AbortSignal.timeout / TextEncoder / URL，这些 Node 18+ 全部原生具备；
 *   caches.default 与 ctx.waitUntil 在源码中已做存在性判断（cacheStore() 返回 null
 *   即自动退回纯内存缓存），env 仅读取可选的 env.FORCE_HTTPS。
 *   所以这里只做 HTTP 语义转换，不触碰业务逻辑。
 */

import http from "node:http";
import worker from "./worker_radio_gateway.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

// 对应 Workers 的 env 绑定，仅 FORCE_HTTPS 一项可选
const env = { FORCE_HTTPS: process.env.FORCE_HTTPS || undefined };

// 对应 Workers 的 ExecutionContext；容器内单进程，waitUntil 直接吞掉即可
const ctx = {
  waitUntil(p) {
    if (p && typeof p.catch === "function") p.catch(() => {});
  },
  passThroughOnException() {},
};

function toRequest(req) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, String(v));
  }

  const isBodyless = req.method === "GET" || req.method === "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    ...(isBodyless ? {} : { body: req, duplex: "half" }),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const response = await worker.fetch(toRequest(req), env, ctx);

    res.statusCode = response.status;
    for (const [k, v] of response.headers) {
      const key = k.toLowerCase();
      // content-length / transfer-encoding 交给 Node 重算，避免 body 长度不符
      if (key === "content-length" || key === "transfer-encoding") continue;
      res.setHeader(k, v);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(buf);
    }
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({ error: "adapter_error", detail: String((e && e.message) || e) }) + "\n"
    );
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 30000;

server.listen(PORT, HOST, () => {
  console.log(`[radio-gateway] v3 listening on http://${HOST}:${PORT} (FORCE_HTTPS=${env.FORCE_HTTPS || "0"})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[radio-gateway] ${sig} received, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
