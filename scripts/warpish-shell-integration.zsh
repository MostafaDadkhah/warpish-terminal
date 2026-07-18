# Warpish shell integration for zsh.
# Loaded only inside Warpish Terminal sessions via an isolated ZDOTDIR.
# Emits invisible OSC markers that the web server converts into command blocks.

if [[ -n "${__WARPISH_SHELL_INTEGRATION_LOADED:-}" ]]; then
  return 0
fi
__WARPISH_SHELL_INTEGRATION_LOADED=1

zmodload zsh/datetime 2>/dev/null || true
autoload -Uz add-zsh-hook 2>/dev/null || true

__warpish_b64() {
  command printf '%s' "$1" | /usr/bin/base64 | tr -d '\n'
}

__warpish_now() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    command printf '%s' "$EPOCHREALTIME"
  else
    command date +%s
  fi
}

__warpish_emit() {
  # OSC 697 is a private marker namespace for this local tool.
  command printf '\033]697;%s\007' "$1"
}

__warpish_database_event() {
  [[ -n "${WARPISH_DATABASE_FILE:-}" ]] || return 0
  [[ -n "${WARPISH_EVENT_RECORDER:-}" ]] || return 0
  [[ -n "${WARPISH_PYTHON:-}" ]] || return 0
  [[ -n "${WARPISH_SESSION_ID:-}" ]] || return 0
  command "$WARPISH_PYTHON" "$WARPISH_EVENT_RECORDER" \
    --database "$WARPISH_DATABASE_FILE" \
    --session-id "$WARPISH_SESSION_ID" \
    --payload "$1" >/dev/null 2>&1 || true
}

__warpish_marker() {
  # The database journal preserves markers across server restarts. OSC keeps
  # the active browser responsive; the server de-duplicates replayed markers.
  __warpish_database_event "$1"
  __warpish_emit "$1"
}

__warpish_preexec() {
  emulate -L zsh
  local command_line="$1"
  [[ -z "$command_line" ]] && return 0
  [[ "$command_line" == __warpish_* ]] && return 0

  __WARPISH_BLOCK_ID="${WARPISH_SESSION_ID:-warpish}-$(command date +%s)-$RANDOM"
  __WARPISH_BLOCK_STARTED="$(__warpish_now)"
  __warpish_marker "Start;id=${__WARPISH_BLOCK_ID};started=${__WARPISH_BLOCK_STARTED};command=$(__warpish_b64 "$command_line")"
}

__warpish_precmd() {
  local exit_code=$?
  emulate -L zsh
  if [[ -n "${__WARPISH_BLOCK_ID:-}" ]]; then
    local ended="$(__warpish_now)"
    __warpish_marker "End;id=${__WARPISH_BLOCK_ID};ended=${ended};status=${exit_code}"
    unset __WARPISH_BLOCK_ID __WARPISH_BLOCK_STARTED
  fi
  return $exit_code
}

add-zsh-hook preexec __warpish_preexec 2>/dev/null || true
add-zsh-hook precmd __warpish_precmd 2>/dev/null || true

__warpish_hermes_should_force_cli() {
  emulate -L zsh
  local arg
  for arg in "$@"; do
    case "$arg" in
      --cli|--tui|--dev|-z|--oneshot|-h|--help|--version|-V)
        return 1
        ;;
    esac
  done

  # Hermes' modern TUI uses an alternate screen and can trap scrollback inside
  # browser xterm. In Warpish, default interactive/resume Hermes sessions to the
  # classic CLI unless the user explicitly asks for --tui.
  [[ $# -eq 0 ]] && return 0
  for arg in "$@"; do
    case "$arg" in
      --resume|--resume=*|-r|--continue|--continue=*|-c)
        return 0
        ;;
    esac
  done
  return 1
}

hermes() {
  emulate -L zsh
  if __warpish_hermes_should_force_cli "$@"; then
    command hermes --cli "$@"
  else
    command hermes "$@"
  fi
}
