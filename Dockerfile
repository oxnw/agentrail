FROM node:20-alpine

WORKDIR /app

COPY sdk/typescript/package.json sdk/typescript/package-lock.json ./sdk/typescript/
RUN npm --prefix sdk/typescript ci

COPY . .
RUN npm --prefix sdk/typescript run build

ENV AGENTRAIL_HOST=0.0.0.0
ENV AGENTRAIL_PUBLIC_BASE_URL=http://127.0.0.1:3000

CMD ["npm", "start"]
