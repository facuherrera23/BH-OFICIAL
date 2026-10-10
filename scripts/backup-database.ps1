# ============================================================
# backup-database.ps1 — Backup completo de la DB de producción.
#
# USO (una sola vez por semana, o antes de cualquier operación
# riesgosa en la base):
#   1. Supabase Dashboard → Settings → Database → Connection string
#      → "URI" (modo Session pool). Pegarla abajo en $CONN o
#      pasarla como parámetro.
#   2. Tener pg_dump instalado (PostgreSQL 15+ client).
#   3. Ejecutar:  .\scripts\backup-database.ps1
#      (opcional:  .\scripts\backup-database.ps1 -Conn "postgresql://...")
#
# El archivo queda en backups\backup-<fecha>.dump (formato custom
# de pg_dump, restaurable con pg_restore).
# La carpeta backups/ está ignorada por git a propósito: contiene
# datos reales de clientes y NUNCA debe commitearse.
# ============================================================

param(
    [string]$Conn = "",
    [string]$OutDir = "backups"
)

$ErrorActionPreference = "Stop"

if (-not $Conn) {
    $Conn = Read-Host "Pega la connection string de Supabase (Session pool)"
}
if (-not $Conn) { throw "Connection string vacia" }

if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
    throw "pg_dump no esta en el PATH. Instala PostgreSQL client (psql) o agregalo al PATH."
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$file = Join-Path $OutDir "backup-$stamp.dump"

Write-Host "Dumpando a $file ..."
& pg_dump $Conn --format=custom --no-owner --no-privileges --file=$file
if ($LASTEXITCODE -ne 0) { throw "pg_dump fallo con codigo $LASTEXITCODE" }

$size = (Get-Item $file).Length
Write-Host ("OK: {0:N0} bytes" -f $size)

# Verificacion de integridad del archivo de backup
Write-Host "Verificando el archivo (pg_restore --list)..."
& pg_restore --list $file | Select-Object -First 5
if ($LASTEXITCODE -ne 0) { throw "El archivo de backup no se puede leer — NO sirve como backup" }

Write-Host @"

BACKUP COMPLETO: $file
- Guardalo tambien en otro lugar (Drive/OneDrive externo al proyecto).
- Para restaurar en una DB nueva:
    pg_restore --clean --if-exists --no-owner -d "<connection-string-destino>" "$file"
- Recordatorio: el plan free de Supabase NO incluye backups automaticos;
  correr este script es la unica red de seguridad de los datos.
"@
