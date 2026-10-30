FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY cloudflare/package.json cloudflare/
# Only the Node.js server and the client; the Cloudflare backend (and workerd) isn't needed here.
RUN npm ci --workspace client --workspace server --include-workspace-root
COPY . .
RUN npm run build && npm prune --omit=dev --workspace client --workspace server --include-workspace-root

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 SQLITE_PATH=/data/codehere.db
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server/dist/index.js"]
