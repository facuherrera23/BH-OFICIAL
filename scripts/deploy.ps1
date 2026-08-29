#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deploy script for BIENENHAUS PROPIEDADES
    Usage: ./scripts/deploy.ps1 [-VersionBump] [-SkipLint] [-SkipSupabase] [-SkipCloudflare]

.DESCRIPTION
    Deploy script for BIENENHAUS PROPIEDADES to Cloudflare Pages + Supabase
    - Runs lint checks
    - Auto-increments cache buster version
    - Deploys to Cloudflare Pages
    - Deploys Supabase Edge Functions

.PARAMETER VersionBump
    Auto-increment cache buster version (default: true)

.PARAMETER SkipLint
    Skip lint checks (default: false)

.PARAMETER SkipSupabase
    Skip Supabase Edge Functions deploy (default: false)

.PARAMETER SkipCloudflare
    Skip Cloudflare Pages deploy (default: false)

.EXAMPLE
    ./scripts/deploy.ps1
    ./scripts/deploy.ps1 -SkipLint
    ./scripts/deploy.ps1 -SkipSupabase -SkipCloudflare
#>

param(
    [switch]$VersionBump = $true,
    [switch]$SkipLint = $false,
    [switch]$SkipSupabase = $false,
    [switch]$SkipCloudflare = $false
)

$ErrorActionPreference = "Stop"

Write-Host "=== BIENENHAUS DEPLOY ===" -ForegroundColor Cyan
Write-Host "Version bump: $VersionBump" -ForegroundColor Gray
Write-Host "Skip lint: $SkipLint" -ForegroundColor Gray
Write-Host "Skip Supabase: $SkipSupabase" -ForegroundColor Gray
Write-Host "Skip Cloudflare: $SkipCloudflare" -ForegroundColor Gray

# Check dependencies
$requiredCommands = @("git", "node", "npm", "supabase")
foreach ($cmd in $requiredCommands) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "Missing required command: $cmd"
        exit 1
    }
}

# Get current version
$adminHtml = Get-Content admin.html -Raw
$currentVersion = [regex]::Match($adminHtml, '(?<=admin-app\.js\?v=)\d+').Value
if (-not $currentVersion) {
    Write-Error "Could not find current version in admin.html"
    exit 1
}
Write-Host "Current version: v$currentVersion" -ForegroundColor Yellow

# Lint check
if (-not $SkipLint) {
    Write-Host "`n=== LINT CHECK ===" -ForegroundColor Cyan
    foreach ($file in @("assets/js/admin-app.js", "assets/js/landing-app.js", "assets/js/supabase-client.js", "assets/js/utils.js", "assets/js/cloudinary.js", "assets/js/config.js")) {
        Write-Host "Checking $file..." -NoNewline
        $result = node --check $file 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Lint failed for $file:`n$result"
            exit 1
        } else {
            Write-Host " OK" -ForegroundColor Green
        }
    }
}

# Version bump
$newVersion = $currentVersion
if ($VersionBump) {
    $newVersion = [int]$currentVersion + 1
    Write-Host "`n=== BUMPING VERSION: $currentVersion -> $newVersion ===" -ForegroundColor Cyan
    
    $filesToUpdate = @(
        @{ Path = "admin.html"; Pattern = "admin-app.js\?v=$currentVersion"; Replacement = "admin-app.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "index.html"; Pattern = "landing-app.js\?v=$currentVersion"; Replacement = "landing-app.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "index.html"; Pattern = "supabase-client.js\?v=$currentVersion"; Replacement = "supabase-client.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "admin.html"; Pattern = "supabase-client.js\?v=$currentVersion"; Replacement = "supabase-client.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "tasacion.html"; Pattern = "supabase-client.js\?v=$currentVersion"; Replacement = "supabase-client.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "index.html"; Pattern = "utils.js\?v=$currentVersion"; Replacement = "utils.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "admin.html"; Pattern = "utils.js\?v=$currentVersion"; Replacement = "utils.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "tasacion.html"; Pattern = "utils.js\?v=$currentVersion"; Replacement = "utils.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "admin.html"; Pattern = "config.js\?v=$currentVersion"; Replacement = "config.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "index.html"; Pattern = "config.js\?v=$currentVersion"; Replacement = "config.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "tasacion.html"; Pattern = "config.js\?v=$currentVersion"; Replacement = "config.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "admin.html"; Pattern = "cloudinary.js\?v=$currentVersion"; Replacement = "cloudinary.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "index.html"; Pattern = "cloudinary.js\?v=$currentVersion"; Replacement = "cloudinary.js?v=$([int]$currentVersion + 1)" },
        @{ Path = "admin.html"; Pattern = "admin.css\?v=$currentVersion"; Replacement = "admin.css?v=$([int]$currentVersion + 1)" },
        @{ Path = "index.html"; Pattern = "landing.css\?v=$currentVersion"; Replacement = "landing.css?v=$([int]$currentVersion + 1)" },
        @{ Path = "portal-propietario.html"; Pattern = "landing.css\?v=$currentVersion"; Replacement = "landing.css?v=$([int]$currentVersion + 1)" },
        @{ Path = "confirmar-visita.html"; Pattern = "landing.css\?v=$currentVersion"; Replacement = "landing.css?v=$([int]$currentVersion + 1)" }
    )

    foreach ($f in $filesToUpdate) {
        if (Test-Path $f.Path) {
            $content = Get-Content $f.Path -Raw
            $newContent = $content -replace $f.Pattern, $f.Replacement
            if ($content -ne $newContent) {
                Set-Content -Path $f.Path -Value $newContent -Encoding UTF8
                Write-Host "  Updated $($f.Path) v$currentVersion -> v$([int]$currentVersion + 1)" -ForegroundColor Green
            }
        }
    }
}

# Git commit if version bumped
if ($VersionBump) {
    Write-Host "`n=== COMMITTING VERSION BUMP ===" -ForegroundColor Cyan
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add admin.html index.html portal-propietario.html confirmar-visita.html tasacion.html
    git commit -m "chore: bump cache buster to v$([int]$currentVersion + 1)"
    Write-Host "Committed version bump to v$([int]$currentVersion + 1)" -ForegroundColor Green
}

# Supabase Edge Functions deploy
if (-not $SkipSupabase) {
    Write-Host "`n=== DEPLOY SUPABASE EDGE FUNCTIONS ===" -ForegroundColor Cyan
    $functionsDir = "supabase/functions"
    if (Test-Path $functionsDir) {
        $functions = Get-ChildItem $functionsDir -Directory | Select-Object -ExpandProperty Name
        foreach ($fn in $functions) {
            Write-Host "Deploying $fn..." -ForegroundColor Yellow
            $result = supabase functions deploy $fn --project-ref $env:SUPABASE_PROJECT_REF --no-verify-jwt 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Failed to deploy $fn:`n$result"
                exit 1
            }
            Write-Host "  $fn deployed OK" -ForegroundColor Green
        }
    } else {
        Write-Warning "No functions directory found at $functionsDir"
    }
}

# Cloudflare Pages deploy
if (-not $SkipCloudflare) {
    Write-Host "`n=== DEPLOY CLOUDFLARE PAGES ===" -ForegroundColor Cyan
    Write-Host "Deploying to Cloudflare Pages..." -ForegroundColor Yellow
    # Using wrangler or cloudflare/pages-action equivalent
    Write-Warning "Cloudflare deploy requires manual setup or cloudflare/pages-action in CI/CD"
    Write-Host "Run: npx wrangler pages deploy . --project-name=bienenhaus" -ForegroundColor Yellow
}

Write-Host "`n=== DEPLOY COMPLETE ===" -ForegroundColor Cyan
Write-Host "Version: v$([int]$currentVersion + (if ($VersionBump) { 1 } else { 0 }))" -ForegroundColor Green
Write-Host "Don't forget to push git changes: git push origin main" -ForegroundColor Yellow