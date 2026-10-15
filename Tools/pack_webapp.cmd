@echo off

cd /d "%~dp0..\WebApp" || exit /b 1
call npm install --legacy-peer-deps
call npm run build
call npm run pack
cd ..\
mkdir WebApp\bin~
move WebApp\webserver.exe WebApp\bin~
