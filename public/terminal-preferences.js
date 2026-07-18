(function registerWarpishTerminalPreferences(root) {
  const STORAGE_KEY = 'warpish_terminal_preferences_v1';
  const THEMES = Object.freeze({
    midnight: Object.freeze({
      background: '#070711', foreground: '#f4f1ff', cursor: '#22d3ee', selectionBackground: '#5b4a9f66',
      black: '#11111b', red: '#fb7185', green: '#34d399', yellow: '#fbbf24',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#f3f4f6',
      brightBlack: '#6b7280', brightRed: '#fda4af', brightGreen: '#86efac', brightYellow: '#fde68a',
      brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
    }),
    graphite: Object.freeze({
      background: '#101214', foreground: '#e6e6e6', cursor: '#f6c177', selectionBackground: '#6172b055',
      black: '#17191c', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
      brightBlack: '#7f848e', brightRed: '#ff7a85', brightGreen: '#b3d98c', brightYellow: '#f4d58d',
      brightBlue: '#7fc3ff', brightMagenta: '#dc8cf0', brightCyan: '#72d2dc', brightWhite: '#ffffff',
    }),
    light: Object.freeze({
      background: '#fbfbfd', foreground: '#202124', cursor: '#0067c0', selectionBackground: '#8ab4f866',
      black: '#202124', red: '#b3261e', green: '#0b8043', yellow: '#8d6500',
      blue: '#0057b8', magenta: '#7b1fa2', cyan: '#007c91', white: '#eef0f4',
      brightBlack: '#5f6368', brightRed: '#d93025', brightGreen: '#188038', brightYellow: '#b06000',
      brightBlue: '#1a73e8', brightMagenta: '#a142f4', brightCyan: '#0097a7', brightWhite: '#ffffff',
    }),
  });

  const DEFAULTS = Object.freeze({
    fontSize: 13.5,
    lineHeight: 1.16,
    scrollback: 50000,
    theme: 'midnight',
    cursorBlink: true,
    screenReaderMode: false,
    notifications: false,
    defaultCwd: '',
    defaultProfile: 'default',
    privateByDefault: false,
  });

  function finiteNumber(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
  }

  function normalize(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const theme = Object.hasOwn(THEMES, source.theme) ? source.theme : DEFAULTS.theme;
    const requestedProfile = String(source.defaultProfile || DEFAULTS.defaultProfile).trim().slice(0, 40);
    const defaultProfile = /^[a-z0-9][a-z0-9._-]{0,39}$/u.test(requestedProfile) ? requestedProfile : DEFAULTS.defaultProfile;
    return {
      fontSize: finiteNumber(source.fontSize, DEFAULTS.fontSize, 10, 24),
      lineHeight: finiteNumber(source.lineHeight, DEFAULTS.lineHeight, 1, 2),
      scrollback: Math.round(finiteNumber(source.scrollback, DEFAULTS.scrollback, 1000, 200000)),
      theme,
      cursorBlink: source.cursorBlink === undefined ? DEFAULTS.cursorBlink : Boolean(source.cursorBlink),
      screenReaderMode: Boolean(source.screenReaderMode),
      notifications: Boolean(source.notifications),
      defaultCwd: String(source.defaultCwd || '').trim().slice(0, 1024),
      defaultProfile,
      privateByDefault: Boolean(source.privateByDefault),
    };
  }

  function load(storage = root.localStorage) {
    try {
      return normalize(JSON.parse(storage?.getItem?.(STORAGE_KEY) || '{}'));
    } catch {
      return normalize();
    }
  }

  function save(value, storage = root.localStorage) {
    const normalized = normalize(value);
    storage?.setItem?.(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  root.WarpishTerminalPreferences = Object.freeze({
    STORAGE_KEY,
    DEFAULTS,
    THEMES,
    normalize,
    load,
    save,
  });
}(globalThis));
