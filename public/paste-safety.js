(function registerWarpishPasteSafety(root) {
  function prepareTerminalPasteText(rawText, {
    bracketedPasteMode = false,
    multilineMode = 'single-line',
  } = {}) {
    const normalized = String(rawText || '')
      .replace(/\r\n?|\u2028|\u2029/gu, '\n');
    const withoutTerminalControls = normalized.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, '');
    const withoutImplicitSubmit = withoutTerminalControls.replace(/(?:\n[ \t]*)+$/u, '');
    const internalLineBreaks = withoutImplicitSubmit.match(/\n/gu)?.length || 0;
    const preserveLines = bracketedPasteMode || multilineMode === 'preserve';
    return {
      text: multilineMode === 'cancel'
        ? ''
        : preserveLines
        ? withoutImplicitSubmit
        : withoutImplicitSubmit.replace(/\n/gu, ' ').replace(/\t/gu, '    '),
      internalLineBreaks,
      requiresChoice: internalLineBreaks > 0 && !bracketedPasteMode,
      multilineMode: preserveLines ? 'preserve' : multilineMode === 'cancel' ? 'cancel' : 'single-line',
      removedTrailingLineBreak: withoutImplicitSubmit !== withoutTerminalControls,
      removedControlCharacters: withoutTerminalControls !== normalized,
    };
  }

  function formatMultilinePastePreview(rawText, maxChars = 2400) {
    const normalized = String(rawText || '').replace(/\r\n?|\u2028|\u2029/gu, '\n');
    const visible = normalized.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, '�');
    const characterCount = Array.from(visible).length;
    const lineCount = visible ? (visible.match(/\n/gu)?.length || 0) + 1 : 0;
    const limit = Math.max(200, Number(maxChars) || 2400);
    const heading = `${lineCount.toLocaleString()} lines • ${characterCount.toLocaleString()} characters`;
    if (visible.length <= limit) return `${heading}\n\n${visible}`;
    const headLength = Math.floor(limit / 2);
    const tailLength = limit - headLength;
    const omitted = Math.max(0, visible.length - headLength - tailLength);
    return `${heading} • PREVIEW TRUNCATED\n\n${visible.slice(0, headLength)}\n\n… ${omitted.toLocaleString()} characters omitted; showing the end below …\n\n${visible.slice(-tailLength)}`;
  }

  root.WarpishPasteSafety = Object.freeze({ prepareTerminalPasteText, formatMultilinePastePreview });
}(globalThis));
