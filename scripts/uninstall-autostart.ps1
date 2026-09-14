$ErrorActionPreference = 'Stop'

$entryName = 'AngelAgentOS'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$entry = Get-ItemProperty -Path $runKey -Name $entryName -ErrorAction SilentlyContinue
if ($entry) {
    Remove-ItemProperty -Path $runKey -Name $entryName
    Write-Output "Removed current-user startup entry: $entryName"
} else {
    Write-Output "Startup entry not found: $entryName"
}

$legacyTask = Get-ScheduledTask -TaskName 'Angel AgentOS' -ErrorAction SilentlyContinue
if ($legacyTask) {
    Unregister-ScheduledTask -TaskName 'Angel AgentOS' -Confirm:$false
    Write-Output 'Removed legacy scheduled task: Angel AgentOS'
}
