FROM python:3.13-slim
WORKDIR /app
ENV HOST=0.0.0.0 PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# Demo buyer origin from operator-server/docs/handoff.md. Railway can override it.
ENV SHOPSHOP_BUYER_REST_URL=https://rochester-tear-ensemble-float.trycloudflare.com
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py story_data.py instagram.py public_instagram.py buyer_inquiry.py avatar.py ./
COPY story.html story.css story.js recap.js turntable.js brand-corpus.json ./
COPY assets/ ./assets/
USER 10001
CMD ["python", "server.py"]
