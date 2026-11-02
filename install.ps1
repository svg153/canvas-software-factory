<#
.SYNOPSIS
    Instala o actualiza la extensión Software Factory en la app de GitHub Copilot.
.DESCRIPTION
    Sincroniza com.github.copilot/extensions/software-factory/ (canvas + runner + UI) hacia
    <COPILOT_HOME>\extensions\software-factory y skills/software-factory/ hacia
    <COPILOT_HOME>\skills\software-factory.

    Comportamiento:
    - Valida el origen ANTES de escribir nada (archivos obligatorios presentes,
      JSONs parseables y main del manifiesto resoluble). Un origen inválido aborta
      sin tocar la instalación existente.
    - Copia archivo a archivo, sin borrar nunca el directorio destino: se conservan
      datos ajenos como artifacts/ o cualquier archivo añadido por el usuario.
    - El árbol distribuido NO incluye canvas.json (convención awesome-copilot: la
      metadata procede del manifiesto del plugin). Se genera en el destino desde
      canvas-meta.json + plugin.json con tools/make-canvas-manifest.mjs.
.PARAMETER CopilotHome
    Ruta de COPILOT_HOME. Por defecto $env:COPILOT_HOME o ~/.copilot.
.PARAMETER Check
    Solo comprueba si la instalacion esta sincronizada con el repo (version, archivos,
    canvas.json y SKILL.md). Sale con codigo 1 si hay deriva; no escribe nada.
.PARAMETER Force
    Instala/actualiza sin preguntar.
#>
[CmdletBinding()]
param(
  [string]$CopilotHome = $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME ".copilot" }),
  [switch]$Force,
  [switch]$Check
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($CopilotHome)) { throw "COPILOT_HOME vacío o no resoluble." }

$extSource = Join-Path $PSScriptRoot "com.github.copilot\extensions\software-factory"
$skillSource = Join-Path $PSScriptRoot "skills\software-factory"
$manifestTool = Join-Path $PSScriptRoot "tools\make-canvas-manifest.mjs"

# --- Validación del origen: nada se escribe si falla -------------------------
$required = @(
  "com.github.copilot\extensions\software-factory\extension.mjs",
  "com.github.copilot\extensions\software-factory\index.html",
  "com.github.copilot\extensions\software-factory\app.mjs",
  "com.github.copilot\extensions\software-factory\ui.mjs",
  "com.github.copilot\extensions\software-factory\package.json",
  "com.github.copilot\extensions\software-factory\runner\sf.mjs",
  "com.github.copilot\extensions\software-factory\runner\lib\actions.mjs",
  "com.github.copilot\extensions\software-factory\runner\lib\gh.mjs",
  "com.github.copilot\extensions\software-factory\runner\lib\http.mjs",
  "com.github.copilot\extensions\software-factory\runner\lib\prompts.mjs",
  "com.github.copilot\extensions\software-factory\runner\lib\state.mjs",
  "skills\software-factory\SKILL.md",
  "canvas-meta.json",
  "plugin.json",
  "tools\make-canvas-manifest.mjs"
)
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $PSScriptRoot $_)) })
if ($missing.Count) { throw "Origen incompleto, no se modifica la instalación. Faltan: $($missing -join ', ')" }

foreach ($jsonName in @("canvas-meta.json", "plugin.json")) {
  try { Get-Content (Join-Path $PSScriptRoot $jsonName) -Raw | ConvertFrom-Json | Out-Null }
  catch { throw "$jsonName no es JSON válido: $($_.Exception.Message)" }
}
$canvasMeta = Get-Content (Join-Path $PSScriptRoot "canvas-meta.json") -Raw | ConvertFrom-Json
if (-not $canvasMeta.main -or -not (Test-Path (Join-Path $extSource $canvasMeta.main))) {
  throw "canvas-meta.json declara main='$($canvasMeta.main)' pero ese archivo no existe en el origen."
}

# --- Sincronización aditiva: copia archivo a archivo, nunca borra ------------
function Sync-Tree {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Force $Destination | Out-Null }
  $srcFull = (Resolve-Path $Source).Path.TrimEnd('\', '/')
  foreach ($file in Get-ChildItem -Recurse -File $srcFull) {
    $rel = $file.FullName.Substring($srcFull.Length).TrimStart('\', '/')
    $destFile = Join-Path $Destination $rel
    $destDir = Split-Path $destFile
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force $destDir | Out-Null }
    Copy-Item -Force $file.FullName $destFile
  }
}

if ($Check) {
  $extT = Join-Path $CopilotHome "extensions\software-factory"
  $skillT = Join-Path $CopilotHome "skills\software-factory"
  $problems = @()
  $srcPlugin = Get-Content (Join-Path $PSScriptRoot "plugin.json") -Raw | ConvertFrom-Json
  if (-not (Test-Path $extT)) { $problems += "no hay instalacion en $extT" }
  else {
    $missingInstalled = @(Get-ChildItem -Recurse -File $extSource | ForEach-Object {
      $rel = $_.FullName.Substring((Resolve-Path $extSource).Path.TrimEnd('\', '/').Length).TrimStart('\', '/')
      if (-not (Test-Path (Join-Path $extT $rel))) { $rel }
    })
    if ($missingInstalled.Count) { $problems += "faltan archivos instalados: $($missingInstalled -join ', ')" }
    $instPkg = Join-Path $extT "package.json"
    if (Test-Path $instPkg) {
      $instVersion = (Get-Content $instPkg -Raw | ConvertFrom-Json).version
      if ($instVersion -ne $srcPlugin.version) { $problems += "version instalada $instVersion != manifiesto $($srcPlugin.version)" }
    }
    if (-not (Test-Path (Join-Path $extT "canvas.json"))) { $problems += "falta canvas.json generado" }
  }
  $srcSkill = Join-Path $skillSource "SKILL.md"
  $instSkill = Join-Path $skillT "SKILL.md"
  if (-not (Test-Path $instSkill)) { $problems += "falta la skill instalada $instSkill" }
  elseif ((Get-FileHash $srcSkill).Hash -ne (Get-FileHash $instSkill).Hash) { $problems += "SKILL.md instalada difiere de la del repo" }
  if ($problems.Count) {
    $problems | ForEach-Object { Write-Host "DESINCRONIZADO: $_" -ForegroundColor Red }
    Write-Host "Ejecuta install.ps1 para actualizar."
    exit 1
  }
  Write-Host "Instalacion sincronizada con v$($srcPlugin.version)."
  exit 0
}
$extTarget = Join-Path $CopilotHome "extensions\software-factory"
$skillTarget = Join-Path $CopilotHome "skills\software-factory"

if ((Test-Path $extTarget) -and -not $Force) {
  $answer = Read-Host "Ya existe una instalación en $extTarget. ¿Actualizar? (s/N)"
  if ($answer -notmatch '^[sSyY]') { Write-Host "Cancelado."; exit 0 }
}

Sync-Tree -Source $extSource -Destination $extTarget
Sync-Tree -Source $skillSource -Destination $skillTarget

# --- canvas.json se materializa en el destino desde el manifiesto del plugin --
node $manifestTool $PSScriptRoot $extTarget
if ($LASTEXITCODE -ne 0) { throw "Fallo la generacion de canvas.json (exit $LASTEXITCODE)" }
$canvasManifestPath = Join-Path $extTarget "canvas.json"
if (-not (Test-Path $canvasManifestPath)) { throw "No se genero $canvasManifestPath" }
try { $canvasManifest = Get-Content $canvasManifestPath -Raw | ConvertFrom-Json }
catch { throw "canvas.json generado no es JSON valido: $($_.Exception.Message)" }
if (-not $canvasManifest.main -or -not (Test-Path (Join-Path $extTarget $canvasManifest.main))) {
  throw "canvas.json generado declara main='$($canvasManifest.main)' pero ese archivo no existe en el destino."
}

Write-Host "Canvas+runner -> $extTarget"
Write-Host "Skill         -> $skillTarget"
Write-Host "canvas.json   -> $canvasManifestPath (generado desde canvas-meta.json + plugin.json)"
Write-Host "Instalación completa (archivos ajenos como artifacts/ se conservan)."
Write-Host "Recarga las extensiones en la app de Copilot (o reiníciala)."
