// Lazily loads the CopilotKit generated-UI bundle once, sharing a single
// in-flight import across widgets. A failed import is not cached, so a
// later widget can retry instead of every view failing until reload.
export function createGeneratedUiLoader({loadModule, loadStylesheet = () => {}}) {
  if (typeof loadModule !== 'function') throw new TypeError('A generated UI module loader is required.');
  let pending;
  return function loadGeneratedUi() {
    if (!pending) {
      pending = (async () => {
        loadStylesheet();
        return loadModule();
      })();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}
