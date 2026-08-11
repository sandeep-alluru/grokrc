# Windows support

grokrc is developed on Linux and supported on Linux, macOS and Windows. On
Windows the **full test suite runs in continuous integration**, alongside the
packaged CLI, on every push.

This page states what is covered, what differs from Unix, and what is still
unmeasured. Where a limitation remains it is described directly rather than
implied.

---

## Support matrix

| Platform    | Packaged CLI | Full test suite | Service manager  | Status    |
| ----------- | ------------ | --------------- | ---------------- | --------- |
| **Linux**   | Node 20–24   | Node 22, 24     | systemd unit     | Supported |
| **macOS**   | Node 20–24   | Node 22, 24     | none supplied    | Supported |
| **Windows** | Node 20–24   | Node 22, 24     | Scheduled Task   | Supported |

Every entry above corresponds to a job in `.github/workflows/compat.yml` that
runs on each push.

---

## What works on Windows

Everything the product does: creating and resuming sessions, observing a session
started by hand, one-tap approvals, taking over a terminal session, `grokrc
term`, relay mode, and the PWA.

The control channel between the CLI and a running daemon uses a named pipe
(`\\.\pipe\grokrc-<id>`), derived per user account so two people on one machine
do not collide — Windows has no Unix domain sockets. If that channel fails to
start, the daemon still runs and still serves phones; only `grokrc pair`,
`devices`, `revoke` and live configuration reload need it.

**Autostart** is a Scheduled Task rather than a service — see
[Running as a service](#running-as-a-service).

### Two defects worth knowing about, because they were invisible for a while

Until the suite ran here, Windows CI consisted of five CLI smoke steps, and they
were green throughout a period when the product could not work at all:

- **Every absolute path was refused.** The check for "is this absolute?" was
  `startsWith('/')`, which is true only on POSIX. Every `C:\...` path failed, so
  no session could be created, resumed, observed or taken over — and
  `grokrc config set defaultCwd C:\code`, the one required setting, was rejected.
- **The daemon returned 403 for every asset of its own PWA.** Path containment
  was tested as `startsWith(root + '/')`, and `resolve()` returns `C:\...`, so
  the check refused everything. The phone client could not load.

Both failed *closed* — refusing legitimate work rather than allowing anything
unsafe. A smoke test that never requests an asset cannot notice that every asset
is refused, which is why `windows-latest` now runs the whole suite.

---

## What differs from Unix

### File permissions

On Linux and macOS grokrc restricts its configuration directory and files with
POSIX modes (`0700` / `0600`). Windows ignores those, so the directory is
hardened explicitly with an ACL: inherited entries are dropped and a single
grant is made to your account.

This matters more than "tokens are hashed" suggests — `~/.grokrc` also holds
`vapid.json`, a Web Push **private key**, and `term-token`, a **plaintext**
bearer token for `grokrc term`.

### The control channel

Weaker on Windows, and stated rather than glossed. On Unix the channel is a
socket file in your own directory, `chmod 0600` — access is filesystem
permissions. A Windows named pipe is machine-global and Node exposes no way to
set an ACL on one, so the name is *unguessable* rather than *protected*. See
[SECURITY.md](../SECURITY.md).

### Shutdown signals

Windows has no POSIX signals; Node terminates the target process immediately
rather than asking it to stop. The concern was that an agent stopped this way
would lose the tail of its turn.

**Measured, and it does not.** `tools/midturn-check.mjs` closes an agent
mid-turn and resumes the session: the recovery path restores events the agent
never persisted, and the last streamed line survives. It runs as part of
`npm test`.

### Taking over a terminal session

Before stopping a process, grokrc confirms it really is a Grok agent, so a stale
registry entry can never cause an unrelated program to be killed. On Unix that
reads the command line with `ps`. Windows has no `ps`, so it reads the
executable path from the process table with `Get-CimInstance Win32_Process`.

The identity check is deliberately different on each platform. A POSIX command
line is matched on `argv[0]`; a Windows executable path is matched whole,
without word-splitting, because install paths routinely contain spaces
(`C:\Program Files\grok\grok.exe`). One predicate accepting both shapes would
also accept `vim /home/me/grok`, which is precisely what the check exists to
prevent.

---

## Getting started on Windows

Requires Node 20 or newer and [Grok Build](https://x.ai/cli) on your `PATH`.

Grok Build ships a native Windows binary. Its installer is a shell script — run
it from Git Bash, and note that on Windows it does **not** add itself to your
`PATH`:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Then add `%USERPROFILE%\.grok\bin` to your `PATH` and sign in with `grok login`.

```powershell
git clone https://github.com/sandeep-alluru/grokrc
cd grokrc
npm ci
npm run build
```

Confirm the agent is available, then start the daemon:

```powershell
grok --version
node dist/cli.js doctor
node dist/cli.js up --port 4319
```

In a second terminal, request a pairing code. This also confirms the named pipe
is working end to end:

```powershell
node dist/cli.js pair
```

From there, follow the main [setup guide](SETUP.md) from §5 onwards — pairing,
reaching the daemon from your phone, and notifications are all
platform-independent.

---

## Running as a service

A Scheduled Task, deliberately shaped like the systemd **user** unit rather than
a Windows Service: it runs as you, needs no administrator, starts automatically
and restarts on failure. A Service was rejected because services run as SYSTEM
or need a stored password, and a coding agent running as SYSTEM is the wrong
answer to every question.

```powershell
packaging\windows\install.ps1
packaging\windows\install.ps1 -DaemonArgs '--lan'
packaging\windows\install-watchdog.ps1 -BindHost 127.0.0.1   # optional
```

```powershell
Get-ScheduledTask grokrc
Get-Content "$env:LOCALAPPDATA\grokrc\grokrc.log" -Wait -Tail 40
Stop-ScheduledTask -TaskName grokrc; Start-ScheduledTask -TaskName grokrc
packaging\windows\uninstall.ps1          # keeps your pairings
```

Two differences from systemd, both deliberate:

- It starts at **logon**, not at boot. Starting earlier means "run whether the
  user is logged on or not", which requires storing your password. Pass
  `-RunWhetherLoggedOn` if you want that trade.
- Task Scheduler captures no output, so stdout goes to
  `%LOCALAPPDATA%\grokrc\grokrc.log`. That file is the equivalent of
  `journalctl --user -u grokrc -f`.

If you give the daemon a specific `--host`, give the watchdog the **same** one. A
daemon bound to one address does not answer on loopback, and a watchdog probing
the wrong address will restart a healthy daemon on every run.

---

## Still unmeasured on Windows

Three things are not known to be broken — they are simply untested here, and
saying so is more useful than implying coverage that does not exist.

- **First-run experience.** `npm run check:stranger` installs the package into a
  sandboxed HOME to test what a new user meets. It is a bash script with no
  Windows equivalent, which is unfortunate precisely because first-run is where
  Windows differs most: the agent installer adds nothing to `PATH`, and
  `grok login` has not happened yet.
- **The permission option shape.** The conformance run reports that the agent
  did not ask permission on that turn, because the isolated test home runs with
  prompting disabled. Nothing indicates a problem; it is unexercised.
  `tools/e2e-drive.mjs` is the tool that would close it.
- **Web Push from a Windows-hosted daemon.** Delivery to an iPhone is verified
  from Linux. Whether a Windows host behaves identically has not been run.

Line endings are worth one note for contributors: git's Windows default
(`core.autocrlf=true`) checks the tree out as CRLF. `.gitattributes` pins
everything to LF, so a fresh clone is correct; an older clone may need
`git add --renormalize .` once.

---

## Contributing

Please read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request.
In short: changes need a test that fails without them, and `npm test`,
`npm run lint` and `npm run format:check` must pass.
