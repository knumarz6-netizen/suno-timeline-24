param(
  [int]$Port = 4173,
  [string]$BindHost = "127.0.0.1",
  [string]$DataDir = ".data"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledNode = "C:\Users\rz6_3\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

function Get-NodeExecutable {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue

  if ($nodeCommand -and $nodeCommand.Source) {
    return $nodeCommand.Source
  }

  if (Test-Path -LiteralPath $bundledNode) {
    return $bundledNode
  }

  throw "Node.js could not be found. Install Node.js or update `$bundledNode in start-local.ps1."
}

function Test-PortAvailable {
  param([int]$PortToCheck)

  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $PortToCheck)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

$nodeExecutable = Get-NodeExecutable

if (-not (Test-PortAvailable -PortToCheck $Port)) {
  throw "Port $Port is already in use. Stop the existing process or run .\start-local.ps1 -Port 4189"
}

$env:PORT = [string]$Port
$env:HOST = $BindHost
$env:DATA_DIR = if ([System.IO.Path]::IsPathRooted($DataDir)) { $DataDir } else { Join-Path $projectRoot $DataDir }

Write-Host "Starting SUNO Timeline"
Write-Host "Node : $nodeExecutable"
Write-Host "Host : $BindHost"
Write-Host "Port : $Port"
Write-Host "Data : $env:DATA_DIR"
Write-Host "URL  : http://$BindHost`:$Port/"

Push-Location $projectRoot
try {
  & $nodeExecutable --use-system-ca server.mjs
} finally {
  Pop-Location
}
