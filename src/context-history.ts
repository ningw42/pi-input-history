/**
 * The active-context history stream ("H"): the user prompts Pi's own editor preload would add for the
 * current session, reconstructed in memory when a replacement editor would otherwise miss it.
 *
 * Mirrors Pi's `renderInitialMessages` → `getUserMessageText` path: compaction-aware context entries,
 * projected to messages, keeping user messages with their text blocks joined by "".
 */

/**
 * Prompt texts in chronological order. Pass `ctx.sessionManager` and Pi's `sessionEntryToContextMessages`.
 * Texts are untrimmed and may repeat; `addToHistory` applies the editor's own trimming, duplicate, and cap rules.
 */
export function activeContextHistory<Entry>(
  session: { buildContextEntries(): readonly Entry[] },
  project: (entry: Entry) => readonly unknown[],
): string[] {
  const texts: string[] = [];
  for (const entry of session.buildContextEntries()) {
    for (const message of project(entry)) {
      const text = userMessageText(message);
      if (text) texts.push(text);
    }
  }
  return texts;
}

function userMessageText(message: unknown): string {
  const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
  if (role !== "user") return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: unknown } | null)?.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
}
