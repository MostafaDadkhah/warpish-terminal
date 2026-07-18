import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const projectRoot = new URL('..', import.meta.url).pathname;
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runtimeRoot = process.env.WARPISH_BROWSER_RUNTIME_ROOT
  ? path.resolve(process.env.WARPISH_BROWSER_RUNTIME_ROOT)
  : fs.mkdtempSync(path.join('/tmp', 'warpish-browser-regressions-'));
fs.mkdirSync(runtimeRoot, { recursive: true });
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
const browserOnly = process.env.WARPISH_BROWSER_ONLY || '';
const createdSessions = [];

let server;
let chrome;
let browserPage;
let tokenUrl;
let token;
let port;
let cdpPort;
let chromeDiagnostics = { stdout: '', stderr: '', exit: null, error: null };

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isolatedTmuxEnvironment(extra = {}) {
  const env = { ...process.env, ...extra, TMUX_TMPDIR: tmuxTmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

const tmuxEnvironment = isolatedTmuxEnvironment();

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => resolve(address.port));
    });
    srv.on('error', reject);
  });
}

function httpRequest({
  host = '127.0.0.1',
  port: requestPort,
  method = 'GET',
  pathname = '/',
  headers = {},
  body,
  json = true,
  timeoutMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host,
      port: requestPort,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${pathname} -> HTTP ${res.statusCode}: ${text}`));
          return;
        }
        if (!json) {
          resolve(text);
          return;
        }
        resolve(text ? JSON.parse(text) : {});
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${host}:${requestPort}${pathname} timed out after ${timeoutMs}ms`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function api(pathname, { method = 'GET', body } = {}) {
  return httpRequest({
    port,
    pathname,
    method,
    body,
    headers: { 'x-warpish-token': token },
  });
}

function httpText(pathname) {
  return httpRequest({
    port,
    pathname,
    json: false,
    headers: { 'x-warpish-token': token },
  });
}

async function waitForServerUrl(stdoutRef, stderrRef) {
  for (let i = 0; i < 120; i += 1) {
    const match = stdoutRef.value.match(/URL: (http:\/\/[^\s]+)/);
    if (match) return match[1];
    await delay(100);
  }
  throw new Error(`server did not print URL. stdout=${stdoutRef.value}\nstderr=${stderrRef.value}`);
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
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { stdoutRef.value += chunk.toString(); });
  server.stderr.on('data', (chunk) => { stderrRef.value += chunk.toString(); });
  tokenUrl = await waitForServerUrl(stdoutRef, stderrRef);
  token = new URL(tokenUrl).searchParams.get('token');
  await httpRequest({ port, pathname: '/healthz' });
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
  const startupDeadline = Date.now() + 30_000;
  while (Date.now() < startupDeadline) {
    try {
      const remainingMs = Math.max(100, startupDeadline - Date.now());
      const list = await httpRequest({
        port: cdpPort,
        pathname: '/json/list',
        timeoutMs: Math.min(1000, remainingMs),
      });
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return new CdpPage(page.webSocketDebuggerUrl);
      lastCdpError = `CDP returned ${list.length} targets but no page target`;
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

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
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
        const msg = JSON.parse(String(raw));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: done, reject: fail } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) fail(new Error(`${msg.error.message}: ${msg.error.data || ''}`));
          else done(msg.result || {});
          return;
        }
        this.recordDiagnostic(msg);
        this.events.push(msg);
      });
    });
  }

  recordDiagnostic(msg) {
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params?.type)) {
      this.diagnostics.consoleErrors.push({
        type: msg.params.type,
        timestamp: msg.params.timestamp,
        args: (msg.params.args || []).map((arg) => arg.value ?? arg.unserializableValue ?? arg.description ?? arg.type),
        stackTrace: msg.params.stackTrace,
      });
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params?.exceptionDetails || {};
      this.diagnostics.runtimeExceptions.push({
        timestamp: msg.params?.timestamp,
        text: details.text,
        url: details.url,
        lineNumber: details.lineNumber,
        columnNumber: details.columnNumber,
        exception: details.exception?.description || details.exception?.value,
        stackTrace: details.stackTrace,
      });
      return;
    }
    if (msg.method === 'Log.entryAdded') {
      const entry = msg.params?.entry;
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
    const { consoleErrors, runtimeExceptions } = this.diagnostics;
    assert(
      consoleErrors.length === 0 && runtimeExceptions.length === 0,
      `${label} emitted console errors or unhandled runtime exceptions`,
      this.diagnosticSnapshot(),
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
      }, 15000);
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
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 15000, 'page load complete');
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

  async waitFor(expression, timeoutMs, label) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
      try {
        last = await this.eval(`(() => { try { return (${expression}); } catch (error) { return { __error: String(error) }; } })()`);
        if (last && !last.__error) return last;
      } catch (error) {
        last = String(error);
      }
      await delay(100);
    }
    throw new Error(`timed out waiting for ${label}. last=${JSON.stringify(last)}`);
  }

  async wheelAt(x, y, deltaY, deltaX = 0) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      modifiers: 0,
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function createSession(title, cwd = runtimeRoot) {
  fs.mkdirSync(cwd, { recursive: true });
  const payload = await api('/api/sessions', { method: 'POST', body: { title, cwd } });
  createdSessions.push(payload.session.id);
  return payload.session;
}

function respawnPane(sessionId, command) {
  execFileSync(tmuxBin, ['respawn-pane', '-k', '-t', sessionId, command], { stdio: 'pipe', env: tmuxEnvironment });
}

const HERMES_CONCEALED_SECRET = '__WARPISH_HERMES_CONCEALED_SECRET__';
const HERMES_AFTER_CONCEAL = 'Hermes visible after conceal';

function hermesPaletteDemoCommand() {
  const ESC = '\x1b';
  const screen = `${ESC}[2J${ESC}[HHermes readable regression fixture using captured Hermes SGR values.\n\n`
    + `${ESC}[38;2;205;127;50mHermes border${ESC}[0m\n`
    + `${ESC}[38;2;255;248;220mWelcome to Hermes Agent! Type your message or /help for commands.${ESC}[0m\n`
    + `${ESC}[2;38;2;184;134;11m✦ Tip: BROWSER_CDP_URL connects browser tools to Chromium.${ESC}[0m\n`
    + `${ESC}[1;33m⚠ 57 commits behind${ESC}[0;2;33m — run ${ESC}[1mhermes update${ESC}[0;2;33m to update${ESC}[0m\n`
    + `${ESC}[31mHermes themed base red${ESC}[0m\n`
    + `${ESC}[1;38;5;71m[██░░░░░░░░]${ESC}[0m${ESC}[38;5;136m${ESC}[48;5;234m 18% │ 7m │ ⏱ 3m 36s${ESC}[0m\n`
    + `${ESC}[38;5;173m────────────────────────────────────────${ESC}[0m\n`
    + `${ESC}[38:2::205:127:50mHermes colon truecolor${ESC}[0m\n`
    + `${ESC}[38:5:173mHermes colon 256${ESC}[0m\n`
    + `${ESC}[7;38;2;10;20;30;48;2;240;230;220mHermes inverse pair${ESC}[0m\n`
    + `${ESC}[8m${HERMES_CONCEALED_SECRET}${ESC}[28m${HERMES_AFTER_CONCEAL}${ESC}[0m\n`
    + `${ESC}[3;38;5;136m⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel${ESC}[0m\n`
    + `سلام Mostafa — خروجی فارسی/English باید خوانا بماند.\n`;
  const code = `import sys,time; sys.stdout.write(${JSON.stringify(screen)}); sys.stdout.flush(); time.sleep(90)`;
  return `python3 -c ${shellQuote(code)}`;
}

function hermesPaletteStateExpression() {
  return `(() => {
    const lines = [...document.querySelectorAll('#bidiReaderLines .bidi-line')];
    if (!lines.some((line) => line.textContent.includes('Welcome to Hermes Agent'))) return false;
    const runs = [...document.querySelectorAll('#bidiReaderLines .bidi-style-run')].map((node) => ({
      text: node.textContent,
      color: getComputedStyle(node).color,
      backgroundColor: getComputedStyle(node).backgroundColor,
      fontWeight: getComputedStyle(node).fontWeight,
      fontStyle: getComputedStyle(node).fontStyle,
      opacity: getComputedStyle(node).opacity,
      style: node.getAttribute('style') || '',
    }));
    const xtermConceal = getReadableTerminalEntries().some((entry) =>
      entry.segments?.some((segment) => segment.style?.invisible && segment.text.includes(${JSON.stringify(HERMES_CONCEALED_SECRET)})));
    const captureConceal = capturedReaderHistoryState.entries.some((entry) =>
      entry.segments?.some((segment) => segment.style?.invisible && segment.text.includes(${JSON.stringify(HERMES_CONCEALED_SECRET)})));
    if (!xtermConceal || !captureConceal) return false;
    return {
      text: lines.map((line) => line.textContent).join(String.fromCharCode(10)),
      logicalText: lines.map((line) => line.dataset.logicalText || '').join(String.fromCharCode(10)),
      readerHtml: document.getElementById('bidiReaderLines')?.innerHTML || '',
      xtermConceal,
      captureConceal,
      captureSuccessCount: bidiReaderCaptureSuccessCount,
      runs,
    };
  })()`;
}

function assertHermesPalettePayload(payload) {
  const run = (needle) => payload.runs.find((item) => item.text.includes(needle));
  const border = run('Hermes border');
  const welcome = run('Welcome to Hermes Agent');
  const tip = run('Tip: BROWSER_CDP_URL');
  const warning = run('57 commits behind');
  const progress = run('[██░░░░░░░░]');
  const progressMeta = run('18%');
  const themedRed = run('Hermes themed base red');
  const colonTruecolor = run('Hermes colon truecolor');
  const colon256 = run('Hermes colon 256');
  const inversePair = run('Hermes inverse pair');
  const promptHint = run('msg=interrupt');

  assert(border && /205\s*,\s*127\s*,\s*50/.test(border.color), 'Hermes border orange from captured SGR was not preserved', payload);
  assert(welcome && /255\s*,\s*248\s*,\s*220/.test(welcome.color), 'Hermes warm welcome foreground was not preserved', payload);
  assert(tip && /184\s*,\s*134\s*,\s*11/.test(tip.color) && Number(tip.opacity) < 1, 'Hermes dim gold tip styling was not preserved', payload);
  assert(warning && /253\s*,\s*230\s*,\s*138/.test(warning.color) && Number.parseInt(warning.fontWeight, 10) >= 700, 'Hermes bold yellow warning styling did not match the xterm theme', payload);
  assert(progress && /95\s*,\s*175\s*,\s*95/.test(progress.color) && Number.parseInt(progress.fontWeight, 10) >= 700, 'Hermes green progress styling was not preserved', payload);
  assert(progressMeta && /175\s*,\s*135\s*,\s*0/.test(progressMeta.color) && /28\s*,\s*28\s*,\s*28/.test(progressMeta.backgroundColor), 'Hermes progress metadata foreground/background was not preserved', payload);
  assert(themedRed && /251\s*,\s*113\s*,\s*133/.test(themedRed.color), 'base ANSI red did not match the raw xterm theme', payload);
  assert(colonTruecolor && /205\s*,\s*127\s*,\s*50/.test(colonTruecolor.color), 'colon-form Hermes truecolor SGR was not preserved', payload);
  assert(colon256 && /215\s*,\s*135\s*,\s*95/.test(colon256.color), 'colon-form Hermes 256-color SGR was not preserved', payload);
  assert(inversePair && /240\s*,\s*230\s*,\s*220/.test(inversePair.color) && /10\s*,\s*20\s*,\s*30/.test(inversePair.backgroundColor), 'inverse ANSI foreground/background styling was not preserved', payload);
  assert(promptHint && /175\s*,\s*135\s*,\s*0/.test(promptHint.color) && promptHint.fontStyle === 'italic', 'Hermes prompt hint italic/gold styling was not preserved', payload);
  assert(payload.text.includes(HERMES_AFTER_CONCEAL), 'SGR 28 did not restore visible terminal text', payload);
  assert(!payload.text.includes(HERMES_CONCEALED_SECRET) && !payload.logicalText.includes(HERMES_CONCEALED_SECRET) && !payload.readerHtml.includes(HERMES_CONCEALED_SECRET), 'SGR 8 concealed text leaked into the readable DOM or copy surface', payload);
  assert(payload.xtermConceal && payload.captureConceal, 'conceal styling was not preserved in both xterm and tmux capture paths', payload);
}

async function testHermesPaletteStyles(page) {
  const session = await createSession('Hermes Palette Regression', path.join(runtimeRoot, 'hermes-palette-cwd'));
  respawnPane(session.id, hermesPaletteDemoCommand());
  await delay(800);
  await page.navigate(`${tokenUrl}&case=hermes-palette`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Hermes Palette Regression')`, 15000, 'Hermes palette session selected');
  const payload = await page.waitFor(hermesPaletteStateExpression(), 15000, 'styled Hermes palette reader output');
  const samples = [payload];
  for (let index = 0; index < 3; index += 1) {
    await page.eval(`refreshBidiReaderFromCapture({ preferCapture: true })`);
    await delay(750);
    samples.push(await page.eval(hermesPaletteStateExpression()));
  }
  samples.forEach(assertHermesPalettePayload);
  assert(samples.every((sample, index) => index === 0 || sample.captureSuccessCount >= samples[index - 1].captureSuccessCount), 'Hermes palette capture success counter regressed', samples);
  assert(samples.at(-1).captureSuccessCount >= payload.captureSuccessCount + 3, 'Hermes palette refresh loop did not complete three successful tmux captures', samples.map((sample) => sample.captureSuccessCount));

  return {
    ok: true,
    stableSamples: samples.length,
    styledRuns: payload.runs.filter((item) => item.style).map((item) => item.text),
  };
}

async function testCapturedHistoryReducer(page) {
  const payload = await page.eval(`(() => {
    const entries = (prefix, count) => Array.from({ length: count }, (_, index) => ({ text: prefix + '_' + String(index).padStart(4, '0'), segments: [] }));
    let state = reduceCapturedReaderHistory({}, entries('OLD', 200));
    const initial = { count: state.entries.length, first: state.entries[0]?.text, last: state.entries.at(-1)?.text };
    state = reduceCapturedReaderHistory(state, entries('SHORT', 20));
    const firstShort = { count: state.entries.length, pending: Boolean(state.pendingReset), first: state.entries[0]?.text };
    state = reduceCapturedReaderHistory(state, entries('NEW', 20));
    const confirmedShort = { count: state.entries.length, pending: Boolean(state.pendingReset), first: state.entries[0]?.text };
    state = reduceCapturedReaderHistory(state, entries('EQUAL_RESET', 20));
    const equalReset = { count: state.entries.length, first: state.entries[0]?.text };
    state = reduceCapturedReaderHistory(state, []);
    const firstEmpty = { count: state.entries.length, pending: Boolean(state.pendingReset) };
    state = reduceCapturedReaderHistory(state, []);
    const confirmedEmpty = { count: state.entries.length, pending: Boolean(state.pendingReset), known: state.known };

    let recovered = reduceCapturedReaderHistory({}, entries('RECOVER', 200));
    recovered = reduceCapturedReaderHistory(recovered, entries('TRANSIENT', 10));
    recovered = reduceCapturedReaderHistory(recovered, entries('RECOVERED', 201));
    const recovery = { count: recovered.entries.length, pending: Boolean(recovered.pendingReset), first: recovered.entries[0]?.text };

    const rolling = reduceCapturedReaderHistory({}, entries('ROLLING', 2500));

    const savedCaptureState = {
      mode: bidiReaderCaptureMode,
      historyState: capturedReaderHistoryState,
      historyRevision: capturedReaderHistoryRevision,
      historyNeedsLiveScreen: capturedReaderHistoryNeedsLiveScreen,
      screenKnown: capturedReaderScreenKnown,
      screenEntries: capturedReaderScreenEntries,
      screenRevision: capturedReaderScreenRevision,
    };
    capturedReaderHistoryState = { known: true, entries: entries('HISTORY_ONLY', 3), pendingReset: null, committed: true };
    capturedReaderHistoryRevision = terminalOutputRevision;
    capturedReaderHistoryNeedsLiveScreen = false;
    capturedReaderScreenKnown = true;
    capturedReaderScreenEntries = entries('SCREEN_ONLY', 2);
    capturedReaderScreenRevision = terminalOutputRevision;
    bidiReaderCaptureMode = 'screen';
    const screenSelection = currentBidiReaderRenderState().entries.map((entry) => entry.text);
    bidiReaderCaptureMode = 'history';
    const historySelection = currentBidiReaderRenderState().entries.map((entry) => entry.text);
    capturedReaderHistoryState = { known: true, entries: [], pendingReset: null, committed: true };
    capturedReaderHistoryRevision = terminalOutputRevision;
    const knownEmptySelection = currentBidiReaderRenderState().entries.map((entry) => entry.text);
    bidiReaderCaptureMode = savedCaptureState.mode;
    capturedReaderHistoryState = savedCaptureState.historyState;
    capturedReaderHistoryRevision = savedCaptureState.historyRevision;
    capturedReaderHistoryNeedsLiveScreen = savedCaptureState.historyNeedsLiveScreen;
    capturedReaderScreenKnown = savedCaptureState.screenKnown;
    capturedReaderScreenEntries = savedCaptureState.screenEntries;
    capturedReaderScreenRevision = savedCaptureState.screenRevision;

    const renderState = currentBidiReaderRenderState();
    renderBidiReader(renderState.entries, { source: renderState.source });
    const firstNode = document.getElementById('bidiReaderLines')?.firstElementChild;
    renderBidiReader(renderState.entries, { force: true, source: renderState.source });
    const identicalRenderPreserved = firstNode === document.getElementById('bidiReaderLines')?.firstElementChild;

    const mixedPrefix = { text: '', segments: [] };
    appendStyledSegmentsToEntry(mixedPrefix, 'plain-prefix ', []);
    appendStyledSegmentsToEntry(mixedPrefix, 'colored-suffix', [{ text: 'colored-suffix', style: { fg: 'rgb(205, 127, 50)' } }]);
    const mixedSuffix = { text: '', segments: [] };
    appendStyledSegmentsToEntry(mixedSuffix, 'colored-prefix ', [{ text: 'colored-prefix ', style: { fg: 'rgb(205, 127, 50)' } }]);
    appendStyledSegmentsToEntry(mixedSuffix, 'plain-suffix', []);
    const mixedPrefixNode = document.createElement('div');
    const mixedSuffixNode = document.createElement('div');
    renderBidiLine(mixedPrefixNode, mixedPrefix);
    renderBidiLine(mixedSuffixNode, mixedSuffix);
    const mixedWrappedStyles = {
      prefixText: mixedPrefixNode.textContent,
      suffixText: mixedSuffixNode.textContent,
      prefixCoverage: mixedPrefix.segments.map((segment) => segment.text).join(''),
      suffixCoverage: mixedSuffix.segments.map((segment) => segment.text).join(''),
    };
    return {
      initial,
      firstShort,
      confirmedShort,
      equalReset,
      firstEmpty,
      confirmedEmpty,
      recovery,
      rolling: { count: rolling.entries.length, first: rolling.entries[0]?.text, last: rolling.entries.at(-1)?.text },
      semanticCaches: { screenSelection, historySelection, knownEmptySelection },
      identicalRenderPreserved,
      mixedWrappedStyles,
    };
  })()`);

  assert(payload.initial.count === 200 && payload.initial.first === 'OLD_0000', 'canonical history reducer did not accept its initial snapshot', payload);
  assert(payload.firstShort.count === 200 && payload.firstShort.pending && payload.firstShort.first === 'OLD_0000', 'one transient short capture collapsed canonical history', payload);
  assert(payload.confirmedShort.count === 20 && !payload.confirmedShort.pending && payload.confirmedShort.first === 'NEW_0000', 'confirmed history shrink was not committed', payload);
  assert(payload.equalReset.count === 20 && payload.equalReset.first === 'EQUAL_RESET_0000', 'equal-length history discontinuity retained stale lines', payload);
  assert(payload.firstEmpty.count === 20 && payload.firstEmpty.pending, 'first empty history snapshot was not held for confirmation', payload);
  assert(payload.confirmedEmpty.known && payload.confirmedEmpty.count === 0 && !payload.confirmedEmpty.pending, 'confirmed empty history did not clear canonical scrollback', payload);
  assert(payload.recovery.count === 201 && !payload.recovery.pending && payload.recovery.first === 'RECOVERED_0000', 'history recovery did not cancel a transient shrink', payload);
  assert(payload.rolling.count === 2000 && payload.rolling.first === 'ROLLING_0500' && payload.rolling.last === 'ROLLING_2499', 'canonical history reducer did not enforce its 2000-line rolling window', payload);
  assert(payload.semanticCaches.screenSelection.every((line) => line.startsWith('SCREEN_ONLY_')) && payload.semanticCaches.historySelection.every((line) => line.startsWith('HISTORY_ONLY_')), 'screen and history capture caches contaminated each other', payload);
  assert(payload.semanticCaches.knownEmptySelection.length === 0, 'known-empty canonical history resurrected stale xterm scrollback', payload);
  assert(payload.identicalRenderPreserved, 'identical reader content rebuilt the DOM despite the stable render key', payload);
  assert(payload.mixedWrappedStyles.prefixText === 'plain-prefix colored-suffix' && payload.mixedWrappedStyles.prefixCoverage === payload.mixedWrappedStyles.prefixText, 'unstyled wrapped prefix disappeared before a colored continuation', payload);
  assert(payload.mixedWrappedStyles.suffixText === 'colored-prefix plain-suffix' && payload.mixedWrappedStyles.suffixCoverage === payload.mixedWrappedStyles.suffixText, 'unstyled wrapped suffix disappeared after a colored prefix', payload);
  return { ok: true, ...payload };
}

function hermesHistoryRedrawCommand({
  topMarker,
  bottomMarker,
  readyMarker,
  liveMarker,
  tickMarker,
  colorMarker,
  triggerFile,
  historyLines = 220,
}) {
  const script = [
    'import os, sys, time',
    `top = ${JSON.stringify(topMarker)}`,
    `bottom = ${JSON.stringify(bottomMarker)}`,
    `ready = ${JSON.stringify(readyMarker)}`,
    `live = ${JSON.stringify(liveMarker)}`,
    `tick_marker = ${JSON.stringify(tickMarker)}`,
    `color = ${JSON.stringify(colorMarker)}`,
    `trigger = ${JSON.stringify(triggerFile)}`,
    `count = ${Number(historyLines)}`,
    'ESC = "\\x1b"',
    'for index in range(count):',
    '    marker = top if index == 0 else (bottom if index == count - 1 else f"HISTORY_{index:03d}")',
    '    sys.stdout.write(f"{ESC}[38;2;205;127;50m{color}{ESC}[0m ⚕ gpt-5.6-sol {marker} stable history line {index:03d}\\n")',
    'sys.stdout.write(f"{ready}\\n")',
    'sys.stdout.flush()',
    'deadline = time.monotonic() + 45',
    'while not os.path.exists(trigger) and time.monotonic() < deadline:',
    '    time.sleep(0.02)',
    'if not os.path.exists(trigger):',
    '    raise SystemExit(42)',
    'sys.stdout.write(f"{ESC}[?1049h")',
    'sys.stdout.flush()',
    'for tick in range(20):',
    '    frame = [f"{ESC}[2J{ESC}[H", f"{ESC}[38;2;205;127;50m{live}{ESC}[0m Hermes live redraw\\n"]',
    '    for row in range(1, 13):',
    '        frame.append(f"alternate row {row:02d} tick {tick:02d}{ESC}[K\\n")',
    '    frame.append(f"{ESC}[1;38;5;71m[██░░░░░░░░]{ESC}[0m {tick_marker} tick={tick:02d}{ESC}[K")',
    '    sys.stdout.write("".join(frame))',
    '    sys.stdout.flush()',
    '    time.sleep(0.65)',
    'time.sleep(30)',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

async function testHermesReadableHistoryDoesNotOscillate(page) {
  const suffix = Date.now().toString(36);
  const topMarker = `H_TOP_${suffix}`;
  const bottomMarker = `H_BOTTOM_${suffix}`;
  const readyMarker = `H_READY_${suffix}`;
  const liveMarker = `H_LIVE_${suffix}`;
  const tickMarker = `H_TICK_${suffix}`;
  const colorMarker = `H_BRICK_${suffix}`;
  const triggerFile = path.join(runtimeRoot, `hermes-redraw-trigger-${suffix}`);
  const session = await createSession('Hermes Readable Oscillation Regression', path.join(runtimeRoot, 'hermes-oscillation-cwd'));
  await page.navigate(`${tokenUrl}&case=hermes-readable-oscillation`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Hermes Readable Oscillation Regression')`, 15000, 'Hermes oscillation session selected');
  await page.waitFor(`terminalControlRole === 'controller'`, 15000, 'Hermes oscillation terminal controller');
  await page.eval(`document.fonts?.ready || Promise.resolve()`);
  const connectedRevision = await page.eval(`terminalOutputRevision`);

  const stateExpression = `(() => {
    const reader = document.getElementById('bidiReaderLines');
    const lines = reader ? [...reader.querySelectorAll('.bidi-line:not(.empty-state)')] : [];
    const logical = lines.map((line) => line.dataset.logicalText || line.textContent || '');
    const colorRun = [...document.querySelectorAll('#bidiReaderLines .bidi-style-run')]
      .find((node) => node.textContent.includes(${JSON.stringify(colorMarker)}));
    const liveColorRun = [...document.querySelectorAll('#bidiReaderLines .bidi-style-run')]
      .find((node) => node.textContent.includes(${JSON.stringify(liveMarker)}));
    const tickLine = logical.find((line) => line.includes(${JSON.stringify(tickMarker)})) || '';
    const tickMatch = tickLine.match(/tick=(\\d+)/);
    return {
      lineCount: lines.length,
      scrollHeight: reader?.scrollHeight || 0,
      maxScrollTop: reader ? Math.max(0, reader.scrollHeight - reader.clientHeight) : 0,
      atBottom: reader ? Math.abs(reader.scrollHeight - reader.clientHeight - reader.scrollTop) <= 10 : false,
      topCount: logical.filter((line) => line.includes(${JSON.stringify(topMarker)})).length,
      bottomCount: logical.filter((line) => line.includes(${JSON.stringify(bottomMarker)})).length,
      readyCount: logical.filter((line) => line.includes(${JSON.stringify(readyMarker)})).length,
      liveCount: logical.filter((line) => line.includes(${JSON.stringify(liveMarker)})).length,
      tick: tickMatch ? Number(tickMatch[1]) : -1,
      revision: terminalOutputRevision,
      captureAt: lastBidiReaderCaptureAt,
      alternate: isTerminalAlternateBuffer(),
      source: lastBidiReaderRenderSource,
      captureMode: bidiReaderCaptureMode,
      color: colorRun ? getComputedStyle(colorRun).color : '',
      liveColor: liveColorRun ? getComputedStyle(liveColorRun).color : '',
    };
  })()`;

  respawnPane(session.id, hermesHistoryRedrawCommand({
    topMarker,
    bottomMarker,
    readyMarker,
    liveMarker,
    tickMarker,
    colorMarker,
    triggerFile,
  }));
  await page.waitFor(`(() => {
    const state = ${stateExpression};
    return state.topCount === 1 && state.bottomCount === 1 && state.readyCount === 1 && state.liveCount === 0
      ? state
      : false;
  })()`, 20000, 'Hermes primary history before alternate transition');
  await page.eval(`refreshBidiReaderFromCapture({ preferCapture: true, keepScroll: true })`);
  const primary = await page.waitFor(`(() => {
    const state = ${stateExpression};
    return state.topCount === 1 && state.bottomCount === 1 && state.readyCount === 1 && state.liveCount === 0
      && state.captureMode === 'history' && state.source === 'capture' && state.revision > ${Number(connectedRevision)}
      ? state
      : false;
  })()`, 20000, 'canonical Hermes primary history capture');
  const primaryCapture = await api(`/api/sessions/${session.id}/capture?lines=5000&ansi=1`);
  assert(primaryCapture.usingAlternate === false && primaryCapture.alternateActive === false, 'primary Hermes history was misclassified as an alternate screen', primaryCapture);
  assert(primaryCapture.text.includes(topMarker) && primaryCapture.text.includes(bottomMarker) && !primaryCapture.alternate.includes(liveMarker), 'primary Hermes history capture lost its stable markers', primaryCapture);

  fs.writeFileSync(triggerFile, 'go');
  const baseline = await page.waitFor(`(() => {
    const state = ${stateExpression};
    return state.topCount === 1 && state.bottomCount === 1 && state.liveCount === 1 && state.tick >= 2
      && state.captureMode === 'history' && state.source === 'capture' && state.revision > ${Number(primary.revision)}
      ? state
      : false;
  })()`, 20000, 'Hermes live primary-to-alternate transition');

  let alternateCapture = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    alternateCapture = await api(`/api/sessions/${session.id}/capture?lines=5000&ansi=1`);
    if (
      alternateCapture.alternateActive === true
      && alternateCapture.captureReason === 'normal-rich-history'
      && alternateCapture.text.includes(topMarker)
      && alternateCapture.text.includes(bottomMarker)
      && alternateCapture.active.includes(liveMarker)
      && alternateCapture.active.includes(tickMarker)
    ) break;
    await delay(100);
  }
  assert(alternateCapture?.captureReason === 'normal-rich-history' && alternateCapture?.usingAlternate === false, 'Hermes rich history was not preferred over its fixed alternate viewport', alternateCapture);
  assert(alternateCapture?.alternateActive === true && alternateCapture?.active.includes(liveMarker) && alternateCapture?.active.includes(tickMarker), 'Hermes active alternate viewport was not captured while redraws were active', alternateCapture);

  const samples = [];
  for (let index = 0; index < 28; index += 1) {
    samples.push(await page.eval(stateExpression));
    await delay(250);
  }

  const measured = [baseline, ...samples];
  const lineCounts = measured.map((sample) => sample.lineCount);
  const scrollHeights = measured.map((sample) => sample.scrollHeight);
  const ticks = measured.map((sample) => sample.tick);
  const revisions = measured.map((sample) => sample.revision);
  const captureTimes = measured.map((sample) => sample.captureAt);
  const lineSpread = Math.max(...lineCounts) - Math.min(...lineCounts);
  const scrollHeightSpread = Math.max(...scrollHeights) - Math.min(...scrollHeights);
  assert(measured.every((sample) => sample.topCount === 1 && sample.bottomCount === 1), 'canonical Hermes history disappeared or duplicated during redraw', { baseline, samples });
  assert(measured.every((sample) => sample.liveCount === 1), 'Hermes live tail disappeared or duplicated during redraw', { baseline, samples });
  assert(measured.every((sample) => sample.captureMode === 'history' && sample.source === 'capture'), 'Readable ping-ponged between xterm and capture after history latch', { baseline, samples });
  assert(lineSpread <= 2, 'Readable line count oscillated while Hermes only redrew its fixed live screen', { baseline, lineSpread, lineCounts, samples });
  assert(scrollHeightSpread <= 60, 'Readable scroll range oscillated while Hermes only redrew its fixed live screen', { baseline, scrollHeightSpread, scrollHeights, samples });
  assert(measured.every((sample) => /205\s*,\s*127\s*,\s*50/.test(sample.color)), 'Hermes brick color disappeared during live/capture refreshes', { baseline, samples });
  assert(measured.every((sample) => /205\s*,\s*127\s*,\s*50/.test(sample.liveColor)), 'Hermes live redraw color was flattened instead of preserving its brick SGR', { baseline, samples });
  assert(measured.every((sample) => sample.atBottom), 'Readable lost its pinned bottom during fixed Hermes redraws', { baseline, samples });
  assert(measured.every((sample) => sample.tick >= 0) && ticks.every((tick, index) => index === 0 || tick >= ticks[index - 1]), 'Hermes frame ticks regressed or disappeared from the readable surface', { baseline, ticks, samples });
  assert(new Set(ticks).size >= 4 && Math.max(...ticks) - Math.min(...ticks) >= 3, 'Hermes redraw fixture did not advance enough to rule out a frozen reader', { baseline, ticks, samples });
  assert(revisions.every((revision, index) => index === 0 || revision >= revisions[index - 1]) && new Set(revisions).size >= 3 && revisions.at(-1) > revisions[0], 'terminal output revisions did not advance during Hermes redraw sampling', { baseline, revisions, samples });
  assert(new Set(captureTimes).size >= 2 && captureTimes.at(-1) > captureTimes[0], 'settled tmux captures did not run while Hermes redraws were active', { baseline, captureTimes, samples });

  return {
    ok: true,
    sampleCount: measured.length,
    lineCount: baseline.lineCount,
    lineSpread,
    scrollHeightSpread,
    tickRange: [Math.min(...ticks), Math.max(...ticks)],
    revisionRange: [revisions[0], revisions.at(-1)],
    captureRefreshes: new Set(captureTimes).size,
    primaryCaptureReason: primaryCapture.captureReason,
    alternateCaptureReason: alternateCapture.captureReason,
    sources: [...new Set(samples.map((sample) => sample.source))],
    captureModes: [...new Set(samples.map((sample) => sample.captureMode))],
  };
}

function readableLinkDemoShellCommand() {
  const lines = [
    'Readable link regression fixture.',
    'Source: https://example.com/path?q=1.',
    'Docs: www.example.org/docs and encoded: https://api.torob.com/v4/base-product/search/?page=0&query=مودم',
    'Persian URL: https://samennetwork.ir/product/مودم-4g-lte-قابل-حمل/',
  ];
  return `printf '%b\\n' ${lines.map((line) => shellQuote(line)).join(' ')}`;
}

async function testReadableLinksOpenNewTabs(page) {
  const session = await createSession('Readable Link Regression', path.join(runtimeRoot, 'link-cwd'));
  respawnPane(session.id, `${readableLinkDemoShellCommand()}; sleep 90`);
  await delay(500);
  await page.navigate(`${tokenUrl}&case=readable-links`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Readable Link Regression')`, 15000, 'readable-link session selected');
  const controlPayload = await page.eval(`(() => {
    const host = document.createElement('div');
    renderBidiRuns(host, 'Control boundary: https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19' + String.fromCharCode(27) + '\\\\Hermes');
    const link = host.querySelector('a.bidi-link');
    return { text: host.textContent, linkText: link?.textContent || '', href: link?.href || '', target: link?.target || '', rel: link?.rel || '' };
  })()`);
  assert(controlPayload.linkText === 'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19', 'control bytes or following text leaked into direct link text', controlPayload);
  assert(controlPayload.href === 'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19', 'control bytes or following text leaked into direct link href', controlPayload);
  assert(controlPayload.text.includes('v2026.6.19 Hermes'), 'control boundary should remain readable as a text boundary', controlPayload);
  await page.waitFor(`document.querySelector('#statusText')?.textContent.includes('connected')`, 15000, 'readable-link terminal connected');
  await page.eval(`refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })`);
  let payload = null;
  let lastReadableLinkState = null;
  const readableLinksDeadline = Date.now() + 15000;
  while (Date.now() < readableLinksDeadline) {
    lastReadableLinkState = await page.eval(`(() => {
      const readerText = document.querySelector('#bidiReaderLines')?.innerText || '';
      const anchors = [...document.querySelectorAll('#bidiReaderLines a.bidi-link')].map((node) => ({
        text: node.textContent,
        href: node.href,
        decodedHref: decodeURI(node.href),
        target: node.target,
        rel: node.rel,
        dir: node.dir,
        title: node.title,
        textDecorationLine: getComputedStyle(node).textDecorationLine,
        cursor: getComputedStyle(node).cursor,
      }));
      return {
        ready: readerText.includes('Readable link regression fixture.') && readerText.includes('Persian URL:') && anchors.length >= 4,
        anchors,
        readerText,
        lineCount: readerText ? readerText.split(String.fromCharCode(10)).length : 0,
        bodyClass: document.body.className,
        readerDisplay: getComputedStyle(document.getElementById('bidiReader')).display,
      };
    })()`);
    if (lastReadableLinkState.ready) {
      payload = lastReadableLinkState;
      break;
    }
    await delay(150);
  }
  assert(payload, 'readable links were not rendered as anchors', lastReadableLinkState);

  const byText = (needle) => payload.anchors.filter((link) => link.text.includes(needle)).at(-1);
  const example = byText('https://example.com/path?q=1');
  const www = byText('www.example.org/docs');
  const torob = byText('api.torob.com');
  const persian = byText('samennetwork.ir/product/مودم');

  assert(example && example.href === 'https://example.com/path?q=1', 'http link href should exclude trailing punctuation', payload);
  assert(payload.readerText.includes('https://example.com/path?q=1.'), 'trailing punctuation should remain visible after the link', payload);
  assert(www && www.href === 'https://www.example.org/docs', 'www link should normalize to https href', payload);
  assert(torob && torob.decodedHref.includes('query=مودم'), 'unicode query link was not preserved', payload);
  assert(persian && persian.decodedHref.includes('/product/مودم-4g-lte-قابل-حمل/'), 'Persian path link was not preserved', payload);
  for (const link of [example, www, torob, persian]) {
    assert(link.target === '_blank', 'readable terminal links must open in a new tab', payload);
    assert(link.rel.includes('noopener') && link.rel.includes('noreferrer'), 'readable terminal links need safe rel attributes', payload);
    assert(link.dir === 'ltr', 'readable terminal links should render as LTR islands', payload);
    assert(link.textDecorationLine.includes('underline') && link.cursor === 'pointer', 'readable terminal links should look clickable', payload);
  }

  return { ok: true, anchors: payload.anchors.map((link) => ({ text: link.text, href: link.href, target: link.target })) };
}

async function testEmptyReaderDoesNotBlankTerminal(page) {
  const payload = await page.eval(`(() => {
    const reader = document.getElementById('bidiReader');
    const xtermScreen = document.querySelector('#terminal .xterm-screen');
    document.body.classList.add('bidi-mode');
    document.body.classList.remove('bidi-reader-has-content');
    reader?.classList.remove('has-content');
    return {
      readerDisplay: reader ? getComputedStyle(reader).display : null,
      xtermOpacity: xtermScreen ? getComputedStyle(xtermScreen).opacity : null,
      bodyClass: document.body.className,
    };
  })()`);
  assert(payload.readerDisplay === 'none', 'empty readable overlay is still visible and can blank the terminal', payload);
  assert(payload.xtermOpacity !== '0', 'raw xterm screen is hidden while reader has no content', payload);
  return payload;
}

function longHermesScrollbackCommand({ topMarker, bottomMarker, lines = 650 }) {
  const script = [
    'import sys,time',
    `print(${JSON.stringify(`${topMarker} Welcome to Hermes Agent long readable answer`)})`,
    `for i in range(1, ${Number(lines) + 1}):`,
    `    print(f"Hermes long answer line {i:04d}: مودم همراه دو سیم کارته / dual-SIM MiFi explanation continues")`,
    `print(${JSON.stringify(bottomMarker)})`,
    'sys.stdout.flush()',
    'time.sleep(90)',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

function terminal56AlternateScrollCommand({ topMarker, bottomMarker, readyMarker, lines = 360 }) {
  const script = [
    'import sys',
    `print(${JSON.stringify(`${topMarker} Welcome to Hermes Agent — Terminal 56 long readable answer`)})`,
    `for i in range(1, ${Number(lines) + 1}):`,
    `    print(f"Terminal 56 history line {i:04d}: فارسی + English scrollback should stay reachable while typing")`,
    // This mirrors the tmux/Hermes failure mode: the active capture keeps the long
    // history plus the live alternate viewport, while `capture-pane -a` exposes the
    // saved primary tail. The reader reconstructs canonical history from both
    // and merges the active viewport only once.
    `sys.stdout.write('\\033[?1049h\\033[2J\\033[H')`,
    `print(${JSON.stringify('Terminal 56 alternate visible tail starts')})`,
    `print(${JSON.stringify(bottomMarker)})`,
    `print(${JSON.stringify(readyMarker)})`,
    'sys.stdout.flush()',
    'for line in sys.stdin:',
    `    print('INPUT_ECHO:' + line.strip())`,
    '    sys.stdout.flush()',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

function terminal56ScrollableInputCommand({ topMarker, bottomMarker, readyMarker, lines = 360 }) {
  const script = [
    'import sys',
    `print(${JSON.stringify(`${topMarker} Welcome to Hermes Agent — Terminal 56 scroll/typing surface`)})`,
    `for i in range(1, ${Number(lines) + 1}):`,
    `    print(f"Terminal 56 scrollable line {i:04d}: فارسی + English history must not jump when typing")`,
    `print(${JSON.stringify(bottomMarker)})`,
    `print(${JSON.stringify(readyMarker)})`,
    'sys.stdout.flush()',
    'for line in sys.stdin:',
    `    print('INPUT_ECHO:' + line.strip())`,
    '    sys.stdout.flush()',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

function alternateReconnectRelativeUpdateCommand({
  primaryMarker,
  oldMarker,
  bottomMarker,
  relativeMarker,
  updateTrigger,
  exitTrigger,
}) {
  const script = [
    'import os, sys, time',
    `primary = ${JSON.stringify(primaryMarker)}`,
    `old = ${JSON.stringify(oldMarker)}`,
    `bottom = ${JSON.stringify(bottomMarker)}`,
    `relative = ${JSON.stringify(relativeMarker)}`,
    `update_trigger = ${JSON.stringify(updateTrigger)}`,
    `exit_trigger = ${JSON.stringify(exitTrigger)}`,
    'ESC = "\\x1b"',
    'sys.stdout.write(primary + "\\n")',
    'sys.stdout.write(f"{ESC}[?1049h{ESC}[2J{ESC}[H")',
    'sys.stdout.write(f"{ESC}[3;1H{old}{ESC}[20;1H{bottom}{ESC}[3;7H")',
    'sys.stdout.flush()',
    'deadline = time.monotonic() + 30',
    'while not os.path.exists(update_trigger) and time.monotonic() < deadline:',
    '    time.sleep(0.02)',
    'if not os.path.exists(update_trigger):',
    '    raise SystemExit(41)',
    'sys.stdout.write(f"\\r{ESC}[2K{relative}")',
    'sys.stdout.flush()',
    'deadline = time.monotonic() + 30',
    'while not os.path.exists(exit_trigger) and time.monotonic() < deadline:',
    '    time.sleep(0.02)',
    'if not os.path.exists(exit_trigger):',
    '    raise SystemExit(42)',
    'sys.stdout.write(f"{ESC}[?1049l")',
    'sys.stdout.flush()',
    'time.sleep(10)',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

function shortHistoryTypingCommand({ topMarker, bottomMarker, prompt }) {
  const history = [
    topMarker,
    'Short history line 2: reader context must remain visible.',
    'Short history line 3: typing may only update the active tail.',
    'Short history line 4: capture refresh must not replace the reader.',
    'Short history line 5: Backspace must restore the prompt tail.',
    bottomMarker,
  ];
  const screen = `\x1b[2J\x1b[H${history.join('\n')}\n${prompt}`;
  const script = [
    'import os, sys, termios, tty',
    `sys.stdout.write(${JSON.stringify(screen)})`,
    'sys.stdout.flush()',
    'fd = sys.stdin.fileno()',
    'old = termios.tcgetattr(fd)',
    'tty.setraw(fd)',
    'current = []',
    'try:',
    '    while True:',
    '        data = os.read(fd, 64)',
    '        if not data:',
    '            break',
    '        for value in data:',
    '            if value in (8, 127):',
    '                if current:',
    '                    current.pop()',
    '                    os.write(sys.stdout.fileno(), b"\\b \\b")',
    '            elif value in (10, 13):',
    '                os.write(sys.stdout.fileno(), b"\\r\\n")',
    `                os.write(sys.stdout.fileno(), ${JSON.stringify(prompt)}.encode())`,
    '                current = []',
    '            elif 32 <= value < 127:',
    '                current.append(chr(value))',
    '                os.write(sys.stdout.fileno(), bytes([value]))',
    'finally:',
    '    termios.tcsetattr(fd, termios.TCSADRAIN, old)',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

function clipboardShortcutInputLogCommand({ readyMarker, inputLog, stateFile }) {
  const screen = `\x1b[?2004h\x1b[2J\x1b[HClipboard shortcut regression line 1\nClipboard shortcut regression line 2\nClipboard shortcut regression line 3\n${readyMarker}\nCLIPBOARD>`;
  const script = [
    'import json, os, sys, termios, tty',
    `input_log = ${JSON.stringify(inputLog)}`,
    `state_file = ${JSON.stringify(stateFile)}`,
    'open(input_log, "wb").close()',
    'draft = bytearray()',
    'submissions = []',
    'pending = bytearray()',
    'bracketed = False',
    'def write_state():',
    '    temporary = state_file + ".tmp"',
    '    with open(temporary, "w", encoding="utf-8") as handle:',
    '        json.dump({"draft": draft.decode("utf-8", errors="replace"), "submissions": submissions, "bracketed": bracketed}, handle, ensure_ascii=False)',
    '    os.replace(temporary, state_file)',
    'def consume(data):',
    '    global bracketed',
    '    pending.extend(data)',
    '    paste_start = b"\x1b[200~"',
    '    paste_end = b"\x1b[201~"',
    '    while pending:',
    '        if pending.startswith(paste_start):',
    '            del pending[:len(paste_start)]',
    '            bracketed = True',
    '            continue',
    '        if pending.startswith(paste_end):',
    '            del pending[:len(paste_end)]',
    '            bracketed = False',
    '            continue',
    '        if pending[0] == 27 and (paste_start.startswith(bytes(pending)) or paste_end.startswith(bytes(pending))):',
    '            break',
    '        value = pending.pop(0)',
    '        if value == 21 and not bracketed:',
    '            draft.clear()',
    '        elif value in (10, 13):',
    '            if bracketed:',
    '                draft.extend(b"\\n")',
    '            else:',
    '                submissions.append(draft.decode("utf-8", errors="replace"))',
    '                draft.clear()',
    '        else:',
    '            draft.append(value)',
    '    write_state()',
    'write_state()',
    `sys.stdout.write(${JSON.stringify(screen)})`,
    'sys.stdout.flush()',
    'fd = sys.stdin.fileno()',
    'old = termios.tcgetattr(fd)',
    'tty.setraw(fd)',
    'try:',
    '    while True:',
    '        data = os.read(fd, 128)',
    '        if not data:',
    '            break',
    '        with open(input_log, "ab") as handle:',
    '            handle.write(data)',
    '            handle.flush()',
    '            os.fsync(handle.fileno())',
    '        consume(data)',
    '        os.write(sys.stdout.fileno(), data)',
    'finally:',
    '    termios.tcsetattr(fd, termios.TCSADRAIN, old)',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

function readerSelectionUpdateCommand({ selectionMarker, prompt, suggestion, triggerFile, liveMarker }) {
  const history = [
    'Reader selection regression line 1',
    'Reader selection regression line 2',
    selectionMarker,
    'Reader selection regression line 4',
  ].join('\n');
  const screen = `\x1b[2J\x1b[H${history}\n${prompt}${suggestion}\x1b[${suggestion.length}D`;
  const script = [
    'import os, sys, time',
    `trigger_file = ${JSON.stringify(triggerFile)}`,
    `sys.stdout.write(${JSON.stringify(screen)})`,
    'sys.stdout.flush()',
    'deadline = time.time() + 30',
    'while time.time() < deadline and not os.path.exists(trigger_file):',
    '    time.sleep(0.02)',
    'if os.path.exists(trigger_file):',
    `    sys.stdout.write(${JSON.stringify(`\r\n${liveMarker}\n`)})`,
    '    sys.stdout.flush()',
    'time.sleep(90)',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

function controllerLeaseProbeCommand({ readyMarker, inputLog }) {
  const script = [
    'import os, sys, termios, tty',
    `input_log = ${JSON.stringify(inputLog)}`,
    'open(input_log, "wb").close()',
    'fd = sys.stdin.fileno()',
    `sys.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${readyMarker}\n`)})`,
    'sys.stdout.flush()',
    'old = termios.tcgetattr(fd)',
    'tty.setraw(fd)',
    'try:',
    '    while True:',
    '        data = os.read(fd, 1024)',
    '        if not data:',
    '            break',
    '        with open(input_log, "ab") as handle:',
    '            handle.write(data)',
    '            handle.flush()',
    '            os.fsync(handle.fileno())',
    'finally:',
    '    termios.tcsetattr(fd, termios.TCSADRAIN, old)',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

function focusReportLeakDetectorCommand({ readyMarker }) {
  const script = [
    'import select, sys, termios, time, tty',
    `sys.stdout.write('\\x1b[?1004h' + ${JSON.stringify(readyMarker)} + '\\n')`,
    'sys.stdout.flush()',
    'fd = sys.stdin.fileno()',
    'old = termios.tcgetattr(fd)',
    'tty.setraw(fd)',
    'buf = b""',
    'end = time.time() + 9',
    'try:',
    '    while time.time() < end:',
    '        ready, _, _ = select.select([sys.stdin], [], [], 0.1)',
    '        if not ready:',
    '            continue',
    '        data = sys.stdin.buffer.read(1)',
    '        if not data:',
    '            continue',
    '        buf += data',
    '        if data in (b"I", b"O") or len(buf) >= 8:',
    '            sys.stdout.write("\\r\\nLEAK_BYTES:" + buf.hex() + "\\r\\n")',
    '            sys.stdout.flush()',
    '            buf = b""',
    'finally:',
    '    termios.tcsetattr(fd, termios.TCSADRAIN, old)',
    `    sys.stdout.write('\\r\\n\\x1b[?1004l${readyMarker}:DONE\\n')`,
    '    sys.stdout.flush()',
  ].join('\n');
  return `python3 -c ${shellQuote(script)}`;
}

async function clickSessionCard(page, sessionId, title) {
  const clicked = await page.eval(`(() => {
    const card = document.querySelector(${JSON.stringify(`.session-card[data-session-id="${sessionId}"]`)});
    if (!card) return false;
    card.click();
    return true;
  })()`);
  assert(clicked, `session card was not found for ${title}`, { sessionId, title });
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes(${JSON.stringify(title)})`, 15000, `${title} selected`);
}

async function testLongHermesScrollbackIsReadable(page) {
  const appJs = await httpText('/app.js');
  assert(appJs.includes('const BIDI_READER_MAX_LINES = 2000'), 'readable terminal line cap is too small for long Hermes answers');
  assert(appJs.includes('capture?lines=5000&ansi=1'), 'tmux capture line count is too small for long Hermes answers');
  assert(appJs.includes('refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })'), 'reader wheel does not prefer tmux capture for history scroll');

  const topMarker = `__WARPISH_LONG_SCROLL_TOP_${Date.now().toString(36)}__`;
  const bottomMarker = `__WARPISH_LONG_SCROLL_BOTTOM_${Date.now().toString(36)}__`;
  const session = await createSession('Long Hermes Scroll Regression', path.join(runtimeRoot, 'long-scroll-cwd'));
  respawnPane(session.id, longHermesScrollbackCommand({ topMarker, bottomMarker, lines: 650 }));
  await delay(500);
  await page.navigate(`${tokenUrl}&case=long-scrollback`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Long Hermes Scroll Regression')`, 15000, 'long-scroll session selected');
  await page.waitFor(`document.querySelector('#statusText')?.textContent.includes('connected')`, 15000, 'long-scroll terminal connected');
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes(${JSON.stringify(bottomMarker)})`, 20000, 'long-scroll bottom marker visible');

  const wheelPoint = await page.eval(`(() => {
    const lines = document.getElementById('bidiReaderLines');
    const rect = lines?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  })()`);
  assert(wheelPoint, 'could not locate readable reader for wheel test');
  for (let index = 0; index < 10; index += 1) {
    await page.wheelAt(wheelPoint.x, wheelPoint.y, -900);
    await delay(120);
  }

  let payload = null;
  let lastState = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    lastState = await page.eval(`(() => {
      const topMarker = ${JSON.stringify(topMarker)};
      const bottomMarker = ${JSON.stringify(bottomMarker)};
      const lines = document.getElementById('bidiReaderLines');
      const reader = document.getElementById('bidiReader');
      const text = lines?.innerText || '';
      const split = text ? text.split(String.fromCharCode(10)) : [];
      if (!lines) return { hasLines: false };
      if (!text.includes(topMarker) || !text.includes(bottomMarker)) {
        return {
          ready: false,
          title: document.querySelector('#sessionTitle')?.textContent || '',
          bodyClass: document.body.className,
          readerDisplay: reader ? getComputedStyle(reader).display : null,
          lineCount: split.length,
          hasTop: text.includes(topMarker),
          hasBottom: text.includes(bottomMarker),
          head: split.slice(0, 3),
          tail: split.slice(-3),
          scrollTop: lines.scrollTop,
          scrollHeight: lines.scrollHeight,
          clientHeight: lines.clientHeight,
        };
      }
      lines.scrollTop = 0;
      const topLine = [...lines.querySelectorAll('.bidi-line')].find((line) => line.textContent.includes(topMarker));
      const containerRect = lines.getBoundingClientRect();
      const topRect = topLine?.getBoundingClientRect();
      return {
        ready: true,
        hasTop: true,
        hasBottom: true,
        lineCount: split.length,
        scrollTop: lines.scrollTop,
        scrollHeight: lines.scrollHeight,
        clientHeight: lines.clientHeight,
        topVisible: Boolean(topRect && topRect.bottom >= containerRect.top && topRect.top <= containerRect.bottom),
      };
    })()`);
    if (lastState?.ready) {
      payload = lastState;
      break;
    }
    await delay(150);
  }

  assert(payload, 'long Hermes output was truncated from readable reader', lastState);
  assert(payload.lineCount >= 650, 'readable reader did not retain enough long-output lines', payload);
  assert(payload.topVisible, 'scrolling to the top of a long Hermes answer does not reveal the beginning', payload);
  return payload;
}

function visibleReaderStateExpression(prefix = '') {
  return `(() => {
    const lines = document.getElementById('bidiReaderLines');
    if (!lines) return { ok: false, reason: 'missing-lines' };
    ${prefix}
    const containerRect = lines.getBoundingClientRect();
    const visibleLine = [...lines.querySelectorAll('.bidi-line')].find((line) => {
      const rect = line.getBoundingClientRect();
      return rect.bottom > containerRect.top + 4 && rect.top < containerRect.bottom - 4;
    });
    return {
      ok: true,
      scrollTop: lines.scrollTop,
      maxScrollTop: Math.max(0, lines.scrollHeight - lines.clientHeight),
      scrollHeight: lines.scrollHeight,
      clientHeight: lines.clientHeight,
      text: lines.innerText || '',
      lineCount: (lines.innerText || '').split(String.fromCharCode(10)).length,
      visibleTop: visibleLine?.dataset?.logicalText || visibleLine?.textContent || '',
      nearBottom: lines.scrollHeight - lines.scrollTop - lines.clientHeight <= 10,
    };
  })()`;
}

function uiStabilityStateExpression(prefix = '') {
  return `(() => {
    const lines = document.getElementById('bidiReaderLines');
    ${prefix}
    const reader = document.getElementById('bidiReader');
    const card = document.querySelector('.terminal-card');
    const terminal = document.getElementById('terminal');
    const lineNodes = lines ? [...lines.querySelectorAll('.bidi-line')] : [];
    const text = lines?.innerText || '';
    const rectOf = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return rect ? {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
      } : null;
    };
    const containerRect = lines?.getBoundingClientRect?.();
    const visibleLine = lineNodes.find((line) => {
      const rect = line.getBoundingClientRect();
      return containerRect && rect.bottom > containerRect.top + 4 && rect.top < containerRect.bottom - 4;
    });
    return {
      windowScrollX: window.scrollX,
      windowScrollY: window.scrollY,
      activeTag: document.activeElement?.tagName || '',
      bodyClass: document.body.className,
      readerDisplay: reader ? getComputedStyle(reader).display : '',
      readerOpacity: reader ? getComputedStyle(reader).opacity : '',
      cardRect: rectOf(card),
      terminalRect: rectOf(terminal),
      readerRect: rectOf(reader),
      linesRect: rectOf(lines),
      lineCount: text ? text.split(String.fromCharCode(10)).length : 0,
      scrollTop: lines?.scrollTop || 0,
      maxScrollTop: lines ? Math.max(0, lines.scrollHeight - lines.clientHeight) : 0,
      scrollHeight: lines?.scrollHeight || 0,
      clientHeight: lines?.clientHeight || 0,
      visibleTop: visibleLine?.dataset?.logicalText || visibleLine?.textContent || '',
      nearBottom: lines ? lines.scrollHeight - lines.scrollTop - lines.clientHeight <= 10 : true,
      text,
    };
  })()`;
}

function assertRectStable(before, after, name, tolerance = 3) {
  for (const key of ['top', 'left', 'width', 'height', 'bottom']) {
    const delta = Math.abs((after?.[key] ?? 0) - (before?.[key] ?? 0));
    assert(delta <= tolerance, `${name} shifted during typing`, { key, delta, before, after });
  }
}

async function dispatchReadableKey(page, key) {
  await page.eval(`(() => {
    const target = document.getElementById('bidiReaderLines') || document.querySelector('.terminal-card') || document.getElementById('terminal');
    target?.focus?.({ preventScroll: true });
    const event = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true });
    const dispatched = target?.dispatchEvent(event);
    if (dispatched !== false && !event.defaultPrevented && typeof window.sendRaw === 'function') {
      window.sendRaw(${JSON.stringify(key === 'Enter' ? '\r' : key)}, { directTmux: true });
    }
  })()`);
}

async function dispatchTrustedReadableKey(page, key, {
  focusReader = false,
  ctrlKey = false,
  shiftKey = false,
  altKey = false,
  metaKey = false,
} = {}) {
  if (focusReader) {
    await page.eval(`document.getElementById('bidiReaderLines')?.focus({ preventScroll: true })`);
  }
  const printable = typeof key === 'string' && key.length === 1;
  const upper = printable ? key.toUpperCase() : '';
  const keyCode = printable && /[A-Z]/.test(upper)
    ? upper.charCodeAt(0)
    : ({ Backspace: 8, Enter: 13, Tab: 9, Escape: 27 }[key] || 0);
  const code = printable && /[A-Z]/.test(upper) ? `Key${upper}` : key;
  const base = {
    key,
    code,
    modifiers: (altKey ? 1 : 0) | (ctrlKey ? 2 : 0) | (metaKey ? 4 : 0) | (shiftKey ? 8 : 0),
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };
  const sendsText = printable && !ctrlKey && !altKey && !metaKey;
  await page.send('Input.dispatchKeyEvent', {
    ...base,
    type: 'keyDown',
    ...(sendsText ? { text: key, unmodifiedText: key } : {}),
  });
  await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

function shortReaderStateExpression() {
  return `(() => {
    const nodes = [...document.querySelectorAll('#bidiReaderLines .bidi-line:not(.empty-state)')];
    const lines = nodes.map((node) => node.dataset.logicalText || node.textContent || '');
    return {
      lineCount: lines.length,
      lines,
      tail: lines.at(-1) || '',
      bodyClass: document.body.className,
      activeClass: document.activeElement?.className || '',
    };
  })()`;
}

async function sampleShortReaderAtOffsets(page, offsets) {
  const startedAt = Date.now();
  const samples = [];
  for (const offsetMs of offsets) {
    const remaining = offsetMs - (Date.now() - startedAt);
    if (remaining > 0) await delay(remaining);
    samples.push({ offsetMs, ...(await page.eval(shortReaderStateExpression())) });
  }
  return samples;
}

async function waitForFileState(filePath, predicate, timeoutMs, label, { binary = false } = {}) {
  const startedAt = Date.now();
  let last = binary ? Buffer.alloc(0) : '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = fs.readFileSync(filePath, binary ? undefined : 'utf8');
      if (predicate(last)) return last;
    } catch {}
    await delay(40);
  }
  const printable = Buffer.isBuffer(last) ? last.toString('hex') : last;
  throw new Error(`timed out waiting for ${label}. last=${JSON.stringify(printable)}`);
}

function readTmuxPaneSize(sessionId) {
  return execFileSync(tmuxBin, [
    'display-message', '-p', '-t', sessionId, '#{pane_height}x#{pane_width}',
  ], { encoding: 'utf8', env: tmuxEnvironment }).trim();
}

async function waitForTmuxPaneSize(sessionId, expected, timeoutMs, label) {
  const startedAt = Date.now();
  let last = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = readTmuxPaneSize(sessionId);
      if (last === expected) return last;
    } catch {}
    await delay(40);
  }
  throw new Error(`timed out waiting for ${label}. expected=${expected} last=${JSON.stringify(last)}`);
}

async function connectRuntimeTestClient(sessionId, { cols, rows, name }) {
  const url = new URL('/ws', tokenUrl);
  url.protocol = 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));
  const socket = new WebSocket(url);
  const client = { name, socket, roles: [], controls: [], outputBytes: 0 };
  socket.on('message', (raw, isBinary) => {
    if (isBinary) {
      client.outputBytes += Buffer.byteLength(raw);
      return;
    }
    try {
      const message = JSON.parse(String(raw));
      client.controls.push(message);
      if (message.type === 'role') client.roles.push(message.role);
    } catch {}
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} WebSocket open timed out`)), 5000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return client;
}

async function waitForRuntimeRole(client, role, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (client.roles.at(-1) === role) return client.roles.slice();
    await delay(30);
  }
  throw new Error(`${client.name} did not become ${role}; roles=${JSON.stringify(client.roles)} controls=${JSON.stringify(client.controls)}`);
}

async function waitForRuntimeRoleCount(client, role, minimumCount, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (client.roles.length >= minimumCount && client.roles.at(-1) === role) return client.roles.slice();
    await delay(30);
  }
  throw new Error(`${client.name} did not receive ${minimumCount} ${role} role updates; roles=${JSON.stringify(client.roles)} controls=${JSON.stringify(client.controls)}`);
}

async function closeRuntimeTestClient(client) {
  if (!client?.socket || [WebSocket.CLOSED, WebSocket.CLOSING].includes(client.socket.readyState)) return;
  const closed = new Promise((resolve) => client.socket.once('close', resolve));
  client.socket.close(1000, 'test complete');
  await Promise.race([closed, delay(1000)]);
  if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
}

async function testRichHistoryTypingDoesNotCollapseOrJump(page) {
  const topMarker = `__WARPISH_UI_STABILITY_TOP_${Date.now().toString(36)}__`;
  const bottomMarker = `__WARPISH_UI_STABILITY_BOTTOM_${Date.now().toString(36)}__`;
  const readyMarker = `__WARPISH_UI_STABILITY_READY_${Date.now().toString(36)}__`;
  const typedMarker = `UISTABLE_${Date.now().toString(36)}`;
  const session = await createSession('UI Stability Typing Agent', path.join(runtimeRoot, 'ui-stability-cwd'));
  respawnPane(session.id, terminal56ScrollableInputCommand({ topMarker, bottomMarker, readyMarker, lines: 520 }));
  await delay(800);
  await page.navigate(`${tokenUrl}&case=ui-stability-typing`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('UI Stability Typing Agent')`, 15000, 'ui stability session selected');
  await page.eval(`refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })`);
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes(${JSON.stringify(readyMarker)})`, 20000, 'ui stability rich reader ready');
  await page.eval(uiStabilityStateExpression(`
    if (lines) {
      lines.scrollTop = lines.scrollHeight;
      lines.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  `));
  await delay(900);
  const before = await page.eval(uiStabilityStateExpression());
  assert(before.lineCount >= 500, 'ui stability setup did not retain rich reader history', before);
  assert(before.maxScrollTop > 1000, 'ui stability setup is not meaningfully scrollable', before);

  const samples = [];
  const expectedEcho = `INPUT_ECHO:${typedMarker}`;
  for (const key of typedMarker.split('')) {
    await dispatchReadableKey(page, key);
    await delay(90);
    samples.push(await page.eval(uiStabilityStateExpression()));
  }
  await dispatchReadableKey(page, 'Enter');
  let afterEnter = null;
  for (let index = 0; index < 80; index += 1) {
    await delay(50);
    const sample = await page.eval(uiStabilityStateExpression());
    samples.push(sample);
    if (!afterEnter && sample.text.includes(expectedEcho)) afterEnter = sample;
  }
  assert(afterEnter, 'ui stability typed marker was not echoed during sampling', samples.at(-1));

  const collapsed = samples.filter((sample) => sample.lineCount < before.lineCount - 20 || sample.maxScrollTop < before.maxScrollTop - 600);
  const pageScrolled = samples.filter((sample) => sample.windowScrollX !== before.windowScrollX || sample.windowScrollY !== before.windowScrollY);
  const hiddenReader = samples.filter((sample) => sample.readerDisplay === 'none' || sample.readerRect?.height === 0);
  assert(!collapsed.length, 'typing collapsed rich reader history and caused a visible up/down jump', {
    before: { lineCount: before.lineCount, maxScrollTop: before.maxScrollTop, scrollHeight: before.scrollHeight },
    collapsed: collapsed.map((sample) => ({ lineCount: sample.lineCount, maxScrollTop: sample.maxScrollTop, scrollHeight: sample.scrollHeight, visibleTop: sample.visibleTop })),
  });
  assert(!pageScrolled.length, 'typing changed browser page scroll', {
    before: { x: before.windowScrollX, y: before.windowScrollY },
    pageScrolled: pageScrolled.map((sample) => ({ x: sample.windowScrollX, y: sample.windowScrollY })),
  });
  assert(!hiddenReader.length, 'typing hid the readable terminal overlay', hiddenReader.map((sample) => ({ display: sample.readerDisplay, rect: sample.readerRect })));
  assert(afterEnter.nearBottom, 'typing at bottom left the readable terminal away from bottom', {
    before: { scrollTop: before.scrollTop, maxScrollTop: before.maxScrollTop, nearBottom: before.nearBottom },
    afterEnter: { scrollTop: afterEnter.scrollTop, maxScrollTop: afterEnter.maxScrollTop, nearBottom: afterEnter.nearBottom },
  });
  for (const sample of samples) {
    assertRectStable(before.cardRect, sample.cardRect, 'terminal card rect');
    assertRectStable(before.terminalRect, sample.terminalRect, 'terminal surface rect');
    assertRectStable(before.readerRect, sample.readerRect, 'reader overlay rect');
  }

  return {
    marker: typedMarker,
    sampleCount: samples.length,
    before: { lineCount: before.lineCount, maxScrollTop: before.maxScrollTop, scrollTop: before.scrollTop, nearBottom: before.nearBottom },
    minLineCount: Math.min(...samples.map((sample) => sample.lineCount)),
    minMaxScrollTop: Math.min(...samples.map((sample) => sample.maxScrollTop)),
    afterEnter: { lineCount: afterEnter.lineCount, maxScrollTop: afterEnter.maxScrollTop, scrollTop: afterEnter.scrollTop, nearBottom: afterEnter.nearBottom },
  };
}

async function testTerminal56ScrollAndTypingAreStable(page) {
  const topMarker = `__WARPISH_TERMINAL56_TOP_${Date.now().toString(36)}__`;
  const bottomMarker = `__WARPISH_TERMINAL56_BOTTOM_${Date.now().toString(36)}__`;
  const readyMarker = `__WARPISH_TERMINAL56_READY_${Date.now().toString(36)}__`;
  const typedMarker = `__WARPISH_TERMINAL56_TYPED_${Date.now().toString(36)}__`;
  const session = await createSession('Terminal 56 Scroll/Typing Regression', path.join(runtimeRoot, 'terminal56-cwd'));
  respawnPane(session.id, terminal56AlternateScrollCommand({ topMarker, bottomMarker, readyMarker, lines: 360 }));
  let capture = null;
  const captureDeadline = Date.now() + 15000;
  while (Date.now() < captureDeadline) {
    capture = await api(`/api/sessions/${session.id}/capture?lines=5000&ansi=1`);
    if ((capture.history || '').includes(topMarker) && (capture.active || '').includes(readyMarker)) break;
    await delay(100);
  }
  assert(!capture.usingAlternate && capture.captureReason === 'normal-rich-history', 'short alternate capture still wins over rich scrollback capture', {
    usingAlternate: capture.usingAlternate,
    captureReason: capture.captureReason,
    normalLines: (capture.normal || '').split('\n').length,
    alternateLines: (capture.alternate || '').split('\n').length,
    textHasTop: (capture.text || '').includes(topMarker),
    textHasBottom: (capture.text || '').includes(bottomMarker),
  });

  respawnPane(session.id, terminal56ScrollableInputCommand({ topMarker, bottomMarker, readyMarker, lines: 360 }));
  await delay(800);

  await page.navigate(`${tokenUrl}&case=terminal56-scroll-typing`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Terminal 56 Scroll/Typing Regression')`, 15000, 'terminal56 regression session selected');
  await page.eval(`refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })`);
  const initial = await page.waitFor(`(() => {
    const lines = document.getElementById('bidiReaderLines');
    const text = lines?.innerText || '';
    if (!text.includes(${JSON.stringify(topMarker)}) || !text.includes(${JSON.stringify(readyMarker)})) return false;
    return {
      lineCount: text.split(String.fromCharCode(10)).length,
      scrollHeight: lines.scrollHeight,
      clientHeight: lines.clientHeight,
      scrollTop: lines.scrollTop,
      maxScrollTop: Math.max(0, lines.scrollHeight - lines.clientHeight),
    };
  })()`, 20000, 'terminal56 rich reader content');
  assert(initial.lineCount >= 300, 'terminal56 reader lost scrollback lines before typing', initial);
  assert(initial.maxScrollTop > 200, 'terminal56 reader is not scrollable', initial);

  const wheelPoint = await page.eval(`(() => {
    const lines = document.getElementById('bidiReaderLines');
    const rect = lines?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  })()`);
  assert(wheelPoint, 'could not locate terminal56 readable reader for wheel test');

  await page.eval(`(() => {
    const lines = document.getElementById('bidiReaderLines');
    lines.scrollTop = lines.scrollHeight;
    lines.dispatchEvent(new Event('scroll', { bubbles: true }));
  })()`);
  await delay(900);
  const beforeWheel = await page.eval(visibleReaderStateExpression());
  await page.wheelAt(wheelPoint.x, wheelPoint.y, -900);
  await delay(450);
  const afterWheel = await page.eval(visibleReaderStateExpression());
  assert(!afterWheel.nearBottom && afterWheel.scrollTop < afterWheel.maxScrollTop - 40, 'mouse/trackpad wheel did not leave the readable terminal scrollback', { beforeWheel, afterWheel: { scrollTop: afterWheel.scrollTop, maxScrollTop: afterWheel.maxScrollTop, nearBottom: afterWheel.nearBottom, lineCount: afterWheel.lineCount } });

  await page.eval(visibleReaderStateExpression(`
    const maxScrollTop = Math.max(0, lines.scrollHeight - lines.clientHeight);
    lines.scrollTop = Math.round(maxScrollTop * 0.45);
    lines.dispatchEvent(new Event('scroll', { bubbles: true }));
  `));
  await delay(900);
  const beforeType = await page.eval(visibleReaderStateExpression());
  assert(!beforeType.nearBottom && beforeType.scrollTop > 20, 'typing stability setup did not leave reader scrolled in history', beforeType);

  await page.eval(`(() => {
    window.__warpishTerminal56Data = [];
    window.__warpishTerminal56Frames = [];
    term.onData((data) => window.__warpishTerminal56Data.push(data));
    const socket = ws;
    const originalSend = socket.send.bind(socket);
    socket.send = (data) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'input') window.__warpishTerminal56Frames.push(parsed.data);
      } catch {}
      return originalSend(data);
    };
  })()`);

  for (const key of typedMarker.split('')) {
    await dispatchReadableKey(page, key);
    await delay(90);
  }
  await dispatchReadableKey(page, 'Enter');
  await delay(700);
  await page.eval(`refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })`);
  let afterType;
  try {
    afterType = await page.waitFor(`(() => {
      const lines = document.getElementById('bidiReaderLines');
      const text = lines?.innerText || '';
      if (!text.includes(${JSON.stringify(`INPUT_ECHO:${typedMarker}`)})) return false;
      return ${visibleReaderStateExpression()};
    })()`, 15000, 'typed marker echoed without reader jump');
  } catch (error) {
    const [clientState, paneCapture] = await Promise.all([
      page.eval(`({
        currentSessionId,
        terminalControlRole,
        controlClaimPending,
        pendingChars: pendingInputChars(currentSessionId),
        socketState: ws?.readyState ?? null,
        status: document.getElementById('statusText')?.textContent || '',
        detail: document.getElementById('sessionText')?.textContent || '',
        terminalInputEventSerial,
        terminalWriteDepth,
        observedData: window.__warpishTerminal56Data,
        sentFrames: window.__warpishTerminal56Frames,
        activeElement: document.activeElement?.className || document.activeElement?.id || document.activeElement?.tagName || '',
        readerTail: (document.getElementById('bidiReaderLines')?.innerText || '').slice(-1200),
      })`),
      api(`/api/sessions/${session.id}/capture?lines=120&ansi=0`),
    ]);
    error.message += `\nterminal56 diagnostics=${JSON.stringify({ clientState, paneTail: (paneCapture.text || '').slice(-1200) }, null, 2)}`;
    throw error;
  }

  const summarizeTerminal56State = (state) => ({
    scrollTop: state.scrollTop,
    maxScrollTop: state.maxScrollTop,
    scrollHeight: state.scrollHeight,
    clientHeight: state.clientHeight,
    lineCount: state.lineCount,
    visibleTop: state.visibleTop,
    nearBottom: state.nearBottom,
    hasTop: state.text.includes(topMarker),
    hasBottom: state.text.includes(bottomMarker),
    hasTypedEcho: state.text.includes(`INPUT_ECHO:${typedMarker}`),
  });
  const scrollJump = Math.abs(afterType.scrollTop - beforeType.scrollTop);
  assert(scrollJump <= 80, 'typing while scrolled in Terminal 56 history jumped the reader', { beforeType: summarizeTerminal56State(beforeType), afterType: summarizeTerminal56State(afterType), scrollJump });
  assert(!afterType.nearBottom, 'typing while scrolled in Terminal 56 history snapped to bottom', { beforeType: summarizeTerminal56State(beforeType), afterType: summarizeTerminal56State(afterType) });
  assert(afterType.text.includes(topMarker) && afterType.text.includes(bottomMarker), 'typing truncated terminal56 scrollback', summarizeTerminal56State(afterType));
  assert(afterType.visibleTop === beforeType.visibleTop, 'typing preserved scrollTop but changed visible Terminal 56 reader line', { beforeType: summarizeTerminal56State(beforeType), afterType: summarizeTerminal56State(afterType) });

  const postTypeWheelDelta = afterType.scrollTop > 100 ? -700 : 700;
  await page.eval(`document.getElementById('bidiReaderLines')?.dispatchEvent(new WheelEvent('wheel', { deltaY: ${postTypeWheelDelta}, bubbles: true, cancelable: true }))`);
  await delay(300);
  const afterSecondWheel = await page.eval(visibleReaderStateExpression());
  assert(Math.abs(afterSecondWheel.scrollTop - afterType.scrollTop) > 20, 'reader stopped scrolling after typing in Terminal 56 regression', {
    wheelDelta: postTypeWheelDelta,
    afterType: summarizeTerminal56State(afterType),
    afterSecondWheel: summarizeTerminal56State(afterSecondWheel),
  });

  return {
    captureReason: capture.captureReason,
    lineCount: afterType.lineCount,
    beforeWheel,
    afterWheel: { scrollTop: afterWheel.scrollTop, maxScrollTop: afterWheel.maxScrollTop },
    beforeType: { scrollTop: beforeType.scrollTop, visibleTop: beforeType.visibleTop },
    afterType: { scrollTop: afterType.scrollTop, visibleTop: afterType.visibleTop, nearBottom: afterType.nearBottom },
    afterSecondWheel: { scrollTop: afterSecondWheel.scrollTop, maxScrollTop: afterSecondWheel.maxScrollTop },
  };
}

async function testSessionSwitchingSuppressesFocusReportsAndScrollBounce(page) {
  const focusTitle = 'Switch Focus Reporter Regression';
  const scrollTitle = 'Switch Scroll Bounce Regression';
  const focusReady = `__WARPISH_FOCUS_REPORT_READY_${Date.now().toString(36)}__`;
  const topMarker = `__WARPISH_SWITCH_SCROLL_TOP_${Date.now().toString(36)}__`;
  const bottomMarker = `__WARPISH_SWITCH_SCROLL_BOTTOM_${Date.now().toString(36)}__`;
  const readyMarker = `__WARPISH_SWITCH_SCROLL_READY_${Date.now().toString(36)}__`;

  const focusSession = await createSession(focusTitle, path.join(runtimeRoot, 'switch-focus-cwd'));
  const scrollSession = await createSession(scrollTitle, path.join(runtimeRoot, 'switch-scroll-cwd'));
  respawnPane(focusSession.id, focusReportLeakDetectorCommand({ readyMarker: focusReady }));
  respawnPane(scrollSession.id, terminal56ScrollableInputCommand({ topMarker, bottomMarker, readyMarker, lines: 460 }));
  await delay(900);

  await page.navigate(`${tokenUrl}&case=session-switch-scroll-bounce`);
  await page.waitFor(`document.querySelector('#sessionList')?.innerText.includes(${JSON.stringify(focusTitle)}) && document.querySelector('#sessionList')?.innerText.includes(${JSON.stringify(scrollTitle)})`, 15000, 'switch regression sessions listed');
  const focusFilter = await page.eval(`(() => {
    window.__warpishSentInputMessages = [];
    if (!WebSocket.prototype.__warpishLoggedSend) {
      const originalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function loggedSend(data) {
        try {
          const text = String(data);
          if (text.includes('\\u001b') || text.includes(String.fromCharCode(27))) window.__warpishSentInputMessages.push(text);
        } catch {}
        return originalSend.call(this, data);
      };
      WebSocket.prototype.__warpishLoggedSend = true;
    }
    if (typeof setReaderMouseMode === 'function') setReaderMouseMode('reader');
    if (typeof bidiReaderEnabled !== 'undefined' && !bidiReaderEnabled) {
      bidiReaderEnabled = true;
      localStorage.setItem('warpish_readable_terminal_v1', 'on');
      applyBidiMode();
    }
    window.scrollTo(0, 0);
    const focusIn = String.fromCharCode(27) + '[I';
    const focusOut = String.fromCharCode(27) + '[O';
    return {
      focusIn: stripTerminalFocusReports(focusIn),
      focusOut: stripTerminalFocusReports(focusOut),
      mixed: stripTerminalFocusReports('before' + focusIn + 'middle' + focusOut + 'after'),
      suppressesFocusIn: shouldSuppressTerminalInput(focusIn),
      suppressesFocusOut: shouldSuppressTerminalInput(focusOut),
    };
  })()`);
  assert(
    focusFilter.focusIn === ''
      && focusFilter.focusOut === ''
      && focusFilter.mixed === 'beforemiddleafter'
      && focusFilter.suppressesFocusIn
      && focusFilter.suppressesFocusOut,
    'readable-mode focus report filter did not suppress focus control input',
    focusFilter,
  );

  await clickSessionCard(page, focusSession.id, focusTitle);
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes(${JSON.stringify(focusReady)})`, 15000, 'focus-report session ready');
  for (let index = 0; index < 4; index += 1) {
    await page.eval(`focusTerminalReliably()`);
    await delay(120);
    await clickSessionCard(page, scrollSession.id, scrollTitle);
    await delay(140);
    await clickSessionCard(page, focusSession.id, focusTitle);
    await delay(140);
  }
  await page.eval(`focusTerminalReliably()`);
  await delay(800);
  const focusCapture = await api(`/api/sessions/${focusSession.id}/capture?lines=300&ansi=0`);
  const sentFocusMessages = await page.eval(`window.__warpishSentInputMessages || []`);
  const focusInputLeaks = sentFocusMessages.filter((wireMessage) => {
    try {
      const message = JSON.parse(wireMessage);
      return /\x1b\[(?:I|O)/.test(String(message.data || ''));
    } catch {
      return /\x1b\[(?:I|O)/.test(wireMessage);
    }
  });
  assert(!focusInputLeaks.length, 'browser sent terminal focus reports while switching sessions', focusInputLeaks);
  assert(!focusCapture.text.includes('LEAK_BYTES:'), 'terminal focus reports leaked into the tmux pane while switching sessions', {
    focusInputLeaks,
    sentFocusMessages,
    captureTail: focusCapture.text.split('\n').slice(-20),
  });

  await clickSessionCard(page, scrollSession.id, scrollTitle);
  await page.eval(`refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })`);
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes(${JSON.stringify(readyMarker)})`, 20000, 'switch scroll reader ready');
  const setup = await page.eval(uiStabilityStateExpression(`
    if (lines) {
      const maxScrollTop = Math.max(0, lines.scrollHeight - lines.clientHeight);
      lines.scrollTop = Math.round(maxScrollTop * 0.72);
      lines.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    window.scrollTo(0, 0);
  `));
  assert(setup.maxScrollTop > 1000 && setup.scrollTop > 500, 'switch scroll setup is not meaningfully inside scrollback', setup);

  const wheelPoint = await page.eval(`(() => {
    const lines = document.getElementById('bidiReaderLines');
    const rect = lines?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  })()`);
  assert(wheelPoint, 'could not locate switch regression reader for wheel test');

  const samples = [];
  for (let index = 0; index < 8; index += 1) {
    await page.wheelAt(wheelPoint.x, wheelPoint.y, -650);
    await delay(55);
    samples.push(await page.eval(uiStabilityStateExpression()));
  }
  await delay(850);
  const settled = await page.eval(uiStabilityStateExpression());
  const pageScrolled = samples.concat(settled).filter((sample) => sample.windowScrollY !== 0 || sample.windowScrollX !== 0);
  assert(!pageScrolled.length, 'fast terminal wheel scrolled the page/project instead of the terminal reader', pageScrolled.map((sample) => ({ x: sample.windowScrollX, y: sample.windowScrollY, scrollTop: sample.scrollTop })));
  assert(samples.some((sample) => sample.scrollTop < setup.scrollTop - 80), 'fast upward wheel did not move the terminal reader into history', { setup, samples: samples.map((sample) => ({ scrollTop: sample.scrollTop, maxScrollTop: sample.maxScrollTop })) });
  const bounceDown = [];
  for (let index = 1; index < samples.length; index += 1) {
    const delta = samples[index].scrollTop - samples[index - 1].scrollTop;
    if (delta > 260) bounceDown.push({ index, delta, before: samples[index - 1].scrollTop, after: samples[index].scrollTop });
  }
  assert(!bounceDown.length, 'fast upward wheel bounced the terminal reader back downward', { setup: { scrollTop: setup.scrollTop, maxScrollTop: setup.maxScrollTop }, bounceDown });
  assert(!settled.nearBottom, 'fast wheel snapped the terminal reader back to bottom after settling', { setup: { scrollTop: setup.scrollTop, maxScrollTop: setup.maxScrollTop }, settled: { scrollTop: settled.scrollTop, maxScrollTop: settled.maxScrollTop, nearBottom: settled.nearBottom } });

  return {
    focusLeakClean: true,
    focusFilter,
    sentFocusMessageCount: sentFocusMessages.length,
    focusCaptureTail: focusCapture.text.split('\n').slice(-8),
    setup: { scrollTop: setup.scrollTop, maxScrollTop: setup.maxScrollTop, windowScrollY: setup.windowScrollY },
    samples: samples.map((sample) => ({ scrollTop: sample.scrollTop, maxScrollTop: sample.maxScrollTop, windowScrollY: sample.windowScrollY, visibleTop: sample.visibleTop })),
    settled: { scrollTop: settled.scrollTop, maxScrollTop: settled.maxScrollTop, windowScrollY: settled.windowScrollY, nearBottom: settled.nearBottom, visibleTop: settled.visibleTop },
  };
}

async function testShortHistoryTypingAndBackspaceStayStable(page) {
  const suffix = Date.now().toString(36);
  const topMarker = `__WARPISH_SHORT_HISTORY_TOP_${suffix}__`;
  const bottomMarker = `__WARPISH_SHORT_HISTORY_BOTTOM_${suffix}__`;
  const prompt = `__WARPISH_SHORT_PROMPT_${suffix}__>`;
  const typedKey = 'x';
  const typedTail = `${prompt}${typedKey}`;
  const sampleOffsets = [60, 300, 1000];
  const session = await createSession('Short History Typing Flicker Regression', path.join(runtimeRoot, 'short-history-typing-cwd'));
  respawnPane(session.id, shortHistoryTypingCommand({ topMarker, bottomMarker, prompt }));
  await delay(600);

  await page.navigate(`${tokenUrl}&case=short-history-typing-flicker`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Short History Typing Flicker Regression')`, 15000, 'short-history typing session selected');
  await page.waitFor(`document.querySelector('#statusText')?.textContent.includes('connected')`, 15000, 'short-history typing terminal connected');
  await page.eval(`refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })`);
  const baseline = await page.waitFor(`(() => {
    const state = ${shortReaderStateExpression()};
    return state.lines.includes(${JSON.stringify(topMarker)})
      && state.lines.includes(${JSON.stringify(bottomMarker)})
      && state.tail.endsWith(${JSON.stringify(prompt)})
      ? state
      : false;
  })()`, 15000, 'short-history baseline and prompt');
  assert(baseline.lineCount >= 5, 'short-history fixture did not establish a multi-line reader baseline', baseline);

  await dispatchTrustedReadableKey(page, typedKey, { focusReader: true });
  const typedSamples = await sampleShortReaderAtOffsets(page, sampleOffsets);
  await dispatchTrustedReadableKey(page, 'Backspace');
  const restoredSamples = await sampleShortReaderAtOffsets(page, sampleOffsets);
  const allSamples = typedSamples.concat(restoredSamples);

  const collapsed = allSamples.filter((sample) => sample.lineCount <= 1);
  assert(!collapsed.length, 'short terminal history collapsed to a one-line reader while typing or deleting', {
    baseline,
    collapsed,
    typedSamples,
    restoredSamples,
  });
  const lostHistory = allSamples.filter((sample) => !sample.lines.includes(topMarker) || !sample.lines.includes(bottomMarker));
  assert(!lostHistory.length, 'short terminal history disappeared while the prompt tail was updating', {
    baseline,
    lostHistory,
    typedSamples,
    restoredSamples,
  });

  assert(
    [prompt, typedTail].some((expected) => typedSamples[0].tail.endsWith(expected)),
    'short-history tail was corrupted during the first typing render window',
    { baseline, typedSamples },
  );
  for (const sample of typedSamples.slice(1)) {
    assert(sample.tail.endsWith(typedTail), 'typed character did not remain in the short-history prompt tail', {
      baseline,
      typedTail,
      typedSamples,
    });
  }
  assert(
    [prompt, typedTail].some((expected) => restoredSamples[0].tail.endsWith(expected)),
    'short-history tail was corrupted during the first Backspace render window',
    { baseline, restoredSamples },
  );
  for (const sample of restoredSamples.slice(1)) {
    assert(sample.tail.endsWith(prompt) && !sample.tail.endsWith(typedTail), 'Backspace did not restore the short-history prompt tail', {
      baseline,
      prompt,
      typedTail,
      restoredSamples,
    });
  }

  return {
    baseline: { lineCount: baseline.lineCount, tail: baseline.tail },
    typedKey,
    typedSamples: typedSamples.map(({ offsetMs, lineCount, tail }) => ({ offsetMs, lineCount, tail })),
    restoredSamples: restoredSamples.map(({ offsetMs, lineCount, tail }) => ({ offsetMs, lineCount, tail })),
  };
}

async function testReadableClipboardShortcutsDoNotSendControlBytes(page) {
  const suffix = Date.now().toString(36);
  const readyMarker = `__WARPISH_CLIPBOARD_SHORTCUT_READY_${suffix}__`;
  const inputLog = path.join(runtimeRoot, `clipboard-shortcut-${suffix}.bin`);
  const stateFile = path.join(runtimeRoot, `clipboard-shortcut-${suffix}.json`);
  const session = await createSession('Readable Clipboard Shortcut Regression', path.join(runtimeRoot, 'clipboard-shortcut-cwd'));
  respawnPane(session.id, clipboardShortcutInputLogCommand({ readyMarker, inputLog, stateFile }));
  await waitForFileState(inputLog, () => true, 5000, 'clipboard shortcut input log', { binary: true });
  await waitForFileState(stateFile, (text) => {
    try { return JSON.parse(text).draft === ''; } catch { return false; }
  }, 5000, 'clipboard semantic input state');

  await page.navigate(`${tokenUrl}&case=clipboard-shortcuts`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Readable Clipboard Shortcut Regression')`, 15000, 'clipboard shortcut session selected');
  await page.waitFor(`document.querySelector('.terminal-card')?.dataset.controlRole === 'controller'`, 15000, 'clipboard shortcut tab controller role');
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes(${JSON.stringify(readyMarker)})`, 15000, 'clipboard shortcut reader ready');
  const naturalReconnectMode = await page.eval(`Boolean(term.modes?.bracketedPasteMode)`);
  await page.eval(`new Promise((resolve) => term.write('\\x1b[?2004l', resolve))`);
  const reconnectMode = await page.eval(`Boolean(term.modes?.bracketedPasteMode)`);
  assert(reconnectMode === false, 'clipboard fixture could not establish the deterministic lost-mode reconnect branch', {
    naturalReconnectMode,
    reconnectMode,
  });
  fs.writeFileSync(inputLog, Buffer.alloc(0));

  async function waitForSemanticState(predicate, label) {
    const text = await waitForFileState(stateFile, (value) => {
      try { return predicate(JSON.parse(value)); } catch { return false; }
    }, 5000, label);
    return JSON.parse(text);
  }

  async function resetSemanticDraft(expectedSubmissionCount = 0) {
    await page.eval(`term.input('\\x15', true)`);
    return waitForSemanticState(
      (state) => state.draft === '' && state.submissions.length === expectedSubmissionCount,
      'semantic draft reset',
    );
  }

  const selection = await page.eval(`(() => {
    const line = [...document.querySelectorAll('#bidiReaderLines .bidi-line')]
      .find((node) => (node.dataset.logicalText || node.textContent || '').includes('Clipboard shortcut regression line 2'));
    if (!line) return { selected: false };
    const range = document.createRange();
    range.selectNodeContents(line);
    const selected = window.getSelection();
    selected.removeAllRanges();
    selected.addRange(range);
    document.getElementById('bidiReaderLines')?.focus({ preventScroll: true });
    return { selected: !selected.isCollapsed, text: selected.toString() };
  })()`);
  assert(selection.selected, 'clipboard shortcut regression could not establish a readable selection', selection);

  await dispatchTrustedReadableKey(page, 'c', { ctrlKey: true, shiftKey: true });
  await dispatchTrustedReadableKey(page, 'v', { ctrlKey: true, shiftKey: true });
  await delay(350);
  const received = fs.readFileSync(inputLog);
  assert(!received.includes(0x03) && !received.includes(0x16), 'Ctrl+Shift+C/V leaked Ctrl-C or Ctrl-V bytes into tmux', {
    selection,
    receivedHex: received.toString('hex'),
  });
  assert(received.length === 0, 'readable clipboard shortcuts unexpectedly sent terminal input', {
    selection,
    receivedHex: received.toString('hex'),
  });

  await page.eval(`window.getSelection()?.removeAllRanges()`);
  const multilinePaste = 'این  متن می‌خواهد فاصله‌  دقیق و ۱۲۳ را حفظ کند\nخط دوم Hermes است\n';
  const safeSingleLinePaste = multilinePaste.replace(/\n+$/u, '').replace(/\n/gu, ' ');

  async function dispatchPasteTo(selector, payload) {
    fs.writeFileSync(inputLog, Buffer.alloc(0));
    const dispatch = await page.eval(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { dispatched: false, reason: 'target missing' };
      target.focus?.({ preventScroll: true });
      const transfer = new DataTransfer();
      transfer.setData('text/plain', ${JSON.stringify(payload)});
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      const result = target.dispatchEvent(event);
      return { dispatched: true, defaultPrevented: !result || event.defaultPrevented };
    })()`);
    assert(dispatch.dispatched && dispatch.defaultPrevented, 'safe terminal paste handler did not intercept the clipboard event', {
      selector,
      dispatch,
    });
    const expected = Buffer.from(safeSingleLinePaste, 'utf8');
    const actual = await waitForFileState(inputLog, (value) => value.length >= expected.length, 5000, `safe paste input for ${selector}`, { binary: true });
    assert(actual.equals(expected), 'safe multiline paste changed Unicode/spacing, duplicated input, or submitted a line', {
      selector,
      expectedText: safeSingleLinePaste,
      actualText: actual.toString('utf8'),
      expectedHex: expected.toString('hex'),
      actualHex: actual.toString('hex'),
    });
    assert(!actual.includes(0x0a) && !actual.includes(0x0d), 'safe multiline paste leaked Enter before explicit user confirmation', {
      selector,
      actualHex: actual.toString('hex'),
    });
    return actual;
  }

  const readerPaste = await dispatchPasteTo('#bidiReaderLines', multilinePaste);
  const readerSemanticState = await waitForSemanticState(
    (state) => state.draft === safeSingleLinePaste && state.submissions.length === 0,
    'reader paste semantic draft',
  );
  await page.waitFor(`(() => {
    const logical = [...document.querySelectorAll('#bidiReaderLines .bidi-line')]
      .map((node) => node.dataset.logicalText || node.textContent || '')
      .join('');
    return logical.includes(${JSON.stringify(safeSingleLinePaste)});
  })()`, 5000, 'safe Persian paste rendered with logical spacing');
  const renderedPaste = await page.eval(`(() => {
    const logical = [...document.querySelectorAll('#bidiReaderLines .bidi-line')]
      .map((node) => node.dataset.logicalText || node.textContent || '')
      .join('');
    return {
      logical,
      occurrences: logical.split(${JSON.stringify(safeSingleLinePaste)}).length - 1,
    };
  })()`);
  assert(renderedPaste.occurrences === 1, 'safe Persian paste was duplicated or changed in the readable DOM', renderedPaste);
  const renderedPasteSamples = [renderedPaste];
  for (let refreshIndex = 0; refreshIndex < 2; refreshIndex += 1) {
    await page.eval(`refreshBidiReaderFromCapture({ preferCapture: true, keepScroll: true })`);
    await delay(120);
    const sample = await page.eval(`(() => {
      const logical = [...document.querySelectorAll('#bidiReaderLines .bidi-line')]
        .map((node) => node.dataset.logicalText || node.textContent || '')
        .join('');
      return {
        logical,
        occurrences: logical.split(${JSON.stringify(safeSingleLinePaste)}).length - 1,
      };
    })()`);
    assert(sample.occurrences === 1, 'safe Persian paste changed or duplicated after capture reconciliation', {
      refreshIndex,
      sample,
    });
    renderedPasteSamples.push(sample);
  }
  await resetSemanticDraft(0);
  const helperPaste = await dispatchPasteTo('.xterm-helper-textarea', multilinePaste);
  const helperSemanticState = await waitForSemanticState(
    (state) => state.draft === safeSingleLinePaste && state.submissions.length === 0,
    'xterm helper paste semantic draft',
  );
  await resetSemanticDraft(0);

  await page.eval(`(() => { bidiReaderEnabled = false; applyBidiMode(); })()`);
  const rawModePaste = await dispatchPasteTo('.xterm-helper-textarea', multilinePaste);
  const rawSemanticState = await waitForSemanticState(
    (state) => state.draft === safeSingleLinePaste && state.submissions.length === 0,
    'raw-mode paste semantic draft',
  );
  await page.eval(`(() => { bidiReaderEnabled = true; applyBidiMode(); })()`);

  fs.writeFileSync(inputLog, Buffer.alloc(0));
  await dispatchTrustedReadableKey(page, 'Enter', { focusReader: true });
  const explicitSubmit = await waitForFileState(inputLog, (value) => value.length >= 1, 5000, 'explicit Enter after safe paste', { binary: true });
  assert(explicitSubmit.equals(Buffer.from('\r')), 'explicit Enter did not remain the only submit byte', {
    actualHex: explicitSubmit.toString('hex'),
  });
  const explicitSubmitState = await waitForSemanticState(
    (state) => state.draft === '' && state.submissions.length === 1 && state.submissions[0] === safeSingleLinePaste,
    'explicit Enter semantic submission',
  );

  fs.writeFileSync(inputLog, Buffer.alloc(0));
  await page.eval(`new Promise((resolve) => term.write('\\x1b[?2004h', resolve))`);
  const bracketedDispatch = await page.eval(`(() => {
    const target = document.querySelector('#bidiReaderLines');
    const transfer = new DataTransfer();
    transfer.setData('text/plain', ${JSON.stringify(multilinePaste)});
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true, composed: true });
    target?.dispatchEvent(event);
    return { targetFound: Boolean(target), defaultPrevented: event.defaultPrevented };
  })()`);
  assert(bracketedDispatch.targetFound && bracketedDispatch.defaultPrevented, 'bracketed safe paste was not intercepted', bracketedDispatch);
  const bracketedExpected = Buffer.from(`\x1b[200~${multilinePaste.replace(/\n+$/u, '').replace(/\n/gu, '\r')}\x1b[201~`, 'utf8');
  const bracketedPaste = await waitForFileState(inputLog, (value) => value.length >= bracketedExpected.length, 5000, 'bracketed safe paste input', { binary: true });
  assert(bracketedPaste.equals(bracketedExpected), 'bracketed paste did not preserve internal lines or removed the final-submit guard', {
    expectedHex: bracketedExpected.toString('hex'),
    actualHex: bracketedPaste.toString('hex'),
  });
  const bracketedDraftText = multilinePaste.replace(/\n+$/u, '');
  const bracketedSemanticState = await waitForSemanticState(
    (state) => state.draft === bracketedDraftText && state.submissions.length === 1 && state.bracketed === false,
    'bracketed multiline semantic draft',
  );
  await resetSemanticDraft(1);

  const bracketEscapePayload = 'safe\x1b[201~\ncommand-must-stay-draft\n';
  fs.writeFileSync(inputLog, Buffer.alloc(0));
  await page.eval(`(() => {
    const target = document.querySelector('.xterm-helper-textarea');
    const transfer = new DataTransfer();
    transfer.setData('text/plain', ${JSON.stringify(bracketEscapePayload)});
    target?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true, composed: true }));
  })()`);
  const bracketEscapeExpected = Buffer.from('\x1b[200~safe[201~\rcommand-must-stay-draft\x1b[201~', 'utf8');
  const bracketEscapePaste = await waitForFileState(inputLog, (value) => value.length >= bracketEscapeExpected.length, 5000, 'bracket terminator injection paste', { binary: true });
  assert(bracketEscapePaste.equals(bracketEscapeExpected), 'clipboard content escaped bracketed paste and exposed an implicit submit', {
    expectedHex: bracketEscapeExpected.toString('hex'),
    actualHex: bracketEscapePaste.toString('hex'),
  });
  const bracketEscapeSemanticState = await waitForSemanticState(
    (state) => state.draft === 'safe[201~\ncommand-must-stay-draft' && state.submissions.length === 1 && state.bracketed === false,
    'bracket terminator semantic draft',
  );
  await resetSemanticDraft(1);
  await page.eval(`new Promise((resolve) => term.write('\\x1b[?2004l', resolve))`);

  return {
    selectionText: selection.text,
    receivedHex: received.toString('hex'),
    controller: true,
    safePaste: {
      surfaces: 3,
      submittedBeforeEnter: [readerSemanticState, helperSemanticState, rawSemanticState]
        .reduce((count, state) => count + state.submissions.length, 0),
      submittedAfterEnter: explicitSubmitState.submissions.length,
      persianSpacingPreserved: readerPaste.equals(Buffer.from(safeSingleLinePaste))
        && helperPaste.equals(Buffer.from(safeSingleLinePaste))
        && rawModePaste.equals(Buffer.from(safeSingleLinePaste))
        && renderedPasteSamples.every((sample) => sample.occurrences === 1),
      readerHex: readerPaste.toString('hex'),
      helperHex: helperPaste.toString('hex'),
      rawModeHex: rawModePaste.toString('hex'),
      renderedOccurrences: renderedPaste.occurrences,
      stableRenderedSamples: renderedPasteSamples.length,
      naturalReconnectMode,
      reconnectModeDesyncCovered: reconnectMode === false,
      bracketedInternalLinesPreserved: bracketedPaste.equals(bracketedExpected),
      bracketTerminatorNeutralized: bracketEscapePaste.equals(bracketEscapeExpected),
      semanticDraftsVerified: [readerSemanticState, helperSemanticState, rawSemanticState]
        .every((state) => state.draft === safeSingleLinePaste && state.submissions.length === 0)
        && explicitSubmitState.submissions[0] === safeSingleLinePaste
        && bracketedSemanticState.draft === bracketedDraftText
        && bracketEscapeSemanticState.draft === 'safe[201~\ncommand-must-stay-draft',
    },
  };
}

async function testReaderSelectionSurvivesLiveOutput(page) {
  const suffix = Date.now().toString(36);
  const selectionMarker = `__WARPISH_SELECTION_TARGET_${suffix}__`;
  const prompt = `__WARPISH_SELECTION_PROMPT_${suffix}__>`;
  const suggestion = 'ghost-suggestion';
  const liveMarker = `__WARPISH_SELECTION_LIVE_UPDATE_${suffix}__`;
  const triggerFile = path.join(runtimeRoot, `selection-trigger-${suffix}`);
  try { fs.unlinkSync(triggerFile); } catch {}
  const session = await createSession('Reader Selection Live Update Regression', path.join(runtimeRoot, 'selection-live-cwd'));
  respawnPane(session.id, readerSelectionUpdateCommand({ selectionMarker, prompt, suggestion, triggerFile, liveMarker }));
  await delay(500);

  await page.navigate(`${tokenUrl}&case=reader-selection-live-update`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Reader Selection Live Update Regression')`, 15000, 'reader selection session selected');
  await page.waitFor(`document.querySelector('.terminal-card')?.dataset.controlRole === 'controller'`, 15000, 'reader selection tab controller role');
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes(${JSON.stringify(selectionMarker)})`, 15000, 'reader selection fixture visible');
  await page.eval(`renderBidiReader(getReadableTerminalEntries(), { force: true, source: 'xterm' })`);
  await page.waitFor(`Boolean(document.querySelector('#bidiReaderLines .bidi-inline-cursor'))`, 5000, 'reader inline cursor fixture');

  const before = await page.eval(`(async () => {
    const lines = [...document.querySelectorAll('#bidiReaderLines .bidi-line')];
    const start = lines.find((node) => (node.dataset.logicalText || node.textContent || '').includes(${JSON.stringify(selectionMarker)}));
    const end = lines.find((node) => (node.dataset.logicalText || node.textContent || '').includes(${JSON.stringify(prompt)}));
    if (!start || !end) return { selected: false, reason: 'selection endpoints missing' };
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.childNodes.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const raw = selection.toString();
    const sanitized = selectedReadableText();
    let copied = null;
    const clipboard = navigator.clipboard;
    const ownDescriptor = clipboard ? Object.getOwnPropertyDescriptor(clipboard, 'writeText') : null;
    try {
      if (clipboard) {
        Object.defineProperty(clipboard, 'writeText', {
          configurable: true,
          value: async (text) => { copied = text; },
        });
        await copyTerminalSelection();
      }
    } finally {
      if (clipboard) {
        if (ownDescriptor) Object.defineProperty(clipboard, 'writeText', ownDescriptor);
        else delete clipboard.writeText;
      }
    }
    return {
      selected: !selection.isCollapsed,
      raw,
      sanitized,
      copied,
      cursorCount: end.querySelectorAll('.bidi-inline-cursor').length,
    };
  })()`);
  assert(before.selected && before.cursorCount === 1, 'reader selection fixture did not include the visible inline cursor', before);
  assert(before.raw.includes('▌'), 'raw reader selection did not include the visible cursor fixture', before);
  assert(!before.sanitized.includes('▌'), 'selectedReadableText leaked the visual cursor glyph', before);
  assert(before.copied === before.sanitized && !before.copied.includes('▌'), 'Copy action included the visual cursor glyph', before);

  fs.writeFileSync(triggerFile, 'release');
  await waitForFileState(triggerFile, (text) => text === 'release', 1000, 'selection live-update trigger');
  let captureAfterUpdate = null;
  const updateDeadline = Date.now() + 10000;
  while (Date.now() < updateDeadline) {
    captureAfterUpdate = await api(`/api/sessions/${session.id}/capture?lines=100&ansi=0`);
    if ((captureAfterUpdate.text || '').includes(liveMarker)) break;
    await delay(80);
  }
  assert((captureAfterUpdate?.text || '').includes(liveMarker), 'selection fixture did not emit its live output update', captureAfterUpdate);
  await delay(500);

  const during = await page.eval(`(() => {
    const selection = window.getSelection();
    return {
      selected: Boolean(selection && !selection.isCollapsed),
      raw: selection?.toString() || '',
      sanitized: selectedReadableText(),
      liveVisible: (document.querySelector('#bidiReaderLines')?.innerText || '').includes(${JSON.stringify(liveMarker)}),
    };
  })()`);
  assert(during.selected && during.raw === before.raw, 'active reader selection changed or collapsed during live output', { before, during });
  assert(during.sanitized === before.sanitized && !during.sanitized.includes('▌'), 'copiable reader selection changed during live output', { before, during });
  assert(!during.liveVisible, 'reader rerendered underneath an active selection', { before, during });

  await page.eval(`window.getSelection()?.removeAllRanges()`);
  const after = await page.waitFor(`(() => {
    const text = document.querySelector('#bidiReaderLines')?.innerText || '';
    return text.includes(${JSON.stringify(liveMarker)}) ? { liveVisible: true, text } : false;
  })()`, 10000, 'reader catches up after selection clears');
  return {
    selectionText: before.sanitized,
    rawContainedCursor: before.raw.includes('▌'),
    copiedContainedCursor: before.copied.includes('▌'),
    selectionPreservedDuringUpdate: during.selected,
    liveVisibleAfterClear: after.liveVisible,
  };
}

async function testSecondClientAlternateSnapshotRestoresState(page) {
  const suffix = Date.now().toString(36);
  const primaryMarker = `__WARPISH_SNAPSHOT_PRIMARY_${suffix}__`;
  const oldMarker = `__WARPISH_SNAPSHOT_OLD_${suffix}__`;
  const bottomMarker = `__WARPISH_SNAPSHOT_BOTTOM_${suffix}__`;
  const relativeMarker = `__WARPISH_SNAPSHOT_RELATIVE_${suffix}__`;
  const updateTrigger = path.join(runtimeRoot, `snapshot-update-${suffix}`);
  const exitTrigger = path.join(runtimeRoot, `snapshot-exit-${suffix}`);
  const session = await createSession('Alternate Reconnect Snapshot Regression', path.join(runtimeRoot, 'alternate-snapshot-cwd'));
  let controller;
  try {
    controller = await connectRuntimeTestClient(session.id, { cols: 90, rows: 24, name: 'snapshot client A' });
    await waitForRuntimeRole(controller, 'controller');
    await waitForTmuxPaneSize(session.id, '24x90', 5000, 'snapshot controller size');
    respawnPane(session.id, alternateReconnectRelativeUpdateCommand({
      primaryMarker,
      oldMarker,
      bottomMarker,
      relativeMarker,
      updateTrigger,
      exitTrigger,
    }));

    let capture = null;
    const captureDeadline = Date.now() + 15000;
    while (Date.now() < captureDeadline) {
      capture = await api(`/api/sessions/${session.id}/capture?lines=5000&ansi=1`);
      if (capture.alternateActive && capture.active.includes(oldMarker) && capture.active.includes(bottomMarker)) break;
      await delay(80);
    }
    assert(capture?.alternateActive && capture.active.includes(oldMarker) && capture.active.includes(bottomMarker), 'alternate snapshot fixture did not become ready', capture);

    await page.navigate(`${tokenUrl}&case=alternate-runtime-snapshot`);
    await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Alternate Reconnect Snapshot Regression')`, 15000, 'alternate snapshot session selected');
    const before = await page.waitFor(`(() => {
      const rows = Array.from({ length: term.rows }, (_, index) =>
        term.buffer.active.getLine(term.buffer.active.viewportY + index)?.translateToString(true) || '');
      const state = {
        alternate: isTerminalAlternateBuffer(),
        cursorX: term.buffer.active.cursorX,
        cursorY: term.buffer.active.cursorY,
        role: terminalControlRole,
        rows,
      };
      return state.role === 'spectator' && state.alternate && state.cursorX === 6 && state.cursorY === 2
        && state.rows[2]?.includes(${JSON.stringify(oldMarker)})
        && state.rows[19]?.includes(${JSON.stringify(bottomMarker)})
        ? state
        : false;
    })()`, 15000, 'second client alternate snapshot state');

    fs.writeFileSync(updateTrigger, 'update');
    const afterRelative = await page.waitFor(`(() => {
      const rows = Array.from({ length: term.rows }, (_, index) =>
        term.buffer.active.getLine(term.buffer.active.viewportY + index)?.translateToString(true) || '');
      const relativeRows = rows.map((text, index) => ({ text, index })).filter((item) => item.text.includes(${JSON.stringify(relativeMarker)}));
      return isTerminalAlternateBuffer()
        && relativeRows.length === 1
        && relativeRows[0].index === 2
        && rows[19]?.includes(${JSON.stringify(bottomMarker)})
        ? { alternate: true, relativeRows, bottom: rows[19], cursorX: term.buffer.active.cursorX, cursorY: term.buffer.active.cursorY }
        : false;
    })()`, 10000, 'relative update after alternate snapshot');

    fs.writeFileSync(exitTrigger, 'exit');
    const afterExit = await page.waitFor(`(() => {
      const rows = Array.from({ length: term.rows }, (_, index) =>
        term.buffer.active.getLine(term.buffer.active.viewportY + index)?.translateToString(true) || '');
      const joined = rows.join(String.fromCharCode(10));
      return joined.includes(${JSON.stringify(primaryMarker)})
        && !joined.includes(${JSON.stringify(relativeMarker)})
        ? { outerBuffer: term.buffer.active.type, primaryVisible: true, relativeLeaked: false }
        : false;
    })()`, 10000, 'primary screen restored after alternate exit');

    return {
      role: before.role,
      initialCursor: { x: before.cursorX, y: before.cursorY },
      relativeRow: afterRelative.relativeRows[0].index,
      bottomPreserved: afterRelative.bottom.includes(bottomMarker),
      primaryRestored: afterExit.primaryVisible,
      outerBufferAfterPaneExit: afterExit.outerBuffer,
      relativeLeakedToPrimary: afterExit.relativeLeaked,
    };
  } finally {
    await closeRuntimeTestClient(controller);
  }
}

async function testControllerSpectatorLease() {
  const suffix = Date.now().toString(36);
  const readyMarker = `__WARPISH_CONTROLLER_LEASE_READY_${suffix}__`;
  const inputLog = path.join(runtimeRoot, `controller-lease-input-${suffix}.bin`);
  const session = await createSession('Controller Spectator Lease Regression', path.join(runtimeRoot, 'controller-lease-cwd'));
  respawnPane(session.id, controllerLeaseProbeCommand({ readyMarker, inputLog }));
  await waitForFileState(inputLog, () => true, 5000, 'controller lease input log', { binary: true });

  let controller;
  let spectator;
  try {
    controller = await connectRuntimeTestClient(session.id, { cols: 90, rows: 24, name: 'client A' });
    await waitForRuntimeRole(controller, 'controller');
    spectator = await connectRuntimeTestClient(session.id, { cols: 140, rows: 45, name: 'client B' });
    await waitForRuntimeRole(controller, 'controller');
    await waitForRuntimeRole(spectator, 'spectator');
    await waitForTmuxPaneSize(session.id, '24x90', 5000, 'initial controller size');
    fs.writeFileSync(inputLog, Buffer.alloc(0));

    const ignoredInput = `SPECTATOR_IGNORED_${suffix}`;
    const ignoredBarrier = `SPECTATOR_BARRIER_${suffix}`;
    const spectatorRoleCount = spectator.roles.length;
    spectator.socket.send(JSON.stringify({ type: 'input', data: ignoredInput }));
    spectator.socket.send(JSON.stringify({ type: 'resize', cols: 177, rows: 55 }));
    spectator.socket.send(JSON.stringify({ type: 'input', data: ignoredBarrier }));
    await waitForRuntimeRoleCount(spectator, 'spectator', spectatorRoleCount + 2);
    const ignoredBytes = fs.readFileSync(inputLog);
    const ignoredSize = readTmuxPaneSize(session.id);
    assert(!ignoredBytes.includes(Buffer.from(ignoredInput)) && !ignoredBytes.includes(Buffer.from(ignoredBarrier)), 'spectator input reached the PTY before take-control', {
      inputHex: ignoredBytes.toString('hex'),
      roles: { controller: controller.roles, spectator: spectator.roles },
    });
    assert(ignoredSize === '24x90', 'spectator resize reached the PTY before take-control', { ignoredSize });

    const controllerInput = `CONTROLLER_ACCEPTED_${suffix}`;
    controller.socket.send(JSON.stringify({ type: 'input', data: controllerInput }));
    controller.socket.send(JSON.stringify({ type: 'resize', cols: 101, rows: 31 }));
    await waitForFileState(inputLog, (bytes) => bytes.includes(Buffer.from(controllerInput)), 5000, 'controller input accepted', { binary: true });
    await waitForTmuxPaneSize(session.id, '31x101', 5000, 'controller resize accepted');

    spectator.socket.send(JSON.stringify({ type: 'take-control', cols: 133, rows: 41 }));
    await waitForRuntimeRole(spectator, 'controller');
    await waitForRuntimeRole(controller, 'spectator');
    await waitForTmuxPaneSize(session.id, '41x133', 5000, 'take-control resize accepted');
    fs.writeFileSync(inputLog, Buffer.alloc(0));

    const oldControllerInput = `OLD_CONTROLLER_IGNORED_${suffix}`;
    const oldControllerBarrier = `OLD_CONTROLLER_BARRIER_${suffix}`;
    const newControllerInput = `NEW_CONTROLLER_ACCEPTED_${suffix}`;
    const previousControllerRoleCount = controller.roles.length;
    controller.socket.send(JSON.stringify({ type: 'input', data: oldControllerInput }));
    controller.socket.send(JSON.stringify({ type: 'resize', cols: 166, rows: 52 }));
    controller.socket.send(JSON.stringify({ type: 'input', data: oldControllerBarrier }));
    spectator.socket.send(JSON.stringify({ type: 'input', data: newControllerInput }));
    spectator.socket.send(JSON.stringify({ type: 'resize', cols: 144, rows: 44 }));
    await waitForFileState(inputLog, (bytes) => bytes.includes(Buffer.from(newControllerInput)), 5000, 'new controller input accepted', { binary: true });
    await waitForTmuxPaneSize(session.id, '44x144', 5000, 'new controller resize accepted');
    await waitForRuntimeRoleCount(controller, 'spectator', previousControllerRoleCount + 2);
    const finalInput = fs.readFileSync(inputLog);
    const finalSize = readTmuxPaneSize(session.id);
    assert(!finalInput.includes(Buffer.from(oldControllerInput)) && !finalInput.includes(Buffer.from(oldControllerBarrier)), 'previous controller input reached the PTY after lease transfer', {
      inputText: finalInput.toString('utf8'),
      roles: { previousController: controller.roles, newController: spectator.roles },
    });
    assert(finalSize === '44x144', 'previous controller resize reached the PTY after lease transfer', { finalSize });

    return {
      initialRoles: { clientA: 'controller', clientB: 'spectator' },
      spectatorIgnoredBeforeTakeControl: true,
      controllerAcceptedBeforeTransfer: true,
      finalRoles: { clientA: controller.roles.at(-1), clientB: spectator.roles.at(-1) },
      previousControllerIgnoredAfterTransfer: true,
      finalSize,
    };
  } finally {
    await closeRuntimeTestClient(spectator);
    await closeRuntimeTestClient(controller);
  }
}

async function testTypingDoesNotRevertToStaleCapture(page) {
  const appJs = await httpText('/app.js');
  assert(!appJs.includes('lastCapturedReaderEntries') && !appJs.includes('const shouldUseCapture ='), 'old captured-reader source feedback loop returned');
  assert(appJs.includes("bidiReaderCaptureMode === 'history' && capturedReaderHistoryState.known"), 'canonical capture-history render mode is missing');
  assert(appJs.includes('terminalOutputRevision > capturedReaderHistoryRevision') && appJs.includes('getReadableTerminalScreenEntries'), 'revision-gated live screen tail is missing');

  const session = await createSession('Typing Flicker Regression', path.join(runtimeRoot, 'typing-cwd'));
  await delay(800);
  await page.navigate(`${tokenUrl}&case=typing-flicker`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Typing Flicker Regression')`, 15000, 'typing session selected');
  await page.waitFor(`document.querySelector('#statusText')?.textContent.includes('connected')`, 15000, 'typing terminal connected');

  const marker = `__WARPISH_NO_FLICKER_${Date.now().toString(36)}__`;
  const payload = await page.eval(`(async () => {
    const marker = ${JSON.stringify(marker)};
    const lines = document.getElementById('bidiReaderLines');
    const reader = document.getElementById('bidiReader');
    const before = lines?.innerText || '';
    const sample = () => lines?.innerText || '';
    if (typeof window.sendRaw === 'function') {
      window.sendRaw(marker, { directTmux: true });
    } else {
      for (const ch of marker) {
        reader.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      }
    }
    const samples = [];
    for (let index = 0; index < 50; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      samples.push(sample());
    }
    const firstWithMarker = samples.findIndex((text) => text.includes(marker));
    const staleAfterMarker = firstWithMarker >= 0
      ? samples.slice(firstWithMarker + 1).some((text) => !text.includes(marker) && text.trim() === before.trim())
      : false;
    return {
      before,
      marker,
      firstWithMarker,
      staleAfterMarker,
      finalText: samples.at(-1) || '',
      markerSampleCount: samples.filter((text) => text.includes(marker)).length,
      sampleCount: samples.length,
    };
  })()`);

  assert(payload.firstWithMarker >= 0, 'typed marker never appeared in readable terminal', payload);
  assert(!payload.staleAfterMarker, 'reader reverted to stale captured output after typed text appeared', payload);
  assert(payload.finalText.includes(marker), 'typed marker was not stable in final reader output', payload);

  return payload;
}


async function testSessionMetadataXssGuard(page) {
  const payloadText = '<img src=x onerror=window.__warpishXss=1>';
  const hostileCwd = path.join(runtimeRoot, `cwd-${payloadText}`);
  fs.mkdirSync(hostileCwd, { recursive: true });
  await createSession(`XSS title ${payloadText}`, hostileCwd);
  await delay(500);
  await page.navigate(`${tokenUrl}&case=xss-guard`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('XSS title')`, 15000, 'xss session selected');
  const result = await page.eval(`(() => {
    const card = [...document.querySelectorAll('.session-card')].find((node) => node.textContent.includes('XSS title'));
    return {
      xss: window.__warpishXss || 0,
      imageCount: card ? card.querySelectorAll('img').length : -1,
      cardText: card?.textContent || '',
      metaHtml: card?.querySelector('.session-meta')?.innerHTML || '',
    };
  })()`);
  assert(result.xss === 0, 'hostile session metadata executed JavaScript', result);
  assert(result.imageCount === 0, 'hostile session metadata created HTML nodes', result);
  assert(result.cardText.includes(payloadText), 'hostile metadata should render as literal text', result);
  return result;
}

async function testApiPlainTextErrorHandling(page) {
  const result = await page.eval(`(async () => {
    try {
      await api('/definitely-missing-route-for-api-error-test');
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  })()`);
  assert(result.ok === false, 'missing API route unexpectedly succeeded', result);
  assert(result.message.includes('HTTP 404'), 'plain-text/html API error did not preserve HTTP status', result);
  assert(!result.message.includes('Unexpected token'), 'API error handling leaked JSON.parse failure instead of real status', result);
  return result;
}

async function testMouseModeAndMobileLayout(page) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 780, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${tokenUrl}&case=mobile-layout`);
  const mobile = await page.waitFor(`(() => {
    document.body.classList.add('blocks-open');
    const toolbar = document.querySelector('.toolbar-actions');
    const grid = document.querySelector('.terminal-grid');
    const mouseButton = document.getElementById('mouseModeToggle');
    if (!toolbar || !grid || !mouseButton) return false;
    return {
      toolbarDisplay: getComputedStyle(toolbar).display,
      toolbarOverflowX: getComputedStyle(toolbar).overflowX,
      gridColumns: getComputedStyle(grid).gridTemplateColumns,
      mouseText: mouseButton.textContent,
    };
  })()`, 15000, 'mobile toolbar and blocks layout');
  assert(mobile.toolbarDisplay !== 'none', 'critical toolbar controls are hidden on narrow viewport', mobile);
  assert(!mobile.gridColumns.includes('360px'), 'blocks-open mobile grid still forces a desktop second column', mobile);
  const raw = await page.eval(`(() => {
    document.getElementById('mouseModeToggle')?.click();
    const reader = document.getElementById('bidiReader');
    return {
      bodyClass: document.body.className,
      readerPointerEvents: reader ? getComputedStyle(reader).pointerEvents : '',
      text: document.getElementById('mouseModeToggle')?.textContent || '',
    };
  })()`);
  assert(raw.bodyClass.includes('reader-mouse-raw'), 'mouse raw passthrough mode did not activate', raw);
  assert(raw.readerPointerEvents === 'none', 'raw mouse mode must pass pointer events through the readable overlay', raw);
  await page.send('Emulation.clearDeviceMetricsOverride');
  return { mobile, raw };
}

function chromeVersionLabel() {
  const infoPlist = path.resolve(path.dirname(chromePath), '..', 'Info.plist');
  if (fs.existsSync(infoPlist) && fs.existsSync('/usr/libexec/PlistBuddy')) {
    const plistResult = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', infoPlist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    if (plistResult.status === 0 && plistResult.stdout.trim()) {
      return `Google Chrome ${plistResult.stdout.trim()}`;
    }
  }

  const result = spawnSync(chromePath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status === 0 && output) return output;
  const reason = result.error?.code || result.signal || `status ${result.status}`;
  return `${path.basename(chromePath)} (version unavailable: ${reason})`;
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
      if (!firstError) firstError = error;
      await terminateProcess(chrome);
      chrome = null;
      try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(chromeProfile, { recursive: true });
      if (attempt === 0) await delay(1500);
      else {
        error.message += `\nfirst Chrome launch error=${firstError.message}`;
        throw error;
      }
    }
  }
  throw firstError || new Error('Chrome failed to start');
}

async function main() {
  assert(fs.existsSync(chromePath), `Chrome binary not found at ${chromePath}`);
  const inheritedTmuxProbe = isolatedTmuxEnvironment({ TMUX: '/tmp/parent,1,0', TMUX_PANE: '%99' });
  assert(!('TMUX' in inheritedTmuxProbe) && !('TMUX_PANE' in inheritedTmuxProbe) && inheritedTmuxProbe.TMUX_TMPDIR === tmuxTmpDir, 'browser regressions did not isolate an inherited tmux client environment', inheritedTmuxProbe);
  await startServer();
  const page = await startChromeWithRetry();
  browserPage = page;
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const health = await api('/healthz');

  if (browserOnly) {
    const requestedCases = browserOnly === 'high-value'
      ? ['clipboard-shortcuts', 'reader-selection', 'controller-lease', 'runtime-snapshot', 'hermes-oscillation', 'hermes-palette']
      : [browserOnly];
    const knownCases = new Set(['short-history-typing', 'terminal56-scroll', 'clipboard-shortcuts', 'reader-selection', 'controller-lease', 'runtime-snapshot', 'hermes-oscillation', 'hermes-palette']);
    assert(requestedCases.every((name) => knownCases.has(name)), `unknown WARPISH_BROWSER_ONLY case: ${browserOnly}`);
    const regressions = {};
    if (requestedCases.includes('short-history-typing')) {
      regressions.shortHistoryTypingFlicker = await testShortHistoryTypingAndBackspaceStayStable(page);
    }
    if (requestedCases.includes('terminal56-scroll')) {
      regressions.terminal56ScrollTyping = await testTerminal56ScrollAndTypingAreStable(page);
    }
    if (requestedCases.includes('clipboard-shortcuts')) {
      regressions.readableClipboardShortcuts = await testReadableClipboardShortcutsDoNotSendControlBytes(page);
    }
    if (requestedCases.includes('reader-selection')) {
      regressions.readerSelectionStability = await testReaderSelectionSurvivesLiveOutput(page);
    }
    if (requestedCases.includes('controller-lease')) {
      regressions.controllerSpectatorLease = await testControllerSpectatorLease();
    }
    if (requestedCases.includes('runtime-snapshot')) {
      regressions.alternateRuntimeSnapshot = await testSecondClientAlternateSnapshotRestoresState(page);
    }
    if (requestedCases.includes('hermes-palette')) {
      regressions.hermesPaletteStyles = await testHermesPaletteStyles(page);
      regressions.capturedHistoryReducer = await testCapturedHistoryReducer(page);
    }
    if (requestedCases.includes('hermes-oscillation')) {
      regressions.hermesReadableHistoryStability = await testHermesReadableHistoryDoesNotOscillate(page);
    }
    await delay(150);
    page.assertNoUnhandledErrors(`${browserOnly} browser regression`);
    console.log(JSON.stringify({
      ok: true,
      health,
      browser: { chrome: chromeVersionLabel(), cdpPort },
      isolatedRuntime: { dataDir, sessionPrefix },
      diagnostics: page.diagnosticSnapshot(),
      regressions,
    }, null, 2));
    page.close();
    return;
  }

  const hermesPaletteStyles = await testHermesPaletteStyles(page);
  const capturedHistoryReducer = await testCapturedHistoryReducer(page);
  const hermesReadableHistoryStability = await testHermesReadableHistoryDoesNotOscillate(page);
  const readableLinks = await testReadableLinksOpenNewTabs(page);
  const emptyReaderGuard = await testEmptyReaderDoesNotBlankTerminal(page);
  const longHermesScrollback = await testLongHermesScrollbackIsReadable(page);
  const richHistoryTypingStability = await testRichHistoryTypingDoesNotCollapseOrJump(page);
  const terminal56ScrollTyping = await testTerminal56ScrollAndTypingAreStable(page);
  const sessionSwitchingStability = await testSessionSwitchingSuppressesFocusReportsAndScrollBounce(page);
  const alternateRuntimeSnapshot = await testSecondClientAlternateSnapshotRestoresState(page);
  const controllerSpectatorLease = await testControllerSpectatorLease();
  const readableClipboardShortcuts = await testReadableClipboardShortcutsDoNotSendControlBytes(page);
  const readerSelectionStability = await testReaderSelectionSurvivesLiveOutput(page);
  const shortHistoryTypingFlicker = await testShortHistoryTypingAndBackspaceStayStable(page);
  const typingNoFlicker = await testTypingDoesNotRevertToStaleCapture(page);
  const sessionMetadataXssGuard = await testSessionMetadataXssGuard(page);
  const apiPlainTextErrorHandling = await testApiPlainTextErrorHandling(page);
  const mouseModeAndMobileLayout = await testMouseModeAndMobileLayout(page);
  await delay(150);
  page.assertNoUnhandledErrors();

  console.log(JSON.stringify({
    ok: true,
    health,
    browser: {
      chrome: chromeVersionLabel(),
      cdpPort,
    },
    isolatedRuntime: {
      dataDir,
      sessionPrefix,
    },
    diagnostics: page.diagnosticSnapshot(),
    regressions: {
      hermesPaletteStyles,
      capturedHistoryReducer,
      hermesReadableHistoryStability,
      readableLinks,
      emptyReaderGuard,
      longHermesScrollback: {
        lineCount: longHermesScrollback.lineCount,
        scrollHeight: longHermesScrollback.scrollHeight,
        clientHeight: longHermesScrollback.clientHeight,
        topVisible: longHermesScrollback.topVisible,
      },
      richHistoryTypingStability,
      terminal56ScrollTyping: {
        captureReason: terminal56ScrollTyping.captureReason,
        lineCount: terminal56ScrollTyping.lineCount,
        beforeType: terminal56ScrollTyping.beforeType,
        afterType: terminal56ScrollTyping.afterType,
        afterSecondWheel: terminal56ScrollTyping.afterSecondWheel,
      },
      sessionSwitchingStability,
      alternateRuntimeSnapshot,
      controllerSpectatorLease,
      readableClipboardShortcuts,
      readerSelectionStability,
      shortHistoryTypingFlicker,
      typingNoFlicker: {
        marker: typingNoFlicker.marker,
        firstWithMarker: typingNoFlicker.firstWithMarker,
        markerSampleCount: typingNoFlicker.markerSampleCount,
        sampleCount: typingNoFlicker.sampleCount,
      },
      sessionMetadataXssGuard: {
        imageCount: sessionMetadataXssGuard.imageCount,
        xss: sessionMetadataXssGuard.xss,
      },
      apiPlainTextErrorHandling,
      mouseModeAndMobileLayout,
    },
  }, null, 2));

  page.close();
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
  if (token) {
    for (const sessionId of createdSessions.reverse()) {
      try { await api(`/api/sessions/${sessionId}?purge=1`, { method: 'DELETE' }); } catch {}
    }
  }
  try {
    execFileSync(tmuxBin, ['list-sessions', '-F', '#S'], { encoding: 'utf8', env: tmuxEnvironment })
      .split('\n')
      .filter((name) => name.startsWith(sessionPrefix))
      .forEach((name) => {
        try { execFileSync(tmuxBin, ['kill-session', '-t', name], { env: tmuxEnvironment }); } catch {}
      });
  } catch {}
  await terminateProcess(chrome);
  await terminateProcess(server);
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
}
