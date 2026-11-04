# tests/hooks/lib.sh — shell testleri için küçük yardımcılar (source edilir)
PASS=0
FAIL=0
section() { printf '\n▸ %s\n' "$1"; }
check() {
  name=$1; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); printf '  ✓ %s\n' "$name"
  else FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$name"; fi
}
finish() {
  printf '\n%d geçti, %d kaldı\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}
