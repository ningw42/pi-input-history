/**
 * Synthetic, redacted fixtures for the Pi integration driver: skill files, session files, and the
 * display text each recalled record is expected to have. Everything is written under one disposable root.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { skillEnvelope as envelope } from "../support/skill-envelope.ts";

export const SKILL_NAMES = ["alpha", "beta", "code-review", "implement", "gamma", "shadowed", "delta", "epsilon"] as const;
/** Skills loaded explicitly on the command line; delta and epsilon come from the probe's resources_discover. */
export const CLI_SKILLS = ["alpha", "beta", "code-review", "implement", "gamma", "shadowed"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];


type Content = string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];

/** Writes a version-3 session file entry by entry. */
class SessionFile {
  private lines: object[] = [];
  private parentId: string | null = null;
  private seq = 0;
  readonly ids: Record<string, string> = {};

  constructor(
    private readonly prefix: string,
    cwd: string,
    private clock: number,
    version = 3,
  ) {
    this.lines.push({ type: "session", version, id: `${prefix}-session`, timestamp: this.iso(), cwd });
    // Real sessions record it; without one, Pi appends it when the session is resumed.
    this.entry({ type: "thinking_level_change", thinkingLevel: "off" });
  }

  private iso(): string {
    return new Date(this.clock).toISOString();
  }

  private entry(fields: object, label?: string): string {
    this.clock += 1000;
    const id = `${this.prefix}${String(++this.seq).padStart(4, "0")}`;
    this.lines.push({ id, parentId: this.parentId, timestamp: this.iso(), ...fields });
    this.parentId = id;
    if (label) this.ids[label] = id;
    return id;
  }

  user(content: Content, label?: string): string {
    return this.entry({ type: "message", message: { role: "user", content, timestamp: this.clock + 1000 } }, label);
  }

  assistant(text: string): string {
    return this.entry({
      type: "message",
      message: { ...assistantFields(), content: [{ type: "text", text }], stopReason: "stop", timestamp: this.clock + 1000 },
    });
  }

  exchange(content: Content, label?: string): string {
    const id = this.user(content, label);
    this.assistant("ok");
    return id;
  }

  /** A prompt answered through one tool call whose result is `output`: where a real session's bytes are. */
  toolExchange(content: Content, output: string): string {
    const id = this.user(content);
    const callId = `call-${this.seq}`;
    this.entry({
      type: "message",
      message: {
        ...assistantFields(),
        content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "cat data.txt" } }],
        stopReason: "toolUse",
        timestamp: this.clock + 1000,
      },
    });
    this.entry({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "bash",
        content: [{ type: "text", text: output }],
        isError: false,
        timestamp: this.clock + 1000,
      },
    });
    this.assistant("ok");
    return id;
  }

  compaction(firstKeptEntryId: string): string {
    return this.entry({ type: "compaction", summary: "Earlier work was summarized.", firstKeptEntryId, tokensBefore: 1234 });
  }

  customMessage(content: string): string {
    return this.entry({ type: "custom_message", customType: "fixture-note", content, display: true });
  }

  write(path: string, options: { trailingNewline?: boolean } = {}): string {
    mkdirSync(dirname(path), { recursive: true });
    const text = this.lines.map((line) => JSON.stringify(line)).join("\n");
    writeFileSync(path, options.trailingNewline === false ? text : `${text}\n`);
    return path;
  }
}

function assistantFields() {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/**
 * The large startup corpus: synthetic sessions at roughly the volume of the research's `copilotd`
 * corpus (714 files, 664 MB), where session scanning dominates startup. Most bytes are tool output.
 */
export const LARGE_CORPUS = { sessions: 700, promptsPerSession: 10, toolOutputBytes: 85_000 };

/** Pi's session directory for a cwd (session-manager.ts getDefaultSessionDirPath). */
export function sessionDirFor(agentDir: string, cwd: string): string {
  return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

export type Fixtures = ReturnType<typeof buildFixtures>;

export function buildFixtures(root: string, options: { bigCorpus?: boolean } = {}) {
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const work = join(root, "work");
  const empty = join(root, "empty");
  const writes = join(root, "writes");
  const outside = join(root, "outside");
  const replay = join(root, "replay");
  const big = join(root, "big");
  for (const dir of [agentDir, home, work, empty, writes, outside, replay, big]) mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      quietStartup: true,
      enableSkillCommands: false,
      lastChangelogVersion: "0.87.1",
      // Only the replay scenario's local faux model can fail; a short backoff keeps its retry observable.
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1500 },
      // Lets the replay scenario compact its small session.
      compaction: { keepRecentTokens: 10 },
    }),
  );
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(
    join(agentDir, "keybindings.json"),
    JSON.stringify({ "tui.editor.historyPrevious": "ctrl+p", "tui.editor.historyNext": "ctrl+n" }),
  );

  const skills = {} as Record<SkillName, string>;
  for (const name of SKILL_NAMES) {
    const path = join(root, "skills", name, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: Fixture skill ${name}.\n---\n\nCurrent ${name} instructions.\n`);
    skills[name] = path;
  }

  const env = (name: SkillName, body: string, args?: string) => envelope(name, skills[name], body, args);

  // ── Records of the resumed context session ("H"), oldest first, with their expected recall text ──
  const ctxRecords = {
    compactedAway: "compacted away prompt",
    plain: "plain kept prompt",
    multiBlockParts: ["multi ", "block prompt"],
    alpha: env("alpha", "Historical alpha body zqxj-marker.", "ctx alpha args\nsecond line"),
    ghost: envelope("ghost", join(root, "skills", "ghost", "SKILL.md"), "Ghost body ghost-body-marker.", "ghost args"),
    shadowed: env("shadowed", "Shadowed body.", "shadow args"),
    beta: env("beta", "Beta body zqxj-marker."),
    ambiguous: env("code-review", "Example:\n</skill>\n\nnot the arguments", "review args"),
    mismatch: envelope("alpha", join(root, "elsewhere", "alpha", "SKILL.md"), "Moved alpha body.", "mismatch args"),
    delta: env("delta", "Delta body zqxj-marker.", "delta args"),
    latest: "latest plain prompt",
  };
  const ctxExpected = {
    /** H newest first, as displayed by Up from an empty editor. */
    upSequence: [
      "latest plain prompt",
      "/skill:delta delta args",
      ctxRecords.mismatch,
      ctxRecords.ambiguous,
      "/skill:beta",
      ctxRecords.shadowed,
      ctxRecords.ghost,
      "/skill:alpha ctx alpha args\nsecond line",
      "multi block prompt",
      "plain kept prompt",
    ],
    hChronological: [
      "plain kept prompt",
      "multi block prompt",
      ctxRecords.alpha,
      ctxRecords.ghost,
      ctxRecords.shadowed,
      ctxRecords.beta,
      ctxRecords.ambiguous,
      ctxRecords.mismatch,
      ctxRecords.delta,
      "latest plain prompt",
    ],
  };

  function writeContextSession(path: string, cwd: string, clock: number): { path: string; ids: Record<string, string> } {
    const s = new SessionFile("ctx", cwd, clock);
    s.exchange(ctxRecords.compactedAway, "compactedAway");
    const firstKept = s.exchange(ctxRecords.plain, "plain");
    s.customMessage("A custom message the model saw.");
    s.exchange(
      [
        { type: "text", text: ctxRecords.multiBlockParts[0]! },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        { type: "text", text: ctxRecords.multiBlockParts[1]! },
      ],
      "multiBlock",
    );
    s.compaction(firstKept);
    for (const key of ["alpha", "ghost", "shadowed", "beta", "ambiguous", "mismatch", "delta", "latest"] as const) {
      s.exchange(ctxRecords[key], key);
    }
    return { path: s.write(path), ids: s.ids };
  }

  // ── A second session to resume and fork ──
  const resumeRecords = {
    first: "resume plain first",
    epsilon: env("epsilon", "Epsilon body.", "epsilon args"),
    alpha: env("alpha", "Resume alpha body.", "resume alpha"),
    latest: "resume latest",
  };
  function writeResumeSession(path: string, cwd: string, clock: number) {
    const s = new SessionFile("res", cwd, clock);
    for (const key of ["first", "epsilon", "alpha", "latest"] as const) s.exchange(resumeRecords[key], key);
    return { path: s.write(path), ids: s.ids };
  }

  // ── Cross-session cache ("C") sessions for `work`: newer than the context session ──
  const cacheRecords = {
    alphaV1: env("alpha", "Alpha body v1 zqxj-marker.", "collapse me"),
    alphaV2: env("alpha", "Alpha body v2 zqxj-marker.", "collapse me"),
    codeReview: env("code-review", "Review body.", '审查 changes "quoted"\n  indented line'),
    whitespace: env("alpha", "Whitespace body.", "  lead\twhitespace a\tb\r\nc\rd"),
    plainTabs: "plain\ttab prompt\r\nsecond",
  };
  const JAN = Date.parse("2026-01-01T00:00:00Z");
  const workSessions = sessionDirFor(agentDir, work);
  const recentA = new SessionFile("reca", work, JAN + 30 * 86_400_000);
  recentA.exchange(cacheRecords.alphaV1);
  recentA.exchange("cache between variants");
  recentA.exchange(cacheRecords.alphaV2);
  recentA.exchange(cacheRecords.codeReview);
  recentA.exchange(cacheRecords.plainTabs);
  recentA.exchange(cacheRecords.whitespace);
  recentA.write(join(workSessions, "2026-01-31_reca.jsonl"));
  const recentB = new SessionFile("recb", work, JAN + 20 * 86_400_000);
  for (let i = 1; i <= 110; i++) recentB.exchange(`cache prompt ${String(i).padStart(3, "0")}`);
  recentB.write(join(workSessions, "2026-01-21_recb.jsonl"));

  const workContext = writeContextSession(join(workSessions, "2026-01-05_ctx.jsonl"), work, JAN + 4 * 86_400_000);
  const workResume = writeResumeSession(join(workSessions, "2026-01-02_res.jsonl"), work, JAN + 86_400_000);

  // ── Sessions outside any cwd's session directory: resumable, but never part of a cache ──
  const outsideContext = writeContextSession(join(outside, "ctx.jsonl"), empty, JAN + 4 * 86_400_000);
  const outsideResume = writeResumeSession(join(outside, "res.jsonl"), empty, JAN + 86_400_000);

  // ── A large current branch for timing Ctrl-R work beyond the 100-entry cache ──
  const large = new SessionFile("big", work, JAN);
  for (let i = 0; i < 1000; i++) {
    large.exchange(i % 5 === 0 ? env("alpha", `Large body ${i}.`, `large ${i}`) : `large plain prompt ${i}`);
  }
  const largeSession = large.write(join(outside, "large.jsonl"));

  // ── Search timing: the current branch ends with a ~300 KB envelope ──
  const hugeRecord = env("alpha", `${"Huge body line.\n".repeat(20_000)}End.`, "huge args");
  const search = new SessionFile("srch", work, JAN);
  for (let i = 0; i < 40; i++) search.exchange(`search plain prompt ${i}`);
  search.exchange(hugeRecord);
  const searchSession = search.write(join(outside, "search.jsonl"));

  // ── Replay: historical invocations in the cache of cwd `replay`, recalled and resubmitted ──
  const replayRecords = {
    codeReview: env("code-review", "Historical review body.", "review the diff\nfocus on auth"),
    implement: env("implement", "Historical implement body.", "build the feature\nwith tests"),
    beta: env("beta", "Historical beta body.", "beta args"),
    gamma: env("gamma", "Historical gamma body.", "gamma args"),
    delta: env("delta", "Historical delta body.", "delta args"),
  };
  const replayCache = new SessionFile("rpl", replay, JAN + 10 * 86_400_000);
  for (const record of Object.values(replayRecords)) {
    replayCache.exchange(record);
    replayCache.exchange("replay plain prompt");
  }
  replayCache.write(join(sessionDirFor(agentDir, replay), "2026-01-11_rpl.jsonl"));

  // ── Startup timing on a large cwd (LARGE_CORPUS), then a resumed 300-prompt skill session ──
  const bigContextH: string[] = [];
  let bigContextPath: string | undefined;
  if (options.bigCorpus) {
    const bigSessions = sessionDirFor(agentDir, big);
    let output = "";
    for (let line = 0; output.length < LARGE_CORPUS.toolOutputBytes; line++) {
      output += `synthetic tool output line ${String(line).padStart(5, "0")}: build step completed without findings\n`;
    }
    for (let n = 0; n < LARGE_CORPUS.sessions; n++) {
      const session = new SessionFile(`b${n}`, big, JAN + (n + 10) * 3_600_000);
      for (let i = 0; i < LARGE_CORPUS.promptsPerSession; i++) {
        const text = i % 7 === 0 ? env("alpha", `Corpus body ${n}-${i}.`, `corpus ${n}-${i}`) : `corpus prompt ${n}-${i}`;
        session.toolExchange(i % 11 === 0 ? [{ type: "text", text }, { type: "text", text: " (two blocks)" }] : text, output);
      }
      session.write(join(bigSessions, `b${String(n).padStart(3, "0")}.jsonl`));
    }
    const context = new SessionFile("bctx", big, JAN);
    for (let i = 0; i < 300; i++) {
      const text = i % 10 === 0 ? env("code-review", `Big context body ${i}.`, `big context ${i}`) : `big context prompt ${i}`;
      context.exchange(text);
      bigContextH.push(text);
    }
    bigContextPath = context.write(join(bigSessions, "bctx.jsonl"));
  }

  // ── Sessions that Pi's loader repairs or migrates when opened ──
  const writesSessions = sessionDirFor(agentDir, writes);
  const canonical = new SessionFile("can", writes, JAN + 3 * 86_400_000);
  canonical.exchange("canonical prompt");
  canonical.exchange(env("alpha", "Canonical alpha body.", "canonical args"));
  const repair = new SessionFile("rep", writes, JAN + 2 * 86_400_000);
  repair.exchange("repair prompt");
  const migrate = new SessionFile("mig", writes, JAN + 86_400_000, 2);
  migrate.exchange("migrate prompt");
  const writesFiles = {
    canonical: canonical.write(join(writesSessions, "canonical.jsonl")),
    repair: repair.write(join(writesSessions, "repair.jsonl"), { trailingNewline: false }),
    migrate: migrate.write(join(writesSessions, "migrate.jsonl")),
  };

  return {
    root,
    agentDir,
    home,
    cwd: { work, empty, writes, replay, big },
    skills,
    ctxRecords,
    ctxExpected,
    resumeRecords,
    cacheRecords,
    sessions: { workContext, workResume, outsideContext, outsideResume, largeSession, searchSession, writesFiles },
    replayRecords,
    hugeRecord,
    bigContext: bigContextPath ? { path: bigContextPath, h: bigContextH } : undefined,
    drafts: [
      "/skill:alpha edited shorthand\nline two",
      env("epsilon", "Epsilon body.", "epsilon args, edited by hand"),
    ],
  };
}
