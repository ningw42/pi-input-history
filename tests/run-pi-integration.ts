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
import { buildFixtures, type Fixtures } from "./integration/fixtures.ts";

const REPO = resolve(import.meta.dir, "..");
const PROBE = join(REPO, "tests", "integration", "probe.ts");
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

type Result = { id?: string; pass?: boolean; detail?: unknown; metric?: unknown; done?: boolean };
type SessionKey = "workContext" | "outsideContext" | "largeSession" | "none";
type Scenario = { name: string; cwd: keyof Fixtures["cwd"]; session: SessionKey; extension?: string };

let runCounter = 0;

function sessionPath(fx: Fixtures, key: SessionKey): string | undefined {
  if (key === "none") return undefined;
  const session = fx.sessions[key];
  return typeof session === "string" ? session : session.path;
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
  writeFileSync(plan, JSON.stringify({ scenario: scenario.name, results, control, fixtures: fx }));

  const session = sessionPath(fx, scenario.session);
  const argv = [
    piBin,
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    ...(["alpha", "beta", "code-review", "shadowed"] as const).flatMap((name) => ["--skill", fx.skills[name]]),
    "-e",
    PROBE,
    "-e",
    scenario.extension ?? EXTENSION,
    ...(session ? ["--session", session] : ["--no-session"]),
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
  const records: Result[] = readFileSync(results, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const problems: string[] = [];
  if (host.status !== 0) problems.push(`pty host failed: ${host.stderr}`);
  if (status.timedOut) problems.push("Pi timed out");
  else if (status.exitCode !== 0) problems.push(`Pi exited with ${status.exitCode}`);
  if (!records.some((r) => r.done)) problems.push("probe did not finish");
  if (problems.length > 0) {
    const transcript = readFileSync(join(dir, "transcript"), "latin1").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    problems.push(`transcript tail:\n${transcript.slice(-1500)}`);
  }
  return { records, problems };
}

// ─── Reporting ─────────────────────────────────────────────────────────────────────────────────────

const failures: string[] = [];
const metrics: Record<string, unknown> = {};

function report(label: string, records: Result[], problems: string[]) {
  const checks = records.filter((r) => r.id && r.pass !== undefined);
  const failed = checks.filter((r) => !r.pass);
  for (const r of records) if (r.metric !== undefined) metrics[`${label} ${r.id}`] = r.metric;
  for (const r of failed) failures.push(`${label}: ${r.id}\n    ${JSON.stringify(r.detail)}`);
  for (const problem of problems) failures.push(`${label}: ${problem}`);
  if (checks.length === 0) failures.push(`${label}: no assertions were reported`);
  const ok = failed.length === 0 && problems.length === 0 && checks.length > 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${checks.length - failed.length}/${checks.length} checks`);
}

function freshFixtures(name: string): Fixtures {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  return buildFixtures(root);
}

/** Fixture session files must never change; new files (fork) are allowed. */
function assertUnchanged(label: string, before: Map<string, string>, after: Map<string, string>, exempt: string[] = []) {
  const changed = [...before].filter(([path, hash]) => !exempt.includes(path) && after.get(path) !== hash).map(([path]) => path);
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
  { name: "editor-contract", cwd: "work", session: "workContext" },
  { name: "transform-timing", cwd: "work", session: "largeSession" },
];

const only = process.env.PIH_ONLY?.split(",").filter(Boolean);
for (const scenario of behavior) {
  if (only && !only.includes(scenario.name)) continue;
  const fx = freshFixtures(scenario.name);
  const before = snapshot(fx);
  const { records, problems } = runPi(scenario, fx);
  report(scenario.name, records, problems);
  assertUnchanged(scenario.name, before, snapshot(fx));
}

// ─── Session-file writes: feature versus the unchanged 1.1.3 loader (S12) ──────────────────────────

if (!only || only.includes("session-writes")) {
  const outcomes: Record<string, Record<string, string>> = {};
  for (const [variant, extension] of [
    ["baseline-1.1.3", baselineExtension],
    ["feature", EXTENSION],
  ] as const) {
    const fx = freshFixtures(`writes-${variant}`);
    const sources = Object.fromEntries(Object.entries(fx.sessions.writesFiles).map(([k, path]) => [k, readFileSync(path, "utf8")]));
    const { records, problems } = runPi({ name: "session-writes", cwd: "writes", session: "none", extension }, fx);
    report(`session-writes (${variant})`, records, problems);
    const normalize = (text: string) => text.replaceAll(fx.root, "<root>");
    outcomes[variant] = Object.fromEntries(
      Object.entries(fx.sessions.writesFiles).map(([k, path]) => [k, normalize(readFileSync(path, "utf8"))]),
    );
    if (outcomes[variant]!.canonical !== normalize(sources.canonical!)) failures.push(`session-writes (${variant}): canonical fixture changed`);
    metrics[`session-writes (${variant}) loader rewrote`] = Object.keys(sources).filter(
      (k) => normalize(sources[k]!) !== outcomes[variant]![k],
    );
  }
  for (const key of ["canonical", "repair", "migrate"]) {
    if (outcomes["feature"]?.[key] !== outcomes["baseline-1.1.3"]?.[key]) {
      failures.push(`session-writes: ${key} differs from the 1.1.3 loader's result`);
    }
  }
}

// ─── Startup time: feature versus 1.1.3, alternating runs ──────────────────────────────────────────

if (!only || only.includes("startup-timing")) {
  const samples: Record<string, number[]> = { "baseline-1.1.3": [], feature: [] };
  for (let i = 0; i < STARTUP_RUNS; i++) {
    for (const [variant, extension] of [
      ["baseline-1.1.3", baselineExtension],
      ["feature", EXTENSION],
    ] as const) {
      const fx = freshFixtures(`timing-${variant}-${i}`);
      const { records, problems } = runPi({ name: "startup-timing", cwd: "work", session: "workContext", extension }, fx);
      const timing = records.find((r) => r.id === "timing.startup")?.metric as { ready?: number } | undefined;
      if (problems.length > 0 || typeof timing?.ready !== "number") {
        report(`startup-timing (${variant} #${i + 1})`, records, problems);
        continue;
      }
      samples[variant]!.push(timing.ready);
    }
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { n: sorted.length, median: sorted[sorted.length >> 1], min: sorted[0], max: sorted[sorted.length - 1] };
  };
  const base = stats(samples["baseline-1.1.3"]!);
  const feat = stats(samples.feature!);
  metrics["startup ready ms (baseline-1.1.3)"] = base;
  metrics["startup ready ms (feature)"] = feat;
  const delta = (feat.median ?? Number.NaN) - (base.median ?? Number.NaN);
  metrics["startup median delta ms"] = Math.round(delta * 10) / 10;
  // "No meaningful regression": within 5% of the baseline median (at least 25 ms for timer noise).
  const allowed = Math.max(25, 0.05 * (base.median ?? 0));
  const ok = base.n === STARTUP_RUNS && feat.n === STARTUP_RUNS && delta < allowed;
  if (!ok) failures.push(`startup-timing: median delta ${delta.toFixed(1)} ms exceeds ${allowed.toFixed(1)} ms`);
  console.log(`${ok ? "ok  " : "FAIL"} ${"startup-timing".padEnd(34)} median delta ${delta.toFixed(1)} ms`);
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
