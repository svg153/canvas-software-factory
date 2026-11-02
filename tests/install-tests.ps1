<#
.SYNOPSIS
    Pruebas de instalacion/mantenibilidad del repo Software Factory.
.DESCRIPTION
    Scripts planos (sin dependencia de Pester). Ejecutar con:
        pwsh -NoProfile -File tests/install-tests.ps1
    Usa COPILOT_HOME temporales: NUNCA toca la instalacion real de ~/.copilot.
#>
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

$script:Passed = 0
$script:Failed = 0
$script:Failures = @()

function It {
  param([string]$Name, [scriptblock]$Body)
  try {
    & $Body
    $script:Passed++
    Write-Host "  PASS  $Name" -ForegroundColor Green
  } catch {
    $script:Failed++
    $script:Failures += "$Name :: $($_.Exception.Message)"
    Write-Host "  FAIL  $Name :: $($_.Exception.Message)" -ForegroundColor Red
  }
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

# Copia el instalador + fuentes a un sandbox temporal para probar origenes manipulados
function New-SourceSandbox {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("sf-src-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force $dir | Out-Null
  Copy-Item (Join-Path $RepoRoot "install.ps1") $dir
  Copy-Item -Recurse (Join-Path $RepoRoot "extensions") (Join-Path $dir "extensions")
  Copy-Item -Recurse (Join-Path $RepoRoot "skills") (Join-Path $dir "skills")
  return $dir
}

function New-TempHome {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("sf-home-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force $dir | Out-Null
  return $dir
}

Write-Host "`n== Manifiestos y URLs =="
It "plugin.json es JSON valido y conforme al esquema agent-plugins" {
  $p = Get-Content (Join-Path $RepoRoot "plugin.json") -Raw | ConvertFrom-Json
  Assert-True ($p.name -eq "software-factory") "plugin.json name incorrecto"
  Assert-True ($p.'$schema' -eq "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") "schema incorrecta"
  Assert-True ($p.version -match '^\d+\.\d+\.\d+$') "version no es semver"
}
It "plugin.json apunta a svg153/canvas-software-factory" {
  $p = Get-Content (Join-Path $RepoRoot "plugin.json") -Raw | ConvertFrom-Json
  Assert-True ($p.homepage -eq "https://github.com/svg153/canvas-software-factory") "homepage obsoleta: $($p.homepage)"
  Assert-True ($p.repository -eq "https://github.com/svg153/canvas-software-factory") "repository obsoleta: $($p.repository)"
}
It "ningun archivo del repo usa la URL obsoleta del antiguo nombre del repo" {
  $stale = 'svg153/software' + '-factory'
  $bad = Get-ChildItem -Recurse -File $RepoRoot -Include *.md, *.json, *.ps1, *.mjs, *.html |
    Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\' } |
    Select-String -Pattern $stale -SimpleMatch
  Assert-True (-not $bad) "URL obsoleta en: $(($bad | ForEach-Object Path | Sort-Object -Unique) -join ', ')"
}
It "canvas.json existe, es valido y su main resuelve" {
  $cpath = Join-Path $RepoRoot "extensions\software-factory\canvas.json"
  Assert-True (Test-Path $cpath) "falta canvas.json en el repositorio"
  $c = Get-Content $cpath -Raw | ConvertFrom-Json
  Assert-True ($c.id -eq "software-factory") "canvas.json id incorrecto"
  Assert-True ($c.main -and (Test-Path (Join-Path $RepoRoot "extensions\software-factory" $c.main))) "canvas.json main no resuelve"
}
It "canvas.json, package.json y plugin.json declaran la misma version" {
  $c = Get-Content (Join-Path $RepoRoot "extensions\software-factory\canvas.json") -Raw | ConvertFrom-Json
  $pkg = Get-Content (Join-Path $RepoRoot "extensions\software-factory\package.json") -Raw | ConvertFrom-Json
  $plugin = Get-Content (Join-Path $RepoRoot "plugin.json") -Raw | ConvertFrom-Json
  Assert-True ($c.version -eq $pkg.version -and $pkg.version -eq $plugin.version) "versiones desiguales: canvas=$($c.version) pkg=$($pkg.version) plugin=$($plugin.version)"
}

Write-Host "`n== Sintaxis JS (node --check) =="
It "todos los .mjs del repo compilan" {
  $files = Get-ChildItem -Recurse -File (Join-Path $RepoRoot "extensions") -Filter *.mjs
  Assert-True ($files.Count -gt 0) "no se encontro ningun .mjs"
  foreach ($f in $files) {
    $out = & node --check $f.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "node --check fallo en $($f.Name): $out" }
  }
}

Write-Host "`n== Instalacion limpia (COPILOT_HOME temporal) =="
It "instala todos los archivos esperados" {
  $h = New-TempHome
  try {
    & (Join-Path $RepoRoot "install.ps1") -CopilotHome $h -Force
    $expected = @(
      "extensions\software-factory\canvas.json",
      "extensions\software-factory\extension.mjs",
      "extensions\software-factory\index.html",
      "extensions\software-factory\package.json",
      "extensions\software-factory\runner\sf.mjs",
      "extensions\software-factory\runner\lib\gh.mjs",
      "extensions\software-factory\runner\lib\prompts.mjs",
      "extensions\software-factory\runner\lib\state.mjs",
      "skills\software-factory\SKILL.md"
    )
    foreach ($e in $expected) {
      Assert-True (Test-Path (Join-Path $h $e)) "falta $e tras instalacion limpia"
    }
  } finally { Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue }
}

Write-Host "`n== Actualizacion sin borrar datos ajenos =="
It "conserva artifacts/ y archivos del usuario; renueva el codigo" {
  $h = New-TempHome
  try {
    & (Join-Path $RepoRoot "install.ps1") -CopilotHome $h -Force
    $extDir = Join-Path $h "extensions\software-factory"
    New-Item -ItemType Directory -Force (Join-Path $extDir "artifacts") | Out-Null
    Set-Content (Join-Path $extDir "artifacts\state.json") '{"keep":true}'
    Set-Content (Join-Path $extDir "mi-config-local.json") 'custom'
    Set-Content (Join-Path $extDir "extension.mjs") 'STALE'
    & (Join-Path $RepoRoot "install.ps1") -CopilotHome $h -Force
    Assert-True ((Get-Content (Join-Path $extDir "artifacts\state.json") -Raw) -match '"keep":true') "artifacts/ fue borrado"
    Assert-True (Test-Path (Join-Path $extDir "mi-config-local.json")) "archivo del usuario fue borrado"
    Assert-True ((Get-Content (Join-Path $extDir "extension.mjs") -Raw) -notmatch 'STALE') "extension.mjs no se actualizo"
  } finally { Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue }
}

Write-Host "`n== Origen invalido: la instalacion no se degrada =="
It "aborta con canvas.json ausente y deja la instalacion intacta" {
  $h = New-TempHome
  $src = New-SourceSandbox
  try {
    & (Join-Path $RepoRoot "install.ps1") -CopilotHome $h -Force
    $before = (Get-ChildItem -Recurse -File (Join-Path $h "extensions\software-factory")).Count
    Remove-Item (Join-Path $src "extensions\software-factory\canvas.json")
    $threw = $false
    try { & (Join-Path $src "install.ps1") -CopilotHome $h -Force } catch { $threw = $true }
    Assert-True $threw "el instalador no aborto con origen incompleto"
    $after = (Get-ChildItem -Recurse -File (Join-Path $h "extensions\software-factory")).Count
    Assert-True ($after -eq $before) "la instalacion cambio con origen invalido"
  } finally {
    Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $src -ErrorAction SilentlyContinue
  }
}
It "aborta con canvas.json corrupto y no destruye la instalacion previa" {
  $h = New-TempHome
  $src = New-SourceSandbox
  try {
    & (Join-Path $RepoRoot "install.ps1") -CopilotHome $h -Force
    Set-Content (Join-Path $src "extensions\software-factory\canvas.json") '{ not json'
    $threw = $false
    try { & (Join-Path $src "install.ps1") -CopilotHome $h -Force } catch { $threw = $true }
    Assert-True $threw "el instalador no aborto con canvas.json corrupto"
    Assert-True (Test-Path (Join-Path $h "extensions\software-factory\extension.mjs")) "instalacion previa destruida"
  } finally {
    Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $src -ErrorAction SilentlyContinue
  }
}
It "aborta si canvas.json declara un main inexistente y no escribe nada" {
  $h = New-TempHome
  $src = New-SourceSandbox
  try {
    Set-Content (Join-Path $src "extensions\software-factory\canvas.json") '{"id":"software-factory","main":"no-existe.mjs"}'
    $threw = $false
    try { & (Join-Path $src "install.ps1") -CopilotHome $h -Force } catch { $threw = $true }
    Assert-True $threw "el instalador no aborto con main roto"
    Assert-True (-not (Test-Path (Join-Path $h "extensions\software-factory\extension.mjs"))) "escribio a pesar de origen invalido"
  } finally {
    Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $src -ErrorAction SilentlyContinue
  }
}

Write-Host "`n== Resultado =="
Write-Host "Pasadas: $script:Passed | Fallidas: $script:Failed"
if ($script:Failed -gt 0) {
  $script:Failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
exit 0

