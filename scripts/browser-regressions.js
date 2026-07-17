import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const projectRoot = new URL('..', import.meta.url).pathname;
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runtimeRoot = process.env.WARPISH_BROWSER_RUNTIME_ROOT
  ? path.resolve(process.env.WARPISH_BROWSER_RUNTIME_ROOT)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'warpish-browser-regressions-'));
fs.mkdirSync(runtimeRoot, { recursive: true });
const dataDir = path.join(runtimeRoot, 'data');
const tokenFile = path.join(runtimeRoot, 'token');
const chromeProfile = path.join(runtimeRoot, 'chrome-profile');
const sessionPrefix = (process.env.WARPISH_SESSION_PREFIX || `warpishreg-${process.pid.toString(36)}-`)
  .replace(/[^a-z0-9-]/gi, '')
  .toLowerCase() || `warpishreg-${process.pid.toString(36)}-`;
const createdSessions = [];

let server;
let chrome;
let tokenUrl;
let token;
let port;
let cdpPort;
let chromeDiagnostics = { stdout: '', stderr: '', exit: null, error: null };

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
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      WARPISH_DATA_DIR: dataDir,
      WARPISH_TOKEN_FILE: tokenFile,
      WARPISH_SESSION_PREFIX: sessionPrefix,
      WARPISH_SKIP_USER_ZSHRC: '1',
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
  execFileSync('tmux', ['respawn-pane', '-k', '-t', sessionId, command], { stdio: 'pipe' });
}

function hermesPaletteDemoCommand() {
  const ESC = '\x1b';
  const screen = `${ESC}[2J${ESC}[HHermes readable regression fixture using captured Hermes SGR values.\n\n`
    + `${ESC}[38;2;205;127;50mHermes border${ESC}[0m\n`
    + `${ESC}[38;2;255;248;220mWelcome to Hermes Agent! Type your message or /help for commands.${ESC}[0m\n`
    + `${ESC}[2;38;2;184;134;11m✦ Tip: BROWSER_CDP_URL connects browser tools to Chromium.${ESC}[0m\n`
    + `${ESC}[1;33m⚠ 57 commits behind${ESC}[0;2;33m — run ${ESC}[1mhermes update${ESC}[0;2;33m to update${ESC}[0m\n`
    + `${ESC}[1;38;5;71m[██░░░░░░░░]${ESC}[0m${ESC}[38;5;136m${ESC}[48;5;234m 18% │ 7m │ ⏱ 3m 36s${ESC}[0m\n`
    + `${ESC}[38;5;173m────────────────────────────────────────${ESC}[0m\n`
    + `${ESC}[3;38;5;136m⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel${ESC}[0m\n`
    + `سلام Mostafa — خروجی فارسی/English باید خوانا بماند.\n`;
  const code = `import sys,time; sys.stdout.write(${JSON.stringify(screen)}); sys.stdout.flush(); time.sleep(90)`;
  return `python3 -c ${shellQuote(code)}`;
}

async function testHermesPaletteStyles(page) {
  const session = await createSession('Hermes Palette Regression', path.join(runtimeRoot, 'hermes-palette-cwd'));
  respawnPane(session.id, hermesPaletteDemoCommand());
  await delay(800);
  await page.navigate(`${tokenUrl}&case=hermes-palette`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Hermes Palette Regression')`, 15000, 'Hermes palette session selected');
  const payload = await page.waitFor(`(() => {
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
    return { text: lines.map((line) => line.textContent).join(String.fromCharCode(10)), runs };
  })()`, 15000, 'styled Hermes palette reader output');

  const run = (needle) => payload.runs.find((item) => item.text.includes(needle));
  const border = run('Hermes border');
  const welcome = run('Welcome to Hermes Agent');
  const tip = run('Tip: BROWSER_CDP_URL');
  const warning = run('57 commits behind');
  const progress = run('[██░░░░░░░░]');
  const progressMeta = run('18%');
  const promptHint = run('msg=interrupt');

  assert(border && /205\s*,\s*127\s*,\s*50/.test(border.color), 'Hermes border orange from captured SGR was not preserved', payload);
  assert(welcome && /255\s*,\s*248\s*,\s*220/.test(welcome.color), 'Hermes warm welcome foreground was not preserved', payload);
  assert(tip && /184\s*,\s*134\s*,\s*11/.test(tip.color) && Number(tip.opacity) < 1, 'Hermes dim gold tip styling was not preserved', payload);
  assert(warning && /245\s*,\s*245\s*,\s*67/.test(warning.color) && Number.parseInt(warning.fontWeight, 10) >= 700, 'Hermes bold yellow warning styling was not preserved', payload);
  assert(progress && /95\s*,\s*175\s*,\s*95/.test(progress.color) && Number.parseInt(progress.fontWeight, 10) >= 700, 'Hermes green progress styling was not preserved', payload);
  assert(progressMeta && /175\s*,\s*135\s*,\s*0/.test(progressMeta.color) && /28\s*,\s*28\s*,\s*28/.test(progressMeta.backgroundColor), 'Hermes progress metadata foreground/background was not preserved', payload);
  assert(promptHint && /175\s*,\s*135\s*,\s*0/.test(promptHint.color) && promptHint.fontStyle === 'italic', 'Hermes prompt hint italic/gold styling was not preserved', payload);

  return {
    ok: true,
    styledRuns: payload.runs.filter((item) => item.style).map((item) => item.text),
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
    // This mirrors the tmux/Hermes failure mode: normal capture keeps the long history,
    // while tmux alternate capture can expose only a short stale viewport. The reader must
    // choose the richer normal capture so scrollback and typing do not jump/truncate.
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
  await delay(800);

  const capture = await api(`/api/sessions/${session.id}/capture?lines=5000&ansi=1`);
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

  for (const key of typedMarker.split('')) {
    await dispatchReadableKey(page, key);
    await delay(90);
  }
  await dispatchReadableKey(page, 'Enter');
  await delay(700);
  await page.eval(`refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })`);
  const afterType = await page.waitFor(`(() => {
    const lines = document.getElementById('bidiReaderLines');
    const text = lines?.innerText || '';
    if (!text.includes(${JSON.stringify(`INPUT_ECHO:${typedMarker}`)})) return false;
    return ${visibleReaderStateExpression()};
  })()`, 15000, 'typed marker echoed without reader jump');

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

async function testTypingDoesNotRevertToStaleCapture(page) {
  const appJs = await httpText('/app.js');
  assert(!appJs.includes('isSparseReadableEntries(entries) || lastCapturedReaderEntries.length > 0'), 'old captured-reader fast-path regression returned');
  assert(appJs.includes('const shouldUseCapture = (isTerminalAlternateBuffer() && (!xtermHasText || xtermIsSparse))'), 'xterm-first reader fast-path guard is missing');
  assert(appJs.includes('isBidiReaderHistoryMode() && lastCapturedReaderEntries.length > entries.length'), 'history-scroll capture guard is missing');

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

async function main() {
  assert(fs.existsSync(chromePath), `Chrome binary not found at ${chromePath}`);
  await startServer();
  const page = await startChrome();
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const health = await api('/healthz');

  const hermesPaletteStyles = await testHermesPaletteStyles(page);
  const readableLinks = await testReadableLinksOpenNewTabs(page);
  const emptyReaderGuard = await testEmptyReaderDoesNotBlankTerminal(page);
  const longHermesScrollback = await testLongHermesScrollbackIsReadable(page);
  const richHistoryTypingStability = await testRichHistoryTypingDoesNotCollapseOrJump(page);
  const terminal56ScrollTyping = await testTerminal56ScrollAndTypingAreStable(page);
  const sessionSwitchingStability = await testSessionSwitchingSuppressesFocusReportsAndScrollBounce(page);
  const typingNoFlicker = await testTypingDoesNotRevertToStaleCapture(page);
  const sessionMetadataXssGuard = await testSessionMetadataXssGuard(page);
  const apiPlainTextErrorHandling = await testApiPlainTextErrorHandling(page);
  const mouseModeAndMobileLayout = await testMouseModeAndMobileLayout(page);

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
    regressions: {
      hermesPaletteStyles,
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
  await terminateProcess(chrome);
  await terminateProcess(server);
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
}
