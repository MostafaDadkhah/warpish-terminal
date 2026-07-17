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
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

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
let sessionGeneration = 0;
let blocksRequestSerial = 0;
let pendingTerminalInputs = [];
const intentionallyClosedSockets = new WeakSet();
let refreshTimer = null;
let blockFilter = '';
let blocksOpen = localStorage.getItem('warpish_blocks_open') === 'on';
let bidiReaderEnabled = localStorage.getItem('warpish_readable_terminal_v1') !== 'off';
let readerMouseMode = localStorage.getItem('warpish_reader_mouse_mode_v1') === 'raw' ? 'raw' : 'reader';
let bidiReaderUpdatePending = false;

const RTL_CHAR_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const STRONG_CHAR_RE = /[A-Za-z\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const LTR_TOKEN_CHAR_RE = /[A-Za-z0-9_.\/@~#$%&+=\\'"`|^-]/u;
const BIDI_TOKEN_RE = /(\s+|\S+)/gu;
const TERMINAL_LINK_RE = /(https?:\/\/[^\s<>"'`\x00-\x1f\x7f]+|www\.[^\s<>"'`\x00-\x1f\x7f]+)/giu;
const LINK_TRAILING_PUNCT_RE = /[.,;:!?،؛؟…]+$/u;
const BIDI_READER_MAX_LINES = 2000;
const BIDI_READER_RENDER_INTERVAL_MS = 70;
const BIDI_CAPTURE_REFRESH_INTERVAL_MS = 600;
const BIDI_CAPTURE_SETTLE_DELAY_MS = 450;
const BIDI_READER_BOTTOM_EPSILON = 10;
const TERMINAL_FOCUS_REPORT_SUPPRESS_MS = 1200;
const XTERM_COLOR_MODE_PALETTE = 0x1000000;
const XTERM_COLOR_MODE_P256 = 0x2000000;
const XTERM_COLOR_MODE_RGB = 0x3000000;
const ANSI_PALETTE = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];
const BLOCK_RENDER_LIMIT = 60;
const BLOCK_OUTPUT_PREVIEW_CHARS = 3200;
const SESSION_PREVIEW_CHARS = 900;
const MAX_PENDING_TERMINAL_INPUT_CHARS = 100000;
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
let lastCapturedReaderEntries = [];
let bidiReaderHistoryModeUntil = 0;
let stalePromptRecoverySent = false;
let terminalFocusTimer = null;
let terminalFocusSerial = 0;
let terminalInputEventSerial = 0;
let terminalFocusFollowupTimers = [];
let terminalFitRaf = null;
let lastSentTerminalSize = '';
let suppressTerminalFocusReportsUntil = 0;

function compactText(text = '', maxChars = BLOCK_OUTPUT_PREVIEW_CHARS) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `… truncated ${value.length - maxChars} chars …\n${value.slice(-maxChars)}`;
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
  let fg = xtermColor(cell.getFgColorMode?.(), cell.getFgColor?.(), { bold });
  let bg = xtermColor(cell.getBgColorMode?.(), cell.getBgColor?.());
  if (inverse) [fg, bg] = [bg || 'var(--reader-fg)', fg || 'rgba(238, 234, 255, 0.16)'];
  const style = {
    fg,
    bg,
    bold,
    dim,
    italic: Boolean(cell.isItalic?.()),
    underline: Boolean(cell.isUnderline?.()),
    inverse,
  };
  return style;
}

function textStyleKey(style = {}) {
  if (!style) return '';
  return [style.fg || '', style.bg || '', style.bold ? 'b' : '', style.dim ? 'd' : '', style.italic ? 'i' : '', style.underline ? 'u' : '', style.inverse ? 'r' : ''].join('|');
}

function hasVisibleTextStyle(style = {}) {
  return Boolean(style?.fg || style?.bg || style?.bold || style?.dim || style?.italic || style?.underline || style?.inverse);
}

function applyTextStyle(element, style = {}) {
  if (!element || !hasVisibleTextStyle(style)) return;
  element.classList.add('bidi-style-run');
  if (style.fg) element.style.color = style.fg;
  if (style.bg) element.style.backgroundColor = style.bg;
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
  } else if (scope === 'fg') {
    style.fg = '';
  } else if (scope === 'bg') {
    style.bg = '';
  }
  return style;
}

function ansiRgb(r, g, b) {
  const clamp = (value) => Math.max(0, Math.min(255, Number(value) || 0));
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function applyAnsiSgr(style, rawCodes = '') {
  const codes = rawCodes === ''
    ? [0]
    : rawCodes.split(';').filter((part) => part.length).map((part) => Number(part));
  if (!codes.length) codes.push(0);
  for (let index = 0; index < codes.length; index += 1) {
    const code = Number.isFinite(codes[index]) ? codes[index] : 0;
    if (code === 0) resetTextStyle(style);
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 39) resetTextStyle(style, 'fg');
    else if (code === 49) resetTextStyle(style, 'bg');
    else if (code >= 30 && code <= 37) style.fg = xtermPaletteColor(code - 30, style.bold);
    else if (code >= 90 && code <= 97) style.fg = xtermPaletteColor(code - 90 + 8, style.bold);
    else if (code >= 40 && code <= 47) style.bg = xtermPaletteColor(code - 40);
    else if (code >= 100 && code <= 107) style.bg = xtermPaletteColor(code - 100 + 8);
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      const mode = codes[index + 1];
      if (mode === 2 && codes.length >= index + 5) {
        style[target] = ansiRgb(codes[index + 2], codes[index + 3], codes[index + 4]);
        index += 4;
      } else if (mode === 5 && codes.length >= index + 3) {
        style[target] = xtermPaletteColor(codes[index + 2], style.bold);
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
  const sgrPattern = /\x1b\[([0-9;]*)m/g;
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
    renderBidiRuns(wrapper, segment.text || ' ');
    element.appendChild(wrapper);
  }
}

function appendStyledSegmentsToEntry(entry, text, segments = []) {
  const offset = entry.text.length;
  entry.text += text;
  if (segments?.length) {
    for (const segment of segments) mergeStyledSegment(entry.segments, segment.text, segment.style);
  }
  return offset;
}

function getReadableTerminalEntries(limit = BIDI_READER_MAX_LINES) {
  const buffer = term.buffer?.active;
  if (!buffer) return [];
  const end = Math.min(buffer.length, buffer.baseY + term.rows);
  const start = Math.max(0, end - limit * 2);
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

function getReadableTerminalLines(limit = BIDI_READER_MAX_LINES) {
  return getReadableTerminalEntries(limit).map((entry) => entry.text);
}

function isTerminalAlternateBuffer() {
  return term?.buffer?.active?.type === 'alternate';
}

function isSparseReadableEntries(entries = []) {
  const visible = entries.map((entry) => String(entry?.text || '').trim()).filter(Boolean);
  if (!visible.length) return true;
  return visible.length <= 2 && visible.every((line) => /^(?:<[^>]+>|~|[│╭╰╮╯─\s]|\[[A-Z]+\])+$/u.test(line));
}

function entriesHaveVisibleText(entries = []) {
  return entries.some((entry) => String(entry?.text || '').trim().length > 0);
}

function entriesHaveVisibleStyle(entries = []) {
  return entries.some((entry) => Array.isArray(entry?.segments) && entry.segments.some((segment) => hasVisibleTextStyle(segment.style)));
}

function isBidiReaderNearBottom() {
  if (!bidiReaderLines) return true;
  return bidiReaderLines.scrollHeight - bidiReaderLines.scrollTop - bidiReaderLines.clientHeight <= BIDI_READER_BOTTOM_EPSILON;
}

function renderBidiLine(row, entry) {
  const text = entry.text || ' ';
  const segments = Array.isArray(entry.segments) ? entry.segments : [];
  const ghostStart = Number.isFinite(entry.ghostStart) ? Math.max(0, Math.min(entry.ghostStart, text.length)) : null;
  row.className = `bidi-line ${bidiDirection(text)}`;
  row.classList.toggle('active-cursor-line', Boolean(entry.isActiveLine));
  row.dataset.logicalText = text;
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
    ghost.dataset.ghostText = ghostText;
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

function mergeCapturedReaderEntriesWithLiveTail(capturedEntries = [], liveEntries = []) {
  if (!capturedEntries.length) return liveEntries;
  if (!liveEntries.length) return capturedEntries;
  if (capturedEntries.length <= liveEntries.length) return liveEntries;

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

  const tailLength = Math.min(liveEntries.length, Math.max(12, Math.min(term?.rows || 36, 80)));
  return capturedEntries.concat(liveEntries.slice(-tailLength));
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
  const exact = lines.find((line) => (line.dataset.logicalText || line.textContent || '') === anchor.text);
  const fallback = lines[Math.min(anchor.index, lines.length - 1)];
  const node = exact || fallback;
  if (!node) return false;
  const containerRect = bidiReaderLines.getBoundingClientRect();
  const delta = node.getBoundingClientRect().top - containerRect.top - anchor.offset;
  if (Math.abs(delta) > 0.5) bidiReaderLines.scrollTop += delta;
  return true;
}

function renderBidiReader(input = getReadableTerminalEntries(), { force = false, keepScroll = false, source = 'xterm', preserveAwayFromBottom = false } = {}) {
  if (!bidiReaderLines) return;
  const entries = normalizeReadableEntries(input);
  const hasContent = entries.length > 0;
  const key = `${hasContent ? 'content' : 'empty'}\n${readableEntriesKey(entries)}`;
  if (!force && key === lastBidiReaderRenderKey) return;
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
}

function isBidiReaderHistoryMode() {
  return performance.now() < bidiReaderHistoryModeUntil;
}

function preferBidiReaderHistoryForScroll() {
  bidiReaderHistoryModeUntil = performance.now() + 3000;
}

function flushBidiReaderUpdate() {
  bidiReaderUpdatePending = false;
  bidiReaderUpdateTimer = null;
  lastBidiReaderRenderAt = performance.now();
  const entries = getReadableTerminalEntries();
  const xtermHasText = entriesHaveVisibleText(entries);
  const xtermIsSparse = isSparseReadableEntries(entries);
  const readerIsScrolledInCaptureHistory = !bidiReaderPinnedToBottom && lastBidiReaderRenderSource === 'capture' && lastCapturedReaderEntries.length > 0;
  const readerHasRicherCapture = lastCapturedReaderEntries.length >= entries.length + 80 && entriesHaveVisibleText(lastCapturedReaderEntries);
  const shouldUseCapture = (isTerminalAlternateBuffer() && (!xtermHasText || xtermIsSparse))
    || readerIsScrolledInCaptureHistory
    || (isBidiReaderHistoryMode() && lastCapturedReaderEntries.length > entries.length)
    || readerHasRicherCapture;
  if (shouldUseCapture) {
    if (lastCapturedReaderEntries.length) {
      const renderEntries = xtermHasText
        ? mergeCapturedReaderEntriesWithLiveTail(lastCapturedReaderEntries, entries)
        : lastCapturedReaderEntries;
      renderBidiReader(renderEntries, { keepScroll: readerIsScrolledInCaptureHistory || isBidiReaderHistoryMode() || !bidiReaderPinnedToBottom, source: 'capture' });
    }
    if (performance.now() - lastBidiReaderCaptureAt > BIDI_CAPTURE_REFRESH_INTERVAL_MS) {
      refreshBidiReaderFromCapture({ keepScroll: !bidiReaderPinnedToBottom }).catch(() => renderBidiReader(entries, { force: true, source: 'xterm' }));
    }
    return;
  }
  renderBidiReader(entries, { source: 'xterm' });
}

function scheduleBidiReaderUpdate({ immediate = false } = {}) {
  if (!bidiReaderEnabled || bidiReaderUpdatePending) return;
  bidiReaderUpdatePending = true;
  const elapsed = performance.now() - lastBidiReaderRenderAt;
  const delay = immediate ? 0 : Math.max(0, BIDI_READER_RENDER_INTERVAL_MS - elapsed);
  bidiReaderUpdateTimer = window.setTimeout(() => requestAnimationFrame(flushBidiReaderUpdate), delay);
}

function scheduleBidiReaderCaptureAfterOutput() {
  if (!bidiReaderEnabled || !currentSessionId) return;
  if (bidiReaderCaptureSettleTimer) window.clearTimeout(bidiReaderCaptureSettleTimer);
  bidiReaderCaptureSettleTimer = window.setTimeout(() => {
    bidiReaderCaptureSettleTimer = null;
    refreshBidiReaderFromCapture({ keepScroll: !bidiReaderPinnedToBottom, preferCapture: true }).catch(() => {});
  }, BIDI_CAPTURE_SETTLE_DELAY_MS);
}

function handleTerminalWriteComplete() {
  if (!bidiReaderPinnedToBottom && lastCapturedReaderEntries.length) {
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
  if (!bidiReaderEnabled || !currentSessionId) {
    renderBidiReader(getReadableTerminalEntries(), { keepScroll, preserveAwayFromBottom });
    return;
  }
  const requestSessionId = currentSessionId;
  const requestGeneration = sessionGeneration;
  const requestIsCurrent = () => requestSessionId === currentSessionId && requestGeneration === sessionGeneration;
  bidiReaderCaptureRefreshPending = true;
  lastBidiReaderCaptureAt = performance.now();
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(requestSessionId)}/capture?lines=5000&ansi=1`);
    if (!requestIsCurrent()) return;
    const captureEntries = parseAnsiCaptureEntries(payload.text || '')
      .slice(-BIDI_READER_MAX_LINES);
    if (captureEntries.length) lastCapturedReaderEntries = captureEntries;

    const xtermEntries = getReadableTerminalEntries();
    const xtermHasText = entriesHaveVisibleText(xtermEntries);
    const xtermIsSparse = isSparseReadableEntries(xtermEntries);
    const shouldUseCapture = Boolean(
      captureEntries.length && (
        preferCapture
        || !xtermHasText
        || (isTerminalAlternateBuffer() && xtermIsSparse)
      )
    );

    const captureIsRicherHistory = captureEntries.length >= xtermEntries.length + 80;
    const renderEntries = captureIsRicherHistory && xtermHasText
      ? mergeCapturedReaderEntriesWithLiveTail(captureEntries, xtermEntries)
      : (shouldUseCapture ? captureEntries : (xtermHasText ? xtermEntries : captureEntries));
    const renderSource = (captureIsRicherHistory || shouldUseCapture || !xtermHasText) ? 'capture' : 'xterm';
    renderBidiReader(renderEntries, { force: true, keepScroll, source: renderSource, preserveAwayFromBottom });
  } catch {
    if (!requestIsCurrent()) return;
    const xtermEntries = getReadableTerminalEntries();
    const useCaptureFallback = lastCapturedReaderEntries.length && (preferCapture || isTerminalAlternateBuffer() && isSparseReadableEntries(xtermEntries));
    const fallbackEntries = useCaptureFallback
      ? lastCapturedReaderEntries
      : xtermEntries;
    renderBidiReader(fallbackEntries, { force: true, keepScroll, source: useCaptureFallback ? 'capture' : 'xterm', preserveAwayFromBottom });
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
  const key = `${cols}x${rows}`;
  if (key === lastSentTerminalSize) return;
  lastSentTerminalSize = key;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
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

function applyBidiMode() {
  document.body.classList.toggle('bidi-mode', bidiReaderEnabled);
  if (bidiToggleButton) {
    bidiToggleButton.textContent = `Readable: ${bidiReaderEnabled ? 'on' : 'off'}`;
    bidiToggleButton.setAttribute('aria-pressed', String(bidiReaderEnabled));
  }
  if (bidiReader) bidiReader.setAttribute('aria-hidden', String(!bidiReaderEnabled));
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
  if (bidiReaderEnabled) refreshBidiReaderFromCapture({ preferCapture: true }).catch(() => renderBidiReader(getReadableTerminalEntries(), { force: true }));
  refitTerminal();
}

function applyReaderMouseMode() {
  const raw = readerMouseMode === 'raw';
  document.body.classList.toggle('reader-mouse-raw', raw);
  document.body.classList.toggle('reader-mouse-reader', !raw);
  if (mouseModeToggleButton) {
    mouseModeToggleButton.textContent = `Mouse: ${raw ? 'raw' : 'reader'}`;
    mouseModeToggleButton.setAttribute('aria-pressed', String(raw));
    mouseModeToggleButton.setAttribute('aria-label', raw ? 'Use raw terminal mouse mode' : 'Use readable terminal mouse mode');
    mouseModeToggleButton.title = raw
      ? 'Mouse goes through the readable overlay to raw xterm/TUI apps; switch to reader for selection and links.'
      : 'Mouse selects/scrolls readable text and opens links; switch to raw for mouse-enabled TUI apps.';
  }
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
  if (readerMouseMode !== 'raw') return true;
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
    if (serial === terminalFocusSerial) focusTerminalOnceWithoutScroll();
  });
  for (const delayMs of [80, 240]) {
    const timer = setTimeout(() => {
      terminalFocusFollowupTimers = terminalFocusFollowupTimers.filter((item) => item !== timer);
      if (serial !== terminalFocusSerial) return;
      suppressTerminalFocusReports();
      focusTerminalOnceWithoutScroll();
    }, delayMs);
    terminalFocusFollowupTimers.push(timer);
  }
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
  terminalInputEventSerial += 1;
  if (shouldSuppressTerminalInput(data)) return;
  const filtered = stripTerminalFocusReports(data);
  if (!filtered) return;
  const sessionId = currentSessionId;
  if (maybeRecoverStalePromptBeforeInput(filtered)) {
    setTimeout(() => sendRaw(filtered, { sessionId }), 80);
  } else {
    sendRaw(filtered, { sessionId });
  }
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
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: authHeaders(options),
  });
  return parseApiResponse(response);
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
    button.disabled = !session.alive;
    button.dataset.sessionId = session.id;
    if (session.id === currentSessionId) button.setAttribute('aria-current', 'true');

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
    const whenSpan = document.createElement('span');
    whenSpan.textContent = formatRelative(session.lastOpenedAt || session.createdAt);
    const cwdSpan = document.createElement('span');
    cwdSpan.textContent = session.cwd || '~';
    meta.append(whenSpan, cwdSpan);

    const preview = document.createElement('div');
    preview.className = 'session-preview';
    const previewText = compactText(session.preview || (session.alive ? 'fresh terminal — no output yet' : 'no saved preview'), SESSION_PREVIEW_CHARS);
    applyBidiText(preview, previewText);

    button.append(title, meta, preview);
    button.addEventListener('click', () => connectToSession(session.id));
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
    empty.textContent = blocks.length
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
    if (currentSessionId && !sessions.some((session) => session.id === currentSessionId && session.alive)) {
      currentSessionId = null;
      sessionGeneration += 1;
      blocksRequestSerial += 1;
    }
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
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));
  return url;
}

function disconnectCurrent({ quiet = false } = {}) {
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

function pendingInputChars(sessionId) {
  return pendingTerminalInputs
    .filter((item) => item.sessionId === sessionId)
    .reduce((total, item) => total + item.data.length, 0);
}

function discardPendingTerminalInputs(sessionId) {
  const discarded = pendingInputChars(sessionId);
  pendingTerminalInputs = pendingTerminalInputs.filter((item) => item.sessionId !== sessionId);
  return discarded;
}

function queueTerminalInput({ data, directTmux, sessionId }) {
  const value = String(data || '');
  if (!value) return true;
  if (pendingInputChars(sessionId) + value.length > MAX_PENDING_TERMINAL_INPUT_CHARS) {
    setStatus('bad', 'input queue full', 'wait for the terminal to connect before sending more input');
    return false;
  }
  const last = pendingTerminalInputs.at(-1);
  if (last && last.sessionId === sessionId && last.directTmux === directTmux) {
    last.data += value;
  } else {
    pendingTerminalInputs.push({ data: value, directTmux: Boolean(directTmux), sessionId });
  }
  return true;
}

function sendTerminalInputOverSocket(socket, item) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const allowFocusReports = readerMouseMode === 'raw' && performance.now() > suppressTerminalFocusReportsUntil;
  try {
    socket.send(JSON.stringify({ type: 'input', data: item.data, directTmux: item.directTmux, allowFocusReports }));
    return true;
  } catch {
    return false;
  }
}

function flushPendingTerminalInputs(socket, sessionId) {
  const remaining = [];
  for (const item of pendingTerminalInputs) {
    if (item.sessionId !== sessionId) {
      remaining.push(item);
      continue;
    }
    if (sessionId !== currentSessionId || ws !== socket || !sendTerminalInputOverSocket(socket, item)) {
      remaining.push(item);
    }
  }
  pendingTerminalInputs = remaining;
}

function refreshReadableFromTmuxSoon(delay = 250, preferCapture = false) {
  if (!bidiReaderEnabled || !currentSessionId) return;
  setTimeout(() => {
    if (!bidiReaderEnabled || !currentSessionId) return;
    refreshBidiReaderFromCapture({ preferCapture }).catch(() => renderBidiReader(getReadableTerminalEntries(), { force: true }));
  }, delay);
}

function connectToSession(sessionId) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.alive) return;

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
  stalePromptRecoverySent = false;
  lastCapturedReaderEntries = [];
  lastBidiReaderCaptureAt = 0;
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
    setStatus('ok', 'connected', `${session.title} • tmux resumable`);
    const { cols, rows } = currentDims();
    socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    flushPendingTerminalInputs(socket, sessionId);
    refreshReadableFromTmuxSoon(200, true);
    focusPreferredInput();
  });

  socket.addEventListener('message', (event) => {
    if (serial !== connectionSerial || ws !== socket) return;
    if (event.data instanceof ArrayBuffer) {
      scheduleBidiReaderCaptureAfterOutput();
      term.write(new Uint8Array(event.data), handleTerminalWriteComplete);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      scheduleBidiReaderCaptureAfterOutput();
      term.write(event.data, handleTerminalWriteComplete);
      return;
    }

    if (msg.type === 'hello') {
      setStatus('ok', 'connected', `tmux ${msg.sessionId} • attach pid ${msg.pid}`);
      refreshReadableFromTmuxSoon(200, true);
      focusPreferredInput();
    } else if (msg.type === 'server-error') {
      setStatus('bad', 'error', msg.message || 'server error');
      term.writeln(`\r\n\x1b[31m${msg.message || 'server error'}\x1b[0m`);
      scheduleBidiReaderUpdate();
    } else if (msg.type === 'detached') {
      if (!intentionallyClosedSockets.has(socket)) setStatus('bad', 'detached', 'session still exists in sidebar');
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
      const droppedChars = discardPendingTerminalInputs(sessionId);
      setStatus('bad', 'disconnected', droppedChars ? `${droppedChars} queued chars were not sent` : 'click session to attach again');
    }
    setTimeout(() => {
      refreshSessions().catch(() => {});
      if (blocksOpen) loadBlocks(currentSessionId, { force: true }).catch(() => {});
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
  const item = { data: String(data || ''), directTmux: Boolean(directTmux), sessionId };
  if (ws?.readyState === WebSocket.OPEN && sendTerminalInputOverSocket(ws, item)) return;
  if (!queueTerminalInput(item)) return;
  if (ws?.readyState === WebSocket.CONNECTING) {
    setStatus('warn', 'attaching…', `${pendingInputChars(sessionId)} input chars queued`);
    return;
  }
  connectToSession(sessionId);
}

function selectedReadableText() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !bidiReaderLines) return '';
  const text = selection.toString();
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

function ctrlKeyData(key) {
  if (!key) return null;
  if (key === ' ') return '\x00';
  if (key === '[') return '\x1b';
  if (key === '\\') return '\x1c';
  if (key === ']') return '\x1d';
  if (key === '^') return '\x1e';
  if (key === '_') return '\x1f';
  const upper = key.toUpperCase();
  if (upper.length === 1 && upper >= 'A' && upper <= 'Z') return String.fromCharCode(upper.charCodeAt(0) - 64);
  return null;
}

function terminalKeyData(event) {
  if (!event || event.isComposing || event.metaKey) return null;
  if (event.ctrlKey) return ctrlKeyData(event.key);
  if (event.altKey) return null;
  const keyMap = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: '\t',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    Delete: '\x1b[3~',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
  };
  if (keyMap[event.key]) return keyMap[event.key];
  if (event.key && event.key.length === 1) return event.key;
  return null;
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

function currentCursorLineText() {
  const buffer = term.buffer?.active;
  if (!buffer) return '';
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  return line?.translateToString(true).trimEnd() || '';
}

function looksLikeShellPrompt(text = '') {
  return /(?:^|\s)[^\n]{0,160}(?:[%$#❯›➜>]\s*)(?:.*)$/u.test(String(text));
}

function looksLikePromptOnly(text = '') {
  return /^[^\n]{0,160}(?:[%$#❯›➜>]\s*)$/u.test(String(text).trimEnd());
}

function shouldRecoverStalePromptBeforeInput(data) {
  if (stalePromptRecoverySent || !bidiReaderEnabled || !data || data.length !== 1 || data < ' ') return false;
  const activeLine = currentCursorLineText();
  if (activeLine.trim()) return looksLikePromptOnly(activeLine);
  const recentLines = getReadableTerminalLines(12).filter((line) => line.trim());
  const lastNonEmpty = recentLines.at(-1) || '';
  return looksLikeShellPrompt(lastNonEmpty);
}

function maybeRecoverStalePromptBeforeInput(data) {
  if (!shouldRecoverStalePromptBeforeInput(data)) return false;
  stalePromptRecoverySent = true;
  sendRaw('\x07\x15', { directTmux: true });
  return true;
}

function handleReadableTerminalKeydown(event) {
  if (!bidiReaderEnabled || !isTerminalKeyTarget(event)) return;
  if (isXtermHelperTarget(event.target) || event.isComposing || event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();
  suppressTerminalFocusReports();
  if (forwardReaderKeyToXterm(event)) return;
  const data = terminalKeyData(event);
  if (data) term.input(data, true);
}

function handleReadableTerminalPaste(event) {
  if (!bidiReaderEnabled || !isTerminalKeyTarget(event)) return;
  if (isXtermHelperTarget(event.target)) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  event.preventDefault();
  event.stopPropagation();
  focusTerminalOnceWithoutScroll();
  term.paste(text);
}

term.onData((data) => handleTerminalInput(data));
term.onResize(({ cols, rows }) => {
  sendResizeIfChanged(cols, rows);
});

const resizeObserver = new ResizeObserver(() => {
  refitTerminal();
});
function shouldOpenReaderOnTrappedScroll() {
  const text = getReadableTerminalLines(40).join('\n');
  return /Welcome to Hermes Agent|\bgpt-[\w.]+\b|ctx --|❯/.test(text);
}

function handleBidiReaderScroll() {
  bidiReaderPinnedToBottom = isBidiReaderNearBottom();
  if (!bidiReaderEnabled || !currentSessionId) return;
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
  if (!bidiReaderEnabled || !bidiReaderLines) return;
  event.preventDefault();
  event.stopPropagation();
  const needsTmuxHistory = event.deltaY !== 0;
  if (needsTmuxHistory) refreshBidiReaderForScroll(event.deltaY).catch(() => {});
  bidiReaderLines.scrollTop += event.deltaY;
  bidiReaderPinnedToBottom = isBidiReaderNearBottom();
}

resizeObserver.observe(terminalEl);
terminalEl.addEventListener('pointerdown', () => focusTerminalSoon());
terminalCard?.addEventListener('pointerdown', (event) => {
  if (!shouldPreserveControlFocus(event)) focusTerminalSoon();
});
terminalCard?.addEventListener('click', (event) => {
  if (!shouldPreserveControlFocus(event)) focusPreferredInput();
});
terminalCard?.addEventListener('keydown', handleReadableTerminalKeydown, { capture: true });
terminalCard?.addEventListener('paste', handleReadableTerminalPaste, { capture: true });
bidiReaderLines?.addEventListener('scroll', handleBidiReaderScroll, { passive: true });
bidiReader?.addEventListener('wheel', handleBidiReaderWheel, { capture: true, passive: false });
bidiReaderLines?.addEventListener('wheel', handleBidiReaderWheel, { capture: true, passive: false });
terminalEl.addEventListener('wheel', (event) => {
  if (event.ctrlKey) return;
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
  const title = window.prompt('Rename terminal session:', session.title)?.trim();
  if (!title || title === session.title) return;
  renameSessionButton.disabled = true;
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    sessions = payload.sessions || sessions;
    renderSessions();
    setStatus('ok', 'renamed', title);
  } catch (error) {
    setStatus('bad', 'rename failed', error.message);
  } finally {
    renameSessionButton.disabled = false;
  }
});

copySelection.addEventListener('click', async () => {
  copySelection.disabled = true;
  try {
    await copyTerminalSelection();
  } catch (error) {
    setStatus('bad', 'copy failed', error.message);
  } finally {
    copySelection.disabled = false;
  }
});

blocksToggleButton?.addEventListener('click', () => setBlocksOpen(!blocksOpen));
mouseModeToggleButton?.addEventListener('click', () => setReaderMouseMode(readerMouseMode === 'raw' ? 'reader' : 'raw'));

bidiToggleButton.addEventListener('click', () => {
  bidiReaderEnabled = !bidiReaderEnabled;
  localStorage.setItem('warpish_readable_terminal_v1', bidiReaderEnabled ? 'on' : 'off');
  applyBidiMode();
});

detachSessionButton.addEventListener('click', () => {
  discardPendingTerminalInputs(currentSessionId);
  disconnectCurrent({ quiet: true });
  setStatus('warn', 'detached', 'click sidebar session to continue');
});

killSessionButton.addEventListener('click', async () => {
  const session = activeSession();
  if (!session) return;
  if (!window.confirm(`Kill tmux session "${session.title}"? This stops the terminal process, not just the browser attach.`)) return;
  killSessionButton.disabled = true;
  detachSessionButton.disabled = true;
  connectionSerial += 1;
  sessionGeneration += 1;
  blocksRequestSerial += 1;
  discardPendingTerminalInputs(session.id);
  disconnectCurrent({ quiet: true });
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
    currentSessionId = null;
    blocks = [];
    lastCapturedReaderEntries = [];
    renderBlocks();
    term.reset();
    scheduleBidiReaderUpdate();
    setStatus('warn', 'session killed', 'create or choose another session');
    try {
      await refreshSessions({ createIfEmpty: true });
    } catch (error) {
      setStatus('bad', 'refresh failed', `session was killed; ${error.message}`);
    }
  } catch (error) {
    setStatus('bad', 'kill failed', error.message);
    try {
      await refreshSessions();
      if (sessions.some((candidate) => candidate.id === session.id && candidate.alive)) connectToSession(session.id);
    } catch {}
  } finally {
    killSessionButton.disabled = false;
    detachSessionButton.disabled = false;
  }
});

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    focusTerminalReliably();
  }
});

applyPanelMode();
applyReaderMouseMode();
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
