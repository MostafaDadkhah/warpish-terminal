import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const startedAt = Date.now();
const timeoutMs = Number(process.env.WARPISH_UI_TIMEOUT_MS || 600_000);
const runtimeRoot = fs.mkdtempSync(path.join('/tmp', 'warpish-ui-agent-'));
const tmuxTmpDir = path.join(runtimeRoot, 'tmux');
const sessionPrefix = `warpishui-${process.pid.toString(36)}-${Date.now().toString(36)}-`;
const tmuxBin = process.env.TMUX_BIN
  || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((candidate) => fs.existsSync(candidate))
  || 'tmux';

function isolatedTmuxEnvironment(extra = {}) {
  const env = { ...process.env, ...extra, TMUX_TMPDIR: tmuxTmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function cleanupTmuxSessions() {
  let output = '';
  try {
    output = execFileSync(tmuxBin, ['list-sessions', '-F', '#S'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: isolatedTmuxEnvironment(),
    });
  } catch {
    return [];
  }
  const cleaned = [];
  for (const name of output.split('\n').filter((value) => value.startsWith(sessionPrefix))) {
    try {
      execFileSync(tmuxBin, ['kill-session', '-t', name], {
        stdio: 'ignore',
        env: isolatedTmuxEnvironment(),
      });
      cleaned.push(name);
    } catch {}
  }
  return cleaned;
}

let stdout = '';
let stderr = '';
let timedOut = false;
let spawnError = null;
let forceKillTimer = null;

const child = spawn(process.execPath, ['scripts/browser-regressions.js'], {
  cwd: projectRoot,
  detached: true,
  env: isolatedTmuxEnvironment({
    WARPISH_BROWSER_RUNTIME_ROOT: runtimeRoot,
    WARPISH_SESSION_PREFIX: sessionPrefix,
    WARPISH_BROWSER_ONLY: process.env.WARPISH_BROWSER_ONLY || '',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

function signalProcessGroup(signal) {
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {}
  try { child.kill(signal); } catch {}
}

const childResult = await new Promise((resolve) => {
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    resolve(result);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    signalProcessGroup('SIGTERM');
    forceKillTimer = setTimeout(() => signalProcessGroup('SIGKILL'), 3000);
  }, timeoutMs);
  child.on('error', (error) => {
    spawnError = error;
    finish({ code: null, signal: null });
  });
  child.on('close', (code, signal) => finish({ code, signal }));
});

if (timedOut) signalProcessGroup('SIGKILL');
cleanupTmuxSessions();
try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}

if (spawnError) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  throw spawnError;
}
if (timedOut) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  throw new Error(`UI stability suite timed out after ${timeoutMs}ms; its process group and isolated tmux sessions were cleaned up`);
}
if (childResult.code !== 0) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exit(childResult.code ?? 1);
}

let payload;
try {
  payload = JSON.parse(stdout);
} catch (error) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  throw new Error(`UI stability agent could not parse browser regression JSON: ${error.message}`);
}

assert(payload.ok === true, 'browser regression did not report success', payload);
const diagnostics = payload.diagnostics || { consoleErrors: [], runtimeExceptions: [] };
assert(diagnostics.consoleErrors?.length === 0, 'browser regression emitted console errors', diagnostics);
assert(diagnostics.runtimeExceptions?.length === 0, 'browser regression emitted unhandled runtime exceptions', diagnostics);

const regressions = payload.regressions || {};
const quick = regressions.quickCreateDefaults;
const minimal = regressions.minimalUi;
assert(quick, 'quick-create regression is missing', Object.keys(regressions));
assert(minimal, 'minimal-UI regression is missing', Object.keys(regressions));
assert(/^Terminal \d+$/u.test(quick.automaticTitle), 'quick create did not use an automatic title', quick);
assert(quick.cwd === os.homedir(), 'quick create did not start in Home', quick);
assert(quick.profile === 'default' && quick.private === false, 'quick create did not use default/normal settings', quick);
assert(quick.doubleClickCreatedCount === 1 && quick.postCount === 1, 'double-click created duplicate sessions or requests', quick);
assert(JSON.stringify(quick.postBody) === '{}' && quick.regularButtonOpenedDialog === false, 'quick create did not POST {} without a dialog', quick);
assert(minimal.rawXterm === true && minimal.removedSelectorsPresent.length === 0, 'removed UI is present or raw xterm is missing', minimal);
assert(minimal.remainingDialogs.length === 1 && minimal.remainingDialogs[0] === 'pasteDialog', 'a removed creation/options dialog remains', minimal);

if (!process.env.WARPISH_BROWSER_ONLY) {
  const required = [
    'rawXtermResume',
    'largeOrderedUtf8',
    'nativeFocusReports',
    'runtimeEpochInputSafety',
    'staleOutputIsolation',
    'minimalApiSurface',
    'pasteAndStoppedHistory',
    'mobileLayoutAndKeys',
  ];
  for (const name of required) {
    assert(regressions[name], `full UI stability suite is missing ${name}`, Object.keys(regressions));
  }
}

if (regressions.rawXtermResume) {
  const check = regressions.rawXtermResume;
  assert(check.rawInputReachedPty && check.reloadResumed && check.websocketReconnected && check.tmuxSnapshotPreserved, 'raw xterm resume/reconnect failed', check);
}
if (regressions.largeOrderedUtf8) {
  const check = regressions.largeOrderedUtf8;
  assert(check.byteLength > 64 * 1024 && check.exceedsSingleMessageLimit && check.orderedExactMatch && check.browserQueueDrained, 'large ordered UTF-8 input failed', check);
}
if (regressions.nativeFocusReports) {
  const check = regressions.nativeFocusReports;
  assert(check.focusTrackingEnabled
    && check.reportsHex === check.expectedHex
    && check.protocolMetadataPreserved
    && check.controllerFocusResynced
    && check.acknowledged, 'native xterm focus reporting or input acknowledgement failed', check);
}
if (regressions.runtimeEpochInputSafety) {
  const check = regressions.runtimeEpochInputSafety;
  assert(check.runtimeEpochChanged && check.uncertainInputNotRetried && check.executionCount === 1, 'runtime-epoch input replay safety failed', check);
}
if (regressions.staleOutputIsolation) {
  const check = regressions.staleOutputIsolation;
  assert(check.staleDeviceResponsesSent === 0 && check.targetQueueClean, 'stale xterm output crossed into the selected session', check);
}
if (regressions.minimalApiSurface) {
  const check = regressions.minimalApiSurface;
  assert(check.customCreateIgnored === true, 'removed custom-create fields are still honored', check);
  assert(Object.values(check.removedRouteStatuses).every((status) => status === 404), 'a removed feature API is still reachable', check);
}
if (regressions.pasteAndStoppedHistory) {
  const check = regressions.pasteAndStoppedHistory;
  assert(check.pasteBoundToSource && check.crossSessionPasteCancelled, 'multiline paste crossed sessions', check);
  assert(check.stoppedRole === 'history' && check.stoppedSocket === null && check.stoppedPendingInputs === 0 && check.stoppedPasteDialogOpen === false && check.createdFromStoppedHistory, 'stopped history accepted input or blocked one-click creation', check);
}
if (regressions.mobileLayoutAndKeys) {
  const check = regressions.mobileLayoutAndKeys;
  assert(check.horizontalOverflow === false && check.keyCount === 8 && check.visualViewportAware, 'mobile layout overflowed, ignored visual viewport, or lost keys', check);
  assert(check.escapeReceivedHex === '1b', 'mobile Escape did not send the terminal byte', check);
  assert(check.compactPortrait?.terminalHeight > 100
    && check.compactPortrait?.footerDisplay === 'none', 'short mobile keyboard viewport collapsed', check);
}

console.log(JSON.stringify({
  ok: true,
  agent: 'warpish-ui-stability-agent',
  targeted: process.env.WARPISH_BROWSER_ONLY || null,
  durationMs: Date.now() - startedAt,
  browser: payload.browser,
  checks: regressions,
}, null, 2));
