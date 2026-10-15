@echo off

cd /d "%~dp0..\WebApp\client" || exit /b 1
call npm install
call npm run lint
call npm run test
