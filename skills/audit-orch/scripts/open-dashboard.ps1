param(
    [string]$ProjectDir = (Get-Location).Path,
    [int]$PreferredPort = 15788,
    [switch]$Close
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
        $res = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 2
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

function Stop-DashboardOnPort {
    param(
        [int]$Port,
        [string]$ExpectedServerPath,
        [string]$ExpectedProjectDir
    )
    $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -in @("Listen", "Established", "Bound") }
    $processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
    $stopped = $false
    foreach ($processId in $processIds) {
        if (-not $processId) { continue }
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        $cmd = [string]$proc.CommandLine
        if ($cmd -and $cmd.Contains($ExpectedServerPath) -and $cmd.Contains($ExpectedProjectDir) -and $cmd.Contains("--port $Port")) {
            Stop-Process -Id $processId -Force
            $stopped = $true
        }
    }
    return $stopped
}

$resolvedProject = (Resolve-Path -LiteralPath $ProjectDir).Path
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $scriptDir "server.py"
$resolvedProjectFull = [System.IO.Path]::GetFullPath($resolvedProject).TrimEnd('\')
$targetOrchestrator = Resolve-OrchestratorDir -StartDir $resolvedProject
if ($Close -and -not $targetOrchestrator) {
    $closed = $false
    $matchedPort = $null
    for ($candidate = $PreferredPort; $candidate -lt $PreferredPort + 50; $candidate++) {
        if (Stop-DashboardOnPort -Port $candidate -ExpectedServerPath $serverPath -ExpectedProjectDir $resolvedProjectFull) {
            $closed = $true
            $matchedPort = $candidate
            break
        }
    }
    if ($matchedPort) {
        Write-Output "dashboard_url=http://127.0.0.1:$matchedPort"
    }
    Write-Output "orchestrator_dir="
    Write-Output "stopped=$($closed.ToString().ToLowerInvariant())"
    exit 0
}
if (-not $targetOrchestrator) {
    throw ".agent-orchestrator not found from project dir: $resolvedProject"
}

$target = [System.IO.Path]::GetFullPath($targetOrchestrator).TrimEnd('\')
$requiredServerVersion = "audit-orch-project-bound-v3"
$port = $null

if ($Close) {
    $closed = $false
    $matchedPort = $null
    for ($candidate = $PreferredPort; $candidate -lt $PreferredPort + 50; $candidate++) {
        $status = Get-DashboardStatus -Port $candidate
        if (-not ($status -and $status.orchestrator_dir)) { continue }
        $current = [System.IO.Path]::GetFullPath([string]$status.orchestrator_dir).TrimEnd('\')
        if ($current -ieq $target -and $status.server_version -eq $requiredServerVersion) {
            $matchedPort = $candidate
            $closed = Stop-DashboardOnPort -Port $candidate -ExpectedServerPath $serverPath -ExpectedProjectDir $resolvedProjectFull
            break
        }
    }
    if ($matchedPort) {
        Write-Output "dashboard_url=http://127.0.0.1:$matchedPort"
    }
    Write-Output "orchestrator_dir=$targetOrchestrator"
    Write-Output "stopped=$($closed.ToString().ToLowerInvariant())"
    exit 0
}

for ($candidate = $PreferredPort; $candidate -lt $PreferredPort + 50; $candidate++) {
    $status = Get-DashboardStatus -Port $candidate
    if ($status -and $status.orchestrator_dir) {
        $current = [System.IO.Path]::GetFullPath([string]$status.orchestrator_dir).TrimEnd('\')
        if ($current -ieq $target -and $status.server_version -eq $requiredServerVersion) {
            $port = $candidate
            Start-Process "http://127.0.0.1:$port"
            Write-Output "dashboard_url=http://127.0.0.1:$port"
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
            Start-Process "http://127.0.0.1:$port"
            Write-Output "dashboard_url=http://127.0.0.1:$port"
            Write-Output "orchestrator_dir=$targetOrchestrator"
            exit 0
        }
    }
    throw "Port $port is occupied by a dashboard or service for another project."
}

Start-Process "http://127.0.0.1:$port"
Write-Output "dashboard_url=http://127.0.0.1:$port"
Write-Output "orchestrator_dir=$($newStatus.orchestrator_dir)"
exit 0
