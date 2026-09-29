/**
 * Skill-aware recall: present a stored skill invocation as `/skill:name arguments`.
 *
 * Pi stores an explicitly invoked skill as a leading `<skill …>…</skill>` envelope followed by the
 * invocation's arguments. Recall shows the command instead of the expanded body, but only when the
 * envelope is unambiguous and the skill it names is the one currently loaded from the same file.
 * Every other input is returned unchanged.
 */

import { dirname, isAbsolute } from "node:path";

type SkillInvocation = { name: string; location: string; args: string };

const OPEN = '<skill name="';
const LOCATION = '" location="';
const HEADER_END = '">\n';
const CLOSER = "\n</skill>";

/** Names that are safe to retype as `/skill:NAME`; anything else stays raw even if Pi loaded it. */
const COMMAND_SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Recognize Pi's native envelope at the start of `text`:
 *
 *   <skill name="NAME" location="/abs/SKILL.md">\nReferences are relative to /abs.\n\nBODY\n</skill>[\n\nARGS]
 *
 * The body ends at the first `\n</skill>` followed by end-of-text or by `\n\n` and at least one character.
 * If the arguments after that closer contain a line that is exactly `</skill>`, the boundary is ambiguous
 * (an early closer inside the body looks the same), so the record is not recognized. Arguments are the
 * original slice, untrimmed. Work is linear in the length of `text`.
 */
function parseSkillInvocation(text: string): SkillInvocation | null {
  if (!text.startsWith(OPEN)) return null;
  const nameEnd = text.indexOf('"', OPEN.length);
  if (nameEnd < 0 || !text.startsWith(LOCATION, nameEnd)) return null;
  const name = text.slice(OPEN.length, nameEnd);
  if (!COMMAND_SAFE_NAME.test(name)) return null;

  const locationStart = nameEnd + LOCATION.length;
  const locationEnd = text.indexOf('"', locationStart);
  if (locationEnd < 0 || !text.startsWith(HEADER_END, locationEnd)) return null;
  const location = text.slice(locationStart, locationEnd);
  if (!isAbsolute(location)) return null;

  // Pi writes `location` from the skill's filePath and this prologue from baseDir = dirname(filePath).
  const prologue = `References are relative to ${dirname(location)}.\n\n`;
  const bodyStart = locationEnd + HEADER_END.length;
  if (!text.startsWith(prologue, bodyStart)) return null;

  let closer = text.indexOf(CLOSER, bodyStart + prologue.length);
  for (; closer >= 0; closer = text.indexOf(CLOSER, closer + 1)) {
    const after = closer + CLOSER.length;
    if (after === text.length) return { name, location, args: "" };
    if (text.startsWith("\n\n", after) && after + 2 < text.length) {
      const args = text.slice(after + 2);
      return hasCloserLine(args) ? null : { name, location, args };
    }
  }
  return null;
}

function hasCloserLine(text: string): boolean {
  const line = "</skill>";
  return text === line || text.startsWith(`${line}\n`) || text.endsWith(`\n${line}`) || text.includes(`\n${line}\n`);
}

/**
 * Opt-in instrumentation for test harnesses: while an object is installed under this global symbol,
 * every recall (`toRecallText` call) and every inventory read (`getCommands()` call) is counted in it.
 * The Pi integration timing probe uses it to show startup does no recall work.
 */
const RECALL_COUNTERS = Symbol.for("pi-input-history.recall-counters");

function countRecallWork(kind: "normalizations" | "inventoryReads") {
  const counters = (globalThis as { [RECALL_COUNTERS]?: Record<string, number> })[RECALL_COUNTERS];
  if (counters) counters[kind] = (counters[kind] ?? 0) + 1;
}

/** The slice of a `pi.getCommands()` entry that identifies a loaded command. */
export type CommandInfo = { name?: unknown; source?: unknown; sourceInfo?: { path?: unknown } };

/** A point-in-time view of the loaded commands, used to decide whether a skill still resolves. */
export type SkillInventory = { resolves(name: string, location: string): boolean };

/**
 * An inventory over `getCommands()` (normally `pi.getCommands()`), read at most once, on the first
 * skill invocation that needs resolving. `/skill:NAME` resolves only when exactly one command has that
 * invocation name, it is a skill, and it was loaded from exactly the stored `location`; an extension
 * command with the same name would intercept the invocation. A failed read resolves nothing.
 */
export function commandInventory(getCommands: () => readonly CommandInfo[]): SkillInventory {
  let commands: readonly CommandInfo[] | undefined;
  return {
    resolves(name, location) {
      if (commands === undefined) {
        countRecallWork("inventoryReads");
        try {
          commands = getCommands();
        } catch {
          commands = [];
        }
      }
      const matches = commands.filter((c) => c?.name === `skill:${name}`);
      const [command] = matches;
      return matches.length === 1 && command!.source === "skill" && command!.sourceInfo?.path === location;
    },
  };
}

/**
 * Display text for a history record: `/skill:name arguments` for a resolvable invocation, else `text`.
 *
 * The arguments are the stored ones, shown as Pi's editor holds any text it is given (pi-tui
 * `Editor.normalizeText`): CRLF and CR become LF and a tab becomes four spaces. Reverse search accepts
 * through the editor's public setText, which applies exactly that, so every recall surface shows the
 * same text. Records that stay raw are returned unchanged.
 */
export function toRecallText(text: string, inventory: SkillInventory): string {
  countRecallWork("normalizations");
  try {
    const invocation = parseSkillInvocation(text);
    if (!invocation || !inventory.resolves(invocation.name, invocation.location)) return text;
    // One space: a newline would become part of the command name when Pi parses `/skill:NAME`.
    return invocation.args ? `/skill:${invocation.name} ${editorText(invocation.args)}` : `/skill:${invocation.name}`;
  } catch {
    return text;
  }
}

/** pi-tui Editor.normalizeText (Pi 0.87.1). */
function editorText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}
