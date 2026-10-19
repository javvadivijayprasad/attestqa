import { presentEnvFiles } from "./env-files";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { CopilotBridge, copilotModels, usesCopilot } from "./copilot";
import { spawnAqa } from "./runtime";
import { requestFor, type StoryRef } from "./story";

/**
 * Starting one `aqa run`, shared by the Run story… command and @attestqa in
 * Copilot Chat, so a run behaves the same whichever way it was started. The
 * engine decides everything; this builds the command line, lends it Copilot
 * when the config asks for it, and reports the output and the exit code.
 */
export interface RunSettings {
  configFile: string;
  workspaceDir: string;
  envFile: string;
  ledgerDir: string;
  approvalTimeoutSeconds: number;
}

export interface RunParams {
  folder: vscode.WorkspaceFolder;
  command: string;
  story: StoryRef;
  dryRun: boolean;
  settings: RunSettings;
  log: vscode.OutputChannel;
  /** Each chunk of the engine's output, as it arrives. */
  onText: (text: string) => void;
  cancel?: vscode.CancellationToken;
  /** The model picked in Copilot Chat, for a run started with @attestqa. */
  chatModel?: vscode.LanguageModelChat;
}

export class RunSetupError extends Error {}

export function runArgs(story: StoryRef, s: RunSettings, dryRun: boolean, envFiles: string[]): string[] {
  const args = ["run", requestFor(story), "--config", s.configFile, "--workspace", s.workspaceDir, "--ledger", s.ledgerDir];
  // The credentials file is passed by name; the extension never opens it.
  if (envFiles.length > 0) args.push("--env", envFiles.join(","));
  if (dryRun) args.push("--dry-run");
  // File approval is what lets the editor answer instead of a terminal.
  else args.push("--approval", "file", "--approval-timeout", String(s.approvalTimeoutSeconds));
  return args;
}

/** Runs `aqa run` to the end; resolves with its exit code. */
export async function launchRun(p: RunParams): Promise<number | null> {
  const root = p.folder.uri.fsPath;
  const args = runArgs(p.story, p.settings, p.dryRun, presentEnvFiles(root, p.settings.envFile));

  // GitHub Copilot: VS Code lends its models to extensions, not to the engine
  // process, so the run's model calls are relayed through a private address.
  let bridge: CopilotBridge | undefined;
  const extraEnv: Record<string, string> = {};
  const configPath = join(root, p.settings.configFile);
  if (!p.dryRun && existsSync(configPath) && usesCopilot(readFileSync(configPath, "utf8"))) {
    // Asked while the person has just started the run: VS Code shows its
    // consent prompt only for a user-initiated action.
    const model = p.chatModel ?? (await copilotModels())[0];
    if (!model)
      throw new RunSetupError(
        "This project uses GitHub Copilot, but VS Code offers no Copilot models. Sign in to GitHub Copilot and allow attestqa to use it, then run again.",
      );
    bridge = new CopilotBridge(p.log, p.chatModel);
    extraEnv["AQA_VSCODE_LM_ENDPOINT"] = await bridge.start();
    extraEnv["AQA_VSCODE_LM_TOKEN"] = bridge.token;
    // The chat's model is the one used, so the ledger names it (AQA_MODEL
    // overrides the config's model name, never its provider).
    if (p.chatModel) extraEnv["AQA_MODEL"] = p.chatModel.family;
    p.log.appendLine(`copilot: relaying model calls for this run${p.chatModel ? ` to ${p.chatModel.family}` : ""}`);
  }

  p.log.appendLine(`\n$ ${p.command} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  return new Promise<number | null>((resolve) => {
    // The token reaches the engine through its environment, never its arguments.
    const child = spawnAqa(p.command, args, { cwd: root, env: { ...process.env, ...extraEnv } });
    p.cancel?.onCancellationRequested(() => {
      p.log.appendLine("cancelled — stopping the run");
      child.kill();
    });
    const onData = (d: Buffer): void => {
      const text = d.toString();
      p.log.append(text);
      p.onText(text);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      bridge?.dispose();
      p.log.appendLine(`failed to start: ${err.message}`);
      resolve(null);
    });
    child.on("close", (code) => {
      bridge?.dispose();
      p.log.appendLine(`\nexit ${code ?? "?"}`);
      resolve(code);
    });
  });
}

/** What each exit code means to a person (0 done, 1 error, 2 blocked, 3 refused, 4 budget). */
export function exitMeaning(code: number | null): string {
  switch (code) {
    case 0:
      return "done — the verifier accepted the run";
    case 2:
      return "blocked — the rules stopped the run; the record says why";
    case 3:
      return "refused — the request was outside what this project allows";
    case 4:
      return "stopped at its budget";
    default:
      return "failed — see the attestqa output for why";
  }
}
