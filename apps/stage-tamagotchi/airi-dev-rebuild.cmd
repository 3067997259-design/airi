@echo off
rem AIRI desktop launcher that rebuilds first: use this after pulling or
rem changing source code, so the desktop shortcut never runs a stale build.
rem Daily quick launches can keep using the plain AIRI shortcut.
cd /d "%~dp0"
echo Building stage-tamagotchi (electron-vite build)...
call pnpm --dir "%~dp0..\.." --filter @proj-airi/stage-tamagotchi build
if errorlevel 1 (
  echo Build failed - see output above.
  pause
  exit /b 1
)
set "ELECTRON_EXE="
for /d %%D in ("%~dp0..\node_modules\.pnpm\electron@*") do if exist "%%~fD\dist\electron.exe" set "ELECTRON_EXE=%%~fD\dist\electron.exe"
if defined ELECTRON_EXE (
  start "AIRI" "%ELECTRON_EXE%" "%~dp0"
  exit /b 0
)
echo electron.exe not found - run pnpm install first
pause
