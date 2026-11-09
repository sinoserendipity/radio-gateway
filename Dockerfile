# syntax=docker/dockerfile:1

FROM python:3.12-alpine

# ca-certificates: 上游是 https，必须校验证书
# tzdata: 让日志时间戳按本地时区显示
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 -s /sbin/nologin gw

WORKDIR /app
COPY gateway.py /app/gateway.py

ENV PORT=8787 \
    BIND=0.0.0.0 \
    TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER gw
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -T 4 -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["python", "-u", "/app/gateway.py"]
