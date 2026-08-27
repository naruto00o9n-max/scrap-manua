FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json vite.config.ts components.json ./
COPY patches ./patches
RUN npm install -g corepack@latest && corepack pnpm install --frozen-lockfile
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY drizzle ./drizzle
RUN corepack pnpm run build
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
