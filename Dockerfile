FROM node:20-alpine

WORKDIR /app

# 先复制依赖清单，利用 Docker 分层缓存完成依赖安装
COPY package.json ./
RUN npm install --omit=dev

# 复制应用源码
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
