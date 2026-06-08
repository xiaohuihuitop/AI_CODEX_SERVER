FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY cloud-server.js ./
COPY public ./public
COPY src ./src

EXPOSE 8787
CMD ["node", "cloud-server.js"]
