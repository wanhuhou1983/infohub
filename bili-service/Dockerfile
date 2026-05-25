FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libu2f-udev \
    libvulkan1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright + Chromium
RUN pip install --no-cache-dir playwright && \
    python3 -m playwright install chromium && \
    python3 -m playwright install-deps chromium

COPY bili-server.py /app/

EXPOSE 8979

CMD ["python3", "bili-server.py"]
