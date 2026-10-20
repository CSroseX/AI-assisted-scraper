# Pinned by version and digest so a rebuild can't change the image underneath us.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
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

# CRA inlines REACT_APP_* into the public bundle at build time, so the API
# address is a build argument. Never pass a secret this way.
ARG REACT_APP_API_BASE
ENV REACT_APP_API_BASE=$REACT_APP_API_BASE
RUN npm run build

# Only the built files ship, served by nginx as a non-root user on port 8080.
FROM nginxinc/nginx-unprivileged:1.31.6-alpine@sha256:884e0b7f42f303641b0f4e78755aea647521dca0b89ca3be7992ad78b5c07434
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 8080
