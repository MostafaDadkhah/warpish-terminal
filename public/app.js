const terminalEl = document.getElementById('terminal');
const terminalCard = document.querySelector('.terminal-card');
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
const mouseModeToggleButton = document.getElementById('mouseModeToggle');
const tuiModeToggleButton = document.getElementById('tuiModeToggle');
const tuiModeStatus = document.getElementById('tuiModeStatus');
const terminalSearchToggleButton = document.getElementById('terminalSearchToggle');
const terminalSearchPanel = document.getElementById('terminalSearchPanel');
const terminalSearchInput = document.getElementById('terminalSearchInput');
const terminalSearchCount = document.getElementById('terminalSearchCount');
const terminalSearchPrevious = document.getElementById('terminalSearchPrevious');
const terminalSearchNext = document.getElementById('terminalSearchNext');
const terminalSearchClose = document.getElementById('terminalSearchClose');
const settingsToggleButton = document.getElementById('settingsToggle');
const exportSessionButton = document.getElementById('exportSession');
const splitVerticalButton = document.getElementById('splitVertical');
const splitHorizontalButton = document.getElementById('splitHorizontal');
const nextPaneButton = document.getElementById('nextPane');
const bidiReader = document.getElementById('bidiReader');
const bidiReaderLines = document.getElementById('bidiReaderLines');
const detachSessionButton = document.getElementById('detachSession');
const killSessionButton = document.getElementById('killSession');
const blockList = document.getElementById('blockList');
const blockSearch = document.getElementById('blockSearch');
const blocksCount = document.getElementById('blocksCount');
const refreshBlocksButton = document.getElementById('refreshBlocks');
const newSessionDialog = document.getElementById('newSessionDialog');
const newSessionForm = document.getElementById('newSessionForm');
const newSessionTitleInput = document.getElementById('newSessionTitle');
const newSessionCwdInput = document.getElementById('newSessionCwd');
const newSessionProfileInput = document.getElementById('newSessionProfile');
const newSessionPrivateInput = document.getElementById('newSessionPrivate');
const newSessionError = document.getElementById('newSessionError');
const settingsDialog = document.getElementById('settingsDialog');
const settingsForm = document.getElementById('settingsForm');
const settingsResetButton = document.getElementById('settingsReset');
const pasteDialog = document.getElementById('pasteDialog');
const pastePreview = document.getElementById('pastePreview');
const mobileTerminalKeys = document.querySelector('.mobile-terminal-keys');

const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon?.FitAddon;
const WebLinksAddonCtor = window.WebLinksAddon?.WebLinksAddon;
const SearchAddonCtor = window.SearchAddon?.SearchAddon;
const terminalInputApi = window.WarpishTerminalInput;
const terminalPreferencesApi = window.WarpishTerminalPreferences;
let terminalPreferences = terminalPreferencesApi?.load?.() || {
  fontSize: 13.5, lineHeight: 1.16, scrollback: 50000, theme: 'midnight',
  cursorBlink: true, screenReaderMode: false, notifications: false,
  defaultCwd: '', defaultProfile: 'default', privateByDefault: false,
};
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

const FALLBACK_TERMINAL_THEME = Object.freeze({
  background: '#070711',
  foreground: '#f4f1ff',
  cursor: '#22d3ee',
  selectionBackground: '#5b4a9f66',
  black: '#11111b', red: '#fb7185', green: '#34d399', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#f3f4f6',
  brightBlack: '#6b7280', brightRed: '#fda4af', brightGreen: '#86efac', brightYellow: '#fde68a',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
});
const TERMINAL_THEME = terminalPreferencesApi?.THEMES?.[terminalPreferences.theme] || FALLBACK_TERMINAL_THEME;

const term = new TerminalCtor({
  cursorBlink: terminalPreferences.cursorBlink && !prefersReducedMotion,
  cursorStyle: 'bar',
  macOptionIsMeta: true,
  convertEol: false,
  fontFamily: '"SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: terminalPreferences.fontSize,
  lineHeight: terminalPreferences.lineHeight,
  letterSpacing: 0,
  scrollback: terminalPreferences.scrollback,
  screenReaderMode: terminalPreferences.screenReaderMode,
  allowTransparency: true,
  theme: TERMINAL_THEME,
});

const fitAddon = FitAddonCtor ? new FitAddonCtor() : null;
const searchAddon = SearchAddonCtor ? new SearchAddonCtor() : null;
if (fitAddon) term.loadAddon(fitAddon);
if (WebLinksAddonCtor) term.loadAddon(new WebLinksAddonCtor());
if (searchAddon) term.loadAddon(searchAddon);
term.open(terminalEl);
document.body.dataset.terminalTheme = terminalPreferences.theme;
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

let sessions = [];
let blocks = [];
let currentSessionId = null;
let ws = null;
let connectionSerial = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;
let terminalControlRole = 'controller';
let terminalWriteDepth = 0;
let controlClaimPending = false;
let sessionGeneration = 0;
let blocksRequestSerial = 0;
let sessionsRequestSerial = 0;
let sessionsRefreshPending = false;
let sessionsRefreshQueued = null;
let sessionsMutationDepth = 0;
let pendingTerminalInputs = [];
let terminalInputFlushTimer = null;
const busyControls = new WeakSet();
const intentionallyClosedSockets = new WeakSet();
let refreshTimer = null;
let blockFilter = '';
let blocksOpen = localStorage.getItem('warpish_blocks_open') === 'on';
let bidiReaderEnabled = localStorage.getItem('warpish_readable_terminal_v1') !== 'off';
let readerMouseMode = localStorage.getItem('warpish_reader_mouse_mode_v1') === 'raw' ? 'raw' : 'reader';
let tuiAutoEnabled = localStorage.getItem('warpish_tui_auto_mode_v1') !== 'off';
let detectedTuiActive = false;
let detectedTuiCaptureReason = '';
let bidiReaderUpdatePending = false;

const RTL_CHAR_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const STRONG_CHAR_RE = /[A-Za-z\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const LTR_TOKEN_CHAR_RE = /[A-Za-z0-9_.\/@~#$%&+=\\'"`|^-]/u;
const BIDI_TOKEN_RE = /(\s+|\S+)/gu;
const TERMINAL_LINK_RE = /(https?:\/\/[^\s<>"'`\x00-\x1f\x7f]+|www\.[^\s<>"'`\x00-\x1f\x7f]+)/giu;
const LINK_TRAILING_PUNCT_RE = /[.,;:!?،؛؟…]+$/u;
const BIDI_READER_MAX_LINES = 2000;
const BIDI_READER_RENDER_INTERVAL_MS = 100;
const BIDI_CAPTURE_REFRESH_INTERVAL_MS = 2000;
const BIDI_CAPTURE_SETTLE_DELAY_MS = 450;
const BIDI_READER_BOTTOM_EPSILON = 10;
const TERMINAL_FOCUS_REPORT_SUPPRESS_MS = 1200;
const XTERM_COLOR_MODE_PALETTE = 0x1000000;
const XTERM_COLOR_MODE_P256 = 0x2000000;
const XTERM_COLOR_MODE_RGB = 0x3000000;
let ANSI_PALETTE = [
  TERMINAL_THEME.black, TERMINAL_THEME.red, TERMINAL_THEME.green, TERMINAL_THEME.yellow,
  TERMINAL_THEME.blue, TERMINAL_THEME.magenta, TERMINAL_THEME.cyan, TERMINAL_THEME.white,
  TERMINAL_THEME.brightBlack, TERMINAL_THEME.brightRed, TERMINAL_THEME.brightGreen, TERMINAL_THEME.brightYellow,
  TERMINAL_THEME.brightBlue, TERMINAL_THEME.brightMagenta, TERMINAL_THEME.brightCyan, TERMINAL_THEME.brightWhite,
];
const BLOCK_RENDER_LIMIT = 60;
const BLOCK_OUTPUT_PREVIEW_CHARS = 3200;
const SESSION_PREVIEW_CHARS = 900;
const MAX_TERMINAL_INPUT_MESSAGE_BYTES = terminalInputApi?.MAX_MESSAGE_BYTES || 64 * 1024;
const MAX_PENDING_TERMINAL_INPUT_BYTES = terminalInputApi?.MAX_PENDING_BYTES || 1024 * 1024;
const MAX_BROWSER_SOCKET_BUFFERED_BYTES = 256 * 1024;
let blockRenderPending = false;
let bidiReaderUpdateTimer = null;
let lastBidiReaderRenderAt = 0;
let lastBidiReaderRenderKey = '';
let lastBidiReaderRenderSource = 'xterm';
let bidiReaderPinnedToBottom = true;
let bidiReaderCaptureForScrollPending = false;
let bidiReaderCaptureRefreshPending = false;
let bidiReaderCaptureRefreshQueued = null;
let bidiReaderCaptureSettleTimer = null;
let lastBidiReaderCaptureAt = 0;
let bidiReaderCaptureSuccessCount = 0;
let bidiReaderCaptureMode = 'xterm';
let capturedReaderHistoryState = { known: false, entries: [], pendingReset: null };
let capturedReaderHistoryRevision = -1;
let capturedReaderHistoryNeedsLiveScreen = false;
let capturedReaderScreenKnown = false;
let capturedReaderScreenEntries = [];
let capturedReaderScreenRevision = -1;
let terminalOutputRevision = 0;
let bidiReaderHistoryModeUntil = 0;
let terminalFocusTimer = null;
let terminalFocusSerial = 0;
let terminalInputEventSerial = 0;
let terminalFocusFollowupTimers = [];
let terminalFitRaf = null;
let lastSentTerminalSize = '';
let suppressTerminalFocusReportsUntil = 0;
let terminalSearchQuery = '';
let readableSearchMatches = [];
let readableSearchIndex = -1;
let terminalSearchUsesNativeSurface = false;
let activeTerminalTitle = '';
let pendingMultilinePaste = null;

function compactText(text = '', maxChars = BLOCK_OUTPUT_PREVIEW_CHARS) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `… truncated ${value.length - maxChars} chars …\n${value.slice(-maxChars)}`;
}

function applyTerminalPreferences(nextPreferences = terminalPreferences) {
  terminalPreferences = terminalPreferencesApi?.normalize?.(nextPreferences) || nextPreferences;
  const theme = terminalPreferencesApi?.THEMES?.[terminalPreferences.theme] || FALLBACK_TERMINAL_THEME;
  term.options.fontSize = terminalPreferences.fontSize;
  term.options.lineHeight = terminalPreferences.lineHeight;
  term.options.scrollback = terminalPreferences.scrollback;
  term.options.cursorBlink = terminalPreferences.cursorBlink && !prefersReducedMotion;
  term.options.screenReaderMode = terminalPreferences.screenReaderMode;
  term.options.theme = theme;
  terminalCard?.style.setProperty('--reader-bg', theme.background);
  terminalCard?.style.setProperty('--reader-fg', theme.foreground);
  terminalCard?.style.setProperty('--reader-border', theme.cursor);
  terminalCard?.style.setProperty('--reader-link', theme.cyan);
  terminalCard?.style.setProperty('--reader-cursor', theme.cursor);
  terminalCard?.style.setProperty('--reader-ghost', theme.brightBlack);
  ANSI_PALETTE = [
    theme.black, theme.red, theme.green, theme.yellow,
    theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
    theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
  ];
  document.body.dataset.terminalTheme = terminalPreferences.theme;
  lastBidiReaderRenderKey = '';
  refitTerminal();
  scheduleBidiReaderUpdate({ immediate: true });
}

function populateSettingsForm(preferences = terminalPreferences) {
  const fields = {
    settingFontSize: preferences.fontSize,
    settingLineHeight: preferences.lineHeight,
    settingScrollback: preferences.scrollback,
    settingTheme: preferences.theme,
    settingDefaultCwd: preferences.defaultCwd,
    settingDefaultProfile: preferences.defaultProfile,
  };
  for (const [id, value] of Object.entries(fields)) {
    const element = document.getElementById(id);
    if (element) element.value = value;
  }
  const checks = {
    settingCursorBlink: preferences.cursorBlink,
    settingScreenReader: preferences.screenReaderMode,
    settingNotifications: preferences.notifications,
    settingPrivateDefault: preferences.privateByDefault,
  };
  for (const [id, checked] of Object.entries(checks)) {
    const element = document.getElementById(id);
    if (element) element.checked = Boolean(checked);
  }
}

function settingsFromForm() {
  return {
    fontSize: document.getElementById('settingFontSize')?.value,
    lineHeight: document.getElementById('settingLineHeight')?.value,
    scrollback: document.getElementById('settingScrollback')?.value,
    theme: document.getElementById('settingTheme')?.value,
    defaultCwd: document.getElementById('settingDefaultCwd')?.value,
    defaultProfile: document.getElementById('settingDefaultProfile')?.value,
    cursorBlink: document.getElementById('settingCursorBlink')?.checked,
    screenReaderMode: document.getElementById('settingScreenReader')?.checked,
    notifications: document.getElementById('settingNotifications')?.checked,
    privateByDefault: document.getElementById('settingPrivateDefault')?.checked,
  };
}

function openSettingsDialog() {
  populateSettingsForm();
  settingsDialog?.showModal?.();
}

function clearReadableSearchMatches() {
  for (const line of readableSearchMatches) line.classList.remove('search-match');
  readableSearchMatches = [];
  readableSearchIndex = -1;
}

function setTerminalSearchNativeSurface(enabled) {
  terminalSearchUsesNativeSurface = Boolean(enabled);
  document.body.classList.toggle('terminal-search-native', terminalSearchUsesNativeSurface);
}

function updateTerminalSearchCount(found, total = null) {
  if (!terminalSearchCount) return;
  if (Number.isInteger(total)) {
    terminalSearchCount.textContent = total ? `${Math.max(0, readableSearchIndex + 1)}/${total}` : '0 matches';
  } else {
    terminalSearchCount.textContent = found ? 'match' : '0 matches';
  }
}

function updateReadableSearchMatches({ keepIndex = false } = {}) {
  if (terminalSearchUsesNativeSurface) return false;
  const priorIndex = readableSearchIndex;
  clearReadableSearchMatches();
  const query = terminalSearchQuery.trim().toLocaleLowerCase();
  if (!query || !isReadableSurfaceActive() || !bidiReaderLines) {
    updateTerminalSearchCount(false, 0);
    return false;
  }
  readableSearchMatches = [...bidiReaderLines.querySelectorAll('.bidi-line')]
    .filter((line) => String(line.dataset.logicalText || line.textContent || '').toLocaleLowerCase().includes(query));
  if (!readableSearchMatches.length) {
    updateTerminalSearchCount(false, 0);
    return false;
  }
  readableSearchIndex = keepIndex ? Math.min(Math.max(priorIndex, 0), readableSearchMatches.length - 1) : 0;
  const active = readableSearchMatches[readableSearchIndex];
  active.classList.add('search-match');
  active.scrollIntoView({ block: 'center' });
  updateTerminalSearchCount(true, readableSearchMatches.length);
  return true;
}

function runTerminalSearch(direction = 'next', { incremental = false } = {}) {
  terminalSearchQuery = terminalSearchInput?.value || '';
  if (!terminalSearchQuery) {
    searchAddon?.clearDecorations?.();
    clearReadableSearchMatches();
    setTerminalSearchNativeSurface(false);
    updateTerminalSearchCount(false, 0);
    return false;
  }
  if (isReadableSurfaceActive()) {
    if (!readableSearchMatches.length || incremental) {
      if (updateReadableSearchMatches()) {
        searchAddon?.clearDecorations?.();
        setTerminalSearchNativeSurface(false);
        return true;
      }
    } else {
      readableSearchMatches[readableSearchIndex]?.classList.remove('search-match');
      const delta = direction === 'previous' ? -1 : 1;
      readableSearchIndex = (readableSearchIndex + delta + readableSearchMatches.length) % readableSearchMatches.length;
      const active = readableSearchMatches[readableSearchIndex];
      active.classList.add('search-match');
      active.scrollIntoView({ block: 'center' });
      updateTerminalSearchCount(true, readableSearchMatches.length);
      return true;
    }
    // A pane switch can make the readable mirror narrower than xterm's local
    // scrollback. Fall through to SearchAddon so earlier visible output remains
    // discoverable instead of reporting a false zero-match result.
  }
  const options = { incremental, caseSensitive: false, wholeWord: false, regex: false };
  const found = direction === 'previous'
    ? searchAddon?.findPrevious?.(terminalSearchQuery, options)
    : searchAddon?.findNext?.(terminalSearchQuery, options);
  setTerminalSearchNativeSurface(Boolean(found) && isReadableSurfaceActive());
  updateTerminalSearchCount(Boolean(found));
  return Boolean(found);
}

function setTerminalSearchOpen(open) {
  if (!terminalSearchPanel) return;
  terminalSearchPanel.hidden = !open;
  terminalSearchToggleButton?.setAttribute('aria-expanded', String(open));
  if (open) {
    terminalSearchInput?.focus();
    terminalSearchInput?.select();
    runTerminalSearch('next', { incremental: true });
  } else {
    searchAddon?.clearDecorations?.();
    clearReadableSearchMatches();
    terminalSearchQuery = '';
    if (terminalSearchInput) terminalSearchInput.value = '';
    setTerminalSearchNativeSurface(false);
    focusTerminalSoon();
  }
}

function bidiDirection(text = '') {
  const firstStrong = String(text).match(STRONG_CHAR_RE)?.[0] || '';
  return RTL_CHAR_RE.test(firstStrong) ? 'rtl' : 'ltr';
}

function bidiTokenDirection(token = '', fallbackDir = 'ltr') {
  if (LTR_TOKEN_CHAR_RE.test(token)) return 'ltr';
  if (RTL_CHAR_RE.test(token)) return 'rtl';
  return fallbackDir;
}

function terminalLinkParts(raw = '') {
  let url = String(raw || '');
  let suffix = '';
  const takeSuffix = (count = 1) => {
    suffix = url.slice(-count) + suffix;
    url = url.slice(0, -count);
  };
  const punctMatch = url.match(LINK_TRAILING_PUNCT_RE);
  if (punctMatch?.[0]) {
    takeSuffix(punctMatch[0].length);
  }
  if (url.endsWith(')') && !url.includes('(')) takeSuffix();
  if (url.endsWith(']') && !url.includes('[')) takeSuffix();
  return { url, suffix };
}

function terminalLinkHref(url = '') {
  const value = String(url || '');
  return /^www\./i.test(value) ? `https://${value}` : value;
}

function cleanTerminalLinkText(text = '') {
  return String(text || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ' ')
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, ' ')
    .replace(/\x1b\\/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

function appendTerminalLinkifiedText(element, text = '') {
  const value = cleanTerminalLinkText(text);
  let cursor = 0;
  for (const match of value.matchAll(TERMINAL_LINK_RE)) {
    const raw = match[0] || '';
    const start = match.index ?? 0;
    if (start > cursor) element.appendChild(document.createTextNode(value.slice(cursor, start)));
    const { url, suffix } = terminalLinkParts(raw);
    const href = terminalLinkHref(url);
    if (url && /^https?:\/\//i.test(href)) {
      const link = document.createElement('a');
      link.className = 'bidi-link';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.dir = 'ltr';
      link.textContent = url;
      link.title = 'Open link in new tab';
      element.appendChild(link);
      if (suffix) element.appendChild(document.createTextNode(suffix));
    } else {
      element.appendChild(document.createTextNode(raw));
    }
    cursor = start + raw.length;
  }
  if (cursor < value.length) element.appendChild(document.createTextNode(value.slice(cursor)));
}

function appendBidiRun(element, text, dir) {
  if (!text) return;
  const run = document.createElement('bdi');
  run.className = `bidi-run ${dir}`;
  run.dir = dir;
  appendTerminalLinkifiedText(run, text);
  element.appendChild(run);
}

function appendBidiRunWithBoundarySpace(element, text, dir) {
  const match = String(text || '').match(/^(.*?)(\s+)$/u);
  if (!match) {
    appendBidiRun(element, text, dir);
    return;
  }
  appendBidiRun(element, match[1], dir);
  element.appendChild(document.createTextNode(match[2]));
}

function splitPromptRtlSuffix(value = '') {
  const match = String(value).match(/^(.{0,160}?(?:[%$#❯›➜>]\s+))(.+)$/u);
  if (!match) return null;
  const [, prefix, suffix] = match;
  if (bidiDirection(prefix) !== 'ltr' || bidiDirection(suffix) !== 'rtl') return null;
  return { prefix, suffix };
}

function renderBidiTokenRuns(element, value, sourceDir) {
  const tokens = String(value || ' ').match(BIDI_TOKEN_RE) || [String(value || ' ')];
  let pendingText = '';
  let pendingDir = '';

  for (const token of tokens) {
    if (/^\s+$/u.test(token)) {
      pendingText += token;
      continue;
    }
    const dir = bidiTokenDirection(token, sourceDir);
    if (!pendingDir) {
      pendingDir = dir;
      pendingText += token;
      continue;
    }
    if (dir === pendingDir) {
      pendingText += token;
      continue;
    }
    appendBidiRunWithBoundarySpace(element, pendingText, pendingDir);
    pendingDir = dir;
    pendingText = token;
  }
  appendBidiRun(element, pendingText, pendingDir || sourceDir);
}

function renderBidiRuns(element, text = '') {
  if (!element) return;
  const value = String(text || ' ');
  const promptSplit = splitPromptRtlSuffix(value);
  const sourceDir = promptSplit ? 'ltr' : bidiDirection(value);
  element.textContent = '';
  element.dir = sourceDir;
  element.dataset.sourceDir = sourceDir;
  element.classList.toggle('source-rtl', sourceDir === 'rtl');
  element.classList.toggle('source-ltr', sourceDir !== 'rtl');

  if (promptSplit) {
    appendBidiRunWithBoundarySpace(element, promptSplit.prefix, 'ltr');
    const segment = document.createElement('span');
    segment.className = 'bidi-segment rtl';
    segment.dir = 'rtl';
    segment.dataset.sourceDir = 'rtl';
    renderBidiTokenRuns(segment, promptSplit.suffix, 'rtl');
    element.appendChild(segment);
    return;
  }

  renderBidiTokenRuns(element, value, sourceDir);
}

function applyBidiText(element, text, { className = 'bidi-plain' } = {}) {
  if (!element) return;
  element.classList.add(className);
  renderBidiRuns(element, text);
}

function normalizeReadableEntries(input = []) {
  return input
    .map((entry) => {
      const value = typeof entry === 'string' ? { text: entry } : { ...entry, text: String(entry?.text || '') };
      value.text = stripTerminalFocusArtifacts(value.text);
      return value;
    })
    .filter((entry) => entry.text.length || entry.ghostStart != null);
}

function stripTerminalFocusArtifacts(text = '') {
  return String(text || '')
    .replace(/\x1b\[(?:I|O)/g, '')
    .replace(/\^\[\[(?:I|O)/g, '');
}

function hasTerminalFocusArtifacts(text = '') {
  return /(?:\x1b\[|\^\[\[)(?:I|O)/.test(String(text || ''));
}

function rgbToHex(value) {
  const color = Number(value) >>> 0;
  return `#${color.toString(16).padStart(6, '0').slice(-6)}`;
}

function xtermPaletteColor(index, bold = false) {
  const value = Number(index);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 8 && bold) return ANSI_PALETTE[value + 8] || ANSI_PALETTE[value] || '';
  if (value < ANSI_PALETTE.length) return ANSI_PALETTE[value] || '';
  if (value >= 16 && value <= 231) {
    const cube = value - 16;
    const r = Math.floor(cube / 36);
    const g = Math.floor((cube % 36) / 6);
    const b = cube % 6;
    const component = (n) => (n === 0 ? 0 : 55 + n * 40);
    return `rgb(${component(r)}, ${component(g)}, ${component(b)})`;
  }
  if (value >= 232 && value <= 255) {
    const gray = 8 + (value - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  return '';
}

function xtermColor(mode, value, { bold = false } = {}) {
  if (!mode || value == null || value < 0) return '';
  if (mode === XTERM_COLOR_MODE_PALETTE || mode === XTERM_COLOR_MODE_P256) return xtermPaletteColor(value, bold);
  if (mode === XTERM_COLOR_MODE_RGB) return rgbToHex(value);
  return '';
}

function cellTextStyle(cell) {
  if (!cell) return null;
  const bold = Boolean(cell.isBold?.());
  const dim = Boolean(cell.isDim?.());
  const inverse = Boolean(cell.isInverse?.());
  const style = {
    fg: xtermColor(cell.getFgColorMode?.(), cell.getFgColor?.(), { bold }),
    bg: xtermColor(cell.getBgColorMode?.(), cell.getBgColor?.()),
    bold,
    dim,
    italic: Boolean(cell.isItalic?.()),
    underline: Boolean(cell.isUnderline?.()),
    inverse,
    invisible: Boolean(cell.isInvisible?.()),
  };
  return style;
}

function textStyleKey(style = {}) {
  if (!style) return '';
  return [style.fg || '', style.bg || '', style.bold ? 'b' : '', style.dim ? 'd' : '', style.italic ? 'i' : '', style.underline ? 'u' : '', style.inverse ? 'r' : '', style.invisible ? 'h' : ''].join('|');
}

function hasVisibleTextStyle(style = {}) {
  return Boolean(style?.fg || style?.bg || style?.bold || style?.dim || style?.italic || style?.underline || style?.inverse || style?.invisible);
}

function applyTextStyle(element, style = {}) {
  if (!element || !hasVisibleTextStyle(style)) return;
  element.classList.add('bidi-style-run');
  const foreground = style.inverse
    ? (style.bg || 'var(--reader-bg, #020617)')
    : style.fg;
  const background = style.inverse
    ? (style.fg || 'var(--reader-fg, #eeeaff)')
    : style.bg;
  if (foreground) element.style.color = foreground;
  if (background) element.style.backgroundColor = background;
  if (style.bold) element.style.fontWeight = '700';
  if (style.dim) element.style.opacity = '0.62';
  if (style.italic) element.style.fontStyle = 'italic';
  if (style.underline) element.style.textDecoration = 'underline';
}

function cloneTextStyle(style = {}) {
  return {
    fg: style.fg || '',
    bg: style.bg || '',
    bold: Boolean(style.bold),
    dim: Boolean(style.dim),
    italic: Boolean(style.italic),
    underline: Boolean(style.underline),
    inverse: Boolean(style.inverse),
    invisible: Boolean(style.invisible),
    fgPalette: Number.isFinite(style.fgPalette) ? style.fgPalette : null,
    bgPalette: Number.isFinite(style.bgPalette) ? style.bgPalette : null,
  };
}

function resetTextStyle(style, scope = 'all') {
  if (scope === 'all') {
    style.fg = '';
    style.bg = '';
    style.bold = false;
    style.dim = false;
    style.italic = false;
    style.underline = false;
    style.inverse = false;
    style.invisible = false;
    style.fgPalette = null;
    style.bgPalette = null;
  } else if (scope === 'fg') {
    style.fg = '';
    style.fgPalette = null;
  } else if (scope === 'bg') {
    style.bg = '';
    style.bgPalette = null;
  }
  return style;
}

function ansiRgb(r, g, b) {
  const clamp = (value) => Math.max(0, Math.min(255, Number(value) || 0));
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function normalizedAnsiSgrCodes(rawCodes = '') {
  if (rawCodes === '') return [0];
  const codes = [];
  for (const parameter of String(rawCodes).split(';')) {
    if (!parameter.includes(':')) {
      codes.push(parameter === '' ? 0 : Number(parameter));
      continue;
    }
    const parts = parameter.split(':');
    const code = Number(parts[0]);
    const mode = Number(parts[1]);
    if ((code === 38 || code === 48) && mode === 5) {
      const index = parts.slice(2).find((part) => part !== '');
      codes.push(code, 5, Number(index));
      continue;
    }
    if ((code === 38 || code === 48) && mode === 2) {
      const components = parts.slice(2).filter((part) => part !== '').slice(-3);
      if (components.length === 3) {
        codes.push(code, 2, ...components.map(Number));
        continue;
      }
    }
    codes.push(Number.isFinite(code) ? code : 0);
  }
  return codes.length ? codes : [0];
}

function applyAnsiSgr(style, rawCodes = '') {
  const codes = normalizedAnsiSgrCodes(rawCodes);
  for (let index = 0; index < codes.length; index += 1) {
    const code = Number.isFinite(codes[index]) ? codes[index] : 0;
    if (code === 0) resetTextStyle(style);
    else if (code === 1) {
      style.bold = true;
      if (Number.isFinite(style.fgPalette) && style.fgPalette < 8) {
        style.fg = xtermPaletteColor(style.fgPalette, true);
      }
    }
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 8) style.invisible = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
      if (Number.isFinite(style.fgPalette) && style.fgPalette < 8) {
        style.fg = xtermPaletteColor(style.fgPalette, false);
      }
    }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 28) style.invisible = false;
    else if (code === 39) resetTextStyle(style, 'fg');
    else if (code === 49) resetTextStyle(style, 'bg');
    else if (code >= 30 && code <= 37) {
      style.fgPalette = code - 30;
      style.fg = xtermPaletteColor(style.fgPalette, style.bold);
    } else if (code >= 90 && code <= 97) {
      style.fgPalette = code - 90 + 8;
      style.fg = xtermPaletteColor(style.fgPalette, style.bold);
    } else if (code >= 40 && code <= 47) {
      style.bgPalette = code - 40;
      style.bg = xtermPaletteColor(style.bgPalette);
    } else if (code >= 100 && code <= 107) {
      style.bgPalette = code - 100 + 8;
      style.bg = xtermPaletteColor(style.bgPalette);
    }
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      const paletteTarget = code === 38 ? 'fgPalette' : 'bgPalette';
      const mode = codes[index + 1];
      if (mode === 2 && codes.length >= index + 5) {
        style[target] = ansiRgb(codes[index + 2], codes[index + 3], codes[index + 4]);
        style[paletteTarget] = null;
        index += 4;
      } else if (mode === 5 && codes.length >= index + 3) {
        style[paletteTarget] = codes[index + 2];
        style[target] = xtermPaletteColor(codes[index + 2], code === 38 && style.bold);
        index += 2;
      }
    }
  }
  return style;
}

function trimStyledEntryEnd(entry) {
  const text = String(entry?.text || '').trimEnd();
  const segments = entry?.segments?.length ? sliceStyledSegments(entry.segments, 0, text.length) : [];
  return { text, segments };
}

function parseAnsiCaptureEntries(text = '') {
  const entries = [];
  let entry = { text: '', segments: [] };
  const style = resetTextStyle({});
  const pushEntry = () => {
    entries.push(trimStyledEntryEnd(entry));
    entry = { text: '', segments: [] };
  };
  const appendText = (value = '') => {
    if (!value) return;
    const clean = String(value)
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ' ')
      .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, ' ')
      .replace(/\x1b\\/g, ' ')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
    const parts = clean.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) pushEntry();
      if (!part) return;
      entry.text += part;
      mergeStyledSegment(entry.segments, part, cloneTextStyle(style));
    });
  };
  const sgrPattern = /\x1b\[([0-9;:]*)m/g;
  let cursor = 0;
  let match;
  while ((match = sgrPattern.exec(String(text))) !== null) {
    appendText(String(text).slice(cursor, match.index));
    applyAnsiSgr(style, match[1]);
    cursor = sgrPattern.lastIndex;
  }
  appendText(String(text).slice(cursor));
  pushEntry();
  return entries
    .map(trimStyledEntryEnd)
    .filter((item) => item.text.trim().length > 0);
}

function mergeStyledSegment(segments, text, style) {
  if (!text) return;
  const normalizedStyle = hasVisibleTextStyle(style) ? style : null;
  const key = textStyleKey(normalizedStyle);
  const last = segments[segments.length - 1];
  if (last && last.key === key) {
    last.text += text;
  } else {
    segments.push({ text, style: normalizedStyle, key });
  }
}

function sliceStyledSegments(segments = [], start = 0, end = Infinity) {
  const result = [];
  let offset = 0;
  for (const segment of segments) {
    const segStart = offset;
    const segEnd = offset + segment.text.length;
    offset = segEnd;
    if (segEnd <= start || segStart >= end) continue;
    const from = Math.max(0, start - segStart);
    const to = Math.min(segment.text.length, end - segStart);
    mergeStyledSegment(result, segment.text.slice(from, to), segment.style);
  }
  return result;
}

function getLineStyledSegments(line, text) {
  if (!line || !text) return [];
  const segments = [];
  let collected = '';
  for (let cellIndex = 0; cellIndex < line.length && collected.length < text.length; cellIndex += 1) {
    const cell = line.getCell(cellIndex);
    if (!cell || cell.getWidth?.() === 0) continue;
    let chars = cell.getChars?.() || ' ';
    if (!chars) chars = ' ';
    if (collected.length + chars.length > text.length) chars = chars.slice(0, text.length - collected.length);
    collected += chars;
    mergeStyledSegment(segments, chars, cellTextStyle(cell));
  }
  return segments.some((segment) => hasVisibleTextStyle(segment.style)) ? segments : [];
}

function appendStyledBidiContent(element, text, segments = []) {
  if (!segments?.length) {
    renderBidiRuns(element, text);
    return;
  }
  for (const segment of segments) {
    const wrapper = document.createElement('span');
    applyTextStyle(wrapper, segment.style);
    const displayText = segment.style?.invisible
      ? ' '.repeat(Math.max(1, String(segment.text || '').length))
      : (segment.text || ' ');
    renderBidiRuns(wrapper, displayText);
    element.appendChild(wrapper);
  }
}

function maskInvisibleStyledText(text = '', segments = []) {
  if (!segments?.some((segment) => segment.style?.invisible)) return String(text || '');
  return segments.map((segment) => (
    segment.style?.invisible
      ? ' '.repeat(String(segment.text || '').length)
      : String(segment.text || '')
  )).join('');
}

function appendStyledSegmentsToEntry(entry, text, segments = []) {
  const offset = entry.text.length;
  if (segments?.length && !entry.segments.length && offset > 0) {
    mergeStyledSegment(entry.segments, entry.text, null);
  }
  entry.text += text;
  if (segments?.length) {
    for (const segment of segments) mergeStyledSegment(entry.segments, segment.text, segment.style);
  } else if (entry.segments.length && text) {
    mergeStyledSegment(entry.segments, text, null);
  }
  return offset;
}

function getReadableTerminalEntries(limit = BIDI_READER_MAX_LINES, { activeScreenOnly = false } = {}) {
  const buffer = term.buffer?.active;
  if (!buffer) return [];
  const end = Math.min(buffer.length, buffer.baseY + term.rows);
  const start = activeScreenOnly
    ? Math.max(0, buffer.baseY)
    : Math.max(0, end - limit * 2);
  const activeLineIndex = buffer.baseY + buffer.cursorY;
  const entries = [];

  for (let i = start; i < end; i += 1) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const rawText = line.translateToString(true).trimEnd();
    const styledSegments = getLineStyledSegments(line, rawText);
    const entry = { text: '', segments: [], isActiveLine: i === activeLineIndex };
    const appendedOffset = appendStyledSegmentsToEntry(entry, rawText, styledSegments);
    if (i === activeLineIndex && Number.isFinite(buffer.cursorX) && buffer.cursorX < rawText.length) {
      entry.ghostStart = Math.max(0, appendedOffset + buffer.cursorX);
    }
    if (line.isWrapped && entries.length) {
      const previous = entries[entries.length - 1];
      const offset = appendStyledSegmentsToEntry(previous, rawText, styledSegments);
      previous.isActiveLine = previous.isActiveLine || entry.isActiveLine;
      if (entry.ghostStart != null) previous.ghostStart = offset + buffer.cursorX;
    } else {
      entries.push(entry);
    }
  }

  while (entries.length && !entries[entries.length - 1].text.trim() && !entries[entries.length - 1].isActiveLine) entries.pop();
  return entries.slice(-limit);
}

function getReadableTerminalScreenEntries() {
  return getReadableTerminalEntries(Math.max(1, Math.min(term?.rows || 36, BIDI_READER_MAX_LINES)), { activeScreenOnly: true });
}

function getReadableTerminalLines(limit = BIDI_READER_MAX_LINES) {
  return getReadableTerminalEntries(limit).map((entry) => entry.text);
}

function isTerminalAlternateBuffer() {
  return term?.buffer?.active?.type === 'alternate';
}

function isBidiReaderNearBottom() {
  if (!bidiReaderLines) return true;
  return bidiReaderLines.scrollHeight - bidiReaderLines.scrollTop - bidiReaderLines.clientHeight <= BIDI_READER_BOTTOM_EPSILON;
}

function renderBidiLine(row, entry) {
  const text = entry.text || ' ';
  const segments = Array.isArray(entry.segments) ? entry.segments : [];
  const logicalText = maskInvisibleStyledText(text, segments);
  const ghostStart = Number.isFinite(entry.ghostStart) ? Math.max(0, Math.min(entry.ghostStart, text.length)) : null;
  row.className = `bidi-line ${bidiDirection(logicalText)}`;
  row.classList.toggle('active-cursor-line', Boolean(entry.isActiveLine));
  row.dataset.logicalText = logicalText;
  if (ghostStart == null || ghostStart >= text.length) {
    appendStyledBidiContent(row, text, segments);
    return;
  }

  const visibleText = text.slice(0, ghostStart) || ' ';
  const ghostText = text.slice(ghostStart);
  const visibleSegments = sliceStyledSegments(segments, 0, ghostStart);
  const ghostSegments = sliceStyledSegments(segments, ghostStart, text.length);
  row.classList.add('has-ghost');
  appendStyledBidiContent(row, visibleText, visibleSegments);
  const cursor = document.createElement('span');
  cursor.className = 'bidi-inline-cursor';
  cursor.textContent = '▌';
  row.appendChild(cursor);
  if (ghostText) {
    const ghost = document.createElement('span');
    ghost.className = 'bidi-ghost';
    ghost.dataset.ghostText = maskInvisibleStyledText(ghostText, ghostSegments);
    appendStyledBidiContent(ghost, ghostText, ghostSegments);
    row.appendChild(ghost);
  }
}

function readableEntriesKey(entries) {
  return entries.map((entry) => {
    const segmentKey = Array.isArray(entry.segments)
      ? entry.segments.map((segment) => `${segment.key || textStyleKey(segment.style)}:${segment.text}`).join('|')
      : '';
    return `${entry.ghostStart ?? ''}\t${entry.text}\t${segmentKey}`;
  }).join('\n');
}

function setBidiReaderHasContent(hasContent) {
  document.body.classList.toggle('bidi-reader-has-content', Boolean(hasContent));
  if (bidiReader) bidiReader.classList.toggle('has-content', Boolean(hasContent));
}

function readableEntryComparableText(entry) {
  return String(entry?.text || '').replace(/[\s\u00a0]+$/gu, '');
}

function readableLinesShareUpdatingPrefix(left = '', right = '') {
  const a = String(left || '').replace(/[\s\u00a0]+$/gu, '');
  const b = String(right || '').replace(/[\s\u00a0]+$/gu, '');
  if (!a || !b) return false;
  if (a === b) return true;

  const shorterLength = Math.min(a.length, b.length);
  let commonPrefixLength = 0;
  while (commonPrefixLength < shorterLength && a[commonPrefixLength] === b[commonPrefixLength]) {
    commonPrefixLength += 1;
  }

  const requiredPrefixLength = Math.min(24, Math.max(8, Math.floor(shorterLength * 0.7)));
  return commonPrefixLength >= requiredPrefixLength
    && (a.startsWith(b) || b.startsWith(a) || commonPrefixLength >= Math.floor(shorterLength * 0.85));
}

function mergeCapturedReaderEntriesWithLiveTail(capturedEntries = [], liveEntries = []) {
  if (!capturedEntries.length) return liveEntries;
  if (!liveEntries.length) return capturedEntries;

  const capturedTexts = capturedEntries.map(readableEntryComparableText);
  const liveTexts = liveEntries.map(readableEntryComparableText);
  const searchStart = Math.max(0, capturedEntries.length - liveEntries.length - 100);
  let bestIndex = -1;
  let bestMatched = 0;
  for (let index = searchStart; index < capturedEntries.length; index += 1) {
    let matched = 0;
    for (let liveIndex = 0; liveIndex < liveTexts.length && index + liveIndex < capturedTexts.length; liveIndex += 1) {
      if (capturedTexts[index + liveIndex] !== liveTexts[liveIndex]) break;
      matched += 1;
    }
    if (matched > bestMatched) {
      bestMatched = matched;
      bestIndex = index;
    }
  }

  const minimumOverlap = Math.min(3, liveEntries.length);
  if (bestIndex >= 0 && bestMatched >= minimumOverlap) {
    return capturedEntries.slice(0, bestIndex).concat(liveEntries);
  }

  // Interactive shells frequently redraw only the active prompt line. During that
  // short redraw window xterm can expose a one-line buffer even though tmux still
  // owns the preceding history. Treat a strongly matching prefix as an in-place
  // update of the captured tail instead of replacing the whole readable surface.
  const liveFirstText = liveTexts[0] || '';
  const capturedTailIndex = capturedTexts.length - 1;
  if (readableLinesShareUpdatingPrefix(capturedTexts[capturedTailIndex], liveFirstText)) {
    return capturedEntries.slice(0, capturedTailIndex).concat(liveEntries);
  }

  const tailLength = Math.min(liveEntries.length, Math.max(12, Math.min(term?.rows || 36, 80)));
  return capturedEntries.concat(liveEntries.slice(-tailLength));
}

function reduceCapturedReaderHistory(previousState = {}, nextInput = []) {
  const previousEntries = normalizeReadableEntries(previousState.entries || []);
  const nextEntries = normalizeReadableEntries(nextInput);
  const normalizedNext = nextEntries.slice(-BIDI_READER_MAX_LINES);
  if (!previousState.known || normalizedNext.length >= previousEntries.length) {
    return { known: true, entries: normalizedNext, pendingReset: null, committed: true };
  }

  // A single short tmux snapshot can occur while a CLI redraws. Keep the last
  // complete canonical history for that one sample, but accept a second
  // consecutive short/empty snapshot so clear-history and real resets work.
  if (!previousState.pendingReset) {
    return {
      known: true,
      entries: previousEntries.slice(-BIDI_READER_MAX_LINES),
      pendingReset: { entries: normalizedNext },
      committed: false,
    };
  }

  return { known: true, entries: normalizedNext, pendingReset: null, committed: true };
}

function resetCapturedReaderState() {
  bidiReaderCaptureMode = 'xterm';
  capturedReaderHistoryState = { known: false, entries: [], pendingReset: null };
  capturedReaderHistoryRevision = -1;
  capturedReaderHistoryNeedsLiveScreen = false;
  capturedReaderScreenKnown = false;
  capturedReaderScreenEntries = [];
  capturedReaderScreenRevision = -1;
}

function captureBidiReaderAnchor() {
  if (!bidiReaderLines) return null;
  const containerRect = bidiReaderLines.getBoundingClientRect();
  const lines = [...bidiReaderLines.querySelectorAll('.bidi-line')];
  const node = lines.find((line) => {
    const rect = line.getBoundingClientRect();
    return rect.bottom > containerRect.top + 4 && rect.top < containerRect.bottom - 4;
  });
  if (!node) return null;
  return {
    index: lines.indexOf(node),
    text: node.dataset.logicalText || node.textContent || '',
    offset: node.getBoundingClientRect().top - containerRect.top,
  };
}

function restoreBidiReaderAnchor(anchor) {
  if (!anchor || !bidiReaderLines) return false;
  const lines = [...bidiReaderLines.querySelectorAll('.bidi-line')];
  if (!lines.length) return false;
  const exact = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => (line.dataset.logicalText || line.textContent || '') === anchor.text)
    .sort((left, right) => Math.abs(left.index - anchor.index) - Math.abs(right.index - anchor.index))[0]?.line;
  const fallback = lines[Math.min(anchor.index, lines.length - 1)];
  const node = exact || fallback;
  if (!node) return false;
  const containerRect = bidiReaderLines.getBoundingClientRect();
  const delta = node.getBoundingClientRect().top - containerRect.top - anchor.offset;
  if (Math.abs(delta) > 0.5) bidiReaderLines.scrollTop += delta;
  return true;
}

function readerSelectionIsActive() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !bidiReaderLines) return false;
  const withinReader = (node) => {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element && bidiReaderLines.contains(element));
  };
  return withinReader(selection.anchorNode) || withinReader(selection.focusNode);
}

function renderBidiReader(input = getReadableTerminalEntries(), { force = false, keepScroll = false, source = 'xterm', preserveAwayFromBottom = false } = {}) {
  if (!bidiReaderLines) return;
  const entries = normalizeReadableEntries(input);
  const hasContent = entries.length > 0;
  const key = `${hasContent ? 'content' : 'empty'}\n${readableEntriesKey(entries)}`;
  if (key === lastBidiReaderRenderKey) {
    lastBidiReaderRenderSource = source;
    return;
  }
  if (readerSelectionIsActive()) return;
  const previousNearBottom = isBidiReaderNearBottom();
  const wasPinned = !preserveAwayFromBottom && (previousNearBottom || (!keepScroll && bidiReaderPinnedToBottom));
  const previousScrollTop = bidiReaderLines.scrollTop;
  const anchor = keepScroll && !wasPinned ? captureBidiReaderAnchor() : null;
  lastBidiReaderRenderKey = key;
  lastBidiReaderRenderSource = source;
  setBidiReaderHasContent(hasContent);

  const fragment = document.createDocumentFragment();
  if (!hasContent) {
    const empty = document.createElement('div');
    empty.className = 'bidi-line empty-state';
    empty.textContent = 'Waiting for terminal output…';
    fragment.appendChild(empty);
  } else {
    for (const entry of entries) {
      const row = document.createElement('div');
      renderBidiLine(row, entry);
      fragment.appendChild(row);
    }
  }

  bidiReaderLines.replaceChildren(fragment);
  if (wasPinned) bidiReaderLines.scrollTop = bidiReaderLines.scrollHeight;
  else if (!restoreBidiReaderAnchor(anchor)) {
    const maxScrollTop = Math.max(0, bidiReaderLines.scrollHeight - bidiReaderLines.clientHeight);
    bidiReaderLines.scrollTop = Math.min(previousScrollTop, maxScrollTop);
  }
  bidiReaderPinnedToBottom = isBidiReaderNearBottom();
  if (terminalSearchQuery) updateReadableSearchMatches({ keepIndex: true });
}

function isBidiReaderHistoryMode() {
  return performance.now() < bidiReaderHistoryModeUntil;
}

function preferBidiReaderHistoryForScroll() {
  bidiReaderHistoryModeUntil = performance.now() + 3000;
}

function currentBidiReaderRenderState() {
  if (bidiReaderCaptureMode === 'history' && capturedReaderHistoryState.known) {
    const historyEntries = capturedReaderHistoryState.entries;
    const shouldMergeLiveScreen = capturedReaderHistoryNeedsLiveScreen
      || terminalOutputRevision > capturedReaderHistoryRevision;
    const liveEntries = shouldMergeLiveScreen
      ? normalizeReadableEntries(getReadableTerminalScreenEntries())
      : [];
    return {
      entries: liveEntries.length
        ? mergeCapturedReaderEntriesWithLiveTail(historyEntries, liveEntries)
        : historyEntries,
      source: 'capture',
    };
  }

  if (bidiReaderCaptureMode === 'screen') {
    const captureIsCurrent = capturedReaderScreenKnown
      && capturedReaderScreenRevision === terminalOutputRevision
      && terminalWriteDepth === 0;
    return captureIsCurrent
      ? { entries: capturedReaderScreenEntries, source: 'capture' }
      : { entries: normalizeReadableEntries(getReadableTerminalScreenEntries()), source: 'xterm' };
  }

  return { entries: normalizeReadableEntries(getReadableTerminalEntries()), source: 'xterm' };
}

function flushBidiReaderUpdate() {
  bidiReaderUpdatePending = false;
  bidiReaderUpdateTimer = null;
  lastBidiReaderRenderAt = performance.now();
  const renderState = currentBidiReaderRenderState();
  const keepScroll = bidiReaderCaptureMode === 'history'
    && (!bidiReaderPinnedToBottom || isBidiReaderHistoryMode());
  renderBidiReader(renderState.entries, { keepScroll, source: renderState.source });
}

function scheduleBidiReaderUpdate({ immediate = false } = {}) {
  if (!bidiReaderEnabled || bidiReaderUpdatePending) return;
  bidiReaderUpdatePending = true;
  const elapsed = performance.now() - lastBidiReaderRenderAt;
  const delay = immediate ? 0 : Math.max(0, BIDI_READER_RENDER_INTERVAL_MS - elapsed);
  bidiReaderUpdateTimer = window.setTimeout(() => requestAnimationFrame(flushBidiReaderUpdate), delay);
}

function scheduleBidiReaderCaptureAfterOutput() {
  if ((!bidiReaderEnabled && !tuiAutoEnabled) || !currentSessionId) return;
  if (bidiReaderCaptureSettleTimer) window.clearTimeout(bidiReaderCaptureSettleTimer);
  const sinceLastCapture = performance.now() - lastBidiReaderCaptureAt;
  const delay = Math.max(BIDI_CAPTURE_SETTLE_DELAY_MS, BIDI_CAPTURE_REFRESH_INTERVAL_MS - sinceLastCapture);
  bidiReaderCaptureSettleTimer = window.setTimeout(() => {
    bidiReaderCaptureSettleTimer = null;
    refreshBidiReaderFromCapture({ keepScroll: !bidiReaderPinnedToBottom }).catch(() => {});
  }, delay);
}

function handleTerminalWriteComplete() {
  if (!bidiReaderPinnedToBottom && capturedReaderHistoryState.known) {
    scheduleBidiReaderCaptureAfterOutput();
    return;
  }
  scheduleBidiReaderUpdate();
  scheduleBidiReaderCaptureAfterOutput();
}

async function refreshBidiReaderFromCapture({ keepScroll = false, preferCapture = false, preserveAwayFromBottom = false } = {}) {
  if (bidiReaderCaptureRefreshPending) {
    if (preferCapture || keepScroll || preserveAwayFromBottom) {
      bidiReaderCaptureRefreshQueued = {
        keepScroll: keepScroll || Boolean(bidiReaderCaptureRefreshQueued?.keepScroll),
        preferCapture: preferCapture || Boolean(bidiReaderCaptureRefreshQueued?.preferCapture),
        preserveAwayFromBottom: preserveAwayFromBottom || Boolean(bidiReaderCaptureRefreshQueued?.preserveAwayFromBottom),
      };
    }
    return;
  }
  if ((!bidiReaderEnabled && !tuiAutoEnabled) || !currentSessionId) {
    if (bidiReaderEnabled) renderBidiReader(getReadableTerminalEntries(), { keepScroll, preserveAwayFromBottom });
    return;
  }
  const requestSessionId = currentSessionId;
  const requestGeneration = sessionGeneration;
  const requestOutputRevision = terminalOutputRevision;
  const requestIsCurrent = () => requestSessionId === currentSessionId && requestGeneration === sessionGeneration;
  bidiReaderCaptureRefreshPending = true;
  lastBidiReaderCaptureAt = performance.now();
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(requestSessionId)}/capture?lines=5000&ansi=1`);
    if (!requestIsCurrent()) return;
    bidiReaderCaptureSuccessCount += 1;
    updateTuiModeFromCapture(payload);
    if (!bidiReaderEnabled) return;
    const capturedSnapshot = parseAnsiCaptureEntries(payload.text || '')
      .slice(-BIDI_READER_MAX_LINES);
    const captureIsHistory = !payload.usingAlternate || payload.captureReason === 'normal-rich-history';
    if (captureIsHistory) {
      capturedReaderHistoryState = reduceCapturedReaderHistory(capturedReaderHistoryState, capturedSnapshot);
      capturedReaderHistoryNeedsLiveScreen = payload.captureReason === 'normal-rich-history'
        && payload.alternateActive === true;
      bidiReaderCaptureMode = 'history';
      if (capturedReaderHistoryState.committed) capturedReaderHistoryRevision = requestOutputRevision;
      if (capturedReaderHistoryState.pendingReset) {
        bidiReaderCaptureRefreshQueued = {
          keepScroll: true,
          preferCapture: true,
          preserveAwayFromBottom,
        };
      }
    } else {
      capturedReaderScreenKnown = true;
      capturedReaderScreenEntries = capturedSnapshot;
      capturedReaderScreenRevision = requestOutputRevision;
      bidiReaderCaptureMode = 'screen';
    }

    const renderState = currentBidiReaderRenderState();
    renderBidiReader(renderState.entries, { keepScroll, source: renderState.source, preserveAwayFromBottom });
  } catch {
    if (!requestIsCurrent()) return;
    const renderState = currentBidiReaderRenderState();
    renderBidiReader(renderState.entries, { keepScroll, source: renderState.source, preserveAwayFromBottom });
  } finally {
    bidiReaderCaptureRefreshPending = false;
    if (bidiReaderCaptureRefreshQueued) {
      const queued = bidiReaderCaptureRefreshQueued;
      bidiReaderCaptureRefreshQueued = null;
      window.setTimeout(() => refreshBidiReaderFromCapture(queued).catch(() => {}), 0);
    }
  }
}

function sendResizeIfChanged(cols = term.cols || 120, rows = term.rows || 36) {
  if (terminalControlRole !== 'controller' || ws?.readyState !== WebSocket.OPEN) return;
  const key = `${cols}x${rows}`;
  if (key === lastSentTerminalSize) return;
  lastSentTerminalSize = key;
  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
}

function refitTerminal() {
  if (terminalFitRaf) return;
  terminalFitRaf = requestAnimationFrame(() => {
    terminalFitRaf = null;
    const anchor = captureBidiReaderAnchor();
    try { if (fitAddon) fitAddon.fit(); } catch {}
    if (!bidiReaderPinnedToBottom) restoreBidiReaderAnchor(anchor);
    sendResizeIfChanged();
  });
}

function applyPanelMode() {
  document.body.classList.add('terminal-native-mode');
  document.body.classList.toggle('blocks-open', blocksOpen);
  if (blocksToggleButton) {
    blocksToggleButton.textContent = blocksOpen ? 'Hide blocks' : 'Blocks';
    blocksToggleButton.setAttribute('aria-expanded', String(blocksOpen));
  }
  refitTerminal();
}

function setBlocksOpen(open) {
  blocksOpen = Boolean(open);
  localStorage.setItem('warpish_blocks_open', blocksOpen ? 'on' : 'off');
  applyPanelMode();
  if (blocksOpen) loadBlocks(currentSessionId, { force: true }).catch(() => {});
}

function isAutoTuiModeActive() {
  return tuiAutoEnabled && detectedTuiActive;
}

function isReadableSurfaceActive() {
  return bidiReaderEnabled && !isAutoTuiModeActive();
}

function effectiveReaderMouseMode() {
  return isAutoTuiModeActive() ? 'raw' : readerMouseMode;
}

function captureIndicatesStandaloneTui(payload = {}) {
  return payload.alternateActive === true
    && payload.usingAlternate === true
    && payload.captureReason === 'alternate-active';
}

function applyTuiModeUi() {
  const autoActive = isAutoTuiModeActive();
  document.body.classList.toggle('auto-tui-active', autoActive);
  if (tuiModeToggleButton) {
    tuiModeToggleButton.textContent = autoActive
      ? 'TUI: auto raw'
      : `TUI: ${tuiAutoEnabled ? 'auto' : 'manual'}`;
    tuiModeToggleButton.setAttribute('aria-pressed', String(tuiAutoEnabled));
    tuiModeToggleButton.setAttribute('aria-label', autoActive
      ? 'Automatic TUI mode is active. Use manual mode to restore your readable display and mouse preferences.'
      : tuiAutoEnabled
        ? 'Automatic TUI detection is enabled'
        : 'Automatic TUI detection is disabled; display and mouse modes are manual');
    tuiModeToggleButton.title = autoActive
      ? `Full-screen TUI detected${detectedTuiCaptureReason ? ` (${detectedTuiCaptureReason})` : ''}. Native display and raw mouse passthrough are active; click to override.`
      : tuiAutoEnabled
        ? 'Automatically use the native terminal display and raw mouse passthrough for detected full-screen TUI apps.'
        : 'Manual override is active. Click to restore automatic full-screen TUI detection.';
  }
  if (tuiModeStatus) {
    tuiModeStatus.hidden = !autoActive;
    tuiModeStatus.textContent = autoActive ? 'Full-screen TUI · raw display + mouse' : '';
  }
  terminalEl?.setAttribute('aria-label', autoActive
    ? 'Terminal display. Full-screen TUI detected; native display and raw mouse passthrough enabled automatically.'
    : 'Terminal display');
}

function applyBidiMode({ refresh = true } = {}) {
  const readableActive = isReadableSurfaceActive();
  document.body.classList.toggle('bidi-mode', readableActive);
  if (bidiToggleButton) {
    bidiToggleButton.textContent = isAutoTuiModeActive()
      ? 'Readable: auto raw'
      : `Readable: ${bidiReaderEnabled ? 'on' : 'off'}`;
    bidiToggleButton.setAttribute('aria-pressed', String(readableActive));
    bidiToggleButton.setAttribute('aria-label', isAutoTuiModeActive()
      ? 'Readable display is temporarily hidden by automatic TUI mode; click to override and show it'
      : `${bidiReaderEnabled ? 'Disable' : 'Enable'} the readable terminal display`);
  }
  if (bidiReader) bidiReader.setAttribute('aria-hidden', String(!readableActive));
  if (!bidiReaderEnabled) setBidiReaderHasContent(false);
  if (bidiReaderUpdateTimer) window.clearTimeout(bidiReaderUpdateTimer);
  if (bidiReaderCaptureSettleTimer) window.clearTimeout(bidiReaderCaptureSettleTimer);
  bidiReaderUpdatePending = false;
  bidiReaderUpdateTimer = null;
  bidiReaderCaptureSettleTimer = null;
  bidiReaderCaptureRefreshQueued = null;
  lastBidiReaderRenderKey = '';
  lastBidiReaderRenderSource = 'xterm';
  bidiReaderPinnedToBottom = true;
  if (refresh && (bidiReaderEnabled || tuiAutoEnabled)) {
    refreshBidiReaderFromCapture({ preferCapture: true })
      .catch(() => {
        if (bidiReaderEnabled) renderBidiReader(getReadableTerminalEntries(), { force: true });
      });
  }
  refitTerminal();
}

function applyReaderMouseMode() {
  const autoActive = isAutoTuiModeActive();
  const raw = effectiveReaderMouseMode() === 'raw';
  document.body.classList.toggle('reader-mouse-raw', raw);
  document.body.classList.toggle('reader-mouse-reader', !raw);
  if (mouseModeToggleButton) {
    mouseModeToggleButton.textContent = autoActive ? 'Mouse: auto raw' : `Mouse: ${raw ? 'raw' : 'reader'}`;
    mouseModeToggleButton.setAttribute('aria-pressed', String(raw));
    mouseModeToggleButton.setAttribute('aria-label', autoActive
      ? 'Raw mouse passthrough is temporarily enabled by automatic TUI mode; click to override with reader mouse mode'
      : raw ? 'Use raw terminal mouse mode' : 'Use readable terminal mouse mode');
    mouseModeToggleButton.title = autoActive
      ? 'Full-screen TUI detected. Mouse events pass through to xterm automatically; click to override.'
      : raw
      ? 'Mouse goes through the readable overlay to raw xterm/TUI apps; switch to reader for selection and links.'
      : 'Mouse selects/scrolls readable text and opens links; switch to raw for mouse-enabled TUI apps.';
  }
}

function applyTuiPresentation({ refreshReader = false } = {}) {
  applyTuiModeUi();
  applyReaderMouseMode();
  applyBidiMode({ refresh: refreshReader });
}

function updateTuiModeFromCapture(payload) {
  if (!tuiAutoEnabled) return;
  const active = captureIndicatesStandaloneTui(payload);
  const reason = active ? String(payload.captureReason || '') : '';
  if (active === detectedTuiActive && reason === detectedTuiCaptureReason) return;
  detectedTuiActive = active;
  detectedTuiCaptureReason = reason;
  applyTuiPresentation({ refreshReader: false });
}

function setTuiAutoEnabled(enabled) {
  tuiAutoEnabled = Boolean(enabled);
  localStorage.setItem('warpish_tui_auto_mode_v1', tuiAutoEnabled ? 'on' : 'off');
  if (!tuiAutoEnabled) {
    detectedTuiActive = false;
    detectedTuiCaptureReason = '';
  }
  applyTuiPresentation({ refreshReader: true });
}

function resetTuiDetection() {
  if (!detectedTuiActive && !detectedTuiCaptureReason) return;
  detectedTuiActive = false;
  detectedTuiCaptureReason = '';
  applyTuiPresentation({ refreshReader: false });
}

function setReaderMouseMode(mode) {
  readerMouseMode = mode === 'raw' ? 'raw' : 'reader';
  localStorage.setItem('warpish_reader_mouse_mode_v1', readerMouseMode);
  applyReaderMouseMode();
  focusTerminalSoon();
}

function preserveViewportAndReaderScroll(callback) {
  const pageX = window.scrollX;
  const pageY = window.scrollY;
  const readerScrollTop = bidiReaderLines?.scrollTop ?? null;
  try {
    callback();
  } finally {
    if (readerScrollTop !== null && bidiReaderLines && !bidiReaderPinnedToBottom) {
      bidiReaderLines.scrollTop = readerScrollTop;
    }
    if (window.scrollX !== pageX || window.scrollY !== pageY) {
      window.scrollTo(pageX, pageY);
    }
  }
}

function suppressTerminalFocusReports(durationMs = TERMINAL_FOCUS_REPORT_SUPPRESS_MS) {
  suppressTerminalFocusReportsUntil = Math.max(suppressTerminalFocusReportsUntil, performance.now() + durationMs);
}

function isTerminalFocusReport(data) {
  return data === '\x1b[I' || data === '\x1b[O';
}

function shouldStripTerminalFocusReports() {
  if (effectiveReaderMouseMode() !== 'raw') return true;
  return performance.now() <= suppressTerminalFocusReportsUntil;
}

function stripTerminalFocusReports(data) {
  if (!shouldStripTerminalFocusReports()) return data;
  return String(data || '').replace(/\x1b\[(?:I|O)/g, '');
}

function shouldSuppressTerminalInput(data) {
  return isTerminalFocusReport(data) && shouldStripTerminalFocusReports();
}

function clearTerminalFocusFollowups() {
  for (const timer of terminalFocusFollowupTimers) window.clearTimeout(timer);
  terminalFocusFollowupTimers = [];
}

function focusTerminalOnceWithoutScroll() {
  preserveViewportAndReaderScroll(() => {
    const helper = terminalHelperTextarea();
    if (helper?.focus) {
      try {
        helper.focus({ preventScroll: true });
        return;
      } catch {}
    }
    term.focus();
  });
}

function focusTerminalSoon() {
  suppressTerminalFocusReports();
  if (terminalFocusTimer) return;
  terminalFocusTimer = setTimeout(() => {
    terminalFocusTimer = null;
    focusTerminalReliably();
  }, 0);
}

function focusTerminalReliably() {
  suppressTerminalFocusReports();
  const serial = ++terminalFocusSerial;
  clearTerminalFocusFollowups();
  focusTerminalOnceWithoutScroll();
  requestAnimationFrame(() => {
    if (serial === terminalFocusSerial && !hasCompetingUserFocus()) focusTerminalOnceWithoutScroll();
  });
  for (const delayMs of [80, 240]) {
    const timer = setTimeout(() => {
      terminalFocusFollowupTimers = terminalFocusFollowupTimers.filter((item) => item !== timer);
      if (serial !== terminalFocusSerial || hasCompetingUserFocus()) return;
      suppressTerminalFocusReports();
      focusTerminalOnceWithoutScroll();
    }, delayMs);
    terminalFocusFollowupTimers.push(timer);
  }
}

function hasCompetingUserFocus() {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return false;
  if (active === terminalHelperTextarea() || terminalEl?.contains(active)) return false;
  return true;
}

function shouldPreserveControlFocus(event) {
  const target = event?.target;
  return Boolean(target?.closest?.('button, input, textarea, select, a, [contenteditable="true"]'));
}

function focusPreferredInput() {
  focusTerminalReliably();
}

function clearAutoRawInput() {
  // No-op kept for block-end messages; terminal input is always raw passthrough now.
}

function handleTerminalInput(data) {
  // Focus tracking can emit ESC[I / ESC[O merely because the reader hands
  // focus to xterm. Those protocol replies are not evidence that xterm
  // handled the user's key; counting them would suppress the key fallback.
  if (!isTerminalFocusReport(data)) terminalInputEventSerial += 1;
  if (terminalWriteDepth > 0 && terminalControlRole !== 'controller') return;
  if (shouldSuppressTerminalInput(data)) return;
  const filtered = stripTerminalFocusReports(data);
  if (!filtered) return;
  if (isTerminalFocusReport(filtered) && terminalControlRole !== 'controller') return;
  sendRaw(filtered, { sessionId: currentSessionId });
}

function handleTerminalBinaryInput(data) {
  terminalInputEventSerial += 1;
  if (terminalWriteDepth > 0 && terminalControlRole !== 'controller') return;
  sendBinary(data, { sessionId: currentSessionId });
}

const initialParams = new URLSearchParams(window.location.search);
const initialToken = initialParams.get('token');
if (initialToken) {
  window.history.replaceState({}, document.title, window.location.pathname);
}

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
  const isJson = contentType.includes('application/json');
  let payload = {};
  if (text && isJson) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = { error: `Invalid JSON response: ${error.message}` };
    }
  } else if (text) {
    payload = { error: text };
  }
  if (!response.ok) {
    const message = payload.error || payload.message || text || `HTTP ${response.status}`;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return payload;
}

async function api(path, options = {}) {
  const { timeoutMs = 15_000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortFromExternalSignal();
    else externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
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
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener?.('abort', abortFromExternalSignal);
  }
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

function setControlBusy(control, busy) {
  if (!control) return;
  if (busy) busyControls.add(control);
  else busyControls.delete(control);
  updateHeader();
}

function controlIsBusy(control) {
  return Boolean(control && busyControls.has(control));
}

function selectedSessionAcceptsInput(sessionId = currentSessionId) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  return Boolean(session?.alive
    && !session.privacyQuarantined
    && terminalControlRole !== 'history'
    && terminalControlRole !== 'quarantine');
}

function updateHeader() {
  const session = activeSession();
  if (!session) {
    sessionTitle.textContent = 'No terminal selected';
    sessionMeta.textContent = 'Create a new terminal or choose a live session from the sidebar.';
    terminalTitle.textContent = 'No session attached';
    for (const control of [renameSessionButton, copySelection, detachSessionButton, killSessionButton, splitVerticalButton, splitHorizontalButton, nextPaneButton, exportSessionButton]) {
      if (control) control.disabled = true;
    }
    return;
  }
  sessionTitle.textContent = session.title;
  sessionMeta.textContent = `${session.alive ? 'Live tmux session' : 'Stopped history'} • ${session.cwd || '~'} • ${session.profile || 'default'}${session.private ? ' • private' : ''}${session.privacyQuarantined ? ' • privacy quarantine' : ''} • ${formatRelative(session.lastOpenedAt || session.createdAt)}`;
  terminalTitle.textContent = activeTerminalTitle ? `${session.title} — ${activeTerminalTitle}` : session.title;
  terminalTitle.title = session.id;
  for (const control of [detachSessionButton, splitVerticalButton, splitHorizontalButton, nextPaneButton]) {
    if (control) control.disabled = controlIsBusy(control) || !session.alive || Boolean(session.privacyQuarantined);
  }
  if (exportSessionButton) exportSessionButton.disabled = controlIsBusy(exportSessionButton);
  if (renameSessionButton) renameSessionButton.disabled = controlIsBusy(renameSessionButton);
  if (copySelection) copySelection.disabled = controlIsBusy(copySelection);
  if (killSessionButton) {
    killSessionButton.disabled = controlIsBusy(killSessionButton);
    killSessionButton.textContent = session.alive ? 'Kill session' : 'Delete history';
    killSessionButton.title = session.alive ? 'Kill selected tmux session' : 'Permanently delete this stopped session history';
  }
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

function captureSessionListUiState() {
  const active = document.activeElement;
  const focusedCard = active && sessionList.contains(active) ? active.closest?.('.session-card') : null;
  return {
    scrollTop: sessionList.scrollTop,
    focusedSessionId: focusedCard?.dataset?.sessionId || '',
  };
}

function restoreSessionListUiState(state) {
  if (!state) return;
  sessionList.scrollTop = state.scrollTop;
  if (!state.focusedSessionId) return;
  const card = [...sessionList.querySelectorAll('.session-card')]
    .find((candidate) => candidate.dataset.sessionId === state.focusedSessionId && !candidate.disabled);
  if (!card) return;
  try { card.focus({ preventScroll: true }); } catch { card.focus(); }
  sessionList.scrollTop = state.scrollTop;
}

function renderSessions() {
  const uiState = captureSessionListUiState();
  sessionList.replaceChildren();
  updateSessionHistoryActions();
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No terminal history yet. Create a new terminal to start a resumable session.';
    sessionList.appendChild(empty);
    updateHeader();
    restoreSessionListUiState(uiState);
    return;
  }

  for (const session of sessions) {
    const button = document.createElement('button');
    button.className = `session-card ${session.id === currentSessionId ? 'active' : ''} ${session.alive ? '' : 'dead'}`;
    button.dataset.sessionId = session.id;
    if (session.id === currentSessionId) button.setAttribute('aria-current', 'true');

    const title = document.createElement('div');
    title.className = 'session-card-title';
    const titleText = document.createElement('span');
    titleText.textContent = session.title;
    const pill = document.createElement('span');
    pill.className = 'session-pill';
    pill.textContent = session.privacyQuarantined
      ? 'privacy quarantine'
      : session.private
      ? (session.alive ? 'private' : 'private stopped')
      : session.alive ? (session.attached ? `${session.attached} attached` : 'live') : 'stopped history';
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
    const previewText = compactText(session.preview
      || (session.privacyQuarantined
        ? 'attach blocked: pane has nonzero history capacity'
        : session.private
        ? 'private output is not retained'
        : session.alive ? 'fresh terminal — no output yet' : 'no saved preview'), SESSION_PREVIEW_CHARS);
    applyBidiText(preview, previewText);

    button.append(title, meta, preview);
    button.addEventListener('click', () => {
      if (session.alive) connectToSession(session.id);
      else selectStoppedSession(session.id);
    });
    sessionList.appendChild(button);
  }
  updateHeader();
  restoreSessionListUiState(uiState);
}

function captureBlockListUiState() {
  const active = document.activeElement;
  const focusedAction = active && blockList.contains(active) ? active.closest?.('[data-block-action]') : null;
  const focusedCard = focusedAction?.closest?.('.block-card');
  return {
    scrollTop: blockList.scrollTop,
    focusedBlockId: focusedCard?.dataset?.blockId || '',
    focusedAction: focusedAction?.dataset?.blockAction || '',
  };
}

function restoreBlockListUiState(state) {
  if (!state) return;
  blockList.scrollTop = state.scrollTop;
  if (!state.focusedBlockId || !state.focusedAction) return;
  const card = [...blockList.querySelectorAll('.block-card')]
    .find((candidate) => candidate.dataset.blockId === state.focusedBlockId);
  const action = card?.querySelector?.(`[data-block-action="${state.focusedAction}"]`);
  if (!action || action.disabled) return;
  try { action.focus({ preventScroll: true }); } catch { action.focus(); }
  blockList.scrollTop = state.scrollTop;
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

async function copyTextFromButton(button, text, successDetail) {
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(String(text || ''));
    setStatus('ok', 'copied', successDetail);
  } catch (error) {
    setStatus('bad', 'copy failed', error.message);
  } finally {
    button.disabled = false;
  }
}

function renderBlocks() {
  const uiState = captureBlockListUiState();
  const filtered = blocks.filter(blockMatchesFilter);
  blocksCount.textContent = `${filtered.length}${filtered.length === blocks.length ? '' : ` / ${blocks.length}`} block${blocks.length === 1 ? '' : 's'}`;
  if (!blocksOpen) {
    blockList.replaceChildren();
    restoreBlockListUiState(uiState);
    return;
  }

  blockList.replaceChildren();

  if (!currentSessionId) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select a session to see command blocks.';
    blockList.appendChild(empty);
    restoreBlockListUiState(uiState);
    return;
  }

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = activeSession()?.private
      ? 'Private session: command blocks and output history are not retained.'
      : blocks.length
      ? 'No blocks match this search.'
      : 'No command blocks yet. New sessions record commands with shell integration; run a command to create the first block.';
    blockList.appendChild(empty);
    restoreBlockListUiState(uiState);
    return;
  }

  const visibleBlocks = filtered.slice(0, BLOCK_RENDER_LIMIT);
  for (const block of visibleBlocks) {
    const card = document.createElement('article');
    card.className = `block-card ${block.status || 'unknown'}`;
    card.dataset.blockId = String(block.id || '');

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
    rerun.dataset.blockAction = 'rerun';
    rerun.disabled = !block.command || !activeSession()?.alive;
    rerun.addEventListener('click', () => {
      sendRaw(`${block.command}\r`);
      focusPreferredInput();
    });
    const copyCommand = document.createElement('button');
    copyCommand.textContent = 'Copy cmd';
    copyCommand.dataset.blockAction = 'copy-command';
    copyCommand.addEventListener('click', () => copyTextFromButton(copyCommand, block.command || '', 'command copied'));
    const copyOutput = document.createElement('button');
    copyOutput.textContent = 'Copy output';
    copyOutput.dataset.blockAction = 'copy-output';
    copyOutput.addEventListener('click', () => copyTextFromButton(copyOutput, block.output || '', 'output copied'));
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
  restoreBlockListUiState(uiState);
}

async function loadBlocks(sessionId = currentSessionId, { force = false } = {}) {
  const requestSerial = ++blocksRequestSerial;
  const requestGeneration = sessionGeneration;
  if (!sessionId) {
    blocks = [];
    renderBlocks();
    return;
  }
  if (!blocksOpen && !force) {
    renderBlocks();
    return;
  }
  const payload = await api(`/api/sessions/${encodeURIComponent(sessionId)}/blocks`);
  if (requestSerial !== blocksRequestSerial || requestGeneration !== sessionGeneration || sessionId !== currentSessionId) return;
  blocks = payload.blocks || [];
  renderBlocks();
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

function resetTerminalSurface() {
  blocks = [];
  resetTuiDetection();
  resetCapturedReaderState();
  lastBidiReaderCaptureAt = 0;
  bidiReaderCaptureSuccessCount = 0;
  terminalOutputRevision = 0;
  lastBidiReaderRenderSource = 'xterm';
  renderBlocks();
  term.reset();
  lastBidiReaderRenderKey = '';
  bidiReaderPinnedToBottom = true;
  scheduleBidiReaderUpdate({ immediate: true });
}

function safeHistoricalPreview(text = '') {
  return String(text || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '')
    .replace(/\r\n?/gu, '\n');
}

function selectStoppedSession(sessionId) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session || session.alive) return;
  clearReconnectTimer();
  connectionSerial += 1;
  sessionGeneration += 1;
  blocksRequestSerial += 1;
  terminalFocusSerial += 1;
  clearTerminalFocusFollowups();
  const previousSessionId = currentSessionId;
  disconnectCurrent({ quiet: true });
  if (previousSessionId) discardPendingTerminalInputs(previousSessionId);
  discardPendingTerminalInputs(sessionId);
  currentSessionId = sessionId;
  terminalControlRole = 'history';
  if (terminalCard) terminalCard.dataset.controlRole = terminalControlRole;
  controlClaimPending = false;
  activeTerminalTitle = '';
  resetTerminalSurface();
  renderSessions();
  if (blocksOpen) loadBlocks(sessionId, { force: true }).catch(() => {});
  const preview = safeHistoricalPreview(session.preview || '');
  term.writeln('\x1b[2mStopped session history (read-only)\x1b[0m');
  if (preview) term.write(preview.replace(/\n/gu, '\r\n'));
  else term.writeln('\r\nNo retained terminal preview. Open Blocks to inspect saved commands.');
  setStatus('warn', 'stopped history', `${session.title} • read-only`);
  scheduleBidiReaderUpdate({ immediate: true });
}

function selectQuarantinedSession(sessionId) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.alive || !session.privacyQuarantined) return;
  clearReconnectTimer();
  connectionSerial += 1;
  sessionGeneration += 1;
  blocksRequestSerial += 1;
  terminalFocusSerial += 1;
  clearTerminalFocusFollowups();
  const previousSessionId = currentSessionId;
  disconnectCurrent({ quiet: true });
  if (previousSessionId) discardPendingTerminalInputs(previousSessionId);
  discardPendingTerminalInputs(sessionId);
  currentSessionId = sessionId;
  terminalControlRole = 'quarantine';
  if (terminalCard) terminalCard.dataset.controlRole = terminalControlRole;
  controlClaimPending = false;
  activeTerminalTitle = '';
  resetTerminalSurface();
  renderSessions();
  term.writeln('\x1b[31mPrivate session quarantined\x1b[0m');
  term.writeln('\r\nThis tmux pane was created with nonzero history capacity. Warpish will not attach, capture, or send input to it. Kill it here or continue it directly in tmux.');
  setStatus('bad', 'privacy quarantine', `${session.title} • attach blocked`);
  scheduleBidiReaderUpdate({ immediate: true });
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
    const payload = await api('/api/sessions', { timeoutMs: 10_000 });
    if (requestSerial !== sessionsRequestSerial || sessionsMutationDepth > 0) return;
    sessions = payload.sessions || [];
    const liveSessions = sessions.filter((session) => session.alive);

    if (createIfEmpty && liveSessions.length === 0) {
      const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}), timeoutMs: 20_000 });
      if (requestSerial !== sessionsRequestSerial || sessionsMutationDepth > 0) return;
      sessions = created.sessions || [created.session];
      selectId = created.session.id;
    }

    renderSessions();

    const targetId = selectId
      || (currentSessionId && sessions.some((session) => session.id === currentSessionId) ? currentSessionId : null)
      || sessions.find((session) => session.alive)?.id
      || sessions[0]?.id;
    const target = sessions.find((session) => session.id === targetId);

    if (target?.privacyQuarantined && (targetId !== currentSessionId || terminalControlRole !== 'quarantine' || ws)) selectQuarantinedSession(targetId);
    else if (target?.alive && (targetId !== currentSessionId || terminalControlRole === 'quarantine')) connectToSession(targetId);
    else if (target && !target.alive && (targetId !== currentSessionId || terminalControlRole !== 'history' || ws)) selectStoppedSession(targetId);
    else if (targetId && blocksOpen) loadBlocks(targetId, { force: true }).catch(() => {});
    if (!targetId) {
      clearReconnectTimer();
      if (currentSessionId) {
        disconnectCurrent({ quiet: true });
        currentSessionId = null;
        sessionGeneration += 1;
        blocksRequestSerial += 1;
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
  if (!window.confirm(`Clear ${stoppedCount} stopped session${stoppedCount === 1 ? '' : 's'} from history? Live tmux sessions stay running.`)) return;
  clearStoppedSessionsButton.disabled = true;
  beginSessionsMutation();
  try {
    const payload = await api('/api/sessions?stopped=1', { method: 'DELETE', timeoutMs: 20_000 });
    sessions = payload.sessions || [];
    if (currentSessionId && !sessions.some((session) => session.id === currentSessionId && session.alive)) {
      disconnectCurrent({ quiet: true });
      currentSessionId = null;
      sessionGeneration += 1;
      blocksRequestSerial += 1;
      resetTerminalSurface();
    }
    renderSessions();
    setStatus('ok', 'history cleaned', `${payload.purged?.length || stoppedCount} stopped removed`);
    const target = currentSessionId || sessions.find((session) => session.alive)?.id;
    if (target && target !== currentSessionId) connectToSession(target);
  } catch (error) {
    setStatus('bad', 'clear failed', error.message);
  } finally {
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
    if (quiet) intentionallyClosedSockets.add(socket);
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'detach' })); } catch {}
    }
    try { socket.close(); } catch {}
  }
  if (ws === socket) ws = null;
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
  setStatus('warn', 'reconnecting…', `retrying in ${Math.max(1, Math.ceil(delay / 1000))}s`);
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
  return item.kind === 'binary' ? String(item.data || '').length : new TextEncoder().encode(String(item.data || '')).byteLength;
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
  const chunks = splitTerminalInput({ kind, data: String(data || ''), directTmux, sessionId });
  if (!chunks.length) return true;
  const incomingBytes = chunks.reduce((total, item) => total + terminalInputByteLength(item), 0);
  if (pendingInputBytes(sessionId) + incomingBytes > MAX_PENDING_TERMINAL_INPUT_BYTES) {
    setStatus('bad', 'input queue full', 'wait for the terminal to connect before sending more input');
    return false;
  }

  for (const chunk of chunks) {
    const item = { ...chunk, directTmux: Boolean(chunk.directTmux), sessionId };
    const last = pendingTerminalInputs.at(-1);
    const canMerge = last
      && last.sessionId === sessionId
      && last.kind === item.kind
      && last.directTmux === item.directTmux
      && terminalInputByteLength({ ...last, data: last.data + item.data }) <= MAX_TERMINAL_INPUT_MESSAGE_BYTES;
    if (canMerge) last.data += item.data;
    else pendingTerminalInputs.push(item);
  }
  return true;
}

function binaryStringToBase64(data) {
  return window.btoa(String(data || ''));
}

function sendTerminalInputOverSocket(socket, item) {
  if (!socket || socket.readyState !== WebSocket.OPEN || terminalControlRole !== 'controller') return false;
  try {
    if (item.kind === 'binary') {
      socket.send(JSON.stringify({ type: 'input-binary', data: binaryStringToBase64(item.data) }));
    } else {
      const allowFocusReports = effectiveReaderMouseMode() === 'raw' && performance.now() > suppressTerminalFocusReportsUntil;
      socket.send(JSON.stringify({ type: 'input', data: item.data, directTmux: item.directTmux, allowFocusReports }));
    }
    return true;
  } catch {
    return false;
  }
}

function schedulePendingTerminalInputFlush(socket, sessionId) {
  if (terminalInputFlushTimer || !socket || socket.readyState !== WebSocket.OPEN) return;
  terminalInputFlushTimer = window.setTimeout(() => {
    terminalInputFlushTimer = null;
    if (socket === ws && sessionId === currentSessionId) flushPendingTerminalInputs(socket, sessionId);
  }, 25);
}

function flushPendingTerminalInputs(socket, sessionId) {
  if (terminalControlRole !== 'controller') return;
  const remaining = [];
  let socketBackpressured = false;
  for (const item of pendingTerminalInputs) {
    if (item.sessionId !== sessionId) {
      remaining.push(item);
      continue;
    }
    if (socketBackpressured
      || sessionId !== currentSessionId
      || ws !== socket
      || socket?.bufferedAmount > MAX_BROWSER_SOCKET_BUFFERED_BYTES
      || !sendTerminalInputOverSocket(socket, item)) {
      remaining.push(item);
      socketBackpressured = true;
    }
  }
  pendingTerminalInputs = remaining;
  if (pendingTerminalInputs.some((item) => item.sessionId === sessionId)) {
    schedulePendingTerminalInputFlush(socket, sessionId);
  }
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
    setStatus('warn', 'taking control…', 'waiting for this tab to become the terminal controller');
  } catch {
    controlClaimPending = false;
  }
}

function applyTerminalControlRole(role, sessionTitle = activeSession()?.title || 'terminal') {
  terminalControlRole = role === 'controller' ? 'controller' : 'spectator';
  controlClaimPending = false;
  if (terminalCard) terminalCard.dataset.controlRole = terminalControlRole;
  if (terminalControlRole === 'controller') {
    lastSentTerminalSize = '';
    const { cols, rows } = currentDims();
    sendResizeIfChanged(cols, rows);
    flushPendingTerminalInputs(ws, currentSessionId);
    setStatus('ok', 'connected', `${sessionTitle} • this tab has control`);
  } else {
    setStatus('warn', 'view only', `${sessionTitle} • type or click the terminal to take control`);
    if (pendingInputBytes(currentSessionId) > 0) claimTerminalControl();
  }
}

function writeTerminalOutput(data) {
  terminalOutputRevision += 1;
  terminalWriteDepth += 1;
  try {
    term.write(data, () => {
      terminalWriteDepth = Math.max(0, terminalWriteDepth - 1);
      handleTerminalWriteComplete();
    });
  } catch (error) {
    terminalWriteDepth = Math.max(0, terminalWriteDepth - 1);
    throw error;
  }
}

function refreshReadableFromTmuxSoon(delay = 250, preferCapture = false) {
  if ((!bidiReaderEnabled && !tuiAutoEnabled) || !currentSessionId) return;
  setTimeout(() => {
    if ((!bidiReaderEnabled && !tuiAutoEnabled) || !currentSessionId) return;
    refreshBidiReaderFromCapture({ preferCapture }).catch(() => {
      if (bidiReaderEnabled) renderBidiReader(getReadableTerminalEntries(), { force: true });
    });
  }, delay);
}

function connectToSession(sessionId, { reconnecting = false } = {}) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.alive) return;
  if (session.privacyQuarantined) {
    selectQuarantinedSession(sessionId);
    return;
  }

  clearReconnectTimer({ resetAttempts: !reconnecting });
  connectionSerial += 1;
  const serial = connectionSerial;
  sessionGeneration += 1;
  blocksRequestSerial += 1;
  pendingTerminalInputs = pendingTerminalInputs.filter((item) => item.sessionId === sessionId);
  suppressTerminalFocusReports();
  terminalFocusSerial += 1;
  clearTerminalFocusFollowups();
  disconnectCurrent({ quiet: true });
  currentSessionId = sessionId;
  activeTerminalTitle = '';
  resetTuiDetection();
  terminalControlRole = 'pending';
  controlClaimPending = false;
  lastSentTerminalSize = '';
  resetCapturedReaderState();
  lastBidiReaderCaptureAt = 0;
  bidiReaderCaptureSuccessCount = 0;
  terminalOutputRevision = 0;
  bidiReaderCaptureRefreshQueued = null;
  lastBidiReaderRenderSource = 'xterm';
  blocks = [];
  renderSessions();
  renderBlocks();
  if (blocksOpen) loadBlocks(sessionId, { force: true }).catch(() => {});
  term.reset();
  lastBidiReaderRenderKey = '';
  bidiReaderPinnedToBottom = true;
  scheduleBidiReaderUpdate({ immediate: true });
  refreshReadableFromTmuxSoon(350, true);
  focusTerminalSoon();
  setStatus('warn', 'attaching…', session.title);

  const socket = new WebSocket(socketUrl(sessionId));
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.addEventListener('open', () => {
    if (serial !== connectionSerial || ws !== socket) return;
    reconnectAttempts = 0;
    setStatus('warn', 'connected', `${session.title} • negotiating control`);
    refreshReadableFromTmuxSoon(200, true);
    focusPreferredInput();
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
      if (terminalControlRole === 'pending') {
        setStatus('warn', 'connected', `tmux ${msg.sessionId} • negotiating control`);
      } else {
        applyTerminalControlRole(terminalControlRole, session.title);
      }
      refreshReadableFromTmuxSoon(200, true);
    } else if (msg.type === 'role') {
      applyTerminalControlRole(msg.role, session.title);
    } else if (msg.type === 'server-error') {
      setStatus('bad', 'error', msg.message || 'server error');
      term.writeln(`\r\n\x1b[31m${msg.message || 'server error'}\x1b[0m`);
      scheduleBidiReaderUpdate();
    } else if (msg.type === 'detached') {
      if (!intentionallyClosedSockets.has(socket)) setStatus('bad', 'detached', 'session still exists in sidebar');
    } else if (msg.type === 'session-meta' && msg.sessionId === sessionId) {
      const liveSession = sessions.find((candidate) => candidate.id === sessionId);
      if (liveSession && typeof msg.cwd === 'string') liveSession.cwd = msg.cwd;
      renderSessions();
    } else if (['block-start', 'block-update', 'block-end'].includes(msg.type)) {
      upsertBlock(msg.block);
      if (msg.type === 'block-end') clearAutoRawInput('block-end');
    }
  });

  socket.addEventListener('close', () => {
    const intentionalClose = intentionallyClosedSockets.has(socket);
    intentionallyClosedSockets.delete(socket);
    if (serial !== connectionSerial) return;
    if (ws === socket) ws = null;
    if (intentionalClose) {
      setStatus('warn', 'detached', 'tmux session kept alive');
    } else {
      scheduleReconnect(sessionId);
    }
    setTimeout(() => {
      refreshSessions().catch(() => {});
    }, 300);
  });

  socket.addEventListener('error', () => {
    if (serial !== connectionSerial || ws !== socket) return;
    setStatus('bad', 'connection error', 'server/token/session problem');
  });
}

function sendRaw(data, { directTmux = false, sessionId = currentSessionId } = {}) {
  if (!sessionId) {
    term.writeln('\r\n\x1b[31mNo session selected. Create or select a terminal first.\x1b[0m');
    scheduleBidiReaderUpdate();
    return;
  }
  if (sessionId !== currentSessionId) return;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!selectedSessionAcceptsInput(sessionId)) {
    setStatus('warn', 'read only', session?.privacyQuarantined
      ? 'this private session is quarantined and cannot accept input'
      : 'stopped session history does not accept terminal input');
    return;
  }
  const item = { kind: 'text', data: String(data || ''), directTmux: Boolean(directTmux), sessionId };
  if (!queueTerminalInput(item)) return;
  if (ws?.readyState === WebSocket.OPEN) {
    if (terminalControlRole === 'controller') flushPendingTerminalInputs(ws, sessionId);
    else claimTerminalControl();
    return;
  }
  if (ws?.readyState === WebSocket.CONNECTING) {
    setStatus('warn', 'attaching…', `${pendingInputBytes(sessionId)} input bytes queued`);
    return;
  }
  connectToSession(sessionId);
}

function sendBinary(data, { sessionId = currentSessionId } = {}) {
  if (!sessionId || sessionId !== currentSessionId) return;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!selectedSessionAcceptsInput(sessionId)) {
    setStatus('warn', 'read only', session?.privacyQuarantined
      ? 'this private session is quarantined and cannot accept input'
      : 'stopped session history does not accept terminal input');
    return;
  }
  const item = { kind: 'binary', data: String(data || ''), directTmux: false, sessionId };
  if (!item.data) return;
  if (!queueTerminalInput(item)) return;
  if (ws?.readyState === WebSocket.OPEN) {
    if (terminalControlRole === 'controller') flushPendingTerminalInputs(ws, sessionId);
    else claimTerminalControl();
    return;
  }
  if (ws?.readyState === WebSocket.CONNECTING) {
    setStatus('warn', 'attaching…', `${pendingInputBytes(sessionId)} input bytes queued`);
    return;
  }
  connectToSession(sessionId);
}

function selectedReadableText() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !bidiReaderLines) return '';
  const text = selection.toString().replace(/▌/gu, '');
  if (!text) return '';
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const node = range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer?.parentElement;
    if (node && bidiReaderLines.contains(node)) return text;
  }
  return '';
}

async function copyTerminalSelection() {
  const text = term.getSelection() || selectedReadableText();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('ok', 'copied', text.length > 80 ? `${text.length} chars` : 'selection copied');
}

function isXtermHelperTarget(target) {
  return Boolean(target?.classList?.contains('xterm-helper-textarea'));
}

function isTerminalKeyTarget(event) {
  const target = event?.target;
  if (!target || !terminalCard?.contains(target)) return false;
  if (isXtermHelperTarget(target)) return true;
  return !target.closest?.('button, input, textarea, select, a, [contenteditable="true"]');
}

function forwardReaderKeyToXterm(event) {
  const helper = terminalHelperTextarea();
  if (!helper) return false;
  const inputSerialBefore = terminalInputEventSerial;
  try { helper.focus({ preventScroll: true }); } catch { helper.focus(); }
  const forwarded = new KeyboardEvent('keydown', {
    key: event.key,
    code: event.code,
    location: event.location,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  try {
    Object.defineProperty(forwarded, 'keyCode', { get: () => event.keyCode });
    Object.defineProperty(forwarded, 'which', { get: () => event.which });
  } catch {}
  helper.dispatchEvent(forwarded);
  return terminalInputEventSerial !== inputSerialBefore;
}

function handleReadableTerminalKeydown(event) {
  if (!isReadableSurfaceActive() || !isTerminalKeyTarget(event)) return;
  if (isXtermHelperTarget(event.target) || event.isComposing || event.metaKey) return;
  if (event.ctrlKey && event.shiftKey && ['c', 'v'].includes(event.key.toLowerCase())) return;
  event.preventDefault();
  event.stopPropagation();
  suppressTerminalFocusReports();
  if (forwardReaderKeyToXterm(event)) return;
  const data = window.WarpishTerminalKeys?.terminalKeyData(event, term.modes);
  if (data) term.input(data, true);
}

function prepareTerminalPasteText(rawText, { bracketedPasteMode = false, multilineMode = 'single-line' } = {}) {
  return window.WarpishPasteSafety.prepareTerminalPasteText(rawText, { bracketedPasteMode, multilineMode });
}

function insertPreparedPaste(prepared) {
  focusTerminalOnceWithoutScroll();
  if (prepared.text) term.paste(prepared.text);
  const lineDetail = prepared.internalLineBreaks
    ? `${prepared.internalLineBreaks + 1} lines • ${prepared.multilineMode === 'preserve' ? 'line breaks preserved' : 'joined safely'}`
    : 'text inserted safely';
  setStatus(prepared.multilineMode === 'preserve' && prepared.internalLineBreaks ? 'warn' : 'ok',
    prepared.multilineMode === 'preserve' ? 'multiline paste inserted' : 'pasted — press Enter to run',
    lineDetail);
}

function handleTerminalPaste(event) {
  if (!isTerminalKeyTarget(event)) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  if (!selectedSessionAcceptsInput()) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    setStatus('warn', 'read only', activeSession()?.privacyQuarantined
      ? 'this private session is quarantined and cannot accept input'
      : 'stopped session history does not accept terminal input');
    return;
  }
  const prepared = prepareTerminalPasteText(text, {
    bracketedPasteMode: Boolean(term.modes?.bracketedPasteMode),
  });
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (prepared.requiresChoice && pasteDialog?.showModal) {
    pendingMultilinePaste = { text, bracketedPasteMode: false, sessionId: currentSessionId };
    pastePreview.textContent = window.WarpishPasteSafety.formatMultilinePastePreview(text, 2400);
    pasteDialog.returnValue = 'cancel';
    pasteDialog.showModal();
    return;
  }
  insertPreparedPaste(prepared);
}

term.onData((data) => handleTerminalInput(data));
term.onBinary((data) => handleTerminalBinaryInput(data));
term.onResize(({ cols, rows }) => {
  sendResizeIfChanged(cols, rows);
});
term.onTitleChange((title) => {
  activeTerminalTitle = String(title || '').trim().slice(0, 160);
  updateHeader();
});
term.onBell(() => {
  if (!terminalPreferences.notifications || !document.hidden || window.Notification?.permission !== 'granted') return;
  try {
    new Notification(activeSession()?.title || 'Warpish Terminal', {
      body: activeTerminalTitle || 'Terminal bell',
      tag: `warpish-bell-${currentSessionId || 'terminal'}`,
    });
  } catch {}
});

const resizeObserver = new ResizeObserver(() => {
  refitTerminal();
});
function shouldOpenReaderOnTrappedScroll() {
  return !isAutoTuiModeActive()
    && bidiReaderCaptureMode === 'history'
    && capturedReaderHistoryState.known;
}

function handleBidiReaderScroll() {
  bidiReaderPinnedToBottom = isBidiReaderNearBottom();
  if (!isReadableSurfaceActive() || !currentSessionId) return;
  preferBidiReaderHistoryForScroll();
  if (bidiReaderCaptureForScrollPending) return;
  if (performance.now() - lastBidiReaderCaptureAt <= BIDI_CAPTURE_REFRESH_INTERVAL_MS) return;
  refreshBidiReaderForScroll(0).catch(() => {});
}

async function refreshBidiReaderForScroll(deltaY) {
  if (bidiReaderCaptureForScrollPending || !currentSessionId || !bidiReaderLines) return;
  bidiReaderCaptureForScrollPending = true;
  preferBidiReaderHistoryForScroll();
  const wasNearBottom = isBidiReaderNearBottom();
  const scrollTopAtStart = bidiReaderLines.scrollTop;
  try {
    await refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true, preserveAwayFromBottom: deltaY < 0 });
    preferBidiReaderHistoryForScroll();
    const userMovedDuringCapture = Math.abs(bidiReaderLines.scrollTop - scrollTopAtStart) > 2;
    if (!userMovedDuringCapture && wasNearBottom && deltaY < 0) {
      bidiReaderLines.scrollTop = Math.max(0, bidiReaderLines.scrollHeight - bidiReaderLines.clientHeight + deltaY);
    }
    bidiReaderPinnedToBottom = isBidiReaderNearBottom();
  } finally {
    bidiReaderCaptureForScrollPending = false;
  }
}

function handleBidiReaderWheel(event) {
  if (!isReadableSurfaceActive() || !bidiReaderLines) return;
  if (effectiveReaderMouseMode() === 'raw') return;
  event.preventDefault();
  event.stopPropagation();
  const needsTmuxHistory = event.deltaY !== 0;
  if (needsTmuxHistory) refreshBidiReaderForScroll(event.deltaY).catch(() => {});
  bidiReaderLines.scrollTop += event.deltaY;
  bidiReaderPinnedToBottom = isBidiReaderNearBottom();
}

resizeObserver.observe(terminalEl);
terminalEl.addEventListener('pointerdown', () => {
  claimTerminalControl();
  focusTerminalSoon();
});
terminalCard?.addEventListener('pointerdown', (event) => {
  if (effectiveReaderMouseMode() === 'reader' && event.target?.closest?.('#bidiReader')) return;
  if (!shouldPreserveControlFocus(event)) focusTerminalSoon();
});
terminalCard?.addEventListener('click', (event) => {
  if (readerSelectionIsActive()) return;
  if (!shouldPreserveControlFocus(event)) focusPreferredInput();
});
terminalCard?.addEventListener('keydown', handleReadableTerminalKeydown, { capture: true });
terminalCard?.addEventListener('paste', handleTerminalPaste, { capture: true });
bidiReaderLines?.addEventListener('scroll', handleBidiReaderScroll, { passive: true });
document.addEventListener('selectionchange', () => {
  if (!readerSelectionIsActive() && isReadableSurfaceActive()) scheduleBidiReaderUpdate({ immediate: true });
});
bidiReader?.addEventListener('wheel', handleBidiReaderWheel, { capture: true, passive: false });
bidiReaderLines?.addEventListener('wheel', handleBidiReaderWheel, { capture: true, passive: false });
terminalEl.addEventListener('wheel', (event) => {
  if (event.ctrlKey) return;
  if (effectiveReaderMouseMode() === 'raw' && term.modes?.mouseTrackingMode !== 'none') return;
  event.stopPropagation();
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
      refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true }).catch(() => renderBidiReader());
    }
  }
  event.preventDefault();
}, { capture: true, passive: false });

newSessionButton.addEventListener('click', () => {
  newSessionTitleInput.value = '';
  newSessionCwdInput.value = terminalPreferences.defaultCwd || '';
  newSessionProfileInput.value = terminalPreferences.defaultProfile || 'default';
  newSessionPrivateInput.checked = Boolean(terminalPreferences.privateByDefault);
  if (newSessionError) {
    newSessionError.hidden = true;
    newSessionError.textContent = '';
  }
  newSessionDialog?.showModal?.();
  window.setTimeout(() => newSessionTitleInput?.focus(), 0);
});

newSessionForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const selectedAtRequestStart = currentSessionId;
  const submitButton = event.submitter;
  if (submitButton) submitButton.disabled = true;
  beginSessionsMutation();
  try {
    if (newSessionError) {
      newSessionError.hidden = true;
      newSessionError.textContent = '';
    }
    const request = {
      title: newSessionTitleInput.value.trim() || undefined,
      cwd: newSessionCwdInput.value.trim() || undefined,
      profile: newSessionProfileInput.value.trim() || 'default',
      private: newSessionPrivateInput.checked,
    };
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify(request), timeoutMs: 20_000 });
    sessions = created.sessions || [created.session];
    newSessionDialog.close('created');
    renderSessions();
    if (!currentSessionId || currentSessionId === selectedAtRequestStart) connectToSession(created.session.id);
  } catch (error) {
    setStatus('bad', 'create failed', error.message);
    if (newSessionError) {
      newSessionError.textContent = error.message;
      newSessionError.hidden = false;
    }
  } finally {
    endSessionsMutation();
    if (submitButton) submitButton.disabled = false;
  }
});

for (const cancelButton of document.querySelectorAll('[data-dialog-cancel]')) {
  cancelButton.addEventListener('click', () => cancelButton.closest('dialog')?.close?.('cancel'));
}

settingsToggleButton?.addEventListener('click', openSettingsDialog);
settingsResetButton?.addEventListener('click', () => populateSettingsForm(terminalPreferencesApi?.DEFAULTS || terminalPreferences));
settingsForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = terminalPreferencesApi?.save?.(settingsFromForm()) || settingsFromForm();
  if (next.notifications && window.Notification?.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  applyTerminalPreferences(next);
  settingsDialog.close('applied');
  setStatus('ok', 'settings saved', `${next.theme} • ${next.fontSize}px • ${next.scrollback.toLocaleString()} lines`);
});

terminalSearchToggleButton?.addEventListener('click', () => setTerminalSearchOpen(terminalSearchPanel?.hidden !== false));
terminalSearchClose?.addEventListener('click', () => setTerminalSearchOpen(false));
terminalSearchPrevious?.addEventListener('click', () => runTerminalSearch('previous'));
terminalSearchNext?.addEventListener('click', () => runTerminalSearch('next'));
terminalSearchInput?.addEventListener('input', () => runTerminalSearch('next', { incremental: true }));
terminalSearchInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runTerminalSearch(event.shiftKey ? 'previous' : 'next');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    setTerminalSearchOpen(false);
  }
});

pasteDialog?.addEventListener('close', () => {
  const pending = pendingMultilinePaste;
  pendingMultilinePaste = null;
  if (!pending || !['single-line', 'preserve'].includes(pasteDialog.returnValue)) {
    focusTerminalSoon();
    return;
  }
  if (!pending.sessionId
    || pending.sessionId !== currentSessionId
    || !sessions.find((session) => session.id === pending.sessionId)?.alive) {
    setStatus('warn', 'paste cancelled', 'the selected terminal changed while the paste dialog was open');
    focusTerminalSoon();
    return;
  }
  const prepared = prepareTerminalPasteText(pending.text, {
    bracketedPasteMode: pending.bracketedPasteMode,
    multilineMode: pasteDialog.returnValue,
  });
  insertPreparedPaste(prepared);
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
  const title = window.prompt('Rename terminal session:', session.title)?.trim();
  if (!title || title === session.title) return;
  setControlBusy(renameSessionButton, true);
  beginSessionsMutation();
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    sessions = payload.sessions || sessions;
    renderSessions();
    setStatus('ok', 'renamed', title);
  } catch (error) {
    setStatus('bad', 'rename failed', error.message);
  } finally {
    endSessionsMutation();
    setControlBusy(renameSessionButton, false);
  }
});

copySelection.addEventListener('click', async () => {
  setControlBusy(copySelection, true);
  try {
    await copyTerminalSelection();
  } catch (error) {
    setStatus('bad', 'copy failed', error.message);
  } finally {
    setControlBusy(copySelection, false);
  }
});

exportSessionButton?.addEventListener('click', async () => {
  const session = activeSession();
  if (!session) return;
  setControlBusy(exportSessionButton, true);
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}/export`, { timeoutMs: 20_000 });
    const blob = new Blob([String(payload.text || '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = payload.filename || `${session.title || session.id}.txt`;
    const filename = anchor.download;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus('ok', 'exported', filename);
  } catch (error) {
    setStatus('bad', 'export failed', error.message);
  } finally {
    setControlBusy(exportSessionButton, false);
  }
});

async function runPaneAction(path, button, successText, body = {}) {
  const session = activeSession();
  if (!session?.alive) return;
  setControlBusy(button, true);
  try {
    await api(path, { method: 'POST', body: JSON.stringify(body), timeoutMs: 15_000 });
    setStatus('ok', successText, session.title);
    refreshReadableFromTmuxSoon(150, true);
    focusTerminalSoon();
  } catch (error) {
    setStatus('bad', 'pane action failed', error.message);
  } finally {
    setControlBusy(button, false);
  }
}

splitVerticalButton?.addEventListener('click', () => {
  const session = activeSession();
  if (!session) return;
  runPaneAction(`/api/sessions/${encodeURIComponent(session.id)}/panes`, splitVerticalButton, 'pane split left/right', { direction: 'vertical' })
    .catch(() => {});
});
splitHorizontalButton?.addEventListener('click', () => {
  const session = activeSession();
  if (!session) return;
  runPaneAction(`/api/sessions/${encodeURIComponent(session.id)}/panes`, splitHorizontalButton, 'pane split top/bottom', { direction: 'horizontal' })
    .catch(() => {});
});
nextPaneButton?.addEventListener('click', () => {
  const session = activeSession();
  if (!session) return;
  runPaneAction(`/api/sessions/${encodeURIComponent(session.id)}/panes/next`, nextPaneButton, 'next pane selected')
    .catch(() => {});
});

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
  focusTerminalSoon();
});

blocksToggleButton?.addEventListener('click', () => setBlocksOpen(!blocksOpen));
mouseModeToggleButton?.addEventListener('click', () => {
  if (isAutoTuiModeActive()) {
    readerMouseMode = 'reader';
    localStorage.setItem('warpish_reader_mouse_mode_v1', readerMouseMode);
    setTuiAutoEnabled(false);
    focusTerminalSoon();
  } else {
    setReaderMouseMode(readerMouseMode === 'raw' ? 'reader' : 'raw');
  }
});
tuiModeToggleButton?.addEventListener('click', () => {
  setTuiAutoEnabled(!tuiAutoEnabled);
  focusTerminalSoon();
});

bidiToggleButton.addEventListener('click', () => {
  if (isAutoTuiModeActive()) {
    bidiReaderEnabled = true;
    localStorage.setItem('warpish_readable_terminal_v1', 'on');
    setTuiAutoEnabled(false);
    focusTerminalSoon();
    return;
  }
  bidiReaderEnabled = !bidiReaderEnabled;
  localStorage.setItem('warpish_readable_terminal_v1', bidiReaderEnabled ? 'on' : 'off');
  applyBidiMode();
});

detachSessionButton.addEventListener('click', () => {
  clearReconnectTimer();
  discardPendingTerminalInputs(currentSessionId);
  disconnectCurrent({ quiet: true });
  setStatus('warn', 'detached', 'click sidebar session to continue');
});

killSessionButton.addEventListener('click', async () => {
  const session = activeSession();
  if (!session) return;
  const confirmation = session.alive
    ? `Kill tmux session "${session.title}"? This stops the terminal process, but keeps its saved history.`
    : `Permanently delete saved history for "${session.title}"? This cannot be undone.`;
  if (!window.confirm(confirmation)) return;
  setControlBusy(killSessionButton, true);
  setControlBusy(detachSessionButton, true);
  beginSessionsMutation();
  discardPendingTerminalInputs(session.id);
  if (currentSessionId === session.id) {
    connectionSerial += 1;
    sessionGeneration += 1;
    blocksRequestSerial += 1;
    disconnectCurrent({ quiet: true });
  }
  try {
    const purge = session.alive ? '' : '?purge=1';
    const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}${purge}`, { method: 'DELETE', timeoutMs: 20_000 });
    sessions = payload.sessions || sessions.filter((candidate) => candidate.id !== session.id);
    if (currentSessionId === session.id) {
      currentSessionId = null;
      resetTerminalSurface();
      setStatus('warn', session.alive ? 'session killed' : 'history deleted', 'choosing another terminal…');
    }
    renderSessions();
    queueSessionsRefresh({ createIfEmpty: true });
  } catch (error) {
    setStatus('bad', 'kill failed', error.message);
    queueSessionsRefresh({ selectId: currentSessionId === session.id ? session.id : undefined });
  } finally {
    endSessionsMutation();
    setControlBusy(killSessionButton, false);
    setControlBusy(detachSessionButton, false);
  }
});

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    event.stopPropagation();
    setTerminalSearchOpen(true);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    event.stopPropagation();
    focusTerminalReliably();
  }
}, { capture: true });

applyTerminalPreferences(terminalPreferences);
applyPanelMode();
applyTuiPresentation({ refreshReader: false });

refreshSessions({ createIfEmpty: true }).catch((error) => {
  setStatus('bad', 'startup failed', error.message);
  term.writeln(`\x1b[31mStartup failed: ${error.message}\x1b[0m`);
  scheduleBidiReaderUpdate();
});

refreshTimer = setInterval(() => {
  refreshSessions().catch(() => {});
}, 5000);

window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  clearReconnectTimer();
  disconnectCurrent({ quiet: true });
});
