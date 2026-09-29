/**
 * Judging one Pi integration run from the probe's structured records and the process outcome. Every
 * run — behavior scenarios and timing trials alike — is judged here; a timing sample is only taken
 * from a run that passed.
 */

export type ProbeRecord = { id?: string; pass?: unknown; detail?: unknown; metric?: unknown; done?: boolean };
export type RunStatus = { hostExitCode: number | null; hostError?: string; piExitCode?: number | null; timedOut?: boolean };
export type Evaluation = { checks: number; failedChecks: number; failures: string[] };

export function evaluateRun(records: ProbeRecord[], status: RunStatus): Evaluation {
  const failures: string[] = [];
  if (status.hostExitCode !== 0) failures.push(`pty host failed (${status.hostExitCode}): ${status.hostError ?? ""}`.trim());
  if (status.timedOut) failures.push("Pi timed out");
  else if (status.hostExitCode === 0 && status.piExitCode !== 0) failures.push(`Pi exited with ${status.piExitCode}`);

  // Fail closed: a record is a completion marker, a metric (id + metric), or an assertion (id + pass).
  let checks = 0;
  let failedChecks = 0;
  for (const record of records) {
    const isAssertion = "pass" in record;
    const isMetric = "metric" in record;
    if (!isAssertion && record.done === true) continue;
    if (!isAssertion && isMetric && typeof record.id === "string") continue;
    if (!isAssertion || typeof record.id !== "string") {
      failures.push(`malformed record ${JSON.stringify(record)}`);
      continue;
    }
    checks++;
    if (record.pass === true && !isMetric) continue;
    failedChecks++;
    if (isMetric) failures.push(`${record.id}: malformed record mixes an assertion and a metric ${JSON.stringify(record)}`);
    else if (typeof record.pass !== "boolean") failures.push(`${record.id}: malformed assertion ${JSON.stringify(record)}`);
    else failures.push(`${record.id}: ${JSON.stringify(record.detail)}`);
  }
  if (checks === 0) failures.push("no assertions were reported");
  if (!records.some((record) => record.done === true)) failures.push("probe did not finish");
  return { checks, failedChecks, failures };
}

/** The elapsed time `end - start` of a passing run's timing metric. */
export function timingSample(
  records: ProbeRecord[],
  evaluation: Evaluation,
  metricId: string,
): { sample?: number; failures: string[] } {
  if (evaluation.failures.length > 0) return { failures: ["timing sample rejected: the run failed"] };
  const metric = records.find((record) => record.id === metricId)?.metric as { start?: unknown; end?: unknown } | undefined;
  const { start, end } = metric ?? {};
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(end - start) || end < start) {
    return { failures: [`timing sample rejected: invalid ${metricId} ${JSON.stringify(metric)}`] };
  }
  return { sample: end - start, failures: [] };
}

/** The p95 of a passing run's reverse-search keystroke distribution `{ n, median, p95 }`. */
export function searchSample(
  records: ProbeRecord[],
  evaluation: Evaluation,
  metricId: string,
): { p95?: number; failures: string[] } {
  if (evaluation.failures.length > 0) return { failures: ["search sample rejected: the run failed"] };
  const metric = records.find((record) => record.id === metricId)?.metric as { n?: unknown; median?: unknown; p95?: unknown } | undefined;
  const { n, median, p95 } = metric ?? {};
  const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!Number.isInteger(n) || (n as number) <= 0 || !duration(median) || !duration(p95) || p95 < median) {
    return { failures: [`search sample rejected: invalid ${metricId} ${JSON.stringify(metric)}`] };
  }
  return { p95, failures: [] };
}
