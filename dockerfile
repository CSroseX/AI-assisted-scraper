# Pinned by version and digest so a rebuild can't change the image underneath us.
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
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
FROM nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 8080
