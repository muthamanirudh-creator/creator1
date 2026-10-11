FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=optional
COPY . .
RUN npx prisma generate --schema=campus/backend/prisma/schema.prisma
EXPOSE 3000
CMD ["npm","start"]
