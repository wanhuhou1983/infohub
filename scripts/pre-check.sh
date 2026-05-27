#!/bin/sh
# pre-check.sh — Quality gate that must pass before building or pushing
# Run from repo root: sh scripts/pre-check.sh
# Equivalent to the Dockerfile check stage, but for local development

set -e

echo "=== TypeScript type check ==="
cd backend
bun x tsc --noEmit
echo "OK"

echo ""
echo "=== Inline JS syntax check ==="
cd ..
sh scripts/check-html-js.sh backend/frontend/index.html backend/frontend/infohub-admin.html

echo ""
echo "=== Tests ==="
cd backend
bun test

echo ""
echo "✅ All pre-check gates passed"
