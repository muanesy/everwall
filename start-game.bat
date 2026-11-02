@echo off
cd /d "%~dp0"

set "PY=python"
where python >nul 2>nul || set "PY=py -3"

rem 8765 已被占用 = 上一次开的服务器窗口还留着。
rem 它服务的还是磁盘上的代码（所以内容不算旧），但这个窗口的改动就不会生效了，
rem 而且容易让人以为是"启动器坏了"，所以先把话说清楚。
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   [!] 8765 端口上已经有一个服务器在跑了。
  echo       如果那是你上次开的窗口，请先关掉它，再双击本文件。
  echo       不关也能玩，但那个窗口不会加载本次的代码改动。
  echo.
)

start /b %PY% "%~dp0serve.py"
timeout /t 2 /nobreak >nul

rem 带随机时间戳打开：浏览器会当成新网址，强制重新加载。
rem 不带的话，已经开着的那张标签会被复用，画面停在几小时前的状态，
rem 看起来就像"改了没生效"。
start "" "http://localhost:8765/?t=%RANDOM%%RANDOM%"

echo.
echo   Game is running at http://localhost:8765/
echo   开始页标题下面那行版本号会显示当前 git 提交号，
echo   改了代码但版本号没变、也没带 * 号，就说明浏览器吃的是缓存。
echo.
echo   Close this window to stop the server.
echo.
pause >nul
