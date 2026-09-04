# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json ./package.json
COPY engines ./engines
COPY server ./server
WORKDIR /repo/server
RUN npm ci
RUN npx prisma generate
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/server/node_modules ./node_modules
COPY --from=build /repo/server/dist ./dist
COPY --from=build /repo/server/prisma ./prisma
COPY --from=build /repo/server/package.json ./package.json
COPY --from=build /repo/server/prisma7.config.ts ./prisma7.config.ts
# /app/prisma must be writable by whatever PUID/PGID runs the container —
# the bind-mounted dev.db lives here, and SQLite's WAL mode (enabled in
# PrismaService.onModuleInit) creates sibling -wal/-shm files in this same
# directory at runtime. Matches weddingInvitation's identical /app 1777 fix.
RUN chmod 1777 /app/prisma
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/src/main.js"]
