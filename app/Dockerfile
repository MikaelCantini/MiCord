FROM node:24-alpine

WORKDIR /workspace/app

# Instala apenas dependências de produção do Chat App
COPY app/package*.json ./
RUN npm ci --omit=dev

# Copia código do Chat App e inicializador mínimo do banco SQLite
COPY app/ ./
COPY gestao/database/schema.sql /workspace/gestao/database/schema.sql
COPY gestao/database/initDb.js /workspace/gestao/database/initDb.js

# Garante que os diretórios de dados e uploads existam
RUN mkdir -p /data /uploads

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/app.db
ENV UPLOAD_DIR=/uploads
ENV NODE_PATH=/workspace/app/node_modules

EXPOSE 3000

CMD ["node", "server.js"]
