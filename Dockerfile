FROM node:18-slim

WORKDIR /app

COPY package.json ./
RUN rm -rf node_modules && npm install --production

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
