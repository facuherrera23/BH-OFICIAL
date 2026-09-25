param(
  [Parameter(Mandatory)] [string] $Module,
  [Parameter(Mandatory)] [string] $Title,
  [Parameter(Mandatory)] [int[]]  $Ranges,
  [string[]] $Needs = @(),
  [string[]] $Exports = @(),
  [Parameter(Mandatory)] [string] $ExpectStart,
  [switch] $DryRun
)
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\facuh\OneDrive\Escritorio\Mis Proyectos\Landing Page\BH-OFICIAL'
$app = Join-Path $root 'assets\js\admin-app.js'
$bak = Join-Path $env:TEMP 'admin-app.pre-modular.bak'

$raw = [System.IO.File]::ReadAllText($app, [System.Text.Encoding]::UTF8)
$sep = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines = $raw -split "`r?`n", -1

if (-not (Test-Path $bak)) { [System.IO.File]::WriteAllText($bak, $raw, (New-Object System.Text.UTF8Encoding($false))) }

$firstIdx = $Ranges[0] - 1
if (-not $lines[$firstIdx].Trim().StartsWith($ExpectStart.Trim())) { throw "Anchor FAIL en linea $($Ranges[0]): '$($lines[$firstIdx].Trim())'" }
for ($r = 0; $r -lt $Ranges.Count; $r += 2) {
  $s = $Ranges[$r]; $e = $Ranges[$r + 1]
  if ($e -le $s) { throw "Rango invalido $s..$e" }
}

$taken = New-Object System.Collections.Generic.List[string]
for ($r = 0; $r -lt $Ranges.Count; $r += 2) {
  $s = $Ranges[$r]; $e = $Ranges[$r + 1]
  for ($i = $s; $i -le $e; $i++) { $taken.Add($lines[$i - 1]) }
}

$removed = @{}
for ($r = 0; $r -lt $Ranges.Count; $r += 2) { for ($i = $Ranges[$r]; $i -le $Ranges[$r + 1]; $i++) { $removed[$i] = $true } }
$coreLines = New-Object System.Collections.Generic.List[string]
for ($i = 1; $i -le $lines.Count; $i++) { if (-not $removed.ContainsKey($i)) { $coreLines.Add($lines[$i - 1]) } }
$coreText = ($coreLines -join "`n")
$blockText = ($taken -join "`n")

$coreDecls = New-Object System.Collections.Generic.HashSet[string]
foreach ($m in [regex]::Matches($coreText, '(?m)^  (?:async function|function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)')) { [void]$coreDecls.Add($m.Groups[1].Value) }
$blockDecls = New-Object System.Collections.Generic.HashSet[string]
foreach ($m in [regex]::Matches($blockText, '(?m)^\s*(?:async function|function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)')) { [void]$blockDecls.Add($m.Groups[1].Value) }

$missing = New-Object System.Collections.Generic.List[string]
foreach ($name in $coreDecls) {
  if ($blockDecls.Contains($name)) { continue }
  if ($Needs -contains $name) { continue }
  if ($Exports -contains $name) { continue }
  $re = '\b' + [regex]::Escape($name) + '\b'
  if ([regex]::IsMatch($blockText, $re)) { $missing.Add($name) }
}
$rev = New-Object System.Collections.Generic.List[string]
foreach ($name in $blockDecls) {
  $re = '\b' + [regex]::Escape($name) + '\b'
  if ([regex]::IsMatch($coreText, $re)) { $rev.Add($name) }
}
Write-Output ("[{0}] deps NO cubiertas: {1}" -f $Module, ($missing -join ', '))
Write-Output ("[{0}] refs inversas (modulo -> core): {1}" -f $Module, ($rev -join ', '))

if ($DryRun) { Write-Output "DRY RUN sin escritura; lineas a mover: $($taken.Count)"; return }

$hdr = New-Object System.Collections.Generic.List[string]
$hdr.Add('/* ============================================================')
$hdr.Add("   BIENENHAUS PROPIEDADES - Admin - Modulo: $Title")
$hdr.Add('   Extraido de admin-app.js (modularizacion). Helpers via window.__BH.')
$hdr.Add('   ============================================================ */')
$hdr.Add('(function () {')
$hdr.Add("  'use strict';")
if ($Needs.Count) { $hdr.Add('  const { ' + ($Needs -join ', ') + ' } = window.__BH || {};') }
$hdr.Add('')
$ftr = New-Object System.Collections.Generic.List[string]
$ftr.Add('')
foreach ($ex in $Exports) {
  $ftr.Add("  window.__BH.$ex = $ex;")
  $ftr.Add("  if (!Object.prototype.hasOwnProperty.call(window, '$ex')) Object.defineProperty(window, '$ex', { get: () => $ex, configurable: true });")
}
$ftr.Add('})();')
$ftr.Add('')

$modulePath = Join-Path $root ('assets\js\admin-' + $Module + '.js')
[System.IO.File]::WriteAllText($modulePath, (($hdr + $taken + $ftr) -join $sep), (New-Object System.Text.UTF8Encoding($false)))

$marker = '  /* Extraido a assets/js/admin-' + $Module + '.js (modularizacion) */'
$newCore = New-Object System.Collections.Generic.List[string]
$markerWritten = $false
for ($i = 1; $i -le $lines.Count; $i++) {
  if ($removed.ContainsKey($i)) {
    if (-not $markerWritten -and $i -eq $Ranges[0]) { $newCore.Add($marker); $markerWritten = $true }
    continue
  }
  $newCore.Add($lines[$i - 1])
}
[System.IO.File]::WriteAllText($app, ($newCore -join $sep), (New-Object System.Text.UTF8Encoding($false)))

node --check $app | Out-Null
if ($LASTEXITCODE) { throw "node --check admin-app.js FALLO tras extraer $Module" }
node --check $modulePath | Out-Null
if ($LASTEXITCODE) { throw "node --check admin-$Module.js FALLO" }
Write-Output ("OK {0}: movidas {1} lineas; core quedo en {2} lineas" -f $Module, $taken.Count, $newCore.Count)
