$ErrorActionPreference = 'Stop'

$entryName = 'AngelAgentOS'
$runScript = (Resolve-Path (Join-Path $PSScriptRoot 'run-at-login.ps1')).Path
$powerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`""
$command = "`"$powerShell`" $arguments"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name $entryName -Value $command -PropertyType String -Force | Out-Null

$legacyTask = Get-ScheduledTask -TaskName 'Angel AgentOS' -ErrorAction SilentlyContinue
if ($legacyTask) {
    Disable-ScheduledTask -TaskName 'Angel AgentOS' | Out-Null
}

Write-Output "Registered current-user startup entry: $entryName"
