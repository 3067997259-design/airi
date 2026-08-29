@echo off
rem AIRI desktop launcher for the source build (stage-tamagotchi).
rem Resolves the pnpm-managed electron.exe so the shortcut survives
rem dependency version bumps; starts the app without a lingering console.
cd /d "%~dp0"
set "ELECTRON_EXE="
for /d %%D in ("%~dp0..\node_modules\.pnpm\electron@*") do if exist "%%~fD\dist\electron.exe" set "ELECTRON_EXE=%%~fD\dist\electron.exe"
if defined ELECTRON_EXE (
  start "AIRI" "%ELECTRON_EXE%" "%~dp0"
  exit /b 0
)
if exist "%~dp0node_modules\.bin\electron.CMD" (
  start "AIRI" /min "%~dp0node_modules\.bin\electron.CMD" .
  exit /b 0
)
echo electron.exe not found - run pnpm install first
pause
