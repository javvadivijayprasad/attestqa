import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";


/**
 * The extension and the runtime version independently on purpose: the ledger
 * event shapes are a contract, and a user pinning an older runtime must not be
 * forced to upgrade because the editor integration changed. So we locate
 * whatever `aqa` the user has rather than bundling one.
 */
export interface Runtime {
  /** Absolute path, or the bare command name when found on PATH. */
  command: string;
  version: string;
}

const PACKAGE = "attestqa";
const BIN = process.platform === "win32" ? "aqa.cmd" : "aqa";

function candidates(folder: vscode.WorkspaceFolder): string[] {
  const configured = vscode.workspace
    .getConfiguration("aqa")
    .get<string>("executablePath", "")
    .trim();
  const found: string[] = [];
  if (configured) found.push(configured);
  found.push(join(folder.uri.fsPath, "node_modules", ".bin", BIN));
  // Bare name last: resolved by PATH, which is the common global-install case.
  found.push(BIN);
  return found;
}

/**
 * Start `aqa`. On Windows the npm shim is `aqa.cmd`, which Node refuses to
 * spawn directly (EINVAL since the 2024 batch-file fix), so it goes through the
 * shell — with every argument quoted, because the shell would otherwise split
 * "Write tests for SHOP-12" into four words.
 */
export function spawnAqa(
  command: string,
  args: string[],
  opts: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const q = (a: string): string => `"${a.replace(/"/g, '""')}"`;
    return spawn([q(command), ...args.map(q)].join(" "), [], { ...opts, shell: true });
  }
  return spawn(command, args, { ...opts, shell: false });
}

async function versionOf(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAqa(command, ["--version"]);
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 15_000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const v = out.trim();
      resolve(code === 0 && v.length > 0 ? v : undefined);
    });
  });
}

/**
 * Resolve the runtime, offering to install it when absent.
 *
 * Returns `undefined` when it could not be found and the user declined to
 * install — the caller should abandon the command quietly rather than erroring,
 * because the user has already been told what is missing.
 */
export async function resolveRuntime(
  folder: vscode.WorkspaceFolder,
  opts: { silent?: boolean } = {},
): Promise<Runtime | undefined> {
  for (const command of candidates(folder)) {
    // A configured path that does not exist is worth saying out loud rather
    // than silently falling through to PATH and running a different binary.
    if (command !== BIN && !existsSync(command)) continue;
    const version = await versionOf(command);
    if (version) return { command, version };
  }

  if (opts.silent) return undefined;

  const install = "Install globally";
  const choose = "Choose path…";
  const answer = await vscode.window.showWarningMessage(
    "The attestqa CLI (aqa) was not found.",
    { modal: false },
    install,
    choose,
  );

  if (answer === choose) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: "Use this aqa executable",
      title: "Locate the aqa executable",
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return undefined;
    const version = await versionOf(file);
    if (!version) {
      void vscode.window.showErrorMessage(`${file} did not respond to --version.`);
      return undefined;
    }
    await vscode.workspace
      .getConfiguration("aqa")
      .update("executablePath", file, vscode.ConfigurationTarget.Workspace);
    return { command: file, version };
  }

  if (answer === install) {
    // A terminal rather than a silent exec: a global install is the user's
    // machine and they should be able to see and stop it.
    const terminal = vscode.window.createTerminal("attestqa install");
    terminal.show();
    terminal.sendText(`npm install -g ${PACKAGE}`);
    void vscode.window.showInformationMessage(
      "Installing. When it finishes, run the command again.",
    );
  }

  return undefined;
}
