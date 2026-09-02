@echo off
rem ============================================================
rem iwara-downloader-server - Windows 后台启动脚本（对照 gbmd start-windows-background.bat）
rem 与 start-windows.bat 行为一致（start/stop/restart/status，
rem 空参数默认 restart），仅保留此入口以兼容旧习惯/快捷方式。
rem 用法见 start-windows.bat 头注释。
rem ============================================================
cd /d "%~dp0"
call start-windows.bat %*