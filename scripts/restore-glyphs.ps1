# restore-glyphs.ps1 — Restaura glifos destruidos a '?' en admin.html / admin-app.js
# Fuente de verdad: commit limpio 9d03bf1. Matching tolerante a whitespace/encoding.
[CmdletBinding()] param(
  [string]$File = 'admin.html',
  [string]$CleanPath = "$env:TEMP\admin.clean.raw",
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$target = Join-Path $root $File

$work  = [IO.File]::ReadAllText($target)
$clean = [IO.File]::ReadAllText($CleanPath)

# Versión normalizada para matching: whitespace colapsado
$cleanN = [regex]::Replace($clean, '\s+', ' ')

function Find-Glyph([string]$before, [string]$after) {
  if ($before.Length -lt 4 -or $after.Length -lt 2) { return $null }
  $rx = [regex]::Escape($before) + '(.{0,10}?)' + [regex]::Escape($after)
  $m = [regex]::Match($cleanN, $rx)
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

# Runs de '?' a reparar: cualquier '?' que NO sea parte de una URL/query param
$rxAny = [regex]'\?+'
$runs = @()
foreach ($m in $rxAny.Matches($work)) {
  $i = $m.Index
  $next = $work.Substring($i + $m.Length, [Math]::Min(6, $work.Length - $i - $m.Length))
  $prev = if ($i -gt 0) { $work[$i-1] } else { ' ' }
  if ($next -match '^[a-zA-Z]+=') { continue }
  if ($prev -match '[a-zA-Z]' -and $next -match '^[a-zA-Z]') { continue }
  $runs += [pscustomobject]@{ Index = $i; Run = $m.Length }
}

$resolved = New-Object 'System.Collections.Generic.List[object]'
$unres    = New-Object 'System.Collections.Generic.List[object]'
foreach ($r in $runs) {
  $bStart = [Math]::Max(0, $r.Index - 60)
  $beforeAll = $work.Substring($bStart, $r.Index - $bStart)
  $aEnd = [Math]::Min($work.Length, $r.Index + $r.Run + 60)
  $afterAll = $work.Substring($r.Index + $r.Run, $aEnd - $r.Index - $r.Run)

  $bN = [regex]::Replace(($beforeAll -replace '\?+', ''), '\s+', ' ').TrimEnd()
  $aN = [regex]::Replace(($afterAll  -replace '\?+', ''), '\s+', ' ').TrimStart()
  if ($bN.Length -gt 30) { $bN = $bN.Substring($bN.Length - 30) }
  if ($aN.Length -gt 20) { $aN = $aN.Substring(0, 20) }

  $glyph = Find-Glyph $bN $aN
  if ($null -ne $glyph) {
    $resolved.Add([pscustomobject]@{ Index = $r.Index; Run = $r.Run; Glyph = $glyph; Ctx = (($bN.Substring([Math]::Max(0, $bN.Length - 14)) + '[?]' + $aN.Substring(0, [Math]::Min(14, $aN.Length)))) })
  } else {
    $unres.Add([pscustomobject]@{ Ctx = (($bN.Substring([Math]::Max(0, $bN.Length - 18)) + '[?]' + $aN.Substring(0, [Math]::Min(18, $aN.Length)))) })
  }
}

Write-Output ("Runs totales: " + $runs.Count)
Write-Output ("Resueltos:   " + $resolved.Count)
Write-Output ("Sin resolver: " + $unres.Count)
Write-Output '--- RESUELTOS (glifo original segun git 9d03bf1) ---'
$resolved | Group-Object Glyph | Sort-Object Count -Descending | ForEach-Object { '{0} occ -> [{1}]' -f $_.Count, $_.Name } | Out-String -Width 200
Write-Output '--- SIN RESOLVER ---'
$unres | ForEach-Object { $_.Ctx }

if ($Apply -and $resolved.Count -gt 0) {
  $sb = New-Object System.Text.StringBuilder($work)
  foreach ($r in ($resolved | Sort-Object Index -Descending)) {
    $sb.Remove($r.Index, $r.Run)
    $sb.Insert($r.Index, $r.Glyph)
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($target, $sb.ToString(), $utf8NoBom)
  Write-Output ("APLICADO: " + $resolved.Count + " reemplazos en $File")
} elseif (-not $Apply) {
  Write-Output 'DRY-RUN'
}
