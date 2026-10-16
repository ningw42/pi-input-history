import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-input-history-test-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));

class Editor {
  text = "";
  cursor = 0;
  history = [];
  addToHistory(text) { this.history.unshift(text); }
}

let listSessions;
const sessionEntries = new Map();
mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    CustomEditor: Editor,
    getAgentDir: () => agentDir,
    SessionManager: {
      list: (...args) => listSessions(...args),
      open: (path) => ({ getEntries: () => sessionEntries.get(path) }),
    },
  },
});
mock.module("@earendil-works/pi-tui", {
  namedExports: {
    Input: class {},
    Key: {},
    matchesKey: () => false,
    truncateToWidth: (text) => text,
    visibleWidth: (text) => text.length,
  },
});
const { default: inputHistory } = await import("../index.ts");

function fixture(previousFactory) {
  let resolve;
  let reject;
  const listing = new Promise((yes, no) => { resolve = yes; reject = no; });
  listSessions = () => listing;
  const handlers = new Map();
  inputHistory({
    on: (event, handler) => handlers.set(event, handler),
    registerShortcut: () => {},
  });
  const state = {
    editor: new Editor(),
    factory: previousFactory,
    view: undefined,
    focused: undefined,
    replacements: 0,
  };
  state.view = state.focused = state.editor;
  const ctx = {
    cwd: "/test-project",
    ui: {
      getEditorComponent: () => state.factory,
      setEditorComponent: (factory) => {
        state.replacements++;
        state.factory = factory;
        const draft = state.editor.text;
        state.editor = factory({}, {}, {});
        state.editor.text = draft;
        // Pi's setter dismisses selectors and focuses the replacement editor.
        state.view = state.focused = state.editor;
      },
    },
  };
  return {
    state,
    start: () => handlers.get("session_start")({}, ctx),
    shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
    finish: (messages = ["old prompt", "recent prompt"]) => {
      const path = "/fake/session.jsonl";
      sessionEntries.set(path, messages.map((text) => ({
        type: "message", message: { role: "user", content: text },
      })));
      resolve(messages.length ? [{ path, modified: new Date(0) }] : []);
    },
    fail: () => reject(new Error("unavailable history")),
  };
}

test("history completion does not dismiss a model selector opened during startup", async () => {
  const f = fixture();
  const loading = f.start();
  const selector = { query: "gpt", selectedIndex: 2 };
  f.state.view = f.state.focused = selector;
  f.finish();
  await loading;
  assert.equal(f.state.view, selector);
  assert.equal(f.state.focused, selector);
  assert.equal(selector.query, "gpt");
  assert.equal(selector.selectedIndex, 2);
});

test("install once before loading, then seed the same editor without resetting its draft", async () => {
  const f = fixture();
  const loading = f.start();
  assert.equal(f.state.replacements, 1);
  const editor = f.state.editor;
  editor.text = "partly typed draft";
  editor.cursor = 6;
  f.finish();
  await loading;
  assert.equal(f.state.replacements, 1);
  assert.equal(f.state.editor, editor);
  assert.equal(editor.text, "partly typed draft");
  assert.equal(editor.cursor, 6);
  assert.deepEqual(editor.history, ["recent prompt", "old prompt"]);
});

test("preserve another extension's editor factory and seed later instances", async () => {
  const customEditor = new Editor();
  customEditor.marker = "custom editor";
  const create = mock.fn(() => customEditor);
  const f = fixture(create);
  const loading = f.start();
  assert.equal(f.state.editor, customEditor);
  f.finish();
  await loading;
  assert.equal(f.state.editor.marker, "custom editor");
  assert.equal(create.mock.callCount(), 1);
  assert.deepEqual(customEditor.history, ["recent prompt", "old prompt"]);

  // A later factory invocation must seed its new editor from the loaded cache.
  create.mock.mockImplementation(() => new Editor());
  const nextEditor = f.state.factory({}, {}, {});
  assert.deepEqual(nextEditor.history, ["recent prompt", "old prompt"]);
});

for (const outcome of ["empty", "failed"]) {
  test(`${outcome} history leaves an open selector and the editor unchanged`, async () => {
    const f = fixture();
    const loading = f.start();
    const editor = f.state.editor;
    const selector = {};
    f.state.view = f.state.focused = selector;
    if (outcome === "failed") f.fail();
    else f.finish([]);
    await loading;
    assert.equal(f.state.view, selector);
    assert.equal(f.state.focused, selector);
    assert.equal(f.state.editor, editor);
    assert.deepEqual(editor.history, []);
  });
}

test("a pending load cannot seed the editor after session shutdown", async () => {
  const f = fixture();
  const loading = f.start();
  const editor = f.state.editor;
  const replacements = f.state.replacements;
  f.shutdown();
  f.finish();
  await loading;
  assert.deepEqual(editor.history, []);
  assert.equal(f.state.editor, editor);
  assert.equal(f.state.replacements, replacements);
});

test("a newer session invalidates the previous load and factory seed", async () => {
  const f = fixture();
  const firstLoad = f.start();
  const firstEditor = f.state.editor;
  const secondLoad = f.start();
  const secondEditor = f.state.editor;
  f.finish();
  await Promise.all([firstLoad, secondLoad]);
  assert.deepEqual(firstEditor.history, []);
  assert.deepEqual(secondEditor.history, ["recent prompt", "old prompt"]);
  assert.equal(f.state.replacements, 2);
  // The second factory composes the first one. Its obsolete seed must not run.
  const nextEditor = f.state.factory({}, {}, {});
  assert.deepEqual(nextEditor.history, ["recent prompt", "old prompt"]);
});

test("only the latest editor instance is seeded when loading finishes", async () => {
  const f = fixture();
  const loading = f.start();
  const firstEditor = f.state.editor;
  const nextEditor = f.state.factory({}, {}, {});
  f.finish();
  await loading;
  assert.deepEqual(firstEditor.history, []);
  assert.deepEqual(nextEditor.history, ["recent prompt", "old prompt"]);
});

test("an editor without addToHistory remains supported", async () => {
  const customEditor = { text: "custom draft" };
  const f = fixture(() => customEditor);
  const loading = f.start();
  f.finish();
  await loading;
  assert.equal(f.state.editor, customEditor);
});
