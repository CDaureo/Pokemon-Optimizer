@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto_export_and_open.ps1"
if errorlevel 1 (
  echo.
  echo No se pudo abrir el optimizador automaticamente.
  pause
)
