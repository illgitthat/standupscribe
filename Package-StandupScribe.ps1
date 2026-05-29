param(
  [switch]$Portable,

  [switch]$RunInstaller,

  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $RootDir "src"
$DistDir = Join-Path $AppDir "dist"
$PackageScript = if ($Portable) { "package:portable" } else { "package" }

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

  Write-Host "Packaging Standup Scribe with npm script: $PackageScript"
  cmd /c npm.cmd run $PackageScript
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $BuiltExe = Get-ChildItem -Path $DistDir -File -Filter "*.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $BuiltExe) {
    throw "Packaging finished, but no .exe was found in `"$DistDir`"."
  }

  Write-Host "Built executable: $($BuiltExe.FullName)"

  if ($RunInstaller) {
    Write-Host "Opening packaged executable..."
    Start-Process -FilePath $BuiltExe.FullName
  }
}
finally {
  Pop-Location
}
