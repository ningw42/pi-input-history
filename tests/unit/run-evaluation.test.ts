import { describe, expect, test } from "bun:test";
import { evaluateRun, searchSample, timingSample, type ProbeRecord, type RunStatus } from "../integration/run-evaluation.ts";

const clean: RunStatus = { hostExitCode: 0, piExitCode: 0, timedOut: false };
const timing = { id: "timing.startup", metric: { start: 180, end: 520 } };
const passing: ProbeRecord[] = [{ id: "seed.slots", pass: true }, timing, { done: true }];

describe("judging one Pi run", () => {
  test("accepts passing assertions, completion, and a clean exit", () => {
    expect(evaluateRun(passing, clean).failures).toEqual([]);
    expect(evaluateRun(passing, clean).checks).toBe(1);
  });

  test("rejects a failed assertion even when the run also reports a valid timing", () => {
    const records = [{ id: "seed.slots", pass: false, detail: { actual: 99 } }, timing, { done: true }];
    const evaluation = evaluateRun(records, clean);
    expect(evaluation.failures).toEqual(['seed.slots: {"actual":99}']);
    expect(timingSample(records, evaluation, "timing.startup")).toEqual({
      failures: ["timing sample rejected: the run failed"],
    });
  });

  test("rejects a run without assertions or without the completion record", () => {
    expect(evaluateRun([timing, { done: true }], clean).failures).toEqual(["no assertions were reported"]);
    expect(evaluateRun([{ id: "a", pass: true }, timing], clean).failures).toEqual(["probe did not finish"]);
  });

  test("rejects malformed assertion records", () => {
    expect(evaluateRun([{ id: "a", pass: "yes" as never }, { done: true }], clean).failures).toEqual([
      'a: malformed assertion {"id":"a","pass":"yes"}',
    ]);
  });

  test("rejects process failures", () => {
    expect(evaluateRun(passing, { ...clean, timedOut: true }).failures).toEqual(["Pi timed out"]);
    expect(evaluateRun(passing, { ...clean, piExitCode: 1 }).failures).toEqual(["Pi exited with 1"]);
    expect(evaluateRun(passing, { ...clean, hostExitCode: 2, hostError: "boom" }).failures).toEqual([
      "pty host failed (2): boom",
    ]);
  });

  test("accepts a timing sample only from a clean run with a valid metric", () => {
    const evaluation = evaluateRun(passing, clean);
    expect(timingSample(passing, evaluation, "timing.startup")).toEqual({ sample: 340, failures: [] });
    const missing = [{ id: "a", pass: true }, { done: true }];
    expect(timingSample(missing, evaluateRun(missing, clean), "timing.startup").failures).toEqual([
      "timing sample rejected: invalid timing.startup undefined",
    ]);
    for (const metric of [{ start: 5 }, { start: 5, end: Number.NaN }, { start: 9, end: 3 }]) {
      const records = [{ id: "a", pass: true }, { id: "timing.startup", metric }, { done: true }];
      expect(timingSample(records, evaluateRun(records, clean), "timing.startup").failures).toEqual([
        `timing sample rejected: invalid timing.startup ${JSON.stringify(metric)}`,
      ]);
    }
  });
});

describe("fail-closed record handling", () => {
  test("rejects a failed assertion that also carries a metric", () => {
    const records = [{ id: "a", pass: true }, { id: "seed.slots", pass: false, metric: 12 }, timing, { done: true }];
    const evaluation = evaluateRun(records, clean);
    expect(evaluation.failures).toEqual(['seed.slots: malformed record mixes an assertion and a metric {"id":"seed.slots","pass":false,"metric":12}']);
    expect(timingSample(records, evaluation, "timing.startup").sample).toBeUndefined();
  });

  test("rejects a passing assertion that also carries a metric, and records of unknown shape", () => {
    expect(evaluateRun([{ id: "a", pass: true, metric: 1 }, { done: true }], clean).failures).toEqual([
      'a: malformed record mixes an assertion and a metric {"id":"a","pass":true,"metric":1}',
    ]);
    expect(evaluateRun([{ id: "a", pass: true }, { id: "b" }, { done: true }], clean).failures).toEqual([
      'malformed record {"id":"b"}',
    ]);
    expect(evaluateRun([{ id: "a", pass: true }, { pass: false }, { done: true }], clean).failures).toEqual([
      'malformed record {"pass":false}',
    ]);
  });
});

describe("search keystroke samples", () => {
  const search = (metric: unknown) => [{ id: "a", pass: true }, { id: "timing.search", metric }, { done: true }];

  test("accepts a complete distribution from a passing run", () => {
    const records = search({ n: 45, median: 0.4, p95: 0.5 });
    expect(searchSample(records, evaluateRun(records, clean), "timing.search")).toEqual({ p95: 0.5, failures: [] });
  });

  test("rejects missing, non-finite, negative, or inconsistent measurements", () => {
    for (const metric of [
      undefined,
      { p95: 0.5 },
      { n: 45, median: 0.4 },
      { n: 0, median: 0.4, p95: 0.5 },
      { n: 4.5, median: 0.4, p95: 0.5 },
      { n: 45, median: -1, p95: 0.5 },
      { n: 45, median: 0.4, p95: -1 },
      { n: 45, median: 0.4, p95: Number.POSITIVE_INFINITY },
      { n: 45, median: 0.6, p95: 0.5 },
    ]) {
      const records = metric === undefined ? [{ id: "a", pass: true }, { done: true }] : search(metric);
      expect(searchSample(records, evaluateRun(records, clean), "timing.search").failures).toEqual([
        `search sample rejected: invalid timing.search ${JSON.stringify(metric)}`,
      ]);
    }
  });

  test("rejects a sample from a failed run", () => {
    const records = [{ id: "a", pass: false }, { id: "timing.search", metric: { n: 45, median: 0.4, p95: 0.5 } }, { done: true }];
    expect(searchSample(records, evaluateRun(records, clean), "timing.search")).toEqual({
      failures: ["search sample rejected: the run failed"],
    });
  });
});
