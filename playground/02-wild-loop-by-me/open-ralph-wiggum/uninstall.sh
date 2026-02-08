#!/bin/bash
# Uninstall script for Ralph Wiggum CLI

set -e

echo "Uninstalling Ralph Wiggum CLI..."

if command -v bun &> /dev/null; then
  echo "Unlinking ralph command (bun)..."
  bun unlink @th0rgal/ralph-wiggum 2>/dev/null || true
fi

if command -v npm &> /dev/null; then
  echo "Removing global package (npm)..."
  npm uninstall -g @th0rgal/ralph-wiggum 2>/dev/null || true
fi

echo ""
echo "Uninstall complete!"
echo "You may also want to remove the cloned repository."
