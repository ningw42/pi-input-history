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

import { appendFileSync, readFileSync } from "node:fs";
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
import type { Fixtures } from "./fixtures.ts";

type Plan = { scenario: string; results: string; control: string; fixtures: Fixtures };
const plan: Plan = JSON.parse(readFileSync(process.env.PIH_PLAN!, "utf8"));
const F = plan.fixtures;

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
  failed: boolean;
  finished: boolean;
};

const g: ProbeState = ((globalThis as any).__pihProbe ??= {
  lifecycles: [],
  editorIds: new WeakMap(),
  nextEditorId: 1,
  settleKey: "",
  settleKeyAt: 0,
  renders: [],
  inputs: 0,
  submitted: [],
  flags: {},
  failed: false,
  finished: false,
});

const ORACLE = Symbol.for("pih.oracle-editor");
const HOOKED = Symbol.for("pih.render-hook");
const ADAPTER = Symbol.for("pi-input-history.history-recall-adapter");

function editorId(editor: object): number {
  let id = g.editorIds.get(editor);
  if (id === undefined) g.editorIds.set(editor, (id = g.nextEditorId++));
  return id;
}

// Track the editor the TUI actually renders: the active one. Oracle editors are marked and ignored.
const editorProto = Editor.prototype as any;
if (!editorProto[HOOKED]) {
  editorProto[HOOKED] = true;
  const render = editorProto.render;
  editorProto.render = function (this: any, width: number) {
    const lines = render.call(this, width);
    if (!this[ORACLE]) {
      g.active = this;
      const key = `${editorId(this)}:${this.history?.length}`;
      const at = performance.now();
      if (key !== g.settleKey) {
        g.settleKey = key;
        g.settleKeyAt = at;
      }
      g.renders.push({ at, text: this.getText() });
      if (g.renders.length > 200) g.renders.shift();
    }
    return lines;
  };
}

// ─── Results ───────────────────────────────────────────────────────────────────────────────────────

function emit(record: object) {
  appendFileSync(plan.results, `${JSON.stringify(record)}\n`);
}

function check(id: string, pass: boolean, detail?: unknown) {
  emit({ id, pass, ...(pass || detail === undefined ? {} : { detail }) });
  if (!pass) g.failed = true;
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

type T = ReturnType<typeof testContext>;

function testContext(ctx: ExtensionContext, pi: ExtensionAPI, label: string) {
  const editor = () => g.active;
  const tui = () => g.active.tui;
  const display = (raw: string) => toRecallText(raw, commandInventory(() => pi.getCommands()));

  async function press(sequence: string, until?: () => boolean, what = JSON.stringify(sequence)) {
    const before = g.inputs;
    appendFileSync(plan.control, `${JSON.stringify({ send: Buffer.from(sequence).toString("base64") })}\n`);
    await waitFor(() => g.inputs > before, `terminal input ${what}`);
    await sleep(15);
    if (until) await waitFor(until, `effect of ${what}`);
  }

  async function type(text: string) {
    for (const ch of text) await press(ch);
  }

  /** Submit a command line; used to trigger lifecycles. The current ctx is stale afterwards. */
  async function submit(line: string) {
    const expected = g.lifecycles.length + 1;
    ctx.ui.setEditorText(line);
    await press("\r");
    setTimeout(() => {
      if (!g.finished && g.lifecycles.length < expected) {
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
      await waitFor(() => g.renders.some((r) => r.at > acceptedAt && r.text === expected), "repaint", 2000).then(
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

type Step = { reason: string; run: (t: T) => Promise<void> };

const CTX_UP = F.ctxExpected.upSequence;
const CTX_H = F.ctxExpected.hChronological;
const R = F.resumeRecords;

function checkInventory(t: T) {
  const commands = t.pi.getCommands();
  const skill = (name: string) => commands.filter((c) => c.name === `skill:${name}`);
  equal("inventory.alpha", skill("alpha").map((c) => [c.source, c.sourceInfo.path]), [["skill", F.skills.alpha]]);
  equal("inventory.delta.discovered", skill("delta").map((c) => c.source), ["skill"]);
  equal("inventory.shadowed", skill("shadowed").map((c) => c.source).sort(), ["extension", "skill"]);
  equal("inventory.ghost", skill("ghost").length, 0);
}

function checkWorkingStatus(t: T) {
  const editor = t.editor();
  equal(`${t.label}.embedWorkingStatus`, editor.embedWorkingStatus, true);
  editor.setWorkingStatusIndicator({ renderInBorder: () => "PIH-WORKING", renderSpinnerInBorder: () => "*" });
  const top = stripAnsi(editor.render(100)[0] ?? "");
  editor.setWorkingStatusIndicator(undefined);
  check(`${t.label}.workingStatusRendered`, top.includes("PIH-WORKING"), top);
}

async function startupChecks(t: T) {
  checkInventory(t);
  t.checkAdapter(true);
  checkWorkingStatus(t);
  await t.checkSeed({ cache: "populated", h: CTX_H });
  check("startup.ctxEnvelopeOnlyFromContext", t.editor().history.includes(F.ctxRecords.alpha));

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
  editor.addToHistory(F.ctxRecords.alpha);
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

  // S6/S5/S4: reverse search.
  await t.searchAndAccept("search.ctxAlpha", "ctx alpha", "/skill:alpha ctx alpha args\nsecond line");
  await t.searchAndAccept("search.collapse", "collapse me", "/skill:alpha collapse me", { occurrences: 1 });
  await t.searchAndAccept("search.discovered", "delta args", "/skill:delta delta args");
  await t.searchAndAccept("search.unicode", "审查 quoted", '/skill:code-review 审查 changes "quoted"\n  indented line');
  await t.searchShows("search.bodyNotSearchable", "zqxj", { total: 0 });
  await t.searchShows("search.rawFallbackSearchable", "ghost-body-marker", {
    includes: [F.ctxRecords.ghost],
    excludes: ["/skill:ghost ghost args"],
  });
  await t.searchShows("search.shadowedRaw", "shadow args", {
    includes: [F.ctxRecords.shadowed],
    excludes: ["/skill:shadowed shadow args"],
  });
  await t.searchShows("search.rawBodiesReplaced", "collapse me", {
    excludes: [F.cacheRecords.alphaV1, F.cacheRecords.alphaV2],
  });
  // S13: search keeps its first-text-block extraction; only the Up/Down seed joins text blocks.
  await t.searchShows("search.firstTextBlock", "multi", { includes: ["multi"], excludes: ["multi block prompt"] });
  check("search.collapsedBodiesKeepSlots", [F.cacheRecords.alphaV1, F.cacheRecords.alphaV2].every((r) => t.editor().history.includes(r)));

  for (const [key, cancel] of [["escape", "\x1b"], ["ctrlG", "\x07"]] as const) {
    t.ctx.ui.setEditorText("keep this draft");
    await t.openSearch();
    await t.type("ctx alpha");
    await t.press(cancel, () => !t.tui().hasOverlay(), key);
    equal(`search.cancel.${key}`, t.ctx.ui.getEditorText(), "keep this draft");
  }

  // S11: programmatic text assignment is not transformed.
  t.ctx.ui.setEditorText(F.ctxRecords.alpha);
  equal("startup.programmaticSetText", t.ctx.ui.getEditorText(), F.ctxRecords.alpha);
  t.ctx.ui.setEditorText("");
}

async function editorContract(t: T) {
  const display = t.display;
  let conversions = 0;
  const counting = (raw: string) => {
    conversions++;
    return display(raw);
  };
  const history = [
    "oldest plain",
    F.ctxRecords.alpha,
    F.ctxRecords.alpha,
    "multi\nline\nplain",
    F.ctxRecords.ghost,
    F.cacheRecords.codeReview,
    "/skill:alpha live typed",
    F.ctxRecords.beta,
    F.ctxRecords.delta,
    "newest plain",
  ];

  // Differential navigation (S7). Stock Up/Down routing depends on the shown text's lines, so the
  // oracle is a stock editor holding the display texts: the adapted editor (raw storage) must show the
  // same text with the same cursor and browsing index after every key, while its storage stays raw.
  const shown = stockEditor(history.map(display));
  const adapted = stockEditor(history);
  const rawSlots = [...adapted.history];
  equal("contract.install", installHistoryRecall(adapted, display), "installed");
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
  installHistoryRecall(editor, counting);
  editor.setText(F.ctxRecords.delta);
  equal("contract.publicSetText", [editor.getText(), conversions], [F.ctxRecords.delta, 0]);
  while (editor.getCursor().line > 0) editor.handleInput("\x1b[A"); // Up moves within a multi-line draft
  editor.handleInput("\x01");
  editor.handleInput("\x1b[A");
  equal("contract.browsingRecall", [editor.getText(), conversions], ["newest plain", 1]);
  editor.handleInput("\x1b[A");
  equal("contract.browsingRecallConverts", [editor.getText(), conversions], ["/skill:delta delta args", 2]);
  editor.handleInput("\x1b[B");
  editor.handleInput("\x1b[B");
  equal("contract.savedDraftRestore", [editor.getText(), conversions], [F.ctxRecords.delta, 3]);
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
    installHistoryRecall(pair[1], display);
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
  installHistoryRecall(throwing, () => {
    throw new Error("resolver failed");
  });
  throwing.handleInput("\x1b[A");
  throwing.handleInput("\x1b[A");
  equal("contract.throwingDisplay", throwing.getText(), F.ctxRecords.delta);
  const frozen = Object.freeze(stockEditor(history));
  equal("contract.frozen", [installHistoryRecall(frozen, display), Object.hasOwn(frozen, "setTextInternal")], ["unsupported", false]);
  const nonString = stockEditor(history);
  nonString.history.push(42);
  equal("contract.nonStringSlot", [installHistoryRecall(nonString, display), Object.hasOwn(nonString, "setTextInternal")], ["unsupported", false]);
  equal("contract.stacked", installHistoryRecall(adapted, display), "already-installed");
  const custom: any = new CustomEditor(tuiStub as any, themeStub as any, (t.editor() as any).keybindings);
  custom[ORACLE] = true;
  equal("contract.customEditorInstall", installHistoryRecall(custom, display), "installed");

  // SR-2: agreement with Pi's parseSkillBlock on unambiguous canonical records only.
  for (const [name, text] of Object.entries({
    ctxAlpha: F.ctxRecords.alpha,
    beta: F.ctxRecords.beta,
    delta: F.ctxRecords.delta,
    alphaV1: F.cacheRecords.alphaV1,
    codeReview: F.cacheRecords.codeReview,
    epsilon: R.epsilon,
  })) {
    const parsed = parseSkillBlock(text)!;
    const oracle = parsed.userMessage ? `/skill:${parsed.name} ${parsed.userMessage}` : `/skill:${parsed.name}`;
    equal(`contract.parseSkillBlock.${name}`, toRecallText(text, everythingLoaded), oracle);
  }
  check("contract.parseSkillBlock.misparsesAmbiguous", parseSkillBlock(F.ctxRecords.ambiguous) !== null);
  equal("contract.ambiguousStaysRaw", toRecallText(F.ctxRecords.ambiguous, everythingLoaded), F.ctxRecords.ambiguous);
}

async function measureTransforms(t: T) {
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
  const cold = time(() => open(branch), 1);
  const results: Record<string, unknown> = { branchSize: branch.length, cacheSize: cache.length, coldOpenMs: cold.first };
  for (const size of [100, 1000]) results[`searchOpen${size}`] = time(() => open(branch.slice(0, size)), 25);

  const history = branch.slice(0, 100).reverse();
  const stepCost = (adapt: boolean) => {
    const editor = stockEditor(history);
    if (adapt) installHistoryRecall(editor, t.display);
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

async function finishStep(t: T) {
  equal(`${t.label}.noPromptSubmitted`, g.submitted, []);
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
        equal("unsupported.upShowsRaw", t.editor().getText(), F.ctxRecords.delta);
        t.ctx.ui.setEditorText("");
        await t.searchAndAccept("unsupported.searchCompact", "delta args", "/skill:delta delta args");

        // A later non-composing replacement: no stale adapter; Ctrl-R still works.
        const previous = t.editor();
        t.ctx.ui.setEditorText("/probe-replace");
        await t.press("\r", () => t.editor() !== previous && t.editor().getText() === "", "probe-replace");
        const replacement = t.editor();
        equal("replaced.noAdapter", Object.hasOwn(replacement, "setTextInternal"), false);
        replacement.addToHistory(F.ctxRecords.alpha);
        await t.press("\x1b[A");
        equal("replaced.upShowsRaw", replacement.getText(), F.ctxRecords.alpha);
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
        t.editor().addToHistory(R.epsilon);
        await t.press("\x1b[A");
        equal("reused.epsilonNotLoaded", t.editor().getText(), R.epsilon);
        t.ctx.ui.setEditorText("");
        g.flags.epsilon = true;
        (g as any).reusedHistory = [...t.editor().history];
        await t.submit("/reload");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        const editor = t.editor();
        equal("reused.sameInstance", editor, (g as any).reused);
        t.checkAdapter(true);
        const before: string[] = (g as any).reusedHistory;
        const history: string[] = editor.history;
        check("reused.notReseeded", history.length <= before.length + 1, { before: before.length, after: history.length });
        equal("reused.historyKept", history.slice(history.length - before.length), before);
        const steps = history.indexOf(R.epsilon) + 1;
        for (let i = 0; i < steps; i++) await t.press("\x1b[A");
        equal("reused.newInventory", editor.getText(), "/skill:epsilon epsilon args");
        await finishStep(t);
      },
    },
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
  "startup-timing": [
    {
      reason: "startup",
      run: async (t) => {
        metric("timing.startup", { sessionStart: (g as any).sessionStartAt, ready: g.settleKeyAt });
        finish(t.ctx);
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
  const resumePath = cache === "populated" ? F.sessions.workResume : F.sessions.outsideResume;
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
        await t.checkSeed({ cache, h: [R.first, R.epsilon, R.alpha, R.latest] });
        await t.navigate([R.latest, "/skill:alpha resume alpha", R.epsilon]);
        // S11: /tree restores the selected prompt through public setText, untransformed.
        t.ctx.ui.setEditorText(`/probe-tree ${resumePath.ids.alpha}`);
        await t.press("\r", () => t.ctx.ui.getEditorText() === R.alpha, "probe-tree");
        equal("tree.selectedTextRaw", t.ctx.ui.getEditorText(), R.alpha);
        t.ctx.ui.setEditorText("");
        await t.submit(`/probe-fork ${resumePath.ids.alpha}`);
      },
    },
    {
      reason: "fork",
      run: async (t) => {
        t.checkAdapter(true);
        await waitFor(() => t.ctx.ui.getEditorText() === R.alpha, "fork text");
        equal("fork.selectedTextRaw", t.ctx.ui.getEditorText(), R.alpha);
        t.ctx.ui.setEditorText("");
        await t.checkSeed({ cache: "any", h: [R.first, R.epsilon] });
        await t.searchShows("fork.epsilonNotLoaded", "epsilon args", {
          includes: [R.epsilon],
          excludes: ["/skill:epsilon epsilon args"],
        });
        g.flags.epsilon = true;
        await t.submit("/reload");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        t.checkAdapter(true);
        await t.checkSeed({ cache: "any", h: [R.first, R.epsilon] });
        await t.navigate(["/skill:epsilon epsilon args", R.first]);
        await t.searchAndAccept("reload.epsilonLoaded", "epsilon args", "/skill:epsilon epsilon args");
        t.ctx.ui.setEditorText("");
        const slots = [...t.editor().history];
        equal("reload.reinstall", installHistoryRecall(t.editor(), t.display), "already-installed");
        await t.searchShows("reload.searchAgain", "epsilon", { includes: ["/skill:epsilon epsilon args"] });
        equal("reload.noExtraSeedPass", t.editor().history, slots);
        await t.submit("/probe-reload-draft 0");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        equal("reloadDraft.shorthandVerbatim", t.ctx.ui.getEditorText(), F.drafts[0]);
        t.checkAdapter(true);
        await t.checkSeed({ cache: "any", h: [R.first, R.epsilon] });
        await t.submit("/probe-reload-draft 1");
      },
    },
    {
      reason: "reload",
      run: async (t) => {
        equal("reloadDraft.editedEnvelopeVerbatim", t.ctx.ui.getEditorText(), F.drafts[1]);
        await finishStep(t);
      },
    },
  ];
}

function cooperatingChecks(first: boolean) {
  return async (t: T) => {
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
  if (g.finished) return;
  g.finished = true;
  emit({ done: true, failed: g.failed, lifecycles: g.lifecycles });
  ctx.shutdown();
  setTimeout(() => process.exit(0), 3000).unref?.();
}

function finishNow() {
  if (latestCtx) finish(latestCtx);
  else process.exit(1);
}

function cooperatingFactory(tui: any, theme: any, keybindings: any) {
  const editor: any = new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: false });
  editor.pihCooperating = true;
  editor.addToHistory("cooperating factory entry");
  return editor;
}

function reusedFactory(tui: any, theme: any, keybindings: any) {
  return ((g as any).reused ??= new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true }));
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
    skillPaths: [F.skills.delta, ...(g.flags.epsilon ? [F.skills.epsilon] : [])],
  }));
  pi.on("input", (event) => {
    g.submitted.push(event.text);
    return { action: "handled" as const };
  });

  pi.registerCommand("skill:shadowed", { description: "Intercepts /skill:shadowed", handler: async () => {} });
  pi.registerCommand("probe-resume", { description: "probe", handler: async (args, ctx) => void (await ctx.switchSession(args.trim())) });
  pi.registerCommand("probe-fork", { description: "probe", handler: async (args, ctx) => void (await ctx.fork(args.trim())) });
  pi.registerCommand("probe-tree", {
    description: "probe",
    handler: async (args, ctx) => void (await ctx.navigateTree(args.trim())),
  });
  pi.registerCommand("probe-reload-draft", {
    description: "probe",
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(F.drafts[Number(args.trim())]!);
      await ctx.reload();
    },
  });
  pi.registerCommand("probe-replace", {
    description: "probe",
    handler: async (_args, ctx) => ctx.ui.setEditorComponent((tui, theme, kb) => new CustomEditor(tui, theme, kb)),
  });

  pi.on("session_start", (event, ctx) => {
    latestCtx = ctx;
    g.lifecycles.push(event.reason);
    (g as any).sessionStartAt ??= performance.now();
    g.activeAtStart = g.active;
    const startedAt = performance.now();
    ctx.ui.onTerminalInput(() => {
      g.inputs++;
      return undefined;
    });
    if (plan.scenario === "cooperating-factory") ctx.ui.setEditorComponent(cooperatingFactory);
    if (plan.scenario === "reused-editor") ctx.ui.setEditorComponent(reusedFactory);
    if (plan.scenario === "unsupported-editor" && event.reason === "startup") ctx.ui.setEditorComponent(lockedFactory);

    const index = g.lifecycles.length - 1;
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
    const rendered = (g.renders[g.renders.length - 1]?.at ?? 0) > startedAt;
    const fresh = rendered && g.active !== undefined && (g.active !== g.activeAtStart || plan.scenario === "reused-editor");
    if (fresh && now - startedAt > 400 && now - g.settleKeyAt > 250) return;
    if (now > deadline) throw new Error("active editor did not settle");
  }
}
