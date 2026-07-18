import '../public/terminal-preferences.js';

const preferences = globalThis.WarpishTerminalPreferences;

function assert(condition, message, details = undefined) {
  if (condition) return;
  throw new Error(`${message}${details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`}`);
}

assert(preferences?.DEFAULTS?.fontSize === 13.5, 'terminal preference defaults were not registered');
const normalized = preferences.normalize({
  fontSize: 99,
  lineHeight: 0,
  scrollback: '250000',
  theme: 'missing',
  cursorBlink: false,
  screenReaderMode: 1,
  defaultCwd: `  /tmp/${'x'.repeat(1100)}  `,
  defaultProfile: '  work  ',
  privateByDefault: true,
});
assert(normalized.fontSize === 24, 'font size was not bounded', normalized);
assert(normalized.lineHeight === 1, 'line height was not bounded', normalized);
assert(normalized.scrollback === 200000, 'scrollback was not bounded', normalized);
assert(normalized.theme === 'midnight', 'unknown theme was not reset', normalized);
assert(normalized.cursorBlink === false && normalized.screenReaderMode === true, 'boolean preferences changed', normalized);
assert(normalized.defaultCwd.startsWith('/tmp/') && normalized.defaultCwd.length === 1024, 'default cwd was not normalized', normalized);
assert(normalized.defaultProfile === 'work' && normalized.privateByDefault, 'profile/privacy preferences changed', normalized);
assert(preferences.normalize({ defaultProfile: 'Work Profile' }).defaultProfile === 'default', 'invalid profile was persisted');
assert(preferences.normalize({ defaultProfile: '-work' }).defaultProfile === 'default', 'profile with an invalid first character was persisted');

const state = new Map();
const storage = {
  getItem(key) { return state.get(key) ?? null; },
  setItem(key, value) { state.set(key, value); },
};
const saved = preferences.save({ theme: 'graphite', fontSize: 15 }, storage);
const loaded = preferences.load(storage);
assert(saved.theme === 'graphite' && loaded.theme === 'graphite', 'theme did not round trip through storage', { saved, loaded });
assert(loaded.fontSize === 15 && loaded.scrollback === preferences.DEFAULTS.scrollback, 'saved preferences lost defaults', loaded);
state.set(preferences.STORAGE_KEY, '{broken json');
assert(preferences.load(storage).theme === preferences.DEFAULTS.theme, 'corrupt preferences did not recover to defaults');

console.log('terminal-preferences: normalization, bounds, themes, and storage passed');
