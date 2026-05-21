FROM docker.io/zenika/alpine-chrome:with-node

RUN npm install --omit=dev single-file-cli@2.0.75

WORKDIR /usr/src/app

ENTRYPOINT [ \
    "npx", \
    "single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./out/", \
    "--dump-content" ]