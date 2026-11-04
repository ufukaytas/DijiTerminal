#!/bin/sh
# tests/hooks/statusline.test.sh — 01/02 statusline.sh testleri
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SL="$ROOT/hooks/statusline.sh"
. "$ROOT/tests/hooks/lib.sh"

DATA=$(mktemp -d)
export DIJI_DATA_DIR="$DATA"
trap 'rm -rf "$DATA"' EXIT

WITH='{"session_id":"s1","model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":1793150000},"seven_day":{"used_percentage":61,"resets_at":1793500000}}}'
WITHOUT='{"session_id":"s1","model":{"display_name":"Opus"}}'

section "Zincirsiz"
out=$(printf '%s' "$WITHOUT" | sh "$SL"); rc=$?
check "rate_limits yok → limits.json yazılmadı" [ ! -f "$DATA/limits.json" ]
check "çıktı boş, exit 0" test -z "$out" -a "$rc" = 0
out=$(printf '%s' "$WITH" | sh "$SL")
check "rate_limits var → limits.json yazıldı" [ -f "$DATA/limits.json" ]
check "limits.json içeriği aynen" [ "$(cat "$DATA/limits.json")" = "$WITH" ]
check "geçici dosya kalmadı" sh -c "! ls '$DATA' | grep -q 'limits\\..*\\.json'"
check "limits.json 0600" [ "$(stat -c %a "$DATA/limits.json" 2>/dev/null || stat -f %Lp "$DATA/limits.json")" = 600 ]

section "Zincirli"
cat > "$DATA/user-sl.sh" <<'EOF'
#!/bin/sh
read -r j
printf 'kullanıcı: %s' "$(printf '%s' "$j" | sed -n 's/.*"display_name":"\([^"]*\)".*/\1/p')"
EOF
chmod 755 "$DATA/user-sl.sh"
printf '{"command":"%s/user-sl.sh '"'"'arg with space'"'"'","padding":1}\n' "$DATA" > "$DATA/statusline-chain.json"
out=$(printf '%s' "$WITH" | sh "$SL")
check "orijinal komutun çıktısı aynen basıldı" [ "$out" = "kullanıcı: Opus" ]
check "zincirli modda da limits.json güncel" [ "$(cat "$DATA/limits.json")" = "$WITH" ]

section "Bozuk zincir dosyası"
printf 'bozuk' > "$DATA/statusline-chain.json"
out=$(printf '%s' "$WITHOUT" | sh "$SL"); rc=$?
check "çıktı boş, exit 0" test -z "$out" -a "$rc" = 0

finish
