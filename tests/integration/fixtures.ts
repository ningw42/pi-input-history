/**
 * Synthetic, redacted fixtures for the Pi integration driver: skill files, session files, and the
 * display text each recalled record is expected to have. Everything is written under one disposable root.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SKILL_NAMES = ["alpha", "beta", "code-review", "shadowed", "delta", "epsilon"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

export function envelope(name: string, location: string, body: string, args?: string): string {
  const block = `<skill name="${name}" location="${location}">\nReferences are relative to ${dirname(location)}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

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
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
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
        stopReason: "stop",
        timestamp: this.clock + 1000,
      },
    });
  }

  exchange(content: Content, label?: string): string {
    const id = this.user(content, label);
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

/** Pi's session directory for a cwd (session-manager.ts getDefaultSessionDirPath). */
export function sessionDirFor(agentDir: string, cwd: string): string {
  return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

export type Fixtures = ReturnType<typeof buildFixtures>;

export function buildFixtures(root: string) {
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const work = join(root, "work");
  const empty = join(root, "empty");
  const writes = join(root, "writes");
  const outside = join(root, "outside");
  for (const dir of [agentDir, home, work, empty, writes, outside]) mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ quietStartup: true, enableSkillCommands: false, lastChangelogVersion: "0.87.1" }),
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
  };
  const JAN = Date.parse("2026-01-01T00:00:00Z");
  const workSessions = sessionDirFor(agentDir, work);
  const recentA = new SessionFile("reca", work, JAN + 30 * 86_400_000);
  recentA.exchange(cacheRecords.alphaV1);
  recentA.exchange("cache between variants");
  recentA.exchange(cacheRecords.alphaV2);
  recentA.exchange(cacheRecords.codeReview);
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
    cwd: { work, empty, writes },
    skills,
    ctxRecords,
    ctxExpected,
    resumeRecords,
    cacheRecords,
    sessions: { workContext, workResume, outsideContext, outsideResume, largeSession, writesFiles },
    drafts: [
      "/skill:alpha edited shorthand\nline two",
      env("epsilon", "Epsilon body.", "epsilon args, edited by hand"),
    ],
  };
}
