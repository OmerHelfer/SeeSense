FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for OpenCV
# Note: libgl1 replaces libgl1-mesa-glx (renamed in Debian trixie)
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first (better caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy project files
COPY . .

EXPOSE 8000

# Bind to an injected $PORT if the host provides one (falls back to 8000).
# Shell form so ${PORT} is expanded at runtime.
# --timeout-keep-alive 75: uvicorn's default is 5s, which is EXACTLY the client's
# health-ping interval. Every ping then raced the server's idle timeout, and the
# loser paid a full TCP+TLS handshake — 4 round trips instead of 1, measured as
# 82ms -> 330ms. 75s is 15x the ping gap, so no amount of jitter can lose that race.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-keep-alive 75"]