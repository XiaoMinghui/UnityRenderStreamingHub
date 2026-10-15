#!/bin/bash -eu

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../WebApp/client"
npm install
npm run lint
npm run test
