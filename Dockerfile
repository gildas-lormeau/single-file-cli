FROM zenika/alpine-chrome:with-node

RUN npm install --omit=dev single-file-cli

WORKDIR /usr/src/app

ENTRYPOINT [ \
    "npx", \
    "single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./out/", \
    "--dump-content" ]