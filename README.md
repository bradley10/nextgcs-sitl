# NextGCS SITL installer

One-command installer for a local ArduPilot Copter simulator and the
WebSocket bridge that NextGCS uses. No repository clone is needed.

The installer downloads the official ArduPilot SITL binary (about 7 MB),
installs the single Node.js dependency it needs, writes a launcher, and can
start one or two simulated drones. Everything stays in your home folder.

## Install and start

macOS, Linux, or WSL2:

```bash
curl -fsSL https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.ps1 | iex
```

The installer asks a couple of questions and can start the simulator
immediately. Press Ctrl+C in that terminal to stop it.

Connect NextGCS to:

```
ws://127.0.0.1:5765
```

On Windows, try `127.0.0.1` first. If it does not connect, use the
`ws://<WSL-IP>:5765` address the installer prints and allow the Windows
Firewall prompt for WSL.

## Requirements

- Node.js 20 or newer. It also runs the WebSocket bridge.
- Linux x86_64 runs the simulator natively.
- macOS and non-x86_64 Linux use Docker. Start Docker Desktop first. On Apple
  Silicon, enable Rosetta for x86_64/amd64 emulation.
- Windows needs Windows 10 2004+ or Windows 11 with WSL2 and an Ubuntu
  distribution. The PowerShell installer checks WSL2 and Node.js inside WSL
  and prints the exact setup command if anything is missing.

The installer does not need Administrator or sudo. Installing Node.js, Docker,
or WSL2 may require it, depending on your computer.

## Start it again

macOS, Linux, and WSL2:

```bash
~/.nextgcs/sitl/start.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File $HOME\.nextgcs\start-sitl.ps1
```

Two simulated drones:

```bash
~/.nextgcs/sitl/start.sh --vehicles 2
```

The second drone listens on `ws://127.0.0.1:5766`.

## Options

Run the installer or launcher with `--help` for the full list.

| Option | Meaning |
|---|---|
| `--yes` | Accept defaults without asking |
| `--vehicles <1\|2>` | Number of simulated drones |
| `--port <port>` | WebSocket port for the first drone (default 5765) |
| `--wipe` / `--no-wipe` | Reset simulator state on every start (default wipe) |
| `--no-start` | Install and write the launcher, then exit |
| `--start-only` | Start an existing installation |
| `--check` | Check an existing installation and exit |
| `--dir <path>` | Install folder (default `~/.nextgcs/sitl`) |
| `--force` | Download and rebuild even if files already exist |

## What it installs

- `arducopter` — the official ArduPilot Copter SITL binary.
- `copter.parm` — the official default parameters.
- `ws` — the only Node.js package, installed inside the install folder.
- `start.sh`, `start.ps1`, `nextgcs-sitl.mjs`, and `install.json`.

Run `--check` any time to verify the binary, parameters, dependency, runner,
launcher, and (on Docker) the local image.

## Uninstall

macOS, Linux, and WSL2:

```bash
rm -rf ~/.nextgcs/sitl
```

Windows also removes the generated launcher:

```powershell
Remove-Item -Recurse -Force $HOME\.nextgcs\sitl
Remove-Item -Force $HOME\.nextgcs\start-sitl.ps1
```

On macOS or non-x86_64 Linux, remove the Docker image too:

```bash
docker image rm nextgcs-sitl:local
```

## Safety

- The simulator runs on your computer and listens on localhost. In WSL2 it
  binds the WSL interface so Windows can reach it; the installer prints a
  warning about the firewall prompt.
- It never connects to, arms, or commands a real aircraft.
- It does not collect telemetry or send data anywhere except the downloads
  needed for setup: ArduPilot firmware, GitHub raw files, and the npm registry.

## Source

These files are published from the NextGCS project for easy installation.
The NextGCS repository is private during development; this repository contains
only the installer and its documentation.

No open-source license is granted at this time.
