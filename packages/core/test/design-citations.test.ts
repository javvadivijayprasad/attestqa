import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  citationProblems,
  citationsNotIn,
  citedPassages,
  designCitations,
  MIN_QUOTE_CHARS,
  quotable,
  quoteIn,
  returnedPassages,
} from "../src/design/citations.js";
import { parseDesign, renderDesign, type StoryFacts } from "../src/design/test-design.js";
import { makeStoryRefusal } from "../src/skills/story-rules.js";
import { storyToTestsInstructions, storyToTestsSkill } from "../src/skills/story-to-tests.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * A design item that takes a value from a project document cites the passage
 * and quotes it, and both are checked in code (ADR-008 §6), the third slice of
 * 2.4.0.
 *
 * Booker #92, 20261116T150143Z: the story says a phone number "shorter than
 * the allowed length" is refused. The agent searched the project's documents,
 * found "Phone must be between 11 and 21 characters." and cited the passage in
 * the item's source — and nothing but a person reading the file could tell
 * whether the passage was real or said that.
 */
const PHONE = "docs/requirements/contact-form.md#phone@4f4d527a";
const MESSAGE = "docs/requirements/contact-form.md#message@f8825370";
const PHONE_TEXT = [
  "A phone number must be 11 to 21 characters long.",
  "",
  "When it is shorter or longer, the form is not sent and this message is shown:",
  "",
  "> Phone must be between 11 and 21 characters.",
].join("\n");
const passage = (id: string, text: string, heading: string) => ({
  label: "D1",
  id,
  file: "docs/requirements/contact-form.md",
  heading: `Contact form — validation rules > ${heading}`,
  lines: "9-15",
  modified: "2026-11-16",
  rank: 1,
  score: 1.4,
  text,
});

let n = 0;
const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1 };
const pair = (
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  ok = true,
): AnyRunEvent[] => {
  const id = ++n;
  return [
    {
      ...base,
      eventId: id,
      kind: "call",
      payload: {
        server: tool.split(".")[0],
        toolName: tool.slice(tool.indexOf(".") + 1),
        args,
        startedAt: 0,
      },
    },
    {
      ...base,
      eventId: ++n,
      kind: "observation",
      payload: { eventIdOfCall: id, ok, result, artefacts: [], durationMs: 1 },
    },
  ] as unknown as AnyRunEvent[];
};
const FACTS: StoryFacts = {
  acceptanceCriteria: ["AC-1"],
  bugs: [],
  tasks: [],
  story: { id: 92, title: "Visitor is told what is wrong with the contact form" },
  epic: { id: 88, title: "Guest website" },
};
const CONTEXT = pair(
  "aqa.story_context",
  {},
  {
    kind: "preflight",
    summary: {},
    text: [
      "STORY 92 [User Story, New] Visitor is told what is wrong with the contact form",
      "Acceptance criteria:",
      "  AC-1: A phone number shorter than the allowed length is refused with a message giving the allowed length.",
    ].join("\n"),
    facts: FACTS,
  },
);
const SEARCH = pair(
  "docs.search",
  { query: "phone length" },
  { notice: "…", query: "phone length", found: 1, passages: [passage(PHONE, PHONE_TEXT, "Phone")] },
);
const item = (over: Record<string, unknown> = {}) => ({
  id: "D10",
  covers: "AC-1",
  type: "functional",
  technique: "boundary-value-analysis",
  conditions: ["Phone is 10 characters, one below the documented minimum of 11"],
  expected: 'The form is not sent and the page shows "Phone must be between 11 and 21 characters."',
  source: `AC-1; doc:${PHONE}`,
  quote: "Phone must be between 11 and 21 characters.",
  rationale: "AC-1 names the allowed length without giving it; the project document states it",
  ...over,
});
const problems = (over: Record<string, unknown>, events = [...CONTEXT, ...SEARCH]) =>
  citationProblems(parseDesign({ items: [item(over)] }), events);

describe("reading a citation", () => {
  it("finds the passage ids in a source, with or without a criterion beside them", () => {
    expect(citedPassages(`AC-2; doc:${PHONE}`)).toEqual([PHONE]);
    expect(citedPassages(`AC-2 (doc:${PHONE}) and doc:${MESSAGE}.`)).toEqual([PHONE, MESSAGE]);
    expect(citedPassages(`doc:${PHONE}; doc:${PHONE}`)).toEqual([PHONE]);
    // A file name may have a space in it; the id ends at the eight hex digits.
    expect(citedPassages("AC-1; doc:docs/validation rules.md#phone@0123abcd, checked")).toEqual([
      "docs/validation rules.md#phone@0123abcd",
    ]);
    expect(citedPassages("AC-1")).toEqual([]);
    expect(citedPassages("AC-1; doc:docs/rules.md#phone")).toEqual([]);
    expect(citedPassages("see the doc: it says 11")).toEqual([]);
  });

  it("reads the passages a run's searches returned, and only from searches that worked", () => {
    const failed = pair("docs.search", { query: "x" }, { message: "no index" }, false);
    const other = pair("fs.read_file", { path: "a" }, { passages: [passage(MESSAGE, "m", "M")] });
    const got = returnedPassages([...CONTEXT, ...SEARCH, ...failed, ...other]);
    expect([...got.keys()]).toEqual([PHONE]);
    expect(got.get(PHONE)).toMatchObject({
      file: "docs/requirements/contact-form.md",
      lines: "9-15",
      text: PHONE_TEXT,
    });
  });

  it("compares a quote by its words: spacing, block-quote marks and curly quotes aside", () => {
    expect(quotable("  > Phone   must be\n> between 11 and 21  ")).toBe(
      "Phone must be between 11 and 21",
    );
    expect(quoteIn("Phone must be between 11 and 21 characters.", PHONE_TEXT)).toBe(true);
    // Two lines of the passage, quoted as one sentence.
    expect(quoteIn("this message is shown: Phone must be between 11 and 21", PHONE_TEXT)).toBe(
      true,
    );
    expect(quoteIn("the customer’s “phone”", 'the customer\'s "phone" is checked')).toBe(true);
    // The wording is what a test asserts: case and the numbers are kept.
    expect(quoteIn("phone must be between 11 and 21 characters.", PHONE_TEXT)).toBe(false);
    expect(quoteIn("Phone must be between 10 and 20 characters.", PHONE_TEXT)).toBe(false);
    expect(quoteIn("", PHONE_TEXT)).toBe(false);
  });

  it("accepts a quote of text the model saw masked", () => {
    const text = "Questions go to bookings@shadymeadows.example and are answered in two days.";
    expect(quoteIn("Questions go to [EMAIL] and are answered in two days.", text)).toBe(true);
    expect(quoteIn("Questions go to bookings@shadymeadows.example and are", text)).toBe(true);
  });
});

describe("the citation check", () => {
  it("passes an item whose passage was returned in this run and holds the quote", () => {
    expect(problems({})).toEqual([]);
    // An item that cites no document is checked as it always was: not here.
    expect(problems({ source: "AC-1", quote: undefined })).toEqual([]);
    expect(citationProblems(parseDesign({ items: [item({ source: "AC-1" })] }), [])).toHaveLength(
      1,
    );
  });

  it("sends back a passage no search of this run returned", () => {
    const [p] = problems({ source: `AC-1; doc:${MESSAGE}` });
    expect(p).toContain(`D10: its source cites doc:${MESSAGE}`);
    expect(p).toContain("no docs.search result in this run returned");
    // Nothing searched at all: a citation from memory, or from an earlier run.
    expect(problems({}, CONTEXT)[0]).toContain("no docs.search result in this run returned");
    // One real, one not: the item names the one that is not.
    const [mixed] = problems({ source: `AC-1; doc:${PHONE}; doc:${MESSAGE}` });
    expect(mixed).toContain(MESSAGE);
    expect(mixed).not.toContain(`doc:${PHONE}`);
  });

  it("sends back a citation with no quote, or a quote too short to show anything", () => {
    expect(problems({ quote: undefined })[0]).toContain(
      "D10: cites a document but quotes nothing from it",
    );
    expect(problems({ quote: "   " })[0]).toContain("quotes nothing from it");
    expect(MIN_QUOTE_CHARS).toBe(10);
    expect(problems({ quote: "11 and 21" })[0]).toContain("too short to show anything");
  });

  it("sends back a quote that is not in the passage", () => {
    const [p] = problems({ quote: "Phone must be between 10 and 20 characters." });
    expect(p).toContain('D10: the quote "Phone must be between 10 and 20 characters."');
    expect(p).toContain("is not in the passage it cites");
    expect(p).toContain("docs/requirements/contact-form.md › Contact form — validation rules");
    // A paraphrase is not a quote.
    expect(problems({ quote: "phones are 11 to 21 characters long" })).toHaveLength(1);
  });

  it("holds a quote to the passage cited, not to any passage the run saw", () => {
    const both = pair(
      "docs.search",
      { query: "length" },
      {
        passages: [
          passage(PHONE, PHONE_TEXT, "Phone"),
          passage(MESSAGE, "A message must be 20 to 2000 characters long.", "Message"),
        ],
      },
    );
    const quote = "A message must be 20 to 2000 characters long.";
    expect(problems({ quote }, [...CONTEXT, ...both])[0]).toContain("is not in the passage");
    expect(problems({ quote, source: `AC-1; doc:${MESSAGE}` }, [...CONTEXT, ...both])).toEqual([]);
    // Cited together, the quote may come from either.
    expect(
      problems({ quote, source: `AC-1; doc:${PHONE}; doc:${MESSAGE}` }, [...CONTEXT, ...both]),
    ).toEqual([]);
  });

  it("sends back a quote that cites nothing", () => {
    expect(problems({ source: "AC-1" })[0]).toContain(
      "D10: gives a quote but its source cites no passage",
    );
  });

  it("is one of the design's rules: the gate refuses the design with it", () => {
    const refusal = makeStoryRefusal({ testTypes: ["functional"] });
    const call = (over: Record<string, unknown>) => ({
      toolName: "aqa.test_design",
      args: { items: [item(over)] },
    });
    const events = [...CONTEXT, ...SEARCH];
    expect(refusal(call({}), events)).toBeUndefined();
    const bad = refusal(call({ quote: "Phone must be between 10 and 20 characters." }), events);
    expect(bad).toContain("the test design has 1 problem(s)");
    expect(bad).toContain("is not in the passage it cites");
    expect(refusal(call({}), CONTEXT)).toContain("no docs.search result in this run returned");
  });

  it("shows the reviewer the document's words beside the expectation", () => {
    const lines = renderDesign(parseDesign({ items: [item()] })).join("\n");
    expect(lines).toContain(
      'document: docs/requirements/contact-form.md › phone says "Phone must be between 11 and 21 characters."',
    );
    expect(
      renderDesign(parseDesign({ items: [item({ source: "AC-1" })] })).join("\n"),
    ).not.toContain("document:");
  });

  it("shows a quote of a whole passage on one line", () => {
    // 20261117T004950Z: the agent quoted the passage entire, line breaks and all.
    const lines = renderDesign(parseDesign({ items: [item({ quote: PHONE_TEXT })] }));
    const shown = lines.find((l) => l.includes("document:"));
    expect(shown).toContain(
      'says "A phone number must be 11 to 21 characters long. When it is shorter or longer',
    );
    expect(shown).toContain('this message is shown: Phone must be between 11 and 21 characters."');
    expect(shown).not.toContain(">");
  });

  it("is in the instructions of a run that has the search, and of no other", () => {
    const withDocs = storyToTestsInstructions("1", undefined, true, ["functional"], "ado", true);
    expect(withDocs).toContain('into the item\'s "quote", exactly as they are written');
    expect(withDocs).toContain("sends the design back");
    expect(storyToTestsInstructions("1", undefined, true, ["functional"])).not.toContain(
      'into the item\'s "quote"',
    );
  });
});

describe("a design carried from an earlier run", () => {
  const design = parseDesign({
    items: [item(), item({ id: "D11", source: `AC-1; doc:${MESSAGE}` })],
  });

  it("lists the cited passages that are not in the index now", () => {
    expect(designCitations(design)).toEqual([PHONE, MESSAGE]);
    expect(citationsNotIn(design, new Set([PHONE, MESSAGE]))).toEqual([]);
    expect(citationsNotIn(design, new Set([PHONE]))).toEqual([MESSAGE]);
    // No index: nothing can be confirmed.
    expect(citationsNotIn(design, undefined)).toEqual([PHONE, MESSAGE]);
    expect(citationsNotIn(parseDesign({ items: [item({ source: "AC-1" })] }), undefined)).toEqual(
      [],
    );
  });

  // A finished earlier run of the same story, its test on disk, the story unchanged.
  const FEATURE = [
    "Feature: Guest website",
    "",
    "  @story:92 @ac:1 @design:D10 @type:functional @technique:boundary-value-analysis",
    "  Scenario: AC-1 A phone number shorter than the allowed length is refused",
    "    Given I navigate to the home page",
  ].join("\n");
  const SPEC = [
    'import { test, expect } from "@playwright/test";',
    "// @story:92 @ac:1 @design:D10",
    'test("AC-1 A phone number shorter than the allowed length is refused", async ({ page }) => {',
    '  await expect(page.getByText("Phone must be between 11 and 21 characters.")).toBeVisible();',
    "});",
  ].join("\n");
  const workspace = (): string => {
    const ws = mkdtempSync(join(tmpdir(), "aqa-cite-"));
    mkdirSync(join(ws, "features"));
    mkdirSync(join(ws, "tests"));
    writeFileSync(join(ws, "playwright.config.ts"), 'export default { testDir: "tests" };');
    writeFileSync(join(ws, "features", "epic-88-guest-website.feature"), FEATURE);
    writeFileSync(join(ws, "tests", "epic-88-guest-website.spec.ts"), SPEC);
    return ws;
  };
  const preflight = () =>
    pair("aqa.story_context", {}, { kind: "preflight", summary: {}, text: "", facts: FACTS });
  const prior = (source: string) => ({
    runId: "20261116T150143Z",
    events: [
      ...preflight(),
      ...pair("aqa.test_design", { items: [item({ source })] }, { recorded: true }),
      ...pair(
        "pw.run_tests",
        { spec: "tests/epic-88-guest-website.spec.ts" },
        {
          tests: [
            {
              title: "AC-1 A phone number shorter than the allowed length is refused",
              status: "passed",
            },
          ],
        },
      ),
      {
        ...base,
        eventId: ++n,
        kind: "end",
        payload: { status: "done", summary: "", exitCode: 0 },
      } as unknown as AnyRunEvent,
    ],
  });
  const route = (source: string, index?: () => ReadonlySet<string> | undefined) =>
    storyToTestsSkill({
      workItem: "92",
      workspaceDir: workspace(),
      testTypes: ["functional"],
      previousRuns: () => [prior(source)],
      ...(index ? { knowledgePassages: index } : {}),
    }).route?.(preflight());

  it("is reused while every passage it cites is still in the index", () => {
    const d = route(`AC-1; doc:${PHONE}`, () => new Set([PHONE]));
    expect(d?.because?.["carriedDesign"]).toBeDefined();
    expect(d?.reason).toContain("reusing the design");
    expect(d?.deny).toContain("aqa.test_design");
  });

  it("is designed again when the document changed: the passage is no longer there", () => {
    const d = route(
      `AC-1; doc:${PHONE}`,
      () => new Set(["docs/requirements/contact-form.md#phone@99999999"]),
    );
    expect(d?.because?.["carriedDesign"]).toBeUndefined();
    expect(d?.because?.["citedPassagesGone"]).toEqual([PHONE]);
    expect(d?.reason).toContain("are no longer in the document index");
    expect(d?.reason).toContain(`doc:${PHONE}`);
    expect(d?.reason).toContain("so it is designed again");
    expect(d?.deny ?? []).not.toContain("aqa.test_design");
  });

  it("is designed again when there is no index to confirm it against", () => {
    for (const index of [() => undefined, undefined]) {
      const d = route(`AC-1; doc:${PHONE}`, index);
      expect(d?.because?.["carriedDesign"]).toBeUndefined();
      expect(d?.reason).toContain("cannot be confirmed (there is no document index)");
    }
  });

  it("is reused as before when it cites no document, index or no index", () => {
    expect(route("AC-1")?.because?.["carriedDesign"]).toBeDefined();
    expect(route("AC-1", () => undefined)?.because?.["carriedDesign"]).toBeDefined();
  });
});

/** The real run; local, not committed. */
const RUN = join(__dirname, "..", ".aqa", "runs", "20261116T150143Z-683a003a", "events.jsonl");
describe.skipIf(!existsSync(RUN))("run 20261116T150143Z (Booker #92), replayed", () => {
  const all = existsSync(RUN)
    ? readFileSync(RUN, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as AnyRunEvent)
    : [];
  const at = all
    .map((e) => e.kind === "call" && (e.payload as { toolName: string }).toolName)
    .lastIndexOf("test_design");
  const args = (all[at]?.payload as { args: Record<string, unknown> } | undefined)?.args ?? {};
  const before = all.slice(0, at);

  it("finds every passage the design cited among the run's search results", () => {
    const cited = designCitations(parseDesign(args));
    expect(cited.length).toBe(3);
    const returned = returnedPassages(before);
    expect(cited.filter((id) => !returned.has(id))).toEqual([]);
  });

  it("would have sent that design back: it cited three passages and quoted none", () => {
    const found = citationProblems(parseDesign(args), before);
    expect(found).toHaveLength(3);
    for (const p of found) expect(p).toContain("cites a document but quotes nothing from it");
  });

  it("passes it once each item quotes the words it used", () => {
    const returned = returnedPassages(before);
    const items = (args["items"] as Array<Record<string, unknown>>).map((it) => {
      const id = citedPassages(String(it["source"]))[0];
      const text = id ? returned.get(id)?.text : undefined;
      // The first sentence of the passage the item cites.
      return text ? { ...it, quote: quotable(text).split(". ")[0] } : it;
    });
    expect(citationProblems(parseDesign({ ...args, items }), before)).toEqual([]);
  });
});
