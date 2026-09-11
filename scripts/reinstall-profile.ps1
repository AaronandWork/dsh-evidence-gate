# Re-installs dsh-evidence-gate into the dsh profile after a manifest rewrite
# wipes it (dshmarket / pnpm runs have done this three times — see PUBLISH.md §3).
# Usage: powershell -File scripts\reinstall-profile.ps1
# Run BEFORE starting the deployment (pnpm needs the file locks free).

$ErrorActionPreference = 'Stop'

$src     = 'E:/Agent/dsh-evidence-gate'
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$scoped  = '@aaronandwork/dsh-evidence-gate'
$pkgJson = Join-Path $profile 'package.json'
$patch   = Join-Path $profile 'cordis.patch.yml'

# 1. dependency + bundles entry
$raw = Get-Content $pkgJson -Raw -Encoding UTF8
if ($raw -notmatch [regex]::Escape($scoped)) {
  $raw = $raw -replace '("dependencies"\s*:\s*\{)', ('$1' + "`n    `"$scoped`": `"file:$src`",")
  $raw = $raw -replace '("dsh-free-search",)', ('$1' + "`n        `"$scoped`"")
  Set-Content $pkgJson $raw -Encoding UTF8 -NoNewline
  Write-Host 'manifest: dependency + bundles entry re-added'
} else {
  Write-Host 'manifest: entry already present'
}

# 2. user-layer patch: must stay an EMPTY YAML ARRAY (`[]`) — the bundle's own
#    cordis.patch.yml inserts the row. A second insert double-mounts the plugin
#    (duplicate registrations at boot); a comments-only file is not a YAML array
#    and the loader rejects it.
$empty = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
#
# NOTE: keep this an EMPTY ARRAY unless you need overrides.
# Do NOT add an insert row for @aaronandwork/dsh-evidence-gate here — the
# bundle's own cordis.patch.yml already inserts the row, and a second insert
# double-mounts the plugin (boot fails with duplicate registrations).
# If the bundles entry ever goes missing, run scripts\reinstall-profile.ps1.
[]
'@
Set-Content $patch $empty -Encoding UTF8 -NoNewline
Write-Host 'patch: reset to canonical empty array'

# 3. install (run with the deployment STOPPED — pnpm needs the locks)
Push-Location $profile
pnpm install 2>&1 | Select-Object -Last 2
Pop-Location

# 4. integrity check
$missing = @('package.json', 'lib\index.js', 'lib\client.mjs', 'cordis.patch.yml') |
  Where-Object { -not (Test-Path (Join-Path $profile "node_modules\$scoped\$_")) }
if ($missing.Count -eq 0) {
  Write-Host "OK — $scoped fully installed. Start the deployment, then Ctrl+F5."
} else {
  Write-Host "INCOMPLETE — missing: $($missing -join ', ')"
  exit 1
}
