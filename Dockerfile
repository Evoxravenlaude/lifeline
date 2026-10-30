FROM node:22-slim
# ffmpeg turns spoken replies into Telegram voice notes (OGG/Opus).
# DejaVu gives the incident-log PDF Cyrillic, Greek, Arabic and more beyond the cards' Latin fonts.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install -g tsx
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY assets ./assets
COPY docs ./docs
# Embedded DB (if DATABASE_URL is empty) lives here; mount a volume at /app/data on Railway.
RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["tsx", "src/index.ts"]
