@echo off
title Plotter Studio
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Nao achei o Node.js neste computador.
  echo  Instale em https://nodejs.org ^(versao LTS^) e de dois cliques aqui de novo.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo.
  echo  Primeira vez: instalando as pecas do programa. Leva um ou dois minutos...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  A instalacao falhou. Confira a internet e tente de novo.
    pause
    exit /b 1
  )
)
echo.
echo  ============================================================
echo   PLOTTER STUDIO
echo.
echo   O navegador vai abrir sozinho em alguns segundos.
echo   Use o Chrome ou o Edge ^(o envio para a maquina so existe neles^).
echo.
echo   DEIXE ESTA JANELA ABERTA enquanto estiver usando.
echo   Para encerrar: feche esta janela.
echo  ============================================================
echo.
call npm run dev -- --open "/"
echo.
echo  O Plotter Studio parou. Se apareceu um erro acima, copie o texto e mostre para quem cuida do programa.
pause