import { normId, sameId as sameTrackerId, type Tracker } from "../design/ids.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Gap, TriagePayload, Verifier, VerifierInput, VerifyPayload } from "../types.js";
import { runTriage, triageGaps } from "../triage/step.js";
import {
  approvedDesign,
  featurePathFor,
  storyFacts,
  traceProblems,
  type TestType,
} from "../design/test-design.js";
import { lastFullRun, ownTestTitles } from "../triage/settle.js";
import { testsPreExisted } from "../route/route.js";
import {
  artefacts,
  asArray,
  asRecord,
  completedCalls,
  numberField,
  refusals,
  successful,
  testedByIds,
  type CallRecord,
} from "./evidence.js";

export interface StoryToTestsOptions {
  /** The work item the tests are for, e.g. "1". */
  workItem: string;
  /** The workspace, so stage 0 can survey the framework already in it. */
  workspaceDir?: string;
  /**
   * The test plan the run may use, from `agent.scope.test_plans`. The agent is
   * told to create it when the project has none — a fresh project has no plan,
   * and without this the run stalls listing an empty list (observed).
   */
  testPlan?: string;
  /** Minimum number of test cases that must exist in Azure DevOps. Default 1. */
  minCases?: number;
  /** Require a green Playwright run. Default true. */
  requireGreenSuite?: boolean;
  /**
   * Require the new cases to be added to a suite. Default true. Set false from
   * `agent.capabilities.test_plans` when the Azure DevOps account has no Test
   * Plans access level: the plan/suite API answers "You are not authorized to
   * access this API" there, so requiring it fails every run for a reason the
   * agent cannot act on. The check then becomes a recorded limitation.
   */
  requireSuiteMembership?: boolean;
  /**
   * Base URL of the defect-analysis service, from `DEFECT_ANALYSIS_URL`.
   *
   * Unset — the default — failure triage runs entirely in-process and nothing
   * about the run leaves the machine. Set, each failing test's name, error
   * message, stack and duration are POSTed there; that is application output
   * and may carry data from the system under test, which is why it is opt-in
   * and why ADOPTION.md says so in as many words.
   *
   * It comes from the environment and only from the environment. An endpoint
   * the agent could nominate — from a work item, a spec, a tool result — would
   * be an exfiltration path with a helpful name.
   */
  defectAnalysisUrl?: string;
  /**
   * ISTQB test types in scope (`agent.test_types`). When set, stage 2 is on: a
   * test design must be approved, every design item must have a scenario, every
   * scenario must trace to a design item, and every Active bug's test must be
   * marked expected-to-fail.
   */
  testTypes?: readonly TestType[];
  /**
   * Where the story lives. Default "ado". With "jira" the story is read with
   * jira.get_issue, bugs are filed with jira.create_bug, and the test-case and
   * suite checks do not apply: Jira keeps no test cases, so the feature file's
   * @story tags are the whole record.
   */
  tracker?: Tracker;
}

/**
 * Decides "done" for the story → tests → run → Test Plans slice, from the
 * LEDGER rather than from the model's account of itself. Every check below is
 * a question about something that was observed to happen:
 *
 *   1. the story was actually read          (a successful wit_work_item get)
 *   2. a spec file exists on disk           (named by the run AND present)
 *   3. the suite ran, and came back green   (pw.run_tests, green === true)
 *   4. cases are linked to the story        (created now, or already tested-by)
 *  4b. it looked before it created          (a story read expanded to Relations)
 *   5. each case is traceable to the story  (testsWorkItemId === the work item)
 *   6. the cases are in a suite             (successful testplan_test_suite_write)
 *
 * Checks 2 and 4 ask whether something EXISTS, not whether this run produced
 * it. The difference matters on a re-run: a story whose tests are already
 * written and still correct should verify as done without the agent rewriting
 * the spec or filing a second set of cases.
 *
 * A missing check produces a `Gap` whose `evidence` records what the verifier
 * did see, so the next cycle — and the ledger reader afterwards — can tell the
 * difference between "not attempted", "attempted and refused" and "attempted
 * and failed".
 */
export class StoryToTestsVerifier implements Verifier {
  readonly name = "story-to-tests";
  private readonly opts: Omit<
    Required<StoryToTestsOptions>,
    "testPlan" | "defectAnalysisUrl" | "testTypes" | "workspaceDir" | "tracker"
  > &
    Pick<
      StoryToTestsOptions,
      "testPlan" | "defectAnalysisUrl" | "testTypes" | "workspaceDir" | "tracker"
    >;

  constructor(options: StoryToTestsOptions) {
    this.opts = {
      minCases: 1,
      requireGreenSuite: true,
      requireSuiteMembership: true,
      ...options,
    };
  }

  /**
   * Classify this run's failures before deciding anything about them.
   *
   * The loop writes the result to the ledger, so `verify` below reads it out of
   * `input.events` rather than being handed it — which is what lets a later
   * attempt compare its quarantined tests against an earlier attempt's.
   */
  async triage(input: VerifierInput): Promise<TriagePayload | undefined> {
    const url = this.opts.defectAnalysisUrl;
    return runTriage(input, url ? { service: { url } } : {});
  }

  async verify(input: VerifierInput): Promise<VerifyPayload> {
    const calls = completedCalls(input.events);
    const gaps: Gap[] = [];
    const refused = refusals(input.events);
    // Read once, up front: the green-suite check below needs to know whether
    // triage explained the red before it decides whether to restate it.
    const triage = triageGaps(input.events);

    // 1. the story was read -------------------------------------------------
    const jira = this.opts.tracker === "jira";
    const storyTool = jira ? "jira.get_issue" : "ado.wit_work_item";
    const reads = jira
      ? successful(calls, storyTool).filter((c) => sameTrackerId(c.args["key"], this.opts.workItem))
      : successful(calls, storyTool, "get").filter((c) => sameId(c.args["id"], this.opts.workItem));
    if (reads.length === 0) {
      gaps.push(
        gap(
          "story-not-read",
          `work item ${this.opts.workItem} was never read, so the acceptance criteria are unknown`,
          { attempted: attempts(calls, storyTool), refused: refusedNames(refused) },
        ),
      );
    }

    // 2. a spec file exists -------------------------------------------------
    // EXISTS, not "was written this run". A run that finds a correct spec
    // already in the workspace and simply runs it has done the right thing;
    // the earlier version of this check forced it to rewrite the file to
    // satisfy the verifier, which is the verifier demanding work rather than
    // checking state (observed in run 20260914T034436Z-a69f71a5).
    const specs = [
      ...new Set([...artefacts(calls).filter(isSpecPath), ...specPathsTouched(calls)]),
    ];
    const present = specs.filter((p) => fileExists(input.workspaceDir, p));
    // 2b. a spec THIS RUN wrote came from a feature file ---------------------
    // The pipeline is .feature -> bdd2pw.scaffold -> spec, and it was being
    // skipped: across a day of runs the generator was called ZERO times and
    // `fs.write_file` twenty-five, with the agent hand-writing specs directly.
    // The tool was visible and classified the whole time; nothing required it,
    // so nothing used it.
    //
    // Scoped to specs this run WROTE, not every spec present. The rule is "the
    // agent must not hand-write a spec", not "every spec in this workspace must
    // have come from bdd2pw" — a team adopting agentic-qa with a suite they
    // already own would fail that second rule on every run, forever, for
    // something they did before they met this tool. (The first version of this
    // check did exactly that, and broke eight fixtures on the way to proving
    // it.)
    //
    // Checked as ORDER, not as a marker. The old check looked for a header line
    // ("Generated by agentic-qa (bdd2pw) from <feature>") stamped by this
    // project's own `renderSpec` — which no longer exists. The real bdd2pw
    // emits no provenance comment at all, so the marker test would have called
    // every genuinely scaffolded spec hand-written the moment the agent edited
    // a TODO body into it. A check that fires on the correct behaviour teaches
    // the agent to avoid the tool.
    //
    // What is actually true of a legitimate spec: a successful
    // `bdd2pw.scaffold` ran BEFORE the write. That is exactly the property the
    // rule is about, and it catches the failure observed in run
    // 20260918T192625Z — hand-write the spec, run the suite twice, scaffold
    // sixty events later, overwrite the generated file — which a marker test
    // catches only by luck and an "any scaffold this run" test misses
    // entirely.
    // A GAP MUST DESCRIBE THE PRESENT, OR THE AGENT CANNOT CLOSE IT.
    //
    // The first version asked "did the first scaffold precede the first spec
    // write" — a fact about history, and one that, once false, stays false for
    // the rest of the run. Observed in 20260918T235010Z: the agent hand-edited
    // an existing spec, was told, scaffolded on the retry (event 149), and the
    // gap fired again unchanged. The run ended blocked with a green suite and
    // four test cases created, because the only remedy available could not
    // affect the thing being measured.
    //
    // So the ordering decides whether the run STARTED wrong, and a later
    // scaffold decides whether it ENDED right. Scaffolding regenerates the
    // spec from the feature file, which is precisely the state the check
    // wants; refusing to accept it teaches the agent that the gap is noise.
    const scaffoldedAt = firstSuccessIndex(calls, "bdd2pw.scaffold");
    const lastScaffoldAt = lastSuccessIndex(calls, "bdd2pw.scaffold");
    const written = specWritesInOrder(calls).filter((w) => fileExists(input.workspaceDir, w.path));
    // A spec is hand-written only if it was written before ANY scaffold and no
    // scaffold has regenerated it since. With no scaffold at all, both filters
    // pass and every write counts; with a scaffold, the two conditions cannot
    // both hold, which is the remedy working.
    const handWritten = [
      ...new Set(
        written
          // Written before ANY scaffold, and not regenerated by one since.
          .filter((w) => scaffoldedAt === undefined || w.index < scaffoldedAt)
          .filter((w) => lastScaffoldAt === undefined || w.index > lastScaffoldAt)
          // Kept for suites generated by the pre-4.3 in-tree emitter, whose
          // specs do carry the header.
          .filter(
            (w) =>
              !readIfPresent(input.workspaceDir, w.path)?.includes(
                "Generated by agentic-qa (bdd2pw)",
              ),
          )
          .map((w) => w.path),
      ),
    ];
    // On the execute path the spec was generated by an EARLIER run and this run
    // may only repair it: the generator is not even offered. Calling that repair
    // "hand-written" told the healer to scaffold, which
    // `featureWriteOnExecutePath` then refuses — a gap with no legal remedy
    // (20260925T174149Z).
    // A run whose tests pre-existed (B, or B re-routed to complete its design)
    // writes new tests by hand beside the old ones: scaffolding would wipe them.
    if (handWritten.length > 0 && !testsPreExisted(input.events)) {
      gaps.push(
        gap(
          "spec-not-generated-from-feature",
          "a Playwright spec was hand-written this run rather than generated from a .feature " +
            "file with bdd2pw.scaffold, so nothing ties those tests back to the scenarios or " +
            "their @ac / @bug tags, and the locators were guessed rather than found on the " +
            "page. Write the scenarios to a .feature file, scaffold from it, then implement " +
            "only the steps bdd2pw left as TODO.",
          { specs: handWritten },
        ),
      );
    }

    if (present.length === 0) {
      gaps.push(
        gap("no-spec-written", "no Playwright spec file exists in the workspace", {
          artefactsRecorded: artefacts(calls),
          specPathsSeen: specs,
        }),
      );
    }

    // Collected before `limitations` exists, and merged into it below.
    const sharedSpecLimitations: string[] = [];

    // 2c. the tests trace to the approved test design (stage 2) -----------
    // All three are questions about files on disk against the design a person
    // approved — none about how the agent got there.
    if (this.opts.testTypes && this.opts.testTypes.length > 0) {
      const design = approvedDesign(input.events);
      if (!design) {
        gaps.push(
          gap(
            "no-test-design",
            "no test design was approved this run. Submit it with aqa.test_design — one item per test, " +
              "with its ISTQB type, technique, conditions, expected result and source — before writing tests.",
            {},
          ),
        );
      } else {
        // The epic's feature file, whether this run wrote it or an earlier one
        // did. State, not effort: a run that finds the scenarios already there
        // and simply runs them has done the right thing, and the first version
        // of this check called that "no feature file" (20260923T222343Z).
        const featurePaths = [
          ...new Set([
            ...successful(calls, "bdd2pw.scaffold").map((c) => String(c.args["feature"] ?? "")),
            ...successful(calls, "fs.write_file")
              .map((c) => String(c.args["path"] ?? ""))
              .filter((p) => /\.feature$/i.test(p)),
            ...(storyFacts(input.events) ? [featurePathFor(storyFacts(input.events)!) ?? ""] : []),
          ]),
        ].filter(Boolean);
        const features = featurePaths
          .map((p) => ({ path: p, text: readIfPresent(input.workspaceDir, p) }))
          .filter((f): f is { path: string; text: string } => f.text !== undefined);
        const specTexts = present
          .map((p) => ({ path: p, text: readIfPresent(input.workspaceDir, p) }))
          .filter((f): f is { path: string; text: string } => f.text !== undefined);
        const t = traceProblems(design, features, specTexts, normId(this.opts.workItem));
        if (features.length === 0) {
          gaps.push(
            gap(
              "no-feature-file",
              "the epic's .feature file does not exist: the scenarios have to be written there and " +
                "scaffolded from it",
              { looked: featurePaths },
            ),
          );
        } else {
          if (t.untested.length > 0)
            gaps.push(
              gap(
                "design-item-not-tested",
                `approved design items have no scenario tagged @design:<id>: ${t.untested.join(", ")}. ` +
                  "Add a scenario for each, tagged with its design id, and scaffold again.",
                { items: t.untested },
              ),
            );
          if (t.untagged.length > 0)
            gaps.push(
              gap(
                "scenario-not-in-design",
                `scenarios with no @design:<id> tag from the approved design: ${t.untagged.join("; ")}. ` +
                  "Tag each with the design item it implements; a test outside the approved design was not approved.",
                { scenarios: t.untagged },
              ),
            );
        }
        if (t.wrongShape.length > 0)
          gaps.push(
            gap(
              "test-does-not-match-its-design",
              `the approved design says these tests do something the file does not: ${t.wrongShape.join("; ")}. ` +
                "A test that exists is not the same as the test that was approved — change the test, or say " +
                "in your final message why the design cannot be followed.",
              { items: t.wrongShape },
            ),
          );
        if (t.unmarked.length > 0)
          gaps.push(
            gap(
              "known-bug-test-not-marked",
              `the test for an Active bug is not marked expected-to-fail: ${t.unmarked.join(", ")}. ` +
                'Add test.fail(true, "Bug #<id> Active: <title>") as the test\'s first line, so that a pass ' +
                'reaches a person as "did not reproduce" instead of disappearing as an ordinary pass.',
              { items: t.unmarked },
            ),
          );
      }
    }

    // 3. the suite ran and is green ----------------------------------------
    // Only a run of the whole suite finishes the job; a filtered one is a
    // working step.
    const last = lastFullRun(input.events);
    if (!last) {
      gaps.push(
        gap("suite-not-run", "the generated tests were never executed", {
          attempted: attempts(calls, "pw.run_tests"),
        }),
      );
    } else if (this.opts.requireGreenSuite) {
      const r = asRecord(last.result) ?? {};
      // Red because the PRODUCT is wrong is finished work, and the skill's own
      // definition of done says so: "OR every remaining failure has been
      // triaged as a product defect". Those failures are put to a reviewer at
      // the end of the run; there is nothing left for the agent to do about
      // them, so they must not read as unfinished work.
      // The epic's spec holds every story's tests, so a failure in it may not
      // be this run's at all. A run cannot be held open for a test it did not
      // write and may not touch; those failures are reported as a limitation.
      const mine = ownTestTitles(input.events, this.opts.workItem);
      const allFailingTitles = asArray(r["failures"]).map((f) =>
        String(asRecord(f)?.["title"] ?? ""),
      );
      const otherStory = mine ? allFailingTitles.filter((t) => !mine.has(t)) : [];
      if (otherStory.length > 0)
        sharedSpecLimitations.push(
          `failing in this epic's spec but belonging to another story: ${otherStory.join("; ")} — ` +
            "not this run's tests to fix, and not its defects to report",
        );
      const failingTitles = mine ? allFailingTitles.filter((t) => mine.has(t)) : allFailingTitles;
      const allDefects =
        failingTitles.length > 0 &&
        failingTitles.every(
          (t) => t && triage.defectCandidates.some((c) => c.endsWith(t) || c.includes(t)),
        );
      const greenForThisStory =
        r["green"] === true || (mine !== undefined && failingTitles.length === 0);
      if (!greenForThisStory && !allDefects) {
        // When triage has something to say, it says it better. "The suite is
        // not green" is a restatement of the exit code; "the system under test
        // was not reachable" names the fix. Reporting both would put three
        // sentences in the ledger about one fact and send the reader to the
        // least useful of them first.
        if (triage.gaps.length === 0) {
          gaps.push(
            gap(
              "suite-not-green",
              skippedOnly(r)
                ? `the suite ran but ${String(r["skipped"])} test(s) are still unimplemented (fixme), so nothing was actually verified`
                : `the suite ran but is not green: ${String(r["passed"] ?? 0)} passed, ${String(r["failed"] ?? 0)} failed, ${String(r["skipped"] ?? 0)} skipped`,
              {
                passed: r["passed"],
                failed: r["failed"],
                skipped: r["skipped"],
                failures: r["failures"],
              },
            ),
          );
          // A red suite that triage could not read is a gap in the EVIDENCE,
          // not in the work, and saying so is the difference between "we did
          // not check" and "we checked and it was fine".
          //
          // This is a gap rather than a limitation, and it is here because the
          // alternative was observed and cost three suite runs: a stale report
          // on disk made triage find no failures while the suite reported one,
          // and triage's correct answer to "no failures" is silence. Silence
          // that looks like agreement is the expensive kind. The verifier is
          // the only place that sees BOTH the suite's own count and what triage
          // made of it, so it is the only place that can notice they disagree.
          if (!skippedOnly(r) && Number(r["failed"] ?? 0) > 0) {
            gaps.push(
              gap(
                "failures-not-triaged",
                `the suite reported ${String(r["failed"])} failing test(s), but triage classified ` +
                  "none of them. Either no Playwright JSON report was written to " +
                  ".aqa-report/playwright.json, or the one there is stale or unreadable — so the " +
                  "run cannot say whether those failures are product defects, flakes, or a system " +
                  "that was never up.",
                { failed: r["failed"], triageEvents: triage.attempts },
              ),
            );
          }
        }
      }
    }

    // 4 + 5. test cases exist, and trace back to the story -------------------
    // Cases the story ALREADY had count. Requiring creation every run is what
    // produced four sets of duplicates in the sandbox: the agent had no reason
    // to look first, and the verifier would have failed it if it had.
    // Jira keeps no test cases: none are created, none are linked, and asking
    // for one would fail every Jira run for a reason the agent cannot act on.
    const created = jira ? [] : successful(calls, "ado.testplan_test_case_write", "create");
    const preexisting = jira ? [] : reads.flatMap((r) => testedByIds(r.result));
    const total = created.length + preexisting.length;
    if (!jira && total < this.opts.minCases) {
      gaps.push(
        gap(
          "no-test-cases",
          `${total} test case(s) are linked to work item ${this.opts.workItem} (${created.length} created this run, ${preexisting.length} already present); at least ${this.opts.minCases} is required`,
          {
            created: created.length,
            preexisting,
            attempted: attempts(calls, "ado.testplan_test_case_write"),
          },
        ),
      );
    }

    // 4b. it looked before it wrote ------------------------------------------
    // The semantic match — "is this criterion already covered?" — is the
    // model's judgement, because the create tool exposes no tag or automated
    // test name to key on and the titles are reworded every run. What code CAN
    // insist on is that the agent read the existing cases before adding more.
    if (created.length > 0) {
      const looked = reads.some(
        (r) => typeof r.args["expand"] === "string" && /relations|all/i.test(r.args["expand"]),
      );
      if (!looked) {
        gaps.push(
          gap(
            "created-without-looking",
            "test cases were created without first reading the cases already linked to the story, so duplicates cannot be ruled out",
            {
              created: created.length,
              storyReads: reads.map((r) => r.args["expand"] ?? "(no expand)"),
            },
          ),
        );
      }
    }
    const untraceable = created.filter(
      (c) => !sameId(c.args["testsWorkItemId"], this.opts.workItem),
    );
    if (untraceable.length > 0) {
      gaps.push(
        gap(
          "cases-not-linked",
          `${untraceable.length} test case(s) are not linked to work item ${this.opts.workItem}`,
          { titles: untraceable.map((c) => String(c.args["title"] ?? "(untitled)")) },
        ),
      );
    }

    // 6. the cases are in a suite -------------------------------------------
    const limitations: string[] = [...sharedSpecLimitations];
    if (this.opts.requireSuiteMembership && created.length > 0) {
      const suiteWrites = successful(calls, "ado.testplan_test_suite_write");
      if (suiteWrites.length === 0) {
        gaps.push(
          gap("cases-not-in-suite", "the new test cases were not added to a test suite", {
            created: created.length,
            attempted: attempts(calls, "ado.testplan_test_suite_write"),
          }),
        );
      }
    } else if (jira) {
      limitations.push(
        "test cases were not checked: Jira keeps no test cases, so the scenarios tagged " +
          `@story:${this.opts.workItem} in the epic's feature file are the record of what is tested.`,
      );
    } else if (!this.opts.requireSuiteMembership) {
      limitations.push(
        "suite membership was not checked: agent.capabilities.test_plans is false, so this " +
          "Azure DevOps account cannot create test plans or suites. The cases exist and are " +
          "linked to the story, but no suite contains them.",
      );
    }

    // 7. a bug that was filed is linked to the story ------------------------
    // Only when one was actually created: the user may deny, and a denied bug
    // is not a gap. But a bug that WAS filed and carries no link lands in the
    // backlog with nothing connecting it to the feature, the test or the run.
    for (const b of successful(calls, "ado.wit_work_item_write", "create")) {
      if (!sameId(b.args["parentId"], this.opts.workItem)) {
        gaps.push(
          gap(
            "bug-not-linked-to-story",
            `a bug was created without parentId = ${this.opts.workItem}, so nothing connects it ` +
              "to the story it was found against",
            { args: b.args },
          ),
        );
      }
      // 7b. and it says an agent proposed it -------------------------------
      // A bug filed by this runtime carries the same author as one a human
      // investigated and filed, because it is created with the same
      // credentials. The tag is the only thing that separates them, and
      // step 1a of the skill reads open bugs back as context — so an untagged
      // proposal becomes, on the next run, an established fact about the
      // product that the agent wrote about itself. That loop has already run
      // once here: three bugs the agent filed sat open in the project, one of
      // them for a failure later shown to be an unregistered test account.
      if (!hasAgentTag(b.args["tags"] ?? asRecord(b.args["fields"])?.["System.Tags"])) {
        gaps.push(
          gap(
            "bug-not-marked-as-agent-filed",
            'a bug was created without the "agentic-qa" tag, so a later run cannot tell this ' +
              "unconfirmed proposal from a defect a human investigated and filed — and will " +
              "read it back as established product knowledge",
            { args: b.args },
          ),
        );
      }
    }
    // Jira: the adapter links and labels every Bug itself, so the one thing
    // left to get wrong is which story it is linked to.
    for (const b of successful(calls, "jira.create_bug")) {
      if (!sameTrackerId(b.args["storyKey"], this.opts.workItem)) {
        gaps.push(
          gap(
            "bug-not-linked-to-story",
            `a bug was created with storyKey ${String(b.args["storyKey"] ?? "(none)")} rather than ` +
              `${this.opts.workItem}, so it is linked to the wrong story`,
            { args: b.args },
          ),
        );
      }
    }

    // Triage's gaps go last so the story-level checks read first: a run that
    // both skipped the story and found a product defect has a bigger problem
    // than the defect.
    gaps.push(...triage.gaps);
    limitations.push(...triage.limitations);

    return {
      done: gaps.length === 0,
      gaps,
      ...(limitations.length > 0 ? { limitations } : {}),
    };
  }
}

/**
 * True when a tags value contains the "agentic-qa" marker.
 *
 * Azure DevOps stores tags as one semicolon-separated string, and the MCP tool
 * accepts them either as a `tags` argument or inside `fields` as
 * `System.Tags` — so both spellings are checked. Matching is on the whole tag,
 * trimmed and case-insensitive: "agentic-qa-run-3" is a different tag and does
 * not count, because a later run looking for its own output must not sweep up
 * something a human named similarly.
 */
export function hasAgentTag(tags: unknown): boolean {
  if (typeof tags !== "string") return false;
  return tags.split(";").some((t) => t.trim().toLowerCase() === AGENT_TAG);
}

/** The tag every bug this runtime proposes must carry. */
export const AGENT_TAG = "agentic-qa";

/** Case ids as reported by Azure DevOps, for the run summary. Best effort. */
export function createdCaseIds(events: VerifierInput["events"]): number[] {
  return successful(completedCalls(events), "ado.testplan_test_case_write", "create")
    .map((c) => numberField(c.result, "id", "workItemId", "testCaseId"))
    .filter((n): n is number => n !== undefined);
}

/**
 * Pull a work item reference out of a request: "AB#1", "#1", "work item 1",
 * "story 1". Returns the first match — the runtime scopes a run to one story.
 */
export function parseWorkItemRef(text: string): string | undefined {
  const m =
    /\bAB#(\d+)\b/i.exec(text) ??
    /#(\d+)\b/.exec(text) ??
    /\b(?:work item|story|user story|item)\s+(\d+)\b/i.exec(text);
  return m?.[1];
}

// ---------------------------------------------------------------------------

function gap(code: string, message: string, evidence: Record<string, unknown>): Gap {
  return { code, message, evidence };
}

/** Ids arrive as numbers or strings depending on the caller; compare as text. */
function sameId(value: unknown, want: string): boolean {
  if (typeof value === "number") return String(value) === want;
  if (typeof value === "string") return value.trim() === want;
  return false;
}

function isSpecPath(p: string): boolean {
  return /\.(spec|test)\.(ts|js|mts|cts|tsx)$/i.test(p);
}

/**
 * Spec paths the run named in a workspace call — written, read, or generated.
 * Catches the spec that was already there and only read, which an artefact
 * list by definition never records.
 */
/**
 * Spec paths this run WROTE, as opposed to merely read.
 *
 * `CallRecord.toolName` is QUALIFIED — "fs.write_file", not "write_file". The
 * first version of this compared against the bare name, matched nothing, and
 * the check silently passed on every run. `evidence.ts` carries a comment about
 * this exact bug biting once before; it bit again here.
 */
/**
 * Index of the first successful call to `toolName`, or undefined.
 *
 * FIRST, not any: a scaffold that ran after a spec was already hand-written
 * does not retroactively make that spec generated.
 */
function firstSuccessIndex(calls: CallRecord[], toolName: string): number | undefined {
  const i = calls.findIndex((c) => c.ok && c.toolName === toolName);
  return i === -1 ? undefined : i;
}

/**
 * Index of the LAST successful call to `toolName`.
 *
 * Used for the closing half of the spec-provenance check: a scaffold after the
 * final hand-write means the file on disk is the generator's output again, and
 * the gap has been remedied rather than merely regretted.
 */
function lastSuccessIndex(calls: CallRecord[], toolName: string): number | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.ok && calls[i]?.toolName === toolName) return i;
  }
  return undefined;
}

/** Spec writes this run, each with its position in the call sequence. */
function specWritesInOrder(calls: CallRecord[]): Array<{ path: string; index: number }> {
  const out: Array<{ path: string; index: number }> = [];
  calls.forEach((c, index) => {
    // `toolName` is QUALIFIED — "fs.write_file", not "write_file". This has
    // been got wrong twice in this file's history.
    if (!c.ok || c.toolName !== "fs.write_file") return;
    const p = c.args["path"];
    if (typeof p === "string" && isSpecPath(p)) out.push({ path: p, index });
  });
  return out;
}

function specPathsTouched(calls: CallRecord[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (!c.ok || c.server !== "fs") continue;
    const p = c.args["path"];
    if (typeof p === "string" && isSpecPath(p)) out.push(p);
  }
  return out;
}

/** File contents, or undefined when it is absent or unreadable. */
function readIfPresent(workspaceDir: string, rel: string): string | undefined {
  try {
    const abs = resolve(workspaceDir, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function fileExists(workspaceDir: string, rel: string): boolean {
  const abs = resolve(workspaceDir, rel);
  return existsSync(abs) && statSync(abs).isFile();
}

/** What was tried for a tool, successful or not — the "not attempted" signal. */
function attempts(calls: CallRecord[], toolName: string): Array<{ action?: string; ok: boolean }> {
  return calls
    .filter((c) => c.toolName === toolName)
    .map((c) => (c.action !== undefined ? { action: c.action, ok: c.ok } : { ok: c.ok }));
}

function refusedNames(refused: Array<{ toolName: string; reason: string }>): string[] {
  return [...new Set(refused.map((r) => r.toolName))];
}

function skippedOnly(r: Record<string, unknown>): boolean {
  return Number(r["failed"] ?? 0) === 0 && Number(r["skipped"] ?? 0) > 0;
}
