@echo off
title SLCL Launcher
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [SLCL] First run: installing dependencies, please wait...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo [SLCL] Dependency install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

if not exist "out\main\index.js" (
  echo [SLCL] Building launcher...
  call npm.cmd run build
  if errorlevel 1 (
    echo.
    echo [SLCL] Build failed.
    pause
    exit /b 1
  )
)

rem Use a relative "." path: "%~dp0" ends with a backslash and breaks quoting.
start "" "node_modules\electron\dist\electron.exe" "."
exit /b 0
