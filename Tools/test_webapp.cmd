@echo off

cd /d "%~dp0..\WebApp" || exit /b 1
call npm install --legacy-peer-deps
call npm run lint
call npm run test
start npm run dev -- -p 8080
ping -n 10 127.0.0.1 >NUL
call npm run newman
