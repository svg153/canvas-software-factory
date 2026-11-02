<#
.SYNOPSIS
    Instala o actualiza la extensión Software Factory en la app de GitHub Copilot.
.DESCRIPTION
    Sincroniza extensions/software-factory/ (canvas + runner + manifiestos) hacia
    <COPILOT_HOME>\extensions\software-factory y skills/software-factory/ hacia
    <COPILOT_HOME>\skills\software-factory.

    Comportamiento:
    - Valida el origen ANTES de escribir nada (archivos obligatorios presentes y
      canvas.json parseable con main resuelto). Un origen inválido aborta sin
      tocar la instalación existente.
    - Copia archivo a archivo (in-place), sin borrar nunca el directorio
      destino: se conservan datos ajenos como artifacts/ o cualquier archivo
      añadido por el usuario.
.PARAMETER CopilotHome
    Ruta de COPILOT_HOME. Por defecto $env:COPILOT_HOME o ~/.copilot.
.PARAMETER Force
    Instala/actualiza sin preguntar.
#>
[CmdletBinding()]
param(
  [string]$CopilotHome = $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME ".copilot" }),
  [switch]$Force
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($CopilotHome)) { throw "COPILOT_HOME vacío o no resoluble." }

$extSource = Join-Path $PSScriptRoot "extensions\software-factory"
$skillSource = Join-Path $PSScriptRoot "skills\software-factory"

# --- Validación del origen: nada se escribe si falla -------------------------
if (-not (Test-Path $extSource)) { throw "No se encuentra el origen $extSource" }
$required = @(
  "canvas.json", "extension.mjs", "index.html", "package.json",
  "runner\sf.mjs", "runner\lib\gh.mjs", "runner\lib\prompts.mjs", "runner\lib\state.mjs"
)
$missing = @()
foreach ($r in $required) { if (-not (Test-Path (Join-Path $extSource $r))) { $missing += $r } }
if ($missing.Count) { throw "Origen incompleto, no se modifica la instalación. Faltan: $($missing -join ', ')" }

$canvasManifestPath = Join-Path $extSource "canvas.json"
try {
  $canvasManifest = Get-Content $canvasManifestPath -Raw | ConvertFrom-Json
} catch {
  throw "canvas.json no es JSON válido: $($_.Exception.Message)"
}
if (-not $canvasManifest.main -or -not (Test-Path (Join-Path $extSource $canvasManifest.main))) {
  throw "canvas.json declara main='$($canvasManifest.main)' pero ese archivo no existe en el origen."
}
if (-not (Test-Path (Join-Path $skillSource "SKILL.md"))) {
  throw "No se encuentra $skillSource\SKILL.md"
}

# --- Sincronización aditiva: copia archivo a archivo, nunca borra ------------
function Sync-Tree {
  param([string]$Source, [string]$Destination)
  $srcFull = (Resolve-Path $Source).Path.TrimEnd('\', '/')
  foreach ($file in Get-ChildItem -Recurse -File $srcFull) {
    $rel = $file.FullName.Substring($srcFull.Length).TrimStart('\', '/')
    $destFile = Join-Path $Destination $rel
    $destDir = Split-Path $destFile
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force $destDir | Out-Null }
    Copy-Item -Force $file.FullName $destFile
  }
}

$extTarget = Join-Path $CopilotHome "extensions\software-factory"
$skillTarget = Join-Path $CopilotHome "skills\software-factory"

if ((Test-Path $extTarget) -and -not $Force) {
  $answer = Read-Host "Ya existe una instalación en $extTarget. ¿Actualizar? (s/N)"
  if ($answer -notmatch '^[sSyY]') { Write-Host "Cancelado."; exit 0 }
}

Sync-Tree -Source $extSource -Destination $extTarget
Sync-Tree -Source $skillSource -Destination $skillTarget

Write-Host "Canvas+runner -> $extTarget"
Write-Host "Skill         -> $skillTarget"
Write-Host "Instalación completa (archivos ajenos como artifacts/ se conservan)."
Write-Host "Recarga las extensiones en la app de Copilot (o reiníciala)."
