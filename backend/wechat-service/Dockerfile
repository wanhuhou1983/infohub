FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2t64 libatspi2.0-0 libx11-6 libxfixes3 \
    libwayland-client0 libwayland-server0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install playwright beautifulsoup4 requests \
    && python3 -m playwright install chromium \
    && python3 -m playwright install-deps chromium

WORKDIR /app
COPY wechat_server.py /app/
COPY requirements.txt /app/
RUN pip install -r requirements.txt

EXPOSE 8978
CMD ["python3", "/app/wechat_server.py"]
