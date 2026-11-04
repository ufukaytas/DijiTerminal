#!/bin/sh
# DijiTerminal — Claude Code statusLine komutu
#
# Claude Code her status güncellemesinde oturum JSON'unu stdin'den verir.
#   1) JSON "rate_limits" içeriyorsa userData/limits.json'a atomik yazar (02/08 okur)
#   2) Kullanıcının önceki statusLine komutu zincirlenmişse (statusline-chain.json),
#      aynı JSON'u ona verir ve çıktısını aynen basar. Zincir yoksa hiçbir şey basmaz.
# Her yolda exit 0.

trap 'exit 0' EXIT HUP INT TERM
set +e
umask 077

DATA=${DIJI_DATA_DIR:-"$HOME/Library/Application Support/DijiTerminal"}
JSON=$(cat 2>/dev/null)

case "$JSON" in
  *'"rate_limits"'*)
    if mkdir -p "$DATA" 2>/dev/null; then
      tmp="$DATA/limits.$$.json"
      printf '%s' "$JSON" > "$tmp" 2>/dev/null && mv -f "$tmp" "$DATA/limits.json" 2>/dev/null
      rm -f "$tmp" 2>/dev/null
    fi
    ;;
esac

CHAIN="$DATA/statusline-chain.json"
[ -f "$CHAIN" ] || exit 0

# Zincir dosyasındaki "command" alanı: perl JSON::PP → plutil.
CMD=
if command -v perl >/dev/null 2>&1; then
  CMD=$(perl -MJSON::PP -e 'local $/; my $j = eval { JSON::PP->new->decode(<STDIN>) }; print $j->{command} if ref $j eq "HASH" && defined $j->{command} && !ref $j->{command};' < "$CHAIN" 2>/dev/null)
fi
[ -n "$CMD" ] || CMD=$(/usr/bin/plutil -extract command raw -o - "$CHAIN" 2>/dev/null)
[ -n "$CMD" ] || exit 0

# Kullanıcının kendi önceki komutu; Claude Code'un yaptığı gibi bir shell'de çalıştırılır.
printf '%s' "$JSON" | /bin/sh -c "$CMD" 2>/dev/null
exit 0
