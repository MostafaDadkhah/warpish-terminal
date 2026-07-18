(function registerWarpishPasteSafety(root) {
  function prepareTerminalPasteText(rawText, { bracketedPasteMode = false } = {}) {
    const normalized = String(rawText || '')
      .replace(/\r\n?|\u2028|\u2029/gu, '\n');
    const withoutTerminalControls = normalized.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, '');
    const withoutImplicitSubmit = withoutTerminalControls.replace(/(?:\n[ \t]*)+$/u, '');
    const internalLineBreaks = withoutImplicitSubmit.match(/\n/gu)?.length || 0;
    return {
      text: bracketedPasteMode
        ? withoutImplicitSubmit
        : withoutImplicitSubmit.replace(/\n/gu, ' ').replace(/\t/gu, '    '),
      internalLineBreaks,
      removedTrailingLineBreak: withoutImplicitSubmit !== withoutTerminalControls,
      removedControlCharacters: withoutTerminalControls !== normalized,
    };
  }

  root.WarpishPasteSafety = Object.freeze({ prepareTerminalPasteText });
}(globalThis));
