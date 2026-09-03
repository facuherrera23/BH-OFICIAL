# fix-glyphs-final.ps1 — Restaura glifos/emojis de admin.html destruidos a '?'
# Reemplazos por fragmento exacto con contexto (no hay versión limpia en git: U+FFFD incrustado en el histórico).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$f = Join-Path $root 'admin.html'
$txt = [IO.File]::ReadAllText($f)

# ---- 1. KPI icons (16, en orden de aparición descubierto en el archivo) ----
# Orden confirmado por labels: Usuarios Activos, Acciones Hoy, Exitosas, Fallidas, Sensibles,
# Alertas Abiertas, Críticas, Exportaciones, Ops. Masivas, Conversión Lead→Cierre,
# Tiempo Medio Cierre, Cartera Venta, Cartera Alquiler, ROI Marketing, Productividad Brokers, SLA Respuesta
$kpiIcons = @('👥','⚡','✅','❌','🔐','🔔','🔴','📤','⚙️','🎯','⏱️','🏷️','🏠','📈','📊','⏲️')
$rxKpi = [regex]'font-size:36px; color:[^;]+; font-weight:700;">\?</div>'
$mt = $rxKpi.Matches($txt)
if ($mt.Count -eq $kpiIcons.Count) {
  $sb = New-Object System.Text.StringBuilder($txt)
  for ($i = $mt.Count - 1; $i -ge 0; $i--) {
    $sb.Remove($mt[$i].Index, $mt[$i].Length)
    $icon = $kpiIcons[$i]
    $sb.Insert($mt[$i].Index, ($mt[$i].Value -replace '\?\</div\>', ($icon + '</div>')))
  }
  $txt = $sb.ToString()
  Write-Output ("KPI icons reemplazados: " + $mt.Count)
} else {
  Write-Output ("ESPERABA 16 KPI icons pero encontre " + $mt.Count)
}

# ---- 2. Fragmentos de glifos/separadores ----
$pairs = @(
  @('" placeholder="????????"', '" placeholder="••••••••"'),
  @('placeholder="???????"', "placeholder='•••••••'"),
  @('"???? AR (Buenos Aires)"', '"🌎 AR (Buenos Aires)"'),
  @('>???? AR (Buenos Aires)<', '>🌎 AR (Buenos Aires)<'),
  @('>?? UTC<', '>🌐 UTC<'),
  @('>?? Crítica<', '>🔴 Crítica<'),
  @('>?? Alta<', '>🟠 Alta<'),
  @('>?? Media<', '>🟡 Media<'),
  @('>?? Baja<', '>🟢 Baja<'),
  @('>?? Error<', '>❌ Error<'),
  @('>?? Info<', '>ℹ️ Info<'),
  @('>? Éxito<', '>✅ Éxito<'),
  @('Auditoría ? Uso ? Seguridad ? Alertas', 'Auditoría · Uso · Seguridad · Alertas'),
  @('KPIs cruzados ? Tendencias ? Alertas estratégicas', 'KPIs cruzados · Tendencias · Alertas estratégicas'),
  @('dashboard</a> ? Settings ? API Key.', 'dashboard</a> → Settings → API Key.'),
  @('SUPERVISION CENTER ? tab-supervision', 'SUPERVISION CENTER — tab-supervision'),
  @('>Mi?</div>', '>Mié</div>'),
  @('(m?)</label>', '(m²)</label>'),
  @('Nombre (?nico)', 'Nombre (único)'),
  @('nunca ac?', 'nunca acá'),
  @('> ? Volver al sitio', '> ← Volver al sitio'),
  @('aria-label="Abrir Men?"', 'aria-label="Abrir Menú"'),
  @('Contacto ? Email', 'Contacto · Email'),
  @('Contacto ? Nombre', 'Contacto · Nombre'),
  @('Contacto ? Teléfono', 'Contacto · Teléfono'),
  @('se insertan aqu?', 'se insertan aquí'),
  @('>Seleccionar propiedad ?<', '>📋 Seleccionar propiedad<'),
  @('>? Seleccionar propiedad ?<', '>📋 Seleccionar propiedad<'),
  @('>? Seleccionar broker ?<', '>👤 Seleccionar broker<'),
  @('>? Sin vincular ?<', '>— Sin vincular<'),
  @('placeholder="?Qué podemos', 'placeholder="¿Qué podemos'),
  @('placeholder="Qu? estás buscando?"', 'placeholder="¿Qué estás buscando?"'),
  @('placeholder="?Qu estás buscando', 'placeholder="¿Qué estás buscando'),
  @('Estado de ?xito', 'Estado de Éxito'),
  @('el ?cono en la web', 'el ícono en la web')
)

$hits = 0
foreach ($p in $pairs) {
  $n = ([regex]::Matches($txt, [regex]::Escape($p[0]))).Count
  if ($n -gt 0) { $txt = $txt.Replace($p[0], $p[1]); $hits += $n }
}
Write-Output ("Fragmentos reemplazados: $hits")

# ---- 3. Verbos y completadores finales (final de palabra con '?') ----
$verbs = @(
  @('Modific? ', 'Modificá '),
  @('modific? ', 'modificá '),
  @('Eleg? ', 'Elegí '),
  @('eleg? ', 'elegí '),
  @('complet? ', 'completá '),
  @('Escrib? ', 'Escribí '),
  @('escrib? ', 'escribí '),
  @('Arrastr? ', 'Arrastrá '),
  @('arrastr? ', 'arrastrá '),
  @('hac? ', 'hacé '),
  @('Desactiv? ', 'Desactivá '),
  @('desactiv? ', 'desactivá '),
  @('Vincul? ', 'Vinculá '),
  @('vincul? ', 'vinculá '),
  @('Defin? ', 'Definí '),
  @('defin? ', 'definí '),
  @('confirm? ', 'confirmá '),
  @('Repet? ', 'Repetí '),
  @('repet? ', 'repetí '),
  @('contactará', 'contactará'),
  @('contactar? ', 'contactará '),
  @('Encontr? ', 'Encontrá '),
  @('encontr? ', 'encontrá '),
  @('est? impidiendo', 'está impidiendo'),
  @('abr? en', 'abrí en'),
  @('estás buscando', 'estás buscando'),
  @('buscando?"', 'buscando?"'),
  @('Mié', 'Mié')
)
foreach ($p in $verbs) {
  $n = ([regex]::Matches($txt, [regex]::Escape($p[0]))).Count
  if ($n -gt 0 -and $p[0] -cne $p[1]) { $txt = $txt.Replace($p[0], $p[1]); $hits += $n }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($f, $txt, $utf8NoBom)

# ---- Verificación final ----
$txt2 = [IO.File]::ReadAllText($f)
$remaining = ([regex]::Matches($txt2, '\?')).Count
Write-Output ("Total '?' restantes en admin.html: " + $remaining)
$inWords = ([regex]::Matches($txt2, '[A-Za-z]\?[A-Za-z]')).Count
Write-Output ("'?entreLetras' restantes: " + $inWords + " (deben ser solo ?v= etc.)")
