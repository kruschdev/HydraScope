FROM node:22-bookworm-slim
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /workspace/projects/krusch-cascade-router
COPY --from=krusch_cascade_router package.json ./
COPY --from=krusch_cascade_router dist ./dist
WORKDIR /workspace/lib
COPY --from=krusch_toolkit package*.json ./
RUN npm install --omit=dev
COPY --from=krusch_toolkit . ./
WORKDIR /workspace/projects/hydrascope
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 4190
CMD ["node", "src/server.js"]
