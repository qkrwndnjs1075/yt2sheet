FROM node:22-bookworm-slim AS web-build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:web

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV YT2SHEET_WEB_ROOT=/app/dist-web
ENV YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates ffmpeg python3 python3-venv \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
COPY --from=web-build /app/dist-web ./dist-web
COPY --from=web-build /app/server ./server
COPY --from=web-build /app/src ./src

VOLUME ["/app/.yt2sheet-data"]
EXPOSE 8080
CMD ["npm", "run", "start:server"]
