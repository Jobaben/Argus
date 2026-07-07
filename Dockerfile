# syntax=docker/dockerfile:1

# ---- build stage: compile the server and bundle the web UI ----
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage: production deps + compiled artifacts only ----
FROM node:26-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# Argus reads Claude Code state under this path; mount the host's ~/.claude here.
ENV ARGUS_CLAUDE_HOME=/data/.claude
# Bind all interfaces inside the container; publish the port with `-p` and set
# ARGUS_TOKEN so the exposed surface is authenticated.
ENV ARGUS_HOST=0.0.0.0
EXPOSE 7777
CMD ["node", "server/dist/index.js"]
