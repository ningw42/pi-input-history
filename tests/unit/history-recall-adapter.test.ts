import { describe, expect, test } from "bun:test";
import { installHistoryRecall } from "../../src/history-recall-adapter.ts";

/**
 * Stands in for the stock editor, with Pi 0.87.1's call pattern: navigation sets `historyIndex`, then
 * calls `setTextInternal(history[historyIndex], cursor)`; public `setText` first exits browsing. Its
 * prototype is passed as the stock reference. Compatibility with the real editor is exercised by the
 * Pi integration driver, not here.
 */
class FakeEditor {
  history: string[] = [];
  historyIndex = -1;
  text = "";
  cursor: string | undefined;
  calls: unknown[][] = [];
  onChange?: (text: string) => void;

  setTextInternal(text: string, cursor: "start" | "end" = "end"): string {
    this.calls.push([this, text, cursor]);
    this.text = text;
    this.cursor = cursor;
    this.onChange?.(text);
    return "original-result";
  }

  navigateHistory(direction: 1 | -1) {
    this.historyIndex -= direction;
    return this.setTextInternal(this.history[this.historyIndex] || "", direction === -1 ? "start" : "end");
  }

  exitHistoryBrowsing() {
    this.historyIndex = -1;
  }

  addToHistory(text: string) {
    this.history.unshift(text);
  }

  setText(text: string) {
    this.exitHistoryBrowsing();
    return this.setTextInternal(text);
  }

  recall(index: number, cursor: "start" | "end" = "start") {
    this.historyIndex = index;
    return this.setTextInternal(this.history[index] || "", cursor);
  }
}

const STOCK = FakeEditor.prototype;

const upper = (text: string) => text.toUpperCase();

function editorWith(history: string[]) {
  const editor = new FakeEditor();
  editor.history = [...history];
  return editor;
}

describe("recall while browsing history", () => {
  test("shows the display form of the recalled entry", () => {
    const editor = editorWith(["newest", "older"]);
    expect(installHistoryRecall(editor, upper, STOCK)).toBe("installed");
    editor.recall(1);
    expect(editor.text).toBe("OLDER");
    expect(editor.history).toEqual(["newest", "older"]);
  });

  test("keeps the receiver, cursor argument, arity, and return value of the original call", () => {
    const editor = editorWith(["entry"]);
    installHistoryRecall(editor, upper, STOCK);
    editor.historyIndex = 0;
    expect(editor.setTextInternal("entry", "start")).toBe("original-result");
    expect(editor.setTextInternal("entry")).toBe("original-result");
    expect(editor.calls).toEqual([
      [editor, "ENTRY", "start"],
      [editor, "ENTRY", "end"],
    ]);
  });

  test("leaves calls outside history browsing unchanged", () => {
    const editor = editorWith(["entry"]);
    installHistoryRecall(editor, upper, STOCK);
    editor.setText("entry");
    expect(editor.text).toBe("entry");
    editor.historyIndex = -1;
    editor.setTextInternal("");
    expect(editor.text).toBe("");
  });

  test("leaves text that is not the entry at the browsing index unchanged", () => {
    const editor = editorWith(["entry"]);
    installHistoryRecall(editor, upper, STOCK);
    editor.historyIndex = 0;
    editor.setTextInternal("something else");
    expect(editor.text).toBe("something else");
  });

  test("ignores invalid browsing state at call time", () => {
    const editor = editorWith(["entry"]);
    installHistoryRecall(editor, upper, STOCK);
    for (const index of [1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      editor.historyIndex = index;
      editor.setTextInternal("entry");
      expect(editor.text).toBe("entry");
    }
    editor.historyIndex = 0;
    (editor as { history: unknown }).history = "entry";
    editor.setTextInternal("entry");
    expect(editor.text).toBe("entry");
  });

  test("falls back to the raw entry when the display function fails", () => {
    const editor = editorWith(["entry"]);
    installHistoryRecall(
      editor,
      () => {
        throw new Error("resolver failed");
      },
      STOCK,
    );
    editor.recall(0);
    expect(editor.text).toBe("entry");

    const other = editorWith(["entry"]);
    installHistoryRecall(other, () => undefined as never, STOCK);
    other.recall(0);
    expect(other.text).toBe("entry");
  });

  test("propagates errors raised by the original method", () => {
    const editor = editorWith(["entry"]);
    installHistoryRecall(editor, upper, STOCK);
    editor.onChange = () => {
      throw new Error("callback failed");
    };
    expect(() => editor.recall(0)).toThrow("callback failed");
  });

  test("never swaps history entries, so a synchronous onChange can add history safely", () => {
    const editor = editorWith(["b", "a"]);
    installHistoryRecall(editor, upper, STOCK);
    editor.onChange = (text) => {
      if (text === "A") editor.history.unshift("added by callback");
    };
    editor.recall(1);
    expect(editor.text).toBe("A");
    expect(editor.history).toEqual(["added by callback", "b", "a"]);
  });

  test("affects only the instance it was installed on", () => {
    const adapted = editorWith(["entry"]);
    const plain = editorWith(["entry"]);
    installHistoryRecall(adapted, upper, STOCK);
    plain.recall(0);
    expect(plain.text).toBe("entry");
    expect(Object.hasOwn(plain, "setTextInternal")).toBe(false);
  });

  test("is not stacked by a second installation", () => {
    const editor = editorWith(["entry"]);
    let conversions = 0;
    const count = (text: string) => {
      conversions++;
      return upper(text);
    };
    expect(installHistoryRecall(editor, count, STOCK)).toBe("installed");
    const wrapped = editor.setTextInternal;
    expect(installHistoryRecall(editor, count, STOCK)).toBe("already-installed");
    expect(editor.setTextInternal).toBe(wrapped);
    editor.recall(0);
    expect(conversions).toBe(1);
    expect(editor.calls.length).toBe(1);
  });

  test("uses the latest installer's display function when an editor outlives a lifecycle", () => {
    const editor = editorWith(["entry"]);
    installHistoryRecall(
      editor,
      () => {
        throw new Error("stale extension context");
      },
      STOCK,
    );
    expect(installHistoryRecall(editor, (text) => `[${text}]`, STOCK)).toBe("already-installed");
    editor.recall(0);
    expect(editor.text).toBe("[entry]");
    expect(editor.calls.length).toBe(1);
  });
});

describe("installation preconditions", () => {
  function expectUnchanged(editor: object) {
    const before = Object.getOwnPropertyDescriptor(editor, "setTextInternal");
    const method = (editor as { setTextInternal?: unknown }).setTextInternal;
    expect(installHistoryRecall(editor, upper, STOCK)).toBe("unsupported");
    expect(Object.getOwnPropertyDescriptor(editor, "setTextInternal")).toEqual(before);
    expect((editor as { setTextInternal?: unknown }).setTextInternal).toBe(method);
  }

  test("rejects editors without the expected history members", () => {
    expectUnchanged({});
    expectUnchanged({ history: [], historyIndex: -1 });
    expectUnchanged(Object.assign(editorWith([]), { setTextInternal: "not a function" }));
    expectUnchanged(Object.assign(editorWith([]), { history: undefined }));
    expectUnchanged(Object.assign(editorWith([]), { historyIndex: undefined }));
  });

  test("rejects invalid history state", () => {
    for (const historyIndex of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, -2, 1, "0"]) {
      expectUnchanged(Object.assign(editorWith(["entry"]), { historyIndex }));
    }
    // biome-ignore lint/suspicious/noSparseArray: a sparse history slot is the case under test
    expectUnchanged(Object.assign(editorWith([]), { history: ["a", , "c"] }));
    expectUnchanged(Object.assign(editorWith([]), { history: ["a", 1] }));
    expectUnchanged(Object.assign(editorWith([]), { history: "a" }));
  });

  test("accepts an editor that is browsing a valid entry", () => {
    expect(installHistoryRecall(Object.assign(editorWith(["a", "b"]), { historyIndex: 1 }), upper, STOCK)).toBe("installed");
  });

  test("rejects frozen, sealed, and non-extensible editors", () => {
    expectUnchanged(Object.freeze(editorWith(["entry"])));
    expectUnchanged(Object.seal(editorWith(["entry"])));
    expectUnchanged(Object.preventExtensions(editorWith(["entry"])));
  });

  test("rejects an own method that cannot be replaced", () => {
    const fixed = editorWith(["entry"]);
    Object.defineProperty(fixed, "setTextInternal", { value: FakeEditor.prototype.setTextInternal, writable: false, configurable: false });
    expectUnchanged(fixed);

    const accessor = editorWith(["entry"]);
    Object.defineProperty(accessor, "setTextInternal", { get: () => FakeEditor.prototype.setTextInternal, configurable: true });
    expectUnchanged(accessor);
  });

  test("rejects an editor whose history methods are not the stock implementations", () => {
    // Keeps the browsing index across public setText: a programmatic raw assignment would be converted.
    class KeepsBrowsing extends FakeEditor {
      override setText(text: string) {
        return this.setTextInternal(text);
      }
    }
    const keeps = Object.assign(new KeepsBrowsing(), { history: ["raw"], historyIndex: 0 });
    expectUnchanged(keeps);
    keeps.setText("raw");
    expect(keeps.text).toBe("raw");

    // Treats the browsed slot as editable: recall would write display text into raw history.
    class EditsSlot extends FakeEditor {
      override setTextInternal(text: string, cursor: "start" | "end" = "end") {
        if (this.historyIndex >= 0) this.history[this.historyIndex] = text;
        return super.setTextInternal(text, cursor);
      }
    }
    const edits = Object.assign(new EditsSlot(), { history: ["raw"] });
    expectUnchanged(edits);
    edits.recall(0);
    expect(edits.history).toEqual(["raw"]);

    const ownMethod = editorWith(["raw"]);
    Object.assign(ownMethod, { setTextInternal: (text: string) => text });
    expectUnchanged(ownMethod);

    for (const method of ["navigateHistory", "exitHistoryBrowsing", "addToHistory"] as const) {
      const Custom = class extends FakeEditor {};
      Object.defineProperty(Custom.prototype, method, { value: () => {}, configurable: true, writable: true });
      expectUnchanged(Object.assign(new Custom(), { history: ["raw"] }));
    }
  });

  test("accepts a subclass that only changes unrelated behavior", () => {
    class Styled extends FakeEditor {
      render() {
        return ["styled"];
      }
    }
    expect(installHistoryRecall(Object.assign(new Styled(), { history: ["raw"] }), upper, STOCK)).toBe("installed");
  });

  test("rejects everything when the stock reference lacks a history method", () => {
    const { navigateHistory: _omitted, ...partial } = Object.getOwnPropertyDescriptors(FakeEditor.prototype);
    const reference = Object.defineProperties({}, partial);
    const editor = editorWith(["raw"]);
    expect(installHistoryRecall(editor, upper, reference)).toBe("unsupported");
    expect(Object.hasOwn(editor, "setTextInternal")).toBe(false);
  });

  test("leaves an editor unchanged when defining the wrapper fails", () => {
    const target = editorWith(["entry"]);
    const refusing = new Proxy(target, {
      defineProperty() {
        throw new Error("refused");
      },
    });
    expectUnchanged(refusing);
    expect(Object.hasOwn(target, "setTextInternal")).toBe(false);

    const ignoring = new Proxy(editorWith(["entry"]), { defineProperty: () => true });
    expectUnchanged(ignoring);
  });
});
