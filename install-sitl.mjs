#!/usr/bin/env node
/**
 * NextGCS local ArduPilot SITL installer and runner.
 *
 * This file is designed to run outside a repository checkout. The one-line
 * installers download it, ask a few plain-language questions, fetch the
 * official ArduPilot Copter simulator, install the single Node dependency it
 * needs (ws), write a launcher, and then bridge the simulator to NextGCS over
 * a WebSocket at ws://127.0.0.1:5765.
 *
 * Supported routes:
 *   - Linux x86_64: run the official prebuilt simulator directly.
 *   - macOS and non-x86_64 Linux: run the same official Linux build in Docker,
 *     because ArduPilot does not publish native builds for those platforms.
 *   - Windows: use scripts/install-sitl.ps1, which runs this installer inside
 *     WSL2. Running this file directly on win32 prints that route.
 *
 * Environment:
 *   NEXTGCS_INSTALL_BASE_URL  Base URL for the one-line installers. Also shown
 *                             in help text when a fork or mirror is used.
 *
 * This program only touches its own install folder (default ~/.nextgcs/sitl)
 * and listens on localhost. It never connects to or commands a real aircraft.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { ReadStream as TtyReadStream } from 'node:tty';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_URL =
  process.env.NEXTGCS_INSTALL_BASE_URL ||
  'https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main';
const ARDUCOPTER_URL =
  'https://firmware.ardupilot.org/Copter/stable/SITL_x86_64_linux_gnu/arducopter';
const COPTER_PARM_URL =
  'https://raw.githubusercontent.com/ArduPilot/ardupilot/master/Tools/autotest/default_params/copter.parm';

const DOCKER_IMAGE = 'nextgcs-sitl:local';
const DOCKER_PLATFORM = 'linux/amd64';
const CONTAINER_WORK_DIR = '/sitl-work';
const CONTAINER_PARM_PATH = '/sitl/copter.parm';
const DEFAULT_PORT = 5765;
const DEFAULT_BASE_TCP_PORT = 5760;
const DEFAULT_UDP_PORT = 14550;
const RUNNER_FILE = 'nextgcs-sitl.mjs';
const MIN_NODE_MAJOR = 20;

const VEHICLE_HOMES = [
  '-35.363262,149.165237,584,353',
  '-35.363362,149.165337,584,353',
];

class InstallError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.name = 'InstallError';
    this.hints = hints;
  }
}

function printHelp() {
  const base = DEFAULT_BASE_URL.replace(/\/+$/, '');
  console.log(`NextGCS local SITL installer

Usually you do not run this file directly. Use one command:

  Linux / macOS / WSL2:
    curl -fsSL ${base}/install-sitl.sh | bash

  Windows PowerShell:
    irm ${base}/install-sitl.ps1 | iex

A run with a terminal shows one checklist (defaults already ticked); press
Enter to accept them. Use --yes to skip it and other options to set values
up front.

Options:
  -y, --yes             Skip the checklist and use the defaults
  --vehicles <1|2>      Simulated drones to start (default: 1)
  --port <port>         WebSocket port for the first drone (default: ${DEFAULT_PORT})
  --wipe                Reset simulator state on every start (default)
  --no-wipe             Keep simulator state between starts
  --no-start            Install and write the launcher, then exit
  --start-only          Start an existing installation; do not install
  --check               Check an existing installation and exit
  --dir <path>          Install folder (default: ~/.nextgcs/sitl)
  --host <addr>         WebSocket bind address (default: 127.0.0.1;
                        0.0.0.0 inside WSL2 so Windows can connect)
  --force               Download and rebuild even if files already exist
  --wsl-distro <name>   WSL distribution name used in the Windows launcher
  --base-url <url>      Base URL shown in instructions
  -h, --help            Show this message

After installing, start later with:
  ~/.nextgcs/sitl/start.sh          (Linux, macOS, WSL2)

Connect NextGCS to:
  ws://127.0.0.1:${DEFAULT_PORT}

The install folder can be changed with --dir or by running the one-line
installer with NEXTGCS_INSTALL_BASE_URL set to a fork or mirror.`);
}

function parsePort(raw, flag) {
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new InstallError(`${flag} must be a whole number from 1 to 65535, got "${raw}".`);
  }
  return num;
}

function parseArgs(argv) {
  const opts = {
    yes: false,
    vehicles: null,
    port: DEFAULT_PORT,
    wipe: null,
    noStart: false,
    startOnly: false,
    check: false,
    force: false,
    dir: null,
    host: null,
    wslDistro: process.env.NEXTGCS_WSL_DISTRO || process.env.WSL_DISTRO_NAME || null,
    baseUrl: DEFAULT_BASE_URL,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--yes' || arg === '-y') {
      opts.yes = true;
    } else if (arg === '--vehicles') {
      const raw = argv[++i];
      const val = Number(raw);
      if (val !== 1 && val !== 2) {
        throw new InstallError(`--vehicles must be 1 or 2, got "${raw}".`);
      }
      opts.vehicles = val;
    } else if (arg === '--port' || arg === '--ws-port') {
      opts.port = parsePort(argv[++i], arg);
    } else if (arg === '--wipe' || arg === '-w') {
      opts.wipe = true;
    } else if (arg === '--no-wipe') {
      opts.wipe = false;
    } else if (arg === '--no-start') {
      opts.noStart = true;
    } else if (arg === '--start-only') {
      opts.startOnly = true;
    } else if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--dir') {
      const dir = argv[++i];
      if (!dir || dir.startsWith('--')) {
        throw new InstallError('--dir needs a folder path, for example --dir ~/sitl.');
      }
      opts.dir = path.resolve(dir);
    } else if (arg === '--host') {
      const host = argv[++i];
      if (!host || host.startsWith('--')) {
        throw new InstallError('--host needs an address such as 127.0.0.1 or 0.0.0.0.');
      }
      opts.host = host;
    } else if (arg === '--wsl-distro') {
      const distro = argv[++i];
      if (!distro || distro.startsWith('--')) {
        throw new InstallError('--wsl-distro needs a distribution name, for example Ubuntu.');
      }
      opts.wslDistro = distro;
    } else if (arg === '--base-url') {
      const url = argv[++i];
      if (!url || url.startsWith('--')) {
        throw new InstallError('--base-url needs a URL.');
      }
      opts.baseUrl = url;
    } else {
      throw new InstallError(`Unknown option: ${arg}`, [
        'Run "node install-sitl.mjs --help" to see the options.',
      ]);
    }
  }

  return opts;
}

function commandWorks(command, args, timeout = 15000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function describePlatform() {
  const { platform, arch } = process;

  if (platform === 'win32') {
    return { kind: 'windows', label: `Windows ${arch}` };
  }

  if (platform === 'linux' && arch === 'x64') {
    return {
      kind: 'native',
      label: isWsl() ? 'Linux x64 (inside WSL2)' : 'Linux x64',
    };
  }

  if (platform === 'darwin' || platform === 'linux') {
    const name = platform === 'darwin' ? 'macOS' : 'Linux';
    return { kind: 'docker', label: `${name} ${arch}` };
  }

  return {
    kind: 'unsupported',
    label: `${platform} ${arch}`,
    hints: [
      'Use a Linux x86_64 computer, WSL2 on Windows, or Docker on macOS.',
      'Official build instructions: https://ardupilot.org/dev/docs/building-setup-linux.html',
    ],
  };
}

function defaultInstallDir() {
  return path.join(os.homedir(), '.nextgcs', 'sitl');
}

function localIpv4() {
  const interfaces = os.networkInterfaces();
  const preferred = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (name.startsWith('eth')) preferred.push(entry.address);
      else if (!name.startsWith('lo')) preferred.push(entry.address);
    }
  }
  return preferred[0] || null;
}

/**
 * One-screen checklist that replaces a string of [Y/n] questions. Up/Down (or
 * j/k) move, Space toggles, Enter accepts the current choices, Ctrl+C cancels.
 * The list is redrawn in place, so the user sees one compact set of checkboxes
 * with the good defaults already ticked.
 */
export function chooseOptions(stream, output, items) {
  if (items.length === 0) return Promise.resolve({});
  const wasRaw = Boolean(stream.isRaw);
  stream.setRawMode(true);
  stream.resume();

  return new Promise((resolve) => {
    let cursor = 0;
    let renderedLines = 0;
    let settled = false;

    const draw = () => {
      if (renderedLines > 0) output.write(`\x1b[${renderedLines}A`);
      const lines = [
        'Press Enter to accept these options:',
        ...items.map(
          (item, index) =>
            `  ${index === cursor ? '>' : ' '} [${item.checked ? 'x' : ' '}] ${item.label}`
        ),
        '  ↑/↓ move · Space toggle · Enter accept · Ctrl+C cancel',
      ];
      for (const line of lines) output.write(`\x1b[2K${line}\n`);
      renderedLines = lines.length;
    };

    const finish = () => {
      stream.removeListener('data', onData);
      try {
        stream.setRawMode(wasRaw);
      } catch {
        // stream already closed
      }
      stream.pause();
    };

    const accept = () => {
      if (settled) return;
      settled = true;
      finish();
      const chosen = {};
      for (const item of items) chosen[item.key] = item.checked;
      resolve(chosen);
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      finish();
      output.write('\n');
      process.exit(130);
    };

    const move = (delta) => {
      cursor = (cursor + delta + items.length) % items.length;
      draw();
    };

    const toggle = () => {
      items[cursor].checked = !items[cursor].checked;
      draw();
    };

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '\x1b') {
          const rest = text.slice(i + 1);
          if (rest.startsWith('[A') || rest.startsWith('OA')) {
            move(-1);
            i += 2;
          } else if (rest.startsWith('[B') || rest.startsWith('OB')) {
            move(1);
            i += 2;
          } else {
            i = text.length;
          }
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          accept();
          return;
        }
        if (ch === '\x03') {
          cancel();
          return;
        }
        if (ch === ' ') {
          toggle();
          continue;
        }
        if (ch === 'k') move(-1);
        else if (ch === 'j') move(1);
      }
    };

    stream.on('data', onData);
    draw();
  });
}

function makePrompter(stream, openedFd) {
  let rl = null;
  const reader = () => {
    if (!rl) {
      rl = readline.createInterface({ input: stream, output: process.stdout, terminal: true });
    }
    return rl;
  };

  return {
    canChooseOptions: typeof stream.setRawMode === 'function',
    chooseOptions(items) {
      return chooseOptions(stream, process.stdout, items);
    },
    async ask(question, fallback) {
      const answer = (await reader().question(question)).trim();
      return answer === '' ? fallback : answer;
    },
    async confirm(question, fallback) {
      const answer = (await reader().question(question)).trim().toLowerCase();
      if (answer === '') return fallback;
      return answer.startsWith('y');
    },
    close() {
      if (rl) rl.close();
      if (openedFd !== null) {
        try {
          closeSync(openedFd);
        } catch {
          // already closed
        }
      }
    },
  };
}

async function createPrompter() {
  if (process.stdin.isTTY) {
    return makePrompter(process.stdin, null);
  }

  if (process.platform !== 'win32') {
    try {
      const fd = openSync('/dev/tty', 'r');
      return makePrompter(new TtyReadStream(fd), fd);
    } catch {
      // No controlling terminal (for example a scheduled task). Fall back to
      // unattended defaults rather than hanging forever.
    }
  }

  return null;
}

function armInactivityTimer(timerRef, controller, ms) {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    controller.abort(new Error(`No data received for ${Math.round(ms / 1000)} seconds.`));
  }, ms);
  timerRef.current.unref?.();
}

async function downloadFile(url, destPath, label, { showProgress, inactivityMs = 60000 }) {
  const controller = new AbortController();
  const timerRef = { current: null };
  armInactivityTimer(timerRef, controller, inactivityMs);

  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'NextGCS-SITL-Installer/1.0' },
    });
  } catch (error) {
    clearTimeout(timerRef.current);
    throw new InstallError(`Could not reach the download server for ${label}.`, [
      'Check the internet connection, then run the installer again.',
      'If this computer requires a proxy, use a network with direct access, or place the ArduPilot arducopter and copter.parm files in the install folder yourself.',
      `URL: ${url}`,
      error instanceof Error ? error.message : String(error),
    ]);
  }

  if (!response.ok) {
    clearTimeout(timerRef.current);
    const hints = [`URL: ${url}`];
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      hints.push(
        'This can happen when the file is behind a private repository.',
        'Use a public raw URL, or host the installer at a URL you can reach and set NEXTGCS_INSTALL_BASE_URL.'
      );
    } else {
      hints.push('Try again in a few minutes.');
    }
    throw new InstallError(
      `The download server answered HTTP ${response.status} for ${label}.`,
      hints
    );
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const tmpPath = `${destPath}.part-${process.pid}`;
  const fd = openSync(tmpPath, 'w');
  let received = 0;
  let lastShown = -1;

  try {
    for await (const chunk of response.body) {
      armInactivityTimer(timerRef, controller, inactivityMs);
      const buffer = Buffer.from(chunk);
      writeSync(fd, buffer);
      received += buffer.byteLength;
      if (showProgress && total > 0) {
        const percent = Math.min(100, Math.floor((received / total) * 100));
        const shown = Math.floor(percent / 10) * 10;
        if (shown !== lastShown) {
          lastShown = shown;
          process.stdout.write(
            `\r  ${label}: ${shown}% (${(received / 1048576).toFixed(1)} MiB of ${(total / 1048576).toFixed(1)} MiB)`
          );
        }
      }
    }
  } catch (error) {
    clearTimeout(timerRef.current);
    closeSync(fd);
    rmSync(tmpPath, { force: true });
    throw new InstallError(`The download for ${label} stopped before it finished.`, [
      'Check the internet connection and run the installer again.',
      error instanceof Error ? error.message : String(error),
    ]);
  }

  clearTimeout(timerRef.current);
  closeSync(fd);

  if (received === 0) {
    rmSync(tmpPath, { force: true });
    throw new InstallError(`The download server returned an empty file for ${label}.`, [
      'Try again in a few minutes.',
    ]);
  }

  // Windows rename does not replace an existing file; remove it first.
  rmSync(destPath, { force: true });
  renameSync(tmpPath, destPath);
  if (showProgress) process.stdout.write('\n');
  return received;
}

function isExecutableElf(filePath) {
  try {
    const bytes = readFileSync(filePath);
    return (
      bytes.byteLength > 1024 * 1024 &&
      bytes[0] === 0x7f &&
      bytes[1] === 0x45 &&
      bytes[2] === 0x4c &&
      bytes[3] === 0x46
    );
  } catch {
    return false;
  }
}

function looksLikeCopterParams(filePath) {
  try {
    return readFileSync(filePath, 'utf8').includes('FRAME_CLASS');
  } catch {
    return false;
  }
}

function verifyNativeBinary(binaryPath) {
  const result = spawnSync(binaryPath, ['--help'], {
    cwd: path.dirname(binaryPath),
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new InstallError('The simulator was downloaded but it cannot run on this computer.', [
      result.error.message,
      'On Debian/Ubuntu, install the C++ runtime with: sudo apt-get install -y libstdc++6',
      'Run the installer again with --force to download a fresh copy.',
    ]);
  }
  if (result.status !== 0) {
    throw new InstallError(`The simulator exited with status ${result.status} during a test run.`, [
      (result.stderr || '').trim() || 'No error output was produced.',
      'On Debian/Ubuntu, install the C++ runtime with: sudo apt-get install -y libstdc++6',
      'Run the installer again with --force to download a fresh copy.',
    ]);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes('--sysid') || !output.includes('--instance')) {
    throw new InstallError('The downloaded simulator is missing expected ArduPilot options.', [
      'The download may be corrupt. Run the installer again with --force.',
    ]);
  }
}

async function ensureAssets(root, { showProgress, force }) {
  mkdirSync(root, { recursive: true });
  const arducopterPath = path.join(root, 'arducopter');
  const parmPath = path.join(root, 'copter.parm');

  const alreadyValid =
    isExecutableElf(arducopterPath) && looksLikeCopterParams(parmPath) && !force;

  if (alreadyValid) {
    return { arducopterPath, parmPath, downloaded: false };
  }

  console.log('Downloading the official ArduPilot Copter simulator...');
  console.log(`  ${ARDUCOPTER_URL}`);
  const binBytes = await downloadFile(ARDUCOPTER_URL, arducopterPath, 'Simulator', {
    showProgress,
  });
  chmodSync(arducopterPath, 0o755);

  console.log(`  ${COPTER_PARM_URL}`);
  const parmBytes = await downloadFile(COPTER_PARM_URL, parmPath, 'Default parameters', {
    showProgress,
  });

  if (!isExecutableElf(arducopterPath)) {
    rmSync(arducopterPath, { force: true });
    throw new InstallError('The downloaded simulator is not a valid Linux executable.', [
      'Check the internet connection and run the installer again.',
      'If the problem repeats, check the ArduPilot firmware site status.',
    ]);
  }
  if (!looksLikeCopterParams(parmPath)) {
    rmSync(parmPath, { force: true });
    throw new InstallError('The downloaded parameter file does not look like an ArduCopter default.', [
      'Check the internet connection and run the installer again.',
    ]);
  }

  console.log(`  Simulator ready (${(binBytes / 1048576).toFixed(1)} MiB).`);
  console.log(`  Default parameters ready (${parmBytes} bytes).`);
  return { arducopterPath, parmPath, downloaded: true };
}

function ensurePackageJson(root) {
  const pkgPath = path.join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg === 'object' && pkg.dependencies?.ws) return pkgPath;
    } catch {
      // Replace an unreadable file below.
    }
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg === 'object') {
        pkg.private = true;
        pkg.dependencies = { ...(pkg.dependencies || {}), ws: pkg.dependencies?.ws || '^8.18.0' };
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
        return pkgPath;
      }
    } catch {
      // Fall through to writing a clean package.json.
    }
  }

  const pkg = {
    name: 'nextgcs-sitl-runtime',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: { ws: '^8.18.0' },
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkgPath;
}

function installedWsVersion(root) {
  try {
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    return requireFromRoot('ws/package.json').version || null;
  } catch {
    return null;
  }
}

function ensureWsDependency(root, { force }) {
  if (!existsSync(path.join(root, 'package.json'))) ensurePackageJson(root);
  if (!force && installedWsVersion(root)) return installedWsVersion(root);

  // Prefer the npm that ships next to node. This matters when Node was
  // installed with nvm, where a non-login WSL shell may not have nvm's bin
  // folder on PATH. Also prepend that folder for npm itself, because npm's
  // #!/usr/bin/env node shebang needs to find node.
  const nodeBinDir = path.dirname(process.execPath);
  const npmEnv = {
    ...process.env,
    PATH: [nodeBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const npmWorks = (command) =>
    spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: npmEnv,
    }).status === 0;

  const siblingNpm = path.join(
    nodeBinDir,
    process.platform === 'win32' ? 'npm.cmd' : 'npm'
  );
  let npmCommand = 'npm';
  if (existsSync(siblingNpm) && npmWorks(siblingNpm)) {
    npmCommand = siblingNpm;
  } else if (!npmWorks(npmCommand)) {
    throw new InstallError('Node.js is installed, but npm was not found.', [
      'Reinstall Node.js 20 or newer from https://nodejs.org/ (the installer includes npm).',
      'If Node came from nvm, check that npm is next to the node program, then run the installer again.',
    ]);
  }

  console.log('Installing the ws networking package (the only Node dependency needed)...');
  const result = spawnSync(
    npmCommand,
    [
      'install',
      '--prefix',
      root,
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      'ws@^8.18.0',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      timeout: 3 * 60 * 1000,
      env: npmEnv,
    }
  );

  if (result.error || result.status !== 0) {
    throw new InstallError('npm could not install the ws networking package.', [
      result.error?.message || `npm exited with status ${result.status}.`,
      'Check the internet connection and that the install folder is writable.',
      `Install folder: ${root}`,
    ]);
  }

  const version = installedWsVersion(root);
  if (!version) {
    throw new InstallError('The ws networking package is still missing after npm finished.', [
      `Check the install folder: ${root}`,
      'Run the installer again with --force.',
    ]);
  }
  return version;
}

function dockerAvailable() {
  if (!commandWorks('docker', ['--version'], 15000)) return false;
  return commandWorks('docker', ['info', '--format', '{{.ServerVersion}}'], 30000);
}

function assertDockerReady() {
  if (!commandWorks('docker', ['--version'], 15000)) {
    throw new InstallError('Docker is needed on this computer, but it is not installed.', [
      'Install Docker Desktop: https://www.docker.com/products/docker-desktop/',
      'On Apple Silicon, enable "Use Rosetta for x86_64/amd64 emulation" in Docker Desktop.',
      'Start Docker Desktop, then run the installer again.',
    ]);
  }
  if (!commandWorks('docker', ['info', '--format', '{{.ServerVersion}}'], 30000)) {
    throw new InstallError('Docker is installed, but its engine is not running.', [
      'Start Docker Desktop and wait until it says "Engine running".',
      'Then run the installer again.',
    ]);
  }
}

function writeDockerfile(root) {
  const dockerfile = path.join(root, 'Dockerfile.nextgcs-sitl');
  const content = `# Runs the official ArduPilot SITL Linux build on macOS and non-x86_64 Linux.
# Generated by NextGCS scripts/install-sitl.mjs.
FROM ubuntu:24.04

RUN apt-get update \\
    && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \\
    && rm -rf /var/lib/apt/lists/*

COPY arducopter /usr/local/bin/arducopter

ENTRYPOINT ["/usr/local/bin/arducopter"]
`;
  writeFileSync(dockerfile, content);
  return dockerfile;
}

function dockerImageExists() {
  return commandWorks('docker', ['image', 'inspect', DOCKER_IMAGE], 30000);
}

function buildDockerImage(root, { force }) {
  if (!force && dockerImageExists()) {
    return { built: false };
  }

  const dockerfile = writeDockerfile(root);
  console.log('Building the local simulator container (one time, uses the official Linux build)...');
  const result = spawnSync(
    'docker',
    ['build', '--platform', DOCKER_PLATFORM, '-f', dockerfile, '-t', DOCKER_IMAGE, root],
    { stdio: 'inherit', timeout: 10 * 60 * 1000 }
  );

  if (result.error || result.status !== 0) {
    throw new InstallError('Docker could not build the simulator container.', [
      result.error?.message || `docker build exited with status ${result.status}.`,
      'Make sure Docker Desktop is running and has enough disk space.',
      'On Apple Silicon, enable "Use Rosetta for x86_64/amd64 emulation" in Docker Desktop.',
      'On ARM Linux, enable amd64 emulation (qemu binfmt) or use an x86_64 Linux computer.',
      `Try manually: docker build --platform ${DOCKER_PLATFORM} -f "${dockerfile}" -t ${DOCKER_IMAGE} "${root}"`,
    ]);
  }
  return { built: true };
}

function verifyDockerImage() {
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--platform', DOCKER_PLATFORM, DOCKER_IMAGE, '--help'],
    { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (result.error || result.status !== 0) {
    throw new InstallError('The simulator container was built but it cannot start.', [
      (result.stderr || result.error?.message || '').trim() || 'Docker did not report a reason.',
      'On Apple Silicon, enable "Use Rosetta for x86_64/amd64 emulation" in Docker Desktop.',
      'On ARM Linux, enable amd64 emulation (qemu binfmt).',
      'Run the installer again with --force to rebuild the image.',
    ]);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes('--sysid') || !output.includes('--instance')) {
    throw new InstallError('The simulator container is missing expected ArduPilot options.', [
      'Run the installer again with --force to rebuild the image.',
    ]);
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function copyRunnerIntoRoot(root) {
  const dest = path.join(root, RUNNER_FILE);
  let source;
  try {
    source = path.resolve(process.argv[1]);
  } catch {
    source = path.join(scriptDir, 'install-sitl.mjs');
  }
  if (path.resolve(source) === path.resolve(dest)) return dest;

  try {
    copyFileSync(source, dest);
    chmodSync(dest, 0o755);
    return dest;
  } catch (error) {
    throw new InstallError('Could not save the launcher into the install folder.', [
      error instanceof Error ? error.message : String(error),
      `Install folder: ${root}`,
    ]);
  }
}

function writeStartScript(root, { vehicles, port, wipe }) {
  const startPath = path.join(root, 'start.sh');
  // Put the Node folder that installed this copy on PATH. This makes the
  // launcher work when WSL starts it with a bare PATH (for example through
  // wsl.exe from Windows) and when Node came from nvm.
  const nodeDir = path.dirname(process.execPath);
  const lines = [
    '#!/bin/sh',
    '# NextGCS local SITL launcher. Generated by install-sitl.mjs.',
    '# Extra flags are passed through, for example: ./start.sh --vehicles 2',
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `node_dir=${shellQuote(nodeDir)}`,
    'if [ -d "$node_dir" ]; then',
    '  PATH="$node_dir:$PATH"',
    '  export PATH',
    'fi',
    `exec node "$here/${RUNNER_FILE}" --start-only --dir "$here" --vehicles ${vehicles} --port ${port} ${wipe ? '--wipe' : '--no-wipe'} "$@"`,
    '',
  ];
  writeFileSync(startPath, lines.join('\n'));
  chmodSync(startPath, 0o755);
  return startPath;
}

function writeWslLauncher(root, { wslDistro }) {
  const startPath = path.join(root, 'start.ps1');
  const startSh = path.join(root, 'start.sh');
  const wslCommand = wslDistro ? `wsl.exe -d ${psQuote(wslDistro)}` : 'wsl.exe';
  const content = [
    '# NextGCS local SITL launcher for Windows. Generated by install-sitl.mjs.',
    '# Run from PowerShell. Extra flags are passed through.',
    'param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Rest)',
    `${wslCommand} -- /bin/sh ${psQuote(startSh)} @Rest`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
  writeFileSync(startPath, content);
  return startPath;
}

function writeInstallRecord(root, record) {
  writeFileSync(path.join(root, 'install.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function readInstallRecord(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

function printConnectionInfo({ port, vehicles, host }) {
  const base = `ws://127.0.0.1:${port}`;
  console.log('');
  console.log('Connect NextGCS to:');
  console.log(`  ${base}`);
  if (vehicles === 2) {
    console.log(`  ws://127.0.0.1:${port + 1}   (second simulated drone)`);
  }
  if (host === '0.0.0.0' || host === '::') {
    const ip = localIpv4();
    console.log('');
    console.log('On Windows, try the 127.0.0.1 address first.');
    if (ip) {
      console.log(`If that does not connect, use: ws://${ip}:${port}`);
    } else {
      console.log('If that does not connect, run "wsl hostname -I" and use that address.');
    }
    console.log('Allow the Windows Firewall prompt for the WSL network if one appears.');
  }
  console.log('');
  console.log('This only talks to the simulator. It never connects to a real aircraft.');
}

function printStartLater({ root, platform, wslDistro }) {
  console.log('');
  if (platform === 'windows') {
    console.log(`Start later from PowerShell: ${path.join(root, 'start.ps1')}`);
  } else {
    console.log('Start it later with:');
    console.log(`  ${path.join(root, 'start.sh')}`);
    if (isWsl() || wslDistro) {
      console.log('');
      console.log('From Windows PowerShell:');
      console.log(`  wsl${wslDistro ? ` -d ${wslDistro}` : ''} -- ${path.join(root, 'start.sh')}`);
    }
  }
  console.log('');
}

async function checkInstallation(root, plan) {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });
  const arducopterPath = path.join(root, 'arducopter');
  const parmPath = path.join(root, 'copter.parm');
  const startSh = path.join(root, 'start.sh');
  const runner = path.join(root, RUNNER_FILE);

  console.log('');
  console.log('NextGCS local SITL check');
  console.log('------------------------');
  console.log(`Install folder: ${root}`);
  console.log(`Platform: ${plan.label} (${plan.kind})`);
  console.log('');

  add(existsSync(root), 'Install folder exists', root);
  add(isExecutableElf(arducopterPath), 'Simulator binary', arducopterPath);
  add(looksLikeCopterParams(parmPath), 'Default parameters', parmPath);
  const wsVersion = installedWsVersion(root);
  add(Boolean(wsVersion), 'ws networking package', wsVersion ? `v${wsVersion}` : 'missing');
  add(existsSync(runner), 'Runner copy', runner);
  add(existsSync(startSh), 'Launcher', startSh);

  if (plan.kind === 'docker') {
    add(dockerAvailable(), 'Docker engine', dockerAvailable() ? 'running' : 'not available');
    add(dockerImageExists(), 'Docker image', DOCKER_IMAGE);
  }

  if (plan.kind === 'native' && isExecutableElf(arducopterPath)) {
    const help = spawnSync(arducopterPath, ['--help'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    add(
      help.status === 0 && `${help.stdout}${help.stderr}`.includes('--sysid'),
      'Simulator starts',
      help.status === 0 ? 'ok' : `exit ${help.status}`
    );
  }

  for (const check of checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.label}${check.detail ? ` (${check.detail})` : ''}`);
  }

  const failed = checks.filter((check) => !check.ok);
  console.log('');
  if (failed.length === 0) {
    const record = readInstallRecord(root);
    const port = record?.port || DEFAULT_PORT;
    console.log(`Installation looks good. Start with: ${path.join(root, 'start.sh')}`);
    console.log(`Connect NextGCS to: ws://127.0.0.1:${port}`);
    return 0;
  }

  console.log(`${failed.length} check(s) failed.`);
  console.log('Run the one-line installer again, or run this file with --force to repair it.');
  return 1;
}

/* ------------------------------------------------------------------------- */
/* Runner: SITL process lifetime and WebSocket <-> TCP MAVLink bridge.       */
/* ------------------------------------------------------------------------- */

const activeVehicles = [];
const activeProbeSockets = new Set();
let shuttingDown = false;
let shutdownPromise = null;

function containsMavlinkV2Heartbeat(buffer, expectedSysId) {
  for (let i = 0; i + 12 <= buffer.length; i++) {
    if (buffer[i] !== 0xfd) continue;
    const payloadLen = buffer[i + 1];
    const incompatFlags = buffer[i + 2];
    const sysId = buffer[i + 5];
    const msgId = buffer[i + 7] | (buffer[i + 8] << 8) | (buffer[i + 9] << 16);
    const sigLen = (incompatFlags & 0x01) !== 0 ? 13 : 0;
    const totalLen = 12 + payloadLen + sigLen;
    if (
      i + totalLen <= buffer.length &&
      msgId === 0 &&
      sysId === expectedSysId &&
      payloadLen >= 1 &&
      payloadLen <= 9
    ) {
      return true;
    }
  }
  return false;
}

function connectTcpWithRetry(host, port, isAborted, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      if (isAborted()) {
        reject(new Error(`Aborted while connecting to ${host}:${port}`));
        return;
      }
      const socket = net.createConnection({ host, port });
      const onError = (error) => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out connecting to ${host}:${port}: ${error.message}`));
          return;
        }
        setTimeout(attempt, 100);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
    }
    attempt();
  });
}

function waitForHeartbeatOnSocket(socket, expectedSysId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for a MAVLink HEARTBEAT from sysId=${expectedSysId}`));
    }, timeoutMs);

    const onData = (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      if (acc.length > 65536) acc = acc.subarray(acc.length - 8192);
      if (containsMavlinkV2Heartbeat(acc, expectedSysId)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed before a HEARTBEAT from sysId=${expectedSysId}`));
    };

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function shutdown(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;

  shutdownPromise = (async () => {
    for (const socket of activeProbeSockets) {
      if (!socket.destroyed) socket.destroy();
    }
    activeProbeSockets.clear();

    for (const vehicle of activeVehicles) {
      if (vehicle.wss) {
        for (const client of vehicle.wss.clients) {
          try {
            client.terminate();
          } catch {
            // ignore
          }
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 500);
          timer.unref();
          try {
            vehicle.wss.close(() => {
              clearTimeout(timer);
              resolve();
            });
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      }
      if (vehicle.bridgeSocket && !vehicle.bridgeSocket.destroyed) {
        vehicle.bridgeSocket.destroy();
      }
    }

    for (const vehicle of activeVehicles) {
      if (vehicle.dockerName && vehicle.child && vehicle.child.exitCode === null) {
        try {
          spawnSync('docker', ['kill', vehicle.dockerName], { stdio: 'ignore', timeout: 5000 });
        } catch {
          // ignore
        }
      }
    }

    const aliveChildren = activeVehicles
      .map((vehicle) => vehicle.child)
      .filter((child) => child && child.exitCode === null && child.signalCode === null);

    if (aliveChildren.length > 0) {
      for (const child of aliveChildren) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }

      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          for (const child of aliveChildren) {
            if (child.exitCode === null && child.signalCode === null) {
              try {
                child.kill('SIGKILL');
              } catch {
                // ignore
              }
            }
          }
          resolve();
        }, 2000);
        killTimer.unref();

        let remaining = aliveChildren.length;
        const onDone = () => {
          remaining -= 1;
          if (remaining <= 0) {
            clearTimeout(killTimer);
            resolve();
          }
        };
        for (const child of aliveChildren) {
          if (child.exitCode !== null || child.signalCode !== null) onDone();
          else child.once('exit', onDone);
        }
      });
    }

    process.exit(code);
  })();

  return shutdownPromise;
}

function loadWs(root) {
  try {
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    const mod = requireFromRoot('ws');
    if (!mod.WebSocket || !mod.WebSocketServer) throw new Error('unexpected ws exports');
    return { WebSocket: mod.WebSocket, WebSocketServer: mod.WebSocketServer };
  } catch (error) {
    throw new InstallError('The ws networking package is missing from the install folder.', [
      `Install folder: ${root}`,
      'Run the installer again, or run it with --force to repair the install.',
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

function checkPortFree(host, port, label) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new InstallError(`${label} port ${port} is already in use.`, [
            'Another simulator or program is using that port.',
            'Stop it, or choose a different port with --port (for example --port 5766).',
          ])
        );
      } else if (error.code === 'EACCES') {
        reject(
          new InstallError(`This computer does not allow listening on ${host}:${port}.`, [
            'Choose a port above 1024 with --port.',
          ])
        );
      } else {
        reject(
          new InstallError(`Could not use ${host}:${port}: ${error.message}`, [
            'Choose a different port with --port.',
          ])
        );
      }
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve());
    });
  });
}

async function runSitl(root, opts) {
  const plan = describePlatform();
  const wsLib = loadWs(root);
  const arducopterPath = path.join(root, 'arducopter');
  const parmPath = path.join(root, 'copter.parm');

  if (!isExecutableElf(arducopterPath) || !looksLikeCopterParams(parmPath)) {
    throw new InstallError('The simulator is not installed in this folder yet.', [
      `Install folder: ${root}`,
      'Run the one-line installer first (see install-sitl.sh or install-sitl.ps1).',
    ]);
  }

  if (plan.kind === 'docker') assertDockerReady();
  if (plan.kind === 'docker' && !dockerImageExists()) {
    throw new InstallError(`The simulator container ${DOCKER_IMAGE} is missing.`, [
      'Run the installer again to build it.',
    ]);
  }

  const host = opts.host || (isWsl() || opts.wslDistro ? '0.0.0.0' : '127.0.0.1');
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  for (let i = 0; i < opts.vehicles; i++) {
    await checkPortFree(host, opts.port + i, 'WebSocket');
    await checkPortFree('127.0.0.1', DEFAULT_BASE_TCP_PORT + 10 * i, 'Simulator TCP');
    await checkPortFree('127.0.0.1', DEFAULT_BASE_TCP_PORT + 2 + 10 * i, 'Simulator bridge');
  }

  process.on('SIGINT', () => {
    console.log('');
    console.log('Stopping the simulator...');
    void shutdown(0);
  });
  process.on('SIGTERM', () => void shutdown(0));

  for (let i = 0; i < opts.vehicles; i++) {
    const sysId = i + 1;
    const workDir = path.join(root, 'state', `v${sysId}`);
    mkdirSync(workDir, { recursive: true });

    const directTcpPort = DEFAULT_BASE_TCP_PORT + 10 * i;
    const bridgeTcpPort = DEFAULT_BASE_TCP_PORT + 2 + 10 * i;
    const udpTargetPort = DEFAULT_UDP_PORT + 10 * i;
    const wsPort = opts.port + i;

    const args = [
      '--model',
      'quad',
      '--home',
      VEHICLE_HOMES[i],
      '--defaults',
      parmPath,
      '--base-port',
      String(DEFAULT_BASE_TCP_PORT + 10 * i),
      '--instance',
      String(i),
      '--sysid',
      String(sysId),
      '--serial0',
      'tcp:0',
      '--serial1',
      'tcp:2',
      '--serial2',
      `udpclient:127.0.0.1:${udpTargetPort}`,
    ];
    if (opts.wipe) args.push('--wipe');

    let child;
    let dockerName = null;

    if (plan.kind === 'docker') {
      dockerName = `nextgcs-sitl-${process.pid}-${sysId}`;
      const containerArgs = args.map((value) =>
        value === parmPath ? CONTAINER_PARM_PATH : value
      );
      child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          dockerName,
          '--platform',
          DOCKER_PLATFORM,
          '-w',
          CONTAINER_WORK_DIR,
          '-v',
          `${workDir}:${CONTAINER_WORK_DIR}`,
          '-v',
          `${parmPath}:${CONTAINER_PARM_PATH}:ro`,
          '-p',
          `127.0.0.1:${bridgeTcpPort}:${bridgeTcpPort}`,
          DOCKER_IMAGE,
          ...containerArgs,
        ],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } else {
      child = spawn(arducopterPath, args, {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    const vehicle = {
      sysId,
      workDir,
      directTcpPort,
      bridgeTcpPort,
      udpTargetPort,
      wsPort,
      child,
      dockerName,
      bridgeSocket: null,
      wss: null,
    };
    activeVehicles.push(vehicle);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) console.log(`[sitl v${sysId}] ${line}`);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) console.error(`[sitl v${sysId} err] ${line}`);
    });
    child.once('error', (error) => {
      if (!shuttingDown) {
        console.error(`[sitl v${sysId}] could not start: ${error.message}`);
        void shutdown(1);
      }
    });
    child.once('exit', (code, signal) => {
      if (!shuttingDown) {
        console.error(`[sitl v${sysId}] exited unexpectedly (code=${code}, signal=${signal})`);
        void shutdown(1);
      }
    });
  }

  for (const vehicle of activeVehicles) {
    const isAborted = () =>
      shuttingDown ||
      vehicle.child.exitCode !== null ||
      vehicle.child.signalCode !== null;

    const bridgeSocket = await connectTcpWithRetry('127.0.0.1', vehicle.bridgeTcpPort, isAborted);
    vehicle.bridgeSocket = bridgeSocket;
    await waitForHeartbeatOnSocket(bridgeSocket, vehicle.sysId);

    const wss = new wsLib.WebSocketServer({ host, port: vehicle.wsPort });
    vehicle.wss = wss;

    await new Promise((resolve, reject) => {
      const onListening = () => {
        wss.removeListener('error', onError);
        resolve();
      };
      const onError = (error) => {
        wss.removeListener('listening', onListening);
        reject(
          error.code === 'EADDRINUSE'
            ? new InstallError(`WebSocket port ${vehicle.wsPort} is already in use.`, [
                'Stop the other program, or choose a different port with --port.',
              ])
            : error
        );
      };
      wss.once('listening', onListening);
      wss.once('error', onError);
    });

    wss.on('error', (error) => {
      if (!shuttingDown) {
        console.error(`[ws v${vehicle.sysId}] server error: ${error.message}`);
        void shutdown(1);
      }
    });

    bridgeSocket.on('data', (chunk) => {
      for (const client of wss.clients) {
        if (client.readyState === wsLib.WebSocket.OPEN) client.send(chunk);
      }
    });
    bridgeSocket.on('error', (error) => {
      if (!shuttingDown) console.error(`[bridge v${vehicle.sysId}] TCP error: ${error.message}`);
    });
    bridgeSocket.on('close', () => {
      if (!shuttingDown) {
        console.error(`[bridge v${vehicle.sysId}] TCP bridge closed unexpectedly`);
        void shutdown(1);
      }
    });

    wss.on('connection', (ws) => {
      ws.on('error', () => {
        // ignore abrupt client disconnect
      });
      ws.on('message', (data) => {
        if (bridgeSocket.destroyed) return;
        if (typeof data === 'string') bridgeSocket.write(Buffer.from(data, 'utf8'));
        else if (Buffer.isBuffer(data)) bridgeSocket.write(data);
        else if (Array.isArray(data)) bridgeSocket.write(Buffer.concat(data));
        else bridgeSocket.write(Buffer.from(data));
      });
    });

    console.log(
      `[ready] v${vehicle.sysId} sysId=${vehicle.sysId} ws=ws://${displayHost}:${vehicle.wsPort}`
    );
  }

  console.log('');
  console.log(`SITL is running with ${opts.vehicles} simulated drone(s).`);
  console.log('Connect NextGCS to:');
  console.log(`  ws://127.0.0.1:${opts.port}`);
  if (opts.vehicles === 2) console.log(`  ws://127.0.0.1:${opts.port + 1}   (second drone)`);
  if (host === '0.0.0.0' || host === '::') {
    const ip = localIpv4();
    console.log('');
    console.log('On Windows, try 127.0.0.1 first.');
    if (ip) console.log(`If it does not connect, use: ws://${ip}:${opts.port}`);
    else console.log('If it does not connect, run "wsl hostname -I" and use that address.');
  }
  console.log('');
  console.log('Keep this window open. Press Ctrl+C to stop the simulator.');

  return new Promise(() => {
    // Keep the process alive through the WebSocket servers and child processes.
  });
}

/* ------------------------------------------------------------------------- */
/* Main                                                                       */
/* ------------------------------------------------------------------------- */

function toPowerShellArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') out.push('-Yes');
    else if (arg === '--no-start') out.push('-NoStart');
    else if (arg === '--check') out.push('-Check');
    else if (arg === '--force') out.push('-Force');
    else if (arg === '--vehicles') out.push('-Vehicles', argv[++i]);
    else if (arg === '--port' || arg === '--ws-port') out.push('-Port', argv[++i]);
    else if (arg === '--dir') out.push('-Dir', argv[++i]);
    else if (arg === '--wsl-distro') out.push('-WslDistro', argv[++i]);
    else if (arg === '--base-url') out.push('-BaseUrl', argv[++i]);
    // --wipe, --no-wipe, --start-only, and --host are chosen interactively or
    // applied by the WSL runner. They have no PowerShell switch equivalent.
  }
  return out;
}

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    throw new InstallError(
      `Node.js ${MIN_NODE_MAJOR} or newer is needed; this is ${process.version}.`,
      ['Install Node.js from https://nodejs.org/ and run the installer again.']
    );
  }

  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const plan = describePlatform();

  if (plan.kind === 'windows') {
    const ps1 = path.join(scriptDir, 'install-sitl.ps1');
    if (existsSync(ps1)) {
      console.log('Windows uses WSL2. Starting the PowerShell installer...');
      const shell = commandWorks('pwsh', ['-NoProfile', '-Command', 'exit 0'], 15000)
        ? 'pwsh'
        : 'powershell';
      const forwarded = toPowerShellArgs(process.argv.slice(2));
      const result = spawnSync(
        shell,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...forwarded],
        { stdio: 'inherit' }
      );
      process.exit(result.status ?? 1);
    }
    throw new InstallError('Windows cannot run ArduPilot SITL directly; it runs inside WSL2.', [
      `In PowerShell, run: irm ${opts.baseUrl.replace(/\/+$/, '')}/install-sitl.ps1 | iex`,
      'That command checks WSL2 and runs this installer inside Ubuntu.',
    ]);
  }

  if (plan.kind === 'unsupported') {
    throw new InstallError(`No supported simulator route for ${plan.label}.`, plan.hints);
  }

  const root = opts.dir || defaultInstallDir();
  if (path.parse(root).root === root) {
    throw new InstallError(`Refusing to install directly into ${root}.`, [
      'Pass a folder with --dir, for example --dir ~/nextgcs-sitl.',
    ]);
  }

  if (opts.check) {
    const code = await checkInstallation(root, plan);
    process.exitCode = code;
    return;
  }

  if (opts.startOnly) {
    await runSitl(root, {
      vehicles: opts.vehicles ?? 1,
      port: opts.port,
      wipe: opts.wipe ?? true,
      host: opts.host,
      wslDistro: opts.wslDistro,
    });
    return;
  }

  console.log('');
  console.log('NextGCS local SITL');
  console.log('------------------');
  console.log('This prepares a simulated drone on this computer and a WebSocket bridge');
  console.log('that NextGCS can connect to. It does not touch or fly a real aircraft.');
  console.log('');
  console.log(`Detected: ${plan.label}`);
  console.log(`Install folder: ${root}`);
  console.log('');
  console.log('What will happen:');
  if (plan.kind === 'native') {
    console.log('  1. Download the official ArduPilot Copter simulator (about 7 MB).');
  } else {
    console.log('  1. Download the official Linux ArduPilot Copter simulator (about 7 MB)');
    console.log('     and build a small local Docker image, because this computer has no');
    console.log('     native ArduPilot SITL build.');
  }
  console.log('  2. Install the ws networking package into that folder (no repo needed).');
  console.log('  3. Write a one-command launcher for later.');
  console.log('  4. Start the simulator and bridge it to NextGCS.');
  console.log('');
  console.log('No administrator or sudo access is needed. Ctrl+C stops the simulator.');
  console.log('');

  if (plan.kind === 'docker') {
    assertDockerReady();
  }

  const prompter = opts.yes ? null : await createPrompter();
  if (!prompter && !opts.yes && !process.stdin.isTTY) {
    console.log('No terminal is available for questions, so the defaults will be used.');
    console.log('Use --yes to choose this explicitly.');
  }

  const arducopterPath = path.join(root, 'arducopter');
  const parmPath = path.join(root, 'copter.parm');
  const installed =
    isExecutableElf(arducopterPath) && looksLikeCopterParams(parmPath) && !opts.force;

  let shouldDownload = !installed;
  try {
    let vehicles = opts.vehicles;
    let wipe = opts.wipe;
    let startNow = !opts.noStart;

    const optionItems = [];
    if (vehicles === null) {
      optionItems.push({
        key: 'vehicles',
        checked: false,
        label: 'Two simulated drones (leave empty for one)',
      });
    }
    if (wipe === null) {
      optionItems.push({
        key: 'wipe',
        checked: true,
        label: 'Reset the simulated drone on every start (always fresh)',
      });
    }
    if (!opts.noStart) {
      optionItems.push({
        key: 'start',
        checked: true,
        label: 'Start the simulator when setup finishes',
      });
    }

    if (prompter && prompter.canChooseOptions && optionItems.length > 0) {
      // One checklist replaces the old question-by-question flow. Enter accepts
      // the defaults; Space toggles an item; Ctrl+C cancels without changing
      // anything.
      if (installed) {
        console.log('An existing simulator was found; it will be verified and reused.');
        console.log('Use --force to download it again.');
        console.log('');
      }
      const chosen = await prompter.chooseOptions(optionItems);
      if ('vehicles' in chosen) vehicles = chosen.vehicles ? 2 : 1;
      if ('wipe' in chosen) wipe = chosen.wipe;
      if ('start' in chosen) startNow = chosen.start;
      console.log(
        `Using ${vehicles === 1 ? 'one simulated drone' : 'two simulated drones'}, ` +
          `${wipe ? 'fresh' : 'kept'} state, ${startNow ? 'start now' : 'no autostart'}.`
      );
    } else {
      if (installed) {
        if (prompter) {
          const reuse = await prompter.confirm(
            'A simulator is already installed here. Verify and reuse it? [Y/n] ',
            true
          );
          shouldDownload = !reuse;
        } else if (!opts.yes) {
          console.log('Existing simulator found; it will be verified and reused.');
        }
      } else if (prompter) {
        const proceed = await prompter.confirm(
          'Download and set up the simulator now? [Y/n] ',
          true
        );
        if (!proceed) {
          console.log('');
          console.log('Cancelled. Nothing was changed.');
          prompter.close();
          return;
        }
      }

      if (vehicles === null) {
        if (prompter) {
          const answer = await prompter.ask('How many simulated drones? Enter 1 or 2 [1]: ', '1');
          vehicles = answer === '2' ? 2 : 1;
        } else {
          vehicles = 1;
        }
      }

      if (wipe === null) {
        if (prompter) {
          wipe = await prompter.confirm(
            'Reset the simulated drone (wipe EEPROM) on every start? [Y/n] ',
            true
          );
        } else {
          wipe = true;
        }
      }

      if (startNow && prompter) {
        startNow = await prompter.confirm('Start it when setup finishes? [Y/n] ', true);
      }
    }

    if (prompter) prompter.close();

    console.log('');
    let assetsDownloaded = false;
    if (shouldDownload) {
      const assets = await ensureAssets(root, {
        showProgress: Boolean(prompter),
        force: opts.force || shouldDownload,
      });
      assetsDownloaded = assets.downloaded;
    } else {
      console.log('Using the existing simulator files.');
      chmodSync(arducopterPath, 0o755);
    }

    if (plan.kind === 'native') {
      console.log('Checking that the simulator runs on this computer...');
      verifyNativeBinary(arducopterPath);
    }

    const wsVersion = ensureWsDependency(root, { force: opts.force });
    console.log(`  ws v${wsVersion} ready.`);

    if (plan.kind === 'docker') {
      buildDockerImage(root, { force: opts.force || assetsDownloaded });
      verifyDockerImage();
    }

    const runnerPath = copyRunnerIntoRoot(root);
    const startPath = writeStartScript(root, { vehicles, port: opts.port, wipe });
    let wslLauncher = null;
    if (isWsl() || plan.kind === 'windows' || opts.wslDistro) {
      wslLauncher = writeWslLauncher(root, { wslDistro: opts.wslDistro });
    }

    writeInstallRecord(root, {
      installer: 'nextgcs-install-sitl',
      version: 1,
      installedAt: new Date().toISOString(),
      platform: plan.kind,
      platformLabel: plan.label,
      root,
      vehicles,
      port: opts.port,
      wipe,
      wsUrl: `ws://127.0.0.1:${opts.port}`,
      runner: runnerPath,
      launcher: startPath,
      wslLauncher,
    });

    console.log('');
    console.log('Setup is complete.');
    printConnectionInfo({ port: opts.port, vehicles, host: opts.host || (isWsl() ? '0.0.0.0' : '127.0.0.1') });
    printStartLater({ root, platform: plan.kind, wslDistro: opts.wslDistro });

    if (!startNow) {
      console.log('');
      console.log('The simulator was not started. Use the command above when ready.');
      return;
    }

    console.log('');
    console.log('Starting the simulator...');
    await runSitl(root, {
      vehicles,
      port: opts.port,
      wipe,
      host: opts.host,
      wslDistro: opts.wslDistro,
    });
  } finally {
    if (prompter) prompter.close();
  }
}

function isDirectRun() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const modulePath = fileURLToPath(import.meta.url);
  if (path.resolve(invoked) === modulePath) return true;
  try {
    return realpathSync(invoked) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('');
    console.error(`NextGCS SITL setup could not finish: ${message}`);
    if (error instanceof InstallError && error.hints.length > 0) {
      console.error('');
      console.error('What to try next:');
      for (const hint of error.hints) console.error(`  - ${hint}`);
    } else if (!(error instanceof InstallError)) {
      console.error('Run with --help to see the options.');
    }
    console.error('');
    void shutdown(1);
  });
}
