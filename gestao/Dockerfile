FROM node:24-alpine

WORKDIR /workspace/gestao

# Instala apenas dependências de produção do Painel de Gestão
COPY gestao/package*.json ./
RUN npm ci --omit=dev

# Copia código do Painel de Gestão
COPY gestao/ ./

# Garante que o diretório de dados exista
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/app.db

EXPOSE 3001

CMD ["node", "server.js"]
