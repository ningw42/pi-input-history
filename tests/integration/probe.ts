/**
 * Probe extension for the Pi integration driver (tests/run-pi-integration.ts).
 *
 * The driver starts the real Pi executable with `--no-extensions -e probe.ts -e <extension>`. Loaded
 * through Pi's own extension loader, this probe imports the Pi packages bundled in that executable,
 * runs one scenario from the driver's plan across real Pi lifecycles (startup, /new, resume, fork,
 * /reload), presses keys through the PTY host, and appends structured results to the plan's results
 * file. The stock bundled `Editor` is the oracle for history slots and navigation.
 *
 * Reads private editor/TUI fields (`history`, `historyIndex`, `tui.overlayStack`). Re-check on Pi upgrades.
 */

import { appendFileSync, chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  parseSkillBlock,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { loadRecentPrompts } from "../../index.ts";
import { activeContextHistory } from "../../src/context-history.ts";
import { installHistoryRecall } from "../../src/history-recall-adapter.ts";
import { commandInventory, toRecallText, type SkillInventory } from "../../src/skill-recall.ts";
import { skillEnvelope } from "../support/skill-envelope.ts";
import type { Fixtures } from "./fixtures.ts";

type Plan = { scenario: string; results: string; control: string; fixtures: Fixtures };
const plan: Plan = JSON.parse(readFileSync(process.env.PIH_PLAN!, "utf8"));
const fixtures = plan.fixtures;

// ─── State shared across lifecycles (Pi reloads extensions on every session replacement) ──────────

type ProbeState = {
  lifecycles: string[];
  active?: any;
  activeAtStart?: any;
  editorIds: WeakMap<object, number>;
  nextEditorId: number;
  settleKey: string;
  settleKeyAt: number;
  renders: { at: number; text: string }[];
  inputs: number;
  submitted: string[];
  flags: Record<string, boolean>;
  /** Scripted replies of the replay scenario's local faux model, consumed in order ("ok" when empty). */
  replies: { text?: string; error?: string; delayMs?: number }[];
  agentEnds: number;
  finished: boolean;
};

const probeState: ProbeState = ((globalThis as any).__pihProbe ??= {
  lifecycles: [],
  editorIds: new WeakMap(),
  nextEditorId: 1,
  settleKey: "",
  settleKeyAt: 0,
  renders: [],
  inputs: 0,
  submitted: [],
  flags: {},
  replies: [],
  agentEnds: 0,
  finished: false,
});

const ORACLE = Symbol.for("pih.oracle-editor");
const HOOKED = Symbol.for("pih.render-hook");
const ADAPTER = Symbol.for("pi-input-history.history-recall-adapter");

function editorId(editor: object): number {
  let id = probeState.editorIds.get(editor);
  if (id === undefined) probeState.editorIds.set(editor, (id = probeState.nextEditorId++));
  return id;
}

// Track the editor the TUI actually renders: the active one. Oracle editors are marked and ignored.
const editorProto = Editor.prototype as any;
if (!editorProto[HOOKED]) {
  editorProto[HOOKED] = true;
  const render = editorProto.render;
  editorProto.render = function (this: any, width: number) {
    const lines = render.call(this, width);
    if (!this[ORACLE]) noteRender(this);
    return lines;
  };
}

/** Record a render of the editor on screen (the active one). */
function noteRender(editor: any) {
  probeState.active = editor;
  const key = `${editorId(editor)}:${editor.history?.length}`;
  const at = performance.now();
  if (key !== probeState.settleKey) {
    probeState.settleKey = key;
    probeState.settleKeyAt = at;
  }
  probeState.renders.push({ at, text: editor.getText() });
  if (probeState.renders.length > 200) probeState.renders.shift();
}

// ─── Results ───────────────────────────────────────────────────────────────────────────────────────

function emit(record: object) {
  appendFileSync(plan.results, `${JSON.stringify(record)}\n`);
}

function check(id: string, pass: boolean, detail?: unknown) {
  emit({ id, pass, ...(pass || detail === undefined ? {} : { detail }) });
}

function equal(id: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  check(id, pass, pass ? undefined : { actual, expected });
}

function metric(id: string, value: unknown) {
  emit({ id, metric: value });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b_[^\x1b]*\x1b\\/g, "");

// ─── Oracles ───────────────────────────────────────────────────────────────────────────────────────

const identity = (s: string) => s;
const tuiStub = { requestRender() {}, terminal: { rows: 40, columns: 120 } };
const themeStub = {
  borderColor: identity,
  selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

/** A stock, unadapted editor from the Pi executable. */
function stockEditor(history: string[] = []): any {
  const editor: any = new Editor(tuiStub as any, themeStub as any);
  editor[ORACLE] = true;
  for (const text of history) editor.addToHistory(text);
  editor.render(100);
  return editor;
}

/** The raw slots a fresh stock editor holds after the given insertion streams. */
function stockHistory(...streams: string[][]): string[] {
  return [...stockEditor(streams.flat()).history];
}

const everythingLoaded: SkillInventory = { resolves: () => true };

// ─── Test context for one lifecycle ────────────────────────────────────────────────────────────────

type TestContext = ReturnType<typeof testContext>;

function testContext(ctx: ExtensionContext, pi: ExtensionAPI, label: string) {
  const editor = () => probeState.active;
  const tui = () => probeState.active.tui;
  const display = (raw: string) => toRecallText(raw, commandInventory(() => pi.getCommands()));

  async function press(sequence: string, until?: () => boolean, what = JSON.stringify(sequence)) {
    const before = probeState.inputs;
    appendFileSync(plan.control, `${JSON.stringify({ send: Buffer.from(sequence).toString("base64") })}\n`);
    await waitFor(() => probeState.inputs > before, `terminal input ${what}`);
    await sleep(15);
    if (until) await waitFor(until, `effect of ${what}`);
  }

  async function type(text: string) {
    for (const ch of text) await press(ch);
  }

  /** Submit a command line; used to trigger lifecycles. The current ctx is stale afterwards. */
  async function submit(line: string) {
    const expected = probeState.lifecycles.length + 1;
    ctx.ui.setEditorText(line);
    await press("\r");
    setTimeout(() => {
      if (!probeState.finished && probeState.lifecycles.length < expected) {
        check(`${label}.submit(${line.split(" ")[0]})`, false, "expected a new session_start");
        finishNow();
      }
    }, 15000);
  }

  function cursorAtStart() {
    const c = editor().getCursor();
    return c.line === 0 && c.col === 0;
  }

  function cursorAtEnd() {
    const lines: string[] = editor().getLines();
    const c = editor().getCursor();
    return c.line === lines.length - 1 && c.col === lines[lines.length - 1]!.length;
  }

  function overlay(): any {
    const stack = tui().overlayStack as { component: any }[];
    return stack[stack.length - 1]?.component;
  }

  /** The reverse-search overlay as the user sees it: counter, preview text, and underlined characters. */
  function searchView() {
    const raw: string[] = overlay().render(220);
    const plain = raw.map(stripAnsi);
    const counter = /\[(\d+)\/(\d+)\]/.exec(plain[0] ?? "");
    const separators = plain.flatMap((line, i) => (/^─+$/.test(line.trim()) ? [i] : []));
    let preview: string | undefined;
    let highlighted = "";
    if (separators.length >= 2) {
      const lines = plain.slice(separators[0]! + 1, separators[1]).map((l) => l.replace(/^▸ /, "").trimEnd());
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      preview = lines.join("\n");
      for (const line of raw.slice(separators[0]! + 1, separators[1])) {
        for (const m of line.matchAll(/\x1b\[4m([\s\S]*?)\x1b\[24m/g)) highlighted += stripAnsi(m[1]!);
      }
    }
    return { index: Number(counter?.[1] ?? 0), total: Number(counter?.[2] ?? 0), preview, highlighted };
  }

  /** Every record the open search currently matches, in the order ↑ cycles through them. */
  function searchMatches(): string[] {
    const component = overlay();
    return component.matchIndices.map((i: number) => component.history[i]);
  }

  async function openSearch() {
    await press("\x12", () => tui().hasOverlay(), "ctrl+r");
  }

  /**
   * Search for `query`, move to the match showing `expected`, check the preview and highlight, and
   * accept it. Fuzzy subsequence matching also hits unrelated long raw records, so the target is
   * located among the matches rather than assumed to be first.
   */
  async function searchAndAccept(id: string, query: string, expected: string, options: { occurrences?: number } = {}) {
    await openSearch();
    await type(query);
    const matches = searchMatches();
    const position = matches.indexOf(expected);
    check(`${id}.found`, position >= 0, matches);
    if (options.occurrences !== undefined) {
      equal(`${id}.occurrences`, matches.filter((m) => m === expected).length, options.occurrences);
    }
    for (let i = 0; i < position; i++) await press("\x1b[A");
    const view = searchView();
    equal(`${id}.preview`, view.preview, expected);
    const queryChars = new Set(query.toLowerCase().replace(/\s+/g, ""));
    check(
      `${id}.highlight`,
      view.highlighted.length > 0 && [...view.highlighted.toLowerCase()].every((ch) => queryChars.has(ch)),
      view.highlighted,
    );
    // 1.1.3 fix: the accepted text is painted without another keypress. On Pi's Bun runtime the TUI's
    // own post-input render already lands after the accept, so also check the explicit render request.
    const ui = tui();
    const ownRequestRender = Object.getOwnPropertyDescriptor(ui, "requestRender");
    const requestRender = ui.requestRender;
    const requestedWithText: string[] = [];
    ui.requestRender = function (this: unknown, ...args: unknown[]) {
      requestedWithText.push(editor().getText());
      return requestRender.apply(this, args);
    };
    const acceptedAt = performance.now();
    try {
      await press("\r", () => !tui().hasOverlay(), "enter");
      equal(`${id}.accepted`, ctx.ui.getEditorText(), expected);
      await waitFor(() => probeState.renders.some((r) => r.at > acceptedAt && r.text === expected), "repaint", 2000).then(
        () => check(`${id}.repaint`, true),
        () => check(`${id}.repaint`, false, "no render showed the accepted text"),
      );
    } finally {
      if (ownRequestRender) Object.defineProperty(ui, "requestRender", ownRequestRender);
      else delete ui.requestRender;
    }
    check(`${id}.repaintRequested`, requestedWithText.includes(expected), requestedWithText);
  }

  /** Open a search, check which records match, and cancel. */
  async function searchShows(id: string, query: string, expected: { includes?: string[]; excludes?: string[]; total?: number }) {
    await openSearch();
    await type(query);
    const matches = searchMatches();
    for (const text of expected.includes ?? []) check(`${id}.includes`, matches.includes(text), { text, matches });
    for (const text of expected.excludes ?? []) check(`${id}.excludes`, !matches.includes(text), { text, matches });
    if (expected.total !== undefined) equal(`${id}.total`, [matches.length, searchView().total], [expected.total, expected.total]);
    await press("\x07", () => !tui().hasOverlay(), "ctrl+g");
  }

  /** Check the active editor's raw slots against the stock C-then-H insertion oracle. */
  async function checkSeed(options: { cache: "populated" | "empty" | "any"; h?: string[]; prefix?: string[] }) {
    const cache = await loadRecentPrompts(ctx.cwd, 100);
    const h = activeContextHistory(ctx.sessionManager, sessionEntryToContextMessages);
    const expected = stockHistory(options.prefix ?? [], [...cache].reverse(), h);
    equal(`${label}.seed.slots`, editor().history, expected);
    if (options.h) equal(`${label}.seed.h`, h, options.h);
    if (options.cache === "populated") equal(`${label}.seed.cacheSize`, cache.length, 100);
    if (options.cache === "empty") equal(`${label}.seed.cacheSize`, cache.length, 0);
    metric(`${label}.seed.sizes`, { cache: cache.length, h: h.length, slots: editor().history.length });
  }

  function checkAdapter(expected: boolean) {
    const method = editor().setTextInternal;
    equal(`${label}.adapter.installed`, Object.hasOwn(editor(), "setTextInternal") && method?.[ADAPTER] !== undefined, expected);
  }

  /**
   * Down browses newer history only from the last visual line; on a multi-line entry it first moves
   * the cursor. Press Down until the shown entry changes.
   */
  async function downToNextEntry() {
    const from = editor().getText();
    for (let i = 0; i < 50 && editor().getText() === from; i++) await press("\x1b[B");
  }

  /** Walk Up/Down through `expected` (newest first) from an empty editor and back to the empty draft. */
  async function navigate(expected: string[]) {
    await waitFor(() => editor().getText() === "", "empty editor");
    const before = [...editor().history];
    for (let i = 0; i < expected.length; i++) {
      await press("\x1b[A");
      equal(`${label}.up.${i}.text`, editor().getText(), expected[i]);
      check(`${label}.up.${i}.cursorStart`, cursorAtStart(), editor().getCursor());
    }
    for (let i = expected.length - 2; i >= 0; i--) {
      await downToNextEntry();
      equal(`${label}.down.${i}.text`, editor().getText(), expected[i]);
      check(`${label}.down.${i}.cursorEnd`, cursorAtEnd(), editor().getCursor());
    }
    await downToNextEntry();
    equal(`${label}.down.draft`, editor().getText(), "");
    equal(`${label}.navigation.rawHistoryUnchanged`, editor().history, before);
  }

  return {
    ctx,
    pi,
    label,
    editor,
    tui,
    display,
    press,
    type,
    submit,
    cursorAtStart,
    cursorAtEnd,
    searchView,
    searchMatches,
    openSearch,
    searchAndAccept,
    searchShows,
    checkSeed,
    checkAdapter,
    navigate,
  };
}

// ─── Scenario steps ────────────────────────────────────────────────────────────────────────────────

type Step = { reason: string; run: (t: TestContext) => Promise<void> };

const CTX_UP = fixtures.ctxExpected.upSequence;
const CTX_H = fixtures.ctxExpected.hChronological;
const resumeRecords = fixtures.resumeRecords;

function checkInventory(t: TestContext) {
  const commands = t.pi.getCommands();
  const skill = (name: string) => commands.filter((c) => c.name === `skill:${name}`);
  equal("inventory.alpha", skill("alpha").map((c) => [c.source, c.sourceInfo.path]), [["skill", fixtures.skills.alpha]]);
  equal("inventory.delta.discovered", skill("delta").map((c) => c.source), ["skill"]);
  equal("inventory.shadowed", skill("shadowed").map((c) => c.source).sort(), ["extension", "skill"]);
  equal("inventory.ghost", skill("ghost").length, 0);
}

function checkWorkingStatus(t: TestContext) {
  const editor = t.editor();
  equal(`${t.label}.embedWorkingStatus`, editor.embedWorkingStatus, true);
  editor.setWorkingStatusIndicator({ renderInBorder: () => "PIH-WORKING", renderSpinnerInBorder: () => "*" });
  const top = stripAnsi(editor.render(100)[0] ?? "");
  editor.setWorkingStatusIndicator(undefined);
  check(`${t.label}.workingStatusRendered`, top.includes("PIH-WORKING"), top);
}

async function startupChecks(t: TestContext) {
  checkInventory(t);
  t.checkAdapter(true);
  checkWorkingStatus(t);
  await t.checkSeed({ cache: "populated", h: CTX_H });
  check("startup.ctxEnvelopeOnlyFromContext", t.editor().history.includes(fixtures.ctxRecords.alpha));

  // S7: stock routing, cursor placement, configured history bindings.
  await t.navigate(CTX_UP.slice(0, 8));
  await t.press("\x10"); // ctrl+p: tui.editor.historyPrevious, which takes precedence over model cycling
  equal("startup.ctrlP.0", t.editor().getText(), CTX_UP[0]);
  await t.press("\x10");
  equal("startup.ctrlP.1", t.editor().getText(), CTX_UP[1]);
  await t.press("\x0e"); // ctrl+n: tui.editor.historyNext
  equal("startup.ctrlN.0", t.editor().getText(), CTX_UP[0]);
  await t.press("\x1b[B");
  equal("startup.ctrlN.draft", t.editor().getText(), "");

  // Draft restoration and undo.
  await t.type("draft text");
  await t.press("\x01"); // ctrl+a: line start, so Up browses history
  await t.press("\x1b[A");
  equal("startup.draft.recalled", t.editor().getText(), CTX_UP[0]);
  await t.press("\x1b[B");
  equal("startup.draft.restored", t.editor().getText(), "draft text");
  await t.press("\x1b[A");
  await t.press("\x1f"); // ctrl+-: undo
  equal("startup.draft.undo", t.editor().getText(), "draft text");
  t.ctx.ui.setEditorText("");

  // Live-typed shorthand is stored as typed and recalled unchanged.
  t.editor().addToHistory("/skill:alpha live typed");
  await t.press("\x1b[A");
  equal("startup.liveShorthand", t.editor().getText(), "/skill:alpha live typed");
  await t.press("\x1b[B");

  // S8: a synchronous onChange that adds history while an envelope is recalled loses and rewrites nothing.
  const editor = t.editor();
  editor.addToHistory(fixtures.ctxRecords.alpha);
  const before = [...editor.history];
  const onChange = editor.onChange;
  let added = false;
  editor.onChange = (text: string) => {
    if (!added) {
      added = true;
      editor.addToHistory("added during recall");
    }
    onChange?.(text);
  };
  await t.press("\x1b[A");
  editor.onChange = onChange;
  equal("startup.onChangeAdds.text", editor.getText(), "/skill:alpha ctx alpha args\nsecond line");
  equal("startup.onChangeAdds.history", editor.history, ["added during recall", ...before].slice(0, 100));
  t.ctx.ui.setEditorText("");

  // Tabs and carriage returns in a converted invocation's arguments show as Pi's editor holds text,
  // identically in reverse search (list, preview, accepted text) and in Up/Down.
  const whitespace = "/skill:alpha   lead    whitespace a    b\nc\nd";
  await t.searchAndAccept("whitespace.search", "whitespace", whitespace);
  t.ctx.ui.setEditorText("");
  for (const [id, record, shown] of [
    ["whitespace.up", fixtures.cacheRecords.whitespace, whitespace],
    ["whitespace.ordinaryPromptUpUnchanged", fixtures.cacheRecords.plainTabs, fixtures.cacheRecords.plainTabs],
  ] as const) {
    const steps = t.editor().history.indexOf(record) + 1;
    for (let i = 0; i < steps; i++) await t.press("\x1b[A");
    equal(id, t.editor().getText(), shown);
    t.ctx.ui.setEditorText("");
  }

  // S6/S5/S4: reverse search.
  await t.searchAndAccept("search.ctxAlpha", "ctx alpha", "/skill:alpha ctx alpha args\nsecond line");
  await t.searchAndAccept("search.collapse", "collapse me", "/skill:alpha collapse me", { occurrences: 1 });
  await t.searchAndAccept("search.discovered", "delta args", "/skill:delta delta args");
  await t.searchAndAccept("search.unicode", "审查 quoted", '/skill:code-review 审查 changes "quoted"\n  indented line');
  await t.searchShows("search.bodyNotSearchable", "zqxj", { total: 0 });
  await t.searchShows("search.rawFallbackSearchable", "ghost-body-marker", {
    includes: [fixtures.ctxRecords.ghost],
    excludes: ["/skill:ghost ghost args"],
  });
  await t.searchShows("search.shadowedRaw", "shadow args", {
    includes: [fixtures.ctxRecords.shadowed],
    excludes: ["/skill:shadowed shadow args"],
  });
  await t.searchShows("search.rawBodiesReplaced", "collapse me", {
    excludes: [fixtures.cacheRecords.alphaV1, fixtures.cacheRecords.alphaV2],
  });
  // S13: search keeps its first-text-block extraction; only the Up/Down seed joins text blocks.
  await t.searchShows("search.firstTextBlock", "multi", { includes: ["multi"], excludes: ["multi block prompt"] });
  check("search.collapsedBodiesKeepSlots", [fixtures.cacheRecords.alphaV1, fixtures.cacheRecords.alphaV2].every((r) => t.editor().history.includes(r)));

  for (const [key, cancel] of [["escape", "\x1b"], ["ctrlG", "\x07"]] as const) {
    t.ctx.ui.setEditorText("keep this draft");
    await t.openSearch();
    await t.type("ctx alpha");
    await t.press(cancel, () => !t.tui().hasOverlay(), key);
    equal(`search.cancel.${key}`, t.ctx.ui.getEditorText(), "keep this draft");
  }

  // S11: programmatic text assignment is not transformed.
  t.ctx.ui.setEditorText(fixtures.ctxRecords.alpha);
  equal("startup.programmaticSetText", t.ctx.ui.getEditorText(), fixtures.ctxRecords.alpha);
  t.ctx.ui.setEditorText("");
}

async function editorContract(t: TestContext) {
  const display = t.display;
  let conversions = 0;
  const counting = (raw: string) => {
    conversions++;
    return display(raw);
  };
  const history = [
    "oldest plain",
    fixtures.ctxRecords.alpha,
    fixtures.ctxRecords.alpha,
    "multi\nline\nplain",
    fixtures.ctxRecords.ghost,
    fixtures.cacheRecords.codeReview,
    fixtures.cacheRecords.whitespace,
    "/skill:alpha live typed",
    fixtures.ctxRecords.beta,
    fixtures.ctxRecords.delta,
    "newest plain",
  ];

  // Differential navigation (S7). Stock Up/Down routing depends on the shown text's lines, so the
  // oracle is a stock editor holding the display texts: the adapted editor (raw storage) must show the
  // same text with the same cursor and browsing index after every key, while its storage stays raw.
  const shown = stockEditor(history.map(display));
  const adapted = stockEditor(history);
  const rawSlots = [...adapted.history];
  equal("contract.install", installHistoryRecall(adapted, display, editorProto), "installed");
  const keys = [
    ...Array(12).fill("\x1b[A"),
    "\x1b[B",
    "\x1b[B",
    "\x10",
    "\x0e",
    ...Array(20).fill("\x1b[B"),
    ..."draft",
    "\x01",
    "\x1b[A",
    "\x1b[A",
    "\x1f",
    "\x1b[A",
    "\x1b[B",
    "\x1b[B",
    "\x1b[B",
  ];
  let mismatches = 0;
  keys.forEach((key, step) => {
    shown.handleInput(key);
    adapted.handleInput(key);
    shown.render(100);
    adapted.render(100);
    const ok =
      adapted.getText() === shown.getText() &&
      JSON.stringify(adapted.getCursor()) === JSON.stringify(shown.getCursor()) &&
      adapted.historyIndex === shown.historyIndex &&
      JSON.stringify(adapted.history) === JSON.stringify(rawSlots);
    if (!ok && mismatches++ < 3) {
      check(`contract.differential.step${step}`, false, {
        key,
        shown: { text: shown.getText(), index: shown.historyIndex, cursor: shown.getCursor() },
        adapted: { text: adapted.getText(), index: adapted.historyIndex, cursor: adapted.getCursor() },
      });
    }
  });
  check("contract.differential", mismatches === 0, { mismatches, steps: keys.length });
  check("contract.differential.visitedConverted", shown.history.includes("/skill:delta delta args"));

  // S14: the three stock setTextInternal callers.
  const editor = stockEditor(history);
  installHistoryRecall(editor, counting, editorProto);
  editor.setText(fixtures.ctxRecords.delta);
  equal("contract.publicSetText", [editor.getText(), conversions], [fixtures.ctxRecords.delta, 0]);
  while (editor.getCursor().line > 0) editor.handleInput("\x1b[A"); // Up moves within a multi-line draft
  editor.handleInput("\x01");
  editor.handleInput("\x1b[A");
  equal("contract.browsingRecall", [editor.getText(), conversions], ["newest plain", 1]);
  editor.handleInput("\x1b[A");
  equal("contract.browsingRecallConverts", [editor.getText(), conversions], ["/skill:delta delta args", 2]);
  editor.handleInput("\x1b[B");
  editor.handleInput("\x1b[B");
  equal("contract.savedDraftRestore", [editor.getText(), conversions], [fixtures.ctxRecords.delta, 3]);
  editor.setText("");
  editor.historyIndex = 0;
  editor.historyDraft = null;
  editor.handleInput("\x1b[B");
  equal("contract.emptyDraftRestore", [editor.getText(), editor.historyIndex, conversions], ["", -1, 3]);

  // S8: an onChange that adds history, or changes the text, during a converted recall behaves as stock.
  for (const [name, callback] of [
    ["addsHistory", (e: any) => e.addToHistory("added by onChange")],
    ["setsText", (e: any) => e.setText("changed by callback")],
  ] as const) {
    const pair = [stockEditor(history), stockEditor(history)];
    installHistoryRecall(pair[1], display, editorProto);
    for (const e of pair) {
      let calls = 0;
      e.onChange = () => {
        if (++calls === 2) callback(e); // during the second recall: the delta envelope
      };
      e.handleInput("\x1b[A");
      e.handleInput("\x1b[A");
    }
    const [s, a] = pair;
    equal(`contract.onChange.${name}.history`, a.history, s.history);
    equal(`contract.onChange.${name}.index`, a.historyIndex, s.historyIndex);
    check(`contract.onChange.${name}.rawKept`, rawSlots.every((raw) => a.history.includes(raw)));
    const expectedText = name === "setsText" ? "changed by callback" : "/skill:delta delta args";
    equal(`contract.onChange.${name}.text`, a.getText(), expectedText);
  }

  // S9: failures fall back to raw; unsupported instances are left unchanged.
  const throwing = stockEditor(history);
  installHistoryRecall(
    throwing,
    () => {
      throw new Error("resolver failed");
    },
    editorProto,
  );
  throwing.handleInput("\x1b[A");
  throwing.handleInput("\x1b[A");
  equal("contract.throwingDisplay", throwing.getText(), fixtures.ctxRecords.delta);
  const frozen = Object.freeze(stockEditor(history));
  equal("contract.frozen", [installHistoryRecall(frozen, display, editorProto), Object.hasOwn(frozen, "setTextInternal")], ["unsupported", false]);
  const nonString = stockEditor(history);
  nonString.history.push(42);
  equal("contract.nonStringSlot", [installHistoryRecall(nonString, display, editorProto), Object.hasOwn(nonString, "setTextInternal")], ["unsupported", false]);
  equal("contract.stacked", installHistoryRecall(adapted, display, editorProto), "already-installed");
  const custom: any = new CustomEditor(tuiStub as any, themeStub as any, (t.editor() as any).keybindings);
  custom[ORACLE] = true;
  equal("contract.customEditorInstall", installHistoryRecall(custom, display, editorProto), "installed");

  // SR-2: agreement with Pi's parseSkillBlock on unambiguous canonical records only.
  for (const [name, text] of Object.entries({
    ctxAlpha: fixtures.ctxRecords.alpha,
    beta: fixtures.ctxRecords.beta,
    delta: fixtures.ctxRecords.delta,
    alphaV1: fixtures.cacheRecords.alphaV1,
    codeReview: fixtures.cacheRecords.codeReview,
    epsilon: resumeRecords.epsilon,
  })) {
    const parsed = parseSkillBlock(text)!;
    const oracle = parsed.userMessage ? `/skill:${parsed.name} ${parsed.userMessage}` : `/skill:${parsed.name}`;
    equal(`contract.parseSkillBlock.${name}`, toRecallText(text, everythingLoaded), oracle);
  }
  check("contract.parseSkillBlock.misparsesAmbiguous", parseSkillBlock(fixtures.ctxRecords.ambiguous) !== null);
  equal("contract.ambiguousStaysRaw", toRecallText(fixtures.ctxRecords.ambiguous, everythingLoaded), fixtures.ctxRecords.ambiguous);
}

async function measureTransforms(t: TestContext) {
  const branch = activeContextHistory(t.ctx.sessionManager, sessionEntryToContextMessages)
    .map((text) => text.trim())
    .reverse();
  const cache = await loadRecentPrompts(t.ctx.cwd, 100);
  const open = (entries: string[]) => {
    const inventory = commandInventory(() => t.pi.getCommands());
    const seen = new Set<string>();
    for (const raw of [...entries, ...cache]) seen.add(toRecallText(raw, inventory));
    return seen.size;
  };
  const time = (fn: () => void, runs: number) => {
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      fn();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { first: samples.length === 1 ? samples[0] : undefined, median: samples[runs >> 1], p95: samples[Math.floor(runs * 0.95)] };
  };
  equal("timing.workload", [branch.length, cache.length], [1000, 100]);
  const cold = time(() => open(branch), 1);
  const results: Record<string, unknown> = { branchSize: branch.length, cacheSize: cache.length, coldOpenMs: cold.first };
  for (const size of [100, 1000]) results[`searchOpen${size}`] = time(() => open(branch.slice(0, size)), 25);

  const history = branch.slice(0, 100).reverse();
  const stepCost = (adapt: boolean) => {
    const editor = stockEditor(history);
    if (adapt) installHistoryRecall(editor, t.display, editorProto);
    return time(() => {
      for (let i = 0; i < 100; i++) editor.handleInput("\x1b[A");
      for (let i = 0; i < 100; i++) editor.handleInput("\x1b[B");
    }, 15);
  };
  results.stock200Steps = stepCost(false);
  results.adapted200Steps = stepCost(true);
  metric("timing.transforms", results);
  const open1000 = results.searchOpen1000 as { median: number };
  check("timing.searchOpen1000.bounded", open1000.median < 50, open1000);
}

async function finishStep(t: TestContext, expectedSubmissions: string[] = []) {
  equal(`${t.label}.submittedPrompts`, probeState.submitted, expectedSubmissions);
  finish(t.ctx);
}

const scenarios: Record<string, Step[]> = {
  startup: [
    {
      reason: "startup",
      run: async (t) => {
        await startupChecks(t);
        await finishStep(t);
      },
    },
  ],
  "startup-empty-cache": [
    {
      reason: "startup",
      run: async (t) => {
        t.checkAdapter(true);
        await t.checkSeed({ cache: "empty", h: CTX_H });
        await t.navigate(CTX_UP.slice(0, 3));
        await finishStep(t);
      },
    },
  ],
  lifecycle: lifecycleSteps("populated"),
  "lifecycle-empty-cache": lifecycleSteps("empty"),
  "cooperating-factory": [
    { reason: "startup", run: cooperatingChecks(true) },
    { reason: "reload", run: cooperatingChecks(false) },
  ],
  "unsupported-editor": [
    {
      reason: "startup",
      run: async (t) => {
        t.checkAdapter(false);
        equal("unsupported.lockedMethodKept", Object.getOwnPropertyDescriptor(t.editor(), "setTextInternal")?.writable, false);
        await t.checkSeed({ cache: "populated", h: CTX_H });
        await t.press("\x1b[A");
        await t.press("\x1b[A");
        equal("unsupported.upShowsRaw", t.editor().getText(), fixtures.ctxRecords.delta);
        t.ctx.ui.setEditorText("");
        await t.searchAndAccept("unsupported.searchCompact", "delta args", "/skill:delta delta args");

        // A later non-composing replacement: no stale adapter; Ctrl-R still works.
        const previous = t.editor();
        t.ctx.ui.setEditorText("/probe-replace");
        await t.press("\r", () => t.editor() !== previous && t.editor().getText() === "", "probe-replace");
        const replacement = t.editor();
        equal("replaced.noAdapter", Object.hasOwn(replacement, "setTextInternal"), false);
        replacement.addToHistory(fixtures.ctxRecords.alpha);
        await t.press("\x1b[A");
        equal("replaced.upShowsRaw", replacement.getText(), fixtures.ctxRecords.alpha);
        t.ctx.ui.setEditorText("");
        await t.searchAndAccept("replaced.searchCompact", "ctx alpha", "/skill:alpha ctx alpha args\nsecond line");
        await t.submit("/reload");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        t.checkAdapter(true);
        await t.checkSeed({ cache: "populated", h: CTX_H });
        await t.navigate(CTX_UP.slice(0, 3));
        await finishStep(t);
      },
    },
  ],
  "reused-editor": [
    {
      reason: "startup",
      run: async (t) => {
        t.checkAdapter(true);
        await t.checkSeed({ cache: "empty", h: CTX_H });
        t.editor().addToHistory(resumeRecords.epsilon);
        await t.press("\x1b[A");
        equal("reused.epsilonNotLoaded", t.editor().getText(), resumeRecords.epsilon);
        t.ctx.ui.setEditorText("");
        probeState.flags.epsilon = true;
        (probeState as any).reusedHistory = [...t.editor().history];
        await t.submit("/reload");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        const editor = t.editor();
        equal("reused.sameInstance", editor, (probeState as any).reused);
        t.checkAdapter(true);
        const before: string[] = (probeState as any).reusedHistory;
        const history: string[] = editor.history;
        check("reused.notReseeded", history.length <= before.length + 1, { before: before.length, after: history.length });
        equal("reused.historyKept", history.slice(history.length - before.length), before);
        const steps = history.indexOf(resumeRecords.epsilon) + 1;
        for (let i = 0; i < steps; i++) await t.press("\x1b[A");
        equal("reused.newInventory", editor.getText(), "/skill:epsilon epsilon args");
        await finishStep(t);
      },
    },
  ],
  "incompatible-editor": [
    {
      reason: "startup",
      run: async (t) => {
        equal("keepsBrowsing.editor", t.editor().pihIncompatible, "keeps-browsing");
        t.checkAdapter(false);
        await t.checkSeed({ cache: "populated", h: CTX_H });
        await t.press("\x1b[A");
        await t.press("\x1b[A");
        equal("keepsBrowsing.upShowsRaw", t.editor().getText(), fixtures.ctxRecords.delta);
        // Public assignment of the browsed slot's text while browsing: must stay as assigned.
        t.ctx.ui.setEditorText(fixtures.ctxRecords.delta);
        equal("keepsBrowsing.publicSetTextRaw", t.ctx.ui.getEditorText(), fixtures.ctxRecords.delta);
        t.ctx.ui.setEditorText("");
        await t.searchAndAccept("keepsBrowsing.searchCompact", "delta args", "/skill:delta delta args");
        await t.submit("/reload");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        equal("editsSlot.editor", t.editor().pihIncompatible, "edits-slot");
        t.checkAdapter(false);
        await t.checkSeed({ cache: "populated", h: CTX_H });
        const before = [...t.editor().history];
        await t.press("\x1b[A");
        await t.press("\x1b[A");
        equal("editsSlot.upShowsRaw", t.editor().getText(), fixtures.ctxRecords.delta);
        equal("editsSlot.historyUnchanged", t.editor().history, before);
        t.ctx.ui.setEditorText("");
        await t.searchAndAccept("editsSlot.searchCompact", "delta args", "/skill:delta delta args");
        await finishStep(t);
      },
    },
  ],
  "minimal-editor": [
    { reason: "startup", run: minimalEditorChecks(true) },
    { reason: "reload", run: minimalEditorChecks(false) },
  ],
  replay: [
    { reason: "startup", run: replayChecks },
    { reason: "reload", run: replayAfterReload },
  ],
  "editor-contract": [
    {
      reason: "startup",
      run: async (t) => {
        await editorContract(t);
        await finishStep(t);
      },
    },
  ],
  "session-writes": [
    {
      reason: "startup",
      run: async (t) => {
        await t.openSearch();
        await t.type("canonical");
        await t.press("\r", () => !t.tui().hasOverlay(), "enter");
        t.ctx.ui.setEditorText("");
        for (let i = 0; i < 3; i++) await t.press("\x1b[A");
        await finishStep(t);
      },
    },
  ],
  "transform-timing": [
    {
      reason: "startup",
      run: async (t) => {
        await measureTransforms(t);
        await finishStep(t);
      },
    },
  ],
};

function lifecycleSteps(cache: "populated" | "empty"): Step[] {
  const resumePath = cache === "populated" ? fixtures.sessions.workResume : fixtures.sessions.outsideResume;
  return [
    {
      reason: "startup",
      run: async (t) => {
        t.checkAdapter(true);
        await t.checkSeed({ cache, h: CTX_H });
        await t.submit("/new");
      },
    },
    {
      reason: "new",
      run: async (t) => {
        t.checkAdapter(true);
        await t.checkSeed({ cache, h: [] });
        if (cache === "empty") equal("new.emptyHistory", t.editor().history, []);
        await t.submit(`/probe-resume ${resumePath.path}`);
      },
    },
    {
      reason: "resume",
      run: async (t) => {
        t.checkAdapter(true);
        await t.checkSeed({ cache, h: [resumeRecords.first, resumeRecords.epsilon, resumeRecords.alpha, resumeRecords.latest] });
        await t.navigate([resumeRecords.latest, "/skill:alpha resume alpha", resumeRecords.epsilon]);
        // S11: /tree restores the selected prompt through public setText, untransformed.
        t.ctx.ui.setEditorText(`/probe-tree ${resumePath.ids.alpha}`);
        await t.press("\r", () => t.ctx.ui.getEditorText() === resumeRecords.alpha, "probe-tree");
        equal("tree.selectedTextRaw", t.ctx.ui.getEditorText(), resumeRecords.alpha);
        t.ctx.ui.setEditorText("");
        await t.submit(`/probe-fork ${resumePath.ids.alpha}`);
      },
    },
    {
      reason: "fork",
      run: async (t) => {
        t.checkAdapter(true);
        await waitFor(() => t.ctx.ui.getEditorText() === resumeRecords.alpha, "fork text");
        equal("fork.selectedTextRaw", t.ctx.ui.getEditorText(), resumeRecords.alpha);
        t.ctx.ui.setEditorText("");
        await t.checkSeed({ cache: "any", h: [resumeRecords.first, resumeRecords.epsilon] });
        await t.searchShows("fork.epsilonNotLoaded", "epsilon args", {
          includes: [resumeRecords.epsilon],
          excludes: ["/skill:epsilon epsilon args"],
        });
        probeState.flags.epsilon = true;
        await t.submit("/reload");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        t.checkAdapter(true);
        await t.checkSeed({ cache: "any", h: [resumeRecords.first, resumeRecords.epsilon] });
        await t.navigate(["/skill:epsilon epsilon args", resumeRecords.first]);
        await t.searchAndAccept("reload.epsilonLoaded", "epsilon args", "/skill:epsilon epsilon args");
        t.ctx.ui.setEditorText("");
        const slots = [...t.editor().history];
        equal("reload.reinstall", installHistoryRecall(t.editor(), t.display, editorProto), "already-installed");
        await t.searchShows("reload.searchAgain", "epsilon", { includes: ["/skill:epsilon epsilon args"] });
        equal("reload.noExtraSeedPass", t.editor().history, slots);
        await t.submit("/probe-reload-draft 0");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        equal("reloadDraft.shorthandVerbatim", t.ctx.ui.getEditorText(), fixtures.drafts[0]);
        t.checkAdapter(true);
        await t.checkSeed({ cache: "any", h: [resumeRecords.first, resumeRecords.epsilon] });
        await t.submit("/probe-reload-draft 1");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        equal("reloadDraft.editedEnvelopeVerbatim", t.ctx.ui.getEditorText(), fixtures.drafts[1]);
        await finishStep(t);
      },
    },
  ];
}

// ─── Replay: recall, edit, and resubmit through Pi's own expansion (local faux model, no network) ─

/** Text of the newest stored user message of the current session. */
function lastUserMessage(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries() as any[];
  const message = entries.filter((e) => e.type === "message" && e.message.role === "user").pop()?.message;
  if (!message) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}

function lastAssistantText(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries() as any[];
  const message = entries.filter((e) => e.type === "message" && e.message.role === "assistant").pop()?.message;
  return message?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
}

/** Press Enter to submit the editor's text and wait for Pi's agent run to finish. */
async function submitPrompt(t: TestContext) {
  const ends = probeState.agentEnds;
  await t.press("\r");
  await waitFor(() => probeState.agentEnds > ends && t.ctx.isIdle(), "agent run", 15000);
}

/** Move the cursor to the end of the (multi-line) editor text without leaving the entry. */
async function cursorToEnd(t: TestContext) {
  while (t.editor().getCursor().line < t.editor().getLines().length - 1) await t.press("\x1b[B");
  await t.press("\x05"); // ctrl+e: line end
}

/** Observe a status indicator embedded in the active editor's top border while `start` runs. */
async function observeStatus(t: TestContext, id: string, indicator: string, label: string, start: () => Promise<void>) {
  const seen: string[] = [];
  let found = false;
  const watching = (async () => {
    const deadline = performance.now() + 8000;
    while (!found && performance.now() < deadline) {
      const editor = t.editor();
      if (editor.workingStatusIndicator?.constructor?.name === indicator) {
        const top = stripAnsi(editor.render(120)[0] ?? "");
        seen.push(top);
        found = top.includes(label);
      }
      await sleep(20);
    }
  })();
  await start();
  await watching;
  check(`${id}.embedded`, found, { indicator, label, seen: seen.slice(-2) });
}

const SKILL_BODY = (name: string) => `Current ${name} instructions.`;

async function replayChecks(t: TestContext) {
  t.checkAdapter(true);
  await t.checkSeed({ cache: "any", h: [] });
  const records = fixtures.replayRecords;
  const submitted: string[] = [];
  const matrix = [
    { skill: "code-review", path: "search", query: "review the diff", args: "review the diff\nfocus on auth" },
    { skill: "code-review", path: "up", raw: records.codeReview, args: "review the diff\nfocus on auth" },
    { skill: "implement", path: "search", query: "build the feature", args: "build the feature\nwith tests" },
    { skill: "implement", path: "up", raw: records.implement, args: "build the feature\nwith tests", editBody: true },
  ] as const;
  for (const row of matrix) {
    const id = `replay.${row.skill}.${row.path}`;
    const shorthand = `/skill:${row.skill} ${row.args}`;
    let body = SKILL_BODY(row.skill);
    if ("editBody" in row) {
      // The skill file changes after loading: resubmission reads the current file.
      body = "Edited implement instructions after load.";
      writeFileSync(fixtures.skills.implement, `---\nname: implement\ndescription: Fixture skill implement.\n---\n\n${body}\n`);
    }
    if (row.path === "search") {
      await t.searchAndAccept(`${id}.recall`, row.query, shorthand);
    } else {
      const steps = t.editor().history.indexOf(row.raw) + 1;
      for (let i = 0; i < steps; i++) await t.press("\x1b[A");
      equal(`${id}.recall`, t.editor().getText(), shorthand);
      await cursorToEnd(t);
    }
    await t.press("\n"); // ctrl+j: new line
    await t.type("edited line");
    const edited = `${shorthand}\nedited line`;
    equal(`${id}.edited`, t.editor().getText(), edited);
    await submitPrompt(t);
    submitted.push(edited);
    const location = fixtures.skills[row.skill];
    equal(`${id}.expanded`, lastUserMessage(t.ctx), skillEnvelope(row.skill, location, body, `${row.args}\nedited line`));
  }

  // A loaded skill whose file is deleted, or no longer readable, still resolves by loaded identity;
  // resubmitting it fails expansion safely and sends the command text as typed.
  rmSync(fixtures.skills.beta);
  chmodSync(fixtures.skills.gamma, 0);
  for (const name of ["beta", "gamma"] as const) {
    const command = `/skill:${name} ${name} args`;
    await t.searchAndAccept(`replay.${name}.loadedIdentity`, `${name} args`, command);
    await submitPrompt(t);
    submitted.push(command);
    equal(`replay.${name}.replayFailsSafely`, lastUserMessage(t.ctx), command);
  }
  chmodSync(fixtures.skills.gamma, 0o644);
  check(
    "replay.historyStaysRaw",
    [records.codeReview, records.implement, records.beta, records.gamma].every((raw) => t.editor().history.includes(raw)),
  );

  // S11: the compaction indicator renders in the editor border.
  probeState.replies.push({ text: "Compacted summary.", delayMs: 2000 });
  t.ctx.ui.setEditorText("/compact");
  await observeStatus(t, "replay.compactionStatus", "CompactionStatusIndicator", "Compacting context", async () => {
    await t.press("\r");
    await waitFor(() => !t.editor().workingStatusIndicator, "compaction to finish", 15000);
  });
  check("replay.compacted", (t.ctx.sessionManager.getEntries() as any[]).some((e) => e.type === "compaction"));

  await t.searchShows("replay.deltaLoaded", "delta args", { includes: ["/skill:delta delta args"] });
  probeState.flags.deltaRemoved = true;
  (probeState as any).replaySubmitted = submitted;
  await t.submit("/reload");
}

async function replayAfterReload(t: TestContext) {
  t.checkAdapter(true);
  const raw = fixtures.replayRecords.delta;
  // A skill no longer loaded after /reload recalls raw.
  await t.searchShows("replay.deltaRemoved", "delta args", { includes: [raw], excludes: ["/skill:delta delta args"] });
  const steps = t.editor().history.indexOf(raw) + 1;
  for (let i = 0; i < steps; i++) await t.press("\x1b[A");
  equal("replay.deltaRemoved.up", t.editor().getText(), raw);
  t.ctx.ui.setEditorText("");

  // S11: the retry indicator renders in the replacement editor's border.
  probeState.replies.push({ error: "overloaded" }, { text: "ok after retry" });
  t.ctx.ui.setEditorText("retry check");
  await observeStatus(t, "replay.retryStatus", "RetryStatusIndicator", "Retrying (1/", () => submitPrompt(t));
  equal("replay.retried", lastAssistantText(t.ctx), "ok after retry");
  await finishStep(t, [...(probeState as any).replaySubmitted, "retry check"]);
}

function minimalEditorChecks(first: boolean) {
  return async (t: TestContext) => {
    const editor = t.editor();
    equal(`${t.label}.minimalEditor`, editor.pihMinimal, true);
    equal(`${t.label}.noHistoryIngress`, typeof editor.addToHistory, "undefined");
    t.checkAdapter(false);
    await t.type("typed");
    equal(`${t.label}.input`, editor.getText(), "typed");
    t.ctx.ui.setEditorText("");
    await t.searchAndAccept(`${t.label}.searchCompact`, "ctx alpha", "/skill:alpha ctx alpha args\nsecond line");
    probeState.flags.noop = false;
    t.ctx.ui.setEditorText("/probe-noop");
    await t.press("\r", () => probeState.flags.noop === true, "submit callback");
    equal(`${t.label}.submitCallback`, [probeState.flags.noop, editor.getText()], [true, ""]);
    if (first) await t.submit("/reload");
    else await finishStep(t);
  };
}

function cooperatingChecks(first: boolean) {
  return async (t: TestContext) => {
    const editor = t.editor();
    equal(`${t.label}.cooperatingEditor`, editor.pihCooperating, true);
    equal(`${t.label}.factoryChoiceKept`, editor.embedWorkingStatus, false);
    t.checkAdapter(true);
    await t.checkSeed({ cache: "populated", h: CTX_H, prefix: ["cooperating factory entry"] });
    await t.navigate(CTX_UP.slice(0, 2));
    if (first) await t.submit("/reload");
    else await finishStep(t);
  };
}

// ─── Lifecycle plumbing ────────────────────────────────────────────────────────────────────────────

let latestCtx: ExtensionContext | undefined;

function finish(ctx: ExtensionContext) {
  if (probeState.finished) return;
  probeState.finished = true;
  emit({ done: true, lifecycles: probeState.lifecycles });
  ctx.shutdown();
  setTimeout(() => process.exit(0), 3000).unref?.();
}

function finishNow() {
  if (latestCtx) finish(latestCtx);
  else process.exit(1);
}

/** A cooperating factory: a CustomEditor subclass that changes unrelated behavior and its own options. */
class CooperatingEditor extends CustomEditor {
  readonly pihCooperating = true;
  override render(width: number): string[] {
    return super.render(width);
  }
}

function cooperatingFactory(tui: any, theme: any, keybindings: any) {
  const editor = new CooperatingEditor(tui, theme, keybindings, { embedWorkingStatus: false });
  editor.addToHistory("cooperating factory entry");
  return editor;
}

/** Same members as the stock editor, different semantics: public setText keeps history browsing. */
class KeepsBrowsingEditor extends CustomEditor {
  readonly pihIncompatible = "keeps-browsing";
  override setText(text: string): void {
    (this as any).setTextInternal(text);
  }
}

/** Same members as the stock editor, different semantics: the browsed history slot is editable. */
class EditsSlotEditor extends CustomEditor {
  readonly pihIncompatible = "edits-slot";
}
Object.defineProperty(EditsSlotEditor.prototype, "setTextInternal", {
  configurable: true,
  writable: true,
  value(this: any, text: string, cursor?: "start" | "end") {
    if (this.historyIndex >= 0) this.history[this.historyIndex] = text;
    return editorProto.setTextInternal.call(this, text, cursor);
  },
});

/** A valid EditorComponent that is not a pi-tui Editor and has no addToHistory. */
class MinimalEditor {
  readonly pihMinimal = true;
  text = "";
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  onExtensionShortcut?: (data: string) => boolean;
  actionHandlers = new Map<string, () => void>();
  constructor(readonly tui: any) {}
  getText() {
    return this.text;
  }
  setText(text: string) {
    this.text = text;
    this.onChange?.(text);
  }
  handleInput(data: string) {
    if (this.onExtensionShortcut?.(data)) return;
    if (data === "\r") {
      const text = this.text;
      this.text = "";
      this.onSubmit?.(text);
    } else if (data === "\x7f") {
      this.setText(this.text.slice(0, -1));
    } else if (!data.startsWith("\x1b") && data >= " ") {
      this.setText(this.text + data);
    }
  }
  render(_width: number) {
    noteRender(this);
    return [`minimal> ${this.text}`];
  }
  invalidate() {}
}

function reusedFactory(tui: any, theme: any, keybindings: any) {
  return ((probeState as any).reused ??= new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true }));
}

function lockedFactory(tui: any, theme: any, keybindings: any) {
  const editor = new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
  Object.defineProperty(editor, "setTextInternal", { value: editorProto.setTextInternal, writable: false, configurable: false });
  return editor;
}

export default function probe(pi: ExtensionAPI) {
  const steps = scenarios[plan.scenario];
  if (!steps) throw new Error(`unknown scenario ${plan.scenario}`);

  pi.on("resources_discover", () => ({
    skillPaths: [
      ...(probeState.flags.deltaRemoved ? [] : [fixtures.skills.delta]),
      ...(probeState.flags.epsilon ? [fixtures.skills.epsilon] : []),
    ],
  }));
  // Only the replay scenario lets a prompt reach Pi's skill expansion, and then only its local faux model.
  pi.on("input", (event) => {
    probeState.submitted.push(event.text);
    return plan.scenario === "replay" ? { action: "continue" as const } : { action: "handled" as const };
  });
  pi.on("agent_end", () => {
    probeState.agentEnds++;
  });
  if (plan.scenario === "replay") {
    const faux = fauxProvider();
    const reply = async () => {
      const next = probeState.replies.shift() ?? { text: "ok" };
      if (next.delayMs) await sleep(next.delayMs);
      return next.error
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: next.error })
        : fauxAssistantMessage(next.text ?? "ok");
    };
    faux.setResponses(Array.from({ length: 200 }, () => reply));
    pi.registerProvider(faux.provider);
  }

  pi.registerCommand("skill:shadowed", { description: "Intercepts /skill:shadowed", handler: async () => {} });
  pi.registerCommand("probe-resume", { description: "probe", handler: async (args, ctx) => void (await ctx.switchSession(args.trim())) });
  pi.registerCommand("probe-fork", { description: "probe", handler: async (args, ctx) => void (await ctx.fork(args.trim())) });
  pi.registerCommand("probe-noop", {
    description: "probe",
    handler: async () => {
      probeState.flags.noop = true;
    },
  });
  pi.registerCommand("probe-tree", {
    description: "probe",
    handler: async (args, ctx) => void (await ctx.navigateTree(args.trim())),
  });
  pi.registerCommand("probe-reload-draft", {
    description: "probe",
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(fixtures.drafts[Number(args.trim())]!);
      await ctx.reload();
    },
  });
  pi.registerCommand("probe-replace", {
    description: "probe",
    handler: async (_args, ctx) => ctx.ui.setEditorComponent((tui, theme, kb) => new CustomEditor(tui, theme, kb)),
  });

  pi.on("session_start", (event, ctx) => {
    latestCtx = ctx;
    probeState.lifecycles.push(event.reason);
    probeState.activeAtStart = probeState.active;
    const startedAt = performance.now();
    ctx.ui.onTerminalInput(() => {
      probeState.inputs++;
      return undefined;
    });
    if (plan.scenario === "cooperating-factory") ctx.ui.setEditorComponent(cooperatingFactory);
    if (plan.scenario === "reused-editor") ctx.ui.setEditorComponent(reusedFactory);
    if (plan.scenario === "minimal-editor") ctx.ui.setEditorComponent((tui) => new MinimalEditor(tui) as any);
    if (plan.scenario === "incompatible-editor") {
      const Incompatible = event.reason === "startup" ? KeepsBrowsingEditor : EditsSlotEditor;
      ctx.ui.setEditorComponent((tui, theme, kb) => new Incompatible(tui, theme, kb, { embedWorkingStatus: true }));
    }
    if (plan.scenario === "unsupported-editor" && event.reason === "startup") ctx.ui.setEditorComponent(lockedFactory);

    const index = probeState.lifecycles.length - 1;
    const label = `${index}.${event.reason}`;
    setTimeout(async () => {
      try {
        const step = steps[index];
        if (!step) throw new Error(`unexpected session_start ${label}`);
        equal(`${label}.reason`, event.reason, step.reason);
        await settle(startedAt);
        await step.run(testContext(ctx, pi, label));
      } catch (error) {
        check(`${label}.error`, false, error instanceof Error ? error.stack : String(error));
        finish(ctx);
      }
    }, 0);
  });
}

/**
 * Wait until the lifecycle's editor is active and its history has stopped changing (Pi's own preload
 * is done). The editor is a new instance, except when the scenario's factory reuses one.
 */
async function settle(startedAt: number) {
  const deadline = performance.now() + 10000;
  while (true) {
    await sleep(25);
    const now = performance.now();
    const rendered = (probeState.renders[probeState.renders.length - 1]?.at ?? 0) > startedAt;
    const fresh = rendered && probeState.active !== undefined && (probeState.active !== probeState.activeAtStart || plan.scenario === "reused-editor");
    if (fresh && now - startedAt > 400 && now - probeState.settleKeyAt > 250) return;
    if (now > deadline) throw new Error("active editor did not settle");
  }
}
