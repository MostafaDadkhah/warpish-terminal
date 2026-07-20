const terminalEl = document.getElementById('terminal');
const terminalCard = document.querySelector('.terminal-card');
const statusCard = document.getElementById('statusCard');
const statusText = document.getElementById('statusText');
const sessionText = document.getElementById('sessionText');
const sessionTitle = document.getElementById('sessionTitle');
const sessionMeta = document.getElementById('sessionMeta');
const sessionList = document.getElementById('sessionList');
const newSessionButton = document.getElementById('newSession');
const refreshSessionsButton = document.getElementById('refreshSessions');
const clearStoppedSessionsButton = document.getElementById('clearStoppedSessions');
const pasteDialog = document.getElementById('pasteDialog');
const pastePreview = document.getElementById('pastePreview');
const mobileTerminalKeys = document.querySelector('.mobile-terminal-keys');

const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon?.FitAddon;
const WebLinksAddonCtor = window.WebLinksAddon?.WebLinksAddon;
const terminalInputApi = window.WarpishTerminalInput;
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

const TERMINAL_THEME = Object.freeze({
  background: '#070711',
  foreground: '#f4f1ff',
  cursor: '#22d3ee',
  selectionBackground: '#5b4a9f66',
  black: '#11111b',
  red: '#fb7185',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#f3f4f6',
  brightBlack: '#6b7280',
  brightRed: '#fda4af',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
});

const term = new TerminalCtor({
  cursorBlink: !prefersReducedMotion,
  cursorStyle: 'bar',
  macOptionIsMeta: true,
  convertEol: false,
  fontFamily: '"SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 13.5,
  lineHeight: 1.16,
  letterSpacing: 0,
  scrollback: 50000,
  screenReaderMode: false,
  allowProposedApi: true,
  allowTransparency: true,
  theme: TERMINAL_THEME,
});

const RTL_SCRIPT_CHARACTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;

function rtlCharacterJoinRanges(text) {
  const start = String(text || '').search(RTL_SCRIPT_CHARACTER);
  if (start < 0) return [];
  return [[start, text.length]];
}

const fitAddon = FitAddonCtor ? new FitAddonCtor() : null;
if (fitAddon) term.loadAddon(fitAddon);
if (WebLinksAddonCtor) term.loadAddon(new WebLinksAddonCtor());
term.open(terminalEl);
term.registerCharacterJoiner?.(rtlCharacterJoinRanges);

let rtlCursorFrame = null;

function syncRtlCursorPosition() {
  rtlCursorFrame = null;
  const priorCursor = terminalEl.querySelector('.xterm-cursor.warpish-rtl-cursor');
  if (priorCursor) {
    priorCursor.classList.remove('warpish-rtl-cursor');
    priorCursor.style.removeProperty('--warpish-rtl-cursor-shift');
  }

  const cursor = terminalEl.querySelector('.xterm-rows .xterm-cursor');
  const rtlSpan = cursor?.previousElementSibling;
  if (!cursor || !rtlSpan || !RTL_SCRIPT_CHARACTER.test(rtlSpan.textContent || '')) return;

  const row = cursor.parentElement;
  const rowRect = row?.getBoundingClientRect();
  const cursorRect = cursor.getBoundingClientRect();
  const rtlRect = rtlSpan.getBoundingClientRect();
  if (!rowRect || !cursorRect.width || rtlRect.width <= cursorRect.width) return;

  const cursorColumn = Math.round((cursorRect.left - rowRect.left) / cursorRect.width);
  const rtlEndColumn = Math.round((rtlRect.right - rowRect.left) / cursorRect.width);
  if (cursorColumn !== rtlEndColumn) return;

  cursor.style.setProperty('--warpish-rtl-cursor-shift', `-${rtlRect.width}px`);
  cursor.classList.add('warpish-rtl-cursor');
}

function scheduleRtlCursorPosition() {
  if (rtlCursorFrame !== null) return;
  rtlCursorFrame = window.requestAnimationFrame(syncRtlCursorPosition);
}

term.onRender(scheduleRtlCursorPosition);
terminalEl.addEventListener('focusin', scheduleRtlCursorPosition);
terminalEl.addEventListener('focusout', scheduleRtlCursorPosition);

const terminalHelperTextarea = () => terminalEl?.querySelector?.('.xterm-helper-textarea') || null;
const helperTextarea = terminalHelperTextarea();
if (helperTextarea) {
  helperTextarea.setAttribute('aria-label', 'Terminal input');
  helperTextarea.setAttribute('inputmode', 'text');
  helperTextarea.setAttribute('enterkeyhint', 'enter');
  helperTextarea.setAttribute('autocapitalize', 'off');
  helperTextarea.setAttribute('autocomplete', 'off');
  helperTextarea.setAttribute('autocorrect', 'off');
  helperTextarea.spellcheck = false;
}

const SESSION_PREVIEW_CHARS = 900;
const AUTH_COOKIE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_TERMINAL_INPUT_MESSAGE_BYTES = terminalInputApi?.MAX_MESSAGE_BYTES || 64 * 1024;
const MAX_PENDING_TERMINAL_INPUT_BYTES = terminalInputApi?.MAX_PENDING_BYTES || 1024 * 1024;
const MAX_BROWSER_SOCKET_BUFFERED_BYTES = 256 * 1024;

let sessions = [];
let currentSessionId = null;
let ws = null;
let connectionSerial = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;
let terminalControlRole = 'controller';
let controlClaimPending = false;
let newSessionCreationPending = false;
const closingSessionIds = new Set();
let sessionsRequestSerial = 0;
let sessionsRefreshPending = false;
let sessionsRefreshQueued = null;
let sessionsMutationDepth = 0;
let pendingTerminalInputs = [];
let terminalInputFlushTimer = null;
let terminalFitRaf = null;
let lastSentTerminalSize = '';
let refreshTimer = null;
let authRefreshTimer = null;
let pendingMultilinePaste = null;
let focusTimer = null;
let terminalSurfaceGeneration = 0;
let terminalSurfaceTransitioning = false;
let terminalInputSequence = 0;
let terminalRuntimeEpoch = null;
let controllerFocusReported = false;
let commandActivity = null;
let commandCompletionTimer = null;

const intentionallyClosedSockets = new WeakSet();
const terminalInputClientId = window.crypto?.randomUUID?.()
  || Math.random().toString(36).slice(2);

const initialParams = new URLSearchParams(window.location.search);
const initialToken = initialParams.get('token');
if (initialToken) window.history.replaceState({}, document.title, window.location.pathname);

function authHeaders(options = {}) {
  return {
    ...(initialToken ? { 'x-warpish-token': initialToken } : {}),
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
}

async function parseApiResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  let payload = {};
  if (text && contentType.includes('application/json')) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = { error: 'Invalid JSON response: ' + error.message };
    }
  } else if (text) {
    payload = { error: text };
  }
  if (!response.ok) {
    const message = payload.error || payload.message || text || ('HTTP ' + response.status);
    const error = new Error('HTTP ' + response.status + ': ' + message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function api(path, options = {}) {
  const { timeoutMs = 15000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortFromExternalSignal();
    else externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    const response = await fetch(path, {
      ...fetchOptions,
      credentials: 'same-origin',
      headers: authHeaders(fetchOptions),
      signal: controller.signal,
    });
    return await parseApiResponse(response);
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new Error('Request timed out after ' + Math.round(timeoutMs / 1000) + 's');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener?.('abort', abortFromExternalSignal);
  }
}

async function refreshAuthCookie() {
  return api('/api/auth/refresh', {
    method: 'POST',
    timeoutMs: 10000,
  });
}

function setStatus(kind, text, detail = '') {
  statusCard.classList.remove('status-ok', 'status-bad', 'status-running');
  if (kind === 'ok') statusCard.classList.add('status-ok');
  if (kind === 'bad') statusCard.classList.add('status-bad');
  if (kind === 'running') statusCard.classList.add('status-running');
  if (kind === 'running') statusCard.setAttribute('aria-busy', 'true');
  else statusCard.removeAttribute('aria-busy');
  statusText.textContent = text;
  sessionText.textContent = detail;
}

function clearCommandCompletionTimer() {
  if (commandCompletionTimer) window.clearTimeout(commandCompletionTimer);
  commandCompletionTimer = null;
}

function commandActivityDetail(state = commandActivity) {
  if (state?.phase === 'pending') return 'command accepted • waiting for the shell';
  const processName = compactText(state?.processName || '', 80);
  return (processName ? processName + ' • ' : '') + 'Ctrl+C to stop';
}

function renderCommandActivity() {
  if (!commandActivity?.running) return false;
  clearCommandCompletionTimer();
  setStatus('running', 'command running…', commandActivityDetail());
  return true;
}

function renderConnectionStatus(title = activeSession()?.title || 'terminal') {
  if (renderCommandActivity()) return;
  if (terminalControlRole === 'controller') {
    setStatus('ok', 'connected', title + ' • this tab has control');
  } else if (terminalControlRole === 'spectator') {
    setStatus('warn', 'view only', title + ' • click or type to take control');
  }
}

function resetCommandActivity() {
  clearCommandCompletionTimer();
  commandActivity = null;
  statusCard.removeAttribute('aria-busy');
  statusCard.classList.remove('status-running');
}

function applyCommandState(message, { announceCompletion = true } = {}) {
  const state = message?.state || (message?.running ? message : null);
  if (state?.running) {
    commandActivity = state;
    renderCommandActivity();
    return;
  }

  const previous = commandActivity;
  commandActivity = null;
  clearCommandCompletionTimer();
  if (!previous?.running || !announceCompletion) {
    renderConnectionStatus();
    return;
  }

  const exitCode = Number.isInteger(message?.exitCode) ? message.exitCode : null;
  const elapsedMs = previous.startedAt ? Date.now() - new Date(previous.startedAt).getTime() : null;
  const durationMs = Number.isFinite(message?.durationMs) ? message.durationMs : elapsedMs;
  const durationDetail = Number.isFinite(durationMs) && durationMs >= 1000
    ? Math.max(1, Math.round(durationMs / 1000)) + 's • '
    : '';
  const exitDetail = exitCode === null ? '' : 'exit ' + exitCode + ' • ';
  setStatus(exitCode === null || exitCode === 0 ? 'ok' : 'bad', 'command finished', durationDetail + exitDetail + 'ready for the next command');
  commandCompletionTimer = window.setTimeout(() => {
    commandCompletionTimer = null;
    if (!commandActivity?.running) renderConnectionStatus();
  }, 1800);
}

function compactText(text = '', maxChars = SESSION_PREVIEW_CHARS) {
  const normalized = String(text)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length > maxChars ? normalized.slice(0, maxChars - 1) + '…' : normalized;
}

function safeHistoricalPreview(text = '') {
  return String(text || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '')
    .replace(/\r\n?/gu, '\n');
}

function formatRelative(iso) {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  const deltaSeconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(deltaSeconds)) return 'unknown';
  if (deltaSeconds < 60) return Math.max(deltaSeconds, 0) + 's ago';
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function activeSession() {
  return sessions.find((session) => session.id === currentSessionId) || null;
}

function selectedSessionAcceptsInput(sessionId = currentSessionId) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  return Boolean(
    session?.alive
    && !session.privacyQuarantined
    && terminalControlRole !== 'history'
    && terminalControlRole !== 'quarantine',
  );
}

function updateHeader() {
  const session = activeSession();
  if (!session) {
    sessionTitle.textContent = 'No terminal selected';
    sessionMeta.textContent = 'Create a new terminal or choose a session from the sidebar.';
    return;
  }
  const state = session.alive ? 'Live tmux session' : 'Stopped history';
  const privacy = session.privacyQuarantined
    ? ' • privacy quarantine'
    : session.private
      ? ' • legacy private'
      : '';
  sessionTitle.textContent = session.title;
  sessionMeta.textContent = state
    + ' • ' + (session.cwd || '~')
    + privacy
    + ' • ' + formatRelative(session.lastOpenedAt || session.createdAt);
}

function updateSessionHistoryActions() {
  if (!clearStoppedSessionsButton) return;
  const stoppedCount = sessions.filter((session) => !session.alive).length;
  clearStoppedSessionsButton.disabled = stoppedCount === 0;
  clearStoppedSessionsButton.textContent = stoppedCount ? 'Clear (' + stoppedCount + ')' : 'Clear';
  clearStoppedSessionsButton.title = stoppedCount
    ? 'Clear stopped session history; live tmux sessions are kept'
    : 'No stopped sessions to clear';
}

function captureSessionListUiState() {
  const active = document.activeElement;
  const focusedEntry = active && sessionList.contains(active) ? active.closest?.('.session-entry') : null;
  return {
    scrollTop: sessionList.scrollTop,
    focusedSessionId: focusedEntry?.dataset?.sessionId || '',
    focusedAction: active?.dataset?.sessionAction || 'select',
  };
}

function restoreSessionListUiState(state) {
  if (!state) return;
  sessionList.scrollTop = state.scrollTop;
  if (!state.focusedSessionId) return;
  const entry = [...sessionList.querySelectorAll('.session-entry')]
    .find((candidate) => candidate.dataset.sessionId === state.focusedSessionId);
  const control = entry?.querySelector(`[data-session-action="${state.focusedAction}"]`)
    || entry?.querySelector('[data-session-action="select"]');
  if (!control || control.disabled) return;
  try {
    control.focus({ preventScroll: true });
  } catch {
    control.focus();
  }
  sessionList.scrollTop = state.scrollTop;
}

function renderSessions() {
  const uiState = captureSessionListUiState();
  sessionList.replaceChildren();
  updateSessionHistoryActions();

  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No terminal history yet.';
    sessionList.appendChild(empty);
    updateHeader();
    restoreSessionListUiState(uiState);
    return;
  }

  for (const session of sessions) {
    const entry = document.createElement('div');
    entry.className = 'session-entry';
    entry.dataset.sessionId = session.id;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-card'
      + (session.id === currentSessionId ? ' active' : '')
      + (session.alive ? '' : ' dead');
    button.dataset.sessionId = session.id;
    button.dataset.sessionAction = 'select';
    if (session.id === currentSessionId) button.setAttribute('aria-current', 'true');

    const title = document.createElement('div');
    title.className = 'session-card-title';
    const titleText = document.createElement('span');
    titleText.textContent = session.title;
    const pill = document.createElement('span');
    pill.className = 'session-pill';
    pill.textContent = session.privacyQuarantined
      ? 'quarantined'
      : session.private
        ? (session.alive ? 'private' : 'private stopped')
        : session.alive
          ? (session.attached ? session.attached + ' attached' : 'live')
          : 'stopped';
    title.append(titleText, pill);

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    const whenSpan = document.createElement('span');
    whenSpan.textContent = formatRelative(session.lastOpenedAt || session.createdAt);
    const cwdSpan = document.createElement('span');
    cwdSpan.textContent = session.cwd || '~';
    meta.append(whenSpan, cwdSpan);

    const preview = document.createElement('div');
    preview.className = 'session-preview';
    preview.textContent = compactText(
      session.preview
      || (session.privacyQuarantined
        ? 'Attach blocked to protect private history.'
        : session.private
          ? 'Private output is not retained.'
          : session.alive
            ? 'Fresh terminal.'
            : 'No saved preview.'),
    );

    button.append(title, meta, preview);
    button.addEventListener('click', () => {
      if (session.privacyQuarantined) selectQuarantinedSession(session.id);
      else if (session.alive) connectToSession(session.id);
      else selectStoppedSession(session.id);
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'session-close';
    closeButton.dataset.sessionAction = 'close';
    closeButton.disabled = closingSessionIds.has(session.id);
    closeButton.setAttribute('aria-label', 'Close and remove ' + session.title);
    closeButton.title = session.alive
      ? 'Close terminal and remove it from the list'
      : 'Remove stopped terminal from the list';
    closeButton.textContent = '×';
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closeAndRemoveSession(session.id).catch(() => {});
    });

    entry.append(button, closeButton);
    sessionList.appendChild(entry);
  }

  updateHeader();
  restoreSessionListUiState(uiState);
}

function currentDims() {
  try {
    fitAddon?.fit();
  } catch {}
  return { cols: term.cols || 120, rows: term.rows || 36 };
}

function sendResizeIfChanged(cols = term.cols || 120, rows = term.rows || 36) {
  if (terminalControlRole !== 'controller' || ws?.readyState !== WebSocket.OPEN) return;
  const key = cols + 'x' + rows;
  if (key === lastSentTerminalSize) return;
  lastSentTerminalSize = key;
  try {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  } catch {}
}

function refitTerminal() {
  if (terminalFitRaf) return;
  terminalFitRaf = requestAnimationFrame(() => {
    terminalFitRaf = null;
    try {
      fitAddon?.fit();
    } catch {}
    sendResizeIfChanged();
  });
}

function focusTerminal() {
  if (focusTimer) return;
  focusTimer = window.setTimeout(() => {
    focusTimer = null;
    const helper = terminalHelperTextarea();
    try {
      if (helper?.focus) helper.focus({ preventScroll: true });
      else term.focus();
    } catch {
      term.focus();
    }
  }, 0);
}

function resetTerminalSurface() {
  const generation = ++terminalSurfaceGeneration;
  terminalSurfaceTransitioning = true;
  controllerFocusReported = false;
  term.reset();
  term.write('', () => {
    if (generation !== terminalSurfaceGeneration) return;
    term.reset();
    terminalSurfaceTransitioning = false;
    refitTerminal();
    resyncControllerFocus();
  });
}

function writeTerminalOutput(data) {
  const generation = terminalSurfaceGeneration;
  term.write(data, () => {
    if (generation !== terminalSurfaceGeneration) term.reset();
    if (generation !== terminalSurfaceGeneration) return;
    if (!term.modes?.sendFocusMode) controllerFocusReported = false;
    resyncControllerFocus();
  });
}

function terminalInputIsFocused() {
  return document.activeElement === terminalHelperTextarea();
}

function resyncControllerFocus() {
  if (
    terminalSurfaceTransitioning
    || terminalControlRole !== 'controller'
    || controllerFocusReported
    || !term.modes?.sendFocusMode
    || !terminalInputIsFocused()
  ) return false;
  return handleTerminalInput('\x1b[I');
}

function queueSessionsRefresh({ selectId, createIfEmpty = false } = {}) {
  sessionsRefreshQueued = {
    selectId: selectId || sessionsRefreshQueued?.selectId,
    createIfEmpty: Boolean(createIfEmpty || sessionsRefreshQueued?.createIfEmpty),
  };
}

function runQueuedSessionsRefresh() {
  if (!sessionsRefreshQueued || sessionsRefreshPending || sessionsMutationDepth > 0) return;
  const queued = sessionsRefreshQueued;
  sessionsRefreshQueued = null;
  window.setTimeout(() => refreshSessions(queued).catch(() => {}), 0);
}

function beginSessionsMutation() {
  sessionsMutationDepth += 1;
  sessionsRequestSerial += 1;
}

function endSessionsMutation() {
  sessionsMutationDepth = Math.max(0, sessionsMutationDepth - 1);
  sessionsRequestSerial += 1;
  runQueuedSessionsRefresh();
}

function selectStoppedSession(sessionId) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session || session.alive) return;
  clearReconnectTimer();
  connectionSerial += 1;
  const previousSessionId = currentSessionId;
  disconnectCurrent({ quiet: true });
  if (previousSessionId) discardPendingTerminalInputs(previousSessionId);
  discardPendingTerminalInputs(sessionId);
  currentSessionId = sessionId;
  terminalControlRole = 'history';
  resetCommandActivity();
  terminalCard.dataset.controlRole = terminalControlRole;
  controlClaimPending = false;
  resetTerminalSurface();
  renderSessions();
  const preview = safeHistoricalPreview(session.preview || '');
  term.writeln('\x1b[2mStopped session history (read-only)\x1b[0m');
  if (preview) term.write(preview.replace(/\n/gu, '\r\n'));
  else term.writeln('\r\nNo retained terminal preview.');
  setStatus('warn', 'stopped history', session.title + ' • read-only');
}

function selectQuarantinedSession(sessionId) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.alive || !session.privacyQuarantined) return;
  clearReconnectTimer();
  connectionSerial += 1;
  const previousSessionId = currentSessionId;
  disconnectCurrent({ quiet: true });
  if (previousSessionId) discardPendingTerminalInputs(previousSessionId);
  discardPendingTerminalInputs(sessionId);
  currentSessionId = sessionId;
  terminalControlRole = 'quarantine';
  resetCommandActivity();
  terminalCard.dataset.controlRole = terminalControlRole;
  controlClaimPending = false;
  resetTerminalSurface();
  renderSessions();
  term.writeln('\x1b[31mPrivate session quarantined\x1b[0m');
  term.writeln('\r\nWarpish will not attach, capture, or send input to this legacy private pane. Manage it directly with tmux.');
  setStatus('bad', 'privacy quarantine', session.title + ' • attach blocked');
}

function enforceSelectedSessionSafety() {
  const selected = activeSession();
  if (selected?.privacyQuarantined) {
    if (terminalControlRole !== 'quarantine' || ws) selectQuarantinedSession(selected.id);
    return true;
  }
  if (selected && !selected.alive) {
    if (terminalControlRole !== 'history' || ws) selectStoppedSession(selected.id);
    return true;
  }
  return false;
}

async function refreshSessions(options = {}) {
  let { selectId, createIfEmpty = false } = options;
  if (sessionsRefreshPending || sessionsMutationDepth > 0) {
    queueSessionsRefresh({ selectId, createIfEmpty });
    return;
  }

  const requestSerial = ++sessionsRequestSerial;
  sessionsRefreshPending = true;
  try {
    const payload = await api('/api/sessions', { timeoutMs: 10000 });
    if (requestSerial !== sessionsRequestSerial || sessionsMutationDepth > 0) return;
    sessions = payload.sessions || [];
    const liveSessions = sessions.filter((session) => session.alive);

    if (createIfEmpty && liveSessions.length === 0) {
      if (newSessionCreationPending) {
        queueSessionsRefresh({ selectId, createIfEmpty: true });
        return;
      }
      setNewSessionCreationBusy(true);
      let created;
      try {
        created = await api('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({}),
          timeoutMs: 20000,
        });
      } finally {
        setNewSessionCreationBusy(false);
      }
      if (requestSerial !== sessionsRequestSerial || sessionsMutationDepth > 0) return;
      sessions = created.sessions || [created.session];
      selectId = created.session.id;
    }

    renderSessions();
    const targetId = selectId
      || (currentSessionId && sessions.some((session) => session.id === currentSessionId)
        ? currentSessionId
        : null)
      || sessions.find((session) => session.alive)?.id
      || sessions[0]?.id;
    const target = sessions.find((session) => session.id === targetId);

    if (target?.privacyQuarantined) {
      if (targetId !== currentSessionId || terminalControlRole !== 'quarantine' || ws) {
        selectQuarantinedSession(targetId);
      }
    } else if (target?.alive) {
      const socketActive = ws && (
        ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING
      );
      if (
        targetId !== currentSessionId
        || ['history', 'quarantine'].includes(terminalControlRole)
        || (!socketActive && !reconnectTimer)
      ) {
        connectToSession(targetId);
      }
    } else if (target) {
      if (targetId !== currentSessionId || terminalControlRole !== 'history' || ws) {
        selectStoppedSession(targetId);
      }
    } else {
      clearReconnectTimer();
      if (currentSessionId) {
        disconnectCurrent({ quiet: true });
        discardPendingTerminalInputs(currentSessionId);
        currentSessionId = null;
        resetTerminalSurface();
      }
      updateHeader();
    }
  } finally {
    sessionsRefreshPending = false;
    runQueuedSessionsRefresh();
  }
}

async function clearStoppedSessions() {
  const stoppedCount = sessions.filter((session) => !session.alive).length;
  if (!stoppedCount) return;
  const suffix = stoppedCount === 1 ? '' : 's';
  if (!window.confirm('Clear ' + stoppedCount + ' stopped session' + suffix + ' from history? Live tmux sessions stay running.')) {
    return;
  }
  clearStoppedSessionsButton.disabled = true;
  beginSessionsMutation();
  try {
    const payload = await api('/api/sessions?stopped=1', {
      method: 'DELETE',
      timeoutMs: 20000,
    });
    sessions = payload.sessions || [];
    if (currentSessionId && !sessions.some((session) => session.id === currentSessionId)) {
      disconnectCurrent({ quiet: true });
      discardPendingTerminalInputs(currentSessionId);
      currentSessionId = null;
      resetTerminalSurface();
    }
    renderSessions();
    const safetyStateApplied = enforceSelectedSessionSafety();
    if (!safetyStateApplied) {
      setStatus('ok', 'history cleaned', (payload.purged?.length || stoppedCount) + ' stopped removed');
    }
    const target = currentSessionId || sessions.find((session) => session.alive)?.id;
    if (target && target !== currentSessionId) connectToSession(target);
  } catch (error) {
    setStatus('bad', 'clear failed', error.message);
  } finally {
    endSessionsMutation();
    updateSessionHistoryActions();
  }
}

async function closeAndRemoveSession(sessionId) {
  if (closingSessionIds.has(sessionId)) return false;
  const sessionIndex = sessions.findIndex((candidate) => candidate.id === sessionId);
  const session = sessions[sessionIndex];
  if (!session) return false;

  if (session.alive && !window.confirm(
    'Close "' + session.title + '"? Any process running in this terminal will be terminated and its history will be removed.',
  )) {
    return false;
  }

  const closingCurrentSession = currentSessionId === sessionId;
  closingSessionIds.add(sessionId);
  beginSessionsMutation();

  if (closingCurrentSession) {
    clearReconnectTimer();
    setStatus('warn', 'closing terminal…', session.title);
  }

  try {
    const payload = await api('/api/sessions/' + encodeURIComponent(sessionId) + '?purge=1', {
      method: 'DELETE',
      timeoutMs: 20000,
    });
    sessions = payload.sessions || [];

    if (closingCurrentSession) {
      connectionSerial += 1;
      disconnectCurrent({ quiet: true });
      discardPendingTerminalInputs(sessionId);
      currentSessionId = null;
      terminalControlRole = 'pending';
      terminalCard.dataset.controlRole = terminalControlRole;
      controlClaimPending = false;
      resetCommandActivity();
      resetTerminalSurface();
    }
    renderSessions();

    if (closingCurrentSession) {
      const nextSession = sessions[Math.min(sessionIndex, sessions.length - 1)] || null;
      if (nextSession?.privacyQuarantined) selectQuarantinedSession(nextSession.id);
      else if (nextSession?.alive) connectToSession(nextSession.id);
      else if (nextSession) selectStoppedSession(nextSession.id);
      else setStatus('ok', 'terminal closed', session.title + ' removed');
    } else {
      setStatus('ok', 'terminal closed', session.title + ' removed');
    }
    return true;
  } catch (error) {
    if (error.status === 401) {
      setStatus(
        'bad',
        'sign-in expired',
        'Terminal was not removed. Run ./start.sh to reopen Warpish securely, then try again.',
      );
    } else {
      if (closingCurrentSession) queueSessionsRefresh({ selectId: sessionId });
      setStatus('bad', 'close failed', 'Terminal was not removed. ' + error.message);
    }
    return false;
  } finally {
    closingSessionIds.delete(sessionId);
    endSessionsMutation();
    updateSessionHistoryActions();
  }
}

function socketUrl(sessionId) {
  const { cols, rows } = currentDims();
  const url = new URL('/ws', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));
  return url;
}

function disconnectCurrent({ quiet = false } = {}) {
  if (terminalInputFlushTimer) window.clearTimeout(terminalInputFlushTimer);
  terminalInputFlushTimer = null;
  const socket = ws;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    releaseUnacknowledgedInputs(socket, currentSessionId);
    if (quiet) intentionallyClosedSockets.add(socket);
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'detach' }));
      } catch {}
    }
    try {
      socket.close();
    } catch {}
  }
  if (ws === socket) {
    ws = null;
    terminalRuntimeEpoch = null;
  }
}

function clearReconnectTimer({ resetAttempts = true } = {}) {
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (resetAttempts) reconnectAttempts = 0;
}

function scheduleReconnect(sessionId) {
  if (!sessionId || sessionId !== currentSessionId || reconnectTimer) return;
  const delay = Math.min(8000, 500 * (2 ** Math.min(reconnectAttempts, 4)));
  reconnectAttempts += 1;
  setStatus('warn', 'reconnecting…', 'retrying in ' + Math.max(1, Math.ceil(delay / 1000)) + 's');
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (sessionId !== currentSessionId) return;
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (session?.alive) connectToSession(sessionId, { reconnecting: true });
    else refreshSessions({ selectId: sessionId }).catch(() => scheduleReconnect(sessionId));
  }, delay);
}

function terminalInputByteLength(item) {
  if (terminalInputApi?.byteLength) return terminalInputApi.byteLength(item.kind, item.data);
  return item.kind === 'binary'
    ? String(item.data || '').length
    : new TextEncoder().encode(String(item.data || '')).byteLength;
}

function splitTerminalInput(item) {
  return terminalInputApi?.splitInput?.(item, MAX_TERMINAL_INPUT_MESSAGE_BYTES) || [item];
}

function pendingInputBytes(sessionId) {
  return pendingTerminalInputs
    .filter((item) => item.sessionId === sessionId)
    .reduce((total, item) => total + terminalInputByteLength(item), 0);
}

function discardPendingTerminalInputs(sessionId) {
  const discarded = pendingInputBytes(sessionId);
  pendingTerminalInputs = pendingTerminalInputs.filter((item) => item.sessionId !== sessionId);
  return discarded;
}

function queueTerminalInput({ kind = 'text', data, directTmux, sessionId }) {
  const chunks = splitTerminalInput({
    kind,
    data: String(data || ''),
    directTmux,
    sessionId,
  });
  if (!chunks.length) return true;
  const incomingBytes = chunks.reduce(
    (total, item) => total + terminalInputByteLength(item),
    0,
  );
  if (pendingInputBytes(sessionId) + incomingBytes > MAX_PENDING_TERMINAL_INPUT_BYTES) {
    setStatus('bad', 'input queue full', 'wait for the terminal to connect before sending more input');
    return false;
  }

  for (const chunk of chunks) {
    const item = {
      ...chunk,
      directTmux: Boolean(chunk.directTmux),
      sessionId,
      inputId: terminalInputClientId + ':' + (++terminalInputSequence),
      sentSocket: null,
      sentRuntimeEpoch: null,
    };
    const last = pendingTerminalInputs.at(-1);
    const canMerge = last
      && last.sessionId === sessionId
      && last.kind === item.kind
      && last.directTmux === item.directTmux
      && !last.sentSocket
      && !last.sentRuntimeEpoch
      && terminalInputByteLength({ ...last, data: last.data + item.data })
        <= MAX_TERMINAL_INPUT_MESSAGE_BYTES;
    if (canMerge) last.data += item.data;
    else pendingTerminalInputs.push(item);
  }
  return true;
}

function sendTerminalInputOverSocket(socket, item) {
  if (
    !socket
    || socket.readyState !== WebSocket.OPEN
    || terminalControlRole !== 'controller'
    || !terminalRuntimeEpoch
    || (item.sentRuntimeEpoch && item.sentRuntimeEpoch !== terminalRuntimeEpoch)
  ) {
    return false;
  }
  const previousRuntimeEpoch = item.sentRuntimeEpoch;
  item.sentRuntimeEpoch ||= terminalRuntimeEpoch;
  try {
    if (item.kind === 'binary') {
      socket.send(JSON.stringify({
        type: 'input-binary',
        data: window.btoa(String(item.data || '')),
        inputId: item.inputId,
      }));
    } else {
      socket.send(JSON.stringify({
        type: 'input',
        data: item.data,
        directTmux: item.directTmux,
        allowFocusReports: true,
        inputId: item.inputId,
      }));
    }
    return true;
  } catch {
    item.sentRuntimeEpoch = previousRuntimeEpoch;
    return false;
  }
}

function schedulePendingTerminalInputFlush(socket, sessionId) {
  if (terminalInputFlushTimer || !socket || socket.readyState !== WebSocket.OPEN) return;
  terminalInputFlushTimer = window.setTimeout(() => {
    terminalInputFlushTimer = null;
    if (socket === ws && sessionId === currentSessionId) {
      flushPendingTerminalInputs(socket, sessionId);
    }
  }, 25);
}

function flushPendingTerminalInputs(socket, sessionId) {
  if (terminalControlRole !== 'controller') return;
  let socketBackpressured = false;
  for (const item of pendingTerminalInputs) {
    if (item.sessionId !== sessionId || item.sentSocket === socket) continue;
    if (
      socketBackpressured
      || sessionId !== currentSessionId
      || ws !== socket
      || socket?.bufferedAmount > MAX_BROWSER_SOCKET_BUFFERED_BYTES
      || !sendTerminalInputOverSocket(socket, item)
    ) {
      socketBackpressured = true;
    } else {
      item.sentSocket = socket;
    }
  }
  if (pendingTerminalInputs.some((item) => item.sessionId === sessionId && !item.sentSocket)) {
    schedulePendingTerminalInputFlush(socket, sessionId);
  }
}

function releaseUnacknowledgedInputs(socket, sessionId) {
  for (const item of pendingTerminalInputs) {
    if (item.sessionId === sessionId && item.sentSocket === socket) item.sentSocket = null;
  }
}

function acknowledgeTerminalInput(socket, sessionId, inputId) {
  const index = pendingTerminalInputs.findIndex((item) => (
    item.sessionId === sessionId
    && item.inputId === inputId
    && item.sentSocket === socket
  ));
  if (index < 0) return;
  pendingTerminalInputs.splice(index, 1);
  flushPendingTerminalInputs(socket, sessionId);
}

function reconcilePendingInputsForRuntime(sessionId, runtimeEpoch) {
  const nextRuntimeEpoch = typeof runtimeEpoch === 'string' && runtimeEpoch.length <= 160
    ? runtimeEpoch
    : null;
  let uncertainBytes = 0;
  pendingTerminalInputs = pendingTerminalInputs.filter((item) => {
    if (item.sessionId !== sessionId) return true;
    if (item.sentRuntimeEpoch && item.sentRuntimeEpoch !== nextRuntimeEpoch) {
      uncertainBytes += terminalInputByteLength(item);
      return false;
    }
    item.sentSocket = null;
    return true;
  });
  terminalRuntimeEpoch = nextRuntimeEpoch;
  return uncertainBytes;
}

function claimTerminalControl() {
  if (terminalControlRole === 'controller') {
    flushPendingTerminalInputs(ws, currentSessionId);
    return;
  }
  if (controlClaimPending || ws?.readyState !== WebSocket.OPEN || !currentSessionId) return;
  const { cols, rows } = currentDims();
  controlClaimPending = true;
  try {
    ws.send(JSON.stringify({ type: 'take-control', cols, rows }));
    setStatus('warn', 'taking control…', 'waiting for this tab to become controller');
  } catch {
    controlClaimPending = false;
  }
}

function applyTerminalControlRole(role, title = activeSession()?.title || 'terminal') {
  const previousRole = terminalControlRole;
  terminalControlRole = role === 'controller' ? 'controller' : 'spectator';
  controlClaimPending = false;
  terminalCard.dataset.controlRole = terminalControlRole;
  if (terminalControlRole === 'controller') {
    if (previousRole !== 'controller') controllerFocusReported = false;
    lastSentTerminalSize = '';
    sendResizeIfChanged();
    flushPendingTerminalInputs(ws, currentSessionId);
    resyncControllerFocus();
    renderConnectionStatus(title);
  } else {
    controllerFocusReported = false;
    releaseUnacknowledgedInputs(ws, currentSessionId);
    renderConnectionStatus(title);
    if (pendingInputBytes(currentSessionId) > 0) claimTerminalControl();
  }
}

function connectToSession(sessionId, { reconnecting = false } = {}) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.alive) return;
  if (session.privacyQuarantined) {
    selectQuarantinedSession(sessionId);
    return;
  }

  clearReconnectTimer({ resetAttempts: !reconnecting });
  const serial = ++connectionSerial;
  pendingTerminalInputs = pendingTerminalInputs.filter((item) => item.sessionId === sessionId);
  disconnectCurrent({ quiet: true });
  currentSessionId = sessionId;
  resetCommandActivity();
  terminalRuntimeEpoch = null;
  controllerFocusReported = false;
  terminalControlRole = 'pending';
  terminalCard.dataset.controlRole = terminalControlRole;
  controlClaimPending = false;
  lastSentTerminalSize = '';
  resetTerminalSurface();
  renderSessions();
  focusTerminal();
  setStatus('warn', 'attaching…', session.title);

  const socket = new WebSocket(socketUrl(sessionId));
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.addEventListener('open', () => {
    if (serial !== connectionSerial || ws !== socket) return;
    reconnectAttempts = 0;
    setStatus('warn', 'connected', session.title + ' • negotiating control');
    focusTerminal();
  });

  socket.addEventListener('message', (event) => {
    if (serial !== connectionSerial || ws !== socket) return;
    if (event.data instanceof ArrayBuffer) {
      writeTerminalOutput(new Uint8Array(event.data));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      writeTerminalOutput(event.data);
      return;
    }

    if (msg.type === 'hello') {
      const uncertainInputBytes = reconcilePendingInputsForRuntime(sessionId, msg.runtimeEpoch);
      if (terminalControlRole === 'pending') {
        setStatus('warn', 'connected', 'tmux ' + msg.sessionId + ' • negotiating control');
      } else {
        applyTerminalControlRole(terminalControlRole, session.title);
      }
      if (uncertainInputBytes > 0) {
        setStatus(
          'bad',
          'input not retried',
          uncertainInputBytes + ' unacknowledged bytes were not replayed after terminal runtime restart',
        );
      } else {
        applyCommandState({ running: Boolean(msg.commandState?.running), state: msg.commandState }, {
          announceCompletion: false,
        });
      }
    } else if (msg.type === 'role') {
      applyTerminalControlRole(msg.role, session.title);
    } else if (msg.type === 'input-ack' && msg.sessionId === sessionId) {
      acknowledgeTerminalInput(socket, sessionId, msg.inputId);
    } else if (msg.type === 'command-state' && msg.sessionId === sessionId) {
      applyCommandState(msg);
    } else if (msg.type === 'server-error') {
      if (msg.code === 'pty-input-backpressure') {
        releaseUnacknowledgedInputs(socket, sessionId);
        schedulePendingTerminalInputFlush(socket, sessionId);
      }
      setStatus('bad', 'error', msg.message || 'server error');
      term.writeln('\r\n\x1b[31m' + (msg.message || 'server error') + '\x1b[0m');
    } else if (msg.type === 'detached') {
      if (!intentionallyClosedSockets.has(socket)) {
        setStatus('bad', 'detached', 'session remains available in the sidebar');
      }
    } else if (msg.type === 'session-meta' && msg.sessionId === sessionId) {
      const liveSession = sessions.find((candidate) => candidate.id === sessionId);
      if (liveSession && typeof msg.cwd === 'string') liveSession.cwd = msg.cwd;
      renderSessions();
    }
  });

  socket.addEventListener('close', () => {
    const intentionalClose = intentionallyClosedSockets.has(socket);
    const closingSession = closingSessionIds.has(sessionId);
    intentionallyClosedSockets.delete(socket);
    if (serial !== connectionSerial) return;
    releaseUnacknowledgedInputs(socket, sessionId);
    if (ws === socket) ws = null;
    terminalRuntimeEpoch = null;
    if (closingSession) return;
    if (intentionalClose) setStatus('warn', 'detached', 'tmux session kept alive');
    else scheduleReconnect(sessionId);
    window.setTimeout(() => refreshSessions().catch(() => {}), 300);
  });

  socket.addEventListener('error', () => {
    if (serial !== connectionSerial || ws !== socket) return;
    setStatus('bad', 'connection error', 'server, token, or session problem');
  });
}

function sendRaw(data, { directTmux = false, sessionId = currentSessionId } = {}) {
  if (!sessionId) {
    term.writeln('\r\n\x1b[31mNo session selected.\x1b[0m');
    return false;
  }
  if (sessionId !== currentSessionId || terminalSurfaceTransitioning) return false;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!selectedSessionAcceptsInput(sessionId)) {
    setStatus(
      'warn',
      'read only',
      session?.privacyQuarantined
        ? 'this legacy private session is quarantined'
        : 'stopped history does not accept terminal input',
    );
    return false;
  }
  const item = {
    kind: 'text',
    data: String(data || ''),
    directTmux: Boolean(directTmux),
    sessionId,
  };
  if (!item.data || !queueTerminalInput(item)) return false;
  if (ws?.readyState === WebSocket.OPEN) {
    if (terminalControlRole === 'controller') flushPendingTerminalInputs(ws, sessionId);
    else claimTerminalControl();
    return true;
  }
  if (ws?.readyState === WebSocket.CONNECTING) {
    setStatus('warn', 'attaching…', pendingInputBytes(sessionId) + ' input bytes queued');
    return true;
  }
  connectToSession(sessionId);
  return true;
}

function sendBinary(data, { sessionId = currentSessionId } = {}) {
  if (!sessionId || sessionId !== currentSessionId || terminalSurfaceTransitioning) return false;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!selectedSessionAcceptsInput(sessionId)) {
    setStatus(
      'warn',
      'read only',
      session?.privacyQuarantined
        ? 'this legacy private session is quarantined'
        : 'stopped history does not accept terminal input',
    );
    return false;
  }
  const item = {
    kind: 'binary',
    data: String(data || ''),
    directTmux: false,
    sessionId,
  };
  if (!item.data || !queueTerminalInput(item)) return false;
  if (ws?.readyState === WebSocket.OPEN) {
    if (terminalControlRole === 'controller') flushPendingTerminalInputs(ws, sessionId);
    else claimTerminalControl();
    return true;
  }
  if (ws?.readyState === WebSocket.CONNECTING) {
    setStatus('warn', 'attaching…', pendingInputBytes(sessionId) + ' input bytes queued');
    return true;
  }
  connectToSession(sessionId);
  return true;
}

function handleTerminalInput(data) {
  const input = String(data || '');
  if (!input) return false;
  const focusReport = /^\x1b\[(?:I|O)$/u.test(input);
  const terminalProtocolReply = /^(?:(?:\x1b\[(?:\?|>)[0-9;]*c)|(?:\x1b\[[0-9;?]*[nR])|(?:\x1b\[[0-9;]*t)|(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)))+$/u.test(input);
  if (input === '\x1b[O') controllerFocusReported = false;
  if (terminalSurfaceTransitioning) return false;
  if (terminalControlRole !== 'controller' && (focusReport || terminalProtocolReply)) {
    if (focusReport) controllerFocusReported = false;
    return false;
  }
  const queued = sendRaw(input, { sessionId: currentSessionId });
  if (queued && input === '\x1b[I') controllerFocusReported = true;
  return queued;
}

function isTerminalKeyTarget(event) {
  const target = event?.target;
  if (!target || !terminalCard?.contains(target)) return false;
  if (target.classList?.contains('xterm-helper-textarea')) return true;
  return !target.closest?.('button, input, textarea, select, a, [contenteditable="true"]');
}

function prepareTerminalPasteText(rawText, options = {}) {
  return window.WarpishPasteSafety.prepareTerminalPasteText(rawText, options);
}

function insertPreparedPaste(prepared) {
  focusTerminal();
  if (prepared.text) term.paste(prepared.text);
  const lineDetail = prepared.internalLineBreaks
    ? (prepared.internalLineBreaks + 1) + ' lines • '
      + (prepared.multilineMode === 'preserve' ? 'line breaks preserved' : 'joined safely')
    : 'text inserted safely';
  setStatus(
    prepared.multilineMode === 'preserve' && prepared.internalLineBreaks ? 'warn' : 'ok',
    prepared.multilineMode === 'preserve' ? 'multiline paste inserted' : 'pasted — press Enter to run',
    lineDetail,
  );
}

function handleTerminalPaste(event) {
  if (!isTerminalKeyTarget(event)) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (!selectedSessionAcceptsInput()) {
    setStatus(
      'warn',
      'read only',
      activeSession()?.privacyQuarantined
        ? 'this legacy private session is quarantined'
        : 'stopped history does not accept terminal input',
    );
    return;
  }
  const prepared = prepareTerminalPasteText(text, {
    bracketedPasteMode: Boolean(term.modes?.bracketedPasteMode),
  });
  if (prepared.requiresChoice && pasteDialog?.showModal) {
    pendingMultilinePaste = {
      text,
      bracketedPasteMode: false,
      sessionId: currentSessionId,
    };
    pastePreview.textContent = window.WarpishPasteSafety.formatMultilinePastePreview(text, 2400);
    pasteDialog.returnValue = 'cancel';
    pasteDialog.showModal();
    return;
  }
  insertPreparedPaste(prepared);
}

function setNewSessionCreationBusy(busy) {
  newSessionCreationPending = Boolean(busy);
  newSessionButton.disabled = newSessionCreationPending;
  newSessionButton.textContent = newSessionCreationPending ? 'Creating…' : '+ New terminal';
  if (newSessionCreationPending) newSessionButton.setAttribute('aria-busy', 'true');
  else newSessionButton.removeAttribute('aria-busy');
}

async function createNewSession() {
  if (newSessionCreationPending) return null;
  const selectedAtRequestStart = currentSessionId;
  setNewSessionCreationBusy(true);
  beginSessionsMutation();
  try {
    setStatus('warn', 'creating terminal…', 'Home directory');
    const created = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 20000,
    });
    sessions = created.sessions || [created.session];
    renderSessions();
    if (!currentSessionId || currentSessionId === selectedAtRequestStart) {
      connectToSession(created.session.id);
    } else {
      enforceSelectedSessionSafety();
    }
    return created.session;
  } catch (error) {
    setStatus('bad', 'create failed', error.message);
    return null;
  } finally {
    endSessionsMutation();
    setNewSessionCreationBusy(false);
  }
}

term.onData((data) => handleTerminalInput(data));
term.onBinary((data) => sendBinary(data, { sessionId: currentSessionId }));
term.onResize(({ cols, rows }) => sendResizeIfChanged(cols, rows));

function syncVisualViewportHeight() {
  const viewport = window.visualViewport;
  const viewportHeight = Math.max(1, Math.round(viewport?.height || window.innerHeight));
  const viewportWidth = Math.max(1, Math.round(viewport?.width || window.innerWidth));
  const viewportTop = Math.round(viewport?.offsetTop || 0);
  const viewportLeft = Math.round(viewport?.offsetLeft || 0);
  document.documentElement.style.setProperty('--app-viewport-height', viewportHeight + 'px');
  document.documentElement.style.setProperty('--app-viewport-width', viewportWidth + 'px');
  document.documentElement.style.setProperty('--app-viewport-top', viewportTop + 'px');
  document.documentElement.style.setProperty('--app-viewport-left', viewportLeft + 'px');
  refitTerminal();
}

syncVisualViewportHeight();
window.visualViewport?.addEventListener('resize', syncVisualViewportHeight);
window.visualViewport?.addEventListener('scroll', syncVisualViewportHeight);
window.addEventListener('resize', syncVisualViewportHeight);

const resizeObserver = new ResizeObserver(() => refitTerminal());
resizeObserver.observe(terminalEl);

terminalEl.addEventListener('pointerdown', () => {
  claimTerminalControl();
  focusTerminal();
});
terminalCard.addEventListener('click', (event) => {
  if (!event.target.closest?.('button, input, textarea, select, a')) focusTerminal();
});
terminalCard.addEventListener('paste', handleTerminalPaste, { capture: true });

pasteDialog?.addEventListener('close', () => {
  const pending = pendingMultilinePaste;
  pendingMultilinePaste = null;
  if (!pending || !['single-line', 'preserve'].includes(pasteDialog.returnValue)) {
    focusTerminal();
    return;
  }
  if (
    !pending.sessionId
    || pending.sessionId !== currentSessionId
    || !selectedSessionAcceptsInput(pending.sessionId)
  ) {
    setStatus('warn', 'paste cancelled', 'the selected terminal changed while the dialog was open');
    focusTerminal();
    return;
  }
  const prepared = prepareTerminalPasteText(pending.text, {
    bracketedPasteMode: pending.bracketedPasteMode,
    multilineMode: pasteDialog.returnValue,
  });
  insertPreparedPaste(prepared);
});

newSessionButton.addEventListener('click', () => createNewSession().catch(() => {}));
refreshSessionsButton.addEventListener('click', () => {
  refreshSessions().catch((error) => setStatus('bad', 'refresh failed', error.message));
});
clearStoppedSessionsButton?.addEventListener('click', () => clearStoppedSessions());

mobileTerminalKeys?.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const controlData = { 'ctrl-c': '\x03', 'ctrl-d': '\x04' }[button.dataset.terminalData];
  const data = controlData || window.WarpishTerminalKeys?.terminalKeyData({
    key: button.dataset.terminalKey,
    code: button.dataset.terminalKey,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
  }, term.modes);
  if (data) term.input(data, true);
  focusTerminal();
});
mobileTerminalKeys?.addEventListener('pointerdown', (event) => {
  if (event.target.closest('button')) event.preventDefault();
});

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    event.stopPropagation();
    focusTerminal();
  }
}, { capture: true });

refreshSessions({ createIfEmpty: true }).catch((error) => {
  setStatus('bad', 'startup failed', error.message);
  term.writeln('\x1b[31mStartup failed: ' + error.message + '\x1b[0m');
});

refreshAuthCookie().catch(() => {});
authRefreshTimer = window.setInterval(() => {
  refreshAuthCookie().catch((error) => {
    if (error.status === 401) {
      setStatus('bad', 'sign-in expired', 'Run ./start.sh to reopen Warpish securely.');
    }
  });
}, AUTH_COOKIE_REFRESH_INTERVAL_MS);

refreshTimer = window.setInterval(() => {
  refreshSessions().catch(() => {});
}, 5000);

window.addEventListener('beforeunload', () => {
  if (refreshTimer) window.clearInterval(refreshTimer);
  if (authRefreshTimer) window.clearInterval(authRefreshTimer);
  clearReconnectTimer();
  disconnectCurrent({ quiet: true });
  window.visualViewport?.removeEventListener('resize', syncVisualViewportHeight);
  window.visualViewport?.removeEventListener('scroll', syncVisualViewportHeight);
  window.removeEventListener('resize', syncVisualViewportHeight);
});
