/**
 * Real-Pi integration driver.
 *
 *   export PI_BIN="${PI_BIN:-${PI_PACKAGE_DIR:?set PI_BIN or PI_PACKAGE_DIR}/pi}"
 *   BUN_BE_BUN=1 "$PI_BIN" run ./tests/run-pi-integration.ts
 *
 * PI_BIN must be the Pi 0.87.1 executable itself (a Bun single-file binary), not a wrapper script.
 * Requires Python 3 (standard-library `pty`) and git (the 1.1.3 baseline is read from commit b183aac).
 *
 * Each scenario gets a disposable root with its own HOME, agent directory, synthetic skills, and
 * synthetic sessions. Pi runs in a pseudo-terminal with `--offline`, no discovered extensions, skills,
 * prompts, themes, or context files, no credentials, and `BUN_BE_BUN` removed from its environment.
 * tests/integration/probe.ts runs inside Pi and reports structured assertions. The run fails on a
 * missing runtime, a wrong Pi version, a failed or missing probe result, or an unexpected change to a
 * fixture session file.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildFixtures, CLI_SKILLS, sessionDirFor, type Fixtures } from "./integration/fixtures.ts";
import { evaluateRun, searchSample, timingSample, type ProbeRecord } from "./integration/run-evaluation.ts";

const REPO = resolve(import.meta.dir, "..");
const PROBE = join(REPO, "tests", "integration", "probe.ts");
const TIMING_PROBE = join(REPO, "tests", "integration", "timing-probe.ts");
const PTY_HOST = join(REPO, "tests", "integration", "pty-host.py");
const EXTENSION = join(REPO, "index.ts");
const PI_VERSION = "0.87.1";
const BASELINE_COMMIT = "b183aac"; // pi-input-history 1.1.3
const STARTUP_RUNS = 5;

function die(message: string): never {
  console.error(`\npi integration: ${message}`);
  process.exit(1);
}

// ─── Runtime ───────────────────────────────────────────────────────────────────────────────────────

const piBin =
  process.env.PI_BIN || (process.env.PI_PACKAGE_DIR ? join(process.env.PI_PACKAGE_DIR, "pi") : die("set PI_BIN or PI_PACKAGE_DIR"));
try {
  accessSync(piBin, constants.X_OK);
} catch {
  die(`PI_BIN is not an executable file: ${piBin}`);
}
{
  const fd = openSync(piBin, "r");
  const magic = Buffer.alloc(2);
  readSync(fd, magic, 0, 2, 0);
  closeSync(fd);
  if (magic.toString() === "#!") die(`PI_BIN is a script, not the Pi executable (a wrapper may inject credentials): ${piBin}`);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pih-it-")));
const bareHome = join(scratch, "bare-home");
mkdirSync(join(bareHome, "agent"), { recursive: true });

function isolatedEnv(home: string, agentDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...extra,
  };
}

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(command, args, { env, encoding: "utf8" });
  if (result.error) die(`cannot run ${command}: ${result.error.message}`);
  return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() };
}

const bareEnv = isolatedEnv(bareHome, join(bareHome, "agent"));
const piVersion = run(piBin, ["--version"], bareEnv);
if (piVersion.status !== 0 || piVersion.out !== PI_VERSION) {
  die(`expected Pi ${PI_VERSION} at ${piBin}, got: ${piVersion.out || `exit ${piVersion.status}`}`);
}
const bunRevision = run(piBin, ["--revision"], { ...bareEnv, BUN_BE_BUN: "1" }).out;
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== "BUN_BE_BUN" && v !== undefined)) as Record<string, string>;
const python = run("python3", ["-c", "import pty, select, termios, fcntl, sys; print(sys.version.split()[0])"], hostEnv);
if (python.status !== 0) die(`Python 3 with the standard-library pty module is required: ${python.out}`);

const baselineExtension = join(scratch, "baseline", "index.ts");
{
  const shown = spawnSync("git", ["-C", REPO, "show", `${BASELINE_COMMIT}:index.ts`], { encoding: "utf8", env: hostEnv });
  if (shown.status !== 0) die(`cannot read the 1.1.3 baseline (git show ${BASELINE_COMMIT}:index.ts): ${shown.stderr}`);
  mkdirSync(join(scratch, "baseline"), { recursive: true });
  writeFileSync(baselineExtension, shown.stdout);
}

console.log(`Pi ${piVersion.out} (${piBin})`);
console.log(`embedded Bun ${bunRevision}`);
console.log(`Python ${python.out}`);
console.log(`scratch ${scratch}\n`);

// ─── Running one scenario ──────────────────────────────────────────────────────────────────────────

type SessionKey = "workContext" | "outsideContext" | "largeSession" | "searchSession" | "bigContext" | "none" | "new";
type Scenario = {
  name: string;
  cwd: keyof Fixtures["cwd"];
  session: SessionKey;
  extension?: string;
  /** The timing probe, which imports nothing from this repository before measuring. */
  timing?: TimingPlan;
  args?: string[];
};
type TimingPlan = {
  kind: "startup" | "search";
  arm: "baseline" | "feature";
  sessionPath: string;
  h: string[];
  cacheSize: number;
  discoverDelayMs?: number;
  query?: string;
  hugeRecord?: string;
};

let runCounter = 0;

function sessionArgs(fx: Fixtures, key: SessionKey): string[] {
  if (key === "new") return [];
  if (key === "none") return ["--no-session"];
  const session = key === "bigContext" ? fx.bigContext : fx.sessions[key];
  if (!session) die(`fixture session ${key} was not built`);
  return ["--session", typeof session === "string" ? session : session.path];
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

function snapshot(fx: Fixtures): Map<string, string> {
  const files = [...listFiles(join(fx.agentDir, "sessions")), ...listFiles(join(fx.root, "outside"))];
  return new Map(files.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
}

function runPi(scenario: Scenario, fx: Fixtures) {
  const dir = join(fx.root, `run-${++runCounter}`);
  mkdirSync(dir, { recursive: true });
  const results = join(dir, "results.ndjson");
  const control = join(dir, "control");
  const plan = join(dir, "plan.json");
  writeFileSync(results, "");
  writeFileSync(plan, JSON.stringify({ scenario: scenario.name, results, control, fixtures: fx, timing: scenario.timing }));

  const argv = [
    piBin,
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    ...CLI_SKILLS.flatMap((name) => ["--skill", fx.skills[name]]),
    "-e",
    scenario.timing ? TIMING_PROBE : PROBE,
    "-e",
    scenario.extension ?? EXTENSION,
    ...sessionArgs(fx, scenario.session),
    ...(scenario.args ?? []),
  ];
  const config = join(dir, "pty.json");
  writeFileSync(
    config,
    JSON.stringify({
      argv,
      env: isolatedEnv(fx.home, fx.agentDir, { PIH_PLAN: plan }),
      cwd: fx.cwd[scenario.cwd],
      control,
      transcript: join(dir, "transcript"),
      timeoutSeconds: 120,
      rows: 40,
      cols: 120,
    }),
  );
  const host = spawnSync("python3", [PTY_HOST, config], { encoding: "utf8", env: hostEnv });
  const status = JSON.parse(host.stdout.trim().split("\n").pop() || "{}") as { exitCode?: number; timedOut?: boolean };
  const records: ProbeRecord[] = readFileSync(results, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const evaluation = evaluateRun(records, {
    hostExitCode: host.status,
    hostError: host.stderr,
    piExitCode: status.exitCode,
    timedOut: status.timedOut,
  });
  const transcript = () => readFileSync(join(dir, "transcript"), "latin1").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return { records, evaluation, transcript };
}

// ─── Reporting ─────────────────────────────────────────────────────────────────────────────────────

const failures: string[] = [];
const metrics: Record<string, unknown> = {};

/** Every run is judged the same way; a failed run keeps its transcript tail for diagnosis. */
function report(label: string, run: ReturnType<typeof runPi>, summary?: string): boolean {
  const { records, evaluation } = run;
  for (const r of records) if (r.metric !== undefined) metrics[`${label} ${r.id}`] = r.metric;
  for (const failure of evaluation.failures) failures.push(`${label}: ${failure}`);
  const ok = evaluation.failures.length === 0;
  if (!ok && !records.some((r) => r.done)) failures.push(`${label}: transcript tail:\n${run.transcript().slice(-1500)}`);
  const passed = evaluation.checks - evaluation.failedChecks;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(40)} ${summary ?? `${passed}/${evaluation.checks} checks`}`);
  return ok;
}

function freshFixtures(name: string, options?: { bigCorpus?: boolean }): Fixtures {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  return buildFixtures(root, options);
}

/** Fixture session files must never change; new files (fork, a new session) are allowed. */
function assertUnchanged(label: string, before: Map<string, string>, after: Map<string, string>) {
  const changed = [...before].filter(([path, hash]) => after.get(path) !== hash).map(([path]) => path);
  if (changed.length > 0) failures.push(`${label}: fixture session files changed: ${changed.join(", ")}`);
  const created = [...after.keys()].filter((path) => !before.has(path));
  if (created.length > 0) metrics[`${label} created session files`] = created.map((p) => relative(scratch, p));
}

// ─── Behavior scenarios ────────────────────────────────────────────────────────────────────────────

const behavior: Scenario[] = [
  { name: "startup", cwd: "work", session: "workContext" },
  { name: "startup-empty-cache", cwd: "empty", session: "outsideContext" },
  { name: "lifecycle", cwd: "work", session: "workContext" },
  { name: "lifecycle-empty-cache", cwd: "empty", session: "outsideContext" },
  { name: "cooperating-factory", cwd: "work", session: "workContext" },
  { name: "unsupported-editor", cwd: "work", session: "workContext" },
  { name: "reused-editor", cwd: "empty", session: "outsideContext" },
  { name: "incompatible-editor", cwd: "work", session: "workContext" },
  { name: "minimal-editor", cwd: "work", session: "workContext" },
  { name: "editor-contract", cwd: "work", session: "workContext" },
  { name: "replay", cwd: "replay", session: "new", args: ["--provider", "faux", "--model", "faux-1"] },
  { name: "transform-timing", cwd: "work", session: "largeSession" },
];

const only = process.env.PIH_ONLY?.split(",").filter(Boolean);
const selected = (name: string) => !only || only.includes(name);

for (const scenario of behavior) {
  if (!selected(scenario.name)) continue;
  const fx = freshFixtures(scenario.name);
  const before = snapshot(fx);
  report(scenario.name, runPi(scenario, fx));
  assertUnchanged(scenario.name, before, snapshot(fx));
}

// ─── Session-file writes: feature versus the unchanged 1.1.3 loader (S12) ──────────────────────────

const ARMS = [
  ["baseline", baselineExtension],
  ["feature", EXTENSION],
] as const;

if (selected("session-writes")) {
  const outcomes: Record<string, Record<string, string>> = {};
  for (const [arm, extension] of ARMS) {
    const fx = freshFixtures(`writes-${arm}`);
    const sources = Object.fromEntries(Object.entries(fx.sessions.writesFiles).map(([k, path]) => [k, readFileSync(path, "utf8")]));
    report(`session-writes (${arm})`, runPi({ name: "session-writes", cwd: "writes", session: "none", extension }, fx));
    const normalize = (text: string) => text.replaceAll(fx.root, "<root>");
    outcomes[arm] = Object.fromEntries(
      Object.entries(fx.sessions.writesFiles).map(([k, path]) => [k, normalize(readFileSync(path, "utf8"))]),
    );
    if (outcomes[arm]!.canonical !== normalize(sources.canonical!)) failures.push(`session-writes (${arm}): canonical fixture changed`);
    metrics[`session-writes (${arm}) loader rewrote`] = Object.keys(sources).filter((k) => normalize(sources[k]!) !== outcomes[arm]![k]);
  }
  for (const key of ["canonical", "repair", "migrate"]) {
    if (outcomes.feature?.[key] !== outcomes.baseline?.[key]) failures.push(`session-writes: ${key} differs from the 1.1.3 loader's result`);
  }
}

// ─── Startup time: feature versus 1.1.3, alternating runs, small and large corpus ─────────────────

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  const sd = Math.sqrt(sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, sorted.length - 1));
  const round = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);
  return { n: sorted.length, median: round(sorted[sorted.length >> 1]), min: round(sorted[0]), max: round(sorted[sorted.length - 1]), sd: round(sd) };
};

type Workload = {
  label: string;
  cwd: keyof Fixtures["cwd"];
  session: SessionKey;
  h: (fx: Fixtures) => string[];
  /** Fixtures for one trial: fresh per trial, or one read-only corpus shared by every trial. */
  fixtures: (label: string) => Fixtures;
};

let largeCorpus: Fixtures | undefined;
const workloads: Workload[] = [
  {
    label: "small",
    cwd: "work",
    session: "workContext",
    h: (fx) => fx.ctxExpected.hChronological,
    fixtures: (label) => freshFixtures(label),
  },
  {
    label: "large",
    cwd: "big",
    session: "bigContext",
    h: (fx) => fx.bigContext!.h,
    fixtures: () => (largeCorpus ??= freshFixtures("startup-timing-large-corpus", { bigCorpus: true })),
  },
];

/** Size and mtime of every session file: a cheap way to show timing trials never write the corpus. */
function statSnapshot(fx: Fixtures): string {
  return listFiles(join(fx.agentDir, "sessions"))
    .map((path) => `${path}:${statSync(path).size}:${statSync(path).mtimeMs}`)
    .join("\n");
}

/** One timed startup; the sample counts only if the run passed (workload checked, no recall work). */
function timeStartup(label: string, workload: Workload, arm: "baseline" | "feature", discoverDelayMs = 0): number | undefined {
  const fx = workload.fixtures(label);
  const extension = arm === "baseline" ? baselineExtension : EXTENSION;
  const sessionPath = sessionArgs(fx, workload.session)[1]!;
  const timing: TimingPlan = { kind: "startup", arm, sessionPath, h: workload.h(fx), cacheSize: 100, discoverDelayMs };
  const run = runPi({ name: "startup-timing", cwd: workload.cwd, session: workload.session, extension, timing }, fx);
  const { sample, failures: rejected } = timingSample(run.records, run.evaluation, "timing.startup");
  report(label, run, sample === undefined ? undefined : `${sample.toFixed(1)} ms`);
  failures.push(...rejected.map((f) => `${label}: ${f}`));
  return sample;
}

if (selected("startup-timing")) {
  for (const workload of workloads) {
    const corpus = workload.label === "large" ? workload.fixtures("") : undefined;
    const corpusBefore = corpus && statSnapshot(corpus);
    if (corpus) {
      const files = listFiles(sessionDirFor(corpus.agentDir, corpus.cwd.big));
      const bytes = files.reduce((sum, path) => sum + statSync(path).size, 0);
      metrics["startup large corpus"] = { files: files.length, megabytes: Math.round(bytes / 1e6) };
    }
    const samples: Record<string, number[]> = { baseline: [], feature: [] };
    for (let i = 0; i < STARTUP_RUNS; i++) {
      for (const [arm] of ARMS) {
        const sample = timeStartup(`startup-timing ${workload.label} ${arm} #${i + 1}`, workload, arm);
        if (sample !== undefined) samples[arm]!.push(sample);
      }
    }
    if (corpus && statSnapshot(corpus) !== corpusBefore) failures.push("startup-timing large: a trial wrote to the corpus");
    const base = stats(samples.baseline!);
    const feat = stats(samples.feature!);
    metrics[`startup ms, ${workload.label} corpus (baseline 1.1.3)`] = base;
    metrics[`startup ms, ${workload.label} corpus (feature)`] = feat;
    const delta = (feat.median ?? Number.NaN) - (base.median ?? Number.NaN);
    // "No meaningful regression": within 5% of the baseline median (at least 25 ms for timer noise).
    const allowed = Math.max(25, 0.05 * (base.median ?? 0));
    const ok = base.n === STARTUP_RUNS && feat.n === STARTUP_RUNS && delta < allowed;
    if (!ok) failures.push(`startup-timing ${workload.label}: median delta ${delta.toFixed(1)} ms exceeds ${allowed.toFixed(1)} ms`);
    console.log(`${ok ? "ok  " : "FAIL"} ${`startup-timing ${workload.label} corpus`.padEnd(40)} median delta ${delta.toFixed(1)} ms`);

    if (workload.label === "small") {
      // The endpoint must include resource discovery and Pi's native preload, even with a capped history.
      const delayed = timeStartup("startup-timing small feature, discovery +600 ms", workload, "feature", 600);
      const moved = delayed !== undefined && feat.median !== undefined && delayed - feat.median >= 500;
      if (!moved) failures.push(`startup-timing: a 600 ms discovery delay moved the endpoint only to ${delayed} ms (median ${feat.median})`);
      console.log(`${moved ? "ok  " : "FAIL"} ${"startup endpoint follows discovery".padEnd(40)} +${((delayed ?? 0) - (feat.median ?? 0)).toFixed(1)} ms`);
    }
  }
}

// ─── Reverse-search keystroke cost: raw (1.1.3) versus compact, with a ~300 KB envelope ────────────

if (selected("search-timing")) {
  const p95: Record<string, number> = {};
  for (const [arm, extension] of ARMS) {
    const fx = freshFixtures(`search-timing-${arm}`);
    const h = [...Array.from({ length: 40 }, (_, i) => `search plain prompt ${i}`), fx.hugeRecord];
    const sessionPath = fx.sessions.searchSession;
    const timing: TimingPlan = { kind: "search", arm, sessionPath, h, cacheSize: 100, query: "huge args", hugeRecord: fx.hugeRecord };
    const run = runPi({ name: "search-timing", cwd: "work", session: "searchSession", extension, timing }, fx);
    report(`search-timing ${arm}`, run);
    const sample = searchSample(run.records, run.evaluation, "timing.search");
    failures.push(...sample.failures.map((f) => `search-timing ${arm}: ${f}`));
    if (sample.p95 !== undefined) p95[arm] = sample.p95;
  }
  const ok = p95.feature !== undefined && p95.baseline !== undefined && p95.feature <= p95.baseline;
  if (!ok) failures.push(`search-timing: compact p95 ${p95.feature} ms is worse than raw p95 ${p95.baseline} ms`);
  console.log(`${ok ? "ok  " : "FAIL"} ${"search keystroke p95 compact <= raw".padEnd(40)} ${p95.feature?.toFixed(2)} vs ${p95.baseline?.toFixed(2)} ms`);
}

// ─── Summary ───────────────────────────────────────────────────────────────────────────────────────

console.log("\nmetrics:");
for (const [key, value] of Object.entries(metrics)) console.log(`  ${key}: ${JSON.stringify(value)}`);

if (only) failures.push(`partial run (PIH_ONLY=${only.join(",")}): not a complete compatibility check`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`\nkept ${scratch} for inspection`);
  process.exit(1);
}
if (!process.env.PIH_KEEP) rmSync(scratch, { recursive: true, force: true });
console.log("\nall Pi integration checks passed");
