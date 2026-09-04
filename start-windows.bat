@echo off
rem POSIX 对应 start.sh。PID = 项目根\项目全称.pid
cd /d "%~dp0"
setlocal EnableExtensions

for %%I in ("%~dp0.") do set PROJECT_NAME=%%~nxI
set PID_FILE=%~dp0%PROJECT_NAME%.pid
set LOG_FILE=server\server.log
if "%DEFAULT_PORT%"=="" set DEFAULT_PORT=8643
set PORT=%DEFAULT_PORT%

set NODE_BIN=
where node >nul 2>nul && set NODE_BIN=node
if "%NODE_BIN%"=="" if exist "%~dp0tool\node\node.exe" set NODE_BIN="%~dp0tool\node\node.exe"
if "%NODE_BIN%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set NODE_BIN="%ProgramFiles%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set NODE_BIN="%ProgramFiles(x86)%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE_BIN="%LOCALAPPDATA%\Programs\nodejs\node.exe"
if "%NODE_BIN%"=="" (
  echo [ERROR] 未找到 Node.js
  exit /b 1
)
echo [OK] Node.js: %NODE_BIN%

if "%~1"=="--set-password" (
  %NODE_BIN% server\boot.cjs --set-password "%~2"
  echo [OK] 密码已设置
  exit /b 0
)

set CMD=%~1
if "%CMD%"=="" set CMD=restart
if "%CMD%"=="--port" set CMD=restart

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

if /i "%CMD%"=="stop" goto stop_server
if /i "%CMD%"=="status" goto status_server
if /i "%CMD%"=="restart" (
  if exist "%PID_FILE%" (
    for /f "usebackq delims=" %%i in ("%PID_FILE%") do set PID=%%i
    tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
    if not errorlevel 1 (
      echo [RESTART] 重启服务 ...
      call :stop_server
    )
  )
  goto start_server
)
if /i "%CMD%"=="start" goto start_server

echo [ERROR] 未知命令: %CMD%
echo 可用命令: start, stop, restart, status
exit /b 1

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
  echo [START] 启动 %PROJECT_NAME% （端口 %PORT%）
  for /f %%i in ('powershell -NoProfile -Command "$p=Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','set PORT=%PORT% && %NODE_BIN% server\boot.cjs --port %PORT% >> server\server.log 2>&1' -WindowStyle Hidden -PassThru; $p.Id"') do set PID=%%i
  echo %PID%> "%PID_FILE%"
  echo [OK] 服务已启动 PID=%PID%
  echo [OK] 访问 http://127.0.0.1:%PORT%
  echo [OK] PID 文件: %PID_FILE%
  echo [OK] 日志: %LOG_FILE%
  exit /b 0

:stop_server
  if not exist "%PID_FILE%" (
    echo [WARN] PID 文件不存在，服务可能未运行
    exit /b 0
  )
  for /f "usebackq delims=" %%i in ("%PID_FILE%") do set PID=%%i
  tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
  if errorlevel 1 (
    echo [WARN] 进程 %PID% 不存在，清理 PID 文件
    del /q "%PID_FILE%" >nul 2>&1
    exit /b 0
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
    echo [WARN] PID 文件存在但进程已消失
    del /q "%PID_FILE%" >nul 2>&1
    exit /b 1
  )
  echo [OK] 服务正在运行 PID=%PID%
  echo [OK] PID 文件: %PID_FILE%
  exit /b 0
