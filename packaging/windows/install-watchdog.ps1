<#
.SYNOPSIS
  Install the grokrc health watchdog as a Scheduled Task.

.DESCRIPTION
  The Windows counterpart to packaging/systemd/install-watchdog.sh, mirroring
  the schedule in grokrc-watchdog.timer:

    systemd                      Scheduled Task
    OnBootSec=5min               AtStartup trigger with a 5-minute delay
    OnUnitActiveSec=30min        RepetitionInterval 30 minutes
    Persistent=true              StartWhenAvailable (run on wake, do not skip)

  No administrator rights: the task runs as you, like the daemon it watches.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'grokrc-watchdog',
  [int]$Port = 4319,
  # Must match how the daemon was started. A daemon bound to a specific address
  # does NOT answer on loopback, and a watchdog probing the wrong one restarts a
  # healthy daemon every time it runs. See the note in tools/watchdog.ps1.
  [string]$BindHost = '127.0.0.1',
  [int]$IntervalMinutes = 30
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Script = Join-Path $RepoRoot 'tools\watchdog.ps1'
if (-not (Test-Path $Script)) { throw "watchdog script not found: $Script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`" -Port $Port -BindHost $BindHost" `
  -WorkingDirectory $RepoRoot

# AtStartup + delay is the closest analogue to OnBootSec. A logon trigger would
# skip the case this exists for: the machine came back up and the daemon did not.
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT5M'
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description 'grokrc health watchdog - restarts the daemon if it stops answering' | Out-Null

Write-Host "  installed watchdog task '$TaskName'"
Write-Host "  every $IntervalMinutes minute(s), 5 minutes after startup, port $Port"
Write-Host "  logs:   Get-Content '$(Join-Path $env:LOCALAPPDATA 'grokrc\watchdog.log')' -Wait -Tail 40"
Write-Host "  run now: Start-ScheduledTask -TaskName $TaskName"
Write-Host "  remove:  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
