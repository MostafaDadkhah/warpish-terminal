import '../public/terminal-key-data.js';

const keys = globalThis.WarpishTerminalKeys;
const ESC = '\x1b';

function assertEqual(actual, expected, message) {
  if (actual === expected) return;
  throw new Error(`${message}\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`);
}

function key(keyName, modifiers = {}) {
  return { key: keyName, ...modifiers };
}

assertEqual(typeof keys?.terminalKeyData, 'function', 'terminal key mapper was not registered');

assertEqual(keys.terminalKeyData(key('ArrowUp')), `${ESC}[A`, 'normal cursor mode ArrowUp is wrong');
assertEqual(
  keys.terminalKeyData(key('ArrowUp'), { applicationCursorKeysMode: true }),
  `${ESC}OA`,
  'application cursor mode ArrowUp is wrong',
);
assertEqual(
  keys.terminalKeyData(key('Home'), { applicationCursorKeys: true }),
  `${ESC}OH`,
  'application cursor mode Home is wrong',
);
assertEqual(
  keys.terminalKeyData(key('End'), true),
  `${ESC}OF`,
  'boolean application cursor mode End is wrong',
);

assertEqual(keys.modifierParameter(key('x', { shiftKey: true })), 2, 'Shift modifier parameter is wrong');
assertEqual(keys.modifierParameter(key('x', { altKey: true })), 3, 'Alt modifier parameter is wrong');
assertEqual(keys.modifierParameter(key('x', { ctrlKey: true })), 5, 'Ctrl modifier parameter is wrong');
assertEqual(
  keys.modifierParameter(key('x', { shiftKey: true, altKey: true, ctrlKey: true })),
  8,
  'combined modifier parameter is wrong',
);
assertEqual(
  keys.terminalKeyData(key('ArrowLeft', { shiftKey: true })),
  `${ESC}[1;2D`,
  'modified ArrowLeft is wrong',
);
assertEqual(
  keys.terminalKeyData(key('ArrowRight', { altKey: true }), { applicationCursorKeysMode: true }),
  `${ESC}[1;3C`,
  'modified cursor key must use CSI even in application mode',
);
assertEqual(
  keys.terminalKeyData(key('Home', { shiftKey: true, altKey: true, ctrlKey: true })),
  `${ESC}[1;8H`,
  'combined modifier Home is wrong',
);

assertEqual(keys.terminalKeyData(key('Tab', { shiftKey: true })), `${ESC}[Z`, 'Shift+Tab is wrong');
assertEqual(keys.terminalKeyData(key('Insert')), `${ESC}[2~`, 'Insert is wrong');
assertEqual(
  keys.terminalKeyData(key('Insert', { ctrlKey: true })),
  `${ESC}[2;5~`,
  'Ctrl+Insert is wrong',
);
assertEqual(
  keys.terminalKeyData(key('Delete', { altKey: true })),
  `${ESC}[3;3~`,
  'Alt+Delete is wrong',
);

const functionKeySequences = [
  `${ESC}OP`, `${ESC}OQ`, `${ESC}OR`, `${ESC}OS`,
  `${ESC}[15~`, `${ESC}[17~`, `${ESC}[18~`, `${ESC}[19~`,
  `${ESC}[20~`, `${ESC}[21~`, `${ESC}[23~`, `${ESC}[24~`,
];
for (let index = 0; index < functionKeySequences.length; index += 1) {
  assertEqual(
    keys.terminalKeyData(key(`F${index + 1}`)),
    functionKeySequences[index],
    `F${index + 1} is wrong`,
  );
}
assertEqual(
  keys.terminalKeyData(key('F1', { ctrlKey: true })),
  `${ESC}[1;5P`,
  'Ctrl+F1 is wrong',
);
assertEqual(
  keys.terminalKeyData(key('F12', { shiftKey: true, altKey: true })),
  `${ESC}[24;4~`,
  'Shift+Alt+F12 is wrong',
);

assertEqual(keys.terminalKeyData(key('x', { altKey: true })), `${ESC}x`, 'Alt+printable is wrong');
assertEqual(keys.terminalKeyData(key('X', { altKey: true, shiftKey: true })), `${ESC}X`, 'Alt+Shift printable is wrong');
assertEqual(keys.terminalKeyData(key('ش', { altKey: true })), `${ESC}ش`, 'Alt+Unicode printable is wrong');

assertEqual(keys.terminalKeyData(key('a', { ctrlKey: true })), '\x01', 'Ctrl+A is wrong');
assertEqual(keys.terminalKeyData(key('z', { ctrlKey: true })), '\x1a', 'Ctrl+Z is wrong');
assertEqual(keys.terminalKeyData(key(' ', { ctrlKey: true })), '\x00', 'Ctrl+Space is wrong');
assertEqual(keys.terminalKeyData(key('[', { ctrlKey: true })), ESC, 'Ctrl+[ is wrong');
assertEqual(keys.terminalKeyData(key('\\', { ctrlKey: true })), '\x1c', 'Ctrl+Backslash is wrong');
assertEqual(keys.terminalKeyData(key(']', { ctrlKey: true })), '\x1d', 'Ctrl+] is wrong');
assertEqual(keys.terminalKeyData(key('^', { ctrlKey: true })), '\x1e', 'Ctrl+^ is wrong');
assertEqual(keys.terminalKeyData(key('_', { ctrlKey: true })), '\x1f', 'Ctrl+_ is wrong');
assertEqual(keys.terminalKeyData(key('?', { ctrlKey: true })), '\x7f', 'Ctrl+? is wrong');
assertEqual(keys.terminalKeyData(key('a', { ctrlKey: true, altKey: true })), `${ESC}\x01`, 'Ctrl+Alt+A is wrong');

assertEqual(keys.terminalKeyData(key('x', { metaKey: true })), null, 'Meta shortcut should stay with the browser');
assertEqual(keys.terminalKeyData(key('x', { isComposing: true })), null, 'IME composition should not be encoded');
assertEqual(keys.terminalKeyData(key('Dead', { altKey: true })), null, 'dead key should not be encoded as printable');

console.log('terminal-key-data: application cursor, modifiers, special keys, Alt, and Ctrl passed');
