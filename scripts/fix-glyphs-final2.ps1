# fix-glyphs-final2.ps1 — Segunda pasada de reparación de glifos en admin.html
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$f = Join-Path $root 'admin.html'
$txt = [IO.File]::ReadAllText($f)

$pairs = @(
  @('?ltima Actividad', 'Última Actividad'),
  @('?ltimos Eventos', 'Últimos Eventos'),
  @('placeholder="?Qu?', 'placeholder="¿Qué'),
  @('"field" data-key="initial_question" placeholder="?Qu?', '"field" data-key="initial_question" placeholder="¿Qué'),
  @('est?s buscando', 'estás buscando'),
  @('por vos?"', 'por vos?"'),
  @('<h1>Carg? tu', '<h1>Cargá tu'),
  @('Carg? tu', 'Cargá tu'),
  @('>? Info</option>', '>ℹ️ Info</option>'),
  @('>? ?xito</option>', '>✅ Éxito</option>'),
  @('>Conectando Realtime?<', '>Conectando Realtime…<'),
  @('placeholder="?Consulta Enviada!"', 'placeholder="¡Consulta Enviada!"'),
  @('index.html">? Volver al sitio', 'index.html">← Volver al sitio'),
  @('Enter para enviar ? Shift+Enter', 'Enter para enviar · Shift+Enter'),
  @('(RELA_CLIENT_ID / RELA_CLIENT_SECRET) ? nunca ac?', '(RELA_CLIENT_ID / RELA_CLIENT_SECRET) — nunca acá'),
  @('nunca ac?.', 'nunca acá.'),
  @('casa/departamento/? ? {', 'casa/departamento/otro → {'),
  @('zona normalizada ? idUbicacion', 'zona normalizada → idUbicacion'),
  @('placeholder="Conoc? a ', 'placeholder="Conocé a '),
  @('?quÃ-c?n', '?qué')
)

$hits = 0
foreach ($p in $pairs) {
  $n = ([regex]::Matches($txt, [regex]::Escape($p[0]))).Count
  if ($n -gt 0) { Write-Output ("{0}x  {1}" -f $n, $p[0]); $txt = $txt.Replace($p[0], $p[1]); $hits += $n }
}

# Chips genéricos pequeños '...</div>' restantes: contarlos primero
$rxChip = [regex]'color:var\(--text-secondary\);">\?</div>'
$m = $rxChip.Matches($txt)
Write-Output ("chips genéricos restantes: " + $m.Count)
if ($m.Count -gt 0) {
  $sb = New-Object System.Text.StringBuilder($txt)
  foreach ($c in (@($m) | ForEach-Object { $_ })[-1..0]) {
    $sb.Remove($c.Index, $c.Length)
    $sb.Insert($c.Index, ($c.Value -replace '\?', 'ℹ️'))
  }
  $txt = $sb.ToString()
  Write-Output ("reemplazados chips: " + $m.Count)
}
$rxChip2 = [regex]'overflow-y:auto;">\?</div>'
$m2 = $rxChip2.Matches($txt)
Write-Output ("chips-tabla restantes: " + $m2.Count)
if ($m2.Count -gt 0) {
  $txt = $txt -replace 'overflow-y:auto;">\?</div>', 'overflow-y:auto;">📅</div>'
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($f, $txt, $utf8NoBom)

# Verificación
$txt2 = [IO.File]::ReadAllText($f)
$m = [regex]::Matches($txt2, '\?')
Write-Output ("Total '?' restantes: " + $m.Count)
