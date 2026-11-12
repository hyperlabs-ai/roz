# Puente roz ↔ Discord. Railway construye con este Dockerfile (ver railway.json).
# Contexto de construcción: la carpeta discord-bridge/ (Root Directory del servicio en Railway).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
# Railway manda SIGTERM al redesplegar: el puente marca "disconnected" y cierra el gateway limpio.
CMD ["node", "dist/index.js"]
