import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseLedger } from "../src/ledger/ledger.js";
import { makeStoryRefusal } from "../src/skills/story-rules.js";
import { roleFor } from "../src/agents/roles.js";
import { asRecord } from "../src/verify/evidence.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Real runs, played through the whole rule chain (item 10 in
 * docs/ENGINE_MAP.md §11).
 *
 * The unit tests check each rule alone; the 18 Oct runs failed on how the rules
 * and roles met — a fix for one moment opened the next. These are the key
 * moments of two TOOL-6 runs, kept as trimmed ledgers, judged with exactly the
 * events that preceded them. A change that alters any of these decisions has
 * to say so here.
 */
function ledger(run: string): AnyRunEvent[] {
  const gz = readFileSync(join(__dirname, "fixtures", "ledgers", `${run}.jsonl.gz`));
  return parseLedger(gunzipSync(gz).toString("utf8"), run);
}

function judge(events: AnyRunEvent[], eventId: number): string | undefined {
  const i = events.findIndex((e) => e.eventId === eventId);
  const e = events[i] as AnyRunEvent;
  const p = e.payload as unknown as Record<string, unknown>;
  expect(e.kind).toBe("call");
  const refuse = makeStoryRefusal({ testTypes: ["functional", "accessibility"] });
  return refuse(
    {
      toolName: `${String(p["server"])}.${String(p["toolName"])}`,
      args: asRecord(p["args"]) ?? {},
    },
    events.slice(0, i),
  );
}

describe("run 20261018T223256Z (TOOL-6): the whack-a-mole run", () => {
  const events = ledger("20261018T223256Z-7a4b86d7");

  it("does not send an assertion failure to the heal role (event 116, F1)", () => {
    const i = events.findIndex((e) => e.eventId === 116);
    expect(roleFor(events.slice(0, i)).name).toBe("default");
  });

  it("refuses the edit that broke the passing AC-2 test (event 170)", () => {
    expect(judge(events, 170)).toMatch(/passed in the last full run/);
  });

  it("refuses the invented ?page=2 address check (event 187)", () => {
    expect(judge(events, 187)).toMatch(/checks the page address/);
  });

  it("lets the first real repair of AC-3 through (event 217)", () => {
    // Under the first repair cap (failing full runs) this was refused as a
    // "fourth guess". It was the first edit to AC-3's own steps: the runs
    // before it were set off by changes to AC-1 and AC-2. The cap counts
    // repairs to each test now (20261019T144404Z showed the same flaw).
    expect(judge(events, 217) ?? "").not.toMatch(/repairs\. Stop changing it/);
  });
});

describe("run 20261018T154651Z (TOOL-6)", () => {
  const events = ledger("20261018T154651Z-a7beba9c");

  it("refuses the address check the design never asked for (event 98)", () => {
    expect(judge(events, 98)).toMatch(/checks the page address/);
  });
});

describe("run 20261019T135539Z (TOOL-6): the first clean-gate attempt", () => {
  const events = ledger("20261019T135539Z-4090168d");

  it("asks for a new analysis of the rewritten feature instead of quoting the old one (event 87)", () => {
    const i = events.findIndex((e) => e.eventId === 87);
    const p = events[i]?.payload as unknown as Record<string, unknown>;
    expect(events[i]?.kind).toBe("inference");
    const why =
      makeStoryRefusal({ testTypes: ["functional", "accessibility"] })(
        { toolName: String(p["toolName"]), args: asRecord(p["args"]) ?? {} },
        events.slice(0, i),
      ) ?? "";
    expect(why).toContain("bdd2pw.analyze on it again");
    expect(why).not.toContain("cannot bind");
  });
});

describe("run 20261019T144404Z (TOOL-6): the second clean-gate attempt", () => {
  const events = ledger("20261019T144404Z-82c5035b");
  const proposal = (eventId: number) => {
    const i = events.findIndex((e) => e.eventId === eventId);
    const p = events[i]?.payload as unknown as Record<string, unknown>;
    expect(events[i]?.kind).toBe("inference");
    return (
      makeStoryRefusal({ testTypes: ["functional", "accessibility"] })(
        { toolName: String(p["toolName"]), args: asRecord(p["args"]) ?? {} },
        events.slice(0, i),
      ) ?? ""
    );
  };

  // The three failing tests had never been edited: the reruns between were set
  // off by a page-object URL and an import line. Their first repairs were
  // refused as "exhausted" and the run stopped.
  it.each([204, 207, 213])("lets the first repair of a failing test through (event %i)", (id) => {
    expect(proposal(id)).not.toMatch(/repairs\. Stop changing it|despite repairs/);
  });
});

describe("run 20261019T155404Z (TOOL-6): the third clean-gate attempt", () => {
  const events = ledger("20261019T155404Z-79a992bf");

  it("sends back the static items labelled state-transition at design time", async () => {
    const { validateDesign, parseDesign, storyFacts } = await import(
      "../src/design/test-design.js"
    );
    const call = events.find(
      (e) =>
        e.kind === "call" &&
        (e.payload as unknown as { toolName: string }).toolName === "test_design",
    );
    const args = asRecord((call?.payload as unknown as Record<string, unknown>)["args"]) ?? {};
    const facts = storyFacts(events);
    expect(facts).toBeDefined();
    const problems = validateDesign(parseDesign(args), facts!, [
      "functional",
      "security",
      "accessibility",
      "confirmation",
    ]);
    expect(problems.filter((p) => p.includes("needs an action")).map((p) => p.slice(0, 2))).toEqual(
      ["D1", "D3"],
    );
  });

  it("drops the three bugs because the test passed before the agent edited it", async () => {
    const { settleBugs } = await import("../src/triage/settle.js");
    const bugs = events
      .filter(
        (e) =>
          e.kind === "inference" &&
          (e.payload as unknown as { toolName: string }).toolName === "jira.create_bug",
      )
      .map((e) => ({
        toolName: "jira.create_bug",
        args: asRecord((e.payload as unknown as Record<string, unknown>)["args"]) ?? {},
      }));
    expect(bugs).toHaveLength(3);
    const s = settleBugs(bugs, events, { workItem: "TOOL-6", runLevel: null });
    expect(s.keep).toHaveLength(0);
    for (const d of s.drop) expect(d.reason).toContain("fails only since it was edited");
  });
});

describe("what the design says about the address counts (rule audit, 19 Oct)", () => {
  // The audit replayed 36 recorded runs: these designs DID speak of where the
  // browser goes, and their address checks were refused as inventions.
  const design = (expected: string) => ({
    items: [
      {
        id: "D1",
        covers: "AC-1",
        type: "functional",
        technique: "equivalence-partitioning",
        conditions: ["registered user"],
        expected,
        source: "AC-1",
      },
    ],
  });
  const facts = {
    acceptanceCriteria: ["AC-1: sign in"],
    bugs: [],
    tasks: [],
    story: { id: "SCRUM-6", title: "Login" },
    epic: { id: "SCRUM-5", title: "Customer account access" },
  };
  let n = 0;
  const base = { tool: "agentic-qa", runId: "r", timestamp: 1 };
  const pair = (
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    server = "aqa",
  ) => {
    const id = ++n;
    return [
      { ...base, eventId: id, kind: "call", payload: { server, toolName, args, startedAt: 0 } },
      {
        ...base,
        eventId: ++n,
        kind: "observation",
        payload: { eventIdOfCall: id, ok: true, result, artefacts: [], durationMs: 1 },
      },
    ] as unknown as AnyRunEvent[];
  };
  const spec = [
    'import { test, expect } from "@playwright/test";',
    "// @story:SCRUM-6 @ac:1 @design:D1",
    'test("AC-1: signs in", async ({ page }) => {',
    "  await expect(page).toHaveURL(/#\\/search/);",
    "});",
  ].join("\n");
  const refusedFor = (expected: string) =>
    makeStoryRefusal({ testTypes: ["functional"] })(
      {
        toolName: "fs.write_file",
        args: { path: "tests/epic-scrum-5-customer-account-access.spec.ts", content: spec },
      },
      [
        ...pair("story_context", {}, { kind: "preflight", summary: {}, text: "", facts }),
        ...pair("test_design", design(expected), { recorded: true }),
        ...pair("scaffold", {}, { ok: true }, "bdd2pw"),
      ],
    ) ?? "";

  it.each([
    "Browser navigates to the storefront home page",
    "User is navigated to the login page",
    "Page stays on /#/login and displays the generic error",
    "The customer is signed in and taken to the product list",
  ])("allows an address check when the design says %s", (expected) => {
    expect(refusedFor(expected)).not.toMatch(/checks the page address/);
  });

  it.each([
    "Page 2 is loaded and shows a different set of products",
    "The account menu shows Logout",
  ])("refuses it when the design says only %s", (expected) => {
    expect(refusedFor(expected)).toMatch(/checks the page address/);
  });
});

describe("Booker on Azure DevOps (20 Oct 2026)", () => {
  // Refused proposals have no call event; judge the model's proposal itself.
  const proposal = (events: AnyRunEvent[], eventId: number): string | undefined => {
    const i = events.findIndex((e) => e.eventId === eventId);
    const p = (events[i] as AnyRunEvent).payload as unknown as Record<string, unknown>;
    const refuse = makeStoryRefusal({ testTypes: ["functional", "accessibility"] });
    return refuse(
      { toolName: String(p["toolName"]), args: asRecord(p["args"]) ?? {} },
      events.slice(0, i),
    );
  };

  it("lets the run create its test cases — the test-plan tool cannot carry tags (200144Z #138)", () => {
    const events = ledger("20261020T200144Z-7c2e9f8c");
    expect(proposal(events, 138) ?? "").not.toContain("carries no");
  });

  it("lets the run take out the scan region it added itself (230547Z #53)", () => {
    const events = ledger("20261020T230547Z-0e7acbef");
    expect(proposal(events, 53) ?? "").not.toContain("execute path");
  });
});
