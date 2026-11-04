FROM node:24-bookworm-slim AS build
WORKDIR /app/app-starter
COPY app-starter/package*.json app-starter/.npmrc ./
RUN npm ci
COPY app-starter/frontend ./frontend
COPY app-starter/public ./public
RUN npm run build
COPY app-starter/build-app.mjs ./
RUN node build-app.mjs
FROM node:24-bookworm-slim
WORKDIR /app/app-starter
COPY app-starter/package*.json app-starter/.npmrc ./
RUN npm ci --omit=dev
COPY app-starter/server.js app-starter/auth.js app-starter/beta-apply.mjs app-starter/payments.mjs app-starter/subscriptions.mjs app-starter/model-intake-proxy.mjs app-starter/share-view.mjs ./
COPY acres-research/wallet.mjs acres-research/execution-context.mjs /app/acres-research/
RUN node --input-type=module -e "await import('../acres-research/wallet.mjs')"
COPY --from=build /app/app-starter/public ./public
USER node
CMD ["npm","start"]
