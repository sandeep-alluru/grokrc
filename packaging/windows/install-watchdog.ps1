<#
.SYNOPSIS
  Install the grokrc health watchdog as a Scheduled Task.

.DESCRIPTION
  The Windows counterpart to packaging/systemd/install-watchdog.sh, mirroring
  the schedule in grokrc-watchdog.timer:

    systemd                      Scheduled Task
    OnBootSec=5min               AtLogOn trigger with a 5-minute delay
    OnUnitActiveSec=30min        RepetitionInterval 30 minutes
    Persistent=true              StartWhenAvailable (run on wake, do not skip)

  The first row is the one that differs on purpose: the daemon starts at logon,
  not at boot, so a boot-triggered watchdog would judge a daemon that is not
  meant to exist yet — and registering a boot trigger needs administrator rights
  this packaging deliberately does not ask for.

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

# AtLogOn, not AtStartup, for two measured reasons:
#
#  1. AtStartup is a machine-scoped trigger and registering one requires
#     administrator rights: "Register-ScheduledTask : Access is denied."  This
#     packaging's whole premise is that it needs none.
#  2. It would be watching for something that cannot be there. The daemon
#     itself starts at LOGON (see install.ps1), so a watchdog running five
#     minutes after boot would find no daemon, restart a task that is not
#     supposed to be running yet, and log a failure every reboot.
#
# The delay still applies, so the daemon gets time to bind before it is judged.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT5M'
# NO -RepetitionDuration: omitting it means "repeat indefinitely", which is what
# OnUnitActiveSec does in the systemd timer this mirrors.
#
# It was written as `-RepetitionDuration ([TimeSpan]::MaxValue)`, which looks
# like "forever" and is not: it serialises to P99999999DT23H59M59S and Task
# Scheduler rejects the task XML outright with "a value which is incorrectly
# formatted or out of range". MEASURED - the task did not register.
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)).Repetition

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
  -Description 'grokrc health watchdog - restarts the daemon if it stops answering' `
  -ErrorAction Stop | Out-Null

# Confirm it is really there before claiming it is.
#
# Register-ScheduledTask reports a rejected task XML as a NON-TERMINATING CIM
# error, which $ErrorActionPreference='Stop' does not catch, so the script ran
# on and printed "installed watchdog task 'grokrc-watchdog'" while no task
# existed. A success message is a claim; this is the measurement behind it.
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  throw "registration reported no error but '$TaskName' does not exist - nothing was installed"
}

Write-Host "  installed watchdog task '$TaskName'"
Write-Host "  every $IntervalMinutes minute(s), 5 minutes after startup, port $Port"
Write-Host "  logs:   Get-Content '$(Join-Path $env:LOCALAPPDATA 'grokrc\watchdog.log')' -Wait -Tail 40"
Write-Host "  run now: Start-ScheduledTask -TaskName $TaskName"
Write-Host "  remove:  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
