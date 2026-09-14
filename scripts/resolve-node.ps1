$ErrorActionPreference = 'Stop'

function Resolve-AgentOsNode {
    param(
        [string]$AgentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    )

    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($env:AGENTOS_NODE_BIN) {
        $candidates.Add($env:AGENTOS_NODE_BIN)
    }

    $versionFile = Join-Path $AgentOsRoot '.nvmrc'
    if ((Test-Path -LiteralPath $versionFile) -and $env:APPDATA) {
        $version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
        $candidates.Add((Join-Path $env:APPDATA "nvm\v$version\node.exe"))
    }

    $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($pathNode) {
        $candidates.Add($pathNode.Source)
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $versionText = (& $candidate --version 2>$null)
        if ($LASTEXITCODE -eq 0 -and $versionText -match '^v22\.') {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw 'Node.js 22 was not found. Install Node 22, or set AGENTOS_NODE_BIN to a verified node.exe.'
}
