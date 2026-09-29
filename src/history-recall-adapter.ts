/**
 * Up/Down history recall adapter for Pi's stock editor.
 *
 * Pi has no public hook for how a recalled history entry is displayed. The stock editor (Pi 0.87.1,
 * pi-tui `Editor`) recalls an entry by setting `historyIndex` and then calling its private
 * `setTextInternal(history[historyIndex], cursorPlacement)`. Its other two callers run while
 * `historyIndex === -1`: public `setText` exits browsing first, and returning past the newest entry
 * without a saved draft sets empty text. Restoring a saved draft assigns editor state directly.
 *
 * The adapter wraps `setTextInternal` on one editor instance and, only for the history-recall call,
 * passes the entry's display text instead of the raw entry. History storage is never touched: a
 * synchronous `onChange` inside the original call may add history, so swapping array slots could lose
 * or overwrite entries. Everything else — routing, cursor placement, draft/undo state, callbacks — stays
 * with the original method, which is called exactly once per call.
 *
 * These are private, version-sensitive internals. Re-run the Pi integration tests when upgrading Pi.
 */

export type InstallResult = "installed" | "already-installed" | "unsupported";

const ADAPTER = Symbol.for("pi-input-history.history-recall-adapter");
/** The stock editor's private method that history navigation calls to show an entry. */
const RECALL_METHOD = "setTextInternal";

type HistoryState = { history?: unknown; historyIndex?: unknown };
/** Kept on the wrapper, so a later installation on the same editor replaces the display function. */
type AdapterState = { display: (raw: string) => string };

/**
 * Install the adapter on `editor`, or leave it untouched. `display` maps a raw history entry to the text
 * shown on recall; if it throws or returns a non-string, the raw entry is shown. On an editor that is
 * already adapted (one reused across Pi lifecycles), `display` replaces the previous function instead
 * of stacking a second wrapper.
 */
export function installHistoryRecall(editor: object, display: (raw: string) => string): InstallResult {
  let original: unknown;
  let previous: PropertyDescriptor | undefined;
  try {
    original = (editor as Record<string, unknown>)[RECALL_METHOD];
    if (typeof original !== "function") return "unsupported";
    const installed = (original as { [ADAPTER]?: AdapterState })[ADAPTER];
    if (installed) {
      installed.display = display;
      return "already-installed";
    }
    const { history, historyIndex } = editor as HistoryState;
    if (!isHistory(history) || !isIndexInto(historyIndex, history)) return "unsupported";
    if (!Object.isExtensible(editor)) return "unsupported";
    previous = Object.getOwnPropertyDescriptor(editor, RECALL_METHOD);
  } catch {
    return "unsupported";
  }
  if (previous && !(previous.writable && previous.configurable)) return "unsupported";

  const method = original as (this: unknown, ...args: unknown[]) => unknown;
  const state: AdapterState = { display };
  const wrapper = function (this: unknown, text: unknown, ...rest: unknown[]) {
    return method.call(this, shownText(this, text, state.display), ...rest);
  };
  Object.defineProperty(wrapper, ADAPTER, { value: state });

  try {
    const enumerable = previous?.enumerable ?? false;
    const defined = Reflect.defineProperty(editor, RECALL_METHOD, { value: wrapper, writable: true, configurable: true, enumerable });
    if (defined && (editor as Record<string, unknown>)[RECALL_METHOD] === wrapper) return "installed";
  } catch {}
  try {
    if (previous) Reflect.defineProperty(editor, RECALL_METHOD, previous);
    else Reflect.deleteProperty(editor, RECALL_METHOD);
  } catch {}
  return "unsupported";
}

/** The text to pass on: the display form only for the history-recall call, else `text` unchanged. */
function shownText(receiver: unknown, text: unknown, display: (raw: string) => string): unknown {
  if (typeof text !== "string") return text;
  try {
    const { history, historyIndex } = receiver as HistoryState;
    if (typeof historyIndex !== "number" || !Number.isInteger(historyIndex) || historyIndex < 0) return text;
    if (!Array.isArray(history) || history[historyIndex] !== text) return text;
    const shown = display(text);
    return typeof shown === "string" ? shown : text;
  } catch {
    return text;
  }
}

function isHistory(history: unknown): history is unknown[] {
  if (!Array.isArray(history)) return false;
  for (let i = 0; i < history.length; i++) {
    if (!(i in history) || typeof history[i] !== "string") return false;
  }
  return true;
}

function isIndexInto(index: unknown, history: unknown[]): boolean {
  return typeof index === "number" && Number.isInteger(index) && index >= -1 && index < history.length;
}
