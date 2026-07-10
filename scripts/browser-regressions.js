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
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes('%')`, 15000, 'readable-link shell prompt visible');
  await page.eval(`window.sendRaw(${JSON.stringify(`clear; ${readableLinkDemoShellCommand()}\r`)}, { directTmux: true })`);
  const payload = await page.waitFor(`(() => {
    const readerText = document.querySelector('#bidiReaderLines')?.innerText || '';
    if (!readerText.includes('Readable link regression fixture.') || !readerText.includes('Persian URL:')) return false;
    if (readerText.includes("printf '%")) return false;
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
    if (anchors.length < 4) return false;
    return { anchors, readerText: document.querySelector('#bidiReaderLines')?.innerText || '' };
  })()`, 15000, 'readable links rendered as anchors');

  const byText = (needle) => payload.anchors.find((link) => link.text.includes(needle));
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

async function testLongHermesScrollbackIsReadable(page) {
  const appJs = await httpText('/app.js');
  assert(appJs.includes('const BIDI_READER_MAX_LINES = 2000'), 'readable terminal line cap is too small for long Hermes answers');
  assert(appJs.includes('capture?lines=5000&ansi=1'), 'tmux capture line count is too small for long Hermes answers');
  assert(appJs.includes('refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })'), 'reader wheel does not prefer tmux capture for history scroll');

  const topMarker = `__WARPISH_LONG_SCROLL_TOP_${Date.now().toString(36)}__`;
  const bottomMarker = `__WARPISH_LONG_SCROLL_BOTTOM_${Date.now().toString(36)}__`;
  const session = await createSession('Long Hermes Scroll Regression', path.join(runtimeRoot, 'long-scroll-cwd'));
  await delay(500);
  await page.navigate(`${tokenUrl}&case=long-scrollback`);
  await page.waitFor(`document.querySelector('#sessionTitle')?.textContent.includes('Long Hermes Scroll Regression')`, 15000, 'long-scroll session selected');
  await page.waitFor(`(document.querySelector('#bidiReaderLines')?.innerText || '').includes('%')`, 15000, 'long-scroll shell prompt visible');
  await page.eval(`window.sendRaw(${JSON.stringify(`${longHermesScrollbackCommand({ topMarker, bottomMarker, lines: 650 })}\r`)}, { directTmux: true })`);
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

async function testTypingDoesNotRevertToStaleCapture(page) {
  const appJs = await httpText('/app.js');
  assert(!appJs.includes('isSparseReadableEntries(entries) || lastCapturedReaderEntries.length > 0'), 'old captured-reader fast-path regression returned');
  assert(appJs.includes('const shouldUseCapture = (isTerminalAlternateBuffer() && (!xtermHasText || xtermIsSparse))'), 'xterm-first reader fast-path guard is missing');
  assert(appJs.includes('isBidiReaderHistoryMode() && lastCapturedReaderEntries.length > entries.length'), 'history-scroll capture guard is missing');

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

async function main() {
  assert(fs.existsSync(chromePath), `Chrome binary not found at ${chromePath}`);
  await startServer();
  const page = await startChrome();
  await page.init();
  const health = await api('/healthz');

  const hermesPaletteStyles = await testHermesPaletteStyles(page);
  const readableLinks = await testReadableLinksOpenNewTabs(page);
  const emptyReaderGuard = await testEmptyReaderDoesNotBlankTerminal(page);
  const longHermesScrollback = await testLongHermesScrollbackIsReadable(page);
  const typingNoFlicker = await testTypingDoesNotRevertToStaleCapture(page);
  const sessionMetadataXssGuard = await testSessionMetadataXssGuard(page);
  const apiPlainTextErrorHandling = await testApiPlainTextErrorHandling(page);
  const mouseModeAndMobileLayout = await testMouseModeAndMobileLayout(page);

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
      hermesPaletteStyles,
      readableLinks,
      emptyReaderGuard,
      longHermesScrollback: {
        lineCount: longHermesScrollback.lineCount,
        scrollHeight: longHermesScrollback.scrollHeight,
        clientHeight: longHermesScrollback.clientHeight,
        topVisible: longHermesScrollback.topVisible,
      },
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
  if (chrome && !chrome.killed) chrome.kill('SIGTERM');
  if (server && !server.killed) server.kill('SIGTERM');
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
}
