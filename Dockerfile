FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY assets/public ./assets/public
COPY assets/richmenu-src/fonts ./assets/richmenu-src/fonts
COPY web ./web

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
