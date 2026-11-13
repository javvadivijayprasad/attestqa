import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedItems,
  changedScenariosWithoutATest,
  untouchedChangedItems,
  untouchedLine,
  type ChangedAtSwitch,
} from "../src/design/cases.js";
import { storyTextHash } from "../src/design/fingerprint.js";
import {
  approvedDesign,
  featurePathFor,
  parseDesign,
  previousDesign,
  specPathFor,
  storyFacts,
  type StoryFacts,
} from "../src/design/test-design.js";
import { TestDesignTools } from "../src/mcp/adapters/test-design.js";
import { roleFor } from "../src/agents/roles.js";
import {
  appendOnlyAfterReroute,
  appendOnlySpec,
  editsAPassingTest,
} from "../src/skills/story-rules.js";
import {
  storyToTestsSkill,
  TURNS_TO_UPDATE_CHANGED,
  waitingForChangedTests,
} from "../src/skills/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * A story changes, a person approves a design that says so under the same item
 * ids, and the tests on disk still check what the items expected before.
 *
 * Run 20261113T014353Z (Booker, AB#176): the criteria had been rewritten to
 * quote the application's messages. `aqa.test_design` answered "every item is
 * already tested … do not rewrite the feature file or the spec", the suite
 * failed five tests on the old wording, the failures were sent to the locator
 * healer, and nothing was changed.
 */

const OLD_MSG = "size must be between 11 and 21";
const NEW_MSG = "Phone must be between 11 and 21 characters.";

const FACTS: StoryFacts = {
  acceptanceCriteria: ["AC-1", "AC-2"],
  bugs: [],
  tasks: [],
  story: { id: 176, title: "Contact form limits" },
  epic: { id: 88, title: "Guest website" },
  textHash: storyTextHash(`AC-1: refused with "${NEW_MSG}"`, ""),
};
const OLD_FACTS: StoryFacts = {
  ...FACTS,
  textHash: storyTextHash("AC-1: refused with a message giving the range", ""),
};

const PHONE = "AC-1 A phone number outside 11 to 21 characters is refused";
const NAME = "AC-2 The name is required";
const OTHER = "AC-1 Home page shows the name";
const FEATURE = [
  "Feature: Guest website",
  "",
  "  @story:91 @ac:1 @design:D1 @type:functional",
  `  Scenario: ${OTHER}`,
  "    Given I navigate to the home page",
  "",
  "  @story:176 @ac:1 @design:D5 @type:functional",
  `  Scenario: ${PHONE}`,
  '    When I enter a phone of "1234567890"',
  `    Then the page displays "${OLD_MSG}"`,
  "",
  "  @story:176 @ac:2 @design:D6 @type:functional",
  `  Scenario: ${NAME}`,
  "    When I leave the name empty",
  '    Then the page displays "Name may not be blank"',
  "",
].join("\n");
const SPEC = [
  'import { test, expect } from "@playwright/test";',
  "// @story:91 @ac:1 @design:D1",
  `test("${OTHER}", async ({ page }) => {`,
  "  await expect(page).toHaveTitle(/x/);",
  "});",
  "// @story:176 @ac:1 @design:D5",
  `test("${PHONE}", async ({ page }) => {`,
  `  await expect(page.getByText("${OLD_MSG}")).toBeVisible();`,
  "});",
  "// @story:176 @ac:2 @design:D6",
  `test("${NAME}", async ({ page }) => {`,
  '  await expect(page.getByText("Name may not be blank")).toBeVisible();',
  "});",
].join("\n");
const FEATURE_PATH = "features/epic-88-guest-website.feature";
const SPEC_PATH = "tests/epic-88-guest-website.spec.ts";

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "aqa-changed-"));
  mkdirSync(join(ws, "features"));
  mkdirSync(join(ws, "tests"));
  writeFileSync(join(ws, "playwright.config.ts"), 'export default { testDir: "tests" };');
  writeFileSync(join(ws, FEATURE_PATH), FEATURE);
  writeFileSync(join(ws, SPEC_PATH), SPEC);
  return ws;
}

const item = (id: string, covers: string, expected: string) => ({
  id,
  covers,
  type: "functional",
  technique: "equivalence-partitioning",
  conditions: ["one value outside the range"],
  expected,
  source: covers,
});
const OLD_DESIGN = {
  items: [
    item("D5", "AC-1", "refused with a message giving the range 11 to 21"),
    item("D6", "AC-2", "an empty name is refused"),
  ],
};
const NEW_DESIGN = {
  items: [
    item("D5", "AC-1", `refused with the message "${NEW_MSG}"`),
    item("D6", "AC-2", "an empty name is refused"),
  ],
};

let n = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
const pair = (
  server: string,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): AnyRunEvent[] => {
  const id = ++n;
  return [
    { ...base, eventId: id, kind: "call", payload: { server, toolName, args, startedAt: 0 } },
    {
      ...base,
      eventId: ++n,
      kind: "observation",
      payload: { eventIdOfCall: id, ok: true, result, artefacts: [], durationMs: 1 },
    },
  ] as AnyRunEvent[];
};
const preflight = (facts: StoryFacts) =>
  pair("aqa", "story_context", {}, { kind: "preflight", summary: {}, text: "", facts });
const routeEvent = (d: { path?: string; reason?: string; because?: unknown; deny?: string[] }) =>
  ({
    ...base,
    eventId: ++n,
    kind: "route",
    payload: { path: d.path, reason: d.reason, because: d.because, denied: d.deny },
  }) as unknown as AnyRunEvent;
/** One turn of the agent: the loop records one `context` event per turn. */
const turn = () =>
  ({
    ...base,
    eventId: ++n,
    kind: "context",
    payload: { sections: [], totalTokens: 0 },
  }) as unknown as AnyRunEvent;
const end = () =>
  ({
    ...base,
    eventId: ++n,
    kind: "end",
    payload: { status: "done", summary: "", exitCode: 0 },
  }) as unknown as AnyRunEvent;

/** The earlier run: old wording, old design, suite run, ended. */
const priorRun = () => ({
  runId: "20261112T230358Z",
  events: [
    ...preflight(OLD_FACTS),
    ...pair("aqa", "test_design", OLD_DESIGN, { recorded: true }),
    ...pair(
      "pw",
      "run_tests",
      { spec: SPEC_PATH },
      { tests: [{ title: PHONE, status: "failed" }] },
    ),
    end(),
  ],
});

const skillFor = (ws: string) =>
  storyToTestsSkill({
    workItem: "176",
    tracker: "ado",
    workspaceDir: ws,
    testTypes: ["functional"],
    previousRuns: () => [priorRun()],
  });

/** This run up to its first route, then with the new design approved. */
function started(ws: string) {
  const skill = skillFor(ws);
  const events = preflight(FACTS);
  const first = skill.route?.(events);
  if (!first) throw new Error("no route");
  const routed = [...events, routeEvent(first)];
  const designed = [...routed, ...pair("aqa", "test_design", NEW_DESIGN, { recorded: true })];
  return { skill, first, routed, designed };
}

describe("changedItems", () => {
  const covered = new Map([
    ["D5", { scenario: PHONE }],
    ["D6", { scenario: NAME }],
  ]);

  it("names the items that have a test written for an earlier expectation", () => {
    const changed = changedItems(parseDesign(NEW_DESIGN), covered, parseDesign(OLD_DESIGN));
    expect(changed.map((c) => c.id)).toEqual(["D5"]);
    expect(changed[0]?.was).toContain("a message giving the range");
    expect(changed[0]?.now).toContain(NEW_MSG);
    expect(changed[0]?.scenario).toBe(PHONE);
  });

  it("is empty with no earlier design, for a new item, and for the same words respaced", () => {
    expect(changedItems(parseDesign(NEW_DESIGN), covered)).toEqual([]);
    // D5 has no test yet: it is new work, not a changed test.
    expect(
      changedItems(parseDesign(NEW_DESIGN), new Map([["D6", { scenario: NAME }]]), {
        ...parseDesign(OLD_DESIGN),
      }),
    ).toEqual([]);
    const respaced = {
      items: [
        item("D5", "AC-1", "Refused with a message   giving the range 11 to 21 "),
        item("D6", "AC-2", "an empty name is refused"),
      ],
    };
    expect(changedItems(parseDesign(respaced), covered, parseDesign(OLD_DESIGN))).toEqual([]);
  });

  it("does not call an item changed for punctuation, an article or reworded conditions", () => {
    // 20261113T124917Z (AB#91): the story had not changed and four of four
    // items were reported changed.
    const before = {
      items: [
        {
          ...item("D5", "AC-1", "The home page lists rooms, each with its type, a picture"),
          conditions: ["Visitor opens the home page"],
        },
      ],
    };
    const after = {
      items: [
        {
          ...item("D5", "AC-1", "The home page lists the rooms, each with its type, a picture."),
          conditions: ["A read-only visitor opens the public home page; no state is mutated."],
        },
      ],
    };
    const one = new Map([["D5", { scenario: PHONE }]]);
    expect(changedItems(parseDesign(after), one, parseDesign(before))).toEqual([]);
  });

  it("does not compare two items that only share an id", () => {
    const before = { items: [{ ...item("D5", "story", "no violations"), type: "accessibility" }] };
    const after = { items: [item("D5", "AC-1", "each product shows its own picture")] };
    const one = new Map([["D5", { scenario: PHONE }]]);
    expect(changedItems(parseDesign(after), one, parseDesign(before))).toEqual([]);
  });

  it("calls an item changed when a number in its conditions moves", () => {
    const at = (max: number) => ({
      items: [
        {
          ...item("D5", "AC-1", "a phone outside the range is refused"),
          conditions: [`Phone length 10, 11, ${max} and ${max + 1} characters`],
        },
      ],
    });
    const one = new Map([["D5", { scenario: PHONE }]]);
    expect(changedItems(parseDesign(at(25)), one, parseDesign(at(21))).map((c) => c.id)).toEqual([
      "D5",
    ]);
    expect(changedItems(parseDesign(at(21)), one, parseDesign(at(21)))).toEqual([]);
  });
});

describe("changedScenariosWithoutATest", () => {
  // 20261113T131724Z: D5's scenario was split in two under new titles, the
  // spec was not touched, the old test passed and the run was accepted.
  const SPLIT = FEATURE.replace(
    `  Scenario: ${PHONE}`,
    [
      "  Scenario: AC-1a A phone number of 11 characters is accepted",
      "    When I enter a phone of 11 characters",
      "",
      "  @story:176 @ac:1 @design:D5 @type:functional",
      "  Scenario: AC-1b A short phone number is refused and no confirmation is shown",
    ].join("\n"),
  );

  it("names a rewritten scenario of a changed item that no test is named after", () => {
    expect(changedScenariosWithoutATest(["D5"], SPLIT, SPEC, 176)).toEqual([
      { id: "D5", scenario: "AC-1a A phone number of 11 characters is accepted" },
      {
        id: "D5",
        scenario: "AC-1b A short phone number is refused and no confirmation is shown",
      },
    ]);
  });

  it("is silent when the tests follow, for unchanged items, and for other stories", () => {
    const followed = SPEC.replace(
      `test("${PHONE}"`,
      'test("AC-1a A phone number of 11 characters is accepted", async () => {});\n' +
        'test("AC-1b A short phone number is refused and no confirmation is shown"',
    );
    expect(changedScenariosWithoutATest(["D5"], SPLIT, followed, 176)).toEqual([]);
    expect(changedScenariosWithoutATest(["D5"], FEATURE, SPEC, 176)).toEqual([]);
    expect(changedScenariosWithoutATest([], SPLIT, SPEC, 176)).toEqual([]);
    // D1 belongs to story 91: not this run's, whatever its id.
    expect(changedScenariosWithoutATest(["D1"], FEATURE, "", 176)).toEqual([]);
  });
});

describe("a story that changed, with tests on disk", () => {
  it("records the earlier design on the first route", () => {
    const { first, routed } = started(workspace());
    expect(first.path).toBe("B");
    expect(first.reason).toContain("the story changed since run 20261112T230358Z");
    const earlier = previousDesign(routed);
    expect(earlier?.runId).toBe("20261112T230358Z");
    expect(earlier?.design.items.map((i) => i.id)).toEqual(["D5", "D6"]);
  });

  it("does none of this when the earlier run did not record the story's wording", () => {
    // 20261113T130619Z: whether the story changed could not be known; the
    // comparison found only rewording, and a passing test lost an assertion.
    const ws = workspace();
    const before = priorRun();
    const noWording = {
      ...before,
      events: before.events.map((e) =>
        e.kind === "observation" && (e.payload.result as { facts?: unknown } | null)?.facts
          ? ({
              ...e,
              payload: {
                ...e.payload,
                result: {
                  ...(e.payload.result as object),
                  facts: { ...OLD_FACTS, textHash: undefined },
                },
              },
            } as AnyRunEvent)
          : e,
      ),
    };
    const skill = storyToTestsSkill({
      workItem: "176",
      tracker: "ado",
      workspaceDir: ws,
      testTypes: ["functional"],
      previousRuns: () => [noWording],
    });
    const events = preflight(FACTS);
    const first = skill.route?.(events);
    expect(first?.reason).toContain("whether the story changed since cannot be known");
    const designed = [
      ...events,
      routeEvent(first ?? {}),
      ...pair("aqa", "test_design", NEW_DESIGN, { recorded: true }),
    ];
    expect(previousDesign(designed)).toBeUndefined();
    expect(skill.reroute?.(designed)).toBeUndefined();
    expect(skill.autoRun?.(designed)?.toolName).toBe("pw.run_tests");
  });

  it("says in the design tool's answer which tests to change, not that all is tested", async () => {
    const ws = workspace();
    const { routed } = started(ws);
    const tools = new TestDesignTools({ read: () => routed } as never, ["functional"], ws);
    const r = (await tools.call("aqa", "test_design", NEW_DESIGN)).result as Record<
      string,
      unknown
    >;
    expect(r["alreadyTested"]).toEqual([`D6 → ${NAME}`]);
    expect(String((r["changedItems"] as string[])[0])).toContain("D5");
    expect(String((r["changedItems"] as string[])[0])).toContain(NEW_MSG);
    expect(String(r["next"])).toContain("1 item(s) changed since the design approved in run");
    expect(String(r["next"])).not.toContain("Do not rewrite the feature file or the spec");
  });

  it("still says so when nothing changed", async () => {
    const ws = workspace();
    const { routed } = started(ws);
    const tools = new TestDesignTools({ read: () => routed } as never, ["functional"], ws);
    const r = (await tools.call("aqa", "test_design", OLD_DESIGN)).result as Record<
      string,
      unknown
    >;
    expect(r["changedItems"]).toBeUndefined();
    expect(String(r["next"])).toContain("Every item is already tested");
  });

  it("switches the run to changing those tests, and locks every other scenario", () => {
    const ws = workspace();
    const { skill, designed } = started(ws);
    const again = skill.reroute?.(designed);
    expect(again?.path).toBe("A2");
    expect(again?.reason).toContain("changes 1 item(s) that already have a test (D5)");
    expect(again?.because["changed"]).toMatchObject([{ id: "D5", scenario: PHONE }]);
    expect(again?.because["missing"]).toEqual([]);
    const locked = (again?.because["locked"] as Array<{ scenario: string }>).map((l) => l.scenario);
    expect(locked).toEqual([OTHER, NAME]);
    // Nothing is generated for a changed item.
    expect(again?.deny).toContain("bdd2pw.scaffold");
    expect(again?.deny).not.toContain("aqa.test_design");
    // Decided once.
    const switched = [...designed, routeEvent(again ?? {})];
    expect(skill.reroute?.(switched)).toBeUndefined();
    // 20261113T131724Z: rewriting the changed scenario under a new title leaves
    // D5 without a test for a moment. That is not a new item to add.
    writeFileSync(
      join(ws, FEATURE_PATH),
      FEATURE.replace(`Scenario: ${PHONE}`, "Scenario: AC-1b A short phone number is refused"),
    );
    expect(skill.reroute?.(switched)).toBeUndefined();
  });

  it("does not switch when the approved design says what the earlier one said", () => {
    const { skill, routed } = started(workspace());
    const same = [...routed, ...pair("aqa", "test_design", OLD_DESIGN, { recorded: true })];
    expect(skill.reroute?.(same)).toBeUndefined();
  });

  it("holds the suite until the agent has written to it, or has had its turns", () => {
    const { skill, designed } = started(workspace());
    const again = skill.reroute?.(designed);
    const switched = [...designed, routeEvent(again ?? {})];
    expect(waitingForChangedTests(switched)).toBe(true);
    expect(skill.autoRun?.(switched)).toBeUndefined();

    // A read is not a change.
    const read = [...switched, turn(), ...pair("fs", "read_file", { path: SPEC_PATH }, {})];
    expect(skill.autoRun?.(read)).toBeUndefined();

    const wrote = [
      ...read,
      turn(),
      ...pair("fs", "replace_in_file", { path: SPEC_PATH, old: OLD_MSG, new: NEW_MSG }, {}),
    ];
    expect(waitingForChangedTests(wrote)).toBe(false);
    expect(skill.autoRun?.(wrote)?.toolName).toBe("pw.run_tests");

    // No write at all: after its turns the suite runs anyway.
    const idle = [...switched, ...Array.from({ length: TURNS_TO_UPDATE_CHANGED }, turn)];
    expect(skill.autoRun?.(idle)?.toolName).toBe("pw.run_tests");
  });

  it("does not hold the suite on the execute path with nothing changed", () => {
    const { skill, routed } = started(workspace());
    const same = [...routed, ...pair("aqa", "test_design", OLD_DESIGN, { recorded: true })];
    expect(waitingForChangedTests(same)).toBe(false);
    expect(skill.autoRun?.(same)?.toolName).toBe("pw.run_tests");
  });

  it("lets the changed scenario be rewritten and no other", () => {
    const ws = workspace();
    const { skill, designed } = started(ws);
    const switched = [...designed, routeEvent(skill.reroute?.(designed) ?? {})];
    const write = (content: string) =>
      appendOnlyAfterReroute(
        { toolName: "fs.write_file", args: { path: FEATURE_PATH, content } },
        switched,
        ws,
      );
    expect(write(FEATURE.replace(OLD_MSG, NEW_MSG))).toBeUndefined();
    const refused = write(FEATURE.replace("Name may not be blank", "Name is required"));
    expect(refused).toContain(`"${NAME}"`);
    expect(refused).toContain("this run adds no scenario");
    expect(refused).toContain("(D5)");
    // Another story's scenario stays locked as before.
    expect(write(FEATURE.replace("Given I navigate to the home page", "Given x"))).toContain(
      `"${OTHER}"`,
    );
  });

  it("lets the changed item's test replace its assertion, and no other test", () => {
    const ws = workspace();
    const { skill, designed } = started(ws);
    const switched = [...designed, routeEvent(skill.reroute?.(designed) ?? {})];
    const write = (content: string) =>
      appendOnlySpec(
        { toolName: "fs.write_file", args: { path: SPEC_PATH, content } },
        switched,
        ws,
      );
    // 20261113T122522Z: the expected text sat in the expect line itself.
    expect(write(SPEC.replace(OLD_MSG, NEW_MSG))).toBeUndefined();
    const refused = write(SPEC.replace("Name may not be blank", "Name is required"));
    expect(refused).toContain("would lose an assertion");
    expect(refused).toContain(`"${NAME}"`);
  });

  it("reports a changed item whose scenario and test were never touched", () => {
    // 20261113T133431Z: the item had gained a requirement, the old test still
    // passed, nothing was changed and the run was accepted.
    const ws = workspace();
    const { skill, designed } = started(ws);
    const again = skill.reroute?.(designed);
    const atSwitch = again?.because["changed"] as ChangedAtSwitch[];
    expect(atSwitch[0]?.body).toContain(OLD_MSG);
    expect(atSwitch[0]?.test).toMatch(/^[0-9a-f]{12}$/);

    expect(untouchedChangedItems(atSwitch, FEATURE, SPEC).map((c) => c.id)).toEqual(["D5"]);
    const line = untouchedLine(atSwitch[0] as ChangedAtSwitch);
    expect(line).toContain("before: refused with a message giving the range 11 to 21");
    expect(line).toContain(NEW_MSG);
    // Changing the test, or the scenario, is enough to take it off the list:
    // whether the change is right is the other checks' business.
    expect(untouchedChangedItems(atSwitch, FEATURE, SPEC.replace(OLD_MSG, NEW_MSG))).toEqual([]);
    expect(untouchedChangedItems(atSwitch, FEATURE.replace(OLD_MSG, NEW_MSG), SPEC)).toEqual([]);
    // Another test changing does not count for this one.
    expect(
      untouchedChangedItems(atSwitch, FEATURE, SPEC.replace("Name may not be blank", "x")).map(
        (c) => c.id,
      ),
    ).toEqual(["D5"]);
  });

  it("lets the changed item's test be changed after it has passed, and no other", () => {
    // 20261113T134043Z: the suite ran first, the old test passed, and the
    // edit that added the new requirement was refused.
    const ws = workspace();
    const { skill, designed } = started(ws);
    const switched = [
      ...designed,
      routeEvent(skill.reroute?.(designed) ?? {}),
      ...pair(
        "pw",
        "run_tests",
        { spec: SPEC_PATH },
        {
          green: false,
          tests: [
            { title: PHONE, status: "passed" },
            { title: NAME, status: "passed" },
            { title: OTHER, status: "failed" },
          ],
        },
      ),
    ];
    const write = (content: string) =>
      editsAPassingTest(
        { toolName: "fs.write_file", args: { path: SPEC_PATH, content } },
        switched,
        ws,
        "176",
      );
    expect(write(SPEC.replace(OLD_MSG, NEW_MSG))).toBeUndefined();
    expect(write(SPEC.replace("Name may not be blank", "Name is required"))).toContain(
      "passed in the last full run",
    );
  });

  it("does not take the tags above the next test for a change to the passing test before it", () => {
    // 20261113T134043Z: `// @bug:180` added above the failing test was refused
    // three times as a change to the passing test that precedes it.
    const ws = workspace();
    const { designed } = started(ws);
    const ran = [
      ...designed,
      ...pair(
        "pw",
        "run_tests",
        { spec: SPEC_PATH },
        {
          green: false,
          tests: [
            { title: OTHER, status: "passed" },
            { title: PHONE, status: "failed" },
            { title: NAME, status: "passed" },
          ],
        },
      ),
    ];
    const write = (content: string) =>
      editsAPassingTest(
        { toolName: "fs.write_file", args: { path: SPEC_PATH, content } },
        ran,
        ws,
        "176",
      );
    // The comment sits after OTHER's closing brace and before PHONE's test line.
    const tagged = SPEC.replace(
      "// @story:176 @ac:1 @design:D5",
      "// @story:176 @ac:1 @design:D5\n// @bug:180",
    );
    expect(tagged).not.toBe(SPEC);
    expect(write(tagged)).toBeUndefined();
    // A change inside the passing test is still refused.
    expect(write(SPEC.replace("toHaveTitle(/x/)", "toHaveTitle(/y/)"))).toContain(
      "passed in the last full run",
    );
  });

  it("does not send a changed item's failing test to the locator healer", () => {
    const { skill, designed } = started(workspace());
    const failure = (title: string, text: string) => ({
      title,
      message:
        `Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('${text}').first()\n` +
        "Expected: visible\nError: element(s) not found\n\nCall log:\n" +
        `  - waiting for getByText('${text}').first()`,
    });
    const run = (events: AnyRunEvent[], f: { title: string; message: string }) => [
      ...events,
      ...pair("pw", "run_tests", { spec: SPEC_PATH }, { failed: 1, failures: [f] }),
    ];
    const switched = [...designed, routeEvent(skill.reroute?.(designed) ?? {})];
    expect(roleFor(run(switched, failure(PHONE, OLD_MSG)), 176).name).toBe("default");
    // An unchanged item's test that loses its element is still a heal.
    expect(roleFor(run(switched, failure(NAME, "Name may not be blank")), 176).name).toBe("heal");
    // And without the switch the changed test would have gone there — run 6.
    expect(roleFor(run(designed, failure(PHONE, OLD_MSG)), 176).name).toBe("heal");
  });
});

/**
 * Run 20261113T014353Z, replayed against a copy of the two files as they were.
 * The ledger is under the local ledger root and is not committed; the test runs
 * where it exists.
 */
const RUN6 = "20261113T014353Z-f537c2d4";
const RUN4 = "20261112T230358Z-8e528bb0";
const ledgerOf = (runId: string) => join(__dirname, "..", ".aqa", "runs", runId, "events.jsonl");
const readLedger = (runId: string): AnyRunEvent[] =>
  readFileSync(ledgerOf(runId), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AnyRunEvent);

describe.skipIf(!existsSync(ledgerOf(RUN6)) || !existsSync(ledgerOf(RUN4)))(
  "run 20261113T014353Z, replayed",
  () => {
    it("finds the items whose expectation changed, which the run called already tested", () => {
      const all = readLedger(RUN6);
      const designCall = all.find((e) => e.kind === "call" && e.payload.toolName === "test_design");
      const answer = all.find(
        (e) => e.kind === "observation" && e.payload.eventIdOfCall === designCall?.eventId,
      );
      // What the run was told.
      expect(JSON.stringify(answer?.payload)).toContain("Every item is already tested");

      const now = approvedDesign(all);
      const before = approvedDesign(readLedger(RUN4));
      const facts = storyFacts(all);
      if (!now || !before || !facts) throw new Error("the ledgers lack a design or the facts");
      // Every item had a scenario: that is what "already tested" rested on.
      const told = (answer?.payload as { result?: { alreadyTested?: string[] } }).result;
      const covered = new Map(
        (told?.alreadyTested ?? []).map((l) => {
          const [id, scenario] = l.split(" → ");
          return [String(id), { scenario: String(scenario) }] as const;
        }),
      );
      expect(covered.size).toBe(now.items.length);
      expect(featurePathFor(facts)).toBe(FEATURE_PATH);
      expect(specPathFor(facts)).toBe(SPEC_PATH);

      const changed = changedItems(now, covered, before);
      // D8, the accessibility item, expects what it did before in other words.
      // A reworded item is "changed" too, and its test needs nothing — which is
      // why the suite is held for a few turns rather than until every test moves.
      expect(changed.map((c) => c.id).sort()).toEqual(["D5", "D6", "D7", "D8", "D9"]);
      expect(changed.find((c) => c.id === "D5")?.now).toContain(
        "Phone must be between 11 and 21 characters.",
      );
      expect(changed.find((c) => c.id === "D5")?.was).not.toContain("Phone must be between");
    });

    it("no longer makes the heal role the answer to those failures once the run has switched", () => {
      const all = readLedger(RUN6);
      const heal = all.find(
        (e) => e.kind === "agent" && (e.payload as { role?: string }).role === "heal",
      );
      expect(heal).toBeDefined(); // what happened
      const upTo = all.filter((e) => e.eventId < (heal?.eventId ?? 0));
      const failing = [
        "AC-1 A phone number of 11 to 21 characters is accepted; one of 10 or of 22 characters is refused with a message giving the range 11 to 21",
        "AC-2 A message of 20 to 2000 characters is accepted; one of 19 characters is refused with a message giving the range 20 to 2000",
        "AC-3 A subject of 5 to 100 characters is accepted; one of 4 or of 101 characters is refused with a message giving the range 5 to 100",
        "AC-2 Message longer than 2000 characters is refused with the stated range",
      ];
      const switched = [
        ...upTo,
        {
          ...base,
          runId: RUN6,
          eventId: (heal?.eventId ?? 0) - 0.5,
          kind: "route",
          payload: {
            path: "A2",
            reason: "",
            because: {
              from: "B",
              appendOnly: true,
              missing: [],
              changed: failing.map((scenario, i) => ({ id: `D${i}`, scenario })),
              locked: [],
            },
            denied: [],
          },
        } as unknown as AnyRunEvent,
      ];
      expect(roleFor(upTo, 176).name).toBe("heal");
      expect(roleFor(switched, 176).name).toBe("default");
    });
  },
);
