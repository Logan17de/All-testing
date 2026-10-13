@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo.
echo  Zet Harness - Windows local launcher
echo  ====================================
where node >nul 2>&1
if errorlevel 1 goto :need_node
where npm >nul 2>&1
if errorlevel 1 goto :need_node
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major===24 && minor>=20 ? 0 : 1)"
if errorlevel 1 goto :need_node
for /f "delims=" %%V in ('npm --version') do set "ZET_NPM_VERSION=%%V"
node -e "const [a,b,c]=process.argv[1].split('.').map(Number);process.exit(a===12 && (b>0 || c>=2) ? 0 : 1)" "%ZET_NPM_VERSION%"
if errorlevel 1 goto :need_npm
if not defined LOCALAPPDATA goto :need_user_data
set "ZET_USER_STATE=%LOCALAPPDATA%\ZetHarness"
if not exist "%ZET_USER_STATE%" mkdir "%ZET_USER_STATE%"
if errorlevel 1 goto :need_user_data
if not exist "%ZET_USER_STATE%\plugins" mkdir "%ZET_USER_STATE%\plugins"
if errorlevel 1 goto :need_user_data
set "ZET_RUNTIME_DB_PATH=%ZET_USER_STATE%\runtime.sqlite"
set "ZET_RUNTIME_PLUGINS_DIR=%ZET_USER_STATE%\plugins"
if not exist "apps\runtime\dist\main.js" goto :need_build
if not exist "apps\web\.next\BUILD_ID" goto :need_build
if /I "%~1"=="--check" (
  echo WINDOWS_LAUNCHER_CHECK_OK
  exit /b 0
)
echo Database and plugin state: %ZET_USER_STATE%
echo Open http://127.0.0.1:3000 after both services start.
echo Press Ctrl+C to stop. Keep this window open while using the app.
call npm start -- --production
exit /b %errorlevel%
:need_build
echo Production build missing. Run "Prepare Zet Harness.cmd" first.
exit /b 1
:need_node
echo Node.js 24.20.x and npm 12.0.2+ are required to run this test package.
exit /b 1
:need_npm
echo npm 12.0.2 or newer in the 12.x line is required. Current: %ZET_NPM_VERSION%.
exit /b 1
:need_user_data
echo Could not create private Zet Harness state under LOCALAPPDATA.
echo The launcher will not fall back to storing chat data inside the downloaded application.
exit /b 1
