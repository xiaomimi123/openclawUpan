@echo off
chcp 65001 >nul 2>&1
title OpenClaw 授权文件生成工具

echo.
echo ========================================
echo       OpenClaw 授权文件生成工具
echo ========================================
echo.

:: 检查 private.pem
if not exist "%~dp0private.pem" (
    echo [错误] 找不到 private.pem，请将私钥放到本脚本同目录下
    echo.
    pause
    exit /b 1
)

:: 找 Node.js
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

:: 输入序列号
set /p "SERIAL=请输入U盘序列号: "
if "%SERIAL%"=="" (
    echo [错误] 未输入序列号
    pause
    exit /b 1
)

echo.
"%NODE_EXE%" "%~dp0sign-usb.js" %SERIAL%

echo.
pause
