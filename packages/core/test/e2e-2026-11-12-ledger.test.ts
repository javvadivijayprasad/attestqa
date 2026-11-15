import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRunReport } from "../src/mcp/adapters/summary.js";
import { storyRefusal } from "../src/skills/story-rules.js";
import { latestPriorDesign, storyFingerprint, storyTextHash } from "../src/design/fingerprint.js";
import { storyFacts } from "../src/design/test-design.js";
import type { AnyRunEvent } from "../src/types.js";

/**
 * Replays of run 20261112T224735Z-d73d59a9 (Booker, story 176), the end-to-end
 * run that found both problems. The ledger is under the local ledger root and
 * is not committed (it holds tracker content), so these run where it exists and
 * are skipped elsewhere. The feature-file rule is also covered from built
 * events in story-rules.test.ts; the report wording is covered only here.
 */
const LEDGER = join(__dirname, "..", ".aqa", "runs", "20261112T224735Z-d73d59a9", "events.jsonl");
const have = existsSync(LEDGER);
const events = (): AnyRunEvent[] =>
  readFileSync(LEDGER, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AnyRunEvent);

describe.skipIf(!have)("run 20261112T224735Z, replayed", () => {
  it("refuses the write that removed story 91's scenarios from the shared feature file", () => {
    const all = events();
    const write = all.find(
      (e) =>
        e.kind === "call" &&
        e.payload.toolName === "write_file" &&
        String(e.payload.args["path"]).endsWith(".feature"),
    );
    if (!write || write.kind !== "call") throw new Error("the ledger has no feature write");
    const before = all.filter((e) => e.eventId < write.eventId);
    const path = String(write.payload.args["path"]);

    // The file as it was on disk before the run: four scenarios of story 91.
    const dir = mkdtempSync(join(tmpdir(), "aqa-e2e-"));
    mkdirSync(join(dir, "features"), { recursive: true });
    const scenario = (name: string) => `  @story:91 @ac:1\n  Scenario: ${name}\n    When x\n`;
    writeFileSync(
      join(dir, path),
      "Feature: Guest website\n" +
        scenario("AC-1 Home page shows the B&B name and description") +
        scenario("AC-3 Home page shows the B&B contact details"),
    );

    const call = { toolName: "fs.write_file", args: write.payload.args };
    // As the run was judged: nothing in its events about the file, so nothing said.
    expect(storyRefusal(call, before) ?? "").not.toContain("belonging to another story");
    // As it is judged now, with the workspace to read.
    expect(storyRefusal(call, before, { workspaceDir: dir })).toContain(
      "removes 2 scenario(s) belonging to another story",
    );
  });

  it("does not call the suite green for a story none of whose design items has a test", () => {
    const text = composeRunReport(events(), "20261112T224735Z-d73d59a9", {
      workItem: "176",
    }).text;
    expect(text).toContain("**No test of story 176 ran.**");
    expect(text).not.toContain("Suite: green");
    expect(text).toContain("4 passed");
  });
});

const LEDGER2 = join(__dirname, "..", ".aqa", "runs", "20261112T225751Z-ed1449f3", "events.jsonl");

describe.skipIf(!existsSync(LEDGER2))("run 20261112T225751Z, replayed", () => {
  it("gives no verdict on story 176 when the run stopped before the verifier ran", () => {
    const all = readFileSync(LEDGER2, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AnyRunEvent);
    const text = composeRunReport(all, "20261112T225751Z-ed1449f3", { workItem: "176" }).text;
    expect(text).toContain("**No test of story 176 ran.**");
    expect(text).not.toContain("Suite: green");
  });
});

/**
 * Runs 20261112T230358Z (run 4) and 20261112T232301Z (run 5) of story 176.
 * Between them all three acceptance criteria were rewritten in Azure DevOps to
 * quote the application's messages. Run 5 answered "story unchanged", reused
 * run 4's design and could not correct five tests asserting an invented message.
 */
const RUN4 = "20261112T230358Z-8e528bb0";
const RUN5 = "20261112T232301Z-f7a3ac4a";
const ledgerOf = (runId: string) => join(__dirname, "..", ".aqa", "runs", runId, "events.jsonl");
const read = (runId: string): AnyRunEvent[] =>
  readFileSync(ledgerOf(runId), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AnyRunEvent);

describe.skipIf(!existsSync(ledgerOf(RUN4)) || !existsSync(ledgerOf(RUN5)))(
  "runs 20261112T230358Z and 20261112T232301Z, replayed",
  () => {
    it("recorded the same facts for a story whose three criteria had been rewritten", () => {
      const before = storyFacts(read(RUN4));
      const after = storyFacts(read(RUN5));
      // Labels only — which is why the two fingerprints were equal.
      expect(before?.acceptanceCriteria).toEqual(["AC-1", "AC-2", "AC-3"]);
      expect(after?.acceptanceCriteria).toEqual(before?.acceptanceCriteria);
      const route = read(RUN5).find((e) => e.kind === "route");
      expect(JSON.stringify(route?.payload)).toContain("story unchanged since run " + RUN4);
      // Neither ledger has the wording, so their fingerprints are what they were.
      if (!before || !after) throw new Error("no facts");
      expect(storyFingerprint(after, ["functional"])).toBe(
        storyFingerprint(before, ["functional"]),
      );
    });

    it("no longer reuses run 4's design once the story is read with its wording", () => {
      const after = storyFacts(read(RUN5));
      if (!after) throw new Error("no facts");
      const prior = latestPriorDesign([{ runId: RUN4, events: read(RUN4) }], after.story, [
        "functional",
      ]);
      expect(prior?.textRecorded).toBe(false);
      // What a read of the story makes of it today.
      const now = { ...after, textHash: storyTextHash("AC-1: Phone must be between…", "") };
      expect(storyFingerprint(now, ["functional"])).not.toBe(prior?.fingerprint);
      // …and the route can tell "not recorded" from "changed".
      expect(storyFingerprint(now, ["functional"], false)).toBe(prior?.fingerprint);
    });
  },
);
