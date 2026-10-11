// Seeds a Jira project with the attestqa practice backlog (backlog.json).
//
//   node scripts/jira-seed/seed.mjs            # dry run: prints what it would create
//   node scripts/jira-seed/seed.mjs --apply    # creates it
//
// Reads JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN (or JIRA_PAT) from the
// environment or from .env in the current directory. The token never leaves
// this machine except to your Jira. Safe to re-run: anything already created
// (same summary, label aqa-seed) is reused, not duplicated.
//
// It creates, never edits or deletes — except moving the seeded bug to the
// status named in backlog.json, which is a transition on an issue it made.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes("--apply");
const envFile = process.argv.find((a) => a.startsWith("--env="))?.slice(6) ?? ".env";

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

const base = (process.env.JIRA_BASE_URL ?? "").replace(/\/+$/, "");
const email = process.env.JIRA_EMAIL;
const token = process.env.JIRA_API_TOKEN;
const pat = process.env.JIRA_PAT;
if (!base || !(pat || (email && token))) {
  console.error(
    `Set JIRA_BASE_URL and JIRA_EMAIL + JIRA_API_TOKEN (or JIRA_PAT) in ${envFile} first.`,
  );
  process.exit(1);
}
const auth = pat
  ? `Bearer ${pat}`
  : `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
const api = `${base}/rest/api/3`;

async function jira(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const para = (t) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
function adf(lines, acceptance) {
  const content = lines.map(para);
  if (acceptance?.length) {
    // Acceptance criteria LAST, under their own heading: that is the section the
    // attestqa Jira adapter reads them from when no custom field is configured.
    content.push({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Acceptance criteria" }],
    });
    content.push(...acceptance.map(para));
  }
  return { type: "doc", version: 1, content };
}

const plan = JSON.parse(readFileSync(join(here, "backlog.json"), "utf8"));
const P = plan.project;
const LABEL = plan.label;

const me = await jira("GET", "/myself");
console.log(`Jira ${base} as ${me.displayName} — ${apply ? "APPLY" : "dry run (add --apply to create)"}`);

// Issue type names differ between team-managed and company-managed projects
// (Subtask vs Sub-task), so read them from the project instead of guessing.
const meta = await jira("GET", `/issue/createmeta/${P}/issuetypes?maxResults=50`);
const types = (meta.issueTypes ?? meta.values ?? []).map((t) => ({
  id: t.id,
  name: t.name,
  subtask: t.subtask,
}));
const typeOf = (want) => {
  const t =
    want === "subtask"
      ? types.find((x) => x.subtask)
      : types.find((x) => x.name.toLowerCase() === want.toLowerCase());
  if (!t) throw new Error(`project ${P} has no "${want}" issue type (has: ${types.map((x) => x.name).join(", ")})`);
  return t;
};
console.log(`issue types: ${types.map((t) => t.name).join(", ")}`);

async function existing(summary) {
  const jql = `project = ${P} AND labels = "${LABEL}" AND summary ~ "\\"${summary.replace(/"/g, '\\\\"')}\\""`;
  const r = await jira("POST", "/search/jql", { jql, maxResults: 10, fields: ["summary"] });
  return (r.issues ?? []).find((i) => i.fields?.summary === summary)?.key;
}

const keys = {};
async function create(ref, type, summary, description, extra = {}) {
  const found = await existing(summary);
  if (found) {
    console.log(`  = ${found}  ${type.name}: ${summary} (already there)`);
    return (keys[ref] = found);
  }
  if (!apply) {
    console.log(`  + ${type.name}: ${summary}`);
    return (keys[ref] = `${P}-?(${ref})`);
  }
  const r = await jira("POST", "/issue", {
    fields: {
      project: { key: P },
      issuetype: { id: type.id },
      summary,
      description,
      labels: [LABEL],
      ...extra,
    },
  });
  console.log(`  + ${r.key}  ${type.name}: ${summary}`);
  return (keys[ref] = r.key);
}

const epicType = typeOf("Epic");
const storyType = typeOf("Story");
const bugType = typeOf("Bug");
const subType = typeOf("subtask");

console.log("\nEpic");
await create("epic", epicType, plan.epic.summary, adf(plan.epic.description));

console.log("\nStories");
for (const s of plan.stories) {
  const parent = apply ? { parent: { key: keys.epic } } : {};
  await create(s.ref, storyType, s.summary, adf(s.description, s.acceptance), parent);
  for (const t of s.subtasks ?? []) {
    await create(`${s.ref}-task`, subType, t.summary, adf([t.summary]), apply ? { parent: { key: keys[s.ref] } } : {});
  }
  for (const c of s.comments ?? []) {
    if (!apply) {
      console.log(`    comment: ${c.slice(0, 70)}…`);
      continue;
    }
    const have = await jira("GET", `/issue/${keys[s.ref]}/comment?maxResults=100`);
    const already = (have.comments ?? []).some((x) => JSON.stringify(x.body).includes(c.slice(0, 40)));
    if (!already) {
      await jira("POST", `/issue/${keys[s.ref]}/comment`, { body: adf([c]) });
      console.log(`    comment added to ${keys[s.ref]}`);
    }
  }
}

console.log("\nBugs");
for (const b of plan.bugs) {
  await create(b.ref, bugType, b.summary, adf(b.description));
  if (!apply) {
    console.log(`    link: relates to ${b.story}; status → ${b.status ?? "(unchanged)"}`);
    continue;
  }
  // Link to its story, once.
  const issue = await jira("GET", `/issue/${keys[b.ref]}?fields=issuelinks,status`);
  const linked = (issue.fields.issuelinks ?? []).some(
    (l) => l.inwardIssue?.key === keys[b.story] || l.outwardIssue?.key === keys[b.story],
  );
  if (!linked) {
    await jira("POST", "/issueLink", {
      type: { name: "Relates" },
      inwardIssue: { key: keys[b.ref] },
      outwardIssue: { key: keys[b.story] },
    });
    console.log(`    linked ${keys[b.ref]} relates to ${keys[b.story]}`);
  }
  if (b.status && issue.fields.status?.name !== b.status) {
    const tr = await jira("GET", `/issue/${keys[b.ref]}/transitions`);
    const to = (tr.transitions ?? []).find((t) => t.to?.name?.toLowerCase() === b.status.toLowerCase());
    if (to) {
      await jira("POST", `/issue/${keys[b.ref]}/transitions`, { transition: { id: to.id } });
      console.log(`    ${keys[b.ref]} moved to ${b.status}`);
    } else console.log(`    (no transition to "${b.status}" from ${issue.fields.status?.name}; left as is)`);
  }
}

console.log("\nKeys:", JSON.stringify(keys));
if (apply)
  console.log(
    `\nIn ai-quality.config.yaml, allow them with agent.scope.work_items: ["${P}-*"]` +
      ` — then: aqa run "Write tests for ${keys.login}" --config ...`,
  );
