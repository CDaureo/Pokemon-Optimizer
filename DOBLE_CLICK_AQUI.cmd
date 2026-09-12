@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto_export_and_open.ps1"
if errorlevel 1 (
  echo.
  echo No se pudo abrir el optimizador automaticamente.
  echo No ejecutes auto_export_and_open.ps1 directamente; usa este archivo .cmd.
  pause
)
