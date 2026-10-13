# Pinned by version and digest so a rebuild can't change the image underneath us.
FROM node:26.11.1-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
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
