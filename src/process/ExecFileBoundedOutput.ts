import { spawn } from "node:child_process";

export interface BoundedCommandOutput {
  readonly exitCode: string | number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

/** Drain both streams while retaining at most limit bytes from each. */
export const execFileBoundedOutput = (
  executable: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<NodeJS.ProcessEnv>;
    readonly limit: number;
  },
): Promise<BoundedCommandOutput> =>
  new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    const capture =
      (chunks: Buffer[], stream: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        const retained = stream === "stdout" ? stdoutBytes : stderrBytes;
        const available = Math.max(0, options.limit - retained);
        const count = Math.min(available, chunk.length);
        if (count > 0) chunks.push(chunk.subarray(0, count));
        if (stream === "stdout") stdoutBytes += count;
        else stderrBytes += count;
        if (count < chunk.length) outputTruncated = true;
      };
    child.stdout.on("data", capture(stdout, "stdout"));
    child.stderr.on("data", capture(stderr, "stderr"));
    let spawnError: NodeJS.ErrnoException | undefined;
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      resolve({
        exitCode: spawnError?.code ?? code ?? signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputTruncated,
      });
    });
  });
