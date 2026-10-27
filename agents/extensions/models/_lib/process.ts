/**
 * Runs a CLI subprocess with the prompt on stdin, a wall-clock timeout and an
 * idle timeout, and a child environment without swamp credentials.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

/** Result of one subprocess run. */
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Which timeout killed the process, if any. */
  timedOut: "wall" | "idle" | null;
}

/** Non-secret `SWAMP_*` variables a child may keep. */
const SWAMP_ENV_ALLOWLIST = new Set([
  "SWAMP_REPO_DIR",
  "SWAMP_SERVER_URL",
  "SWAMP_CLUB_URL",
]);

/**
 * Copy of `env` without swamp control-plane variables. Strips every
 * `SWAMP_*` key except the allowlist, so a new swamp credential variable is
 * withheld by default.
 */
export function childEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      !key.startsWith("SWAMP_") || SWAMP_ENV_ALLOWLIST.has(key)
    ),
  );
}

const KILL_GRACE_MS = 5_000;
const DRAIN_GRACE_MS = 2_000;

/** Spawns `command`, writes `stdin`, and collects output until exit or timeout. */
export async function runProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    stdin: string;
    env: Record<string, string>;
    wallTimeoutMs: number;
    idleTimeoutMs: number;
    /** Global argument that sets `command`, named when it is not found. */
    pathArg: string;
  },
): Promise<ProcessResult> {
  const started = Date.now();
  let child: Deno.ChildProcess;
  try {
    // Running an agent CLI is this extension's purpose; arguments are an
    // argv array (no shell) and the prompt goes on stdin.
    // swamp-quality-ignore deno-command
    child = new Deno.Command(command, {
      args,
      cwd: opts.cwd,
      env: opts.env,
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `${command} not found; install it or set the ${opts.pathArg} global argument`,
      );
    }
    throw error;
  }

  let lastActivity = Date.now();
  let timedOut: ProcessResult["timedOut"] = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (reason: "wall" | "idle") => {
    if (timedOut) return;
    timedOut = reason;
    // shortcut: signals only the direct child, not tool subprocesses it
    // spawned; use process groups if orphaned tool processes become a problem.
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, KILL_GRACE_MS);
  };
  const wallTimer = setTimeout(() => kill("wall"), opts.wallTimeoutMs);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity >= opts.idleTimeoutMs) kill("idle");
  }, Math.min(opts.idleTimeoutMs, 1_000));

  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastActivity = Date.now();
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // Cancelled after exit; keep what was read.
    }
    return text + decoder.decode();
  };
  const stdout = drain(child.stdout);
  const stderr = drain(child.stderr);

  try {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  } catch {
    // The child exited before reading stdin; its exit code tells why.
  }

  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await child.status;
    // Subprocesses the child left behind can hold the pipes open; stop
    // reading shortly after the child itself has exited.
    drainTimer = setTimeout(() => {
      for (const reader of readers) reader.cancel().catch(() => {});
    }, DRAIN_GRACE_MS);
    const [out, err] = await Promise.all([stdout, stderr]);
    return {
      code: status.code,
      stdout: out,
      stderr: err,
      durationMs: Date.now() - started,
      timedOut,
    };
  } finally {
    clearTimeout(wallTimer);
    clearInterval(idleTimer);
    clearTimeout(killTimer);
    clearTimeout(drainTimer);
  }
}
