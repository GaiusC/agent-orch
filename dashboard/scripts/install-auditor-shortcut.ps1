param(
    [string]$SourceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
    [int]$PreferredPort = 43188
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$desktop = (Resolve-Path -LiteralPath $DesktopDir).Path
$launcher = Join-Path $source 'dashboard\scripts\open-dashboard.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Auditor launcher not found: $launcher" }
if ($PreferredPort -lt 1024 -or $PreferredPort -gt 65485) { throw 'PreferredPort must leave room for the 50-port scan.' }

$shortcutPath = Join-Path $desktop 'Agent Orch Auditor.lnk'
$shell = New-Object -ComObject WScript.Shell
$icon = "$env:SystemRoot\System32\shell32.dll,220"
$backup = $null
if (Test-Path -LiteralPath $shortcutPath) {
    $old = $shell.CreateShortcut($shortcutPath)
    if ($old.IconLocation -and $old.IconLocation -ne ',0') { $icon = $old.IconLocation }
    $backupDir = Join-Path $source '.agent-orchestrator\auditor-shortcut-backups'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backup = Join-Path $backupDir ("Agent Orch Auditor-" + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssffffZ') + '.lnk')
    Copy-Item -LiteralPath $shortcutPath -Destination $backup
}

$target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '" -ProjectDir "' + $source + '" -PreferredPort ' + $PreferredPort + ' -ProjectHome'
$link = $shell.CreateShortcut($shortcutPath)
$link.TargetPath = $target
$link.Arguments = $arguments
$link.WorkingDirectory = $source
$link.WindowStyle = 7
$link.IconLocation = $icon
$link.Description = 'Agent Orch Auditor - Projects / Plan and Git history'
$link.Save()

$verified = $shell.CreateShortcut($shortcutPath)
if ($verified.TargetPath -ine $target -or $verified.Arguments -ne $arguments -or $verified.WorkingDirectory -ine $source) {
    throw "Shortcut verification failed. Backup: $backup"
}
[pscustomobject]@{ shortcut = $shortcutPath; target = $verified.TargetPath; arguments = $verified.Arguments; backup = $backup } | ConvertTo-Json -Compress
