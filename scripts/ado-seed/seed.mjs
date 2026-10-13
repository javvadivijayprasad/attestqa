// Seeds an Azure DevOps project with an attestqa evaluation backlog.
//
//   node scripts/ado-seed/seed.mjs --file=booker.json                 # dry run
//   node scripts/ado-seed/seed.mjs --file=booker.json --apply         # creates it
//   ... --env=packages/core/.env                                      # where the PAT is
//   ... --create-project     # create the project first if it does not exist (PAT scope:
//                            # Project and Team: read, write & manage)
//
// Reads AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT from the environment or the
// --env file (default .env). The project comes from the backlog file, so each
// application gets its own project: attestqa reads every open bug in a
// project, and two applications in one project would see each other's bugs.
// The PAT never leaves this machine except to your organisation.
//
// It creates, never edits or deletes — except setting the state of a seeded
// bug it created. Safe to re-run: an item with the same type and title and the
// tag aqa-seed is reused, not duplicated. Fields the seeder does not post —
// "kind", "order", "uiChange", "verify" — are notes for the evaluation, kept
// out of the tracker so the agent never sees them.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes("--apply");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const envFile = arg("env") ?? ".env";
const planFile = arg("file");
if (!planFile) {
  console.error("Name the backlog: --file=booker.json (or saucedemo.json)");
  process.exit(1);
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith("#")) continue;
    const v = m[2].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") process.env[m[1]] = v;
  }
}
loadEnv(envFile);

const org = (process.env.AZURE_DEVOPS_ORG_URL ?? "").replace(/\/+$/, "");
const pat = process.env.AZURE_DEVOPS_PAT;
if (!org || !pat) {
  console.error(`Set AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT in ${envFile} first.`);
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

const plan = JSON.parse(readFileSync(join(here, planFile), "utf8"));
const P = plan.project;
const TAG = plan.label ?? "aqa-seed";
const T = { epic: "Epic", story: "User Story", task: "Task", bug: "Bug", ...(plan.types ?? {}) };
const proj = `${org}/${encodeURIComponent(P)}`;

// Refs name epics, stories and bugs in one namespace; a story named like its
// epic overwrote the epic's key in the printed list (Toolshop "contact").
{
  const all = [...plan.epics.map((e) => e.ref), ...plan.stories.map((s) => s.ref), ...plan.bugs.map((b) => b.ref)];
  const dup = all.filter((r, i) => all.indexOf(r) !== i);
  if (dup.length) {
    console.error(`duplicate ref(s) in ${planFile}: ${[...new Set(dup)].join(", ")} — every epic, story and bug needs its own ref`);
    process.exit(1);
  }
}

async function ado(method, url, body, contentType = "application/json") {
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth, Accept: "application/json", "Content-Type": contentType },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url.replace(org, "")} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (lines) => lines.map((l) => `<div>${esc(l)}</div>`).join("");
const list = (lines) => `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;

async function existing(type, title) {
  const q = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = '${type}' AND [System.Tags] CONTAINS '${TAG}' AND [System.Title] = '${title.replace(/'/g, "''")}'`;
  const r = await ado("POST", `${proj}/_apis/wit/wiql?api-version=7.1`, { query: q });
  const id = r.workItems?.[0]?.id;
  return id ? await ado("GET", `${org}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.1`) : undefined;
}

const items = {};
async function create(ref, type, title, fields, parentRef) {
  const found = await existing(type, title);
  if (found) {
    console.log(`  = #${found.id}  ${type}: ${title} (already there)`);
    return (items[ref] = found);
  }
  if (!apply) {
    console.log(`  + ${type}: ${title}${parentRef ? `  (child of ${parentRef})` : ""}`);
    return (items[ref] = { id: `?(${ref})`, url: "" });
  }
  const ops = [
    { op: "add", path: "/fields/System.Title", value: title },
    { op: "add", path: "/fields/System.Tags", value: TAG },
    ...Object.entries(fields).map(([k, v]) => ({ op: "add", path: `/fields/${k}`, value: v })),
  ];
  if (parentRef)
    ops.push({
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: items[parentRef].url },
    });
  const r = await ado(
    "POST",
    `${proj}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`,
    ops,
    "application/json-patch+json",
  );
  console.log(`  + #${r.id}  ${type}: ${title}`);
  return (items[ref] = r);
}

console.log(`Azure DevOps ${org}, project ${P} — ${apply ? "APPLY" : "dry run (add --apply to create)"}`);
const createProject = process.argv.includes("--create-project");
const haveProject = await ado("GET", `${org}/_apis/projects/${encodeURIComponent(P)}?api-version=7.1`).then(
  () => true,
  () => false,
);
if (!haveProject) {
  if (!createProject) {
    console.error(`Project "${P}" not found in ${org}. Add --create-project to create it (Agile process).`);
    process.exit(1);
  }
  // Agile, because the seed uses User Story, Bug states New/Active/Resolved and
  // the Acceptance Criteria field. Read the process id rather than hard-code it.
  const procs = await ado("GET", `${org}/_apis/process/processes?api-version=7.1`);
  const agile = (procs.value ?? []).find((x) => x.name === (plan.process ?? "Agile"));
  if (!agile) throw new Error(`no "${plan.process ?? "Agile"}" process in ${org}`);
  if (!apply) {
    console.log(`  + project ${P} (process ${agile.name}) — would be created`);
    console.log("\n(dry run stops here: nothing below can be listed until the project exists)");
    process.exit(0);
  }
  const op = await ado("POST", `${org}/_apis/projects?api-version=7.1`, {
    name: P,
    description: plan.target ?? "attestqa evaluation backlog",
    visibility: "private",
    capabilities: {
      versioncontrol: { sourceControlType: "Git" },
      processTemplate: { templateTypeId: agile.id },
    },
  });
  // Project creation is asynchronous: wait for the operation to finish.
  for (let i = 0; i < 60; i++) {
    const st = await ado("GET", `${org}/_apis/operations/${op.id}?api-version=7.1`);
    if (st.status === "succeeded") break;
    if (st.status === "failed" || st.status === "cancelled") throw new Error(`creating ${P}: ${st.status} ${st.resultMessage ?? ""}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  + project ${P} created (process ${agile.name})`);
}

console.log("\nEpics");
for (const e of plan.epics)
  await create(e.ref, T.epic, e.summary, { "System.Description": html(e.description) });

console.log("\nStories");
for (const s of plan.stories) {
  await create(
    s.ref,
    T.story,
    s.summary,
    {
      "System.Description": html(s.description),
      "Microsoft.VSTS.Common.AcceptanceCriteria": list(s.acceptance),
    },
    s.epic,
  );
  for (const [i, t] of (s.subtasks ?? []).entries())
    await create(`${s.ref}-task-${i}`, T.task, t.summary, { "System.Description": html([t.summary]) }, s.ref);
  for (const c of s.comments ?? []) {
    if (!apply) {
      console.log(`    comment: ${c.slice(0, 70)}…`);
      continue;
    }
    const url = `${proj}/_apis/wit/workItems/${items[s.ref].id}/comments?api-version=7.1-preview.4`;
    const have = await ado("GET", url);
    if (!(have.comments ?? []).some((x) => (x.text ?? "").includes(esc(c.slice(0, 40))))) {
      await ado("POST", url, { text: esc(c) });
      console.log(`    comment added to #${items[s.ref].id}`);
    }
  }
}

console.log("\nBugs");
for (const b of plan.bugs) {
  await create(b.ref, T.bug, b.summary, { "Microsoft.VSTS.TCM.ReproSteps": html(b.description) });
  if (!apply) {
    console.log(`    link: related to ${b.story}; state → ${b.state ?? "(unchanged)"}`);
    continue;
  }
  const bug = await ado("GET", `${org}/_apis/wit/workitems/${items[b.ref].id}?$expand=relations&api-version=7.1`);
  const storyUrl = items[b.story].url;
  const ops = [];
  if (!(bug.relations ?? []).some((r) => r.url === storyUrl))
    ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Related", url: storyUrl } });
  if (b.state && bug.fields["System.State"] !== b.state)
    ops.push({ op: "add", path: "/fields/System.State", value: b.state });
  if (ops.length) {
    await ado("PATCH", `${org}/_apis/wit/workitems/${bug.id}?api-version=7.1`, ops, "application/json-patch+json");
    console.log(`    #${bug.id}: linked to #${items[b.story].id}${b.state ? `, state ${b.state}` : ""}`);
  }
}

const ids = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.id]));
console.log("\nIds:", JSON.stringify(ids));
if (apply) {
  const nums = Object.values(ids).filter((n) => typeof n === "number").sort((a, b) => a - b);
  console.log(
    `\nIn this application's config: agent.scope.work_items: ["${nums[0]}-${nums[nums.length - 1]}"]` +
      ` and AZURE_DEVOPS_PROJECT=${P}`,
  );
}
