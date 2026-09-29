/**
 * Timing probe for the Pi integration driver. Loaded instead of probe.ts for startup and search timing,
 * in both the 1.1.3 arm and the feature arm. Until its measurement is taken it imports nothing from
 * this repository — only node built-ins and Pi's own pi-tui — so neither arm pays for the other's code.
 *
 * Startup endpoint ("startup complete"): Pi has preloaded the resumed session's last prompt into the
 * active editor (its native preload runs after session_start and resource discovery), and the terminal
 * has then been quiet for QUIET_MS; the endpoint is the last terminal write before that quiet period.
 * Times are performance.now(), measured from process start.
 *
 * Startup work checks: the recall module's opt-in counters (installed here, before any extension loads)
 * must show no recall and no inventory read before the endpoint. After measuring, each trial checks it
 * resumed the intended session, that the session's projected prompts are exactly the planned H, and that
 * the active editor received exactly the cache (C, oldest first) and then H.
 */

import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";

type TimingPlan = {
  kind: "startup" | "search";
  arm: "baseline" | "feature";
  /** The session file Pi was told to resume. */
  sessionPath: string;
  /** The resumed session's prompts, oldest first: Pi's native preload (H). */
  h: string[];
  cacheSize: number;
  discoverDelayMs?: number;
  query?: string;
  hugeRecord?: string;
};
type Plan = { scenario: string; results: string; control: string; timing: TimingPlan };

const plan: Plan = JSON.parse(readFileSync(process.env.PIH_PLAN!, "utf8"));
const QUIET_MS = 400;
const STATE = Symbol.for("pih.timing-probe");

const state: {
  lastWriteAt: number;
  preloadAt?: number;
  active?: any;
  ingress: Map<object, string[]>;
  browsingRecalls: number;
  inputs: number;
  started: boolean;
} = ((globalThis as any)[STATE] ??= { lastWriteAt: 0, ingress: new Map(), browsingRecalls: 0, inputs: 0, started: false });

/** The recall module counts into this object while it is installed (src/skill-recall.ts). */
const recallCounters = { normalizations: 0, inventoryReads: 0 };
(globalThis as any)[Symbol.for("pi-input-history.recall-counters")] = recallCounters;

const write = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (...args: unknown[]) => {
  state.lastWriteAt = performance.now();
  return (write as (...a: unknown[]) => boolean)(...args);
};

const proto = Editor.prototype as any;
const lastPreload = plan.timing.h[plan.timing.h.length - 1];
for (const [name, observe] of [
  [
    "addToHistory",
    (editor: any, text: string) => {
      if (!state.ingress.has(editor)) state.ingress.set(editor, []);
      state.ingress.get(editor)!.push(text);
      if (text === lastPreload) state.preloadAt = performance.now();
    },
  ],
  [
    "setTextInternal",
    (editor: any) => {
      if (editor.historyIndex >= 0) state.browsingRecalls++;
    },
  ],
  ["render", (editor: any) => (state.active = editor)],
] as const) {
  const original = proto[name];
  proto[name] = function (this: unknown, ...args: unknown[]) {
    (observe as (editor: unknown, ...rest: unknown[]) => void)(this, ...args);
    return original.apply(this, args);
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (record: object) => appendFileSync(plan.results, `${JSON.stringify(record)}\n`);
const check = (id: string, pass: boolean, detail?: unknown) => emit({ id, pass, ...(pass ? {} : { detail }) });

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

async function press(sequence: string) {
  const before = state.inputs;
  appendFileSync(plan.control, `${JSON.stringify({ send: Buffer.from(sequence).toString("base64") })}\n`);
  await waitFor(() => state.inputs > before, `terminal input ${JSON.stringify(sequence)}`);
  await sleep(15);
}

async function measureStartup(sessionStartAt: number) {
  await waitFor(
    () =>
      state.preloadAt !== undefined &&
      state.lastWriteAt >= state.preloadAt &&
      performance.now() - state.lastWriteAt >= QUIET_MS,
    "native preload and a quiet terminal",
  );
  const endpoint = state.lastWriteAt;
  emit({
    id: "timing.startup",
    metric: { start: 0, end: endpoint, sessionStartAt, preloadAt: state.preloadAt },
  });
  const work = { ...recallCounters, browsingRecalls: state.browsingRecalls, inputs: state.inputs };
  check("startup.noRecallWork", Object.values(work).every((count) => count === 0), work);
}

/** After the measurement: the workload was the intended one. */
async function checkSeed(ctx: ExtensionContext) {
  const { resolve } = await import("node:path");
  const { sessionEntryToContextMessages } = await import("@earendil-works/pi-coding-agent");
  const { activeContextHistory } = await import("../../src/context-history.ts");
  const { loadRecentPrompts } = await import("../../index.ts");

  check("seed.session", resolve(ctx.sessionManager.getSessionFile() ?? "") === resolve(plan.timing.sessionPath), {
    actual: ctx.sessionManager.getSessionFile(),
  });
  const h = activeContextHistory(ctx.sessionManager, sessionEntryToContextMessages);
  check("seed.completeH", h.length === plan.timing.h.length && h.every((text, i) => text === plan.timing.h[i]), {
    actual: h.length,
    planned: plan.timing.h.length,
  });
  const cache = await loadRecentPrompts(ctx.cwd, 100);
  check("seed.cacheSize", cache.length === plan.timing.cacheSize, cache.length);
  const expected = [...[...cache].reverse(), ...plan.timing.h];
  const ingress = state.ingress.get(state.active) ?? [];
  check("seed.ingress", ingress.length === expected.length && ingress.every((text, i) => text === expected[i]), {
    actual: ingress.length,
    expected: expected.length,
  });
  const oracle: any = new Editor({ requestRender() {}, terminal: { rows: 40, columns: 120 } } as any, {
    borderColor: (s: string) => s,
    selectList: {} as any,
  });
  for (const text of expected) oracle.addToHistory(text);
  check("seed.slots", JSON.stringify(state.active?.history) === JSON.stringify(oracle.history), {
    active: state.active?.history?.length,
    expected: oracle.history.length,
  });
}

/** Per-keystroke reverse-search cost: the overlay's own handleInput + render, in process. */
async function measureSearch() {
  await press("\x12");
  const tui = state.active.tui;
  await waitFor(() => tui.hasOverlay(), "reverse-search overlay");
  const stack = tui.overlayStack as { component: any }[];
  const component = stack[stack.length - 1]!.component;
  const items: string[] = component.history;
  // Positive control for the startup counters: opening a search is recall work in the feature arm only.
  const counted = recallCounters.normalizations >= items.length && recallCounters.inventoryReads >= 1;
  const none = recallCounters.normalizations === 0 && recallCounters.inventoryReads === 0;
  check("search.recallCounted", plan.timing.arm === "feature" ? counted : none, { ...recallCounters, items: items.length });
  const huge = plan.timing.hugeRecord!;
  const expected = plan.timing.arm === "baseline" ? huge : "/skill:alpha huge args";
  check("search.workload", items[0] === expected && (plan.timing.arm === "feature" || items[0]!.length > 300_000), {
    first: items[0]?.slice(0, 60),
    length: items[0]?.length,
  });
  const samples: number[] = [];
  const query = plan.timing.query!;
  for (let round = 0; round < 6; round++) {
    for (const ch of query) {
      const start = performance.now();
      component.handleInput(ch);
      component.render(120);
      samples.push(performance.now() - start);
    }
    for (let i = 0; i < query.length; i++) component.handleInput("\x7f");
  }
  component.handleInput("\x07");
  const sorted = samples.slice(samples.length / 6).sort((a, b) => a - b); // first round warms up
  emit({
    id: "timing.search",
    metric: { n: sorted.length, median: sorted[sorted.length >> 1], p95: sorted[Math.floor(sorted.length * 0.95)] },
  });
}

export default function timingProbe(pi: ExtensionAPI) {
  pi.on("resources_discover", async () => {
    if (plan.timing.discoverDelayMs) await sleep(plan.timing.discoverDelayMs);
    return {};
  });
  pi.on("session_start", (_event, ctx) => {
    if (state.started) return;
    state.started = true;
    const sessionStartAt = performance.now();
    ctx.ui.onTerminalInput(() => {
      state.inputs++;
      return undefined;
    });
    setTimeout(async () => {
      try {
        await measureStartup(sessionStartAt);
        await checkSeed(ctx);
        if (plan.timing.kind === "search") await measureSearch();
      } catch (error) {
        check("timing.error", false, error instanceof Error ? error.stack : String(error));
      }
      emit({ done: true });
      ctx.shutdown();
      setTimeout(() => process.exit(0), 3000).unref?.();
    }, 0);
  });
}
