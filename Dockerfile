FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/qr.db
RUN mkdir -p /data
EXPOSE 3000
# lê o .env se ele existir; as variáveis do EasyPanel também funcionam
CMD ["node", "--no-warnings", "--env-file-if-exists=.env", "server.js"]
