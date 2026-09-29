import { describe, expect, test } from "bun:test";
import { commandInventory, toRecallText, type SkillInventory } from "../../src/skill-recall.ts";
import { skillEnvelope } from "../support/skill-envelope.ts";

const LOCATION = "/abs/skills/code-review/SKILL.md";

function envelope(options: { name?: string; location?: string; body?: string; args?: string } = {}): string {
  const body = options.body ?? "Review the diff.\n\n## Steps\n1. Read it.";
  return skillEnvelope(options.name ?? "code-review", options.location ?? LOCATION, body, options.args);
}

function skill(name: string, path: string) {
  return { name: `skill:${name}`, source: "skill", sourceInfo: { path } };
}

const loaded = () => commandInventory(() => [skill("code-review", LOCATION)]);

describe("canonical skill invocations", () => {
  test("recalls a single-line invocation as shorthand", () => {
    expect(toRecallText(envelope({ args: "review changes since main" }), loaded())).toBe(
      "/skill:code-review review changes since main",
    );
  });

  test("recalls an invocation without arguments without a trailing space", () => {
    expect(toRecallText(envelope(), loaded())).toBe("/skill:code-review");
  });

  test("preserves multiline arguments after a single space", () => {
    const text = envelope({ args: "review changes since main\nKeep the review focused on authentication." });
    expect(toRecallText(text, loaded())).toBe(
      "/skill:code-review review changes since main\nKeep the review focused on authentication.",
    );
  });

  test("preserves Unicode, quoting, and internal spacing verbatim", () => {
    const args = `check "naïve" café — 日本語 🚀\n\n  indented   line 'single' \`tick\`\n\n\nend`;
    expect(toRecallText(envelope({ args }), loaded())).toBe(`/skill:code-review ${args}`);
  });

  test("shows tabs and carriage returns the way Pi's editor stores assigned text", () => {
    // pi-tui Editor.normalizeText: CRLF and CR become LF, a tab becomes four spaces.
    const args = "  lead\ta\tb\r\nc\rd\r\n\r\ne";
    expect(toRecallText(envelope({ args }), loaded())).toBe("/skill:code-review   lead    a    b\nc\nd\n\ne");
  });

  test("does not trim leading whitespace of the arguments", () => {
    expect(toRecallText(envelope({ args: "  two leading spaces" }), loaded())).toBe(
      "/skill:code-review   two leading spaces",
    );
  });

  test("does not expand templates or shell syntax in the arguments", () => {
    const args = "$1 $@ ${ARGUMENTS} $(whoami) `id` \\n";
    expect(toRecallText(envelope({ args }), loaded())).toBe(`/skill:code-review ${args}`);
  });

  test("accepts an empty skill body", () => {
    expect(toRecallText(envelope({ body: "", args: "go" }), loaded())).toBe("/skill:code-review go");
  });

  test("retains case-sensitive names that use every allowed character class", () => {
    const location = "/abs/skills/My_Skill.v2:beta-1/SKILL.md";
    const inventory = commandInventory(() => [skill("My_Skill.v2:beta-1", location)]);
    expect(toRecallText(envelope({ name: "My_Skill.v2:beta-1", location, args: "x" }), inventory)).toBe(
      "/skill:My_Skill.v2:beta-1 x",
    );
  });

  test("tolerates closer-like text inside the body that is not a candidate closer", () => {
    const body = "Inline </skill> and <skill> tags.\n</skill>X is not a closer.\n</skill>\nnor is this one.";
    expect(toRecallText(envelope({ body, args: "go" }), loaded())).toBe("/skill:code-review go");
  });

  test("keeps inline tags and non-standalone closer lines in the arguments", () => {
    const args = "quote <skill>inline</skill> here\n</skill>X\nX</skill>\n </skill>";
    expect(toRecallText(envelope({ args }), loaded())).toBe(`/skill:code-review ${args}`);
  });

  test("is idempotent", () => {
    for (const text of [envelope(), envelope({ args: "a\nb" }), "plain", "/skill:code-review x"]) {
      const once = toRecallText(text, loaded());
      expect(toRecallText(once, loaded())).toBe(once);
    }
  });
});

describe("text that stays raw", () => {
  // Every name/location resolves, so only recognition can keep these raw.
  const everythingLoaded: SkillInventory = { resolves: () => true };
  const raw = (text: string) => expect(toRecallText(text, everythingLoaded)).toBe(text);

  test("ordinary prompts and existing shorthand pass through", () => {
    raw("fix the failing test");
    raw("tabs\tand\r\nreturns\rstay as stored");
    raw("/skill:code-review review changes since main");
    raw("");
  });

  test("an envelope that does not start the text", () => {
    raw(`please look at this:\n${envelope({ args: "go" })}`);
    raw(` ${envelope({ args: "go" })}`);
    raw("```\n" + envelope({ args: "go" }) + "\n```");
    raw("> " + envelope({ args: "go" }));
  });

  test("missing or empty attributes", () => {
    raw(envelope({ args: "go" }).replace(` location="${LOCATION}"`, ""));
    raw(envelope({ location: "", args: "go" }));
    raw(envelope({ name: "", args: "go" }));
    raw(`<skill name="code-review">\nReferences are relative to /abs.\n\nbody\n</skill>\n\ngo`);
  });

  test("attribute order, spacing, or delimiters other than Pi's", () => {
    raw(
      `<skill location="${LOCATION}" name="code-review">\nReferences are relative to /abs/skills/code-review.\n\nbody\n</skill>\n\ngo`,
    );
    raw(envelope({ args: "go" }).replace('" location', '"  location'));
    raw(envelope({ args: "go" }).replace('">\n', '" >\n'));
    raw(envelope({ args: "go" }).replaceAll("\n", "\r\n"));
    raw(`<skill name='code-review' location='${LOCATION}'>\nReferences are relative to /abs/skills/code-review.\n\nbody\n</skill>`);
  });

  test("a relative location", () => {
    raw(envelope({ location: "skills/code-review/SKILL.md", args: "go" }));
  });

  test("a missing or mismatched reference prologue", () => {
    const text = envelope({ args: "go" });
    raw(text.replace("References are relative to /abs/skills/code-review.\n\n", ""));
    raw(text.replace("/abs/skills/code-review.", "/abs/skills/other."));
    raw(text.replace("/abs/skills/code-review.\n\n", "/abs/skills/code-review.\n"));
    raw(text.replace("References are", "references are"));
  });

  test("a missing closer or an argument separator without arguments", () => {
    const text = envelope({ args: "go" });
    raw(text.replace("\n</skill>", ""));
    raw(text.replace("\n</skill>\n\n", "\n</skill>\n"));
    raw(text.replace("\n</skill>\n\n", "\n</skill> "));
    raw(text.replace("\n</skill>\n\ngo", "\n</skill>\n\n"));
    raw(envelope({ args: "" }));
    raw(text.replace("\n</skill>", "</skill>"));
  });

  test("names that are not command-safe", () => {
    for (const name of [".hidden", "-dash", ":colon", "_under", "has space", "slash/name", "tab\tname", "ünï", "a\nb"]) {
      raw(envelope({ name, args: "go" }));
    }
  });

  test("an early grammar-valid closer inside the body", () => {
    // The first valid closer ends the body early, so the real closer is a standalone line in the suffix.
    raw(envelope({ body: "Example:\n</skill>\n\nnot the arguments", args: "go" }));
    raw(envelope({ body: "Example:\n</skill>\n\nnot the arguments" }));
  });

  test("an argument line that is exactly the closer, anywhere in the suffix", () => {
    raw(envelope({ args: "</skill>" }));
    raw(envelope({ args: "</skill>\nafter" }));
    raw(envelope({ args: "before\n</skill>" }));
    raw(envelope({ args: "before\n</skill>\nafter" }));
    raw(envelope({ args: "before\n\n</skill>\n\nafter" }));
  });
});

describe("resolution against the loaded commands", () => {
  const text = envelope({ args: "go" });
  const recall = (commands: unknown[]) => toRecallText(text, commandInventory(() => commands as never));

  test("converts only when exactly one loaded skill has the stored name and path", () => {
    expect(recall([skill("other", "/abs/skills/other/SKILL.md"), skill("code-review", LOCATION)])).toBe(
      "/skill:code-review go",
    );
  });

  test("an unknown or renamed skill stays raw", () => {
    expect(recall([])).toBe(text);
    expect(recall([skill("code-reviewer", LOCATION)])).toBe(text);
    expect(recall([skill("Code-Review", LOCATION)])).toBe(text);
  });

  test("a path mismatch stays raw, including equivalent spellings", () => {
    expect(recall([skill("code-review", "/abs/other/code-review/SKILL.md")])).toBe(text);
    expect(recall([skill("code-review", "/abs/skills/../skills/code-review/SKILL.md")])).toBe(text);
    expect(recall([skill("code-review", `${LOCATION}/`)])).toBe(text);
  });

  test("missing source metadata stays raw", () => {
    expect(recall([{ name: "skill:code-review", source: "skill" }])).toBe(text);
    expect(recall([{ name: "skill:code-review", source: "skill", sourceInfo: {} }])).toBe(text);
    expect(recall([{ name: "skill:code-review", source: "skill", sourceInfo: { path: 42 } }])).toBe(text);
    expect(recall([{ name: "skill:code-review", sourceInfo: { path: LOCATION } }])).toBe(text);
  });

  test("duplicate or conflicting identities stay raw", () => {
    expect(recall([skill("code-review", LOCATION), skill("code-review", LOCATION)])).toBe(text);
    expect(recall([skill("code-review", LOCATION), skill("code-review", "/abs/b/SKILL.md")])).toBe(text);
    expect(
      recall([skill("code-review", LOCATION), { name: "skill:code-review", source: "prompt", sourceInfo: { path: "/p.md" } }]),
    ).toBe(text);
  });

  test("an extension command that intercepts the invocation name stays raw", () => {
    expect(
      recall([
        { name: "skill:code-review", source: "extension", sourceInfo: { path: "/ext/index.ts" } },
        skill("code-review", LOCATION),
      ]),
    ).toBe(text);
  });

  test("an inventory failure stays raw", () => {
    const inventory = commandInventory(() => {
      throw new Error("stale extension context");
    });
    expect(toRecallText(text, inventory)).toBe(text);
    expect(toRecallText(text, commandInventory(() => null as never))).toBe(text);
    expect(recall([null, 7, "skill:code-review"])).toBe(text);
  });

  test("builds no inventory for records that are not skill invocations", () => {
    let calls = 0;
    const inventory = commandInventory(() => {
      calls++;
      return [skill("code-review", LOCATION)];
    });
    for (const plain of ["fix it", "/skill:code-review go", "<skill>", envelope({ location: "rel/SKILL.md" })]) {
      toRecallText(plain, inventory);
    }
    expect(calls).toBe(0);
  });

  test("reads the commands once per inventory snapshot", () => {
    let calls = 0;
    const inventory = commandInventory(() => {
      calls++;
      return [skill("code-review", LOCATION)];
    });
    for (let i = 0; i < 5; i++) expect(toRecallText(envelope({ args: `run ${i}` }), inventory)).toBe(`/skill:code-review run ${i}`);
    expect(calls).toBe(1);
  });

  test("a later snapshot sees commands loaded after an earlier one", () => {
    let commands: unknown[] = [];
    const before = commandInventory(() => commands as never);
    expect(toRecallText(text, before)).toBe(text);
    commands = [skill("code-review", LOCATION)];
    expect(toRecallText(text, before)).toBe(text);
    expect(toRecallText(text, commandInventory(() => commands as never))).toBe("/skill:code-review go");
  });
});

describe("large and malformed records", () => {
  const everythingLoaded: SkillInventory = { resolves: () => true };
  const MB = 1024 * 1024;

  const inputs = (size: number) => ({
    canonical: envelope({ body: "x".repeat(size), args: "go" }),
    falseClosers: envelope({ body: "\n</skill>X".repeat(size / 10), args: "go" }).replace("\n</skill>\n\ngo", ""),
    noCloser: envelope({ body: "y".repeat(size) }).replace("\n</skill>", ""),
    unterminatedName: `<skill name="${"n".repeat(size)}`,
    closerLinesInArgs: envelope({ args: "a\n</skill>X".repeat(size / 10) + "\n</skill>" }),
  });

  test("are recognized or rejected without throwing or truncating", () => {
    const { canonical, falseClosers, noCloser, unterminatedName, closerLinesInArgs } = inputs(4 * MB);
    expect(toRecallText(canonical, everythingLoaded)).toBe("/skill:code-review go");
    for (const text of [falseClosers, noCloser, unterminatedName, closerLinesInArgs]) {
      const result = toRecallText(text, everythingLoaded);
      expect(result.length).toBe(text.length);
      expect(result).toBe(text);
    }
  });

  test("take approximately linear time", () => {
    const median = (text: string) => {
      const samples: number[] = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        toRecallText(text, everythingLoaded);
        samples.push(performance.now() - start);
      }
      return samples.sort((a, b) => a - b)[3]!;
    };
    const small = inputs(MB / 2);
    const large = inputs(4 * MB);
    for (const kind of Object.keys(small) as (keyof typeof small)[]) {
      const [t1, t8] = [median(small[kind]), median(large[kind])];
      // 8x the input: linear work is ~8x; quadratic would be ~64x. Floor absorbs timer noise on fast paths.
      expect(t8).toBeLessThan(Math.max(1, t1) * 24);
      expect(t8).toBeLessThan(250);
    }
  });
});
