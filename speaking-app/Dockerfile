FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8090
EXPOSE 8090

CMD ["node", "server.js"]
