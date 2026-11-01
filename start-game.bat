@echo off
cd /d "%~dp0"

set "PY=python"
where python >nul 2>nul || set "PY=py -3"

start /b %PY% -m http.server 8765
timeout /t 2 /nobreak >nul

start "" http://localhost:8765/

echo.
echo   Game is running at http://localhost:8765/
echo   Close this window to stop the server.
echo.
pause >nul
