FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Copy dependency files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the app
COPY public ./public
COPY src ./src

EXPOSE 3000
CMD ["npm", "start"]
