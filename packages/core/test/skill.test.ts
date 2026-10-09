import { describe, it, expect } from "vitest";
import {
  storyToTestsSkill,
  storyToTestsInstructions,
  STORY_TO_TESTS_TOOLS,
  STORY_TO_TESTS_SOURCES,
} from "../src/skills/story-to-tests.js";
import { DEFAULT_MANIFEST, entryClass } from "../src/mcp/manifest.js";
import { StoryToTestsVerifier } from "../src/verify/story-to-tests.js";

describe("story-to-tests skill", () => {
  const skill = storyToTestsSkill({ workItem: "1" });

  it("carries the work item into the instructions and the verifier", async () => {
    expect(skill.name).toBe("story-to-tests");
    expect(skill.instructions).toContain("work item 1");
    expect(skill.verifier).toBeInstanceOf(StoryToTestsVerifier);
    expect(skill.verifier.name).toBe("story-to-tests");
  });

  it("shows the model only tools the manifest classifies", () => {
    const unclassified = STORY_TO_TESTS_TOOLS.filter((t) => DEFAULT_MANIFEST[t] === undefined);
    expect(unclassified).toEqual([]);
  });

  it("shows no tool the gate would always refuse", () => {
    const alwaysRefused = STORY_TO_TESTS_TOOLS.filter(
      (t) => entryClass(DEFAULT_MANIFEST[t]!) === "destructive",
    );
    expect(alwaysRefused).toEqual([]);
  });

  it("declares sources that are a subset of the tools it can see", () => {
    // One deliberate exception: `aqa.story_context` is the digest the RUNTIME
    // produces in preflight. The model never calls it — which is the point, it
    // used to skip the reads — but it is the most important source there is,
    // so it is declared, and it is the only name allowed to be.
    const runtimeProduced = new Set(["aqa.story_context"]);
    expect(
      STORY_TO_TESTS_SOURCES.every((s) => STORY_TO_TESTS_TOOLS.includes(s) || runtimeProduced.has(s)),
    ).toBe(true);
    expect(skill.sourceTools).toEqual(STORY_TO_TESTS_SOURCES);
  });

  it("tells the model the verifier decides done, and names every check", () => {
    const text = storyToTestsInstructions("1");
    for (const phrase of [
      "you do not decide this",
      "was read",
      "spec file exists",
      "zero failures AND zero skipped",
      "testsWorkItemId = 1",
      "added to a test suite",
      "Never hard-code the application's address",
      'process.env["AQA_APP_USER"]',
      'process.env["AQA_APP_PASS"]',
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("names only actions the manifest admits", () => {
    const text = storyToTestsInstructions("1");
    const mentioned = [...text.matchAll(/action "([a-z_]+)"/g)].map((m) => m[1]);
    const admitted = new Set(
      Object.values(DEFAULT_MANIFEST).flatMap((e) => Object.keys(e.actions ?? {})),
    );
    expect(mentioned.filter((a) => !admitted.has(a!))).toEqual([]);
  });
});

describe("story-to-tests skill: the test plan", () => {
  it("names the plan it may create, when the config scopes one", () => {
    const text = storyToTestsInstructions("1", "Sandbox Plan");
    expect(text).toContain('The plan you may use is named "Sandbox Plan"');
    // the failure this encodes: a fresh project has no plan, list_plans returns
    // [], and the agent listed it three times rather than creating one
    expect(text).toContain("comes back with an empty list: that is not an error");
    expect(text).toContain('name "Sandbox Plan"');
  });

  it("refuses to invent one when no plan is in scope", () => {
    const text = storyToTestsInstructions("1");
    expect(text).toContain("stop and report that no test plan is in scope");
    expect(text).not.toContain("The plan you may use is named");
  });
});

describe("story-to-tests without the Test Plans access level", () => {
  const skill = storyToTestsSkill({ workItem: "1", requireSuiteMembership: false });

  it("does not show the model tools the environment cannot perform", () => {
    expect(skill.allowedTools).not.toContain("ado.testplan");
    expect(skill.allowedTools).not.toContain("ado.testplan_test_plan_write");
    expect(skill.allowedTools).not.toContain("ado.testplan_test_suite_write");
  });

  it("keeps case creation, which is an ordinary work-item write", () => {
    expect(skill.allowedTools).toContain("ado.testplan_test_case_write");
  });

  it("says why the suite step is absent instead of leaving it unexplained", () => {
    expect(skill.instructions).toContain("no Test Plans access level");
    expect(skill.instructions).not.toContain("6. the cases were added to a test suite.");
  });

  it("still tells the agent that an authorization failure is final", () => {
    expect(skill.instructions).toContain("not authorized");
  });
});

describe("the grain of a test case is stated, not left to chance", () => {
  const skill = storyToTestsSkill({ workItem: "1" });

  it("says one case per acceptance criterion, whatever the test count", () => {
    expect(skill.instructions).toContain("ONE CASE PER ACCEPTANCE CRITERION");
    expect(skill.instructions).toContain("Never create a case per test");
  });

  it("allows the scenario count to differ from the case count", () => {
    expect(skill.instructions).toMatch(/[Tt]ests are per behaviour, test cases are per criterion/);
  });
});

describe("preconditions must be asserted, not assumed", () => {
  const text = storyToTestsInstructions("1");

  it("requires a separate, explicitly-messaged precondition check", () => {
    // The failure this closes, from run 20260918T170400Z-4683360d: a login test
    // asserted navigation away from /#/login and failed identically twice. It
    // was classified a product defect and a bug was proposed at "Confidence:
    // High" — while the login endpoint had been answering 401 the whole time.
    // The application was correct; the account did not exist. The evidence that
    // would have said so was never captured, so no pattern bank could have seen
    // it, and only the human approval gate stopped a false bug.
    expect(text).toMatch(/ASSERT\s+THE\s+PRECONDITIONS\s+SEPARATELY/);
    expect(text).toMatch(/assert\s+the\s+authentication\s+call\s+succeeded/i);
  });

  it("says plainly that a broken precondition is not a defect", () => {
    expect(text).toMatch(
      /A\s+precondition\s+failure\s+is\s+not\s+a\s+product\s+defect/i,
    );
  });
});

describe("bug proposals must say what was ruled out", () => {
  const text = storyToTestsInstructions("1");

  it("demands the ruled-out paragraph, not just a confidence word", () => {
    // The gap this closes, observed on run 20260918T170400Z-4683360d: a bug
    // proposed with "Confidence: High that this is a product defect" whose own
    // repro steps opened "Enter a REGISTERED user's email" — a precondition
    // asserted and never checked. A 200 from the login endpoint makes it a
    // defect; a 401 makes it a fixture problem and no bug at all. The two are
    // indistinguishable from the outside, so the check has to be named.
    expect(text).toMatch(/WHAT YOU RULED OUT/);
    // Whitespace-tolerant: these instructions are wrapped prose, so a literal
    // space in the pattern cannot match "what you\n       checked".
    expect(text).toMatch(/what\s+you\s+checked\s+that\s+would\s+have\s+made\s+this\s+NOT\s+a\s+defect/i);
  });

  it("ties confidence to that paragraph rather than to how the failure felt", () => {
    expect(text).toMatch(/nothing ruled out/);
    expect(text).toMatch(/set\s+your\s+confidence\s+to\s+low/i);
    expect(text).toMatch(
      /Do\s+not\s+reason\s+your\s+way\s+to\s+confidence\s+from\s+the\s+absence\s+of\s+a\s+contradiction/i,
    );
  });

  it("keeps the retry-before-judging rule and the deny-is-final rule", () => {
    expect(text).toMatch(/RE-RUN IT BEFORE YOU CHANGE ANYTHING/);
    expect(text).toMatch(/If\s+they\s+deny,\s+that\s+is\s+the\s+end\s+of\s+it/);
    expect(text).toMatch(/do\s+not\s+reword\s+it\s+and\s+try\s+again/i);
  });

  it("confines bug filing to create/Bug and forbids editing a story", () => {
    expect(text).toMatch(/Only "create", and only "Bug"/);
    expect(text).toMatch(/you\s+cannot\s+change\s+a\s+story's\s+acceptance\s+criteria/i);
  });

  it("forbids filing a bug for the agent's own bad test", () => {
    expect(text).toMatch(/Never\s+file\s+a\s+bug\s+for\s+a\s+test\s+you\s+wrote\s+badly/);
  });
});

describe("feature steps must be written for the generator", () => {
  const text = storyToTestsInstructions("1");

  it("gives the step vocabulary bdd2pw can actually bind", () => {
    // Measured, not guessed: `bdd2pw analyze` on a real feature file bound 5 of
    // 15 steps. The model had written prose — "I submit valid registered email
    // and correct password" is three actions in one sentence, and nothing can
    // match it. The .feature file is the interface between the model and the
    // generator, so it has to be written in the generator's terms.
    for (const shape of [
      'I click "Log in"',
      "I find the Email field and enter",
      "I leave the Password field empty",
      "the page displays",
      "the URL contains",
      "the response status is 200",
    ]) {
      expect(text).toContain(shape);
    }
  });

  it("shows the compound step that fails and how to split it", () => {
    expect(text).toMatch(/ONE\s+ACTION\s+PER\s+STEP/);
    expect(text).toContain("WRONG");
    expect(text).toContain("RIGHT");
  });

  it("prefers a TODO over a wrong binding", () => {
    // Observed on the same run: `Then I see "Invalid email or password."` bound
    // to the email FIELD's visibility. That test would pass while checking
    // something unrelated — worse than not binding at all.
    expect(text).toMatch(
      /a\s+step\s+that\s+binds\s+to\s+the\s+WRONG\s+element\s+is\s+worse/i,
    );
  });
});
