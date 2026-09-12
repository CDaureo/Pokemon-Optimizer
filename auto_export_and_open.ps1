$ErrorActionPreference = "Stop"

$optimizerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$parentDir = Split-Path -Parent $optimizerDir
$extractor = Join-Path $optimizerDir "tools\extract_anil_save.py"
$index = Join-Path $optimizerDir "index.html"
$jsonOut = Join-Path $optimizerDir "save_export.json"
$appDataOut = Join-Path $optimizerDir "app-data.js"
$saveDir = Join-Path $env:APPDATA "Pokemon Anil"

function Test-GameDir($path) {
  return $path -and (Test-Path (Join-Path $path "PBS")) -and (Test-Path (Join-Path $path "Data"))
}

function Find-GameDir {
  $candidates = @(
    $optimizerDir,
    $parentDir,
    (Split-Path -Parent $parentDir)
  )

  foreach ($candidate in $candidates) {
    if (Test-GameDir $candidate) {
      return $candidate
    }
  }

  $desktop = [Environment]::GetFolderPath("Desktop")
  $found = Get-ChildItem -Path $desktop -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object { Test-GameDir $_.FullName } |
    Select-Object -First 1

  if ($found) {
    return $found.FullName
  }

  throw "No encuentro la carpeta del juego. Pon Pokemon-Optimizer-main dentro de la carpeta de Pokemon Añil, o junto a una carpeta que tenga PBS y Data."
}

function Find-Python {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Python\pythoncore-3.14-64\python.exe"),
    "python",
    "py"
  )

  foreach ($candidate in $candidates) {
    try {
      $cmd = Get-Command $candidate -ErrorAction Stop
      return $cmd.Source
    } catch {
    }
  }

  throw "No encuentro Python. Instala Python o ejecuta el extractor manualmente."
}

function Find-Save {
  if (!(Test-Path $saveDir)) {
    throw "No existe la carpeta de partidas: $saveDir"
  }

  $preferred = Join-Path $saveDir "Partida 1.rxdata"
  if (Test-Path $preferred) {
    return $preferred
  }

  $save = Get-ChildItem -Path $saveDir -Filter "*.rxdata" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (!$save) {
    throw "No encuentro ningun archivo .rxdata en: $saveDir"
  }

  return $save.FullName
}

function Find-TmCompatibility($savePath) {
  $name = [IO.Path]::GetFileNameWithoutExtension($savePath).Replace(" ", "_")
  $specific = Join-Path $saveDir "tm_compatibility_$name.dat"
  if (Test-Path $specific) {
    return $specific
  }

  $file = Get-ChildItem -Path $saveDir -Filter "tm_compatibility*.dat" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($file) {
    return $file.FullName
  }

  return $null
}

if (!(Test-Path $extractor)) {
  throw "No encuentro el extractor: $extractor"
}

if (!(Test-Path $index)) {
  throw "No encuentro la app: $index"
}

$python = Find-Python
$gameDir = Find-GameDir
$savePath = Find-Save
$tmCompatibility = Find-TmCompatibility $savePath

$args = @(
  $extractor,
  "--save", $savePath,
  "--game-dir", $gameDir,
  "--out", $jsonOut
)

if ($tmCompatibility) {
  $args += @("--tm-compatibility", $tmCompatibility)
}

Write-Host "Partida:" $savePath
Write-Host "Exportando datos..."
& $python @args

if ($LASTEXITCODE -ne 0) {
  throw "El extractor fallo con codigo $LASTEXITCODE"
}

$json = Get-Content -LiteralPath $jsonOut -Raw -Encoding UTF8
Set-Content -LiteralPath $appDataOut -Encoding UTF8 -Value ("window.ANIL_SAVE_DATA = " + $json + ";")

Write-Host "Listo. Abriendo optimizador..."
Start-Process $index
