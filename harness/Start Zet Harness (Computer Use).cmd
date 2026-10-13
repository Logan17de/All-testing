@echo off
setlocal EnableExtensions
rem Explicit opt-in. Normal Start Zet Harness.cmd leaves desktop access disabled.
if /I "%~1"=="--check" (
  if not exist "%~dp0Start Zet Harness.cmd" exit /b 1
  echo DESKTOP_OPT_IN_LAUNCHER_CHECK_OK
  exit /b 0
)
echo.
echo  Zet Harness - optional local computer use
echo  ========================================
echo This enables the experimental Windows desktop driver for this process only.
echo The agent cannot control your PC until you arm an exact task.
echo Each input requires your separate approval. Screenshot sharing needs
echo an additional model/destination-specific decision.
echo.
choice /C YN /M "Enable this driver for this session"
if errorlevel 2 exit /b 1
set "ZET_DESKTOP_DRIVER=windows-powershell"
call "%~dp0Start Zet Harness.cmd"
exit /b %errorlevel%
