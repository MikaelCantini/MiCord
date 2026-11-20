FROM node:lts-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY ./gestao ./gestao

EXPOSE 3000
CMD ["npm", "start"]