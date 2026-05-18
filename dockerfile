# syntax=docker/dockerfile:1

FROM node:24-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app ./

USER node

EXPOSE 8080

CMD ["node", "index.js"]