const terminalEl = document.getElementById('terminal');
const statusCard = document.getElementById('statusCard');
const statusText = document.getElementById('statusText');
const sessionText = document.getElementById('sessionText');
const sessionTitle = document.getElementById('sessionTitle');
const sessionMeta = document.getElementById('sessionMeta');
const terminalTitle = document.getElementById('terminalTitle');
const sessionList = document.getElementById('sessionList');
const newSessionButton = document.getElementById('newSession');
const refreshSessionsButton = document.getElementById('refreshSessions');
const clearStoppedSessionsButton = document.getElementById('clearStoppedSessions');
const renameSessionButton = document.getElementById('renameSession');
const blocksToggleButton = document.getElementById('blocksToggle');
const copySelection = document.getElementById('copySelection');
const bidiToggleButton = document.getElementById('bidiToggle');
const bidiReader = document.getElementById('bidiReader');
const bidiReaderLines = document.getElementById('bidiReaderLines');
const detachSessionButton = document.getElementById('detachSession');
const killSessionButton = document.getElementById('killSession');
const blockList = document.getElementById('blockList');
const blockSearch = document.getElementById('blockSearch');
const blocksCount = document.getElementById('blocksCount');
const refreshBlocksButton = document.getElementById('refreshBlocks');

const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon?.FitAddon;
const WebLinksAddonCtor = window.WebLinksAddon?.WebLinksAddon;

const term = new TerminalCtor({
  cursorBlink: true,
  cursorStyle: 'bar',
  macOptionIsMeta: true,
  convertEol: false,
  fontFamily: '"SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 13.5,
  lineHeight: 1.16,
  letterSpacing: 0,
  scrollback: 50000,
  allowTransparency: true,
  theme: {
    background: '#070711',
    foreground: '#f4f1ff',
    cursor: '#22d3ee',
    selectionBackground: '#5b4a9f66',
    black: '#11111b', red: '#fb7185', green: '#34d399', yellow: '#fbbf24',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#f3f4f6',
    brightBlack: '#6b7280', brightRed: '#fda4af', brightGreen: '#86efac', brightYellow: '#fde68a',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
  },
});

const fitAddon = FitAddonCtor ? new FitAddonCtor() : null;
if (fitAddon) term.loadAddon(fitAddon);
if (WebLinksAddonCtor) term.loadAddon(new WebLinksAddonCtor());
term.open(terminalEl);

let sessions = [];
let blocks = [];
let currentSessionId = null;
let ws = null;
let connectionSerial = 0;
let intentionalDetach = false;
let refreshTimer = null;
let blockFilter = '';
let blocksOpen = localStorage.getItem('warpish_blocks_open') === 'on';
let bidiReaderEnabled = localStorage.getItem('warpish_readable_terminal_v1') !== 'off';
let bidiReaderUpdatePending = false;

const RTL_CHAR_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const STRONG_CHAR_RE = /[A-Za-z\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const LTR_TOKEN_CHAR_RE = /[A-Za-z0-9_.\/:@~#$%&+=,;!?<>{}()\[\]\\'"`|^-]/u;
const BIDI_TOKEN_RE = /(\s+|[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]+|[A-Za-z0-9_.\/:@~#$%&+=,;!?<>{}()\[\]\\'"`|^-]+|[^\s])/gu;
const BIDI_READER_MAX_LINES = 80;
const BLOCK_RENDER_LIMIT = 60;
const BLOCK_OUTPUT_PREVIEW_CHARS = 3200;
const SESSION_PREVIEW_CHARS = 900;
let blockRenderPending = false;

function compactText(text = '', maxChars = BLOCK_OUTPUT_PREVIEW_CHARS) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `… truncated ${value.length - maxChars} chars …\n${value.slice(-maxChars)}`;
}

function bidiDirection(text = '') {
  const firstStrong = String(text).match(STRONG_CHAR_RE)?.[0] || '';
  return RTL_CHAR_RE.test(firstStrong) ? 'rtl' : 'ltr';
}

function bidiTokenDirection(token = '') {
  if (RTL_CHAR_RE.test(token)) return 'rtl';
  if (LTR_TOKEN_CHAR_RE.test(token)) return 'ltr';
  return 'neutral';
}

function renderBidiRuns(element, text = '') {
  if (!element) return;
  const value = String(text || ' ');
  const sourceDir = bidiDirection(value);
  element.textContent = '';
  element.dir = 'ltr';
  element.dataset.sourceDir = sourceDir;
  element.classList.toggle('source-rtl', sourceDir === 'rtl');
  element.classList.toggle('source-ltr', sourceDir !== 'rtl');

  const tokens = value.match(BIDI_TOKEN_RE) || [value];
  for (const token of tokens) {
    const dir = bidiTokenDirection(token);
    const run = document.createElement('bdi');
    run.className = `bidi-run ${dir}`;
    run.dir = 'ltr';
    run.textContent = token;
    element.appendChild(run);
  }
}

function applyBidiText(element, text, { className = 'bidi-plain' } = {}) {
  if (!element) return;
  element.classList.add(className);
  renderBidiRuns(element, text);
}

function getReadableTerminalLines(limit = BIDI_READER_MAX_LINES) {
  const buffer = term.buffer?.active;
  if (!buffer) return [];
  const end = Math.min(buffer.length, buffer.baseY + term.rows);
  const start = Math.max(0, end - limit * 2);
  const lines = [];

  for (let i = start; i < end; i += 1) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trimEnd();
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }

  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-limit);
}

function renderBidiReader(lines = getReadableTerminalLines()) {
  if (!bidiReaderLines) return;
  bidiReaderLines.innerHTML = '';
  if (!lines.length) {
    const empty = document.createElement('div');
    empty.className = 'bidi-line empty-state';
    empty.textContent = 'Waiting for terminal output…';
    bidiReaderLines.appendChild(empty);
    return;
  }

  for (const line of lines) {
    const row = document.createElement('div');
    row.className = `bidi-line ${bidiDirection(line)}`;
    row.dataset.logicalText = line || ' ';
    renderBidiRuns(row, line || ' ');
    bidiReaderLines.appendChild(row);
  }
  bidiReaderLines.scrollTop = bidiReaderLines.scrollHeight;
}

function scheduleBidiReaderUpdate() {
  if (!bidiReaderEnabled || bidiReaderUpdatePending) return;
  bidiReaderUpdatePending = true;
  requestAnimationFrame(() => {
    bidiReaderUpdatePending = false;
    renderBidiReader();
  });
}

async function refreshBidiReaderFromCapture() {
  if (!bidiReaderEnabled || !currentSessionId) {
    renderBidiReader();
    return;
  }
  try {
    const payload = await api(`/api/sessions/${currentSessionId}/capture?lines=1200`);
    const lines = String(payload.text || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-BIDI_READER_MAX_LINES);
    renderBidiReader(lines.length ? lines : getReadableTerminalLines());
  } catch {
    renderBidiReader();
  }
}

function refitTerminal() {
  requestAnimationFrame(() => {
    try { if (fitAddon) fitAddon.fit(); } catch {}
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols || 120, rows: term.rows || 36 }));
    }
  });
}

function applyPanelMode() {
  document.body.classList.add('terminal-native-mode');
  document.body.classList.toggle('blocks-open', blocksOpen);
  if (blocksToggleButton) blocksToggleButton.textContent = blocksOpen ? 'Hide blocks' : 'Blocks';
  refitTerminal();
}

function setBlocksOpen(open) {
  blocksOpen = Boolean(open);
  localStorage.setItem('warpish_blocks_open', blocksOpen ? 'on' : 'off');
  applyPanelMode();
  if (blocksOpen) loadBlocks(currentSessionId, { force: true }).catch(() => {});
}

function applyBidiMode() {
  document.body.classList.toggle('bidi-mode', bidiReaderEnabled);
  if (bidiToggleButton) bidiToggleButton.textContent = `Readable: ${bidiReaderEnabled ? 'on' : 'off'}`;
  if (bidiReader) bidiReader.setAttribute('aria-hidden', String(!bidiReaderEnabled));
  if (bidiReaderEnabled) refreshBidiReaderFromCapture().catch(() => renderBidiReader());
  refitTerminal();
}

function focusPreferredInput() {
  term.focus();
}

function clearAutoRawInput() {
  // No-op kept for block-end messages; terminal input is always raw passthrough now.
}

function handleTerminalInput(data) {
  sendRaw(data);
}

function getCookie(name) {
  return document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

const initialParams = new URLSearchParams(window.location.search);
const initialToken = initialParams.get('token');
if (initialToken) {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function authToken() {
  return initialToken || decodeURIComponent(getCookie('warpish_token') || '');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'x-warpish-token': authToken(),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  return payload;
}

function setStatus(kind, text, detail) {
  statusCard.classList.remove('status-ok', 'status-bad');
  if (kind === 'ok') statusCard.classList.add('status-ok');
  if (kind === 'bad') statusCard.classList.add('status-bad');
  statusText.textContent = text;
  sessionText.textContent = detail || '';
}

function currentDims() {
  try { if (fitAddon) fitAddon.fit(); } catch {}
  return { cols: term.cols || 120, rows: term.rows || 36 };
}

function formatRelative(iso) {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  const deltaSeconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(deltaSeconds)) return 'unknown';
  if (deltaSeconds < 60) return `${Math.max(deltaSeconds, 0)}s ago`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function activeSession() {
  return sessions.find((session) => session.id === currentSessionId) || null;
}

function updateHeader() {
  const session = activeSession();
  if (!session) {
    sessionTitle.textContent = 'No terminal selected';
    sessionMeta.textContent = 'Create a new terminal or choose a live session from the sidebar.';
    terminalTitle.textContent = 'No session attached';
    return;
  }
  sessionTitle.textContent = session.title;
  sessionMeta.textContent = `${session.alive ? 'Live tmux session' : 'Stopped'} • ${session.cwd || '~'} • ${formatRelative(session.lastOpenedAt || session.createdAt)}`;
  terminalTitle.textContent = session.title;
  terminalTitle.title = session.id;
}

function updateSessionHistoryActions() {
  if (!clearStoppedSessionsButton) return;
  const stoppedCount = sessions.filter((session) => !session.alive).length;
  clearStoppedSessionsButton.disabled = stoppedCount === 0;
  clearStoppedSessionsButton.textContent = stoppedCount ? `Clear (${stoppedCount})` : 'Clear';
  clearStoppedSessionsButton.title = stoppedCount
    ? `Clear ${stoppedCount} stopped session${stoppedCount === 1 ? '' : 's'} from history; live tmux sessions are kept`
    : 'No stopped sessions to clear';
}

function renderSessions() {
  sessionList.innerHTML = '';
  updateSessionHistoryActions();
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No terminal history yet. Create a new terminal to start a resumable session.';
    sessionList.appendChild(empty);
    updateHeader();
    return;
  }

  for (const session of sessions) {
    const button = document.createElement('button');
    button.className = `session-card ${session.id === currentSessionId ? 'active' : ''} ${session.alive ? '' : 'dead'}`;
    button.disabled = !session.alive;
    button.dataset.sessionId = session.id;

    const title = document.createElement('div');
    title.className = 'session-card-title';
    const titleText = document.createElement('span');
    titleText.textContent = session.title;
    const pill = document.createElement('span');
    pill.className = 'session-pill';
    pill.textContent = session.alive ? (session.attached ? `${session.attached} attached` : 'live') : 'stopped';
    title.append(titleText, pill);

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.innerHTML = `<span>${formatRelative(session.lastOpenedAt || session.createdAt)}</span><span>${session.cwd || '~'}</span>`;

    const preview = document.createElement('div');
    preview.className = 'session-preview';
    const previewText = compactText(session.preview || (session.alive ? 'fresh terminal — no output yet' : 'no saved preview'), SESSION_PREVIEW_CHARS);
    applyBidiText(preview, previewText);

    button.append(title, meta, preview);
    button.addEventListener('click', () => connectToSession(session.id));
    sessionList.appendChild(button);
  }
  updateHeader();
}

function blockMatchesFilter(block) {
  if (!blockFilter) return true;
  const haystack = `${block.command || ''}\n${compactText(block.output || '', 6000)}\n${block.status || ''}`.toLowerCase();
  return haystack.includes(blockFilter.toLowerCase());
}

function scheduleRenderBlocks() {
  if (blockRenderPending) return;
  blockRenderPending = true;
  requestAnimationFrame(() => {
    blockRenderPending = false;
    renderBlocks();
  });
}

function upsertBlock(block) {
  if (!block?.id) return;
  const existing = blocks.findIndex((candidate) => candidate.id === block.id);
  if (existing >= 0) blocks[existing] = { ...blocks[existing], ...block };
  else blocks.unshift(block);
  blocks.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  scheduleRenderBlocks();
}

function renderBlocks() {
  const filtered = blocks.filter(blockMatchesFilter);
  blocksCount.textContent = `${filtered.length}${filtered.length === blocks.length ? '' : ` / ${blocks.length}`} block${blocks.length === 1 ? '' : 's'}`;
  if (!blocksOpen) {
    blockList.replaceChildren();
    return;
  }

  blockList.innerHTML = '';

  if (!currentSessionId) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select a session to see command blocks.';
    blockList.appendChild(empty);
    return;
  }

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = blocks.length
      ? 'No blocks match this search.'
      : 'No command blocks yet. New sessions record commands with shell integration; run a command to create the first block.';
    blockList.appendChild(empty);
    return;
  }

  const visibleBlocks = filtered.slice(0, BLOCK_RENDER_LIMIT);
  for (const block of visibleBlocks) {
    const card = document.createElement('article');
    card.className = `block-card ${block.status || 'unknown'}`;

    const command = document.createElement('div');
    command.className = 'block-command';
    applyBidiText(command, `$ ${block.command || '(unknown command)'}`);

    const meta = document.createElement('div');
    meta.className = 'block-meta';
    const status = document.createElement('span');
    status.className = `block-status ${block.status || 'unknown'}`;
    status.textContent = block.status || 'unknown';
    const when = document.createElement('span');
    when.textContent = formatRelative(block.startedAt);
    const duration = document.createElement('span');
    duration.textContent = block.status === 'running' ? 'running…' : formatDuration(block.durationMs);
    const exit = document.createElement('span');
    exit.textContent = block.exitCode === null || block.exitCode === undefined ? '' : `exit ${block.exitCode}`;
    meta.append(status, when, duration);
    if (exit.textContent) meta.append(exit);

    const output = document.createElement('pre');
    output.className = 'block-output';
    const outputText = compactText((block.output || '').trim() || (block.status === 'running' ? 'Waiting for output…' : 'No output.'));
    applyBidiText(output, outputText);

    const actions = document.createElement('div');
    actions.className = 'block-actions';
    const rerun = document.createElement('button');
    rerun.textContent = 'Rerun';
    rerun.disabled = !block.command || !activeSession()?.alive;
    rerun.addEventListener('click', () => {
      sendRaw(`${block.command}\r`);
      focusPreferredInput();
    });
    const copyCommand = document.createElement('button');
    copyCommand.textContent = 'Copy cmd';
    copyCommand.addEventListener('click', () => navigator.clipboard.writeText(block.command || ''));
    const copyOutput = document.createElement('button');
    copyOutput.textContent = 'Copy output';
    copyOutput.addEventListener('click', () => navigator.clipboard.writeText(block.output || ''));
    actions.append(rerun, copyCommand, copyOutput);

    card.append(command, meta, output, actions);
    blockList.appendChild(card);
  }

  if (filtered.length > visibleBlocks.length) {
    const more = document.createElement('div');
    more.className = 'empty-state';
    more.textContent = `Showing latest ${visibleBlocks.length} of ${filtered.length} matching blocks. Narrow search to inspect older blocks.`;
    blockList.appendChild(more);
  }
}

async function loadBlocks(sessionId = currentSessionId, { force = false } = {}) {
  if (!sessionId) {
    blocks = [];
    renderBlocks();
    return;
  }
  if (!blocksOpen && !force) {
    renderBlocks();
    return;
  }
  const payload = await api(`/api/sessions/${sessionId}/blocks`);
  blocks = payload.blocks || [];
  renderBlocks();
}

async function refreshSessions({ selectId, createIfEmpty = false } = {}) {
  const payload = await api('/api/sessions');
  sessions = payload.sessions || [];
  const liveSessions = sessions.filter((session) => session.alive);

  if (createIfEmpty && liveSessions.length === 0) {
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
    sessions = created.sessions || [created.session];
    selectId = created.session.id;
  }

  renderSessions();

  const targetId = selectId
    || (currentSessionId && sessions.some((session) => session.id === currentSessionId && session.alive) ? currentSessionId : null)
    || sessions.find((session) => session.alive)?.id;

  if (targetId && targetId !== currentSessionId) connectToSession(targetId);
  else if (targetId && blocksOpen) loadBlocks(targetId, { force: true }).catch(() => {});
  if (!targetId) updateHeader();
}

async function clearStoppedSessions() {
  const stoppedCount = sessions.filter((session) => !session.alive).length;
  if (!stoppedCount) return;
  if (!window.confirm(`Clear ${stoppedCount} stopped session${stoppedCount === 1 ? '' : 's'} from history? Live tmux sessions stay running.`)) return;
  clearStoppedSessionsButton.disabled = true;
  try {
    const payload = await api('/api/sessions?stopped=1', { method: 'DELETE' });
    sessions = payload.sessions || [];
    if (currentSessionId && !sessions.some((session) => session.id === currentSessionId && session.alive)) currentSessionId = null;
    renderSessions();
    setStatus('ok', 'history cleaned', `${payload.purged?.length || stoppedCount} stopped removed`);
    const target = currentSessionId || sessions.find((session) => session.alive)?.id;
    if (target && target !== currentSessionId) connectToSession(target);
  } catch (error) {
    setStatus('bad', 'clear failed', error.message);
  } finally {
    updateSessionHistoryActions();
  }
}

function socketUrl(sessionId) {
  const { cols, rows } = currentDims();
  const url = new URL('/ws', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', authToken());
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));
  return url;
}

function disconnectCurrent({ quiet = false } = {}) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    intentionalDetach = quiet;
    try { ws.send(JSON.stringify({ type: 'detach' })); } catch {}
    ws.close();
  }
  ws = null;
}

function connectToSession(sessionId) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.alive) return;

  connectionSerial += 1;
  const serial = connectionSerial;
  disconnectCurrent({ quiet: true });
  currentSessionId = sessionId;
  blocks = [];
  renderSessions();
  renderBlocks();
  if (blocksOpen) loadBlocks(sessionId, { force: true }).catch(() => {});
  term.reset();
  scheduleBidiReaderUpdate();
  setStatus('warn', 'attaching…', session.title);

  ws = new WebSocket(socketUrl(sessionId));
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    if (serial !== connectionSerial) return;
    setStatus('ok', 'connected', `${session.title} • tmux resumable`);
    const { cols, rows } = currentDims();
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    focusPreferredInput();
  });

  ws.addEventListener('message', (event) => {
    if (serial !== connectionSerial) return;
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data), scheduleBidiReaderUpdate);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      term.write(event.data, scheduleBidiReaderUpdate);
      return;
    }

    if (msg.type === 'hello') {
      setStatus('ok', 'connected', `tmux ${msg.sessionId} • attach pid ${msg.pid}`);
    } else if (msg.type === 'server-error') {
      setStatus('bad', 'error', msg.message || 'server error');
      term.writeln(`\r\n\x1b[31m${msg.message || 'server error'}\x1b[0m`);
      scheduleBidiReaderUpdate();
    } else if (msg.type === 'detached') {
      if (!intentionalDetach) setStatus('bad', 'detached', 'session still exists in sidebar');
    } else if (['block-start', 'block-update', 'block-end'].includes(msg.type)) {
      upsertBlock(msg.block);
      if (msg.type === 'block-end') clearAutoRawInput('block-end');
    }
  });

  ws.addEventListener('close', () => {
    if (serial !== connectionSerial) return;
    if (intentionalDetach) {
      setStatus('warn', 'detached', 'tmux session kept alive');
      intentionalDetach = false;
    } else {
      setStatus('bad', 'disconnected', 'click session to attach again');
    }
    setTimeout(() => {
      refreshSessions().catch(() => {});
      if (blocksOpen) loadBlocks(currentSessionId, { force: true }).catch(() => {});
    }, 300);
  });

  ws.addEventListener('error', () => {
    if (serial !== connectionSerial) return;
    setStatus('bad', 'connection error', 'server/token/session problem');
  });
}

function sendRaw(data) {
  if (!currentSessionId) {
    term.writeln('\r\n\x1b[31mNo session selected. Create or select a terminal first.\x1b[0m');
    scheduleBidiReaderUpdate();
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectToSession(currentSessionId);
    setTimeout(() => sendRaw(data), 500);
    return;
  }
  ws.send(JSON.stringify({ type: 'input', data }));
}

term.onData((data) => handleTerminalInput(data));
term.onResize(({ cols, rows }) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
});

const resizeObserver = new ResizeObserver(() => {
  const { cols, rows } = currentDims();
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
});
function shouldOpenReaderOnTrappedScroll() {
  const text = getReadableTerminalLines(40).join('\n');
  return /Welcome to Hermes Agent|\bgpt-[\w.]+\b|ctx --|❯/.test(text);
}

resizeObserver.observe(terminalEl);
terminalEl.addEventListener('pointerdown', () => setTimeout(() => term.focus(), 0));
terminalEl.addEventListener('wheel', (event) => {
  if (event.ctrlKey) return;
  const lineHeight = 18;
  const lines = Math.max(1, Math.min(12, Math.round(Math.abs(event.deltaY) / lineHeight)));
  const before = term.buffer?.active?.viewportY ?? 0;
  term.scrollLines(event.deltaY > 0 ? lines : -lines);
  const after = term.buffer?.active?.viewportY ?? before;
  if (after === before && (term.buffer?.active?.baseY ?? 0) === 0 && shouldOpenReaderOnTrappedScroll()) {
    if (!bidiReaderEnabled) {
      bidiReaderEnabled = true;
      localStorage.setItem('warpish_readable_terminal_v1', 'on');
      applyBidiMode();
    } else {
      refreshBidiReaderFromCapture().catch(() => renderBidiReader());
    }
  }
  event.preventDefault();
}, { capture: true, passive: false });

newSessionButton.addEventListener('click', async () => {
  newSessionButton.disabled = true;
  try {
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
    sessions = created.sessions || [created.session];
    connectToSession(created.session.id);
  } catch (error) {
    setStatus('bad', 'create failed', error.message);
  } finally {
    newSessionButton.disabled = false;
  }
});

refreshSessionsButton.addEventListener('click', () => refreshSessions().catch((error) => setStatus('bad', 'refresh failed', error.message)));
clearStoppedSessionsButton?.addEventListener('click', () => clearStoppedSessions());
refreshBlocksButton.addEventListener('click', () => loadBlocks(currentSessionId, { force: true }).catch((error) => setStatus('bad', 'blocks refresh failed', error.message)));
blockSearch.addEventListener('input', () => {
  blockFilter = blockSearch.value.trim();
  renderBlocks();
});

renameSessionButton.addEventListener('click', async () => {
  const session = activeSession();
  if (!session) return;
  const title = window.prompt('Rename terminal session:', session.title);
  if (!title || title.trim() === session.title) return;
  const payload = await api(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
  sessions = payload.sessions || sessions;
  renderSessions();
});

copySelection.addEventListener('click', async () => {
  const text = term.getSelection();
  if (!text) return;
  await navigator.clipboard.writeText(text);
});

blocksToggleButton?.addEventListener('click', () => setBlocksOpen(!blocksOpen));

bidiToggleButton.addEventListener('click', () => {
  bidiReaderEnabled = !bidiReaderEnabled;
  localStorage.setItem('warpish_readable_terminal_v1', bidiReaderEnabled ? 'on' : 'off');
  applyBidiMode();
});

detachSessionButton.addEventListener('click', () => {
  disconnectCurrent({ quiet: true });
  setStatus('warn', 'detached', 'click sidebar session to continue');
});

killSessionButton.addEventListener('click', async () => {
  const session = activeSession();
  if (!session) return;
  if (!window.confirm(`Kill tmux session "${session.title}"? This stops the terminal process, not just the browser attach.`)) return;
  disconnectCurrent({ quiet: true });
  await api(`/api/sessions/${session.id}`, { method: 'DELETE' });
  currentSessionId = null;
  blocks = [];
  renderBlocks();
  term.reset();
  scheduleBidiReaderUpdate();
  setStatus('warn', 'session killed', 'create or choose another session');
  await refreshSessions({ createIfEmpty: true });
});

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    term.focus();
  }
});

applyPanelMode();
applyBidiMode();

refreshSessions({ createIfEmpty: true }).catch((error) => {
  setStatus('bad', 'startup failed', error.message);
  term.writeln(`\x1b[31mStartup failed: ${error.message}\x1b[0m`);
  scheduleBidiReaderUpdate();
});

refreshTimer = setInterval(() => {
  refreshSessions().catch(() => {});
  if (blocksOpen) loadBlocks(currentSessionId, { force: true }).catch(() => {});
}, 5000);

window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  disconnectCurrent({ quiet: true });
});
