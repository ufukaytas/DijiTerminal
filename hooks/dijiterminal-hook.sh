#!/bin/sh
# DijiTerminal — Claude Code hook script
#
# Claude Code her hook olayında bu script'i çalıştırır ve olay JSON'unu stdin'den verir.
#   1) Claude sürecinin iTerm2 sekmesini duruma göre boyar (tty'ye escape kodu yazar)
#   2) Olayı userData/hook-events.jsonl dosyasına tek satır olarak ekler
#   3) Varsa notify.sh'ı (01/03) arka planda çağırır
# Kurallar: stdout/stderr'e hiçbir şey yazmaz, her yolda exit 0, ağ ve osascript yok.

trap 'exit 0' EXIT HUP INT TERM
set +e
umask 077

DATA=${DIJI_DATA_DIR:-"$HOME/Library/Application Support/DijiTerminal"}

INPUT=$(cat 2>/dev/null)
[ -n "$INPUT" ] || exit 0

# ---------- JSON okuma ----------
# Öncelik: perl JSON::PP (macOS'ta yerleşik, tek çağrıda tüm alanlar, kaçışları doğru çözer)
# → plutil (macOS 12+) → sed (düz alanlar için son çare).
SESSION_ID= CWD= EVENT= TOOL= MESSAGE= NTYPE= TS=

parse_perl() {
  command -v perl >/dev/null 2>&1 || return 1
  printf '%s' "$INPUT" | perl -MJSON::PP -MTime::HiRes=time -e '
    local $/; my $j = eval { JSON::PP->new->decode(<STDIN>) };
    exit 1 unless ref $j eq "HASH";
    binmode STDOUT, ":encoding(UTF-8)";
    printf "%d\n", time * 1000;
    for my $k (qw(session_id cwd hook_event_name tool_name message notification_type)) {
      my $v = $j->{$k}; $v = "" if !defined $v || ref $v;
      $v =~ s/[\r\n\t]+/ /g; $v =~ s/[\x00-\x1f\x7f]//g;
      $v = substr($v, 0, 200) if $k eq "message";
      print $v, "\n";
    }' 2>/dev/null
}

jget_fallback() {
  v=$(printf '%s' "$INPUT" | /usr/bin/plutil -extract "$1" raw -o - - 2>/dev/null)
  if [ -z "$v" ]; then
    v=$(printf '%s' "$INPUT" | sed -n -E "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | head -n 1 \
        | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')
  fi
  printf '%s' "$v" | tr '\t\r\n' '   ' | tr -d '\000-\010\013\014\016-\037'
}

if FIELDS=$(parse_perl); then
  {
    IFS= read -r TS
    IFS= read -r SESSION_ID
    IFS= read -r CWD
    IFS= read -r EVENT
    IFS= read -r TOOL
    IFS= read -r MESSAGE
    IFS= read -r NTYPE
  } <<EOF
$FIELDS
EOF
else
  SESSION_ID=$(jget_fallback session_id)
  CWD=$(jget_fallback cwd)
  EVENT=$(jget_fallback hook_event_name)
  TOOL=$(jget_fallback tool_name)
  MESSAGE=$(jget_fallback message | cut -c1-200)
  NTYPE=$(jget_fallback notification_type)
fi
[ -n "$TS" ] || TS="$(date +%s)000"

# session_id ve olay adı dosya yollarında kullanılır: yalnızca güvenli karakterler.
SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-80)
EVENT=$(printf '%s' "$EVENT" | tr -cd 'A-Za-z')
[ -n "$SESSION_ID" ] && [ -n "$EVENT" ] || exit 0

# ---------- Claude süreci, tty, iTerm2 ----------
# Hook ara bir `sh -c` üzerinden çalışabilir: $PPID'den yukarı en fazla 6 seviye yürü.
CLAUDE_PID= TTY= IN_ITERM=
p=$PPID
i=0
while [ "$i" -lt 6 ] && [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
  # Tek ps çağrısı: ppid, tty, komut adı (komut adı boşluk içerebilir)
  line=$(ps -o ppid= -o tty= -o comm= -p "$p" 2>/dev/null)
  [ -n "$line" ] || break
  set -f; set -- $line; set +f
  pp=$1; t=$2; shift 2; c="$*"
  if [ -z "$CLAUDE_PID" ]; then
    case "$c" in
      *[Cc]laude*) CLAUDE_PID=$p ;;
      *node*|*bun*)  # npm kurulumunda süreç adı node olabilir: argümanlara bak
        case "$(ps -o args= -p "$p" 2>/dev/null)" in *claude*) CLAUDE_PID=$p ;; esac ;;
    esac
  fi
  case "$c" in *iTerm*) IN_ITERM=1 ;; esac
  if [ -z "$TTY" ] && [ -n "$t" ] && [ "$t" != "??" ] && [ "$t" != "?" ]; then
    case "$t" in /dev/*) TTY=$t ;; *) TTY="/dev/$t" ;; esac
  fi
  [ -n "$CLAUDE_PID" ] && [ -n "$TTY" ] && break
  p=$pp
  i=$((i + 1))
done
[ -n "$CLAUDE_PID" ] || CLAUDE_PID=$PPID
[ -n "$TTY" ] && [ ! -w "$TTY" ] && TTY=
[ "$LC_TERMINAL" = "iTerm2" ] || [ "$TERM_PROGRAM" = "iTerm.app" ] && IN_ITERM=1
# Testler için: escape kodlarını gerçek tty yerine bir dosyaya yönlendir.
if [ -n "$DIJI_TEST_TTY" ]; then TTY=$DIJI_TEST_TTY; IN_ITERM=1; fi

# ---------- Durum ve renk ----------
STATE_DIR="$DATA/state"
STATE_FILE="$STATE_DIR/$SESSION_ID"
PREV=$(cat "$STATE_FILE" 2>/dev/null)
NEXT=

is_permission() {
  case "$NTYPE" in
    *permission*) return 0 ;;
    idle*|*idle_prompt*) return 1 ;;
  esac
  lower=$(printf '%s' "$MESSAGE" | tr '[:upper:]' '[:lower:]')
  case "$lower" in *permission*|*izin*|*approve*|*approval*) return 0 ;; esac
  return 1
}

case "$EVENT" in
  SessionStart)      NEXT=idle ;;
  UserPromptSubmit)  NEXT=busy ;;
  PreToolUse)
    # Kullanıcıdan cevap bekleyen araçlar: PreToolUse onay penceresinden önce gelir ve
    # ardından Notification gelmeyebilir (Mac'te doğrulandı) → doğrudan waiting.
    case "$TOOL" in
      ExitPlanMode|AskUserQuestion) NEXT=waiting ;;
      *) [ "$PREV" != busy ] && NEXT=busy ;;
    esac ;;
  PostToolUse)       [ "$PREV" = waiting ] && NEXT=busy ;;
  Notification)      if is_permission; then NEXT=waiting; else NEXT=idle; fi ;;
  Stop)              NEXT=idle ;;
  SessionEnd)        NEXT=ended ;;
  *)                 NEXT= ;;
esac

paint() {
  [ -n "$IN_ITERM" ] && [ -n "$TTY" ] || return 0
  printf '\033]6;1;bg;red;brightness;%d\a\033]6;1;bg;green;brightness;%d\a\033]6;1;bg;blue;brightness;%d\a' "$1" "$2" "$3" > "$TTY" 2>/dev/null
}
reset_tab() {
  [ -n "$IN_ITERM" ] && [ -n "$TTY" ] || return 0
  printf '\033]6;1;bg;*;default\a' > "$TTY" 2>/dev/null
}

if [ -n "$NEXT" ] && [ "$NEXT" != "$PREV" ]; then
  case "$NEXT" in
    busy)    paint 94 179 255 ;;
    waiting) paint 242 177 52 ;;
    idle)    paint 76 195 138 ;;
    ended)   reset_tab ;;
  esac
  if [ "$NEXT" = ended ]; then
    rm -f "$STATE_FILE" 2>/dev/null
  else
    mkdir -p "$STATE_DIR" 2>/dev/null && printf '%s\n' "$NEXT" > "$STATE_FILE" 2>/dev/null
  fi
fi

# ---------- JSONL log ----------
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

LINE="{\"v\":1,\"ts\":$TS,\"event\":\"$EVENT\",\"sessionId\":\"$SESSION_ID\",\"cwd\":\"$(esc "$CWD")\""
if [ -n "$TTY" ]; then LINE="$LINE,\"tty\":\"$(esc "$TTY")\""; else LINE="$LINE,\"tty\":null"; fi
case "$CLAUDE_PID" in ''|*[!0-9]*) CLAUDE_PID=0 ;; esac
LINE="$LINE,\"claudePid\":$CLAUDE_PID"
[ -n "$TOOL" ] && LINE="$LINE,\"tool\":\"$(esc "$TOOL")\""
[ -n "$MESSAGE" ] && LINE="$LINE,\"message\":\"$(esc "$MESSAGE")\""
[ -n "$NTYPE" ] && LINE="$LINE,\"notificationType\":\"$(esc "$NTYPE")\""
LINE="$LINE}"

LOG="$DATA/hook-events.jsonl"
if mkdir -p "$DATA" 2>/dev/null; then
  if [ -f "$LOG" ]; then
    size=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
    [ -n "$size" ] && [ "$size" -gt 5242880 ] 2>/dev/null && mv -f "$LOG" "$LOG.1" 2>/dev/null
  fi
  printf '%s\n' "$LINE" >> "$LOG" 2>/dev/null
fi

# ---------- Bildirim (01/03) ----------
NOTIFY="$DATA/hooks/notify.sh"
if [ -x "$NOTIFY" ]; then
  ( env CLAUDE_PID="$CLAUDE_PID" TTY="$TTY" DIJI_DATA_DIR="$DATA" NOTIFY_TYPE="$NTYPE" \
      "$NOTIFY" "$EVENT" "$SESSION_ID" "$CWD" "$TOOL" "$MESSAGE" </dev/null >/dev/null 2>&1 & ) >/dev/null 2>&1
fi

exit 0
