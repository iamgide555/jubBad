# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /repo
COPY engines ./engines
COPY web ./web
WORKDIR /repo/web
RUN npm ci
RUN npm run build

FROM nginx:alpine AS runtime
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/web/dist/web/browser /usr/share/nginx/html
EXPOSE 80
