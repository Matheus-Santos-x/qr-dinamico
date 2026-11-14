# versão fixa do Node: o serviço não muda sozinho a cada deploy
FROM node:22.20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/qr.db TZ=America/Sao_Paulo
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/saude || exit 1
# lê o .env se ele existir; as variáveis do EasyPanel também funcionam
CMD ["node", "--no-warnings", "--env-file-if-exists=.env", "server.js"]
