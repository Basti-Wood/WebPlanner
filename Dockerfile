# ---- build stage: install deps + compile Tailwind CSS ----
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build:css

# ---- runtime stage: small, no build tools ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/views ./views
COPY --from=build /app/src ./src
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
