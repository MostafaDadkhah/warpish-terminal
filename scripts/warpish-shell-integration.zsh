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

__warpish_file_event() {
  if [[ -n "${WARPISH_EVENT_FILE:-}" ]]; then
    command mkdir -p "${WARPISH_EVENT_FILE:h}" 2>/dev/null || true
    command printf '%s\n' "$1" >> "$WARPISH_EVENT_FILE" 2>/dev/null || true
  fi
}

__warpish_marker() {
  __warpish_emit "$1"
  __warpish_file_event "$1"
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
  emulate -L zsh
  local exit_code=$?
  if [[ -n "${__WARPISH_BLOCK_ID:-}" ]]; then
    local ended="$(__warpish_now)"
    __warpish_marker "End;id=${__WARPISH_BLOCK_ID};ended=${ended};status=${exit_code}"
    unset __WARPISH_BLOCK_ID __WARPISH_BLOCK_STARTED
  fi
  return $exit_code
}

add-zsh-hook preexec __warpish_preexec 2>/dev/null || true
add-zsh-hook precmd __warpish_precmd 2>/dev/null || true
