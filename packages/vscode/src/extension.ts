import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { ApprovalWatcher } from "./approvals";
import { listRuns, RunsTreeProvider, type RunEvent, type RunSummary } from "./ledger";
import { resolveRuntime, spawnAqa } from "./runtime";
import { parseStoryRef, requestFor } from "./story";

/**
 * A thin client of the `aqa` CLI (ADR-003). Every rule lives in the engine; this
 * file only starts it, streams its output, answers approvals through the file
 * contract, and opens what it writes. Nothing here may decide anything the
 * engine would decide differently.
 */

const USER_GUIDE =
  "https://github.com/javvadivijayprasad/attestqa/blob/main/packages/core/docs/USAGE.md";

interface Settings {
  configFile: string;
  workspaceDir: string;
  envFile: string;
  ledgerDir: string;
  approvalTimeoutSeconds: number;
}

function settings(): Settings {
  const c = vscode.workspace.getConfiguration("aqa");
  return {
    configFile: c.get<string>("configFile", "ai-quality.config.yaml"),
    workspaceDir: c.get<string>("workspaceDir", "."),
    envFile: c.get<string>("envFile", ".env"),
    ledgerDir: c.get<string>("ledgerDir", ".aqa"),
    approvalTimeoutSeconds: c.get<number>("approvalTimeoutSeconds", 1800),
  };
}

function firstFolder(): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) void vscode.window.showErrorMessage("Open a folder before running attestqa.");
  return folder;
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("attestqa");
  context.subscriptions.push(log);

  const folder = vscode.workspace.workspaceFolders?.[0];
  const cfg = settings();

  const runs = new RunsTreeProvider(folder ? join(folder.uri.fsPath, cfg.ledgerDir) : cfg.ledgerDir);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("aqa.runs", runs));

  let approvals: ApprovalWatcher | undefined;
  if (folder) {
    approvals = new ApprovalWatcher(folder, cfg.ledgerDir, log);
    context.subscriptions.push(approvals);

    // Keep the tree honest while a run is writing to it.
    const ledgerWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${cfg.ledgerDir}/runs/*/events.jsonl`),
    );
    ledgerWatcher.onDidCreate(() => runs.refresh());
    ledgerWatcher.onDidChange(() => runs.refresh());
    context.subscriptions.push(ledgerWatcher);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("aqa")) return;
      const f = vscode.workspace.workspaceFolders?.[0];
      if (f) runs.setLedgerRoot(join(f.uri.fsPath, settings().ledgerDir));
    }),
  );

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler as (...args: unknown[]) => unknown),
    );
  };

  register("aqa.refreshRuns", () => runs.refresh());
  register("aqa.openPendingApproval", () => void approvals?.promptPending());
  register("aqa.openUserGuide", () => void vscode.env.openExternal(vscode.Uri.parse(USER_GUIDE)));

  register("aqa.showRuntimeVersion", async () => {
    const f = firstFolder();
    if (!f) return;
    const runtime = await resolveRuntime(f);
    if (!runtime) return;
    void vscode.window.showInformationMessage(`attestqa ${runtime.version} — ${runtime.command}`);
  });

  register("aqa.openEvent", async (run: RunSummary, event: RunEvent) => {
    const doc = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(event, null, 2),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
    log.appendLine(`opened event ${event.eventId} of ${run.runId}`);
  });

  register("aqa.runStory", () => void runStory(context, log, runs, false));
  register("aqa.dryRun", () => void runStory(context, log, runs, true));

  register("aqa.replayRun", async () => {
    const f = firstFolder();
    if (!f) return;
    const runtime = await resolveRuntime(f);
    if (!runtime) return;
    const root = join(f.uri.fsPath, settings().ledgerDir);
    await execToDocument(runtime.command, ["replay", root], f.uri.fsPath, log, "markdown", {
      empty: "Nothing to replay yet — no runs found.",
    });
  });

  register("aqa.showCoverage", async () => {
    const f = firstFolder();
    if (!f) return;
    const runtime = await resolveRuntime(f);
    if (!runtime) return;
    const s = settings();
    // Exit 3 means "something is not covered"; the report is still the answer.
    await execToDocument(
      runtime.command,
      ["coverage", "--workspace", s.workspaceDir, "--ledger", s.ledgerDir],
      f.uri.fsPath,
      log,
      "markdown",
      { empty: "No coverage to show yet — run a story first.", preview: true },
    );
  });

  register("aqa.checkRules", async () => {
    const f = firstFolder();
    if (!f) return;
    const runtime = await resolveRuntime(f);
    if (!runtime) return;
    const s = settings();
    const recent = listRuns(join(f.uri.fsPath, s.ledgerDir))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 10);
    if (recent.length === 0) {
      void vscode.window.showInformationMessage("No runs to check yet.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      recent.map((r) => ({ label: r.runId, description: r.status, picked: true, run: r })),
      { canPickMany: true, title: "Check which runs against today's rules?" },
    );
    if (!picked || picked.length === 0) return;
    await execToDocument(
      runtime.command,
      [
        "check-rules",
        ...picked.map((p) => p.run.dir),
        "--config",
        s.configFile,
        "--workspace",
        s.workspaceDir,
      ],
      f.uri.fsPath,
      log,
      "plaintext",
      { empty: "check-rules printed nothing." },
    );
  });
}

async function runStory(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  runs: RunsTreeProvider,
  dryRun: boolean,
): Promise<void> {
  const folder = firstFolder();
  if (!folder) return;

  const runtime = await resolveRuntime(folder);
  if (!runtime) return;

  const last = context.workspaceState.get<string>("aqa.lastStory", "");
  const input = await vscode.window.showInputBox({
    title: dryRun ? "attestqa — dry run" : "attestqa — run story",
    prompt: "Story to write tests for: a Jira key (SHOP-12) or an Azure DevOps id (123)",
    placeHolder: "SHOP-12",
    value: last,
    validateInput: (value) =>
      parseStoryRef(value) ? undefined : "Enter a Jira key like SHOP-12, or an Azure DevOps id like 123.",
  });
  const story = input ? parseStoryRef(input) : undefined;
  if (!story) return;
  await context.workspaceState.update("aqa.lastStory", story.label);

  const cfg = settings();
  const args = [
    "run",
    requestFor(story),
    "--config",
    cfg.configFile,
    "--workspace",
    cfg.workspaceDir,
    "--ledger",
    cfg.ledgerDir,
  ];
  // The credentials file is passed by name; the extension never opens it.
  if (existsSync(join(folder.uri.fsPath, cfg.envFile))) args.push("--env", cfg.envFile);
  if (dryRun) {
    args.push("--dry-run");
  } else {
    // File approval is what lets the editor answer instead of a terminal.
    args.push("--approval", "file", "--approval-timeout", String(cfg.approvalTimeoutSeconds));
  }

  log.show(true);
  log.appendLine(`\n$ ${runtime.command} ${args.map(quote).join(" ")}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: dryRun ? `attestqa: dry run for ${story.label}` : `attestqa: ${story.label}`,
      cancellable: true,
    },
    (progress, token) =>
      new Promise<void>((resolve) => {
        const child = spawnAqa(runtime.command, args, { cwd: folder.uri.fsPath });

        token.onCancellationRequested(() => {
          log.appendLine("cancelled — stopping the run");
          child.kill();
        });

        const onData = (d: Buffer): void => {
          const text = d.toString();
          log.append(text);
          // The CLI's own progress lines ("aqa: …") are the progress message.
          const line = text
            .split(/\r?\n/)
            .reverse()
            .find((l) => l.startsWith("aqa: "));
          if (line) progress.report({ message: line.slice(5, 120) });
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);

        child.on("error", (err) => {
          log.appendLine(`failed to start: ${err.message}`);
          void vscode.window.showErrorMessage(`Could not start aqa: ${err.message}`);
          resolve();
        });

        child.on("close", (code) => {
          log.appendLine(`\nexit ${code ?? "?"}`);
          runs.refresh();
          report(code, dryRun);
          resolve();
        });
      }),
  );
}

/**
 * Exit codes are a contract: 0 done, 1 error, 2 blocked, 3 refused, 4 budget.
 * Only one of those is a failure. A blocked run is the governance machinery
 * doing its job, and reporting it as an error teaches people to ignore it.
 */
function report(code: number | null, dryRun: boolean): void {
  const coverage = "Show coverage";
  const pick = (choice: string | undefined): void => {
    if (choice === coverage) void vscode.commands.executeCommand("aqa.showCoverage");
  };
  switch (code) {
    case 0:
      if (dryRun) void vscode.window.showInformationMessage("Dry run finished.");
      else
        void vscode.window
          .showInformationMessage("attestqa: done — the run did what the story needed.", coverage)
          .then(pick);
      return;
    case 2:
      void vscode.window
        .showWarningMessage(
          "attestqa: blocked — see the output for what remains. Nothing unapproved was written.",
          coverage,
        )
        .then(pick);
      return;
    case 3:
      void vscode.window.showWarningMessage(
        "attestqa: refused — the story or an action is outside the config's scope. Nothing was spent.",
      );
      return;
    case 4:
      void vscode.window.showWarningMessage(
        "attestqa: budget reached. Raise budgets.steps or budgets.tokens in the config if that was too tight.",
      );
      return;
    default:
      void vscode.window.showErrorMessage(
        `attestqa failed (exit ${code ?? "?"}). See the attestqa output for why.`,
      );
  }
}

function quote(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

async function execToDocument(
  command: string,
  args: string[],
  cwd: string,
  log: vscode.OutputChannel,
  language: string,
  opts: { empty: string; preview?: boolean },
): Promise<void> {
  const output = await new Promise<string>((resolve) => {
    let buffer = "";
    const child = spawnAqa(command, args, { cwd });
    child.stdout.on("data", (d: Buffer) => (buffer += d.toString()));
    child.stderr.on("data", (d: Buffer) => log.append(d.toString()));
    child.on("error", (err) => resolve(`Could not run ${command}: ${err.message}`));
    child.on("close", () => resolve(buffer));
  });

  if (!output.trim()) {
    void vscode.window.showInformationMessage(opts.empty);
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ language, content: output });
  if (opts.preview && language === "markdown") {
    await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
    return;
  }
  await vscode.window.showTextDocument(doc, { preview: false });
}

export function deactivate(): void {
  // Nothing to tear down: everything registered goes through context.subscriptions.
}
