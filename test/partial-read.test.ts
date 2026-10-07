import { describe, it, expect } from "vitest";
import { fileTextFromEvents, isPartialRead } from "../src/design/test-design.js";
import { ownTestTitles } from "../src/triage/settle.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * A range is not the file.
 *
 * `fs.read_file` grew `fromLine`/`toLine` so a spec too long for the context
 * budget could still be examined. Everything that reads "the file as this run
 * saw it" then had to learn that a read may be a fragment — and in
 * 20260928T093234Z one did not. The run's last read of the spec was lines
 * 328–370; `ownTestTitles` parsed that fragment, found no `@story:44` on
 * Story-c because Story-c is further down the file, and the report told the
 * story that one of its own failing tests belonged to another story.
 *
 * A fragment is worse than nothing: nothing degrades safely, a fragment answers
 * confidently about a file it has only part of.
 */

const SPEC = "tests/epic-42-customer-account-access.spec.ts";

const WHOLE = [
  "// @story:44 @design:D9",
  'test("Story-a — logout", async ({ page }) => {',
  "  await expect(page).toHaveURL(/\\/#\\/login/);",
  "});",
  "",
  "// @story:44 @design:D11",
  'test("Story-c — protected route redirects", async ({ page }) => {',
  "  await expect(page).toHaveURL(/\\/#\\/login/);",
  "});",
].join("\n");

/** Just the top of the file — Story-c is not in it. */
const FRAGMENT = WHOLE.split("\n").slice(0, 4).join("\n");

let id = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };

function read(content: string, range?: { fromLine: number; toLine: number }): AnyRunEvent[] {
  const callId = ++id;
  return [
    {
      ...base,
      eventId: callId,
      kind: "call",
      payload: {
        server: "fs",
        toolName: "read_file",
        args: { path: SPEC, ...(range ?? {}) },
        startedAt: 0,
      },
    },
    {
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: {
        eventIdOfCall: callId,
        ok: true,
        result: { path: SPEC, lines: 9, content, ...(range ?? {}) },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as unknown as AnyRunEvent[];
}

function context(): AnyRunEvent[] {
  const callId = ++id;
  return [
    {
      ...base,
      eventId: callId,
      kind: "call",
      payload: { server: "aqa", toolName: "story_context", args: {}, startedAt: 0 },
    },
    {
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: {
        eventIdOfCall: callId,
        ok: true,
        result: {
          kind: "preflight",
          summary: {},
          text: "story 44",
          facts: {
            acceptanceCriteria: [],
            bugs: [],
            filedBugs: [],
            tasks: [],
            story: { id: 44, title: "Log out" },
            epic: { id: 42, title: "Customer account access" },
          },
        },
        artefacts: [],
        durationMs: 1,
      },
    },
  ] as unknown as AnyRunEvent[];
}

describe("isPartialRead", () => {
  it("reads the range off the arguments", () => {
    expect(isPartialRead({ path: SPEC, fromLine: 1 }, {})).toBe(true);
    expect(isPartialRead({ path: SPEC, toLine: 9 }, {})).toBe(true);
    expect(isPartialRead({ path: SPEC }, { content: "x" })).toBe(false);
  });

  it("reads it off the result too, in case the arguments were normalised away", () => {
    expect(isPartialRead({ path: SPEC }, { fromLine: 4, toLine: 8, content: "x" })).toBe(true);
  });
});

describe("the file as the run saw it", () => {
  it("skips a ranged read and returns the last complete view", () => {
    const events = [...read(WHOLE), ...read(FRAGMENT, { fromLine: 1, toLine: 4 })];
    expect(fileTextFromEvents(events, SPEC)).toBe(WHOLE);
  });

  it("returns nothing when every read was a range — not the fragment", () => {
    const events = read(FRAGMENT, { fromLine: 1, toLine: 4 });
    expect(fileTextFromEvents(events, SPEC)).toBeUndefined();
  });

  it("still prefers the newest write over an older complete read", () => {
    const written = `${WHOLE}\n// added`;
    const callId = ++id;
    const events = [
      ...read(WHOLE),
      {
        ...base,
        eventId: callId,
        kind: "call",
        payload: {
          server: "fs",
          toolName: "write_file",
          args: { path: SPEC, content: written },
          startedAt: 0,
        },
      },
      {
        ...base,
        eventId: ++id,
        kind: "observation",
        payload: { eventIdOfCall: callId, ok: true, result: { path: SPEC }, artefacts: [], durationMs: 1 },
      },
    ] as unknown as AnyRunEvent[];
    expect(fileTextFromEvents(events, SPEC)).toBe(written);
  });
});

describe("whose tests are failing", () => {
  it("counts both of this story's tests after a ranged read of one of them", () => {
    const events = [...context(), ...read(WHOLE), ...read(FRAGMENT, { fromLine: 1, toLine: 4 })];
    const mine = ownTestTitles(events, "44");
    expect(mine?.has("Story-a — logout")).toBe(true);
    // The regression: this came back false, and the report announced that one of
    // story 44's own failing tests belonged to another story.
    expect(mine?.has("Story-c — protected route redirects")).toBe(true);
  });
});

describe("the diff baseline", () => {
  it("is never a fragment — a full write after a ranged read is judged against the whole file", () => {
    // Quarantine Story-a, then write the file back unchanged except for a
    // strengthening line. Judged against the FRAGMENT, Story-c's assertion
    // would look dropped and this honest write would be refused.
    const quarantine = {
      ...base,
      eventId: ++id,
      kind: "triage",
      payload: {
        attempt: 1,
        reportFingerprint: "f",
        runLevel: null,
        verdicts: [{ test: `${SPEC} › Story-a — logout`, category: "real-defect", confidence: 0.8 }],
        quarantined: ["Story-a — logout"],
      },
    } as unknown as AnyRunEvent;
    const events = [
      ...context(),
      ...read(WHOLE),
      quarantine,
      ...read(FRAGMENT, { fromLine: 1, toLine: 4 }),
    ];
    const strengthened = WHOLE.replace(
      "  await expect(page).toHaveURL(/\\/#\\/login/);\n});\n\n// @story:44 @design:D11",
      '  await expect(page).toHaveURL(/\\/#\\/login/);\n  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();\n});\n\n// @story:44 @design:D11',
    );
    const why = storyRefusal({ toolName: "fs.write_file", args: { path: SPEC, content: strengthened } }, events);
    expect(why ?? "").not.toContain("drops the claim");
  });
});
