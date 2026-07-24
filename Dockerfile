FROM node:22-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

EXPOSE 3000

# prestart runs migrations, then starts the server
CMD ["npm", "start"]
