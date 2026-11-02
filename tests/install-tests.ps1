<#
.SYNOPSIS
    Pruebas de instalacion/mantenibilidad del repo Software Factory.
.DESCRIPTION
    Scripts planos (sin dependencia de Pester). Ejecutar con:
        pwsh -NoProfile -File tests/install-tests.ps1
    Usa COPILOT_HOME temporales: NUNCA toca la instalacion real de ~/.copilot.
    El canvas.json del destino se genera desde canvas-meta.json + plugin.json
    (el arbol distribuido no lo versiona, convencion awesome-copilot).
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

# Copia instalador + fuentes a un sandbox temporal para probar origenes manipulados
function New-SourceSandbox {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("sf-src-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force $dir | Out-Null
  Copy-Item (Join-Path $RepoRoot "install.ps1") $dir
  Copy-Item (Join-Path $RepoRoot "canvas-meta.json") $dir
  Copy-Item (Join-Path $RepoRoot "plugin.json") $dir
  New-Item -ItemType Directory -Force (Join-Path $dir "com.github.copilot") | Out-Null
  Copy-Item -Recurse (Join-Path $RepoRoot "com.github.copilot\extensions") (Join-Path $dir "com.github.copilot\extensions")
  Copy-Item -Recurse (Join-Path $RepoRoot "skills") (Join-Path $dir "skills")
  Copy-Item -Recurse (Join-Path $RepoRoot "tools") (Join-Path $dir "tools")
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
It "el arbol distribuido no versiona canvas.json (convencion awesome-copilot)" {
  Assert-True (-not (Test-Path (Join-Path $RepoRoot "com.github.copilot\extensions\software-factory\canvas.json"))) "canvas.json no deberia estar versionado en la extension"
  Assert-True (Test-Path (Join-Path $RepoRoot "canvas-meta.json")) "falta canvas-meta.json (fuente del manifiesto generado)"
  Assert-True (Test-Path (Join-Path $RepoRoot "tools\make-canvas-manifest.mjs")) "falta tools/make-canvas-manifest.mjs"
}
It "el generador produce un canvas.json valido cuyo main resuelve" {
  $out = New-TempHome
  try {
    & node (Join-Path $RepoRoot "tools\make-canvas-manifest.mjs") $RepoRoot $out
    Assert-True ($LASTEXITCODE -eq 0) "make-canvas-manifest.mjs fallo (exit $LASTEXITCODE)"
    $cpath = Join-Path $out "canvas.json"
    Assert-True (Test-Path $cpath) "no se genero canvas.json"
    $c = Get-Content $cpath -Raw | ConvertFrom-Json
    Assert-True ($c.id -eq "software-factory") "canvas.json id incorrecto: $($c.id)"
    $extDir = Join-Path $RepoRoot "com.github.copilot\extensions\software-factory"
    Assert-True ($c.main -and (Test-Path (Join-Path $extDir $c.main))) "main no resuelve: $($c.main)"
  } finally { Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue }
}
It "canvas-meta.json, package.json y plugin.json declaran la misma version" {
  $meta = Get-Content (Join-Path $RepoRoot "canvas-meta.json") -Raw | ConvertFrom-Json
  $pkg = Get-Content (Join-Path $RepoRoot "com.github.copilot\extensions\software-factory\package.json") -Raw | ConvertFrom-Json
  $plugin = Get-Content (Join-Path $RepoRoot "plugin.json") -Raw | ConvertFrom-Json
  $metaVersion = if ($meta.version) { $meta.version } else { $plugin.version }
  Assert-True ($metaVersion -eq $pkg.version -and $pkg.version -eq $plugin.version) "versiones desiguales: meta=$metaVersion pkg=$($pkg.version) plugin=$($plugin.version)"
}

It "el layout externo cumple el gate de estructura de canvas (namespaced)" {
  $p = Get-Content (Join-Path $RepoRoot "plugin.json") -Raw | ConvertFrom-Json
  Assert-True ($p.keywords -contains "canvas") "keywords debe incluir 'canvas' para activar el gate"
  Assert-True (Test-Path (Join-Path $RepoRoot "com.github.copilot\extensions\software-factory\extension.mjs")) "falta com.github.copilot/extensions/software-factory/extension.mjs"
  Assert-True (-not (Test-Path (Join-Path $RepoRoot "extensions\software-factory\extension.mjs"))) "no debe existir una segunda copia fuera del namespace"
  Assert-True (Test-Path (Join-Path $RepoRoot "skills\software-factory\SKILL.md")) "falta skills/software-factory/SKILL.md en la raiz del paquete"
  $allowed = @('$schema','name','version','description','author','homepage','repository','license','keywords','extensions')
  $extra = @($p.PSObject.Properties.Name | Where-Object { $_ -notin $allowed })
  Assert-True ($extra.Count -eq 0) "campos no permitidos por Agent Plugins 1.0 en plugin.json: $($extra -join ', ')"
}

Write-Host "`n== Sintaxis JS (node --check) =="
It "todos los .mjs de extension y tools compilan" {
  $files = @(
    Get-ChildItem -Recurse -File (Join-Path $RepoRoot "com.github.copilot") -Filter *.mjs
    Get-ChildItem -Recurse -File (Join-Path $RepoRoot "tools") -Filter *.mjs
  )
  Assert-True ($files.Count -gt 0) "no se encontro ningun .mjs"
  foreach ($f in $files) {
    $out = & node --check $f.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "node --check fallo en $($f.Name): $out" }
  }
}

Write-Host "`n== Instalacion limpia (COPILOT_HOME temporal) =="
It "instala todos los archivos esperados, canvas.json incluido" {
  $h = New-TempHome
  try {
    & (Join-Path $RepoRoot "install.ps1") -CopilotHome $h -Force
    $expected = @(
      "extensions\software-factory\canvas.json",
      "extensions\software-factory\extension.mjs",
      "extensions\software-factory\index.html",
      "extensions\software-factory\app.mjs",
      "extensions\software-factory\package.json",
      "extensions\software-factory\runner\sf.mjs",
      "extensions\software-factory\runner\lib\actions.mjs",
      "extensions\software-factory\runner\lib\gh.mjs",
      "extensions\software-factory\runner\lib\http.mjs",
      "extensions\software-factory\runner\lib\prompts.mjs",
      "extensions\software-factory\runner\lib\state.mjs",
      "skills\software-factory\SKILL.md"
    )
    foreach ($e in $expected) {
      Assert-True (Test-Path (Join-Path $h $e)) "falta $e tras instalacion limpia"
    }
    $c = Get-Content (Join-Path $h "extensions\software-factory\canvas.json") -Raw | ConvertFrom-Json
    Assert-True ($c.id -eq "software-factory") "canvas.json generado tiene id incorrecto"
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
It "aborta con canvas-meta.json ausente y deja la instalacion intacta" {
  $h = New-TempHome
  $src = New-SourceSandbox
  try {
    & (Join-Path $RepoRoot "install.ps1") -CopilotHome $h -Force
    $before = (Get-ChildItem -Recurse -File (Join-Path $h "extensions\software-factory")).Count
    Remove-Item (Join-Path $src "canvas-meta.json")
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
It "aborta con plugin.json corrupto y no destruye la instalacion previa" {
  $h = New-TempHome
  $src = New-SourceSandbox
  try {
    & (Join-Path $RepoRoot "install.ps1") -CopilotHome $h -Force
    Set-Content (Join-Path $src "plugin.json") '{ not json'
    $threw = $false
    try { & (Join-Path $src "install.ps1") -CopilotHome $h -Force } catch { $threw = $true }
    Assert-True $threw "el instalador no aborto con plugin.json corrupto"
    Assert-True (Test-Path (Join-Path $h "extensions\software-factory\extension.mjs")) "instalacion previa destruida"
  } finally {
    Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $src -ErrorAction SilentlyContinue
  }
}
It "aborta si canvas-meta.json declara un main inexistente y no escribe nada" {
  $h = New-TempHome
  $src = New-SourceSandbox
  try {
    $meta = Get-Content (Join-Path $src "canvas-meta.json") -Raw | ConvertFrom-Json
    $meta.main = "no-existe.mjs"
    $meta | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $src "canvas-meta.json")
    $threw = $false
    try { & (Join-Path $src "install.ps1") -CopilotHome $h -Force } catch { $threw = $true }
    Assert-True $threw "el instalador no aborto con main roto"
    Assert-True (-not (Test-Path (Join-Path $h "extensions\software-factory\extension.mjs"))) "escribio a pesar de origen invalido"
  } finally {
    Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $src -ErrorAction SilentlyContinue
  }
}
It "aborta si falta tools/make-canvas-manifest.mjs y no escribe nada" {
  $h = New-TempHome
  $src = New-SourceSandbox
  try {
    Remove-Item -Recurse -Force (Join-Path $src "tools")
    $threw = $false
    try { & (Join-Path $src "install.ps1") -CopilotHome $h -Force } catch { $threw = $true }
    Assert-True $threw "el instalador no aborto sin generador de manifiesto"
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
