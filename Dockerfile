FROM node:24-alpine

ARG VERSION=latest

RUN apk add --no-cache chromium ttf-freefont font-noto-emoji

USER node

WORKDIR /usr/src/app

RUN npm install --omit=dev single-file-cli@${VERSION}

ENTRYPOINT [ \
    "npx", \
    "single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./out/", \
    "--dump-content" ]
