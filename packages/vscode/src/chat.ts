import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { usesCopilot } from "./copilot";
import type { RunsTreeProvider } from "./ledger";
import { exitMeaning, launchRun, RunSetupError, type RunSettings } from "./runner";
import { resolveRuntime } from "./runtime";
import { findStoryRef } from "./story";

/**
 * @attestqa in Copilot Chat. Starts the same governed run as Run story… and
 * reports it in the chat. Two things are deliberately NOT done from the chat:
 * nothing is approved by typing (approvals stay in their own dialog, each one
 * a separate decision), and Copilot's Agent mode is not given attestqa's tools —
 * the engine runs the loop, so its rules and run record cannot be bypassed.
 */
export function registerChat(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  runs: RunsTreeProvider,
  settings: () => RunSettings,
): void {
  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      stream.markdown("Open your Playwright project folder in VS Code first.");
      return;
    }
    const s = settings();
    const configPath = join(folder.uri.fsPath, s.configFile);

    if (request.command === "setup" || !existsSync(configPath)) {
      stream.markdown(
        existsSync(configPath)
          ? "Setup asks four questions and writes the config and a `.env` to fill in."
          : `This folder has no \`${s.configFile}\` yet. Setup asks four questions — tracker, which stories, where the app runs, which model — and writes it.`,
      );
      stream.button({ command: "aqa.init", title: "Set up this folder" });
      return;
    }

    const runtime = await resolveRuntime(folder);
    if (!runtime) {
      stream.markdown("The attestqa command line (`aqa`) was not found. Install it with `npm install -g attestqa`.");
      return;
    }

    if (request.command === "coverage") {
      stream.markdown("Opening the coverage report.");
      stream.button({ command: "aqa.showCoverage", title: "Show coverage" });
      return;
    }

    const story = findStoryRef(request.prompt);
    if (!story) {
      stream.markdown(
        "Which story? For example `@attestqa write tests for SHOP-12`, `@attestqa AB#44`, or `@attestqa /dryrun SHOP-12` to check the setup without spending anything.",
      );
      return;
    }

    const dryRun = request.command === "dryrun";
    const config = readFileSync(configPath, "utf8");
    const copilot = usesCopilot(config);
    const chatModel = copilot && request.model.vendor === "copilot" ? request.model : undefined;
    if (!copilot && !dryRun)
      stream.markdown(
        "_This project's config names its own model, so the run uses that rather than the model picked in this chat. To use Copilot, choose **GitHub Copilot** in Set up this folder._\n\n",
      );

    stream.markdown(
      dryRun
        ? `**Dry run for ${story.label}** — checks the config, the connection and the tools; no model call, nothing spent.\n\n`
        : `**Writing tests for ${story.label}**${chatModel ? ` with ${chatModel.name}` : ""}. You approve the test design, the test run and any bug in attestqa's own approval dialog — nothing is approved from this chat.\n\n`,
    );

    try {
      let lastLine = "";
      const code = await launchRun({
        folder,
        command: runtime.command,
        story,
        dryRun,
        settings: s,
        log,
        cancel: token,
        ...(chatModel ? { chatModel } : {}),
        onText: (text) => {
          for (const line of text.split(/\r?\n/)) {
            if (!line.startsWith("aqa: ") || line === lastLine) continue;
            lastLine = line;
            stream.progress(line.slice(5, 160));
          }
        },
      });
      runs.refresh();
      stream.markdown(`**${story.label}: ${exitMeaning(code)}.** The full output is in the attestqa output panel.\n\n`);
      if (!dryRun) {
        stream.button({ command: "aqa.showCoverage", title: "Show coverage" });
        stream.button({ command: "aqa.replayRun", title: "Replay the run" });
      }
      return { metadata: { story: story.label, exitCode: code } };
    } catch (e) {
      stream.markdown(e instanceof RunSetupError ? e.message : `Could not run attestqa: ${(e as Error).message}`);
      return;
    }
  };

  const participant = vscode.chat.createChatParticipant("attestqa.chat", handler);
  participant.iconPath = new vscode.ThemeIcon("beaker");
  context.subscriptions.push(participant);
}
