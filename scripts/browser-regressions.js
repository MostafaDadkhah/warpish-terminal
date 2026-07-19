import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runtimeRoot = process.env.WARPISH_BROWSER_RUNTIME_ROOT
  ? path.resolve(process.env.WARPISH_BROWSER_RUNTIME_ROOT)
  : fs.mkdtempSync(path.join('/tmp', 'warpish-browser-regressions-'));
const dataDir = path.join(runtimeRoot, 'data');
const tokenFile = path.join(runtimeRoot, 'token');
const chromeProfile = path.join(runtimeRoot, 'chrome-profile');
const tmuxTmpDir = path.join(runtimeRoot, 'tmux');
fs.mkdirSync(tmuxTmpDir, { recursive: true, mode: 0o700 });

const tmuxBin = process.env.TMUX_BIN
  || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((candidate) => fs.existsSync(candidate))
  || 'tmux';
const sessionPrefix = (process.env.WARPISH_SESSION_PREFIX || `warpishreg-${process.pid.toString(36)}-`)
  .replace(/[^a-z0-9-]/gi, '')
  .toLowerCase() || `warpishreg-${process.pid.toString(36)}-`;
const browserOnly = String(process.env.WARPISH_BROWSER_ONLY || '').trim();

const createdSessions = new Set();
let server;
let chrome;
let browserPage;
let tokenUrl;
let token;
let port;
let cdpPort;
let chromeDiagnostics = { stdout: '', stderr: '', exit: null, error: null };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function isolatedTmuxEnvironment(extra = {}) {
  const env = { ...process.env, ...extra, TMUX_TMPDIR: tmuxTmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

const tmuxEnvironment = isolatedTmuxEnvironment();

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(() => resolve(address.port));
    });
    listener.on('error', reject);
  });
}

function httpResponse({
  requestPort = port,
  method = 'GET',
  pathname = '/',
  headers = {},
  body,
  timeoutMs = 10_000,
}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined
      ? null
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1',
      port: requestPort,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        } : {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let json = null;
        if (text && String(response.headers['content-type'] || '').includes('application/json')) {
          try { json = JSON.parse(text); } catch {}
        }
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          text,
          json,
        });
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`${method} 127.0.0.1:${requestPort}${pathname} timed out after ${timeoutMs}ms`));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

async function requestJson(options) {
  const response = await httpResponse(options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${options.method || 'GET'} ${options.pathname || '/'} -> HTTP ${response.status}: ${response.text}`);
  }
  if (!response.json) throw new Error(`Expected JSON from ${options.pathname || '/'}; received: ${response.text}`);
  return response.json;
}

function api(pathname, { method = 'GET', body, timeoutMs } = {}) {
  return requestJson({
    pathname,
    method,
    body,
    timeoutMs,
    headers: { 'x-warpish-token': token },
  });
}

function apiResponse(pathname, { method = 'GET', body, timeoutMs } = {}) {
  return httpResponse({
    pathname,
    method,
    body,
    timeoutMs,
    headers: { 'x-warpish-token': token },
  });
}

async function waitForServerUrl(stdoutRef, stderrRef) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const match = stdoutRef.value.match(/URL: (http:\/\/[^\s]+)/u);
    if (match) return match[1];
    if (server?.exitCode !== null) break;
    await delay(100);
  }
  throw new Error(`server did not print its URL\nstdout=${stdoutRef.value}\nstderr=${stderrRef.value}`);
}

async function startServer() {
  port = await freePort();
  const stdoutRef = { value: '' };
  const stderrRef = { value: '' };
  server = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: isolatedTmuxEnvironment({
      HOST: '127.0.0.1',
      PORT: String(port),
      WARPISH_DATA_DIR: dataDir,
      WARPISH_TOKEN_FILE: tokenFile,
      WARPISH_SESSION_PREFIX: sessionPrefix,
      WARPISH_SKIP_USER_ZSHRC: '1',
      WARPISH_PTY_IDLE_GRACE_MS: '150',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { stdoutRef.value += chunk.toString(); });
  server.stderr.on('data', (chunk) => { stderrRef.value += chunk.toString(); });
  tokenUrl = await waitForServerUrl(stdoutRef, stderrRef);
  token = new URL(tokenUrl).searchParams.get('token');
  await requestJson({ requestPort: port, pathname: '/healthz' });
}

class CdpPage {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.diagnostics = {
      consoleErrors: [],
      runtimeExceptions: [],
      logEntries: [],
    };
    this.ready = new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`${message.error.message}: ${message.error.data || ''}`));
          else pending.resolve(message.result || {});
          return;
        }
        this.recordDiagnostic(message);
        this.events.push(message);
      });
    });
  }

  recordDiagnostic(message) {
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params?.type)) {
      this.diagnostics.consoleErrors.push({
        type: message.params.type,
        args: (message.params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type),
        stackTrace: message.params.stackTrace,
      });
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails || {};
      this.diagnostics.runtimeExceptions.push({
        text: details.text,
        url: details.url,
        lineNumber: details.lineNumber,
        columnNumber: details.columnNumber,
        exception: details.exception?.description || details.exception?.value,
        stackTrace: details.stackTrace,
      });
      return;
    }
    if (message.method === 'Log.entryAdded') {
      const entry = message.params?.entry;
      if (entry && ['warning', 'error'].includes(entry.level)) {
        this.diagnostics.logEntries.push(entry);
        this.diagnostics.logEntries = this.diagnostics.logEntries.slice(-50);
      }
    }
  }

  diagnosticSnapshot() {
    return {
      consoleErrors: this.diagnostics.consoleErrors.slice(),
      runtimeExceptions: this.diagnostics.runtimeExceptions.slice(),
      recentLogEntries: this.diagnostics.logEntries.slice(),
    };
  }

  assertNoUnhandledErrors(label = 'browser regression suite') {
    const snapshot = this.diagnosticSnapshot();
    assert(
      snapshot.consoleErrors.length === 0 && snapshot.runtimeExceptions.length === 0,
      `${label} emitted console errors or unhandled runtime exceptions`,
      snapshot,
    );
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout for ${method}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 20_000, 'page load');
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 15_000, label = expression) {
    const startedAt = Date.now();
    let lastValue;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        lastValue = await this.eval(`(() => { try { return (${expression}); } catch (error) { return { __error: String(error) }; } })()`);
        if (lastValue && !lastValue.__error) return lastValue;
      } catch (error) {
        lastValue = String(error);
      }
      await delay(100);
    }
    throw new Error(`timed out waiting for ${label}. last=${JSON.stringify(lastValue)}`);
  }

  networkRequestsSince(eventIndex, predicate) {
    return this.events
      .slice(eventIndex)
      .filter((event) => event.method === 'Network.requestWillBeSent')
      .map((event) => event.params?.request)
      .filter(Boolean)
      .filter(predicate);
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function startChrome() {
  cdpPort = await freePort();
  chromeDiagnostics = { stdout: '', stderr: '', exit: null, error: null };
  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${chromeProfile}`,
    `--remote-debugging-port=${cdpPort}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const appendDiagnostic = (field, chunk) => {
    chromeDiagnostics[field] = `${chromeDiagnostics[field]}${chunk.toString()}`.slice(-16_000);
  };
  chrome.stdout.on('data', (chunk) => appendDiagnostic('stdout', chunk));
  chrome.stderr.on('data', (chunk) => appendDiagnostic('stderr', chunk));
  chrome.on('error', (error) => { chromeDiagnostics.error = error.message || String(error); });
  chrome.on('exit', (code, signal) => { chromeDiagnostics.exit = { code, signal }; });

  let lastCdpError = '';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await requestJson({
        requestPort: cdpPort,
        pathname: '/json/list',
        timeoutMs: 1000,
      });
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return new CdpPage(page.webSocketDebuggerUrl);
      lastCdpError = `CDP returned ${targets.length} targets but no page target`;
    } catch (error) {
      lastCdpError = error.message || String(error);
    }
    if (chromeDiagnostics.exit || chromeDiagnostics.error) break;
    await delay(100);
  }
  throw new Error(`Chrome CDP target did not become available\n${JSON.stringify({
    chromePath,
    cdpPort,
    chromeProfile,
    lastCdpError,
    ...chromeDiagnostics,
  }, null, 2)}`);
}

async function terminateProcess(childProcess, timeoutMs = 3000) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  const exited = new Promise((resolve) => childProcess.once('close', resolve));
  childProcess.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (graceful || childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  childProcess.kill('SIGKILL');
  await Promise.race([exited, delay(1000)]);
}

async function startChromeWithRetry() {
  let firstError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await startChrome();
    } catch (error) {
      firstError ||= error;
      await terminateProcess(chrome);
      chrome = null;
      try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(chromeProfile, { recursive: true });
      if (attempt === 0) await delay(1200);
    }
  }
  throw firstError || new Error('Chrome failed to start');
}

function chromeVersionLabel() {
  const infoPlist = path.resolve(path.dirname(chromePath), '..', 'Info.plist');
  if (fs.existsSync(infoPlist) && fs.existsSync('/usr/libexec/PlistBuddy')) {
    const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', infoPlist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout.trim()) return `Google Chrome ${result.stdout.trim()}`;
  }
  const result = spawnSync(chromePath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return result.status === 0 && output ? output : path.basename(chromePath);
}

function rememberSessions(sessions = []) {
  for (const session of sessions) {
    if (session?.id) createdSessions.add(session.id);
  }
}

async function createDefaultSession(body = {}) {
  const payload = await api('/api/sessions', { method: 'POST', body, timeoutMs: 20_000 });
  rememberSessions(payload.sessions);
  createdSessions.add(payload.session.id);
  return payload.session;
}

async function selectLiveSession(page, sessionId) {
  await page.eval(`refreshSessions({ selectId: ${JSON.stringify(sessionId)} })`);
  return page.waitFor(`(() => currentSessionId === ${JSON.stringify(sessionId)}
    && ws?.readyState === WebSocket.OPEN
    && terminalControlRole === 'controller'
    ? { id: currentSessionId, role: terminalControlRole, readyState: ws.readyState }
    : false)()`, 20_000, `live session ${sessionId} attachment`);
}

function terminalContainsExpression(marker) {
  return `(() => {
    const buffer = term?.buffer?.active;
    if (!buffer) return false;
    const lines = [];
    const start = Math.max(0, buffer.length - 2000);
    for (let index = start; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) || '');
    }
    const text = lines.join(String.fromCharCode(10));
    return text.includes(${JSON.stringify(marker)}) ? { text, lineCount: lines.length } : false;
  })()`;
}

function latestWebSocketRequestId(page, sessionId, beforeCursor = page.events.length) {
  for (let index = Math.min(beforeCursor, page.events.length) - 1; index >= 0; index -= 1) {
    const event = page.events[index];
    if (event.method !== 'Network.webSocketCreated' || !event.params?.url) continue;
    try {
      if (new URL(event.params.url).searchParams.get('sessionId') === sessionId) {
        return event.params.requestId || null;
      }
    } catch {}
  }
  return null;
}

function terminalTextExpression() {
  return `(() => {
    const buffer = term?.buffer?.active;
    if (!buffer) return '';
    const lines = [];
    const start = Math.max(0, buffer.length - 2000);
    for (let index = start; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) || '');
    }
    return lines.join(String.fromCharCode(10));
  })()`;
}

function tmuxCaptureText(sessionId) {
  try {
    return execFileSync(tmuxBin, ['capture-pane', '-p', '-J', '-t', sessionId, '-S', '-5000'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: tmuxEnvironment,
    });
  } catch {
    return '';
  }
}

function tmuxSessionExists(sessionId) {
  try {
    execFileSync(tmuxBin, ['has-session', '-t', sessionId], {
      stdio: 'ignore',
      env: tmuxEnvironment,
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForTmuxPaneContains(sessionId, marker, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCapture = '';
  while (Date.now() < deadline) {
    lastCapture = tmuxCaptureText(sessionId);
    if (lastCapture.includes(marker)) return lastCapture;
    await delay(150);
  }
  throw new Error(`tmux pane ${sessionId} did not contain ${marker}: ${JSON.stringify(lastCapture.slice(-2000))}`);
}

async function waitForFile(filePath, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      lastSize = data.length;
      if (predicate(data)) return data;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}; last file size=${lastSize}`);
}

function respawnPane(sessionId, command) {
  execFileSync(tmuxBin, ['respawn-pane', '-k', '-t', sessionId, command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: tmuxEnvironment,
  });
}

function rawInputFixtureCommand({ byteCount, outputFile, readyMarker, doneMarker }) {
  const source = [
    'import sys, termios, tty, time',
    'fd = sys.stdin.fileno()',
    'original = termios.tcgetattr(fd)',
    'tty.setraw(fd)',
    `sys.stdout.write("\\x1b[?1004h" + ${JSON.stringify(readyMarker)})`,
    'sys.stdout.flush()',
    `data = sys.stdin.buffer.read(${byteCount})`,
    'termios.tcsetattr(fd, termios.TCSADRAIN, original)',
    `with open(${JSON.stringify(outputFile)}, 'wb') as handle:`,
    '    handle.write(data)',
    `sys.stdout.write("\\x1b[?1004l" + ${JSON.stringify(doneMarker)})`,
    'sys.stdout.flush()',
    'time.sleep(90)',
  ].join('\n');
  return `python3 -u -c ${shellQuote(source)}`;
}

async function testQuickCreate(page) {
  await page.navigate(`${tokenUrl}&case=quick-create`);
  await page.waitFor(`document.querySelector('#newSession')
    && sessions.length > 0
    && currentSessionId
    && ws?.readyState === WebSocket.OPEN
    && terminalControlRole === 'controller'
    && !sessionsRefreshPending`, 25_000, 'initial default terminal');

  const beforePayload = await api('/api/sessions');
  rememberSessions(beforePayload.sessions);
  const beforeIds = beforePayload.sessions.map((session) => session.id);
  const eventCursor = page.events.length;

  const clickState = await page.eval(`(() => {
    const button = document.querySelector('#newSession');
    button.click();
    button.click();
    return {
      label: button.textContent,
      busy: button.disabled,
      creationDialogOpen: Boolean(document.querySelector('#newSessionDialog')?.open),
    };
  })()`);

  const created = await page.waitFor(`(() => {
    const beforeIds = new Set(${JSON.stringify(beforeIds)});
    const session = sessions.find((candidate) => !beforeIds.has(candidate.id));
    if (!session || currentSessionId !== session.id || newSessionCreationPending) return false;
    return {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      profile: session.profile,
      private: session.private,
      buttonDisabled: document.querySelector('#newSession')?.disabled,
      creationDialogOpen: Boolean(document.querySelector('#newSessionDialog')?.open),
    };
  })()`, 25_000, 'one quick-created terminal');
  createdSessions.add(created.id);

  const afterPayload = await api('/api/sessions');
  rememberSessions(afterPayload.sessions);
  const newlyCreated = afterPayload.sessions.filter((session) => !beforeIds.includes(session.id));
  const postRequests = page.networkRequestsSince(eventCursor, (request) => {
    try {
      const url = new URL(request.url);
      return request.method === 'POST' && url.pathname === '/api/sessions';
    } catch {
      return false;
    }
  });
  const postBodies = postRequests.map((request) => request.postData || '');

  assert(newlyCreated.length === 1, 'double-clicking New terminal created more than one session', newlyCreated);
  assert(postRequests.length === 1, 'double-clicking New terminal emitted more than one POST request', postBodies);
  assert(postBodies[0] && JSON.stringify(JSON.parse(postBodies[0])) === '{}', 'New terminal did not POST an empty object', postBodies);
  assert(/^Terminal \d+$/u.test(created.title), 'quick create did not use an automatic title', created);
  assert(created.cwd === os.homedir(), 'quick create did not start in Home', created);
  assert(created.profile === 'default' && created.private === false, 'quick create did not use default/normal settings', created);
  assert(created.buttonDisabled === false && created.creationDialogOpen === false, 'quick create did not settle without a creation dialog', created);

  return {
    sessionId: created.id,
    automaticTitle: created.title,
    cwd: created.cwd,
    profile: created.profile,
    private: created.private,
    doubleClickCreatedCount: newlyCreated.length,
    postCount: postRequests.length,
    postBody: JSON.parse(postBodies[0]),
    regularButtonOpenedDialog: clickState.creationDialogOpen,
  };
}

async function testMinimalUi(page) {
  const selectors = {
    toolbar: '.toolbar-actions, .terminal-toolbar, [data-terminal-toolbar]',
    options: '#newSessionOptions, #newSessionDialog, [data-action="session-options"]',
    blocks: '#blocksPanel, #blockPanel, .command-blocks, [data-action="blocks"]',
    search: '#findInput, #findDialog, #terminalSearch, [data-action="find"]',
    settings: '#settingsDialog, #settingsButton, [data-action="settings"]',
    readable: '#bidiReader, #readableToggle, [data-action="readable"]',
    mouseMode: '#mouseModeToggle, [data-action="mouse-mode"]',
    tuiMode: '#tuiModeToggle, [data-action="tui-mode"]',
    removedActions: '#renameSession, #copySelection, #exportSession, #splitPane, #nextPane, #detachSession, #killSession',
  };
  const state = await page.eval(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    const present = Object.fromEntries(Object.entries(selectors)
      .filter(([, selector]) => document.querySelector(selector)));
    const dialogs = [...document.querySelectorAll('dialog')].map((dialog) => ({ id: dialog.id, open: dialog.open }));
    const card = document.querySelector('.terminal-card');
    return {
      present,
      dialogs,
      rawXterm: Boolean(document.querySelector('#terminal .xterm .xterm-helper-textarea')),
      terminalChildren: [...(card?.children || [])].map((child) => child.id || child.className),
      newSessionType: document.querySelector('#newSession')?.type || '',
      mobileKeyCount: document.querySelectorAll('.mobile-terminal-keys button').length,
    };
  })()`);

  const creationDialogs = state.dialogs.filter((dialog) => dialog.id !== 'pasteDialog');
  assert(Object.keys(state.present).length === 0, 'removed terminal UI controls are still present', state.present);
  assert(state.rawXterm, 'raw xterm input surface is missing', state);
  assert(creationDialogs.length === 0, 'a removed creation/options dialog is still present', state.dialogs);
  assert(state.dialogs.length === 1 && state.dialogs[0].id === 'pasteDialog' && !state.dialogs[0].open, 'only the paste-safety dialog should remain', state.dialogs);
  assert(state.terminalChildren.length === 2
    && state.terminalChildren.includes('terminal')
    && state.terminalChildren.includes('mobile-terminal-keys'), 'terminal card contains a legacy overlay or action surface', state.terminalChildren);
  assert(state.newSessionType === 'button' && state.mobileKeyCount === 8, 'minimal core controls are incomplete', state);

  return {
    removedSelectorsPresent: Object.keys(state.present),
    remainingDialogs: state.dialogs.map((dialog) => dialog.id),
    rawXterm: state.rawXterm,
    terminalChildren: state.terminalChildren,
    mobileKeyCount: state.mobileKeyCount,
  };
}

async function testIndividualSessionClose(page, survivorSessionId) {
  const disposable = await createDefaultSession();
  await selectLiveSession(page, disposable.id);

  const cancelled = await page.eval(`(() => {
    const entry = [...document.querySelectorAll('.session-entry')]
      .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(disposable.id)});
    const closeButton = entry?.querySelector('[data-session-action="close"]');
    const selectButton = entry?.querySelector('[data-session-action="select"]');
    let confirmText = '';
    const originalConfirm = window.confirm;
    window.confirm = (message) => {
      confirmText = String(message);
      return false;
    };
    closeButton?.click();
    window.confirm = originalConfirm;
    return {
      entryFound: Boolean(entry),
      closeFound: Boolean(closeButton),
      separateButtons: Boolean(closeButton && selectButton && !selectButton.contains(closeButton)),
      closeType: closeButton?.type || '',
      closeLabel: closeButton?.getAttribute('aria-label') || '',
      confirmText,
      sessionStillPresent: sessions.some((session) => session.id === ${JSON.stringify(disposable.id)}),
      currentSessionId,
    };
  })()`);
  await delay(150);
  const afterCancel = await api('/api/sessions');
  assert(cancelled.entryFound
    && cancelled.closeFound
    && cancelled.separateButtons
    && cancelled.closeType === 'button'
    && cancelled.closeLabel.includes(disposable.title), 'individual terminal close control is missing or inaccessible', cancelled);
  assert(cancelled.confirmText.includes(disposable.title)
    && cancelled.confirmText.includes('running')
    && cancelled.sessionStillPresent
    && cancelled.currentSessionId === disposable.id
    && afterCancel.sessions.some((session) => session.id === disposable.id)
    && tmuxSessionExists(disposable.id), 'cancelling a live terminal close still removed or detached it', {
    cancelled,
    afterCancel: afterCancel.sessions.map((session) => session.id),
  });
  const disposableIndex = afterCancel.sessions.findIndex((session) => session.id === disposable.id);
  const remainingInSidebarOrder = afterCancel.sessions.filter((session) => session.id !== disposable.id);
  const expectedAdjacentId = remainingInSidebarOrder[
    Math.min(disposableIndex, remainingInSidebarOrder.length - 1)
  ]?.id || null;
  assert(expectedAdjacentId, 'individual close test needs a surviving adjacent terminal', {
    disposableId: disposable.id,
    sidebarOrder: afterCancel.sessions.map((session) => session.id),
  });

  const eventCursor = page.events.length;
  const accepted = await page.eval(`(() => {
    const entry = [...document.querySelectorAll('.session-entry')]
      .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(disposable.id)});
    const closeButton = entry?.querySelector('[data-session-action="close"]');
    let confirmText = '';
    const originalConfirm = window.confirm;
    window.confirm = (message) => {
      confirmText = String(message);
      return true;
    };
    closeButton?.click();
    window.confirm = originalConfirm;
    return { clicked: Boolean(closeButton), confirmText };
  })()`);

  const settled = await page.waitFor(`(() => !sessions.some((session) => session.id === ${JSON.stringify(disposable.id)})
    && !closingSessionIds.has(${JSON.stringify(disposable.id)})
    && currentSessionId === ${JSON.stringify(expectedAdjacentId)}
    && ws?.readyState === WebSocket.OPEN
    && terminalControlRole === 'controller'
    ? {
      currentSessionId,
      role: terminalControlRole,
      closeButtons: document.querySelectorAll('.session-close').length,
      sessionCount: sessions.length,
    }
    : false)()`, 25_000, 'individual live terminal close and adjacent selection');

  const deleteRequests = page.networkRequestsSince(eventCursor, (request) => {
    try {
      const url = new URL(request.url);
      return request.method === 'DELETE'
        && url.pathname === '/api/sessions/' + disposable.id
        && url.searchParams.get('purge') === '1';
    } catch {
      return false;
    }
  });
  const afterClose = await api('/api/sessions');
  assert(accepted.clicked && accepted.confirmText.includes(disposable.title), 'live terminal close confirmation was not accepted', accepted);
  assert(deleteRequests.length === 1, 'individual close did not issue exactly one permanent-delete request', deleteRequests);
  assert(!afterClose.sessions.some((session) => session.id === disposable.id)
    && !tmuxSessionExists(disposable.id)
    && settled.closeButtons === settled.sessionCount, 'individual close did not remove the tmux session, history row, and only that row', {
    settled,
    afterClose: afterClose.sessions.map((session) => session.id),
    tmuxStillAlive: tmuxSessionExists(disposable.id),
  });
  if (expectedAdjacentId !== survivorSessionId) await selectLiveSession(page, survivorSessionId);

  return {
    closedSessionId: disposable.id,
    survivorSessionId,
    liveCloseConfirmed: true,
    cancelledClosePreservedSession: true,
    permanentDeleteRequests: deleteRequests.length,
    tmuxTerminated: true,
    rowRemoved: true,
    adjacentSessionSelected: settled.currentSessionId === expectedAdjacentId,
    closeButtonsMatchSessions: settled.closeButtons === settled.sessionCount,
  };
}

async function testCommandActivityIndicator(page, sessionId) {
  await selectLiveSession(page, sessionId);
  const command = 'sleep 1.4\r';
  await page.eval(`(() => { term.input(${JSON.stringify(command)}, true); return true; })()`);

  const running = await page.waitFor(`(() => {
    const card = document.querySelector('#statusCard');
    if (!card?.classList.contains('status-running')
      || card.getAttribute('aria-busy') !== 'true'
      || statusText.textContent !== 'command running…') return false;
    return {
      text: statusText.textContent,
      detail: sessionText.textContent,
      className: card.className,
      ariaBusy: card.getAttribute('aria-busy'),
    };
  })()`, 10_000, 'visible command-running status');

  await delay(150);
  const observedActivity = await page.eval(`(() => commandActivity?.running
    ? {
      source: commandActivity.source,
      activityId: commandActivity.activityId,
      startedAt: commandActivity.startedAt,
      detail: sessionText.textContent,
    }
    : null)()`);

  const finished = await page.waitFor(`(() => {
    const card = document.querySelector('#statusCard');
    if (statusText.textContent !== 'command finished'
      || card?.classList.contains('status-running')
      || card?.hasAttribute('aria-busy')) return false;
    return {
      text: statusText.textContent,
      detail: sessionText.textContent,
      className: card.className,
      ariaBusy: card.getAttribute('aria-busy'),
    };
  })()`, 10_000, 'visible command-finished status');

  assert(running.detail.includes('Ctrl+C') || running.detail.includes('waiting for the shell'), 'running status lacks a wait/cancel cue', running);
  assert(finished.detail.includes('ready for the next command'), 'finished status lacks a ready cue', finished);

  const legacySession = await createDefaultSession({});
  await selectLiveSession(page, legacySession.id);
  await page.eval(`(() => { term.input('export WARPISH_ACTIVITY_INTEGRATION=0\\r', true); return true; })()`);
  await page.waitFor(`statusText.textContent === 'command finished' && !commandActivity`, 10_000, 'activity integration disable command');
  await page.waitFor(`statusText.textContent === 'connected' && !commandActivity`, 10_000, 'legacy fallback setup readiness');

  await page.eval(`(() => { term.input('sleep 1.4\\r', true); return true; })()`);
  const legacyRunning = await page.waitFor(`(() => commandActivity?.source === 'process'
    && document.querySelector('#statusCard')?.classList.contains('status-running')
    ? {
      source: commandActivity.source,
      processName: commandActivity.processName,
      text: statusText.textContent,
      detail: sessionText.textContent,
      ariaBusy: document.querySelector('#statusCard')?.getAttribute('aria-busy'),
    }
    : false)()`, 10_000, 'legacy-session foreground process activity');
  const legacyFinished = await page.waitFor(`(() => statusText.textContent === 'command finished'
    && !commandActivity
    ? {
      text: statusText.textContent,
      detail: sessionText.textContent,
      ariaBusy: document.querySelector('#statusCard')?.getAttribute('aria-busy'),
    }
    : false)()`, 10_000, 'legacy-session command completion');

  return {
    sessionId,
    running,
    observedActivity,
    finished,
    exactShellActivityObserved: observedActivity?.source === 'shell',
    legacyFallback: {
      sessionId: legacySession.id,
      running: legacyRunning,
      finished: legacyFinished,
    },
  };
}

async function testRawXtermResume(page, sessionId) {
  await selectLiveSession(page, sessionId);
  const marker = `__WARPISH_RAW_${process.pid}_${Date.now()}__`;
  const command = `printf '%s\\n' ${shellQuote(marker)}\r`;
  await page.eval(`(() => { term.input(${JSON.stringify(command)}, true); return true; })()`);
  await waitForTmuxPaneContains(sessionId, marker);
  await page.waitFor(terminalContainsExpression(marker), 20_000, 'raw xterm command output');

  await page.navigate(`${tokenUrl}&case=raw-resume-reload`);
  await page.waitFor('typeof refreshSessions === "function" && document.querySelector("#terminal .xterm")', 20_000, 'reloaded terminal app');
  await selectLiveSession(page, sessionId);
  await page.waitFor(terminalContainsExpression(marker), 20_000, 'tmux output after browser reload');

  const reconnectStart = await page.eval(`(() => {
    window.__warpishRegressionOldSocket = ws;
    term.reset();
    ws.close(4100, 'regression reconnect');
    return { id: currentSessionId, serial: connectionSerial };
  })()`);
  const reconnected = await page.waitFor(`(() => ws
    && ws !== window.__warpishRegressionOldSocket
    && ws.readyState === WebSocket.OPEN
    && terminalControlRole === 'controller'
    && currentSessionId === ${JSON.stringify(sessionId)}
    ? { serial: connectionSerial, role: terminalControlRole }
    : false)()`, 25_000, 'automatic WebSocket reconnect');
  await page.waitFor(terminalContainsExpression(marker), 20_000, 'tmux snapshot after WebSocket reconnect');
  await waitForTmuxPaneContains(sessionId, marker);

  return {
    sessionId,
    marker,
    rawInputReachedPty: true,
    reloadResumed: true,
    websocketReconnected: reconnected.serial > reconnectStart.serial,
    tmuxSnapshotPreserved: true,
  };
}

async function testLargeOrderedUtf8(page) {
  const session = await createDefaultSession({});
  await selectLiveSession(page, session.id);

  const payload = 'Aسلام🙂Z'.repeat(12_000);
  const expected = Buffer.from(payload, 'utf8');
  const outputFile = path.join(runtimeRoot, `large-input-${Date.now()}.bin`);
  const readyMarker = `__LARGE_READY_${Date.now()}__`;
  const doneMarker = `__LARGE_DONE_${Date.now()}__`;
  respawnPane(session.id, rawInputFixtureCommand({
    byteCount: expected.length,
    outputFile,
    readyMarker,
    doneMarker,
  }));
  await page.waitFor(terminalContainsExpression(readyMarker), 20_000, 'large-input fixture readiness');

  await page.eval(`(() => { term.input(${JSON.stringify(payload)}, true); return true; })()`);
  const received = await waitForFile(
    outputFile,
    (data) => data.length === expected.length,
    30_000,
    'large ordered UTF-8 input',
  );
  await page.waitFor(`pendingTerminalInputs.filter((item) => item.sessionId === ${JSON.stringify(session.id)}).length === 0`, 10_000, 'large-input browser queue drain');
  await page.waitFor(terminalContainsExpression(doneMarker), 10_000, 'large-input completion marker');

  assert(received.equals(expected), 'large UTF-8 input was reordered, duplicated, truncated, or split inside a code point', {
    expectedBytes: expected.length,
    receivedBytes: received.length,
    expectedHash: crypto.createHash('sha256').update(expected).digest('hex'),
    receivedHash: crypto.createHash('sha256').update(received).digest('hex'),
  });

  return {
    sessionId: session.id,
    byteLength: received.length,
    exceedsSingleMessageLimit: received.length > 64 * 1024,
    orderedExactMatch: true,
    sha256: crypto.createHash('sha256').update(received).digest('hex'),
    browserQueueDrained: true,
  };
}

async function testNativeFocusReports(page) {
  const session = await createDefaultSession({});
  await selectLiveSession(page, session.id);
  await page.waitFor(`terminalSurfaceTransitioning === false
    && pendingTerminalInputs.filter((item) => item.sessionId === ${JSON.stringify(session.id)}).length === 0`, 10_000, 'settled focus-report session');
  await delay(150);

  const socketRequestId = latestWebSocketRequestId(page, session.id);
  assert(socketRequestId, 'CDP did not expose the focus-report session WebSocket');
  const eventCursor = page.events.length;
  const focusState = await page.eval(`(async () => {
    const observedReports = [];
    const reportSubscription = term.onData((data) => {
      if (data === '\\x1b[O' || data === '\\x1b[I') observedReports.push(data);
    });
    term.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    await new Promise((resolve) => term.write('\\x1b[?1004h', resolve));
    const focusedBeforeBlur = document.activeElement === document.querySelector('#terminal .xterm-helper-textarea');
    term.blur();
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    term.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    let headlessFocusInFallback = false;
    if (!observedReports.includes('\\x1b[I')) {
      document.querySelector('#terminal .xterm-helper-textarea')
        ?.dispatchEvent(new FocusEvent('focus'));
      headlessFocusInFallback = true;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    reportSubscription.dispose();
    return {
      tracking: term.modes?.sendFocusMode,
      activeElement: document.activeElement?.id || document.activeElement?.className || '',
      focusedBeforeBlur,
      observedReports,
      headlessFocusInFallback,
    };
  })()`);
  assert(focusState.tracking === true
    && focusState.focusedBeforeBlur
    && focusState.observedReports.join('') === '\x1b[O\x1b[I', 'xterm did not generate ordered focus reports from its input surface', focusState);
  await page.waitFor(`pendingTerminalInputs.filter((item) => item.sessionId === ${JSON.stringify(session.id)}).length === 0`, 10_000, 'focus-report input acknowledgements');
  await delay(200);

  const inputFrames = page.events.slice(eventCursor)
    .filter((event) => event.method === 'Network.webSocketFrameSent'
      && event.params?.requestId === socketRequestId
      && event.params?.response?.opcode === 1)
    .flatMap((event) => {
      try {
        const message = JSON.parse(event.params.response.payloadData);
        return message.type === 'input' && ['\x1b[O', '\x1b[I'].includes(message.data) ? [message] : [];
      } catch {
        return [];
      }
    });
  const reports = inputFrames.map((message) => message.data).join('');
  const expected = '\x1b[O\x1b[I';
  assert(reports === expected, 'native xterm focus reports were filtered, lost, duplicated, or reordered before WebSocket transport', {
    reportsHex: Buffer.from(reports, 'binary').toString('hex'),
    inputFrames,
    focusState,
  });
  assert(inputFrames.every((message) => message.allowFocusReports === true && typeof message.inputId === 'string' && message.inputId.length > 0), 'focus-report input frames lost their explicit protocol metadata', inputFrames);

  const resyncEventCursor = page.events.length;
  const controllerResync = await page.eval(`(async () => {
    applyTerminalControlRole('spectator', 'focus regression');
    term.blur();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    term.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const focusedAsSpectator = document.activeElement === document.querySelector('#terminal .xterm-helper-textarea');
    applyTerminalControlRole('controller', 'focus regression');
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    return { focusedAsSpectator, controllerFocusReported, role: terminalControlRole };
  })()`);
  await page.waitFor(`pendingTerminalInputs.filter((item) => item.sessionId === ${JSON.stringify(session.id)}).length === 0`, 10_000, 'controller focus-resync acknowledgement');
  await delay(150);
  const resyncFrames = page.events.slice(resyncEventCursor)
    .filter((event) => event.method === 'Network.webSocketFrameSent'
      && event.params?.requestId === socketRequestId
      && event.params?.response?.opcode === 1)
    .flatMap((event) => {
      try {
        const message = JSON.parse(event.params.response.payloadData);
        return message.type === 'input' && ['\x1b[O', '\x1b[I'].includes(message.data) ? [message] : [];
      } catch {
        return [];
      }
    });
  assert(controllerResync.focusedAsSpectator
    && controllerResync.controllerFocusReported
    && controllerResync.role === 'controller'
    && resyncFrames.length === 1
    && resyncFrames[0].data === '\x1b[I', 'spectator-to-controller transition did not resynchronize the focused TUI state exactly once', {
    controllerResync,
    resyncFrames,
  });
  await page.eval(`new Promise((resolve) => term.write('\\x1b[?1004l', resolve))`);

  return {
    sessionId: session.id,
    focusTrackingEnabled: Boolean(focusState.tracking),
    reportsHex: Buffer.from(reports, 'binary').toString('hex'),
    expectedHex: Buffer.from(expected, 'binary').toString('hex'),
    protocolMetadataPreserved: true,
    controllerFocusResynced: true,
    acknowledged: true,
  };
}

async function testRuntimeEpochInputSafety(page) {
  const session = await createDefaultSession({});
  await selectLiveSession(page, session.id);
  await page.waitFor('typeof terminalRuntimeEpoch === "string" && terminalRuntimeEpoch.length > 0 && pendingTerminalInputs.length === 0', 10_000, 'initial terminal runtime epoch');

  const marker = `__EPOCH_ONCE_${Date.now()}__`;
  const outputFile = path.join(runtimeRoot, `runtime-epoch-${Date.now()}.txt`);
  const command = `printf '%s\\n' ${shellQuote(marker)} >> ${shellQuote(outputFile)}\r`;
  const armed = await page.eval(`(() => {
    window.__warpishOriginalAcknowledgeTerminalInput = acknowledgeTerminalInput;
    acknowledgeTerminalInput = () => {};
    const oldRuntimeEpoch = terminalRuntimeEpoch;
    term.input(${JSON.stringify(command)}, true);
    return { oldRuntimeEpoch, sessionId: currentSessionId };
  })()`);
  assert(armed.sessionId === session.id && armed.oldRuntimeEpoch, 'runtime epoch regression could not arm the live session', armed);
  await waitForFile(outputFile, (data) => data.toString('utf8').includes(marker), 15_000, 'runtime-epoch command execution');
  await page.waitFor(`pendingTerminalInputs.some((item) => item.sessionId === ${JSON.stringify(session.id)}
    && item.sentRuntimeEpoch === ${JSON.stringify(armed.oldRuntimeEpoch)}
    && item.sentSocket === ws)`, 10_000, 'intentionally unacknowledged input');

  await page.eval(`(() => {
    acknowledgeTerminalInput = window.__warpishOriginalAcknowledgeTerminalInput;
    delete window.__warpishOriginalAcknowledgeTerminalInput;
    ws.close(4101, 'runtime epoch regression');
    return true;
  })()`);
  const reconnected = await page.waitFor(`(() => ws?.readyState === WebSocket.OPEN
    && terminalControlRole === 'controller'
    && typeof terminalRuntimeEpoch === 'string'
    && terminalRuntimeEpoch !== ${JSON.stringify(armed.oldRuntimeEpoch)}
    && pendingTerminalInputs.filter((item) => item.sessionId === ${JSON.stringify(session.id)}).length === 0
    && statusText.textContent === 'input not retried'
    ? { runtimeEpoch: terminalRuntimeEpoch, status: statusText.textContent }
    : false)()`, 20_000, 'new runtime epoch without unsafe replay');
  await delay(500);
  const executions = fs.readFileSync(outputFile, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line === marker).length;
  assert(executions === 1, 'unacknowledged command was replayed after runtime teardown', {
    executions,
    oldRuntimeEpoch: armed.oldRuntimeEpoch,
    newRuntimeEpoch: reconnected.runtimeEpoch,
  });

  return {
    sessionId: session.id,
    runtimeEpochChanged: reconnected.runtimeEpoch !== armed.oldRuntimeEpoch,
    uncertainInputNotRetried: reconnected.status === 'input not retried',
    executionCount: executions,
  };
}

async function testStaleOutputIsolation(page) {
  const source = await createDefaultSession({});
  const target = await createDefaultSession({});
  await selectLiveSession(page, source.id);
  const eventCursor = page.events.length;
  const switchState = await page.eval(`(() => {
    writeTerminalOutput('x'.repeat(1_500_000) + '\\x1b[5n');
    connectToSession(${JSON.stringify(target.id)});
    return { sourceId: ${JSON.stringify(source.id)}, targetId: currentSessionId, transitioning: terminalSurfaceTransitioning };
  })()`);
  assert(switchState.targetId === target.id && switchState.transitioning, 'stale-output regression did not enter a guarded session transition', switchState);
  await page.waitFor(`currentSessionId === ${JSON.stringify(target.id)}
    && ws?.readyState === WebSocket.OPEN
    && terminalControlRole === 'controller'
    && terminalSurfaceTransitioning === false`, 25_000, 'stale-output target attachment');
  await delay(500);
  const staleResponses = page.events.slice(eventCursor)
    .filter((event) => event.method === 'Network.webSocketFrameSent' && event.params?.response?.opcode === 1)
    .flatMap((event) => {
      try {
        const message = JSON.parse(event.params.response.payloadData);
        return message.type === 'input' && String(message.data || '').includes('\x1b[0n') ? [message] : [];
      } catch {
        return [];
      }
    });
  const targetPending = await page.eval(`pendingTerminalInputs.filter((item) => item.sessionId === ${JSON.stringify(target.id)}).map((item) => item.data)`);
  assert(staleResponses.length === 0 && !targetPending.some((data) => String(data).includes('\x1b[0n')), 'stale xterm output generated terminal input for the newly selected session', {
    staleResponses,
    targetPending,
  });

  return {
    sourceSessionId: source.id,
    targetSessionId: target.id,
    staleDeviceResponsesSent: staleResponses.length,
    targetQueueClean: targetPending.length === 0,
  };
}

async function testMinimalApiSurface(sessionId) {
  const customAttempt = await createDefaultSession({
    title: 'Must be ignored',
    cwd: runtimeRoot,
    profile: 'must-be-ignored',
    private: true,
  });
  assert(/^Terminal \d+$/u.test(customAttempt.title)
    && customAttempt.cwd === os.homedir()
    && customAttempt.profile === 'default'
    && customAttempt.private === false, 'POST /api/sessions still honored removed custom-create fields', customAttempt);

  const removed = {
    rename: await apiResponse(`/api/sessions/${sessionId}`, { method: 'PATCH', body: { title: 'removed' } }),
    export: await apiResponse(`/api/sessions/${sessionId}/export`),
    panes: await apiResponse(`/api/sessions/${sessionId}/panes`, { method: 'POST', body: {} }),
    blocks: await apiResponse(`/api/sessions/${sessionId}/blocks`),
    capture: await apiResponse(`/api/sessions/${sessionId}/capture?lines=80`),
  };
  const statuses = Object.fromEntries(Object.entries(removed).map(([name, response]) => [name, response.status]));

  assert(Object.values(statuses).every((status) => status === 404), 'a removed custom/rename/export/panes/blocks/capture API is still available', statuses);

  return {
    customCreateIgnored: true,
    defaultSessionId: customAttempt.id,
    internalTmuxSnapshotAvailable: typeof tmuxCaptureText(sessionId) === 'string',
    removedRouteStatuses: statuses,
  };
}

async function testPasteAffinityAndStoppedHistory(page, sourceSessionId, targetSessionId) {
  await selectLiveSession(page, sourceSessionId);
  const affinityMarker = `__PASTE_AFFINITY_${Date.now()}__`;
  const dispatch = await page.eval(`(() => {
    const target = document.querySelector('#terminal .xterm-helper-textarea');
    const transfer = new DataTransfer();
    transfer.setData('text/plain', ${JSON.stringify(`${affinityMarker}\nsecond line\n`)});
    const event = new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target?.dispatchEvent(event);
    return {
      targetFound: Boolean(target),
      prevented: event.defaultPrevented,
      dialogOpen: Boolean(document.querySelector('#pasteDialog')?.open),
      pendingSessionId: pendingMultilinePaste?.sessionId || null,
    };
  })()`);
  assert(dispatch.targetFound && dispatch.prevented && dispatch.dialogOpen
    && dispatch.pendingSessionId === sourceSessionId, 'multiline paste was not bound to its source session', dispatch);

  await selectLiveSession(page, targetSessionId);
  await page.eval(`document.querySelector('#pasteDialog button[value="preserve"]')?.click()`);
  const cancelled = await page.waitFor(`(() => !pendingMultilinePaste
    && !document.querySelector('#pasteDialog')?.open
    && statusText.textContent === 'paste cancelled'
    ? {
      status: statusText.textContent,
      pendingCount: pendingTerminalInputs.length,
      currentSessionId,
    }
    : false)()`, 10_000, 'cross-session paste cancellation');
  await delay(250);
  const sourceText = tmuxCaptureText(sourceSessionId);
  const targetText = tmuxCaptureText(targetSessionId);
  assert(!sourceText.includes(affinityMarker) && !targetText.includes(affinityMarker), 'cancelled cross-session paste reached a PTY', {
    sourceContains: sourceText.includes(affinityMarker),
    targetContains: targetText.includes(affinityMarker),
  });

  await api(`/api/sessions/${sourceSessionId}`, { method: 'DELETE', timeoutMs: 20_000 });
  await page.eval(`refreshSessions({ selectId: ${JSON.stringify(sourceSessionId)} })`);
  await page.waitFor(`currentSessionId === ${JSON.stringify(sourceSessionId)}
    && terminalControlRole === 'history'
    && ws === null`, 20_000, 'stopped session read-only selection');

  const stoppedMarker = `__STOPPED_INPUT_${Date.now()}__`;
  const stoppedInput = await page.eval(`(() => {
    term.input(${JSON.stringify(`${stoppedMarker}\r`)}, true);
    const target = document.querySelector('#terminal .xterm-helper-textarea');
    const transfer = new DataTransfer();
    transfer.setData('text/plain', ${JSON.stringify(stoppedMarker)});
    const event = new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target?.dispatchEvent(event);
    return {
      role: terminalControlRole,
      socket: ws?.readyState ?? null,
      pendingForStopped: pendingTerminalInputs.filter((item) => item.sessionId === currentSessionId).length,
      dialogOpen: Boolean(document.querySelector('#pasteDialog')?.open),
      status: statusText.textContent,
      pastePrevented: event.defaultPrevented,
      terminalText: ${terminalTextExpression()},
    };
  })()`);
  const sessionsPayload = await api('/api/sessions');
  const stoppedSession = sessionsPayload.sessions.find((session) => session.id === sourceSessionId);

  assert(stoppedInput.role === 'history'
    && stoppedInput.socket === null
    && stoppedInput.pendingForStopped === 0
    && stoppedInput.dialogOpen === false
    && stoppedInput.status === 'read only'
    && stoppedInput.pastePrevented === true
    && !stoppedInput.terminalText.includes(stoppedMarker), 'stopped history accepted or queued terminal input', stoppedInput);
  assert(stoppedSession && stoppedSession.alive === false && !String(stoppedSession.preview || '').includes(stoppedMarker), 'stopped input reached retained session history', stoppedSession);

  const createdFromHistory = await page.eval(`(() => {
    const previousSessionId = currentSessionId;
    document.querySelector('#newSession')?.click();
    return previousSessionId;
  })()`);
  const newLiveSession = await page.waitFor(`(() => currentSessionId !== ${JSON.stringify(sourceSessionId)}
    && currentSessionId !== ${JSON.stringify(createdFromHistory)}
    && sessions.find((session) => session.id === currentSessionId)?.alive
    && ws?.readyState === WebSocket.OPEN
    && terminalControlRole === 'controller'
    ? { id: currentSessionId, cwd: sessions.find((session) => session.id === currentSessionId)?.cwd }
    : false)()`, 25_000, 'one-click terminal creation from stopped history');

  return {
    sourceSessionId,
    targetSessionId,
    pasteBoundToSource: dispatch.pendingSessionId === sourceSessionId,
    crossSessionPasteCancelled: cancelled.status === 'paste cancelled',
    pendingAfterCancellation: cancelled.pendingCount,
    stoppedRole: stoppedInput.role,
    stoppedSocket: stoppedInput.socket,
    stoppedPendingInputs: stoppedInput.pendingForStopped,
    stoppedPasteDialogOpen: stoppedInput.dialogOpen,
    createdFromStoppedHistory: true,
    createdSessionId: newLiveSession.id,
  };
}

async function testMobileLayoutAndKeys(page, sessionId) {
  await selectLiveSession(page, sessionId);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  try {
    const layout = await page.waitFor(`(() => {
      const strip = document.querySelector('.mobile-terminal-keys');
      const card = document.querySelector('.terminal-card');
      if (!strip || !card || getComputedStyle(strip).display === 'none') return false;
      const elements = [
        document.querySelector('.app-layout'),
        document.querySelector('.sidebar'),
        document.querySelector('.workspace'),
        card,
        strip,
      ].filter(Boolean);
      const rects = elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { className: element.className, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      });
      const appRect = document.querySelector('.app-layout')?.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const visualHeight = visualViewport?.height || innerHeight;
      const visualWidth = visualViewport?.width || innerWidth;
      const visualTop = visualViewport?.offsetTop || 0;
      const visualLeft = visualViewport?.offsetLeft || 0;
      if (!appRect
        || Math.abs(appRect.height - visualHeight) > 2
        || Math.abs(appRect.width - visualWidth) > 2
        || Math.abs(appRect.top - visualTop) > 2
        || Math.abs(appRect.left - visualLeft) > 2) return false;
      return {
        innerWidth,
        visualHeight,
        visualWidth,
        visualTop,
        visualLeft,
        appHeight: appRect.height,
        appWidth: appRect.width,
        appTop: appRect.top,
        appLeft: appRect.left,
        viewportMeta: document.querySelector('meta[name="viewport"]')?.content || '',
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        pageScrollX: window.scrollX,
        rects,
        buttons: [...strip.querySelectorAll('button')].map((button) => button.textContent.trim()),
        stripClientWidth: strip.clientWidth,
        stripScrollWidth: strip.scrollWidth,
        terminalHeight: card.getBoundingClientRect().height,
      };
    })()`, 15_000, 'mobile terminal layout');

    const horizontalOverflow = layout.documentScrollWidth > layout.innerWidth + 1
      || layout.bodyScrollWidth > layout.innerWidth + 1
      || layout.pageScrollX !== 0
      || layout.rects.some((rect) => rect.left < -1 || rect.right > layout.innerWidth + 1);
    assert(!horizontalOverflow, 'mobile page or core terminal surfaces overflow horizontally', layout);
    assert(layout.buttons.length === 8
      && ['Esc', 'Tab', 'Ctrl+C', 'Ctrl+D', '←', '↓', '↑', '→'].every((label) => layout.buttons.includes(label)), 'mobile terminal keys are missing', layout);
    assert(layout.terminalHeight > 100, 'mobile terminal viewport collapsed', layout);

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 430,
      deviceScaleFactor: 2,
      mobile: true,
    });
    const compactPortrait = await page.waitFor(`(() => {
      const card = document.querySelector('.terminal-card');
      const strip = document.querySelector('.mobile-terminal-keys');
      if (!card || !strip || getComputedStyle(strip).display === 'none') return false;
      const cardRect = card.getBoundingClientRect();
      const appRect = document.querySelector('.app-layout')?.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const visualHeight = visualViewport?.height || innerHeight;
      const visualWidth = visualViewport?.width || innerWidth;
      const visualTop = visualViewport?.offsetTop || 0;
      const visualLeft = visualViewport?.offsetLeft || 0;
      if (!appRect
        || Math.abs(appRect.height - visualHeight) > 2
        || Math.abs(appRect.width - visualWidth) > 2
        || Math.abs(appRect.top - visualTop) > 2
        || Math.abs(appRect.left - visualLeft) > 2) return false;
      return {
        terminalHeight: cardRect.height,
        appHeight: appRect.height,
        appWidth: appRect.width,
        appTop: appRect.top,
        appLeft: appRect.left,
        visualHeight,
        visualWidth,
        visualTop,
        visualLeft,
        documentScrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        footerDisplay: getComputedStyle(document.querySelector('footer')).display,
      };
    })()`, 10_000, 'short mobile keyboard viewport');
    assert(compactPortrait.terminalHeight > 100
      && compactPortrait.documentScrollWidth <= compactPortrait.innerWidth + 1
      && compactPortrait.footerDisplay === 'none'
      && Math.abs(compactPortrait.appHeight - compactPortrait.visualHeight) <= 2
      && Math.abs(compactPortrait.appWidth - compactPortrait.visualWidth) <= 2
      && Math.abs(compactPortrait.appTop - compactPortrait.visualTop) <= 2
      && Math.abs(compactPortrait.appLeft - compactPortrait.visualLeft) <= 2
      && layout.viewportMeta.includes('interactive-widget=resizes-content'), 'short mobile keyboard viewport collapsed, overflowed, or ignored the visual viewport', { layout, compactPortrait });

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });

    const outputFile = path.join(runtimeRoot, `mobile-key-${Date.now()}.bin`);
    const readyMarker = `__MOBILE_READY_${Date.now()}__`;
    const doneMarker = `__MOBILE_DONE_${Date.now()}__`;
    respawnPane(sessionId, rawInputFixtureCommand({
      byteCount: 1,
      outputFile,
      readyMarker,
      doneMarker,
    }));
    await page.waitFor(terminalContainsExpression(readyMarker), 20_000, 'mobile key fixture readiness');
    const clicked = await page.eval(`(() => {
      const button = document.querySelector('.mobile-terminal-keys button[data-terminal-key="Escape"]');
      button?.click();
      return Boolean(button);
    })()`);
    assert(clicked, 'mobile Escape key is missing');
    const received = await waitForFile(outputFile, (data) => data.length === 1, 10_000, 'mobile Escape byte');
    assert(received.equals(Buffer.from([0x1b])), 'mobile Escape key did not send the terminal Escape byte', {
      receivedHex: received.toString('hex'),
    });

    return {
      sessionId,
      viewport: { width: 390, height: 844 },
      horizontalOverflow,
      terminalHeight: layout.terminalHeight,
      keyCount: layout.buttons.length,
      labels: layout.buttons,
      keyStripScrollable: layout.stripScrollWidth > layout.stripClientWidth,
      escapeReceivedHex: received.toString('hex'),
      compactPortrait,
      visualViewportAware: true,
    };
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
}

function requestedCases() {
  const all = ['individual-close', 'raw-resume', 'large-input', 'focus-reports', 'runtime-epoch', 'output-isolation', 'api-surface', 'paste-history', 'mobile'];
  if (!browserOnly || browserOnly === 'high-value') return new Set(all);
  const requested = new Set(browserOnly.split(',').map((value) => value.trim()).filter(Boolean));
  const known = new Set(['quick-create', 'minimal-ui', ...all]);
  assert([...requested].every((name) => known.has(name)), `unknown WARPISH_BROWSER_ONLY case: ${browserOnly}`, { known: [...known] });
  return requested;
}

async function main() {
  assert(fs.existsSync(chromePath), `Chrome binary not found at ${chromePath}`);
  const inheritedProbe = isolatedTmuxEnvironment({ TMUX: '/tmp/parent,1,0', TMUX_PANE: '%99' });
  assert(!('TMUX' in inheritedProbe) && !('TMUX_PANE' in inheritedProbe), 'browser regressions inherited a parent tmux client environment');

  await startServer();
  const page = await startChromeWithRetry();
  browserPage = page;
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const health = await api('/healthz');
  const readiness = await api('/readyz');
  assert(readiness.ok === true, 'isolated browser server is not ready', readiness);
  const selected = requestedCases();
  const regressions = {};

  regressions.quickCreateDefaults = await testQuickCreate(page);
  regressions.minimalUi = await testMinimalUi(page);
  regressions.commandActivityIndicator = await testCommandActivityIndicator(
    page,
    regressions.quickCreateDefaults.sessionId,
  );
  if (selected.has('individual-close')) {
    regressions.individualSessionClose = await testIndividualSessionClose(
      page,
      regressions.quickCreateDefaults.sessionId,
    );
  }

  if (selected.has('raw-resume')) {
    regressions.rawXtermResume = await testRawXtermResume(page, regressions.quickCreateDefaults.sessionId);
  }
  if (selected.has('large-input')) {
    regressions.largeOrderedUtf8 = await testLargeOrderedUtf8(page);
  }
  if (selected.has('focus-reports')) {
    regressions.nativeFocusReports = await testNativeFocusReports(page);
  }
  if (selected.has('runtime-epoch')) {
    regressions.runtimeEpochInputSafety = await testRuntimeEpochInputSafety(page);
  }
  if (selected.has('output-isolation')) {
    regressions.staleOutputIsolation = await testStaleOutputIsolation(page);
  }

  let apiSurface;
  if (selected.has('api-surface') || selected.has('paste-history') || selected.has('mobile')) {
    apiSurface = await testMinimalApiSurface(regressions.quickCreateDefaults.sessionId);
    regressions.minimalApiSurface = apiSurface;
  }
  if (selected.has('paste-history')) {
    regressions.pasteAndStoppedHistory = await testPasteAffinityAndStoppedHistory(
      page,
      regressions.quickCreateDefaults.sessionId,
      apiSurface.defaultSessionId,
    );
  }
  if (selected.has('mobile')) {
    regressions.mobileLayoutAndKeys = await testMobileLayoutAndKeys(page, apiSurface.defaultSessionId);
  }

  await delay(200);
  page.assertNoUnhandledErrors(browserOnly ? `${browserOnly} browser regression` : 'browser regression suite');
  console.log(JSON.stringify({
    ok: true,
    health,
    readiness,
    browser: { chrome: chromeVersionLabel(), cdpPort },
    isolatedRuntime: { dataDir, sessionPrefix },
    requested: browserOnly || 'all',
    diagnostics: page.diagnosticSnapshot(),
    regressions,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  const diagnostics = browserPage?.diagnosticSnapshot?.();
  if (diagnostics && (diagnostics.consoleErrors.length || diagnostics.runtimeExceptions.length || diagnostics.recentLogEntries.length)) {
    error.message = `${error.message}\nBrowser diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`;
  }
  throw error;
} finally {
  try {
    if (token) {
      const payload = await api('/api/sessions');
      rememberSessions(payload.sessions);
      for (const sessionId of [...createdSessions].reverse()) {
        try { await api(`/api/sessions/${sessionId}?purge=1`, { method: 'DELETE', timeoutMs: 10_000 }); } catch {}
      }
    }
  } catch {}
  try {
    execFileSync(tmuxBin, ['list-sessions', '-F', '#S'], { encoding: 'utf8', env: tmuxEnvironment })
      .split('\n')
      .filter((name) => name.startsWith(sessionPrefix))
      .forEach((name) => {
        try { execFileSync(tmuxBin, ['kill-session', '-t', name], { env: tmuxEnvironment }); } catch {}
      });
  } catch {}
  browserPage?.close?.();
  await terminateProcess(chrome);
  await terminateProcess(server);
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
}
