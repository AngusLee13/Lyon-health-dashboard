# 监控新创建的 cmd.exe 进程，记录其父进程和命令行
# 用法：powershell -ExecutionPolicy Bypass -File scripts/catch-cmd.ps1

$logFile = Join-Path $PSScriptRoot "..\logs\cmd-monitor.log"
$startTime = Get-Date
$endTime = $startTime.AddMinutes(5)

"========== 监控开始 $($startTime.ToString('yyyy-MM-dd HH:mm:ss')) ==========" | Out-File -Append $logFile
"将在 $($endTime.ToString('HH:mm:ss')) 结束" | Out-File -Append $logFile

# 记录当前已有的 cmd.exe 进程 ID，用于区分新进程
$existingPids = @{}
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | ForEach-Object {
    $existingPids[$_.ProcessId] = $true
}

while ((Get-Date) -lt $endTime) {
    $current = @{}
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | ForEach-Object {
        $pid = $_.ProcessId
        $current[$pid] = $_
        if (-not $existingPids.ContainsKey($pid)) {
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue
            $parentName = if ($parent) { $parent.Name } else { "未知" }
            $parentCmd = if ($parent -and $parent.CommandLine) { $parent.CommandLine } else { "无" }

            $msg = @"
[$(Get-Date -Format 'HH:mm:ss')] 🪟 新 CMD 进程!
  PID: $pid
  命令行: $($_.CommandLine)
  父进程: $parentName (PID: $($_.ParentProcessId))
  父进程命令行: $parentCmd
---
"@
            $msg | Out-File -Append $logFile
            Write-Host $msg
            $existingPids[$pid] = $true
        }
    }
    Start-Sleep -Milliseconds 500
}

"========== 监控结束 $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) ==========" | Out-File -Append $logFile
