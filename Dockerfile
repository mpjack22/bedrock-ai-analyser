FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
EXPOSE 3000
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/web/server.ts"]
