#!/bin/sh
# check-html-js.sh — Extract inline <script> blocks from HTML and syntax-check them
#
# Wraps each block in a function to prevent top-level evaluation side-effects.
# Auto-detects node binary: uses system node if available, falls back to
# bun's Node.js compatibility layer.
#
# Usage: sh check-html-js.sh file1.html file2.html ...

set -e

# Auto-detect node binary
if command -v node > /dev/null 2>&1; then
  NODE="node"
elif [ -x /usr/local/bun-node-fallback-bin/node ]; then
  NODE="/usr/local/bun-node-fallback-bin/node"
else
  echo "ERROR: No Node.js runtime found (tried: node, bun fallback node)"
  exit 1
fi

PASS=0
FAIL=0
TMP="/tmp/html-js-check-$$.js"
BLOCK="/tmp/html-js-block-$$.js"

for html_file in "$@"; do
  if [ ! -f "$html_file" ]; then
    echo "SKIP: $html_file (not found)"
    continue
  fi

  # Extract all inline <script> blocks
  sed -n '/^<script>$/,/^<\/script>$/{ /^<script>$/d; /^<\/script>$/d; p; }' "$html_file" > "$BLOCK"

  if [ ! -s "$BLOCK" ]; then
    echo "  OK  $(basename $html_file) (no inline scripts)"
    rm -f "$BLOCK"
    PASS=$((PASS + 1))
    continue
  fi

  # Wrap in a function to prevent eval of top-level expressions
  echo "function __check_$$__() {" > "$TMP"
  cat "$BLOCK" >> "$TMP"
  echo "}" >> "$TMP"

  if $NODE --check "$TMP" 2>/dev/null; then
    echo "  OK  $(basename $html_file)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $(basename $html_file)"
    $NODE --check "$TMP" 2>&1 | sed "s|$TMP|$html_file|g" | head -10
    echo ""
    FAIL=$((FAIL + 1))
  fi

  rm -f "$TMP" "$BLOCK"
done

echo ""
if [ $FAIL -eq 0 ]; then
  echo "All $PASS HTML files passed inline JS syntax check"
else
  echo "$FAIL file(s) FAILED inline JS syntax check (passed: $PASS)"
  exit 1
fi
