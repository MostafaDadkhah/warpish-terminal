# Warpish shell integration for zsh.
# Loaded only inside Warpish Terminal sessions via an isolated ZDOTDIR.
# Emits CWD metadata for new sessions. Start/End markers are available only
# while retiring already-running sessions that explicitly opt into legacy mode.

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
  if [[ "${WARPISH_PRIVATE_SESSION:-0}" == 1 ]]; then
    case "$1" in
      Start\;*|End\;*)
        # Private sessions keep their live terminal behavior but never journal
        # or emit command text/output markers. Cwd markers remain available so
        # the UI can show the current directory without retaining scrollback.
        return 0
        ;;
    esac
  fi
  # The database journal preserves markers across server restarts. OSC keeps
  # the active browser responsive; the server de-duplicates replayed markers.
  __warpish_database_event "$1"
  __warpish_emit "$1"
}

__warpish_preexec() {
  emulate -L zsh
  [[ "${WARPISH_BLOCK_INTEGRATION:-0}" == 1 ]] || return 0
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
  if [[ "${__WARPISH_LAST_CWD:-}" != "$PWD" ]]; then
    __WARPISH_LAST_CWD="$PWD"
    __warpish_marker "Cwd;path=$(__warpish_b64 "$PWD")"
  fi
  return $exit_code
}

if [[ "${WARPISH_BLOCK_INTEGRATION:-0}" == 1 ]]; then
  add-zsh-hook preexec __warpish_preexec 2>/dev/null || true
fi
add-zsh-hook precmd __warpish_precmd 2>/dev/null || true

typeset -gr __WARPISH_HERMES_CHOICE_PROMPT_MARKER='[warpish-terminal:clarify-choices:v2]'
typeset -gr __WARPISH_HERMES_CHOICE_PROMPT='[warpish-terminal:clarify-choices:v2] Warpish Terminal interaction contract: whenever you call the clarify tool, always provide 2 to 4 short, mutually exclusive, context-aware choices. Never omit choices or pass an empty choices array. Hermes automatically adds the Other free-text row, so do not add an Other choice yourself.'

__warpish_hermes_ephemeral_prompt() {
  emulate -L zsh
  local existing="${HERMES_EPHEMERAL_SYSTEM_PROMPT:-}"

  # Hermes appends this prompt at API-call time, including for sessions whose
  # original stable system prompt is restored from the resume database.
  # Preserve a caller-provided prompt and append the host contract once.
  if [[ "$existing" == *"$__WARPISH_HERMES_CHOICE_PROMPT_MARKER"* ]]; then
    command printf '%s' "$existing"
  elif [[ -n "$existing" ]]; then
    command printf '%s\n\n%s' "$existing" "$__WARPISH_HERMES_CHOICE_PROMPT"
  else
    command printf '%s' "$__WARPISH_HERMES_CHOICE_PROMPT"
  fi
}

__warpish_hermes_should_apply_choice_prompt() {
  emulate -L zsh
  local arg
  for arg in "$@"; do
    [[ "$arg" == --safe-mode ]] && return 1
  done
  return 0
}

hermes() {
  emulate -L zsh
  local choice_prompt=''
  if __warpish_hermes_should_apply_choice_prompt "$@"; then
    choice_prompt="$(__warpish_hermes_ephemeral_prompt)"
  fi

  if [[ -n "$choice_prompt" ]]; then
    HERMES_EPHEMERAL_SYSTEM_PROMPT="$choice_prompt" command hermes "$@"
  else
    command hermes "$@"
  fi
}
