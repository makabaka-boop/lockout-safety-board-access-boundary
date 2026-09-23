# ---- 构建前端 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---- 运行镜像（含已构建静态页面，API 直接托管） ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY --from=build /app/dist ./dist
# 启动时自动等待数据库、迁移、播种、监听
EXPOSE 4101
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/server/server.ts"]
