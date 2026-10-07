import type { Skill } from "../types.js";
import {
  DefectProfileVerifier,
  type DefectProfileVerifierOptions,
} from "../verify/defect-profile.js";
import {
  DEFECT_SURFACES,
  EXCEPTION_TYPES,
  SURFACE_MEANINGS,
  TEST_TECHNIQUES,
  TECHNIQUE_MEANINGS,
  PROFILE_DIR,
  PROFILE_FILE,
  VOCABULARY_PROVENANCE,
} from "../defects/taxonomy.js";

/**
 * Tools this skill may see. Reading bugs and writing one file in the workspace
 * — nothing here touches a system of record, so a profile run never asks for an
 * approval and never needs one.
 */
export const DEFECT_PROFILE_TOOLS = [
  "ado.wit_query",
  "ado.wit_work_item",
  "aqa.defect_profile",
  "fs.read_file",
  "fs.list_dir",
  "fs.write_file",
];

/** The bugs themselves are the primary source; trimmed last. */
export const DEFECT_PROFILE_SOURCES = ["ado.wit_query", "ado.wit_work_item"];

function vocabulary(): string {
  const surfaces = DEFECT_SURFACES.map((l) => `  - ${l}: ${SURFACE_MEANINGS[l]}`).join("\n");
  const techniques = TEST_TECHNIQUES.map((t) => `  - ${t}: ${TECHNIQUE_MEANINGS[t]}`).join("\n");
  return `SURFACE — where the defect lived:\n${surfaces}\n\nTECHNIQUE — what nobody did, i.e. the test technique that would have caught it:\n${techniques}\n\nEXCEPTION TYPE — how it announced itself. Exactly one of:\n  ${EXCEPTION_TYPES.join(", ")}\nUse "Other" when the bug names no exception; most bug reports will not.`;
}

export function defectProfileInstructions(project: string, maxBugs: number): string {
  return `You are building a defect profile for the project "${project}".

GOAL
Read this product's closed bugs, classify each one, and write the result to
${PROFILE_DIR}/${PROFILE_FILE} in the workspace. The profile exists so that the
test-authoring agent designs tests aimed at where this product actually breaks,
instead of where software breaks in general.

You are not deciding whether the profile is good enough. A verifier reads the
run ledger and the file you wrote and decides that. Your job is the judgement
code cannot make: which bucket each bug belongs in, and why.

THE VOCABULARY IS CLOSED, AND IT IS NOT MINE
These are the categories of Paper F — "Post-Execution Defect Attribution on
Real-World Defects" — whose corpus is 1,323 defects from Defects4J and BugsInPy.
They are borrowed so that a profile built here can be compared against that
corpus and against the next run, rather than only against itself.

${vocabulary()}

Every record must name one surface, one technique and one exception type FROM
THOSE LISTS. Do not invent a label; the verifier will reject the profile for it.

THE TECHNIQUE FIELD IS THE ONE THAT CHANGES ANYTHING
A surface tells a test designer where to look. A technique tells them what to
write. "A three-character password was accepted" is not usefully summarised as
"a validator defect" — it is summarised as "nobody applied boundary value
analysis to the length rule", and that sentence produces a test. Ask of every
bug: what would someone have had to DO to find this before a customer did?
Use "unknown" when the report genuinely does not say enough — that is an honest
answer and it is better than a technique you cannot defend.

One thing to hold in mind while you classify. In Paper F these signals come from
the FIX COMMIT'S DIFF — "schema" means the persisted schema actually changed.
You are inferring them from what a bug REPORT says, which is weaker evidence for
the same quantity. Prefer the surface the bug gives you actual words for over the
one you think is likely.

EVERY CLASSIFICATION QUOTES ITS EVIDENCE
Each record carries an "evidence" field: the words from the bug's title,
description or resolution that decided it. A short quote, not a paraphrase.
Someone reading the profile in three months must be able to see why a bug was
called a validator defect and disagree with you if you were wrong.

METHOD

1. Query the closed bugs with ado.wit_query. Something like:

     SELECT [System.Id] FROM WorkItems
      WHERE [System.TeamProject] = '${project}'
        AND [System.WorkItemType] = 'Bug'
        AND [System.State] IN ('Closed', 'Resolved', 'Done')
      ORDER BY [System.ChangedDate] DESC

   Take at most ${maxBugs} ids. If the query returns none, that is a fact about
   this project, not a failure — write a profile with an empty records array and
   the ids you queried (none), and stop. Do not invent defects to fill it.

2. Read them with ado.wit_work_item using action "get_batch", in batches, asking
   for the fields you need: System.Id, System.Title, System.Description,
   Microsoft.VSTS.TCM.ReproSteps, System.Tags, Microsoft.VSTS.Common.ResolvedReason,
   Microsoft.VSTS.Common.ClosedDate. Reading them in batches rather than one at a
   time is the difference between a cheap run and an expensive one.

3. Classify each bug. Read what the bug actually says; do not classify from the
   title alone when a description is present. Three judgements people get wrong:

   - Classify by where the defect LIVED, not where it was noticed. A defect
     reproduced by clicking a button but caused by a service returning the wrong
     status is "app_code" or "config", not "locator".
   - "validator" is for the CHECK being wrong — input accepted that should have
     been rejected, or the reverse. A correct rejection reported with the wrong
     message is not a validator defect; the check worked.
   - "fixture" means the TEST was wrong, not the product. These matter: a
     history full of fixture defects says your tests are brittle, which is a
     different problem from a product that breaks, and the profile must not
     blur the two.

   Record httpStatus when the bug names one (404, 500). Leave it out otherwise —
   do not guess a status to fill the field.

4. Write ${PROFILE_DIR}/${PROFILE_FILE} with fs.write_file, as JSON:

     {
       "project": "${project}",
       "query": "<the WIQL you ran>",
       "generatedAt": "<ISO timestamp>",
       "vocabulary": "${VOCABULARY_PROVENANCE}",
       "queried": [<every id the query returned, in order>],
       "records": [
         {
           "id": 42,
           "title": "Login accepts blank password",
           "surface": "validator",
           "technique": "boundary-value-analysis",
           "exceptionType": "Other",
           "httpStatus": 200,
           "evidence": "\\"POST /login returned 200 with an empty password field\\"",
           "closedAt": "2026-08-14"
         }
       ]
     }

   "queried" must list EVERY id the query returned, including any you could not
   classify confidently. The verifier compares the two: a profile that quietly
   drops what it could not classify reports a distribution that is not this
   product's.

5. Call aqa.defect_profile to read back what you wrote. It counts the records
   and returns the distribution. Check the totals match what you intended —
   this is the one place you get to see your own work counted by something
   other than yourself.

WHEN A READ IS REFUSED
The WIQL query is not scope-checked, but every work item you then READ is. If a
bug id falls outside agent.scope.work_items the gate refuses it, and no rewording of
the call will change that — the refusal is the operator's decision, not an
error to route around.

Record those ids in an "outOfScope" array in the profile:

     "outOfScope": [ <ids the gate refused> ]

and carry on with the ones you can read. A profile drawn from part of the
history is still useful; a profile that hides which part it was drawn from is
not. The verifier records this as a limitation rather than a gap, so a run that
is refused half the bugs still finishes cleanly and says so.

If EVERY read is refused, stop and say so plainly with no tool calls. The fix is
for a human to widen agent.scope.work_items to cover the bug ids, and you cannot do
it.

WORKING RULES
- Re-run behaviour: if a valid profile already exists and covers the bugs the
  query returns, you have nothing to do. Say so with no tool calls. A run that
  writes nothing is a successful run.
- Never guess a surface from a bug id or a title you did not read.
- If a bug is genuinely ambiguous, use the least specific surface that the words
  support — "app_code" — and quote the ambiguity in the evidence. An honest
  vague answer is more useful than a confident wrong bucket, because the profile
  is read as a distribution and one wrong record moves it.`;
}

export interface DefectProfileSkillOptions extends DefectProfileVerifierOptions {
  /** Azure DevOps project name, for the WIQL and the profile header. */
  project: string;
  /**
   * How many bugs to classify at most. A profile is a distribution, not a
   * census: the shape stabilises long before the history is exhausted, and
   * every extra bug is tokens spent for a decimal place nobody acts on.
   */
  maxBugs?: number;
}

export function defectProfileSkill(opts: DefectProfileSkillOptions): Skill {
  const maxBugs = opts.maxBugs ?? 200;
  return {
    name: "defect-profile",
    instructions: defectProfileInstructions(opts.project, maxBugs),
    allowedTools: DEFECT_PROFILE_TOOLS,
    sourceTools: DEFECT_PROFILE_SOURCES,
    verifier: new DefectProfileVerifier({
      ...(opts.minRecords !== undefined ? { minRecords: opts.minRecords } : {}),
      ...(opts.file !== undefined ? { file: opts.file } : {}),
    }),
  };
}
