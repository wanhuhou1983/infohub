FROM python:3.12-slim

# 境外 deb.debian.org / pypi.org 在国内云服务器常卡死，统一切到腾讯云镜像源。
RUN set -eux; \
    for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do \
      if [ -f "$f" ]; then \
        sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g; s|security.debian.org|mirrors.cloud.tencent.com|g' "$f"; \
      fi; \
    done

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2t64 libatspi2.0-0 libx11-6 libxfixes3 \
    libwayland-client0 libwayland-server0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Chromium 走 npmmirror 国内镜像；去掉 install-deps（第一层 apt 已装齐常用依赖，
# 再跑一次 apt 会显著拖慢构建）。
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
RUN pip install --no-cache-dir -i https://mirrors.cloud.tencent.com/pypi/simple \
      playwright beautifulsoup4 requests \
    && python3 -m playwright install chromium

WORKDIR /app
COPY wechat_server.py /app/
COPY requirements.txt /app/
RUN pip install --no-cache-dir -i https://mirrors.cloud.tencent.com/pypi/simple -r requirements.txt

EXPOSE 8978
CMD ["python3", "/app/wechat_server.py"]
