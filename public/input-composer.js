(function registerWarpishInputComposer(root) {
  const FEATURE_PARAM = 'input';
  const ENABLED_FLAGS = new Set(['v2', 'composer', 'v2-raw']);

  function resolveInputExperience(search = '') {
    let flag = '';
    try {
      flag = new URLSearchParams(String(search || '')).get(FEATURE_PARAM) || '';
    } catch {}
    return Object.freeze({
      enabled: ENABLED_FLAGS.has(flag),
      flag: flag || 'raw',
      initialMode: flag === 'v2-raw' ? 'raw' : 'composer',
    });
  }

  function commandPayload(value) {
    const safeText = String(value ?? '')
      .replace(/\r\n?|\u2028|\u2029/gu, '\n')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, '')
      .replace(/\n/gu, ' ')
      .replace(/\t/gu, '    ');
    return safeText + '\r';
  }

  function shouldSubmitKey(event = {}) {
    return event.key === 'Enter'
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.isComposing;
  }

  function createController({
    rootElement,
    form,
    textarea,
    submitButton,
    modeButtons = [],
    statusElement,
    enabled = false,
    initialMode = 'composer',
    send,
    focusRaw,
  } = {}) {
    if (!rootElement || !form || !textarea || !submitButton || typeof send !== 'function') return null;

    const drafts = new Map();
    let sessionId = null;
    let acceptsInput = false;
    let mode = initialMode === 'raw' ? 'raw' : 'composer';

    function saveDraft() {
      if (!sessionId) return;
      if (textarea.value) drafts.set(sessionId, textarea.value);
      else drafts.delete(sessionId);
    }

    function render() {
      rootElement.hidden = !enabled;
      rootElement.dataset.mode = mode;
      form.hidden = !enabled || mode !== 'composer';
      textarea.disabled = !acceptsInput;
      submitButton.disabled = !acceptsInput;
      for (const button of modeButtons) {
        const selected = button.dataset.inputMode === mode;
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        button.classList.toggle('active', selected);
      }
      if (statusElement) {
        statusElement.textContent = acceptsInput
          ? mode === 'composer'
            ? 'Enter sends • draft line breaks are joined safely'
            : 'Raw terminal keys are active'
          : 'This terminal is read-only';
      }
    }

    function focusComposer() {
      if (!enabled || mode !== 'composer' || textarea.disabled) return false;
      try {
        textarea.focus({ preventScroll: true });
      } catch {
        textarea.focus();
      }
      return true;
    }

    function setMode(nextMode, { focus = true } = {}) {
      const normalized = nextMode === 'raw' ? 'raw' : 'composer';
      if (mode === normalized) {
        if (focus) {
          if (mode === 'composer') focusComposer();
          else focusRaw?.();
        }
        return mode;
      }
      saveDraft();
      mode = normalized;
      render();
      if (focus) {
        if (mode === 'composer') focusComposer();
        else focusRaw?.();
      }
      return mode;
    }

    function setSession(nextSessionId, nextAcceptsInput) {
      const normalizedId = nextSessionId ? String(nextSessionId) : null;
      if (normalizedId !== sessionId) {
        saveDraft();
        sessionId = normalizedId;
        textarea.value = sessionId ? drafts.get(sessionId) || '' : '';
      }
      acceptsInput = Boolean(sessionId && nextAcceptsInput);
      render();
    }

    function submit() {
      if (!enabled || mode !== 'composer' || !sessionId || !acceptsInput) return false;
      const value = textarea.value;
      const submittedSessionId = sessionId;
      const sent = send(commandPayload(value), { sessionId: submittedSessionId });
      if (!sent || sessionId !== submittedSessionId) return false;
      drafts.delete(submittedSessionId);
      textarea.value = '';
      render();
      return true;
    }

    const onSubmit = (event) => {
      event.preventDefault();
      submit();
    };
    const onKeyDown = (event) => {
      if (!shouldSubmitKey(event)) return;
      event.preventDefault();
      submit();
    };
    const onInput = () => saveDraft();
    const onModeClick = (event) => {
      const button = event.currentTarget;
      setMode(button.dataset.inputMode);
    };

    form.addEventListener('submit', onSubmit);
    textarea.addEventListener('keydown', onKeyDown);
    textarea.addEventListener('input', onInput);
    for (const button of modeButtons) button.addEventListener('click', onModeClick);
    render();

    return Object.freeze({
      focus: focusComposer,
      setMode,
      setSession,
      submit,
      get enabled() { return enabled; },
      get mode() { return mode; },
      get sessionId() { return sessionId; },
      dispose() {
        saveDraft();
        form.removeEventListener('submit', onSubmit);
        textarea.removeEventListener('keydown', onKeyDown);
        textarea.removeEventListener('input', onInput);
        for (const button of modeButtons) button.removeEventListener('click', onModeClick);
      },
    });
  }

  root.WarpishInputComposer = Object.freeze({
    FEATURE_PARAM,
    commandPayload,
    createController,
    resolveInputExperience,
    shouldSubmitKey,
  });
}(globalThis));
