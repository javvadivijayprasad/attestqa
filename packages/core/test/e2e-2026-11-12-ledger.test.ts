import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRunReport } from "../src/mcp/adapters/summary.js";
import { storyRefusal } from "../src/skills/story-rules.js";
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
