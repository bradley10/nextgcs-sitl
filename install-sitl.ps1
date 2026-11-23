#Requires -Version 5.1
<#
.SYNOPSIS
  One-command installer for the NextGCS local ArduPilot SITL simulator on Windows.

.DESCRIPTION
  ArduPilot SITL does not run natively on Windows. This script checks for WSL2
  and an Ubuntu distribution, checks for Node.js inside WSL, downloads the
  NextGCS installer into WSL, and runs it interactively. No repository clone is
  needed.

  Intended use:
    irm https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.ps1 | iex

  The base URL can be overridden with NEXTGCS_INSTALL_BASE_URL. For a private
  GitHub repository, set GITHUB_TOKEN before running the one-liner; the token is
  used only for the download and is never printed.

.PARAMETER Yes
  Accept the installer defaults without asking questions.

.PARAMETER Vehicles
  Number of simulated drones: 1 or 2.

.PARAMETER Port
  WebSocket port for the first drone (default 5765).

.PARAMETER NoStart
  Install and write the launcher, but do not start the simulator.

.PARAMETER Check
  Check the existing installation and exit.

.PARAMETER Dir
  Install folder inside WSL. A Windows path is translated automatically.
  Defaults to ~/.nextgcs/sitl inside WSL.

.PARAMETER BaseUrl
  Base URL for the installer files.

.PARAMETER WslDistro
  WSL distribution to use. Defaults to the first Ubuntu distribution.

.PARAMETER Force
  Download and rebuild even if files already exist.

.EXAMPLE
  irm https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main/install-sitl.ps1 | iex

.EXAMPLE
  .\install-sitl.ps1 -Yes -Vehicles 1 -Port 5765
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [ValidateRange(1, 2)][int]$Vehicles,
  [ValidateRange(1, 65535)][int]$Port,
  [switch]$NoStart,
  [switch]$Check,
  [string]$Dir,
  [string]$BaseUrl,
  [string]$WslDistro,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DefaultBaseUrl = 'https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main'
if (-not $BaseUrl) {
  if ($env:NEXTGCS_INSTALL_BASE_URL) { $BaseUrl = $env:NEXTGCS_INSTALL_BASE_URL }
  else { $BaseUrl = $DefaultBaseUrl }
}
$BaseUrl = $BaseUrl.TrimEnd('/')
$InstallerUrl = "$BaseUrl/install-sitl.mjs"
$WsUrl = 'ws://127.0.0.1:5765'
$ExitCode = 0
$TempFile = $null

function Write-Section([string]$Text) {
  Write-Host ''
  Write-Host $Text
  Write-Host ('-' * $Text.Length)
}

function Write-Step([string]$Text) {
  Write-Host "  $Text"
}

function Stop-WithHelp([string]$Message, [string[]]$Hints) {
  Write-Host ''
  Write-Host "NextGCS SITL installer could not continue: $Message" -ForegroundColor Red
  if ($Hints -and $Hints.Count -gt 0) {
    Write-Host ''
    Write-Host 'What to try next:'
    foreach ($hint in $Hints) { Write-Host "  - $hint" }
  }
  Write-Host ''
  exit 1
}

function Test-Command([string]$Command) {
  return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

function Invoke-Wsl([string[]]$Arguments) {
  $output = & wsl.exe @Arguments 2>$null
  $code = $LASTEXITCODE
  return @{ Code = $code; Text = (($output | Out-String) -replace "`0", '').Trim() }
}

Write-Section 'NextGCS local SITL on Windows'
Write-Step 'This sets up a simulated drone for NextGCS. It never touches a real aircraft.'
Write-Step 'ArduPilot SITL runs inside WSL2, so this checks WSL2, Ubuntu, and Node.js first.'

# --- WSL2 and Ubuntu ---------------------------------------------------------

if (-not (Test-Command 'wsl.exe')) {
  Stop-WithHelp 'WSL2 is not available on this computer.' @(
    'Open PowerShell as Administrator.',
    'Run: wsl --install -d Ubuntu',
    'Restart Windows if the installer asks you to.',
    'Then run this command again.'
  )
}

$listResult = Invoke-Wsl @('-l', '-q')
if ($listResult.Code -ne 0) {
  Stop-WithHelp 'WSL is installed but its distribution list could not be read.' @(
    'Open PowerShell as Administrator and run: wsl --install -d Ubuntu',
    'Restart Windows if asked, then run this command again.'
  )
}

$distros = @(
  ($listResult.Text -split "`r?`n") |
    ForEach-Object { ($_ -replace "`0", '').Trim() } |
    Where-Object { $_ -and $_ -notmatch '^docker-desktop' }
)

if ($distros.Count -eq 0) {
  Stop-WithHelp 'WSL is installed but no Linux distribution is available.' @(
    'Open PowerShell as Administrator.',
    'Run: wsl --install -d Ubuntu',
    'Restart Windows if the installer asks you to.',
    'Then run this command again.'
  )
}

if (-not $WslDistro) {
  $ubuntu = $distros | Where-Object { $_ -match '(?i)ubuntu' } | Select-Object -First 1
  if ($ubuntu) { $WslDistro = $ubuntu } else { $WslDistro = $distros[0] }
}

if ($distros -notcontains $WslDistro) {
  Stop-WithHelp "The WSL distribution ""$WslDistro"" was not found." @(
    "Available distributions: $($distros -join ', ')",
    'Run the script again without -WslDistro, or with one of the names above.'
  )
}

Write-Step "Using WSL2 distribution: $WslDistro"

# Check that the distribution actually starts, and that it is WSL2 when the
# version column can be read. WSL1 cannot provide the localhost networking that
# the simulator bridge relies on.
$probe = Invoke-Wsl @('-d', $WslDistro, '--', 'uname', '-s')
if ($probe.Code -ne 0 -or [string]::IsNullOrWhiteSpace($probe.Text)) {
  Stop-WithHelp "The WSL distribution ""$WslDistro"" could not be started." @(
    "Open it once from the Start menu or run: wsl -d $WslDistro",
    'If it asks for a username and password the first time, finish that setup.',
    'Then run this command again.'
  )
}

$versionResult = Invoke-Wsl @('-l', '-v')
if ($versionResult.Code -eq 0 -and $versionResult.Text) {
  $versionLine = ($versionResult.Text -split "`r?`n") |
    Where-Object { $_ -match ('^\s*\*?\s*' + [regex]::Escape($WslDistro) + '\s') } |
    Select-Object -First 1
  if ($versionLine -and ($versionLine -match '\s1\s*$')) {
    Stop-WithHelp "The distribution ""$WslDistro"" is running WSL1, but WSL2 is required." @(
      "Convert it with: wsl --set-version $WslDistro 2",
      'Wait for the conversion to finish, then run this command again.'
    )
  }
}

# --- Node.js inside WSL ------------------------------------------------------

# Find Node. WSL images vary: some put node on the login PATH, some install it
# with nvm (interactive shells only), and some rely on /usr/local/bin. Try the
# common routes and keep the absolute path so later commands do not depend on
# the shell environment.
$nodePath = $null
$nodeProbes = @(
  @('bash', '-lc', 'command -v node'),
  @('bash', '-ic', 'command -v node'),
  @('bash', '-lc', 'source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; command -v node')
)
foreach ($probe in $nodeProbes) {
  $probeArgs = @('-d', $WslDistro, '--') + $probe
  $probeResult = Invoke-Wsl $probeArgs
  $candidate = (($probeResult.Text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 1)
  if ($candidate) { $candidate = $candidate.Trim() }
  if ($probeResult.Code -eq 0 -and $candidate -and $candidate.StartsWith('/')) {
    $nodePath = $candidate
    break
  }
}

if (-not $nodePath) {
  Stop-WithHelp "Node.js is not installed inside $WslDistro." @(
    "Open a WSL terminal: wsl -d $WslDistro",
    'Install Node.js 24 (which includes npm) with:',
    '  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -',
    '  sudo apt-get install -y nodejs',
    'Close the terminal, then run this command again.'
  )
}

$nodeVersionResult = Invoke-Wsl @('-d', $WslDistro, '--', $nodePath, '-p', 'process.versions.node')
$nodeVersion = (($nodeVersionResult.Text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 1)
if ($nodeVersion) { $nodeVersion = $nodeVersion.Trim() }
if ($nodeVersionResult.Code -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersion)) {
  Stop-WithHelp "Node.js inside $WslDistro could not report its version." @(
    "Run it yourself for details: wsl -d $WslDistro -- $nodePath -v",
    'Reinstall Node.js 24 from https://nodejs.org/ if needed.'
  )
}
$nodeMajor = 0
$null = [int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor)
if ($nodeMajor -lt 20) {
  Stop-WithHelp "Node.js $nodeVersion inside $WslDistro is too old; Node.js 20 or newer is needed." @(
    "Open a WSL terminal: wsl -d $WslDistro",
    'Install Node.js 24 with:',
    '  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -',
    '  sudo apt-get install -y nodejs',
    'Then run this command again.'
  )
}

Write-Step "Node inside WSL: v$nodeVersion ($nodePath)"

# --- Translate the install folder -------------------------------------------

$linuxDir = $null
if ($Dir) {
  if ($Dir.StartsWith('/')) {
    $linuxDir = $Dir.TrimEnd('/')
  } else {
    # Windows application paths use backslashes. Forward slashes work too and
    # survive the trip through wsl.exe without escaping problems.
    $dirForWsl = $Dir.Replace('\', '/')
    $mapped = Invoke-Wsl @('-d', $WslDistro, '--', 'wslpath', '-a', $dirForWsl)
    if ($mapped.Code -ne 0 -or [string]::IsNullOrWhiteSpace($mapped.Text)) {
      Stop-WithHelp "Could not translate the install folder into WSL: $Dir" @(
        "Try a path WSL can read, or pass a Linux path such as /home/<you>/nextgcs-sitl."
      )
    }
    $linuxDir = $mapped.Text.TrimEnd('/')
  }
}

# --- Download the installer into Windows temp, then run it inside WSL --------

try {
  $TempFile = Join-Path $env:TEMP "nextgcs-install-sitl-$PID.mjs"

  # A private repository needs an Authorization header. Prefer GITHUB_TOKEN,
  # then reuse an existing GitHub CLI login so a private deployment stays a
  # one-liner. The token is only held in memory and is never printed.
  $githubToken = $env:GITHUB_TOKEN
  if (-not $githubToken -and (Test-Command 'gh')) {
    try {
      $githubToken = (& gh auth token 2>$null | Select-Object -First 1)
      if ($githubToken) { $githubToken = $githubToken.Trim() }
    } catch {
      $githubToken = $null
    }
  }

  Write-Step "Downloading the installer from $InstallerUrl"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = 'NextGCS-SITL-Installer/1.0' }
    if ($githubToken) {
      $headers['Authorization'] = "Bearer $githubToken"
    }
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $TempFile -Headers $headers `
      -UseBasicParsing -TimeoutSec 180 -ErrorAction Stop
  } catch {
    Stop-WithHelp 'Could not download install-sitl.mjs.' @(
      'Check the internet connection and try again.',
      "URL: $InstallerUrl",
      'If you use a fork or a private repository, set NEXTGCS_INSTALL_BASE_URL to a URL you can reach.',
      'For a private GitHub repository, set GITHUB_TOKEN to a token that can read the repository.',
      $_.Exception.Message
    )
  }

  $fileInfo = Get-Item $TempFile -ErrorAction SilentlyContinue
  if (-not $fileInfo -or $fileInfo.Length -lt 1000) {
    Stop-WithHelp 'The downloaded installer is empty or incomplete.' @(
      'Check the internet connection and try again.',
      "URL: $InstallerUrl"
    )
  }

  $mappedScript = Invoke-Wsl @('-d', $WslDistro, '--', 'wslpath', '-a', $TempFile.Replace('\', '/'))
  if ($mappedScript.Code -ne 0 -or [string]::IsNullOrWhiteSpace($mappedScript.Text)) {
    Stop-WithHelp 'Could not open the downloaded installer from inside WSL.' @(
      "The file is at $TempFile",
      "Try: wsl -d $WslDistro -- wslpath -a ""$TempFile"""
    )
  }
  $linuxScript = $mappedScript.Text

  $nodeArgs = @($linuxScript, '--wsl-distro', $WslDistro)
  if ($Yes) { $nodeArgs += '--yes' }
  if ($PSBoundParameters.ContainsKey('Vehicles')) { $nodeArgs += @('--vehicles', [string]$Vehicles) }
  if ($PSBoundParameters.ContainsKey('Port')) { $nodeArgs += @('--port', [string]$Port) }
  if ($NoStart) { $nodeArgs += '--no-start' }
  if ($Check) { $nodeArgs += '--check' }
  if ($Force) { $nodeArgs += '--force' }
  if ($linuxDir) { $nodeArgs += @('--dir', $linuxDir) }

  Write-Section 'Run the installer'

  if (-not $Check) {
    $ipResult = Invoke-Wsl @('-d', $WslDistro, '--', 'hostname', '-I')
    $wslIp = ($ipResult.Text -split '\s+') | Where-Object { $_ } | Select-Object -First 1

    Write-Step 'This downloads the official ArduPilot simulator (about 7 MB) and installs'
    Write-Step 'one small Node package inside WSL. No repository clone is needed.'
    Write-Step 'No administrator access is needed unless Node.js must be installed first.'
    Write-Host ''
    Write-Host 'When it is running, connect NextGCS to:'
    Write-Host "  $WsUrl" -ForegroundColor Green
    if ($wslIp) {
      Write-Step "If that does not connect, try: ws://$wslIp`:$($WsUrl.Split(':')[-1])"
    } else {
      Write-Step 'If that does not connect, run "wsl hostname -I" and use that address.'
    }
    Write-Step 'Allow the Windows Firewall prompt for the WSL network if one appears.'
    Write-Step 'Press Ctrl+C in this window to stop the simulator.'
    Write-Host ''
  }

  & wsl.exe -d $WslDistro -- $nodePath @nodeArgs
  $ExitCode = $LASTEXITCODE

  if ($ExitCode -ne 0) {
    Write-Host ''
    Write-Host "The installer exited with code $ExitCode." -ForegroundColor Red
    Write-Host 'Run it again to see the specific message, or use -Check to inspect the install.'
    Write-Host ''
    exit $ExitCode
  }

  # --- Persistent launcher for later one-command starts ----------------------

  if (-not $Check) {
    if ($linuxDir) {
      $linuxStart = "$linuxDir/start.sh"
    } else {
      $homeResult = Invoke-Wsl @('-d', $WslDistro, '--', 'bash', '-lc', 'printf %s "$HOME/.nextgcs/sitl/start.sh"')
      if ($homeResult.Code -ne 0 -or [string]::IsNullOrWhiteSpace($homeResult.Text)) {
        Stop-WithHelp 'Could not determine the launcher path inside WSL.' @(
          'Run the installer again; the simulator itself is installed.'
        )
      }
      $linuxStart = $homeResult.Text
    }

    $launcherDir = Join-Path $env:USERPROFILE '.nextgcs'
    $launcherPath = Join-Path $launcherDir 'start-sitl.ps1'
    New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
    $escapedDistro = $WslDistro.Replace("'", "''")
    $escapedStart = $linuxStart.Replace("'", "''")
    $launcher = @(
      '# NextGCS local SITL launcher for Windows. Generated by install-sitl.ps1.'
      'param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Rest)'
      "wsl.exe -d '$escapedDistro' -- /bin/sh '$escapedStart' @Rest"
      'exit $LASTEXITCODE'
    ) -join "`r`n"
    Set-Content -Path $launcherPath -Value $launcher -Encoding ASCII

    Write-Section 'Start it later with one command'
    Write-Step "powershell -ExecutionPolicy Bypass -File ""$launcherPath"""
    Write-Step 'In WSL you can also run:'
    Write-Step "  wsl -d $WslDistro -- $linuxStart"
    Write-Host ''
    Write-Host "Then connect NextGCS to: $WsUrl" -ForegroundColor Green
    Write-Host ''
  }
} finally {
  if ($TempFile -and (Test-Path $TempFile)) {
    Remove-Item $TempFile -Force -ErrorAction SilentlyContinue
  }
}

exit $ExitCode
