$ErrorActionPreference = 'Stop'

$agentOsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'resolve-node.ps1')
$node = Resolve-AgentOsNode -AgentOsRoot $agentOsRoot
$runtime = Split-Path -Parent $node

$logDirectory = Join-Path $agentOsRoot 'data\logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stdoutLog = Join-Path $logDirectory 'agentos.stdout.log'
$stderrLog = Join-Path $logDirectory 'agentos.stderr.log'

$env:Path = "$runtime;$env:Path"
$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
$env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'
Set-Location -LiteralPath $agentOsRoot

$process = Start-Process `
    -FilePath $node `
    -ArgumentList 'src\control-plane\local.js' `
    -WorkingDirectory $agentOsRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru `
    -Wait

exit $process.ExitCode
