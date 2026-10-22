/**
 * Spawns the CLI as a subprocess. The whole suite is black-box: nothing under `src/` is
 * imported, so what is asserted is what a user actually gets.
 *
 * Two rules are enforced here rather than left to each test:
 *
 *  1. **cwd is always a fresh temp directory.** `loadConfig()` probes cwd for
 *     `renderdiff.config.{ts,mts,js,mjs}`. Running from the repo root would silently pick up a
 *     config someone adds there later, and the failure would look like a test bug.
 *  2. **`--out` always points into a temp directory.** `run()` starts with
 *     `fs.rmSync(outDir, {recursive:true, force:true})`, so a mistargeted `--out` deletes
 *     a real directory.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

const tempDirs: string[] = [];

/** A temp directory that `cleanupTempDirs()` will remove. */
export function tempDir(prefix = "renderdiff-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Call from an `after` hook. Never throws — leaked temp files are not a test failure. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS will get to it */
    }
  }
}

export interface CliOptions {
  /** Working directory for the subprocess. Defaults to a fresh empty temp dir. */
  cwd?: string;
  /** Skip appending `--out`. Only for runs that never reach the browser (`--dry-run`). */
  noOut?: boolean;
  /** Reuse an out dir from an earlier run, e.g. for `--rerun-failed`. Must be a `CliResult.outDir`. */
  outDir?: string;
  timeoutMs?: number;
  /** Extra environment variables for the subprocess. */
  env?: Record<string, string>;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Where the run wrote its images and `report.html`. */
  outDir: string;
  cwd: string;
  /** `report.html` contents, or null if the run never wrote one. */
  report(): string | null;
  /** Absolute path to a file in `outDir`. */
  file(name: string): string;
}

export function runCli(args: string[], opts: CliOptions = {}): Promise<CliResult> {
  const cwd = opts.cwd ?? tempDir("renderdiff-cwd-");
  const outDir = opts.outDir ?? path.join(tempDir("renderdiff-out-"), "out");
  const argv = opts.noOut ? [...args] : [...args, "--out", outDir];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd,
      // Type stripping emits an experimental warning on some Node versions; the suite
      // asserts on stderr, so keep it to what the CLI itself writes.
      env: { ...process.env, NODE_OPTIONS: "--no-warnings", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));

    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 300_000);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") {
        reject(
          new Error(`renderdiff timed out.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`),
        );
        return;
      }
      const reportPath = path.join(outDir, "report.html");
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        outDir,
        cwd,
        report: () => (fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : null),
        file: (name) => path.join(outDir, name),
      });
    });
  });
}

/**
 * Both origins plus routes, in the order the CLI wants them. Widths default to two — one
 * desktop, one mobile — because every capture costs a browser page load.
 */
export function renderdiffArgs(opts: {
  left: string;
  right: string;
  routes: string[];
  widths?: number[];
  concurrency?: number;
  threshold?: number;
  config?: string;
}): string[] {
  const args = [...opts.routes, "--left", opts.left, "--right", opts.right];
  for (const w of opts.widths ?? [1440, 375]) args.push("--width", String(w));
  args.push("--concurrency", String(opts.concurrency ?? 4));
  if (opts.threshold !== undefined) args.push("--threshold", String(opts.threshold));
  if (opts.config !== undefined) args.push("--config", opts.config);
  return args;
}

/** Attach to a failing assertion so a red visual test is debuggable, not just red. */
export const context = (r: CliResult) =>
  `\nexit ${r.code}\nreport: ${path.join(r.outDir, "report.html")}\n` +
  `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
