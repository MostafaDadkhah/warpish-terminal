(function registerWarpishTerminalKeys(root) {
  const ESC = '\x1b';

  const CURSOR_KEYS = Object.freeze({
    ArrowUp: 'A',
    ArrowDown: 'B',
    ArrowRight: 'C',
    ArrowLeft: 'D',
    Home: 'H',
    End: 'F',
  });

  const TILDE_KEYS = Object.freeze({
    Insert: 2,
    Delete: 3,
    PageUp: 5,
    PageDown: 6,
  });

  const FUNCTION_KEYS = Object.freeze({
    F1: { final: 'P' },
    F2: { final: 'Q' },
    F3: { final: 'R' },
    F4: { final: 'S' },
    F5: { code: 15 },
    F6: { code: 17 },
    F7: { code: 18 },
    F8: { code: 19 },
    F9: { code: 20 },
    F10: { code: 21 },
    F11: { code: 23 },
    F12: { code: 24 },
  });

  function modifierParameter(event = {}) {
    return 1
      + (event.shiftKey ? 1 : 0)
      + (event.altKey ? 2 : 0)
      + (event.ctrlKey ? 4 : 0);
  }

  function ctrlKeyData(key = '') {
    const value = String(key || '');
    const upper = value.toUpperCase();
    if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
      return String.fromCharCode(upper.charCodeAt(0) - 64);
    }

    const controlKeys = {
      ' ': '\x00',
      '2': '\x00',
      '@': '\x00',
      '3': ESC,
      '[': ESC,
      '4': '\x1c',
      '\\': '\x1c',
      '5': '\x1d',
      ']': '\x1d',
      '6': '\x1e',
      '^': '\x1e',
      '7': '\x1f',
      '/': '\x1f',
      '_': '\x1f',
      '8': '\x7f',
      '?': '\x7f',
    };
    return controlKeys[value] ?? null;
  }

  function applicationCursorMode(modes = {}) {
    if (typeof modes === 'boolean') return modes;
    return Boolean(
      modes.applicationCursorKeysMode
      ?? modes.applicationCursorKeys
      ?? modes.applicationCursorMode,
    );
  }

  function modifiedCsi(prefix, final, modifiers) {
    return `${ESC}[${prefix};${modifiers}${final}`;
  }

  function printableKey(key) {
    return key && Array.from(key).length === 1;
  }

  function terminalKeyData(event = {}, modes = {}) {
    if (event.isComposing || event.metaKey) return null;

    const key = String(event.key || '');
    const modifiers = modifierParameter(event);
    const hasModifiers = modifiers > 1;

    if (CURSOR_KEYS[key]) {
      const final = CURSOR_KEYS[key];
      if (hasModifiers) return modifiedCsi(1, final, modifiers);
      return `${ESC}${applicationCursorMode(modes) ? 'O' : '['}${final}`;
    }

    if (TILDE_KEYS[key]) {
      const code = TILDE_KEYS[key];
      return hasModifiers ? modifiedCsi(code, '~', modifiers) : `${ESC}[${code}~`;
    }

    const functionKey = FUNCTION_KEYS[key];
    if (functionKey) {
      if (functionKey.final) {
        return hasModifiers
          ? modifiedCsi(1, functionKey.final, modifiers)
          : `${ESC}O${functionKey.final}`;
      }
      return hasModifiers
        ? modifiedCsi(functionKey.code, '~', modifiers)
        : `${ESC}[${functionKey.code}~`;
    }

    if (key === 'Tab') return event.shiftKey ? `${ESC}[Z` : '\t';
    if (key === 'Enter') return event.altKey ? `${ESC}\r` : '\r';
    if (key === 'Escape') return event.altKey ? `${ESC}${ESC}` : ESC;
    if (key === 'Backspace') {
      const data = event.ctrlKey ? '\b' : '\x7f';
      return event.altKey ? `${ESC}${data}` : data;
    }

    if (event.ctrlKey) {
      const data = ctrlKeyData(key);
      return data == null ? null : `${event.altKey ? ESC : ''}${data}`;
    }

    if (!printableKey(key)) return null;
    return event.altKey ? `${ESC}${key}` : key;
  }

  root.WarpishTerminalKeys = Object.freeze({
    modifierParameter,
    ctrlKeyData,
    terminalKeyData,
  });
}(globalThis));
