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

# Bind to Railway's injected $PORT (falls back to 8000 for local runs).
# Shell form so ${PORT} is expanded at runtime.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]