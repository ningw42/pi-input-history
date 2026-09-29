import { dirname } from "node:path";

/**
 * A skill envelope in the shape Pi 0.87.1 stores for `/skill:NAME ARGS` (agent-session.ts
 * `_expandSkillCommand`; baseDir = dirname(filePath)). Omitted `args` means no suffix, as Pi writes a
 * no-argument invocation. A string `args` — even "" — is appended after the blank line, so tests can
 * also build the malformed separator-without-arguments shape.
 */
export function skillEnvelope(name: string, location: string, body: string, args?: string): string {
  const block = `<skill name="${name}" location="${location}">\nReferences are relative to ${dirname(location)}.\n\n${body}\n</skill>`;
  return args === undefined ? block : `${block}\n\n${args}`;
}
