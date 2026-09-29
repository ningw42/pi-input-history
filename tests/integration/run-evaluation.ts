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

  let checks = 0;
  let failedChecks = 0;
  for (const record of records) {
    if (record.id === undefined || record.metric !== undefined) continue;
    checks++;
    if (record.pass === true) continue;
    failedChecks++;
    if (typeof record.pass !== "boolean") failures.push(`${record.id}: malformed assertion ${JSON.stringify(record)}`);
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
