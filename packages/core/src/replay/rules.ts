import type { AnyRunEvent, Skill } from "../types.js";
import { asRecord } from "../verify/evidence.js";
import { approvedDesign, storyFacts, featurePathFor, specPathFor } from "../design/test-design.js";
import { routePathOf } from "../route/route.js";

/**
 * Replay a recorded run's proposals through TODAY's rules, offline.
 *
 * Live runs found rule conflicts one per fifteen-minute run (SCRUM-8, ten runs,
 * thirteen fixes). Every proposal the model made is in the ledger, with the
 * decision the gate took then; re-judging each one against the current rules,
 * with exactly the events that preceded it, shows in seconds what a rule change
 * does to real behaviour — and probing the end of a blocked run shows whether
 * the run had any way forward at all.
 *
 * The workspace is deliberately NOT read: files on disk today are not the files
 * the run saw. Rules fall back to what the ledger says the run read and wrote.
 */

export interface ReplayDecision {
  eventId: number;
  toolName: string;
  then: "execute" | "ask" | "refuse" | "unknown";
  now: "allowed" | "refused";
  reason?: string;
}

export interface DeadlockProbe {
  missing: string[];
  tried: Array<{ action: string; refused?: string }>;
  /** True when every probed way to write a missing item's test is refused. */
  deadlock: boolean;
}

export interface ReplayReport {
  runId: string;
  proposals: number;
  changed: ReplayDecision[];
  stillRefused: number;
  probe?: DeadlockProbe;
}

type Refuse = NonNullable<Skill["refuse"]>;

export function replayRules(events: AnyRunEvent[], skill: Skill): ReplayReport {
  const refuse = skill.refuse as Refuse | undefined;
  const runId = events[0]?.runId ?? "?";
  const changed: ReplayDecision[] = [];
  let proposals = 0;
  let stillRefused = 0;
  let prefix: AnyRunEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const e = events[i] as AnyRunEvent;
    if (e.kind === "inference") {
      const p = e.payload as unknown as Record<string, unknown>;
      const toolName = typeof p["toolName"] === "string" ? p["toolName"] : undefined;
      const args = asRecord(p["args"]) ?? {};
      if (toolName && refuse) {
        proposals++;
        const view = withReroute(prefix, skill);
        const reason = refuse({ toolName, args }, view);
        const then = thenDecision(events, i, toolName);
        const now: ReplayDecision["now"] = reason ? "refused" : "allowed";
        if (now === "refused") stillRefused++;
        const wasRefused = then === "refuse";
        if (wasRefused !== (now === "refused"))
          changed.push({
            eventId: e.eventId,
            toolName,
            then,
            now,
            ...(reason ? { reason: reason.slice(0, 240) } : {}),
          });
      }
    }
    prefix = events.slice(0, i + 1);
  }

  const probe = probeDeadlock(withReroute(events, skill), skill);
  return { runId, proposals, changed, stillRefused, ...(probe ? { probe } : {}) };
}

/** The ledger as the current runtime would have shaped it: plus a re-route, if one applies now. */
function withReroute(events: AnyRunEvent[], skill: Skill): AnyRunEvent[] {
  if (!skill.reroute) return events;
  if (events.some((e) => e.kind === "route" && routeFrom(e) === "B")) return events;
  const again = skill.reroute(events);
  if (!again) return events;
  const last = events[events.length - 1];
  return [
    ...events,
    {
      tool: last?.tool ?? "attestqa",
      runId: last?.runId ?? "?",
      timestamp: last?.timestamp ?? 0,
      eventId: (last?.eventId ?? 0) + 0.5,
      kind: "route",
      payload: {
        path: again.path,
        reason: again.reason,
        because: again.because,
        denied: again.deny,
      },
    } as unknown as AnyRunEvent,
  ];
}

function routeFrom(e: AnyRunEvent): unknown {
  return asRecord(asRecord(e.payload as unknown)?.["because"])?.["from"];
}

/** The gate's decision for the call proposed at index i, from the next policy event for it. */
function thenDecision(events: AnyRunEvent[], i: number, toolName: string): ReplayDecision["then"] {
  for (let j = i + 1; j < Math.min(events.length, i + 6); j++) {
    const e = events[j];
    if (e?.kind !== "policy") continue;
    const p = e.payload as unknown as Record<string, unknown>;
    if (p["toolName"] !== toolName) continue;
    const d = p["decision"];
    return d === "execute" || d === "ask" || d === "refuse" ? d : "unknown";
  }
  return "unknown";
}

/**
 * At the end of the run, could a missing design item's test be written at all?
 * Tries the three ways there are — scaffold, add a scenario, add a test by hand —
 * each in its most innocent form. If all three are refused, the rules deadlock.
 */
function probeDeadlock(events: AnyRunEvent[], skill: Skill): DeadlockProbe | undefined {
  const refuse = skill.refuse as Refuse | undefined;
  if (!refuse || routePathOf(events) !== "A2") return undefined;
  const because = lastBecause(events);
  const missing = Array.isArray(because?.["missing"])
    ? (because["missing"] as unknown[]).map(String)
    : [];
  if (missing.length === 0) return undefined;
  const facts = storyFacts(events);
  const design = approvedDesign(events);
  if (!facts || !design) return undefined;
  const feature = featurePathFor(facts) ?? "features/x.feature";
  const spec = specPathFor(facts) ?? "tests/x.spec.ts";
  const story = String(facts.story?.id ?? "");
  const featureNow = lastWritten(events, feature) ?? "";
  const specNow = lastWritten(events, spec) ?? "";
  const id = missing[0] as string;
  const item = design.items.find((it) => it.id.toUpperCase() === id.toUpperCase());

  const tries: Array<{
    action: string;
    call: { toolName: string; args: Record<string, unknown> };
  }> = [
    {
      action: `bdd2pw.scaffold ${feature}`,
      call: { toolName: "bdd2pw.scaffold", args: { feature, url: "http://localhost/" } },
    },
    {
      action: `add one scenario for ${id} to ${feature}`,
      call: {
        toolName: "fs.write_file",
        args: {
          path: feature,
          content:
            `${featureNow.trimEnd()}\n\n  @story:${story} @design:${id} @type:${item?.type ?? "functional"} @technique:${item?.technique ?? "state-transition"}\n` +
            `  Scenario: ${id}: replay probe\n    When I open the page\n`,
        },
      },
    },
    {
      action: `add one test for ${id} to ${spec}`,
      call: {
        toolName: "fs.write_file",
        args: {
          path: spec,
          content:
            `${specNow.trimEnd()}\n\n  // @story:${story}\n  // @design:${id}\n` +
            `  test("${id}: replay probe", async ({ page }) => {\n    await page.goto("/");\n  });\n`,
        },
      },
    },
  ];
  const tried = tries.map((t) => {
    const r = refuse(t.call, events);
    return { action: t.action, ...(r ? { refused: r.slice(0, 200) } : {}) };
  });
  return { missing, tried, deadlock: tried.every((t) => t.refused !== undefined) };
}

function lastBecause(events: AnyRunEvent[]): Record<string, unknown> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "route") return asRecord(asRecord(e.payload as unknown)?.["because"]);
  }
  return undefined;
}

/** The last content the run wrote to, or read in full from, a path. */
function lastWritten(events: AnyRunEvent[], path: string): string | undefined {
  let out: string | undefined;
  const calls = new Map<number, { toolName: string; args: Record<string, unknown> }>();
  for (const e of events) {
    const p = e.payload as unknown as Record<string, unknown>;
    if (e.kind === "call")
      calls.set(e.eventId, {
        toolName: `${String(p["server"])}.${String(p["toolName"])}`,
        args: asRecord(p["args"]) ?? {},
      });
    if (e.kind === "observation" && p["ok"] === true) {
      const c = calls.get(Number(p["eventIdOfCall"]));
      if (!c || String(c.args["path"] ?? "") !== path) continue;
      if (c.toolName === "fs.write_file") out = String(c.args["content"] ?? "");
      if (c.toolName === "fs.read_file" && c.args["fromLine"] === undefined) {
        const content = asRecord(p["result"])?.["content"];
        if (typeof content === "string") out = content;
      }
    }
  }
  return out;
}
