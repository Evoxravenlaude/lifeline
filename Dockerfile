FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install -g tsx
COPY tsconfig.json ./
COPY src ./src
# Embedded DB (if DATABASE_URL is empty) lives here; mount a volume at /app/data on Railway.
RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["tsx", "src/index.ts"]
