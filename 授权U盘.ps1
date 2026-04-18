[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$signScript = Join-Path $scriptDir "sign-usb.js"
$privateKey  = Join-Path $scriptDir "private.pem"
$nodePath    = Join-Path $scriptDir "runtime\node.exe"
if (-not (Test-Path $nodePath)) { $nodePath = "node" }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "      OpenClaw U盘授权工具" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $signScript)) {
    Write-Host "错误：找不到 sign-usb.js" -ForegroundColor Red
    pause; exit 1
}
if (-not (Test-Path $privateKey)) {
    Write-Host "错误：找不到 private.pem，授权无法进行" -ForegroundColor Red
    Write-Host "请将 private.pem 放到本脚本同目录下" -ForegroundColor Yellow
    pause; exit 1
}

Write-Host "当前检测到的磁盘：" -ForegroundColor Yellow
$disks = Get-WmiObject Win32_LogicalDisk
foreach ($d in $disks) {
    $label = if ($d.VolumeName) { $d.VolumeName } else { "无标签" }
    Write-Host "  $($d.DeviceID)  [$label]  序列号: $($d.VolumeSerialNumber)"
}
Write-Host ""

$driveLetter = Read-Host "请输入要授权的U盘盘符（例如 F 或 G）"
$driveLetter = $driveLetter.Trim().TrimEnd(":").ToUpper()

if (-not $driveLetter) {
    Write-Host "错误：未输入盘符" -ForegroundColor Red
    pause; exit 1
}

if (-not (Test-Path "${driveLetter}:\")) {
    Write-Host "错误：找不到驱动器 ${driveLetter}:" -ForegroundColor Red
    pause; exit 1
}

$serial = (Get-WmiObject Win32_LogicalDisk -Filter "DeviceID='${driveLetter}:'").VolumeSerialNumber
if (-not $serial) {
    Write-Host "错误：无法读取 ${driveLetter}: 的序列号" -ForegroundColor Red
    pause; exit 1
}
$serial = $serial.Trim().ToUpper()

Write-Host ""
Write-Host "盘符: ${driveLetter}:    序列号: $serial" -ForegroundColor Green
Write-Host "正在生成授权文件..." -ForegroundColor Cyan

$result = & $nodePath $signScript $serial 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "生成失败：$result" -ForegroundColor Red
    pause; exit 1
}
Write-Host $result -ForegroundColor Green

# 复制 license.key 到U盘根目录
$src  = Join-Path $scriptDir "license.key"
$dest = "${driveLetter}:\license.key"
Copy-Item $src $dest -Force

# 复制分发内容到U盘（如果U盘上还没有启动器）
$exeOnUsb = "${driveLetter}:\OpenClaw-启动器.exe"
if (-not (Test-Path $exeOnUsb)) {
    Write-Host ""
    $copyAll = Read-Host "是否将启动器文件一并复制到U盘？(Y/N，默认Y)"
    if ($copyAll -ne "N" -and $copyAll -ne "n") {
        Write-Host "正在复制文件到U盘..." -ForegroundColor Cyan
        $items = @("OpenClaw-启动器.exe", "openclaw.zip", "runtime.zip")
        foreach ($item in $items) {
            $srcItem = Join-Path $scriptDir $item
            if (Test-Path $srcItem) {
                $destItem = "${driveLetter}:\$item"
                if (Test-Path $srcItem -PathType Container) {
                    Copy-Item $srcItem $destItem -Recurse -Force
                } else {
                    Copy-Item $srcItem $destItem -Force
                }
                Write-Host "  已复制: $item" -ForegroundColor Gray
            }
        }
        Write-Host "文件复制完成" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "license.key 已复制到 ${driveLetter}:\" -ForegroundColor Green
Write-Host ""
Write-Host "授权完成！该U盘现在可以运行 OpenClaw 了。" -ForegroundColor Cyan
Write-Host ""
pause
