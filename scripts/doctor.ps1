$ErrorActionPreference = 'Continue'

$agentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'resolve-node.ps1')
$problems = [System.Collections.Generic.List[string]]::new()

function Show-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $mark = if ($Ok) { 'OK  ' } else { 'MISS' }
    Write-Host "$mark $Name - $Detail"
    if (-not $Ok) { [void]$script:problems.Add($Name) }
}

try {
    $node = Resolve-AgentOsNode -AgentOsRoot $agentOsRoot
    Show-Check 'Node.js 22' $true "$(& $node --version) at $node"
} catch {
    Show-Check 'Node.js 22' $false $_.Exception.Message
}

$git = Get-Command git.exe -ErrorAction SilentlyContinue
Show-Check 'Git' ($null -ne $git) $(if ($git) { (& $git.Source --version) } else { 'Install Git and reopen the terminal.' })

$codex = Get-Command codex.exe -ErrorAction SilentlyContinue
if (-not $codex -and $env:LOCALAPPDATA) {
    $codex = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe') -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if ($codex) {
    $codexPath = if ($codex.Source) { $codex.Source } else { $codex.FullName }
    Show-Check 'Codex' $true "$(& $codexPath --version) at $codexPath"
    & $codexPath login status
    if ($LASTEXITCODE -ne 0) { [void]$problems.Add('Codex login') }
} else {
    Show-Check 'Codex' $false 'Install Codex CLI/Desktop and complete codex login.'
}

$larkEntryOk = $env:LARK_CLI_ENTRY -and (Test-Path -LiteralPath $env:LARK_CLI_ENTRY -PathType Leaf)
$lark = Get-Command lark-cli -ErrorAction SilentlyContinue
Show-Check 'lark-cli' ($larkEntryOk -or $null -ne $lark) $(if ($larkEntryOk) { "LARK_CLI_ENTRY=$env:LARK_CLI_ENTRY" } elseif ($lark) { $lark.Source } else { 'Install and configure lark-cli.' })

foreach ($relative in @('config\projects.local.json', 'config\agents.local.json', 'config\codex-runtime.local.json')) {
    $exists = Test-Path -LiteralPath (Join-Path $agentOsRoot $relative) -PathType Leaf
    $detail = if ($exists) { 'present (content is not displayed)' } else { 'Run scripts\initialize-local.ps1, then edit the placeholders.' }
    Show-Check $relative $exists $detail
}

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2
    Show-Check 'AgentOS health' ($health.ok -eq $true) 'http://127.0.0.1:8787/health'
} catch {
    Write-Host 'INFO AgentOS health - not running yet; start it after configuration.'
}

Write-Host ''
if ($problems.Count -eq 0) {
    Write-Host 'Doctor passed. The machine has the required local pieces.'
    exit 0
}
Write-Host "Doctor found $($problems.Count) missing item(s): $($problems -join ', ')"
exit 1
