$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir "agent-orch.mjs"

& node $nodeScript @args
exit $LASTEXITCODE
