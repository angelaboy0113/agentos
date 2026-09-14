$ErrorActionPreference = 'Stop'

$agentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$files = @(
    @{ Source = 'config\projects.example.json'; Target = 'config\projects.local.json' },
    @{ Source = 'config\agents.example.json'; Target = 'config\agents.local.json' },
    @{ Source = 'config\codex-runtime.example.json'; Target = 'config\codex-runtime.local.json' }
)

foreach ($item in $files) {
    $source = Join-Path $agentOsRoot $item.Source
    $target = Join-Path $agentOsRoot $item.Target
    if (Test-Path -LiteralPath $target) {
        Write-Host "KEEP   $($item.Target)"
        continue
    }
    Copy-Item -LiteralPath $source -Destination $target
    Write-Host "CREATE $($item.Target)"
}

Write-Host ''
Write-Host 'Local configuration is ready. Edit the three *.local.json files before starting AgentOS.'
Write-Host 'These files are ignored by Git. Never paste App Secret, access tokens or auth.json into the repository.'
