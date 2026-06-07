FROM node:20-slim

# Install FFmpeg and fonts
RUN apt-get update && apt-get install -y \
  ffmpeg \
  fonts-dejavu-core \
  fonts-liberation \
  fontconfig \
  && fc-cache -f -v \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
