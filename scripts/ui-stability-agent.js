import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const projectRoot = new URL('..', import.meta.url).pathname;
const startedAt = Date.now();
const timeoutMs = Number(process.env.WARPISH_UI_TIMEOUT_MS || 600_000);
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warpish-ui-agent-'));
const sessionPrefix = `warpishui-${process.pid.toString(36)}-${Date.now().toString(36)}-`;
const tmuxBin = process.env.TMUX_BIN
  || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((candidate) => fs.existsSync(candidate))
  || 'tmux';

let stdout = '';
let stderr = '';
let timedOut = false;
let spawnError = null;
let killTimer = null;

const child = spawn(process.execPath, ['scripts/browser-regressions.js'], {
  cwd: projectRoot,
  detached: true,
  env: {
    ...process.env,
    WARPISH_BROWSER_RUNTIME_ROOT: runtimeRoot,
    WARPISH_SESSION_PREFIX: sessionPrefix,
  },
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

function cleanupTmuxSessions(prefix) {
  let output = '';
  try {
    output = execFileSync(tmuxBin, ['list-sessions', '-F', '#S'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const cleaned = [];
  for (const name of output.split('\n').filter((value) => value.startsWith(prefix))) {
    try {
      execFileSync(tmuxBin, ['kill-session', '-t', name], { stdio: 'ignore' });
      cleaned.push(name);
    } catch {}
  }
  return cleaned;
}

const childResult = await new Promise((resolve) => {
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    resolve(result);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    signalProcessGroup('SIGTERM');
    killTimer = setTimeout(() => signalProcessGroup('SIGKILL'), 3000);
  }, timeoutMs);
  child.on('error', (error) => {
    spawnError = error;
    finish({ code: null, signal: null });
  });
  child.on('close', (code, signal) => finish({ code, signal }));
});

if (timedOut) signalProcessGroup('SIGKILL');
cleanupTmuxSessions(sessionPrefix);
try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}

if (spawnError) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  throw spawnError;
}

if (timedOut) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  throw new Error(`UI stability browser suite timed out after ${timeoutMs}ms; process group and ${sessionPrefix}* tmux sessions were cleaned up`);
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

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

const regressions = payload.regressions || {};
const requiredChecks = [
  'longHermesScrollback',
  'richHistoryTypingStability',
  'terminal56ScrollTyping',
  'sessionSwitchingStability',
  'typingNoFlicker',
  'mouseModeAndMobileLayout',
];
for (const check of requiredChecks) {
  assert(regressions[check], `UI stability agent required check is missing: ${check}`, Object.keys(regressions));
}

const rich = regressions.richHistoryTypingStability;
assert(rich.minLineCount >= rich.before.lineCount - 20, 'rich history collapsed during typing', rich);
assert(rich.minMaxScrollTop >= rich.before.maxScrollTop - 600, 'rich history scroll range collapsed during typing', rich);
assert(regressions.terminal56ScrollTyping.afterType.nearBottom === false, 'terminal56 history typing snapped reader to bottom', regressions.terminal56ScrollTyping);
assert(regressions.sessionSwitchingStability.focusLeakClean === true, 'session switching leaked terminal focus reports as input', regressions.sessionSwitchingStability);
assert(regressions.sessionSwitchingStability.settled.windowScrollY === 0, 'session switching/fast wheel scrolled the page instead of terminal', regressions.sessionSwitchingStability);
assert(regressions.sessionSwitchingStability.settled.nearBottom === false, 'fast wheel snapped terminal reader back to bottom', regressions.sessionSwitchingStability);
assert(regressions.typingNoFlicker.firstWithMarker >= 0, 'typed marker never appeared in readable terminal samples', regressions.typingNoFlicker);
assert(
  regressions.typingNoFlicker.markerSampleCount >= regressions.typingNoFlicker.sampleCount - regressions.typingNoFlicker.firstWithMarker,
  'typing marker flickered out after it appeared in readable terminal samples',
  regressions.typingNoFlicker,
);

console.log(JSON.stringify({
  ok: true,
  agent: 'warpish-ui-stability-agent',
  durationMs: Date.now() - startedAt,
  browser: payload.browser,
  checks: {
    richHistoryTypingStability: rich,
    terminal56ScrollTyping: regressions.terminal56ScrollTyping,
    sessionSwitchingStability: regressions.sessionSwitchingStability,
    typingNoFlicker: regressions.typingNoFlicker,
    longHermesScrollback: regressions.longHermesScrollback,
    mouseModeAndMobileLayout: regressions.mouseModeAndMobileLayout,
  },
}, null, 2));
