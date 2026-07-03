param(
    [string]$ProjectDir = (Get-Location).Path,
    [int]$PreferredPort = 15788
)

$ErrorActionPreference = "Stop"

function Resolve-OrchestratorDir {
    param([string]$StartDir)
    $target = (Resolve-Path -LiteralPath $StartDir).Path
    while ($target) {
        $check = Join-Path $target ".agent-orchestrator"
        if (Test-Path -LiteralPath $check -PathType Container) {
            return (Resolve-Path -LiteralPath $check).Path
        }
        $parent = Split-Path -Path $target -Parent
        if ($parent -eq $target) { break }
        $target = $parent
    }
    return $null
}

function Get-DashboardStatus {
    param([int]$Port)
    try {
        $res = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/api/status" -TimeoutSec 2
        if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 500) {
            return $res.Content | ConvertFrom-Json
        }
    } catch {
        return $null
    }
    return $null
}

function Test-PortAvailable {
    param([int]$Port)
    $existing = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -in @("Listen", "Established", "Bound", "SynReceived", "SynSent") } |
        Select-Object -First 1
    return -not $existing
}

$resolvedProject = (Resolve-Path -LiteralPath $ProjectDir).Path
$targetOrchestrator = Resolve-OrchestratorDir -StartDir $resolvedProject
if (-not $targetOrchestrator) {
    throw ".agent-orchestrator not found from project dir: $resolvedProject"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $scriptDir "server.py"
$target = [System.IO.Path]::GetFullPath($targetOrchestrator).TrimEnd('\')
$requiredServerVersion = "audit-orch-project-bound-v3"
$port = $null

for ($candidate = $PreferredPort; $candidate -lt $PreferredPort + 50; $candidate++) {
    $status = Get-DashboardStatus -Port $candidate
    if ($status -and $status.orchestrator_dir) {
        $current = [System.IO.Path]::GetFullPath([string]$status.orchestrator_dir).TrimEnd('\')
        if ($current -ieq $target -and $status.server_version -eq $requiredServerVersion) {
            $port = $candidate
            Start-Process "http://localhost:$port"
            Write-Output "dashboard_url=http://localhost:$port"
            Write-Output "orchestrator_dir=$targetOrchestrator"
            exit 0
        }
        continue
    }
    if (Test-PortAvailable -Port $candidate) {
        $port = $candidate
        break
    }
}

if (-not $port) {
    throw "No available dashboard port found near $PreferredPort"
}

if (Test-PortAvailable -Port $port) {
    $serverArg = '"' + $serverPath + '"'
    $projectArg = '"' + $resolvedProject + '"'
    Start-Process -WindowStyle Hidden -FilePath python -WorkingDirectory $resolvedProject -ArgumentList "$serverArg --project-dir $projectArg --port $port"

    Start-Sleep -Milliseconds 500
    $newStatus = $null
    for ($i = 0; $i -lt 20; $i++) {
        $newStatus = Get-DashboardStatus -Port $port
        if ($newStatus) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $newStatus) {
        throw "Dashboard did not become reachable on port $port"
    }
    if ($newStatus.orchestrator_dir) {
        $current = [System.IO.Path]::GetFullPath([string]$newStatus.orchestrator_dir).TrimEnd('\')
        if ($current -ine $target) {
            throw "Dashboard on port $port is bound to $current, expected $target"
        }
    }
} else {
    $status = Get-DashboardStatus -Port $port
    if ($status -and $status.orchestrator_dir) {
        $current = [System.IO.Path]::GetFullPath([string]$status.orchestrator_dir).TrimEnd('\')
        if ($current -ieq $target) {
            Start-Process "http://localhost:$port"
            Write-Output "dashboard_url=http://localhost:$port"
            Write-Output "orchestrator_dir=$targetOrchestrator"
            exit 0
        }
    }
    throw "Port $port is occupied by a dashboard or service for another project."
}

Start-Process "http://localhost:$port"
Write-Output "dashboard_url=http://localhost:$port"
Write-Output "orchestrator_dir=$($newStatus.orchestrator_dir)"
exit 0
