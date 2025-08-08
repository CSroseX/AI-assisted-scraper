FROM node:18
WORKDIR /app

# Copy dependency files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the app
COPY public ./public
COPY src ./src

EXPOSE 3000
CMD ["npm", "start"]
