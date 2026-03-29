FROM cgr.dev/chainguard/node:latest-dev
WORKDIR /app

# Copy dependency files first
COPY package*.json ./

# Install dependencies with lockfile fidelity for reproducible builds.
RUN npm ci

# Copy the rest of the app
COPY public ./public
COPY src ./src

EXPOSE 3000
CMD ["npm", "start"]
