# Publish the Dossie MCP server to npm.
#
# Prerequisites (one-time):
#   1. npm account with publishing rights to the @dossie scope.
#   2. `npm login` completed in the same shell where you run this script.
#
# Run from anywhere — the script cd's into its own directory first:
#   ./publish.ps1
#
# After a successful publish, the package is installable via:
#   npx -y @dossie/mcp-server
# and the MCP server appears in registries that crawl npm.

$ErrorActionPreference = 'Stop'

Set-Location -Path $PSScriptRoot

Write-Host "==> Verifying npm login..." -ForegroundColor Cyan
$whoami = npm whoami 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Not logged into npm. Run 'npm login' first, then re-run this script."
    exit 1
}
Write-Host "    Logged in as: $whoami" -ForegroundColor Green

Write-Host "==> Verifying package.json..." -ForegroundColor Cyan
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
Write-Host "    Name:    $($pkg.name)"
Write-Host "    Version: $($pkg.version)"
Write-Host "    Files:   index.js, package.json, README.md, mcp-server.json"

Write-Host "==> Running npm publish (public access, @dossie scope)..." -ForegroundColor Cyan
npm publish --access public

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "PUBLISHED ::" -ForegroundColor Green
    Write-Host "  https://www.npmjs.com/package/$($pkg.name)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Verify install:  npx -y $($pkg.name)"
    Write-Host "  2. Submit to registries (see PUBLISH-GUIDE.md):"
    Write-Host "       Smithery:   https://smithery.ai/new"
    Write-Host "       MCPT:       https://mcpt.com/submit"
    Write-Host "       OpenTools:  https://opentools.com (PR to registry repo)"
} else {
    Write-Error "npm publish failed (exit $LASTEXITCODE). Common causes:"
    Write-Error "  - Not logged in OR scope-access denied (E403)."
    Write-Error "    Fix: 'npm login', then ensure the npm account owns the @dossie scope."
    Write-Error "  - Version already published. Bump version in package.json and retry."
    exit $LASTEXITCODE
}
