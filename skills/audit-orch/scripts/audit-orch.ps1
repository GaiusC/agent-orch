# audit-orch.ps1
# Automates checking the progress of Agent Orchestrator (CC/AGY) jobs and active processes.

$targetDir = $PWD.Path
$orchestratorDir = $null

# 1. Search upwards to find .agent-orchestrator folder
while ($targetDir -ne $null -and $targetDir -ne "") {
    $checkDir = Join-Path $targetDir ".agent-orchestrator"
    if (Test-Path $checkDir -PathType Container) {
        $orchestratorDir = $checkDir
        break
    }
    $targetDir = Split-Path $targetDir -Parent
}

Write-Host "## Agent Orchestrator Auditor Report"
Write-Host "Local Time: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host ""

# 2. Check running processes
Write-Host "### Active Agent Orchestrator Processes"
$processes = Get-CimInstance Win32_Process | Where-Object { 
    ($_.Name -eq 'claude.exe') -or
    ($_.Name -eq 'agy.exe') -or
    ($_.CommandLine -match 'agent-orch\.ps1|agent-orch\.mjs|claude -p|agy --print|Main\.py|run_revision')
}

if ($processes) {
    foreach ($p in $processes) {
        $cmd = $p.CommandLine
        if ($cmd -and $cmd.Length -gt 150) {
            $cmd = $cmd.Substring(0, 150) + "..."
        }
        Write-Host "* **$($p.Name)** (PID $($p.ProcessId))"
        Write-Host "  * Command Line: ``$($cmd)``"
    }
} else {
    Write-Host "No active agent-orchestrator or training processes are running."
}
Write-Host ""

# 3. Scan recent jobs
if ($orchestratorDir -eq $null) {
    Write-Host "⚠️ **.agent-orchestrator directory not found in the current directory tree.**"
    exit 0
}

Write-Host "Found Orchestrator Directory: ``$orchestratorDir``"
Write-Host ""

$runsDir = Join-Path $orchestratorDir "runs"
if (-not (Test-Path $runsDir)) {
    Write-Host "No runs folder found under .agent-orchestrator."
    exit 0
}

$runs = Get-ChildItem -Path $runsDir -Directory | Sort-Object Name -Descending | Select-Object -First 10
$results = [System.Collections.Generic.List[PSCustomObject]]::new()

foreach ($r in $runs) {
    $jobFile = Join-Path $r.FullName "job.json"
    if (Test-Path $jobFile) {
        try {
            $job = Get-Content $jobFile -Raw | ConvertFrom-Json
            $observedModel = $null
            if ($job.observed_model) {
                $observedModel = $job.observed_model
            } elseif ($job.model) {
                $observedModel = $job.model
            } elseif ($job.attempts -and $job.attempts.Count -gt 0) {
                $observedModel = $job.attempts[0].observed_model
            }
            
            $status = $job.status
            if ($status -eq "running") {
                $needle = [regex]::Escape($job.id)
                $live = Get-CimInstance Win32_Process | Where-Object {
                    $_.CommandLine -match $needle -or ($job.session_id -and $_.CommandLine -match [regex]::Escape($job.session_id))
                } | Select-Object -First 1
                if (-not $live) { $status = "stale-running" }
            }

            $results.Add([PSCustomObject]@{
                Folder     = $r.Name
                Provider   = $job.provider
                Type       = $job.type
                TaskId     = $job.task_id
                Status     = $status
                Phase      = $job.phase
                StartedAt  = $job.started_at
                FinishedAt = $job.finished_at
                Model      = $observedModel
            })
        } catch {
            # Skip invalid files
        }
    }
}

Write-Host "### Recent Agent Orchestrator Jobs"
Write-Host ""
Write-Host "| Folder / Job ID | Provider | Type | Task ID | Status | Phase | Started At (UTC) | Model |"
Write-Host "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |"
foreach ($item in $results) {
    $startedStr = if ($item.StartedAt) { $item.StartedAt } else { "-" }
    $modelStr = if ($item.Model) { $item.Model } else { "-" }
    Write-Host "| ``$($item.Folder)`` | $($item.Provider) | $($item.Type) | ``$($item.TaskId)`` | **$($item.Status)** | $($item.Phase) | $startedStr | $modelStr |"
}
Write-Host ""

# 4. Details for Newest Jobs
$ccJobs = $results | Where-Object { $_.Provider -eq "cc" }
$agyJobs = $results | Where-Object { $_.Provider -eq "agy" }

if ($ccJobs) {
    $newestCc = $ccJobs[0]
    Write-Host "### Newest CC Job: ``$($newestCc.Folder)``"
    Write-Host "* **Status**: **$($newestCc.Status)** | **Phase**: $($newestCc.Phase)"
    
    $debugLog = Join-Path $runsDir "$($newestCc.Folder)\cc-round-0.claude-debug.log"
    $transcriptLog = Join-Path $runsDir "$($newestCc.Folder)\cc-round-0.claude-transcript.jsonl"
    $patchPath = Join-Path $runsDir "$($newestCc.Folder)\changes.patch"
    if (Test-Path $transcriptLog) {
        Write-Host "* **Claude transcript**: ``$transcriptLog``"
    }
    if (Test-Path $patchPath) {
        Write-Host "* **Patch**: ``$patchPath``"
    }
    if (Test-Path $debugLog) {
        Write-Host "* **Latest Logs from cc-round-0.claude-debug.log**:"
        Write-Host '```'
        Get-Content -Tail 8 -Path $debugLog
        Write-Host '```'
    } else {
        Write-Host "* No debug log file found."
    }
    Write-Host ""
}

if ($agyJobs) {
    $newestAgy = $agyJobs[0]
    Write-Host "### Newest AGY Job: ``$($newestAgy.Folder)``"
    Write-Host "* **Status**: **$($newestAgy.Status)** | **Phase**: $($newestAgy.Phase)"
    
    $evidencePath = Join-Path $runsDir "$($newestAgy.Folder)\evidence.json"
    $cliLog = Join-Path $runsDir "$($newestAgy.Folder)\agy-investigate.cli.log"
    if (-not (Test-Path $cliLog)) { $cliLog = Join-Path $runsDir "$($newestAgy.Folder)\agy-verify.cli.log" }
    if (Test-Path $evidencePath) {
        Write-Host "* Evidence JSON present."
    } else {
        Write-Host "* No evidence file found."
    }
    if (Test-Path $cliLog) {
        Write-Host "* **AGY CLI log**: ``$cliLog``"
    }
}
