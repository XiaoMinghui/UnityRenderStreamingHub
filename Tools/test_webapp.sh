#!/bin/bash -eu

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../WebApp"
npm install --legacy-peer-deps
npm run lint
npm run test
npm run dev -- -p 8080 &
sleep 5
npm run newman -- -e ./test/env_macos.postman_environment.json
