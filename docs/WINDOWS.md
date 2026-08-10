# Windows support

grokrc is developed on Linux and fully supported there and on macOS. Windows
support is **partial**: the packaged CLI is covered by continuous integration,
but the full test suite has not yet been run on Windows and several features are
known not to work.

This page states exactly what is covered, what is not, and what is needed to
finish the port. If you want to help, it is a well-defined piece of work.

---

## Support matrix

| Platform    | Packaged CLI | Full test suite | Service manager  | Status    |
| ----------- | ------------ | --------------- | ---------------- | --------- |
| **Linux**   | Node 20–24   | Node 22, 24     | systemd unit     | Supported |
| **macOS**   | Node 20–24   | Node 22, 24     | none supplied    | Supported |
| **Windows** | Node 20–24   | not yet run     | none supplied    | Partial   |

Every entry above corresponds to a job in `.github/workflows/compat.yml` that
runs on each push.

---

## What works on Windows

Continuous integration runs the compiled package on Windows against Node 20, 21,
22 and 24, covering:

- the CLI loads and runs
- `grokrc doctor` reports a missing agent cleanly
- `grokrc config` reads and prints settings
- `grokrc up` refuses to start when no agent is installed, and says why
- the declared Node version floor is satisfiable

The control channel between the CLI and a running daemon has a Windows
implementation. Windows has no Unix domain sockets, so grokrc uses a named pipe
(`\\.\pipe\grokrc-<id>`), derived per user account so two people on one machine
do not collide.

If that channel fails to start, the daemon still runs and still serves phones —
only `grokrc pair`, `devices`, `revoke` and live configuration reload need it.

---

## What does not work yet

### Taking over a terminal session

Before stopping a process, grokrc confirms that the process really is a Grok
agent, so that a stale entry can never cause an unrelated program to be killed.
That check reads the process command line using `ps`, which does not exist on
Windows.

grokrc detects this and refuses the takeover with an explanatory message. It
does not guess. Everything else — creating sessions, prompting, approvals,
resuming — is unaffected.

### Running as a background service

The repository ships a systemd unit, which is Linux-only. On Windows, run
`grokrc up` in a terminal, or configure a Scheduled Task at logon.

### File permission hardening

On Linux and macOS, grokrc restricts its configuration directory and files to
the owner. Windows ignores these POSIX permissions. Device tokens are stored
hashed rather than in plain text, so this is not a credential disclosure, but the
configuration directory is less protected than on Unix. See
[SECURITY.md](../SECURITY.md).

### Shutdown signals

Windows has no POSIX signals. Node terminates the target process immediately
rather than asking it to stop, so an agent shut down by grokrc may not get the
chance to flush its final output. The practical impact has not been measured.

---

## Getting started on Windows

Requires Node 20 or newer and [Grok Build](https://x.ai/cli) on your `PATH`.

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

## Completing the port

Four pieces of work, in dependency order.

**1. Run the test suite and record what fails.**

```powershell
npm test
```

This has never been run on Windows, so the failure list is unknown. Likely
candidates are tests that invoke shell utilities and tests that assert POSIX
path formats. Capture the full output before changing anything.

**2. Implement process inspection for Windows.**

`processArgs()` in `src/daemon/session-manager.ts` needs a Windows branch. It
must return the executable path **on its own**, without arguments:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" |
  Select-Object -ExpandProperty ExecutablePath
```

Returning a full command line will not work: the identity check derives the
executable name from the string, and Windows install paths routinely contain
spaces (`C:\Program Files\...`). Widening the match to search the whole string
would let unrelated processes match, which defeats the purpose of the check.

**3. Add a service integration.** A Scheduled Task at logon is the smallest
approach that survives a reboot.

**4. Add Windows to the suite matrix.** Once the tests pass, add
`windows-latest` to the `suite` job in `.github/workflows/compat.yml`. Until then
Windows support remains partial by definition.

---

## Contributing

Please read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request.
In short: changes need a test that fails without them, and `npm test`,
`npm run lint` and `npm run format:check` must pass.
