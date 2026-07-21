(function registerWarpishRtlTerminal(root) {
  const RTL_SCRIPT_CHARACTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
  const SOURCE_HIDDEN_CLASS = 'warpish-rtl-source-hidden';
  const NATIVE_CURSOR_HIDDEN_CLASS = 'warpish-rtl-native-cursor-hidden';
  const JOINED_RUN_CLASS = 'warpish-rtl-joined-run';
  const RECONCILED_CURSOR_CLASS = 'warpish-rtl-cursor';

  function rtlCharacterJoinRanges(text) {
    const value = String(text || '');
    const start = value.search(RTL_SCRIPT_CHARACTER);
    return start < 0 ? [] : [[start, value.length]];
  }

  function activeRtlRun(cells, cursorColumn) {
    const normalized = Array.isArray(cells) ? cells : [];
    let start = -1;
    let end = 0;

    for (let column = 0; column < normalized.length; column += 1) {
      const chars = String(normalized[column]?.chars || '');
      const width = Math.max(1, Number(normalized[column]?.width) || 1);
      if (start < 0 && RTL_SCRIPT_CHARACTER.test(chars)) start = column;
      if (chars) end = Math.max(end, column + width);
    }

    const cursor = Number(cursorColumn);
    if (start < 0 || end <= start || !Number.isFinite(cursor) || cursor < start || cursor > end) return null;

    const text = normalized
      .slice(start, end)
      .filter((cell) => Number(cell?.width) !== 0)
      .map((cell) => String(cell?.chars || ' '))
      .join('')
      .replace(/\s+$/u, (trailing) => (cursor === end ? '' : trailing));

    if (!RTL_SCRIPT_CHARACTER.test(text)) return null;
    return {
      start,
      end,
      cursor,
      text,
      visualCursorColumn: Math.max(0, Math.min(end - start, end - cursor)),
    };
  }

  function lineCells(line, columns) {
    const cells = [];
    for (let column = 0; column < columns; column += 1) {
      const cell = line?.getCell?.(column);
      cells.push({
        chars: cell?.getChars?.() || '',
        width: cell?.getWidth?.() ?? 1,
      });
    }
    return cells;
  }

  function createRenderer(term, terminalElement) {
    if (!term || !terminalElement || !root.document) return null;

    term.registerCharacterJoiner?.(rtlCharacterJoinRanges);
    const screen = terminalElement.querySelector('.xterm-screen');
    if (!screen) return null;

    const layer = root.document.createElement('div');
    layer.className = 'warpish-rtl-layer';
    layer.setAttribute('aria-hidden', 'true');
    screen.append(layer);

    let frame = null;
    let disposed = false;

    function clearDecorations() {
      terminalElement.querySelectorAll(`.${SOURCE_HIDDEN_CLASS}`).forEach((element) => {
        element.classList.remove(SOURCE_HIDDEN_CLASS);
      });
      terminalElement.querySelectorAll(`.${NATIVE_CURSOR_HIDDEN_CLASS}`).forEach((element) => {
        element.classList.remove(NATIVE_CURSOR_HIDDEN_CLASS);
      });
      terminalElement.querySelectorAll(`.${JOINED_RUN_CLASS}`).forEach((element) => {
        element.classList.remove(JOINED_RUN_CLASS);
      });
      terminalElement.querySelectorAll(`.${RECONCILED_CURSOR_CLASS}`).forEach((element) => {
        element.classList.remove(RECONCILED_CURSOR_CLASS);
        element.style.removeProperty('--warpish-rtl-cursor-shift');
      });
      layer.replaceChildren();
    }

    function render() {
      frame = null;
      if (disposed) return;
      clearDecorations();

      const buffer = term.buffer?.active;
      const row = terminalElement.querySelectorAll('.xterm-rows > div')[buffer?.cursorY];
      const cursor = row?.querySelector('.xterm-cursor');
      const line = buffer?.getLine?.((buffer.baseY || 0) + (buffer.cursorY || 0));
      if (!buffer || !row || !cursor || !line) return;

      const run = activeRtlRun(lineCells(line, term.cols || 0), buffer.cursorX);
      if (!run) return;

      const joinedSpan = cursor.previousElementSibling;
      if (run.cursor === run.end
        && joinedSpan?.textContent === run.text
        && RTL_SCRIPT_CHARACTER.test(joinedSpan.textContent || '')) {
        const cursorRect = cursor.getBoundingClientRect();
        const joinedRect = joinedSpan.getBoundingClientRect();
        if (cursorRect.width && joinedRect.width > cursorRect.width) {
          joinedSpan.classList.add(JOINED_RUN_CLASS);
          cursor.style.setProperty('--warpish-rtl-cursor-shift', `-${joinedRect.width}px`);
          cursor.classList.add(RECONCILED_CURSOR_CLASS);
          return;
        }
      }

      const rowRect = row.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const cursorRect = cursor.getBoundingClientRect();
      const cellWidth = cursorRect.width || (screenRect.width / Math.max(1, term.cols || 1));
      if (!rowRect.width || !rowRect.height || !cellWidth) return;

      const runLeft = rowRect.left + (run.start * cellWidth);
      const runRight = rowRect.left + (run.end * cellWidth);
      const sourceSpans = [...row.children].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.right > runLeft + 0.5 && rect.left < runRight - 0.5;
      });
      const colorSource = sourceSpans.find((element) => !element.classList.contains('xterm-cursor')) || sourceSpans[0];
      const sourceStyle = colorSource ? root.getComputedStyle(colorSource) : root.getComputedStyle(row);
      const typography = {
        color: sourceStyle.color,
        fontFamily: sourceStyle.fontFamily,
        fontSize: sourceStyle.fontSize,
        fontStyle: sourceStyle.fontStyle,
        fontWeight: sourceStyle.fontWeight,
        letterSpacing: sourceStyle.letterSpacing,
      };
      sourceSpans.forEach((element) => element.classList.add(SOURCE_HIDDEN_CLASS));
      cursor.classList.add(NATIVE_CURSOR_HIDDEN_CLASS);

      const overlay = root.document.createElement('div');
      overlay.className = 'warpish-rtl-overlay';
      overlay.dataset.logicalText = run.text;
      overlay.dataset.runStart = String(run.start);
      overlay.dataset.runEnd = String(run.end);
      overlay.dataset.cursorColumn = String(run.cursor);
      overlay.dataset.visualCursorColumn = String(run.visualCursorColumn);
      overlay.style.left = `${runLeft - screenRect.left}px`;
      overlay.style.top = `${rowRect.top - screenRect.top}px`;
      overlay.style.width = `${(run.end - run.start) * cellWidth}px`;
      overlay.style.height = `${rowRect.height}px`;
      overlay.style.color = typography.color;
      overlay.style.fontFamily = typography.fontFamily;
      overlay.style.fontSize = typography.fontSize;
      overlay.style.fontStyle = typography.fontStyle;
      overlay.style.fontWeight = typography.fontWeight;
      overlay.style.letterSpacing = typography.letterSpacing;
      overlay.style.lineHeight = `${rowRect.height}px`;

      const text = root.document.createElement('span');
      text.className = 'warpish-rtl-overlay-text';
      text.textContent = run.text;
      overlay.append(text);

      const caret = root.document.createElement('span');
      caret.className = 'warpish-rtl-overlay-caret';
      caret.style.left = `${Math.min(
        Math.max(0, ((run.end - run.start) * cellWidth) - 2),
        Math.max(0, run.visualCursorColumn * cellWidth),
      )}px`;
      caret.style.setProperty('--warpish-rtl-caret-color', term.options?.theme?.cursor || '#22d3ee');
      overlay.append(caret);
      layer.replaceChildren(overlay);
    }

    function schedule() {
      if (disposed || frame !== null) return;
      frame = root.requestAnimationFrame(render);
    }

    const renderDisposable = term.onRender(schedule);
    const resizeDisposable = term.onResize?.(schedule);
    terminalElement.addEventListener('focusin', schedule);
    terminalElement.addEventListener('focusout', schedule);
    schedule();

    return Object.freeze({
      layer,
      render,
      schedule,
      dispose() {
        disposed = true;
        if (frame !== null) root.cancelAnimationFrame(frame);
        clearDecorations();
        layer.remove();
        renderDisposable?.dispose?.();
        resizeDisposable?.dispose?.();
        terminalElement.removeEventListener('focusin', schedule);
        terminalElement.removeEventListener('focusout', schedule);
      },
    });
  }

  root.WarpishRtlTerminal = Object.freeze({
    RTL_SCRIPT_CHARACTER,
    activeRtlRun,
    createRenderer,
    lineCells,
    rtlCharacterJoinRanges,
  });
}(globalThis));
