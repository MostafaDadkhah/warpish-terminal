import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const projectRoot = new URL('..', import.meta.url).pathname;
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warpish-browser-regressions-'));
const dataDir = path.join(runtimeRoot, 'data');
const tokenFile = path.join(runtimeRoot, 'token');
const chromeProfile = path.join(runtimeRoot, 'chrome-profile');
const sessionPrefix = `warpishreg-${process.pid.toString(36)}-`;
const createdSessions = [];

let server;
let chrome;
let tokenUrl;
let token;
let port;
let cdpPort;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

function httpRequest({ host = '127.0.0.1', port: requestPort, method = 'GET', pathname = '/', headers = {}, body, json = true }) {
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
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      WARPISH_DATA_DIR: dataDir,
      WARPISH_TOKEN_FILE: tokenFile,
      WARPISH_SESSION_PREFIX: sessionPrefix,
    },
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

  for (let i = 0; i < 120; i += 1) {
    try {
      const list = await httpRequest({ port: cdpPort, pathname: '/json/list' });
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return new CdpPage(page.webSocketDebuggerUrl);
    } catch {}
    await delay(100);
  }
  throw new Error('Chrome CDP target did not become available');
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
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
        this.events.push(msg);
      });
    });
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
  execFileSync('tmux', ['respawn-pane', '-k', '-t', sessionId, command], { stdio: 'pipe' });
}

function ansiDemoCommand() {
  const ESC = '\x1b';
  const screen = `${ESC}[2J${ESC}[H${ESC}[1;36mWarpish Terminal${ESC}[0m\n`
    + `Readable ANSI regression fixture.\n\n`
    + `${ESC}[38;2;139;92;246mdemo@localhost %${ESC}[0m hermes chat\n\n`
    + `${ESC}[1m⚕ Hermes${ESC}[0m\n`
    + `  سلام Mostafa — خروجی فارسی/English باید خوانا بماند.\n`
    + `  English commands stay LTR: ${ESC}[33mgit status --short${ESC}[0m\n`
    + `  Paths stay readable: ${ESC}[36m/demo/project/src/app.js${ESC}[0m\n`
    + `  ANSI colors survive: ${ESC}[31mred${ESC}[0m  ${ESC}[32mgreen${ESC}[0m  ${ESC}[1;34mbold-blue${ESC}[0m  ${ESC}[38;2;255;128;64mtruecolor-orange${ESC}[0m  ${ESC}[48;2;64;40;10mbackground${ESC}[0m\n\n`
    + `${ESC}[38;2;34;211;238mReadable: on${ESC}[0m\n`;
  const code = `import sys,time; sys.stdout.write(${JSON.stringify(screen)}); sys.stdout.flush(); time.sleep(90)`;
  return `python3 -c ${shellQuote(code)}`;
}

async function testAnsiStyles(page) {
  const session = await createSession('ANSI Style Regression', path.join(runtimeRoot, 'ansi-cwd'));
  respawnPane(session.id, ansiDemoCommand());
  await delay(800);
  await page.navigate(`${tokenUrl}&case=ansi-styles`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('ANSI Style Regression')`, 15000, 'ANSI session selected');
  const payload = await page.waitFor(`(() => {
    const line = [...document.querySelectorAll('#bidiReaderLines .bidi-line')]
      .find((candidate) => candidate.textContent.includes('ANSI colors survive'));
    if (!line) return false;
    const defaultColor = getComputedStyle(line).color;
    const runs = [...line.querySelectorAll('.bidi-style-run')].map((node) => ({
      text: node.textContent,
      color: getComputedStyle(node).color,
      backgroundColor: getComputedStyle(node).backgroundColor,
      fontWeight: getComputedStyle(node).fontWeight,
      style: node.getAttribute('style') || '',
    }));
    return { text: line.textContent, defaultColor, runs };
  })()`, 15000, 'styled ANSI reader line');

  const run = (needle) => payload.runs.find((item) => item.text.includes(needle));
  const red = run('red');
  const green = run('green');
  const blue = run('bold-blue');
  const orange = run('truecolor-orange');
  const background = run('background');

  assert(red && red.color !== payload.defaultColor, 'ANSI red run was not visibly styled', payload);
  assert(green && green.color !== payload.defaultColor, 'ANSI green run was not visibly styled', payload);
  assert(blue && blue.color !== payload.defaultColor && Number.parseInt(blue.fontWeight, 10) >= 700, 'ANSI bold blue run lost color or bold styling', payload);
  assert(orange && /255\s*,\s*128\s*,\s*64/.test(orange.color), 'ANSI truecolor orange run was not preserved', payload);
  assert(background && !['rgba(0, 0, 0, 0)', 'transparent'].includes(background.backgroundColor), 'ANSI background run lost background color', payload);

  return {
    ok: true,
    line: payload.text,
    styledRuns: payload.runs.filter((item) => item.style).map((item) => item.text),
  };
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

async function testTypingDoesNotRevertToStaleCapture(page) {
  const appJs = await httpText('/app.js');
  assert(!appJs.includes('isSparseReadableEntries(entries) || lastCapturedReaderEntries.length > 0'), 'old captured-reader fast-path regression returned');
  assert(appJs.includes('const shouldUseCapture = isTerminalAlternateBuffer() && (!xtermHasText || xtermIsSparse)'), 'xterm-first reader fast-path guard is missing');

  const session = await createSession('Typing Flicker Regression', path.join(runtimeRoot, 'typing-cwd'));
  await delay(800);
  await page.navigate(`${tokenUrl}&case=typing-flicker`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Typing Flicker Regression')`, 15000, 'typing session selected');
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes('%')`, 15000, 'shell prompt visible in reader');

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

async function main() {
  assert(fs.existsSync(chromePath), `Chrome binary not found at ${chromePath}`);
  await startServer();
  const page = await startChrome();
  await page.init();
  const health = await api('/healthz');

  const ansiStyles = await testAnsiStyles(page);
  const emptyReaderGuard = await testEmptyReaderDoesNotBlankTerminal(page);
  const typingNoFlicker = await testTypingDoesNotRevertToStaleCapture(page);

  console.log(JSON.stringify({
    ok: true,
    health,
    browser: {
      chrome: execFileSync(chromePath, ['--version'], { encoding: 'utf8' }).trim(),
      cdpPort,
    },
    isolatedRuntime: {
      dataDir,
      sessionPrefix,
    },
    regressions: {
      ansiStyles,
      emptyReaderGuard,
      typingNoFlicker: {
        marker: typingNoFlicker.marker,
        firstWithMarker: typingNoFlicker.firstWithMarker,
        markerSampleCount: typingNoFlicker.markerSampleCount,
        sampleCount: typingNoFlicker.sampleCount,
      },
    },
  }, null, 2));

  page.close();
}

try {
  await main();
} finally {
  if (token) {
    for (const sessionId of createdSessions.reverse()) {
      try { await api(`/api/sessions/${sessionId}?purge=1`, { method: 'DELETE' }); } catch {}
    }
  }
  try {
    execFileSync('tmux', ['list-sessions', '-F', '#S'], { encoding: 'utf8' })
      .split('\n')
      .filter((name) => name.startsWith(sessionPrefix))
      .forEach((name) => {
        try { execFileSync('tmux', ['kill-session', '-t', name]); } catch {}
      });
  } catch {}
  if (chrome && !chrome.killed) chrome.kill('SIGTERM');
  if (server && !server.killed) server.kill('SIGTERM');
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
}
