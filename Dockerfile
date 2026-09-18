# Stage 1: install, generate Prisma client, and compile TypeScript.
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: copy only the production runtime and run without root privileges.
FROM node:22-alpine AS runner

WORKDIR /usr/src/app

RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=5000

RUN addgroup -g 1001 -S nodejs \
    && adduser -u 1001 -S nodeuser

COPY --chown=nodeuser:nodejs package*.json ./
COPY --chown=nodeuser:nodejs --from=builder /usr/src/app/node_modules ./node_modules
COPY --chown=nodeuser:nodejs --from=builder /usr/src/app/dist ./dist
COPY --chown=nodeuser:nodejs --from=builder /usr/src/app/prisma ./prisma

USER nodeuser

EXPOSE 5000

CMD ["node", "dist/server.js"]
