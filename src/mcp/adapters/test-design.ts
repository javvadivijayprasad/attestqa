import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import {
  DESIGN_TECHNIQUES,
  DESIGN_TECHNIQUE_MEANINGS,
  TEST_TYPES,
  TYPE_MEANINGS,
  parseDesign,
  storyFacts,
  validateDesign,
  type TestType,
} from "../../design/test-design.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coverageOf, featurePathFor, specPathFor } from "../../design/test-design.js";
import type { LedgerView } from "./summary.js";

/**
 * In-process `aqa.test_design`: stage 2's single write — the test design,
 * recorded once a person has approved it.
 *
 * Classed `write_record` so the policy table puts it in front of a person: a
 * design is a decision about what this story's tests will and will not check,
 * and that decision is the reviewer's to accept. It writes nothing outside the
 * ledger; the approved call IS the record.
 *
 * The design is validated twice: by the skill's refusal hook before anyone is
 * asked (so nobody is asked to approve something the runtime knows is wrong),
 * and here, in case the tool is ever reached another way.
 */
export class TestDesignTools implements ToolClient {
  readonly server = "aqa";

  /** A workspace file's text, or undefined when there is none to read. */
  private read(rel: string | undefined): string | undefined {
    if (!rel || !this.workspaceDir) return undefined;
    const full = join(this.workspaceDir, rel);
    if (!existsSync(full)) return undefined;
    try {
      return readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
  }

  constructor(
    private readonly ledger: LedgerView,
    private readonly inScope: readonly TestType[],
    /** The suite's directory, so the design can be compared with the tests on disk. */
    private readonly workspaceDir?: string,
  ) {}

  async listTools(): Promise<ToolDescriptor[]> {
    const types = TEST_TYPES.filter((t) => this.inScope.includes(t))
      .map((t) => `${t} (${TYPE_MEANINGS[t]})`)
      .join("; ");
    const techniques = DESIGN_TECHNIQUES.map((t) => `${t} (${DESIGN_TECHNIQUE_MEANINGS[t]})`).join("; ");
    return [
      {
        server: this.server,
        name: "test_design",
        description:
          "Submit this story's TEST DESIGN for a person to approve — before any feature file, spec or " +
          "test case is written. One item per test: what it covers (an acceptance criterion such as " +
          '"AC-2" or "AC-3a", "bug #48", "task #46", or "story" for accessibility), its ISTQB test type, ' +
          "its technique, the test conditions (values or situations exercised), what must be observed, " +
          "and the source of that expectation. Every criterion needs a functional item; every open bug " +
          'is tested or listed in "excluded" with a reason; every type in scope is used or excluded ' +
          "with a reason. An Active bug's test sets expectFail: true. " +
          `Types in scope: ${types}. Techniques: ${techniques}.`,
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "D1, D2, … — each scenario is tagged @design:D1" },
                  covers: { type: "string" },
                  type: { type: "string", enum: [...TEST_TYPES] },
                  technique: { type: "string", enum: [...DESIGN_TECHNIQUES] },
                  conditions: { type: "array", items: { type: "string" } },
                  expected: { type: "string" },
                  source: { type: "string", description: 'where the expectation comes from: "AC-2", "task #46", "bug #50", "comment"' },
                  expectFail: { type: "boolean" },
                },
                required: ["id", "covers", "type", "technique", "conditions", "expected", "source"],
              },
            },
            excluded: {
              type: "array",
              items: {
                type: "object",
                properties: { what: { type: "string" }, reason: { type: "string" } },
                required: ["what", "reason"],
              },
            },
          },
          required: ["items"],
        },
        policyClass: "write_record",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server || name !== "test_design")
      return { ok: false, result: { message: `unknown aqa tool: ${name}` }, artefacts: [] };
    const facts = storyFacts(this.ledger.read());
    if (!facts)
      return {
        ok: false,
        result: { message: "no story context was read this run, so there is nothing to check a design against" },
        artefacts: [],
      };
    const design = parseDesign(args);
    const problems = validateDesign(design, facts, this.inScope);
    if (problems.length > 0) return { ok: false, result: { message: "design rejected", problems }, artefacts: [] };
    // What is already tested, so the record says what this run will WRITE as
    // opposed to what it will run. On the execute path that is usually all of
    // it, and the run's own output should say so rather than announcing work
    // that was done yesterday.
    const covered = coverageOf(design, {
      ...(this.read(featurePathFor(facts)) !== undefined
        ? { featureText: this.read(featurePathFor(facts)) as string }
        : {}),
      ...(this.read(specPathFor(facts)) !== undefined
        ? { specText: this.read(specPathFor(facts)) as string }
        : {}),
      ...(facts.story?.id !== undefined ? { story: facts.story.id } : {}),
    });
    const fresh = design.items.filter((i) => !covered.has(i.id));
    return {
      ok: true,
      result: {
        recorded: true,
        items: design.items.length,
        alreadyTested: [...covered].map(([id, hit]) => `${id} → ${hit.scenario}`),
        newItems: fresh.map((i) => `${i.id} (${i.covers})`),
        next:
          fresh.length === 0
            ? "Every item is already tested by a scenario in this epic's spec: run the suite. Do not " +
              "rewrite the feature file or the spec — repair a locator if one has moved, nothing else."
            : `${fresh.length} item(s) have no test yet (${fresh
                .map((i) => i.id)
                .join(", ")}). Write ONLY those scenarios to the .feature file, each tagged ` +
              "@design:<id> (plus @ac:<n> / @bug:<id>), leaving the existing scenarios untouched. " +
              "Then scaffold with bdd2pw and implement the TODO steps.",
      },
      artefacts: [],
    };
  }
}
