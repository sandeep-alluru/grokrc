<#
.SYNOPSIS
  Is the daemon actually serving? If not, restart it.

.DESCRIPTION
  The Windows counterpart to tools/watchdog.sh, and it exists for the same
  reason: Task Scheduler's RestartCount covers a process that EXITS. It does
  nothing for a process that is alive but wedged - socket open, port bound,
  nothing answering.

  That failure mode is not hypothetical on Windows. While building the
  Scheduled Task packaging, `Stop-ScheduledTask` left an orphaned node holding
  port 4319; the task then crash-looped on EADDRINUSE while /api/health kept
  answering from the orphan. The task said one thing, the port said another,
  and only an HTTP request told the truth.

  So this checks the thing that matters - a real HTTP response with ok:true -
  rather than the thing that is easy to check.

  Installed by packaging/windows/install-watchdog.ps1 as a Scheduled Task.

.PARAMETER Port
  Defaults to GROKRC_PORT, then 4319.
#>
[CmdletBinding()]
param(
  [int]$Port = $(if ($env:GROKRC_PORT) { [int]$env:GROKRC_PORT } else { 4319 }),
  [string]$BindHost = $(if ($env:GROKRC_HOST) { $env:GROKRC_HOST } else { '127.0.0.1' }),
  [string]$TaskName = 'grokrc',
  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'grokrc\watchdog.log')
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') grokrc-watchdog: $msg"
  Write-Output $line
  Add-Content -Path $LogPath -Value $line -Encoding utf8
}

function Test-Healthy {
  # Probe the address the daemon actually BOUND, not loopback.
  #
  # This was written as a hardcoded 127.0.0.1 on the reasoning that "the daemon
  # always answers on the port it bound". MEASURED, and false: a daemon started
  # with `--host 100.119.149.50` binds that address ONLY, so loopback refuses
  # the connection. The first run of this watchdog declared a perfectly healthy
  # daemon dead and restarted it - a watchdog causing the outage it exists to
  # prevent. Pass -BindHost (or set GROKRC_HOST) to match how the daemon was
  # started; install-watchdog.ps1 threads it through.
  try {
    $r = Invoke-WebRequest -Uri "http://${BindHost}:$Port/api/health" -UseBasicParsing -TimeoutSec 10
    return @{ ok = ($r.Content -match '"ok"\s*:\s*true'); body = $r.Content }
  } catch {
    return @{ ok = $false; body = $_.Exception.Message }
  }
}

$health = Test-Healthy
if ($health.ok) {
  # Healthy. Say so at low volume so the schedule leaves a trail worth reading.
  Write-Log "ok $($health.body)"
  exit 0
}

$state = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
Write-Log "UNHEALTHY: state=$state body=$($health.body -replace '\s+',' ')"

# Stop, then start - not Start alone. A wedged process reports Running while
# answering nothing, so Start would be a no-op exactly when it is needed. The
# generated launcher clears its own orphan on the way up, which is what makes
# this safe on a platform where stopping a task does not kill its children.
try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
} catch {
  Write-Log "restart command failed - state=$state err=$($_.Exception.Message)"
  exit 1
}

Start-Sleep -Seconds 8
$after = Test-Healthy
if ($after.ok) {
  Write-Log 'RECOVERED after restart'
  exit 0
}

Write-Log "STILL UNHEALTHY after restart - needs a human. body=$($after.body -replace '\s+',' ')"
exit 1
