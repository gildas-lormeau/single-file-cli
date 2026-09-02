#!/usr/bin/env bash

set -e

version="${1:-$(npm view single-file-core version)}"
sed -i.bak "s#^CORE_PACKAGE=\"npm:single-file-core@.*\"#CORE_PACKAGE=\"npm:single-file-core@$version\"#" build.sh
rm build.sh.bak
bash build.sh
echo "single-file-core $version"
