@echo off
chcp 65001 >nul
title Disparo
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale o Node.js 24 ou mais recente em https://nodejs.org/ e tente de novo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo O Disparo precisa do Node.js 24 ou mais recente. Versao instalada:
  node -v
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias ^(somente na primeira vez^)...
  call npm install
  if errorlevel 1 (
    echo Falha ao instalar as dependencias.
    pause
    exit /b 1
  )
)

if not exist dist\web\index.html (
  echo Compilando o painel ^(somente na primeira vez^)...
  call npm run build:web
  if errorlevel 1 (
    echo Falha ao compilar o painel.
    pause
    exit /b 1
  )
)

echo.
echo Disparo iniciando em http://127.0.0.1:3333
echo Para encerrar, feche esta janela.
echo.
start "" http://127.0.0.1:3333
call npm start
pause
