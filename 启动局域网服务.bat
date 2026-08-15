@echo off
chcp 65001 >nul
title 屏码传 - 局域网服务
cd /d "%~dp0"

echo ================================================
echo   屏码传 · 局域网服务（手机浏览器访问本页面）
echo ================================================
echo.
echo  [1/2] 正在查找本机局域网 IP...
set "IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  if not defined IP set "IP=%%a"
)
if not defined IP (
  echo   未找到局域网 IPv4 地址（请确认已连接 Wi-Fi/网线）
  set "IP=127.0.0.1"
)
set "IP=%IP: =%"
echo   本机 IP：%IP%
echo.
echo  [2/2] 正在启动 HTTP 服务（端口 8000）...
echo.
echo  >>> 请确保手机与电脑连接同一 Wi-Fi，然后在手机浏览器打开：
echo.
echo       http://%IP%:8000/screen-qr-transfer.html
echo.
echo  （按 Ctrl+C 可停止服务）
echo.

if exist screen-qr-transfer.html (
  start "" "http://%IP%:8000/screen-qr-transfer.html"
) else (
  echo  [警告] 未找到 screen-qr-transfer.html，请确认本文件与页面在同一目录！
)

where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8000
  goto :eof
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m http.server 8000
  goto :eof
)
echo  [错误] 未找到 Python，无法启动本地服务。
echo  请改用其他方式把 screen-qr-transfer.html 发送到手机，用浏览器打开。
pause
