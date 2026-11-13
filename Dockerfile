# zeus: el back de roz (API + MCP + planificador + gateway de Discord) en UN proceso.
# Railway detecta este Dockerfile solo. Contexto de construcción: la raíz del repo.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production ROZ_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
ENV PORT=8080
# Railway manda SIGTERM al redesplegar: zeus deja de aceptar tráfico, termina los jobs en curso,
# cierra el gateway de Discord limpio y sale.
CMD ["node", "dist/index.js"]
