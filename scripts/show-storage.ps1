$ErrorActionPreference = 'Stop'

$agentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dataDir = if ($env:AGENTOS_DATA_DIR) { [IO.Path]::GetFullPath($env:AGENTOS_DATA_DIR) } else { Join-Path $agentOsRoot 'data' }
$tempRoot = [IO.Path]::GetTempPath()
$chatTemps = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'agentos-chat-*' -ErrorAction SilentlyContinue)

function Get-DirectorySize([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return (Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
}

$rows = @(
    @{ Name = 'Product source'; Path = $agentOsRoot; Sensitive = 'No (except ignored local files)' },
    @{ Name = 'Runtime data root'; Path = $dataDir; Sensitive = 'Yes' },
    @{ Name = 'State/conversations/jobs'; Path = (Join-Path $dataDir 'agentos.json'); Sensitive = 'Yes' },
    @{ Name = 'Login-start logs'; Path = (Join-Path $dataDir 'logs'); Sensitive = 'Yes' },
    @{ Name = 'Runner worktrees'; Path = (Join-Path $dataDir 'worktrees'); Sensitive = 'Yes' },
    @{ Name = 'Feishu credential copies'; Path = (Join-Path $dataDir 'lark-cli-config'); Sensitive = 'Critical' },
    @{ Name = 'Feishu event files'; Path = (Join-Path $dataDir 'lark-cli-events'); Sensitive = 'Yes' },
    @{ Name = 'Codex home'; Path = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }); Sensitive = 'Critical' },
    @{ Name = 'lark-cli home'; Path = (Join-Path $env:USERPROFILE '.lark-cli'); Sensitive = 'Critical' }
)

$chatSize = ($chatTemps | ForEach-Object { Get-DirectorySize $_.FullName } | Measure-Object -Sum).Sum
$rows += @{
    Name = 'Chat temporary cwd'
    Path = "$(Join-Path $tempRoot 'agentos-chat-*') ($($chatTemps.Count) directories)"
    Exists = $chatTemps.Count -gt 0
    SizeBytes = $chatSize
    Sensitive = 'Yes'
}

$rows | ForEach-Object {
    [pscustomobject]@{
        Name = $_.Name
        Path = $_.Path
        Exists = if ($_.ContainsKey('Exists')) { $_.Exists } else { Test-Path -LiteralPath $_.Path }
        SizeMiB = [math]::Round($(if ($_.ContainsKey('SizeBytes')) { $_.SizeBytes } else { Get-DirectorySize $_.Path }) / 1MB, 2)
        Sensitive = $_.Sensitive
    }
} | Format-Table -AutoSize -Wrap

Write-Host 'This command prints paths and sizes only. It does not read or print message, credential or log contents.'
