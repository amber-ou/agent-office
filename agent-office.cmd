@echo off
setlocal
rem  Agent Office — the Windows entry point.
rem
rem  Starts the office from THIS checkout's build. On first run it shows what
rem  running agents on Windows means and asks for approval once; there is no
rem  namespace to confine a run to on Windows, so that approval is the control.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not on PATH. Install Node 20 or newer, then run this again.
  pause
  exit /b 1
)

if not exist "dist\cli.js" (
  echo This checkout is not built yet. Run these two commands once, then start again:
  echo     npm ci
  echo     npm run build
  pause
  exit /b 1
)

node scripts\windows-consent.mjs --check >nul 2>&1
if errorlevel 1 (
  echo.
  node scripts\windows-consent.mjs --show
  echo.
  set /p AO_OK="Type YES to accept and continue: "
  if /i not "%AO_OK%"=="YES" (
    echo Not accepted. Agent Office will not run agents until you accept.
    pause
    exit /b 1
  )
  node scripts\windows-consent.mjs --accept
  echo.
)

echo Starting Agent Office. Open the address below in your browser.
echo Close this window to stop it.
echo.
node dist\cli.js %*
