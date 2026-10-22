@echo off
chcp 65001 >nul
title Cordis - Servidor Online + Banco SQL
cd /d "%~dp0"
if not exist "node_modules\ws" (
  echo Instalando dependencias pela primeira vez...
  call npm install
)
node online.js
pause
