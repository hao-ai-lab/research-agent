# Uninstall script for Ralph Wiggum CLI (Windows)

$ErrorActionPreference = "Stop"

Write-Host "Uninstalling Ralph Wiggum CLI..."

if (Get-Command bun -ErrorAction SilentlyContinue) {
  Write-Host "Unlinking ralph command (bun)..."
  bun unlink @th0rgal/ralph-wiggum 2>$null
}

if (Get-Command npm -ErrorAction SilentlyContinue) {
  Write-Host "Removing global package (npm)..."
  npm uninstall -g @th0rgal/ralph-wiggum 2>$null
}

Write-Host ""
Write-Host "Uninstall complete!"
Write-Host "You may also want to remove the cloned repository."
