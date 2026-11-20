import { quotable } from "../design/citations.js";
import type { ArmTotals, Bar, EvalResult, StoryArm } from "./eval.js";
import type { ItemDetail, RunMetrics } from "./eval-runs.js";
import type { Rate } from "./eval-stats.js";

/**
 * `aqa eval --html`: the evaluation as one page (ADR-008 §8).
 *
 * One file, nothing fetched: the styles, the two small charts and thirty lines
 * of script for the hover text are all in it, so it opens from a disk or an
 * e-mail attachment and nothing about a project leaves the machine.
 *
 * Everything on it is in `eval.json`; the page computes nothing. It is laid out
 * in the order a reader needs: were the bars met, does the search help story
 * by story, how good is the search itself, then each run, and under each run
 * the design items with the passage each cites and the quoted words marked —
 * the way from a score down to the evidence for it.
 *
 * Passage text comes from a project's documents and item text from a model, so
 * every value is escaped on the way in, and the script only ever sets
 * `textContent`.
 */
const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const pct = (p: number | null | undefined, places = 0): string =>
  p === null || p === undefined ? "—" : `${(p * 100).toFixed(places)}%`;
const num = (n: number | null | undefined, places = 2): string =>
  n === null || n === undefined ? "—" : n.toFixed(places);
const rateText = (r: Rate): string =>
  r.rate === null ? "not measured" : `${pct(r.rate, 1)} (${r.k} of ${r.n})`;
const interval = (r: Rate): string =>
  r.rate === null ? "" : `95% interval ${pct(r.low)} to ${pct(r.high)}`;
const ARM_NAME = { off: "Search off", on: "Search on" } as const;

const STYLE = `
:root{color-scheme:light;--surface:#fcfcfb;--raised:#ffffff;--line:#e4e3df;--text:#0b0b0b;
--text-2:#52514e;--text-3:#7a7974;--off:#2a78d6;--on:#eb6834;--good:#0ca30c;--critical:#d03b3b;
--mark:#fde9a8;--mark-text:#0b0b0b}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--surface:#1a1a19;--raised:#232322;
--line:#383835;--text:#f0efec;--text-2:#c3c2b7;--text-3:#9a998f;--off:#3987e5;--on:#d95926;
--good:#0ca30c;--critical:#e66767;--mark:#5c4a12;--mark-text:#f0efec}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}
h2{font-size:18px;margin:40px 0 4px}
h3{font-size:15px;margin:20px 0 6px}
p{margin:6px 0}.sub{color:var(--text-2)}.muted{color:var(--text-3)}
.card{background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:16px;margin:12px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0}
.tile{background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tile b{display:block;font-size:26px;line-height:1.2;font-variant-numeric:tabular-nums}
.tile span{color:var(--text-2);font-size:13px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 10px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--text-2);font-weight:600;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bars{list-style:none;padding:0;margin:8px 0}
.bars li{display:grid;grid-template-columns:132px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}
.state{font-weight:600;white-space:nowrap}
.state i{font-style:normal;display:inline-block;width:1.2em}
.met i{color:var(--good)}.missed i{color:var(--critical)}.none i{color:var(--text-3)}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--text-2);font-size:13px;margin:4px 0 8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
svg{display:block;max-width:100%;height:auto}
svg text{fill:var(--text-2);font:12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
svg .name{fill:var(--text)}
svg .grid{stroke:var(--line);stroke-width:1}
[data-tip]{cursor:default}[data-tip]:focus{outline:2px solid var(--text-2);outline-offset:2px}
#tip{position:fixed;z-index:9;pointer-events:none;background:var(--text);color:var(--surface);
padding:6px 9px;border-radius:6px;font-size:13px;max-width:320px;white-space:pre-line;display:none}
details{border:1px solid var(--line);border-radius:8px;margin:8px 0;background:var(--raised)}
summary{cursor:pointer;padding:10px 14px;font-weight:600}
summary span{font-weight:400;color:var(--text-2)}
.items{padding:0 14px 12px}
.item{border-top:1px solid var(--line);padding:10px 0}
.item dl{display:grid;grid-template-columns:96px 1fr;gap:2px 10px;margin:6px 0}
.item dt{color:var(--text-2)}.item dd{margin:0;overflow-wrap:anywhere}
.passage{border-left:3px solid var(--line);padding:6px 0 6px 12px;margin:8px 0;white-space:pre-wrap;
overflow-wrap:anywhere;color:var(--text-2)}
mark{background:var(--mark);color:var(--mark-text);padding:0 2px;border-radius:2px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;
color:var(--text-2);margin-right:6px;white-space:nowrap}
code{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
ul.notes{margin:6px 0;padding-left:20px}
`;

const SCRIPT = `
(function(){var t=document.getElementById("tip");if(!t)return;
function show(e){var el=e.target.closest("[data-tip]");if(!el){t.style.display="none";return}
t.textContent=el.getAttribute("data-tip");t.style.display="block";
var r=el.getBoundingClientRect(),x=(e.clientX||r.left+r.width/2)+12,y=(e.clientY||r.bottom)+14;
t.style.left=Math.max(8,Math.min(x,window.innerWidth-t.offsetWidth-8))+"px";
t.style.top=Math.max(8,Math.min(y,window.innerHeight-t.offsetHeight-8))+"px"}
document.addEventListener("mousemove",show);document.addEventListener("focusin",show);
document.addEventListener("focusout",function(){t.style.display="none"});
document.addEventListener("mouseleave",function(){t.style.display="none"})})();
`;

function barLine(b: Bar): string {
  const state = b.met === null ? "none" : b.met ? "met" : "missed";
  const icon = b.met === null ? "–" : b.met ? "✓" : "✕";
  const word = b.met === null ? "Not measured" : b.met ? "Met" : "Missed";
  return (
    `<li><span class="state ${state}"><i aria-hidden="true">${icon}</i>${word}</span>` +
    `<span><b>${esc(b.measure)}</b> — ${esc(b.value)} <span class="muted">· bar: ${esc(b.bar)}</span></span></li>`
  );
}

/** Completion per story: one row a story, a dot and its interval per arm, on a 0–100% axis. */
function completionChart(stories: readonly StoryArm[]): string {
  const names = [...new Set(stories.map((s) => s.story))];
  const arms = (["off", "on"] as const).filter((a) => stories.some((s) => s.arm === a));
  if (names.length === 0) return "";
  const left = 110;
  const width = 720;
  const right = 24;
  const row = 36;
  const top = 8;
  const plot = width - left - right;
  const x = (p: number): number => left + p * plot;
  const height = top + names.length * row + 28;
  const out: string[] = [
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Runs completed per story, with a 95% interval, by arm">`,
  ];
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    out.push(
      `<line class="grid" x1="${x(g)}" x2="${x(g)}" y1="${top}" y2="${top + names.length * row}"/>`,
      `<text x="${x(g)}" y="${top + names.length * row + 18}" text-anchor="middle">${g * 100}%</text>`,
    );
  }
  names.forEach((name, i) => {
    const mid = top + i * row + row / 2;
    out.push(
      `<text class="name" x="${left - 12}" y="${mid + 4}" text-anchor="end">${esc(name)}</text>`,
    );
    arms.forEach((arm, k) => {
      const s = stories.find((v) => v.story === name && v.arm === arm);
      if (!s || s.completed.rate === null) return;
      const y = mid + (arms.length === 1 ? 0 : k === 0 ? -7 : 7);
      const tip =
        `Story ${name} — ${ARM_NAME[arm]}\n${s.completed.k} of ${s.completed.n} run(s) completed ` +
        `(${pct(s.completed.rate)})\n${interval(s.completed)}`;
      out.push(
        `<g data-tip="${esc(tip)}" tabindex="0">` +
          `<rect x="${left}" y="${y - 9}" width="${plot}" height="18" fill="transparent"/>` +
          `<line x1="${x(s.completed.low ?? 0)}" x2="${x(s.completed.high ?? 1)}" y1="${y}" y2="${y}" ` +
          `stroke="var(--${arm})" stroke-width="2" stroke-linecap="round" opacity="0.55"/>` +
          `<circle cx="${x(s.completed.rate)}" cy="${y}" r="5" fill="var(--${arm})" stroke="var(--raised)" stroke-width="2"/>` +
          `</g>`,
      );
    });
  });
  out.push("</svg>");
  const legend =
    arms.length > 1
      ? `<div class="legend">${arms
          .map((a) => `<span><i style="background:var(--${a})"></i>${ARM_NAME[a]}</span>`)
          .join("")}<span class="muted">dot: runs completed · line: 95% interval</span></div>`
      : `<div class="legend"><span class="muted">${ARM_NAME[arms[0] ?? "on"]} · dot: runs completed · line: 95% interval</span></div>`;
  return legend + out.join("");
}

/** A run as a square: filled when it completed. The story's repeats, in order. */
function repeats(runs: readonly RunMetrics[], arm: "on" | "off"): string {
  if (runs.length === 0) return "—";
  const size = 12;
  const gap = 4;
  const squares = runs
    .map((r, i) => {
      const tip = `${r.runId}\n${r.completed ? "completed" : `not completed (${r.status})`}`;
      return (
        `<rect data-tip="${esc(tip)}" tabindex="0" x="${i * (size + gap) + 1}" y="1" width="${size}" height="${size}" rx="2" ` +
        `fill="${r.completed ? `var(--${arm})` : "none"}" stroke="var(--${arm})" stroke-width="2"/>`
      );
    })
    .join("");
  const done = runs.filter((r) => r.completed).length;
  return (
    `<svg viewBox="0 0 ${runs.length * (size + gap) + 2} ${size + 2}" width="${runs.length * (size + gap) + 2}" ` +
    `height="${size + 2}" role="img" aria-label="${done} of ${runs.length} runs completed">${squares}</svg>`
  );
}

function storyTable(r: EvalResult): string {
  const names = [...new Set(r.stories.map((s) => s.story))];
  const arms = (["off", "on"] as const).filter((a) => r.stories.some((s) => s.arm === a));
  const head = arms
    .map(
      (a) =>
        `<th>${ARM_NAME[a]}: runs</th><th class="n">completed</th><th class="n">value F1</th><th class="n">cost / run</th>`,
    )
    .join("");
  const rows = names
    .map((name) => {
      const cells = arms
        .map((a) => {
          const s = r.stories.find((v) => v.story === name && v.arm === a);
          const runs = r.runs.filter((x) => x.story === name && x.arm === a);
          if (!s) return `<td>—</td><td class="n">—</td><td class="n">—</td><td class="n">—</td>`;
          return (
            `<td>${repeats(runs, a)}</td><td class="n">${s.completed.k} of ${s.completed.n}</td>` +
            `<td class="n">${num(s.valueF1)}</td><td class="n">${s.costUsd === null ? "—" : `$${num(s.costUsd)}`}</td>`
          );
        })
        .join("");
      return `<tr><td><b>${esc(name)}</b></td>${cells}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead><tr><th>Story</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function armTable(arms: readonly ArmTotals[]): string {
  const row = (label: string, f: (a: ArmTotals) => string): string =>
    `<tr><td>${label}</td>${arms.map((a) => `<td class="n">${esc(f(a))}</td>`).join("")}</tr>`;
  const money = (v: number | null): string => (v === null ? "—" : `$${num(v)}`);
  return (
    `<div class="scroll"><table><thead><tr><th>Measure</th>${arms
      .map((a) => `<th class="n">${ARM_NAME[a.arm]}</th>`)
      .join("")}</tr></thead><tbody>` +
    row("Runs (stories)", (a) => `${a.runs} (${a.stories})`) +
    row("Runs completed", (a) => rateText(a.completion)) +
    row("Stories whose every run completed", (a) => rateText(a.consistency)) +
    row("Design accepted unchanged", (a) => rateText(a.designAcceptedUnchanged)) +
    row("Value correctness, mean F1 per story", (a) => num(a.valueF1ByStory)) +
    row("Invented values", (a) => rateText(a.inventedValues)) +
    row("Cited passages returned in the run", (a) => rateText(a.citationValidity)) +
    row("Quote holds the value", (a) => rateText(a.faithfulness)) +
    row("Correct refusal", (a) => rateText(a.correctRefusal)) +
    row("Wrong refusal", (a) => rateText(a.wrongRefusal)) +
    row("Stale passage used", (a) => rateText(a.staleUsed)) +
    row("Searched when the story needed it", (a) => rateText(a.searchedWhenNeeded)) +
    row("Searched when it did not", (a) => rateText(a.searchedWhenNotNeeded)) +
    row("Cost per completed run", (a) => money(a.costPerCompletedRun)) +
    row("Steps per completed run", (a) => num(a.stepsPerCompletedRun, 0)) +
    row("Agent minutes per completed run", (a) => num(a.agentMinutesPerCompletedRun, 1)) +
    row(
      "Decisions by a person",
      (a) => `${a.decisions.approved} approved, ${a.decisions.denied} denied`,
    ) +
    `</tbody></table></div>`
  );
}

/** Hit rate at 5 by category: one bar a category, the value at its tip. */
function categoryChart(r: NonNullable<EvalResult["retrieval"]>): string {
  const cats = r.byCategory;
  if (cats.length === 0) return "";
  const left = 110;
  const width = 720;
  const right = 150;
  const row = 34;
  const plot = width - left - right;
  const out: string[] = [
    `<svg viewBox="0 0 ${width} ${cats.length * row + 8}" role="img" aria-label="Hit rate at 5 by kind of question">`,
    `<line class="grid" x1="${left}" x2="${left}" y1="4" y2="${cats.length * row + 4}"/>`,
  ];
  cats.forEach((c, i) => {
    const y = 4 + i * row + (row - 16) / 2;
    const w = Math.max(0, (c.hitAt5.rate ?? 0) * plot);
    const tip = `${c.category}\n${c.hitAt5.k} of ${c.hitAt5.n} in the first five\n${interval(c.hitAt5)}`;
    out.push(
      `<text class="name" x="${left - 12}" y="${y + 12}" text-anchor="end">${esc(c.category)}</text>`,
      `<g data-tip="${esc(tip)}" tabindex="0"><rect x="${left}" y="${y - 6}" width="${plot}" height="28" fill="transparent"/>` +
        (w >= 4
          ? `<path d="M${left} ${y}h${w - 4}a4 4 0 0 1 4 4v8a4 4 0 0 1 -4 4h-${w - 4}z" fill="var(--off)"/>`
          : "") +
        `</g>`,
      `<text class="name" x="${left + w + 8}" y="${y + 12}">${pct(c.hitAt5.rate)} · ${c.hitAt5.k} of ${c.hitAt5.n}</text>`,
    );
  });
  out.push("</svg>");
  return out.join("");
}

function retrieval(r: NonNullable<EvalResult["retrieval"]>): string {
  const rows = r.results
    .map((q) => {
      const where =
        q.category === "unanswerable"
          ? q.top.length > 0
            ? `returned ${q.top.length} passage(s), top score ${num(q.topScore)}`
            : "nothing returned"
          : q.rank === null
            ? "not found"
            : `rank ${q.rank}`;
      const flags =
        (q.complete === false ? " · not every passage in the first five" : "") +
        (q.wrongFirst ? " · the wrong passage came first" : "") +
        (q.missing.length > 0 ? " · gold names a passage the index does not hold" : "");
      return (
        `<tr><td><code>${esc(q.id)}</code></td><td>${esc(q.category)}</td><td>${esc(q.question)}</td>` +
        `<td>${esc(where + flags)}</td><td><code>${esc(q.top[0] ?? "—")}</code></td></tr>`
      );
    })
    .join("");
  return (
    `<h2>The search itself</h2><p class="sub">Each gold question put to the index, as the agent's search runs it. No model is called.</p>` +
    `<div class="tiles">` +
    `<div class="tile"><b>${pct(r.hitAt5.rate)}</b><span>answer in the first five — ${r.hitAt5.k} of ${r.hitAt5.n}; ${esc(interval(r.hitAt5))}</span></div>` +
    `<div class="tile"><b>${num(r.meanReciprocalRank)}</b><span>mean reciprocal rank (1 = always first)</span></div>` +
    (r.unanswerableReturned.n > 0
      ? `<div class="tile"><b>${r.unanswerableReturned.k} of ${r.unanswerableReturned.n}</b><span>unanswerable questions for which passages came back all the same</span></div>`
      : "") +
    (r.wrongFirst.n > 0
      ? `<div class="tile"><b>${r.wrongFirst.k} of ${r.wrongFirst.n}</b><span>questions where the stale or distractor passage came first</span></div>`
      : "") +
    `</div>` +
    `<div class="card"><h3>Answer in the first five, by kind of question</h3>${categoryChart(r)}</div>` +
    `<div class="scroll"><table><thead><tr><th>Question</th><th>Kind</th><th>Asked</th><th>Result</th><th>First passage returned</th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

function runsTable(runs: readonly RunMetrics[]): string {
  const rows = runs
    .map(
      (r) =>
        `<tr><td><code>${esc(r.runId)}</code></td><td>${esc(r.story ?? "—")}</td><td>${r.arm}${r.armGiven ? "" : "*"}</td>` +
        `<td>${esc(r.model ?? "—")}</td><td><code>${esc((r.configHash ?? "—").replace(/^sha256:/, "").slice(0, 10))}</code></td>` +
        `<td>${esc(r.status)}</td><td class="n">${r.costUsd === null ? "—" : `$${num(r.costUsd)}`}</td>` +
        `<td class="n">${r.steps}</td><td class="n">${num(r.agentMinutes, 1)}</td><td class="n">${r.searches}</td>` +
        `<td class="n">${r.citations.valid} of ${r.citations.cited}</td><td class="n">${num(r.values?.f1)}</td>` +
        `<td class="n">${r.invented ? r.invented.values.length : "—"}</td></tr>`,
    )
    .join("");
  return (
    `<div class="scroll"><table><thead><tr><th>Run</th><th>Story</th><th>Arm</th><th>Model</th><th>Config</th><th>Outcome</th>` +
    `<th class="n">Cost</th><th class="n">Steps</th><th class="n">Agent min</th><th class="n">Searches</th>` +
    `<th class="n">Citations returned</th><th class="n">Value F1</th><th class="n">Invented</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    (runs.some((r) => !r.armGiven)
      ? `<p class="muted">* arm told from the ledger: the run searched the documents, or did not.</p>`
      : "")
  );
}

/** The passage with the quoted words marked — or, when they are not in it, said so. */
function passageHtml(text: string, quote: string | undefined): string {
  if (!quote) return esc(text);
  const literal = text.indexOf(quote);
  if (literal >= 0)
    return (
      esc(text.slice(0, literal)) +
      `<mark>${esc(quote)}</mark>` +
      esc(text.slice(literal + quote.length))
    );
  // The check compares by words, spacing and block-quote marks aside; show the
  // passage the same way so the marked words are the ones that were matched.
  const flat = quotable(text);
  const q = quotable(quote);
  const at = q ? flat.indexOf(q) : -1;
  if (at < 0) return esc(text);
  return esc(flat.slice(0, at)) + `<mark>${esc(q)}</mark>` + esc(flat.slice(at + q.length));
}

function itemHtml(it: ItemDetail): string {
  const tags =
    `<span class="tag">${esc(it.type)}</span>` +
    (it.notFound ? `<span class="tag">says “not found in the project documents”</span>` : "") +
    (it.faithfulness === "faithful"
      ? `<span class="tag">quote holds the value</span>`
      : it.faithfulness === "unfaithful"
        ? `<span class="tag">quote does not hold the value</span>`
        : it.faithfulness === "undetermined"
          ? `<span class="tag">quote not judged in code</span>`
          : "");
  const cited = it.cited
    .map((c) => {
      const where = c.returned
        ? `${esc(c.file)} › ${esc(c.heading)} · lines ${esc(c.lines)} · file changed ${esc(c.modified)}`
        : `<code>${esc(c.id)}</code>`;
      const state =
        (c.returned ? "" : `<span class="tag">not returned by a search in this run</span>`) +
        (c.stale ? `<span class="tag">stale version</span>` : "");
      const inPassage =
        c.text !== undefined && it.quote !== undefined
          ? passageHtml(c.text, it.quote).includes("<mark>")
          : null;
      return (
        `<p class="sub">Cites ${where} ${state}</p>` +
        (c.text !== undefined
          ? `<div class="passage">${passageHtml(c.text, it.quote)}</div>` +
            (inPassage === false
              ? `<p class="muted">The quoted words are not in this passage.</p>`
              : "")
          : "")
      );
    })
    .join("");
  return (
    `<div class="item"><b>${esc(it.id)}</b> <span class="sub">${esc(it.covers)}</span> ${tags}` +
    `<dl><dt>Conditions</dt><dd>${esc(it.conditions.join("; ")) || "—"}</dd>` +
    `<dt>Expects</dt><dd>${esc(it.expected)}</dd><dt>Source</dt><dd>${esc(it.source)}</dd>` +
    (it.quote ? `<dt>Quote</dt><dd>“${esc(quotable(it.quote))}”</dd>` : "") +
    `</dl>${cited}</div>`
  );
}

function runDetail(r: RunMetrics): string {
  const facts = [
    r.values
      ? `values: ${r.values.found.length} of ${r.values.found.length + r.values.missed.length} gold values present` +
        (r.values.missed.length > 0 ? `, missing ${r.values.missed.join(" · ")}` : "") +
        (r.values.wrong.length > 0 ? `; not gold values: ${r.values.wrong.join(" · ")}` : "")
      : "",
    r.invented && r.invented.values.length > 0
      ? `in nothing the run was given: ${r.invented.values.join(" · ")}`
      : "",
    r.decisions.filter((d) => d.decision !== "approved").length > 0
      ? `denied by a person: ${r.decisions
          .filter((d) => d.decision !== "approved")
          .map((d) => d.what + (d.reason ? ` (“${d.reason}”)` : ""))
          .join("; ")}`
      : "",
    `ledger events: design ${r.events.design === null ? "—" : `#${r.events.design}`}` +
      (r.events.searches.length > 0
        ? `, searches ${r.events.searches.map((e) => `#${e}`).join(", ")}`
        : ", no search"),
  ].filter(Boolean);
  return (
    `<details><summary><code>${esc(r.runId)}</code> <span>story ${esc(r.story ?? "—")} · search ${r.arm} · ${esc(r.status)} · ` +
    `${r.items.length} item(s), ${r.citations.cited} citation(s)</span></summary><div class="items">` +
    facts.map((f) => `<p class="sub">${esc(f)}</p>`).join("") +
    (r.items.length > 0
      ? r.items.map(itemHtml).join("")
      : `<p class="muted">No design was approved in this run.</p>`) +
    `</div></details>`
  );
}

export function renderEvalHtml(r: EvalResult): string {
  const c = r.comparison;
  const paired = (name: string, p: NonNullable<typeof c>["completion"]): string =>
    `<div class="tile"><b>${p.helped} · ${p.hurt} · ${p.unchanged}</b><span>${name}: stories helped · hurt · unchanged, of ${p.stories} ` +
    `(McNemar exact p = ${p.p.toFixed(3)})</span></div>`;
  const body = [
    `<h1>Evaluation</h1>`,
    `<p class="sub">Gold file <code>${esc(r.gold.file)}</code> · ${r.gold.questions} question(s), ${r.gold.stories} stor${
      r.gold.stories === 1 ? "y" : "ies"
    } · ${r.runs.length} run(s) · generated ${esc(r.generated.slice(0, 16).replace("T", " "))} UTC · prices as of ${esc(r.prices.asOf)}</p>`,
    `<h2>The bars</h2><p class="sub">Fixed on 12 Nov 2026, before the first run.</p><ul class="bars">${r.bars.map(barLine).join("")}</ul>`,
    r.notes.length > 0
      ? `<div class="card"><h3>Read these first</h3><ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
      : "",
    r.stories.length > 0
      ? `<h2>${c ? "Search off against search on, story by story" : "Runs, story by story"}</h2>` +
        `<p class="sub">A story's runs are averaged first; the story is the unit.</p>` +
        (c
          ? `<div class="tiles">${paired("Completion", c.completion)}${paired("Value correctness", c.valueCorrectness)}</div>`
          : "") +
        `<div class="card"><h3>Runs completed per story</h3>${completionChart(r.stories)}</div>` +
        storyTable(r) +
        `<h3>All measures</h3>${armTable(r.arms)}`
      : "",
    r.retrieval ? retrieval(r.retrieval) : "",
    r.runs.length > 0
      ? `<h2>Every run</h2>${runsTable(r.runs)}` +
        `<h2>From a score to the evidence</h2><p class="sub">Each run's approved design, item by item, with the passage it cites and the quoted words marked.</p>` +
        r.runs.map(runDetail).join("")
      : "",
    `<p class="muted" style="margin-top:40px">Not on this page yet: the chain from criterion to test to defect, the trend across versions, and the judge model's panel. ` +
      `attestqa eval, format ${r.evalVersion}. Everything here is in eval.json; this file fetches nothing.</p>`,
  ].join("\n");
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>attestqa evaluation</title><style>${STYLE}</style></head>` +
    `<body><main>${body}</main><div id="tip" role="tooltip"></div><script>${SCRIPT}</script></body></html>\n`
  );
}
