import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openBugAbout } from "../src/triage/settle.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import { StoryToTestsVerifier } from "../src/verify/story-to-tests.js";
import type { StoryFacts } from "../src/design/test-design.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * The same failure, proposed as a bug again under another title.
 *
 * Bug #180 ("Contact form accessibility scan reports unlabeled message field")
 * was filed by run 20261113T123657Z. The next three runs of the story proposed
 * the same axe failure as "Contact form description field has no accessible
 * label", "Contact form message field is missing an accessible label", … — no
 * title close enough to the first for the title comparison, each put to the
 * reviewer, and each run ended BLOCKED when the reviewer answered "duplicate".
 */

const TEST = "AC-story Contact form passes accessibility checks";
const FILED = "Contact form accessibility scan reports unlabeled message field";
const TEXT =
  "Failure kind: Browser-reachable application assertion failure from the approved " +
  `accessibility test for story 176. Test: ${TEST} Open the guest website home page. ` +
  "ACTUAL: axe reported a critical label rule violation on one element: #description.";
const bug180 = { id: 180, state: "New", title: FILED, agent: true, text: TEXT };

describe("openBugAbout", () => {
  it("finds the open bug whose description names the failing test", () => {
    expect(openBugAbout(TEST, [bug180])?.id).toBe(180);
    // As the suite reports it, with the file and the describe block in front.
    expect(
      openBugAbout(`epic-88-guest-website.spec.ts › Guest website — Epic 88 › ${TEST}`, [bug180])
        ?.id,
    ).toBe(180);
  });

  it("finds nothing for another test, a closed bug, or a bug with no description", () => {
    expect(openBugAbout("AC-1 Home page shows the B&B name and description", [bug180])).toBe(
      undefined,
    );
    expect(openBugAbout(TEST, [{ ...bug180, state: "Closed" }])).toBeUndefined();
    expect(openBugAbout(TEST, [{ id: 180, state: "New", title: FILED, agent: true }])).toBe(
      undefined,
    );
  });

  it("does not identify a bug by a name too short to mean one test", () => {
    const login = { id: 9, state: "New", title: "Login fails", agent: true, text: "Test: Login" };
    expect(openBugAbout("Login", [login])).toBeUndefined();
  });
});

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
const facts = (filedBugs: StoryFacts["filedBugs"]): StoryFacts => ({
  acceptanceCriteria: ["AC-1"],
  bugs: [],
  tasks: [],
  story: { id: 176, title: "Contact form limits" },
  ...(filedBugs ? { filedBugs } : {}),
});
const run = (filedBugs: StoryFacts["filedBugs"], failing: string) => [
  ...pair(
    "aqa",
    "story_context",
    {},
    { kind: "preflight", summary: {}, text: "", facts: facts(filedBugs) },
  ),
  ...pair(
    "pw",
    "run_tests",
    { spec: "tests/x.spec.ts" },
    {
      green: false,
      passed: 8,
      failed: 1,
      tests: [{ title: failing, status: "failed" }],
      failures: [{ title: failing, message: "Error: axe violations — label (critical)" }],
    },
  ),
];
const propose = (title: string, repro: string) => ({
  toolName: "ado.wit_work_item_write",
  args: {
    action: "create",
    workItemType: "Bug",
    parentId: 176,
    fields: [
      { name: "System.Title", value: title },
      { name: "System.Tags", value: "agentic-qa" },
      { name: "Microsoft.VSTS.TCM.ReproSteps", format: "Html", value: repro },
    ],
  },
});
const REPRO =
  `<p><strong>Test:</strong> ${TEST}</p><p>EXPECTED: no violations. ACTUAL: label on #description.</p>` +
  "<p>Run 20261113T131724Z-302a2fd0</p>";

describe("a bug proposed for a failure that already has an open bug", () => {
  it("is refused with the existing bug's number, whatever its new title", () => {
    for (const title of [
      "Contact form description field has no accessible label",
      "Contact form message field is missing an accessible label",
    ]) {
      const reason = storyRefusal(propose(title, REPRO), run([bug180], TEST));
      expect(reason).toContain("#180 [New] already says this");
      expect(reason).toContain("filed by an earlier run of this runtime");
    }
  });

  it("is not refused for another failing test, or when the existing bug is closed", () => {
    const other = "AC-1 A phone number of 10 characters is refused with the stated message";
    const otherRepro = REPRO.replace(TEST, other);
    expect(
      storyRefusal(propose("Short phone number is accepted", otherRepro), run([bug180], other)) ??
        "",
    ).not.toContain("#180");
    expect(
      storyRefusal(
        propose("Contact form description field has no accessible label", REPRO),
        run([{ ...bug180, state: "Closed" }], TEST),
      ) ?? "",
    ).not.toContain("#180");
  });

  it("behaves as before on a ledger that did not record the bug's description", () => {
    const old = { id: 180, state: "New", title: FILED, agent: true };
    expect(
      storyRefusal(
        propose("Contact form description field has no accessible label", REPRO),
        run([old], TEST),
      ) ?? "",
    ).not.toContain("#180");
  });
});

/**
 * Run 20261113T133431Z, replayed: the story's only red test was the scan bug
 * #180 already recorded. The ledger is local and not committed; it has no bug
 * description in its facts (it predates this), so the one run 20261113T123657Z
 * filed is put where a preflight of today would have read it.
 */
const RUNS = join(__dirname, "..", ".aqa", "runs");
const RUN10 = join(RUNS, "20261113T133431Z-f4598e96", "events.jsonl");
const RUN8 = join(RUNS, "20261113T123657Z-5c6eb721", "events.jsonl");
const WS = join(__dirname, "..", "..", "..", "TestRunApplication", "booker");
const read = (file: string): AnyRunEvent[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AnyRunEvent);

describe.skipIf(!existsSync(RUN10) || !existsSync(RUN8) || !existsSync(WS))(
  "run 20261113T133431Z, replayed",
  () => {
    /** The description of bug #180 as run 8 wrote it. */
    const filedText = (): string => {
      const call = read(RUN8).find(
        (e) =>
          e.kind === "call" &&
          e.payload.toolName === "wit_work_item_write" &&
          e.payload.args["workItemType"] === "Bug",
      );
      if (!call || call.kind !== "call") throw new Error("run 8 filed no bug");
      const fields = call.payload.args["fields"] as Array<{ name: string; value: string }>;
      const html = fields.find((f) => f.name === "Microsoft.VSTS.TCM.ReproSteps")?.value ?? "";
      return html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 1500);
    };
    /** Run 10 with that description in its facts, up to and not including `before`. */
    const withText = (before: (e: AnyRunEvent) => boolean): AnyRunEvent[] => {
      const all = read(RUN10);
      const cut = all.findIndex(before);
      return (cut < 0 ? all : all.slice(0, cut)).map((e) => {
        const f = (e.payload as { result?: { facts?: StoryFacts } }).result?.facts;
        if (e.kind !== "observation" || !f?.filedBugs) return e;
        const filedBugs = f.filedBugs.map((b) =>
          String(b.id) === "180" ? { ...b, text: filedText() } : b,
        );
        return {
          ...e,
          payload: {
            ...e.payload,
            result: { ...(e.payload.result as object), facts: { ...f, filedBugs } },
          },
        } as AnyRunEvent;
      });
    };
    const isBugProposal = (e: AnyRunEvent) =>
      e.kind === "inference" &&
      (e.payload as { toolName?: string }).toolName?.endsWith("wit_work_item_write") === true;

    it("recorded bug #180 as open and agent-filed, and proposed it again under a new title", () => {
      const f = read(RUN10)
        .map((e) => (e.payload as { result?: { facts?: StoryFacts } }).result?.facts)
        .find((x) => x?.filedBugs);
      expect(f?.filedBugs?.find((b) => String(b.id) === "180")).toMatchObject({
        state: "New",
        agent: true,
      });
      expect(filedText()).toContain(TEST);
      const proposal = read(RUN10).find(isBugProposal);
      const args = (proposal?.payload as { args?: Record<string, unknown> }).args ?? {};
      expect(JSON.stringify(args)).toContain("Contact form message field is missing");
    });

    it("refuses that proposal now, naming #180", () => {
      const proposal = read(RUN10).find(isBugProposal);
      const args = (proposal?.payload as { args?: Record<string, unknown> }).args ?? {};
      const reason = storyRefusal(
        { toolName: "ado.wit_work_item_write", args },
        withText(isBugProposal),
      );
      expect(reason).toContain("#180 [New] already says this");
    });

    it("lets the run finish with the existing bug cited instead of a red suite to settle", async () => {
      const events = withText(isBugProposal);
      const v = await new StoryToTestsVerifier({
        workItem: "176",
        requireSuiteMembership: false,
        testTypes: ["functional", "accessibility", "security", "confirmation"],
      }).verify({ events, workspaceDir: WS });
      expect(v.gaps.map((g) => g.code)).not.toContain("suite-not-green");
      expect(v.limitations?.join("\n")).toContain(`"${TEST}" fails, and bug #180 [New] already`);
      // Without the description — the ledger as it was recorded — nothing ties
      // the failure to #180 and the suite is simply red.
      const asRecorded = read(RUN10);
      const cut = asRecorded.findIndex(isBugProposal);
      const before = await new StoryToTestsVerifier({
        workItem: "176",
        requireSuiteMembership: false,
        testTypes: ["functional", "accessibility", "security", "confirmation"],
      }).verify({ events: asRecorded.slice(0, cut), workspaceDir: WS });
      expect(before.limitations?.join("\n") ?? "").not.toContain("bug #180");
    });
  },
);

describe("the terminal report", () => {
  it("names the bug an earlier run filed for a test that is still failing", async () => {
    const { StageTracker } = await import("../src/runtime/stages.js");
    const stages = new StageTracker();
    const ev = (kind: string, payload: unknown) =>
      ({ ...base, eventId: ++n, kind, payload }) as unknown as AnyRunEvent;
    stages.line(
      ev("verify", {
        done: true,
        gaps: [],
        limitations: [
          `"${TEST}" fails, and bug #180 [New] already records it ("${FILED}") — filed by an ` +
            "earlier run and not yet confirmed by a person; no second bug is filed",
        ],
      }),
    );
    const report = stages.line(ev("end", { status: "done", summary: "", exitCode: 0 }));
    expect(report).toContain(`Already filed : #180 [New] — "${TEST}" still fails`);
    expect(report).not.toContain("Needs your decision");
  });
});
