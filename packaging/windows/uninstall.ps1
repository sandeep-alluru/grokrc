<#
.SYNOPSIS
  Remove the grokrc Scheduled Task.

.DESCRIPTION
  The counterpart to packaging/windows/install.ps1, and the Windows analogue of
  packaging/systemd/uninstall.sh.

  It stops the task before unregistering it. Unregistering alone leaves the
  daemon running until the next reboot — with the port still bound, so the next
  `grokrc up` fails with "another grokrc daemon is already running" and nothing
  on screen explains why.

  The log file is left in place deliberately: it is the only record of why the
  thing you just removed was misbehaving. Its path is printed so you can delete
  it yourself.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'grokrc',
  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'grokrc\grokrc.log'),
  [switch]$RemoveLog
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "  no scheduled task named '$TaskName' - nothing to remove"
} else {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  removed scheduled task '$TaskName'"
}

# Stopping the task kills the powershell wrapper. A `node dist/cli.js up` it
# spawned can outlive it, and an orphan still holds the port. Only processes
# whose command line names THIS repo's entry point are touched.
$entry = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'dist\cli.js')
$orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) }

foreach ($p in $orphans) {
  Write-Host "  stopping orphaned daemon pid $($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if (-not $orphans) { Write-Host '  no orphaned daemon processes' }

if ($RemoveLog -and (Test-Path $LogPath)) {
  Remove-Item $LogPath -Force
  Write-Host "  removed log $LogPath"
} elseif (Test-Path $LogPath) {
  Write-Host "  log kept at $LogPath  (-RemoveLog to delete)"
}

Write-Host ''
Write-Host '  grokrc itself is untouched - this only removes the autostart task.'
Write-Host '  Settings live in ~/.grokrc, credentials in ~/.grok.'
