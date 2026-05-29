param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $RootDir "src"

if (-not (Test-Path (Join-Path $AppDir "package.json"))) {
  throw "Could not find src app at `"$AppDir`"."
}

Push-Location $AppDir
try {
  if (-not $SkipInstall -and -not (Test-Path "node_modules")) {
    Write-Host "Installing src app dependencies..."
    cmd /c npm.cmd install
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }

  if ((Test-Path ".env.example") -and -not (Test-Path ".env")) {
    Write-Host "Tip: configure LLM settings in `"$AppDir\.env`" or `"$AppDir\local-data\.env`"."
    Write-Host "     Start from `"$AppDir\.env.example`"."
  }

  Write-Host "Launching StandupScribe."

  cmd /c npm.cmd start
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
