import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const startedAt = Date.now();
const timeoutMs = Number(process.env.WARPISH_UI_TIMEOUT_MS || 600_000);
const runtimeRoot = fs.mkdtempSync(path.join('/tmp', 'warpish-ui-agent-'));
const sessionPrefix = `warpishui-${process.pid.toString(36)}-${Date.now().toString(36)}-`;
const tmuxBin = process.env.TMUX_BIN
  || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((candidate) => fs.existsSync(candidate))
  || 'tmux';

function isolatedTmuxEnvironment(tmuxTmpDir, extra = {}) {
  const env = { ...process.env, ...extra, TMUX_TMPDIR: tmuxTmpDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

let stdout = '';
let stderr = '';
let timedOut = false;
let spawnError = null;
let killTimer = null;

const child = spawn(process.execPath, ['scripts/browser-regressions.js'], {
  cwd: projectRoot,
  detached: true,
  env: isolatedTmuxEnvironment(path.join(runtimeRoot, 'tmux'), {
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

function cleanupTmuxSessions(prefix, tmuxTmpDir = '') {
  const env = isolatedTmuxEnvironment(tmuxTmpDir || path.join(runtimeRoot, 'tmux'));
  let output = '';
  try {
    output = execFileSync(tmuxBin, ['list-sessions', '-F', '#S'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
  } catch {
    return [];
  }
  const cleaned = [];
  for (const name of output.split('\n').filter((value) => value.startsWith(prefix))) {
    try {
      execFileSync(tmuxBin, ['kill-session', '-t', name], { stdio: 'ignore', env });
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
cleanupTmuxSessions(sessionPrefix, path.join(runtimeRoot, 'tmux'));
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
const browserDiagnostics = payload.diagnostics || { consoleErrors: [], runtimeExceptions: [] };
assert(browserDiagnostics.consoleErrors?.length === 0, 'browser regression suite emitted console errors', browserDiagnostics);
assert(browserDiagnostics.runtimeExceptions?.length === 0, 'browser regression suite emitted unhandled runtime exceptions', browserDiagnostics);
const requestedBrowserCase = process.env.WARPISH_BROWSER_ONLY || '';

if (requestedBrowserCase) {
  assert(Object.keys(regressions).length > 0, `targeted browser regression returned no checks: ${requestedBrowserCase}`, payload);
  console.log(JSON.stringify({
    ok: true,
    agent: 'warpish-ui-stability-agent',
    targeted: requestedBrowserCase,
    durationMs: Date.now() - startedAt,
    browser: payload.browser,
    checks: regressions,
  }, null, 2));
} else {
const requiredChecks = [
  'hermesPaletteStyles',
  'capturedHistoryReducer',
  'hermesReadableHistoryStability',
  'longHermesScrollback',
  'richHistoryTypingStability',
  'terminal56ScrollTyping',
  'sessionSwitchingStability',
  'alternateRuntimeSnapshot',
  'controllerSpectatorLease',
  'readableClipboardShortcuts',
  'readerSelectionStability',
  'shortHistoryTypingFlicker',
  'typingNoFlicker',
  'mouseModeAndMobileLayout',
];
for (const check of requiredChecks) {
  assert(regressions[check], `UI stability agent required check is missing: ${check}`, Object.keys(regressions));
}

const rich = regressions.richHistoryTypingStability;
const shortHistory = regressions.shortHistoryTypingFlicker;
assert(regressions.hermesPaletteStyles.stableSamples >= 4, 'Hermes ANSI colors were not stable across capture refreshes', regressions.hermesPaletteStyles);
assert(regressions.hermesReadableHistoryStability.lineSpread <= 2, 'Hermes readable history line count oscillated', regressions.hermesReadableHistoryStability);
assert(regressions.hermesReadableHistoryStability.scrollHeightSpread <= 60, 'Hermes readable history scroll range oscillated', regressions.hermesReadableHistoryStability);
assert(regressions.hermesReadableHistoryStability.captureRefreshes >= 2, 'Hermes stability fixture did not exercise repeated tmux capture refreshes', regressions.hermesReadableHistoryStability);
assert(regressions.capturedHistoryReducer.confirmedEmpty.count === 0, 'confirmed clear-history did not clear canonical reader state', regressions.capturedHistoryReducer);
assert(rich.minLineCount >= rich.before.lineCount - 20, 'rich history collapsed during typing', rich);
assert(rich.minMaxScrollTop >= rich.before.maxScrollTop - 600, 'rich history scroll range collapsed during typing', rich);
assert(regressions.terminal56ScrollTyping.afterType.nearBottom === false, 'terminal56 history typing snapped reader to bottom', regressions.terminal56ScrollTyping);
assert(regressions.sessionSwitchingStability.focusLeakClean === true, 'session switching leaked terminal focus reports as input', regressions.sessionSwitchingStability);
assert(regressions.sessionSwitchingStability.settled.windowScrollY === 0, 'session switching/fast wheel scrolled the page instead of terminal', regressions.sessionSwitchingStability);
assert(regressions.sessionSwitchingStability.settled.nearBottom === false, 'fast wheel snapped terminal reader back to bottom', regressions.sessionSwitchingStability);
assert(regressions.alternateRuntimeSnapshot.relativeRow === 2, 'relative update landed on the wrong row after runtime snapshot', regressions.alternateRuntimeSnapshot);
assert(regressions.alternateRuntimeSnapshot.bottomPreserved === true && regressions.alternateRuntimeSnapshot.primaryRestored === true, 'runtime snapshot lost the active sentinel or restored primary screen', regressions.alternateRuntimeSnapshot);
assert(regressions.alternateRuntimeSnapshot.relativeLeakedToPrimary === false, 'alternate relative update leaked into the restored primary screen', regressions.alternateRuntimeSnapshot);
assert(regressions.readableClipboardShortcuts.receivedHex === '', 'readable Ctrl+Shift+C/V shortcuts sent terminal input', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.surfaces === 3, 'safe paste regression did not cover reader, xterm helper, and raw-mode surfaces', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.submittedBeforeEnter === 0, 'multiline paste submitted before explicit Enter', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.submittedAfterEnter === 1, 'explicit Enter did not submit exactly once after safe paste', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.persianSpacingPreserved === true, 'safe paste changed Persian Unicode or spacing', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.renderedOccurrences === 1, 'safe Persian paste was duplicated in the readable DOM', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.stableRenderedSamples >= 3, 'safe Persian paste was not rechecked after capture reconciliation', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.reconnectModeDesyncCovered === true, 'safe paste regression did not cover a reconnect with lost bracketed-paste mode', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.bracketedInternalLinesPreserved === true, 'bracketed paste lost its safe internal line structure', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.bracketTerminatorNeutralized === true, 'clipboard content escaped bracketed paste before explicit Enter', regressions.readableClipboardShortcuts);
assert(regressions.readableClipboardShortcuts.safePaste?.semanticDraftsVerified === true, 'safe paste did not preserve one isolated semantic draft per input surface', regressions.readableClipboardShortcuts);
assert(regressions.readerSelectionStability.selectionPreservedDuringUpdate === true, 'reader selection collapsed during live output', regressions.readerSelectionStability);
assert(regressions.readerSelectionStability.copiedContainedCursor === false, 'reader copy text included its visual cursor glyph', regressions.readerSelectionStability);
assert(regressions.readerSelectionStability.liveVisibleAfterClear === true, 'reader did not catch up after selection cleared', regressions.readerSelectionStability);
assert(regressions.controllerSpectatorLease.spectatorIgnoredBeforeTakeControl === true, 'spectator affected PTY before take-control', regressions.controllerSpectatorLease);
assert(regressions.controllerSpectatorLease.previousControllerIgnoredAfterTransfer === true, 'previous controller affected PTY after lease transfer', regressions.controllerSpectatorLease);
assert(regressions.controllerSpectatorLease.finalRoles.clientA === 'spectator' && regressions.controllerSpectatorLease.finalRoles.clientB === 'controller', 'controller/spectator roles did not transfer', regressions.controllerSpectatorLease);
assert(
  shortHistory.typedSamples.concat(shortHistory.restoredSamples).every((sample) => sample.lineCount > 1),
  'short terminal history collapsed to a one-line reader while typing or deleting',
  shortHistory,
);
assert(shortHistory.typedSamples.at(-1)?.tail.endsWith(shortHistory.typedKey), 'short-history prompt tail did not retain the typed character', shortHistory);
assert(shortHistory.restoredSamples.at(-1)?.tail === shortHistory.baseline.tail, 'short-history prompt tail was not restored after Backspace', shortHistory);
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
    hermesPaletteStyles: regressions.hermesPaletteStyles,
    capturedHistoryReducer: regressions.capturedHistoryReducer,
    hermesReadableHistoryStability: regressions.hermesReadableHistoryStability,
    richHistoryTypingStability: rich,
    terminal56ScrollTyping: regressions.terminal56ScrollTyping,
    sessionSwitchingStability: regressions.sessionSwitchingStability,
    alternateRuntimeSnapshot: regressions.alternateRuntimeSnapshot,
    controllerSpectatorLease: regressions.controllerSpectatorLease,
    readableClipboardShortcuts: regressions.readableClipboardShortcuts,
    readerSelectionStability: regressions.readerSelectionStability,
    shortHistoryTypingFlicker: shortHistory,
    typingNoFlicker: regressions.typingNoFlicker,
    longHermesScrollback: regressions.longHermesScrollback,
    mouseModeAndMobileLayout: regressions.mouseModeAndMobileLayout,
  },
}, null, 2));
}
