@echo off
rem AIRI desktop launcher that rebuilds first: use this after pulling or
rem changing source code, so the desktop shortcut never runs a stale build.
rem Daily quick launches can keep using the plain AIRI shortcut.
rem Both values must stay in sync: the server channel port (set at runtime for
rem the app, dodges the 6121 ENOTSUP bind failure) and the renderer-side
rem server-channel URL (baked in at build time).
cd /d "%~dp0"
set "SERVER_CHANNEL_PORT=6221"
set "VITE_AIRI_WS_URL=ws://127.0.0.1:6221/ws"
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
