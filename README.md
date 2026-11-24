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

The installer shows one checklist with the good defaults already ticked: one
simulated drone, reset the simulator state on every start (always fresh), and
start it when setup finishes. Press Enter to accept them, or use the arrow
keys and Space to change the drone count, the fresh-state setting, or
autostart. Press Ctrl+C in that terminal to stop the simulator once it runs.

To skip the checklist and choose everything up front:

```bash
curl -fsSL https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.sh \
  | bash -s -- --yes --vehicles 2 --no-start
```

On Windows, save the script and run it as a file to pass the same options:

```powershell
irm https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.ps1 -OutFile install-sitl.ps1
powershell -ExecutionPolicy Bypass -File .\install-sitl.ps1 -Yes -Vehicles 2
```

Connect NextGCS to:

```
ws://127.0.0.1:5765
```

On Windows, try `127.0.0.1` first. If it does not connect, use the
`ws://<WSL-IP>:5765` address the installer prints and allow the Windows
Firewall prompt for WSL.

## Live logs

The terminal stays live while the simulator runs:

- **Every simulator line.** The ArduPilot binary's stdout and stderr are
  forwarded exactly as emitted, blank lines included (`[sitl v1] ...`).
- **Vehicle status messages.** MAVLink status text — PreArm failures, arming,
  mode changes, EKF events — is timestamped with its severity
  (`[12:34:56.789] [sitl v1 msg] INFO: EKF3 IMU0 initialised`).
- **Connections.** WebSocket open/close events show when NextGCS connects or
  reconnects (`[12:34:56.789] [ws v1] connection opened (1 open)`).

With two simulated drones, every line is tagged `v1` or `v2` so the two
streams stay readable in one window. Nothing is written to a file; the
simulator's own DataFlash logs remain in its state folder.

## Real drone over UDP (browser bridge)

The browser build of NextGCS cannot open UDP sockets. Run this same installer
in bridge mode on the computer that receives the drone's telemetry; it serves
MAVLink both ways over WebSocket, so NextGCS can connect with its normal
WebSocket transport.

macOS, Linux, or WSL2:

```bash
# Listen on UDP 14550 and reply to the first sender
curl -fsSL https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.sh \
  | bash -s -- --bridge

# Or send to a known vehicle or telemetry endpoint
curl -fsSL https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.sh \
  | bash -s -- --bridge --udp 192.168.1.50:14555
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.ps1 -OutFile install-sitl.ps1
powershell -ExecutionPolicy Bypass -File .\install-sitl.ps1 -Bridge
# or: .\install-sitl.ps1 -Bridge -Udp 192.168.1.50:14555
```

Then in NextGCS choose **Connect → WebSocket** and enter `ws://127.0.0.1:5765`.
The connection dialog also builds this command from the address you type.
Bridge mode does not download the simulator; it installs only the small `ws`
package the first time, sends GCS heartbeats so the link becomes discoverable,
prints live vehicle status messages, and forwards commands as well as telemetry —
anything you send from NextGCS reaches the aircraft.

Inside WSL the Windows browser reaches the bridge on `ws://127.0.0.1:5765`; if
the UDP sender runs on Windows, point it at the WSL address the installer prints
(or enable mirrored WSL networking). Using `--udp <host:port>` avoids that
question: the bridge starts the conversation in the right direction.

When Node.js 20 or newer is installed on Windows, `-Bridge` runs natively on
Windows instead of WSL. That is the reliable choice when the drone's telemetry
sender is another Windows program, because WSL2 does not forward UDP localhost
traffic into the distribution by default. If Windows Node.js is missing, the
bridge falls back to WSL2 and the installer prints the WSL address to use.

## Requirements

- Node.js 20 or newer. It also runs the WebSocket bridge and is required
  everywhere (inside WSL2 on Windows). A separate Windows Node.js is optional
  but recommended for a native bridge.
- Linux x86_64 runs the simulator natively. Other Linux architectures use
  Docker and need amd64 emulation (qemu binfmt).
- macOS and non-x86_64 Linux use Docker. Start Docker Desktop first. On Apple
  Silicon, enable Rosetta for x86_64/amd64 emulation.
- Windows needs Windows 10 2004+ or Windows 11 with WSL2 and an Ubuntu
  distribution for the simulator. The PowerShell installer checks WSL2 and
  Node.js inside WSL and prints the exact setup command if anything is missing.

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
| `--yes` | Skip the checklist and use the defaults |
| `--vehicles <1\|2>` | Number of simulated drones |
| `--port <port>` | WebSocket port for the first drone (default 5765) |
| `--wipe` / `--no-wipe` | Reset simulator state on every start (default wipe) |
| `--no-start` | Install and write the launcher, then exit |
| `--start-only` | Start an existing installation |
| `--check` | Check an existing installation and exit |
| `--dir <path>` | Install folder (default `~/.nextgcs/sitl`) |
| `--force` | Download and rebuild even if files already exist |
| `--bridge` | Bridge a real drone's MAVLink UDP to WebSocket instead of running SITL |
| `--udp <host:port>` | Bridge mode: send to this vehicle or telemetry endpoint |
| `--udp-listen <port>` | Bridge mode: UDP port to receive on (default 14550) |

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
