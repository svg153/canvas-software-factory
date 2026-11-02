<#
.SYNOPSIS
    Instala la extensión Software Factory en la app de GitHub Copilot.
.DESCRIPTION
    Copia extensions/software-factory/ a <COPILOT_HOME>\extensions\software-factory
    (canvas + runner) y skills/software-factory/ a <COPILOT_HOME>\skills\.
.PARAMETER CopilotHome
    Ruta de COPILOT_HOME. Por defecto $env:COPILOT_HOME o ~/.copilot.
.PARAMETER Force
    Sobrescribe sin preguntar.
#>
[CmdletBinding()]
param(
  [string]$CopilotHome = $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME ".copilot" }),
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$extSource = Join-Path $PSScriptRoot "extensions\software-factory"
if (-not (Test-Path $extSource)) { throw "No se encuentra $extSource" }

$extTarget = Join-Path $CopilotHome "extensions\software-factory"
if (Test-Path $extTarget) {
  if (-not $Force) {
    $answer = Read-Host "Ya existe una instalación. ¿Sobrescribir? (s/N)"
    if ($answer -notmatch '^[sSyY]') { Write-Host "Cancelado."; exit 0 }
  }
  # conserva artifacts/ si existiera
  $artifacts = Join-Path $extTarget "artifacts"
  $backup = $null
  if (Test-Path $artifacts) { $backup = Join-Path $env:TEMP "sf-artifacts-backup"; Remove-Item -Recurse -Force $backup -ErrorAction SilentlyContinue; Copy-Item -Recurse $artifacts $backup }
  Remove-Item -Recurse -Force $extTarget
}

New-Item -ItemType Directory -Force (Split-Path $extTarget) | Out-Null
Copy-Item -Recurse $extSource $extTarget
if ($backup) { Copy-Item -Recurse $backup (Join-Path $extTarget "artifacts") }

$skillSource = Join-Path $PSScriptRoot "skills\software-factory"
$skillTarget = Join-Path $CopilotHome "skills\software-factory"
New-Item -ItemType Directory -Force $skillTarget | Out-Null
Copy-Item -Recurse -Force (Join-Path $skillSource "*") $skillTarget

Write-Host "Canvas+runner -> $extTarget"
Write-Host "Skill         -> $skillTarget"
Write-Host "Recarga las extensiones en la app de Copilot (o reiníciala)."
