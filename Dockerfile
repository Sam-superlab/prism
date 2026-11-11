FROM node:24-bookworm-slim AS base
RUN npm install --global pnpm@11.25.0
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter @prism/api... --filter @prism/worker... --filter @prism/web...
RUN pnpm --filter @prism/core typecheck && pnpm --filter @prism/api build && pnpm --filter @prism/worker build && pnpm --filter @prism/web build

FROM base AS runtime
COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/database ./database
COPY --from=build --chown=node:node /app/docs ./docs
# Install a clean production graph; source-exporting server packages use their declared tsx runtime.
RUN find apps packages -name node_modules -type d -prune -exec rm -rf '{}' + \
    && pnpm install --prod --frozen-lockfile --filter @prism/api... --filter @prism/worker... --filter @prism/web... \
    && mkdir -p /app/.data && chmod 700 /app/.data && chown -R node:node /app
ENV NODE_ENV=production PRISM_DATA_DIR=/app/.data
USER node

FROM runtime AS api
WORKDIR /app/apps/api
EXPOSE 4000
ENV PRISM_HOST=0.0.0.0
CMD ["node", "--import", "tsx", "src/server.ts"]

FROM runtime AS worker
WORKDIR /app/apps/worker
CMD ["node", "--import", "tsx", "src/main.ts"]

FROM runtime AS web
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
