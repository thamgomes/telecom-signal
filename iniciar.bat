@echo off
title Telecom Signal — Servidor local
color 0B

echo.
echo  ================================================
echo   TELECOM SIGNAL — Iniciando servidor proxy...
echo  ================================================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRO] Node.js nao encontrado.
    echo  Instale em: https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo  Instalando dependencias pela primeira vez...
    echo.
    npm install
    echo.
)

echo  Servidor iniciando em http://localhost:3001
echo  Pressione Ctrl+C para encerrar.
echo.

node server.js
pause
