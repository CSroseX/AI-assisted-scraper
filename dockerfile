# Pinned by version and digest so a rebuild can't change the image underneath us.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
RUN chown node:node /app
USER node

# Copy dependency files first
COPY --chown=node:node package*.json ./

# Install dependencies with lockfile fidelity for reproducible builds.
RUN npm ci

# Copy the rest of the app
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src

EXPOSE 3000
ENTRYPOINT ["npm", "start"]
