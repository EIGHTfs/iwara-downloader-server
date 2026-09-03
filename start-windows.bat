@echo off
rem ============================================================
rem iwara-downloader-server - Windows 启动脚本（对照 gbmd start-windows.bat）
rem 用法：
rem   重启（默认）：start-windows.bat [restart] [--port 8643]
rem   启动：        start-windows.bat start [--port 8643]
rem   停止：        start-windows.bat stop
rem   状态：        start-windows.bat status
rem   设置密码：    start-windows.bat --set-password "新密码"
rem 说明：后台运行，日志追加 server\server.log；PID 记录在 server\app.pid
rem ============================================================
cd /d "%~dp0"
setlocal

rem ---------- 找 node ----------
set NODE_BIN=
where node >nul 2>nul && set NODE_BIN=node
if "%NODE_BIN%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set NODE_BIN="%ProgramFiles%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set NODE_BIN="%ProgramFiles(x86)%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE_BIN="%LOCALAPPDATA%\Programs\nodejs\node.exe"
if "%NODE_BIN%"=="" (
  echo [ERROR] 未找到 Node.js！请先安装：
  echo   从 https://nodejs.org 下载 Windows LTS 版并安装
  pause
  exit /b 1
)
echo [OK] Node.js: %NODE_BIN%

set PID_FILE=server\app.pid
set PORT=8643

rem ---------- 从 config.json 读端口（缺省 8643）----------
for /f "delims=" %%i in ('%NODE_BIN% -e "try{const c=require(process.argv[1]);console.log(c.port||8643)}catch(e){console.log(8643)}" server\config.json 2^>nul') do set PORT=%%i

rem ---------- 特殊：--set-password ----------
if "%~1"=="--set-password" (
  %NODE_BIN% server\boot.cjs --set-password "%~2"
  echo [OK] 密码已设置
  pause
  exit /b 0
)

rem ---------- 先捕获命令（第一个参数），空参数默认 restart ----------
set CMD=%~1
if "%CMD%"=="" set CMD=restart
if "%CMD%"=="--port" set CMD=restart

rem ---------- 再解析 --port（遍历全部剩余参数找 --port N）----------
set PORT_OVERRIDE=
:portloop
  set "a=%~1"
  if "%a%"=="" goto portdone
  if /i "%a%"=="--port" (
    if not "%~2"=="" set PORT_OVERRIDE=%~2
    goto portdone
  )
  shift
  goto portloop
:portdone
if not "%PORT_OVERRIDE%"=="" set PORT=%PORT_OVERRIDE%

rem ---------- 停止 ----------
if /i "%CMD%"=="stop" goto stop_server

rem ---------- 重启（先停再启）----------
if /i "%CMD%"=="restart" (
  echo [RESTART] 重启服务 ...
  call :stop_server
  goto start_server
)

rem ---------- 状态 ----------
if /i "%CMD%"=="status" goto status_server

rem ---------- 启动 / 其他 ----------
if /i "%CMD%"=="start" goto start_server

echo [ERROR] 未知命令: %CMD%
echo 可用命令: start, stop, restart, status
echo 旧用法: --port PORT 或 --set-password PASSWORD
pause
exit /b 1

rem ============================================================
rem 子程序
rem ============================================================

:start_server
  if exist "%PID_FILE%" (
    for /f "usebackq delims=" %%i in ("%PID_FILE%") do set PID=%%i
    tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
    if not errorlevel 1 (
      echo [WARN] 服务已在运行 PID=%PID%
      exit /b 1
    )
  )
  if not exist server mkdir server
  echo [START] 启动 iwara-downloader-server ...（端口 %PORT%）
  rem 用 cmd 包装重定向追加日志；PowerShell 拿 cmd PID
  for /f %%i in ('powershell -NoProfile -Command "$p=Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','set PORT=%PORT% && %NODE_BIN% server\boot.cjs >> server\server.log 2>&1' -WindowStyle Hidden -PassThru; $p.Id"') do set PID=%%i
  echo %PID%> "%PID_FILE%"
  echo [OK] 服务已启动 PID=%PID%
  echo [OK] 访问 http://127.0.0.1:%PORT%
  echo [OK] 日志: server\server.log；停止: start-windows.bat stop
  exit /b 0

:stop_server
  if not exist "%PID_FILE%" (
    echo [WARN] PID 文件不存在，服务可能未运行
    exit /b 1
  )
  for /f "usebackq delims=" %%i in ("%PID_FILE%") do set PID=%%i
  tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
  if errorlevel 1 (
    echo [WARN] 进程 %PID% 不存在，清理 PID 文件
    del /q "%PID_FILE%" >nul 2>&1
    exit /b 1
  )
  echo [STOP] 停止服务 PID=%PID% ...
  taskkill /PID %PID% /T /F >nul 2>&1
  del /q "%PID_FILE%" >nul 2>&1
  echo [OK] 服务已停止
  exit /b 0

:status_server
  if not exist "%PID_FILE%" (
    echo [ERROR] 服务未运行
    exit /b 1
  )
  for /f "usebackq delims=" %%i in ("%PID_FILE%") do set PID=%%i
  tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
  if errorlevel 1 (
    echo [WARN] PID 文件存在但进程已消失（可能异常退出）
    del /q "%PID_FILE%" >nul 2>&1
    exit /b 1
  )
  echo [OK] 服务正在运行 PID=%PID%
  exit /b 0