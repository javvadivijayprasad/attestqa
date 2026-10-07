import { describe, it, expect } from "vitest";
import { renderApproval, parseSteps, stripHtml } from "../src/runtime/render-approval.js";

const CASE = {
  toolName: "ado.testplan_test_case_write",
  args: {
    project: "agentic-qa-sandbox",
    action: "create",
    title: "AC-1: A registered user signs in with correct email and password",
    testsWorkItemId: 1,
    steps:
      "1. Navigate to the login page (/#/login)|Login page is displayed\n" +
      "2. Enter the test user email (AQA_APP_USER) into the Email field|Email field accepts input\n" +
      "3. Verify the login API returns HTTP 200|Status 200 confirms credentials are valid",
    priority: 1,
  },
};

const BUG = {
  toolName: "ado.wit_work_item_write",
  args: {
    action: "create",
    workItemType: "Bug",
    parentId: 1,
    fields: [
      { name: "System.Title", value: "Account menu panel remains hidden after successful login" },
      { name: "System.Tags", value: "agentic-qa" },
      {
        name: "Microsoft.VSTS.TCM.ReproSteps",
        value:
          "<p><strong>Failure kind: failing assertion.</strong></p>" +
          "<p><strong>What was ruled out:</strong></p>" +
          "<ul><li>Credential problem: /rest/user/login returned HTTP 200.</li>" +
          "<li>Flakiness: identical failure across 4 runs.</li></ul>" +
          "<p><strong>Confidence: Medium-High.</strong> I cannot rule out that " +
          "the &lt;mat-menu&gt; element needs a different interaction.</p>",
      },
    ],
  },
};

describe("renderApproval", () => {
  it("says what KIND of thing is being approved, before any detail", () => {
    // A reviewer's first question is not "what are the arguments" but "what am
    // I agreeing to" — and one test case plus one bug is a different question
    // from two test cases, with different stakes and often opposite answers.
    const out = renderApproval([CASE, BUG]);
    expect(out.split("\n").find((l) => l.includes("Approve:"))).toContain(
      "1 test case + 1 BUG",
    );
  });

  it("prints a test case as a numbered scenario with its expectations", () => {
    // Azure DevOps stores steps as "action|expected" on one line. That is a
    // storage format, and putting it in front of a person is how an approval
    // gate becomes a rubber stamp. (Observed: apr-0001, nine steps on one
    // unbroken line, reviewed as "very hard to read".)
    const out = renderApproval([CASE]);
    expect(out).toContain("TEST CASE");
    expect(out).toContain("tests story AB#1");
    expect(out).toMatch(/1\. Navigate to the login page/);
    expect(out).toMatch(/→ Login page is displayed/);
    // The raw separator never reaches the reader.
    expect(out).not.toContain("|Login page");
    // Every line fits a terminal.
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(90);
  });

  it("reduces a bug to what the decision turns on, and strips the HTML", () => {
    const out = renderApproval([BUG]);
    expect(out).toContain("linked to story AB#1");
    expect(out).toContain("confidence: Medium-High");
    expect(out).toContain("WHAT IT RULED OUT");
    expect(out).toContain("/rest/user/login returned HTTP 200");
    expect(out).not.toContain("<strong>");
    expect(out).not.toContain("&lt;");
  });

  it("warns when a bug is unlinked or unmarked", () => {
    // Both are gaps the verifier raises after the fact. The reviewer should see
    // them BEFORE saying yes, because they are cheap to fix and expensive to
    // leave: an untagged bug is read back as product knowledge by the next run.
    const bare = {
      toolName: "ado.wit_work_item_write",
      args: { action: "create", workItemType: "Bug", fields: [{ name: "System.Title", value: "x" }] },
    };
    const out = renderApproval([bare]);
    expect(out).toContain("NOT linked to any story");
    expect(out).toContain('missing the "agentic-qa" tag');
  });

  it("says plainly when nothing was ruled out", () => {
    const thin = {
      toolName: "ado.wit_work_item_write",
      args: {
        action: "create",
        workItemType: "Bug",
        parentId: 1,
        tags: "agentic-qa",
        fields: [{ name: "System.Title", value: "It broke" }],
      },
    };
    expect(renderApproval([thin])).toContain("nothing stated");
  });

  it("keeps the raw arguments available but out of the way", () => {
    expect(renderApproval([CASE])).not.toContain('"project":"agentic-qa-sandbox"');
    expect(renderApproval([CASE], { verbose: true })).toContain('"project":"agentic-qa-sandbox"');
  });

  it("falls back to compact key/value for a call it has no shape for", () => {
    const out = renderApproval([{ toolName: "ado.repo_create_branch", args: { name: "agent/x" } }]);
    expect(out).toContain("ado.repo_create_branch");
    expect(out).toContain("name: agent/x");
  });
});

describe("parseSteps", () => {
  it("splits action from expectation and drops the agent's own numbering", () => {
    // Two numbering schemes on one line is worse than none: the renderer
    // numbers the steps, so a leading "1." from the agent is noise.
    expect(parseSteps("1. Click Log in|The form submits")).toEqual([
      { action: "Click Log in", expected: "The form submits" },
    ]);
    expect(parseSteps("3) Wait|Done")[0]?.action).toBe("Wait");
  });

  it("tolerates a step with no expectation", () => {
    expect(parseSteps("Open the page")).toEqual([{ action: "Open the page", expected: "" }]);
  });

  it("ignores blank lines", () => {
    expect(parseSteps("a|b\n\n  \nc|d")).toHaveLength(2);
  });
});

describe("stripHtml", () => {
  it("keeps list items as separate lines and decodes entities", () => {
    const text = stripHtml("<ul><li>one</li><li>two</li></ul><p>&lt;tag&gt; &amp; more</p>");
    expect(text).toContain("• one");
    expect(text).toContain("• two");
    expect(text).toContain("<tag> & more");
  });
});
