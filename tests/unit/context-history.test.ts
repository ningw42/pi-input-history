import { describe, expect, test } from "bun:test";
import { activeContextHistory } from "../../src/context-history.ts";

type Entry = { id: string; messages: unknown[] };

function session(entries: Entry[]) {
  return { buildContextEntries: () => entries };
}
const project = (entry: unknown) => (entry as Entry).messages;
const user = (content: unknown) => ({ role: "user", content });

describe("active-context history", () => {
  test("yields user message text in context order", () => {
    const entries = [
      { id: "1", messages: [user("first")] },
      { id: "2", messages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }] },
      { id: "3", messages: [user([{ type: "text", text: "second" }])] },
    ];
    expect(activeContextHistory(session(entries), project)).toEqual(["first", "second"]);
  });

  test("joins every text block of a message without a separator, as Pi's editor preload does", () => {
    const content = [
      { type: "text", text: "part one," },
      { type: "image", data: "…", mimeType: "image/png" },
      { type: "text", text: " part two" },
    ];
    expect(activeContextHistory(session([{ id: "1", messages: [user(content)] }]), project)).toEqual([
      "part one, part two",
    ]);
  });

  test("skips non-user messages and user messages without text", () => {
    const entries = [
      { id: "1", messages: [{ role: "compactionSummary", summary: "earlier" }] },
      { id: "2", messages: [{ role: "custom", content: "shown to the model" }] },
      { id: "3", messages: [{ role: "toolResult", content: [{ type: "text", text: "output" }] }] },
      { id: "4", messages: [user([{ type: "image", data: "…", mimeType: "image/png" }])] },
      { id: "5", messages: [user(""), user([])] },
      { id: "6", messages: [] },
    ];
    expect(activeContextHistory(session(entries), project)).toEqual([]);
  });

  test("keeps text as stored, leaving trimming and duplicate handling to the editor", () => {
    const entries = [{ id: "1", messages: [user("  padded  "), user("same"), user("same")] }];
    expect(activeContextHistory(session(entries), project)).toEqual(["  padded  ", "same", "same"]);
  });

  test("projects only the entries the session selects for context", () => {
    const projected: string[] = [];
    const entries = [
      { id: "kept", messages: [user("kept")] },
      { id: "after", messages: [user("after")] },
    ];
    const result = activeContextHistory(session(entries), (entry) => {
      projected.push((entry as Entry).id);
      return (entry as Entry).messages;
    });
    expect(projected).toEqual(["kept", "after"]);
    expect(result).toEqual(["kept", "after"]);
  });
});
