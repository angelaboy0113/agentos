$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'resolve-node.ps1')
$agentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = Resolve-AgentOsNode -AgentOsRoot $agentOsRoot
$runtime = Split-Path -Parent $node

$env:Path = "$runtime;$env:Path"
Write-Host "Using Node $(node --version) from $runtime"

if ($args.Count -gt 0) {
    $command = $args[0]
    $commandArgs = @()
    if ($args.Count -gt 1) {
        $commandArgs = $args[1..($args.Count - 1)]
    }
    if ($command -in @('node', 'node.exe')) {
        & $node @commandArgs
    } else {
        & $command @commandArgs
    }
    exit $LASTEXITCODE
}
