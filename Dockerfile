FROM zenika/alpine-chrome:with-node

RUN npm install --omit=dev single-file-cli

WORKDIR /usr/src/app/node_modules/single-file-cli

ENTRYPOINT [ \
    "node", \
    "./single-file", \
    "--browser-executable-path", "/usr/bin/chromium-browser", \
    "--output-directory", "./../../out/", \
    "--dump-content" ]