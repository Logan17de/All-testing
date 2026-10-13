@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo.
echo  Zet Harness - Windows preparation
echo  =================================
where node >nul 2>&1
if errorlevel 1 goto :need_node
where npm >nul 2>&1
if errorlevel 1 goto :need_node
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major===24 && minor>=20 ? 0 : 1)"
if errorlevel 1 goto :need_node
for /f "delims=" %%V in ('npm --version') do set "ZET_NPM_VERSION=%%V"
node -e "const [a,b,c]=process.argv[1].split('.').map(Number);process.exit(a===12 && (b>0 || c>=2) ? 0 : 1)" "%ZET_NPM_VERSION%"
if errorlevel 1 goto :need_npm
echo.
echo [1/2] Installing pinned project dependencies...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :failed
echo.
echo [2/2] Compiling the runtime and UI...
call npm run build
if errorlevel 1 goto :failed
echo.
echo Preparation complete. Run "Start Zet Harness.cmd" to open the local app.
exit /b 0
:need_node
echo This test package requires Node.js 24.20.x and npm 12.0.2 or newer in the 12.x line.
echo Install the official Node.js 24 LTS runtime first, then run this file again.
exit /b 1
:need_npm
echo npm 12.0.2 or newer in the 12.x line is required. Current: %ZET_NPM_VERSION%.
echo Run: npm install --global npm@12.0.2
exit /b 1
:failed
echo.
echo Preparation failed. Do not start this build; inspect the error above.
exit /b 1
