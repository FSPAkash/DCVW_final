FROM node:20-bullseye-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        poppler-utils \
        tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY --from=frontend-build /app/frontend/build ./frontend/build

RUN pip install --no-cache-dir -r backend/requirements.txt

EXPOSE 10000

CMD ["sh", "-c", "cd /app/backend && gunicorn app:app --bind 0.0.0.0:${PORT:-10000}"]
