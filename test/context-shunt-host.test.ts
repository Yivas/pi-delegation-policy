import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

type HostReport = {
  assertions: string[];
  cases: Array<{ case: string; providerRequests: number; status: string }>;
  piVersion: string;
  tarball: { file: string; sha256: string };
};

type ChildRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (pid: number) => void;
  outputLimitBytes?: number;
  timeoutMs?: number;
};

type ChildRunResult = {
  stdout: string;
  stderr: string;
};

const DEFAULT_CHILD_OUTPUT_LIMIT_BYTES = 1_000_000;
const DEFAULT_CHILD_TIMEOUT_MS = 60_000;
const CHILD_TERMINATION_GRACE_MS = 100;

function runChild(
  command: string,
  args: string[],
  options: ChildRunOptions = {},
): Promise<ChildRunResult> {
  const {
    cwd,
    env,
    onSpawn,
    outputLimitBytes = DEFAULT_CHILD_OUTPUT_LIMIT_BYTES,
    timeoutMs = DEFAULT_CHILD_TIMEOUT_MS,
  } = options;
  return new Promise((resolve, reject) => {
    const deadlineAt = Date.now() + timeoutMs;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`${command} failed to spawn: ${String(error)}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let closeObserved = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let failure: Error | undefined;
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimers = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
    };
    const terminate = () => {
      if (closeObserved || child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill();
      } catch {
        // Continue to the escalation timer when the initial signal fails.
      }
      terminationTimer = setTimeout(() => {
        if (!closeObserved && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child may have failed to spawn or exited during escalation.
          }
        }
      }, CHILD_TERMINATION_GRACE_MS);
    };
    const finish = () => {
      if (settled || !closeObserved) return;
      settled = true;
      cleanupTimers();
      if (failure) {
        reject(failure);
      } else if (closeCode === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} exited with code ${closeCode}${closeSignal ? ` (${closeSignal})` : ""}: ${stderr}`,
          ),
        );
      }
    };
    const fail = (error: unknown) => {
      if (!failure) failure = error instanceof Error ? error : new Error(String(error));
      terminate();
      finish();
    };
    const append = (current: string, chunk: string, label: string) => {
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (outputBytes + bytes > outputLimitBytes) {
        fail(new Error(`${label} exceeded ${outputLimitBytes} bytes`));
        return current;
      }
      outputBytes += bytes;
      return current + chunk;
    };

    if (!child.stdout || !child.stderr) {
      child.kill();
      reject(new Error(`${command} did not provide piped output`));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!settled && !failure) stdout = append(stdout, chunk, `${command} stdout`);
    });
    child.stderr.on("data", (chunk: string) => {
      if (!settled && !failure) stderr = append(stderr, chunk, `${command} stderr`);
    });
    child.once("error", (error) => fail(new Error(`${command} failed to spawn: ${error.message}`)));
    child.once("close", (code, signal) => {
      closeObserved = true;
      closeCode = code;
      closeSignal = signal;
      if (!failure && code !== 0) {
        failure = new Error(
          `${command} exited with code ${code}${signal ? ` (${signal})` : ""}: ${stderr}`,
        );
      }
      finish();
    });
    const deadlineTimer = setTimeout(
      () => {
        fail(new Error(`${command} timed out after ${timeoutMs}ms`));
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    if (child.pid === undefined) {
      fail(new Error(`${command} failed to spawn: process did not report a process ID`));
    } else {
      try {
        onSpawn?.(child.pid);
      } catch (error) {
        fail(new Error(`${command} onSpawn callback failed: ${String(error)}`));
      }
    }
  });
}

async function runHost(
  piRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  nodeCommand = process.execPath,
): Promise<HostReport> {
  const result = await runChild(
    nodeCommand,
    ["scripts/test-context-shunt-host.mjs", "--pi-root", piRoot, "--pack"],
    { cwd: process.cwd(), env },
  );
  try {
    return JSON.parse(result.stdout.trim()) as HostReport;
  } catch (error) {
    throw new Error(
      `host harness emitted invalid JSON: ${error}\n${result.stdout}\n${result.stderr}`,
      {
        cause: error,
      },
    );
  }
}

test("bounds the outer host child output and lifetime", async () => {
  await assert.rejects(
    runChild(
      process.execPath,
      ["-e", "process.stdout.write('o'.repeat(40)); process.stderr.write('e'.repeat(40));"],
      { outputLimitBytes: 64, timeoutMs: 1_000 },
    ),
    /exceeded 64 bytes/,
  );

  let childPid: number | undefined;
  await assert.rejects(
    runChild(process.execPath, ["-e", "setInterval(() => {}, 1_000);"], {
      onSpawn: (pid) => {
        childPid = pid;
      },
      timeoutMs: 50,
      outputLimitBytes: 64,
    }),
    /timed out after 50ms/,
  );
  assert.ok(childPid !== undefined, "successful spawn reports the child PID");
  let childAlive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    childAlive = false;
  }
  assert.equal(childAlive, false, "timed-out child is terminated before rejection");

  const valid = await runChild(process.execPath, ["-e", "process.stdout.write('valid output')"]);
  assert.equal(valid.stdout, "valid output");
  await assert.rejects(
    runChild(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(7)"]),
    /exited with code 7/,
  );
  const temporary = await mkdtemp(join(tmpdir(), "context-shunt-host-test-missing-child-"));
  try {
    await assert.rejects(runChild(join(temporary, "missing-child"), []), /failed to spawn/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function assertHost(
  piRoot: string,
  expectedVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  nodeCommand = process.execPath,
): Promise<void> {
  const result = await runHost(piRoot, env, nodeCommand);
  assert.equal(result.piVersion, expectedVersion);
  assert.match(result.tarball.file, /^pi-delegation-policy-.*\.tgz$/);
  assert.match(result.tarball.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    result.cases.map((entry) => entry.case),
    ["off", "observe", "enforce", "compact", "deny", "mutation", "override", "abort", "concurrent"],
  );
  assert.ok(
    result.cases.every((entry) => entry.status === "passed" && entry.providerRequests <= 8),
  );
  assert.ok(result.assertions.includes("harness: process timeout terminates its owned child"));
  assert.ok(
    result.assertions.includes("harness: aggregate process output cap rejects a synthetic flood"),
  );
  assert.ok(
    result.assertions.includes(
      "harness: RPC line, event, and output cap terminates a synthetic flood",
    ),
  );
  assert.ok(result.assertions.includes("enforce: declared excess read is blocked"));
  assert.ok(result.assertions.includes("compact: recovery tool executes through the host"));
  assert.ok(
    result.assertions.includes(
      "deny: later synthetic extension records its denial before the builtin read",
    ),
  );
  assert.ok(
    result.assertions.includes(
      "mutation: mismatched tool-result binding cannot apply exception maxima",
    ),
  );
  assert.ok(
    result.assertions.includes("override: nonbuiltin replacement read is not post-compacted"),
  );
  assert.ok(
    result.assertions.includes(
      "abort: consumed authorization does not reexecute the cancelled read",
    ),
  );
  assert.ok(
    result.assertions.includes(
      "concurrent: identical calls receive exactly one explicit exception admission",
    ),
  );
  assert.ok(
    (await readFile(join(piRoot, "package.json"), "utf8")).includes(
      `"version": "${expectedVersion}"`,
    ),
  );
}

test("rejects malformed npm_execpath before packing", async () => {
  for (const [npmExecPath, expectedError] of [
    ["", /npm_execpath must not be empty/],
    ["npm-cli.js", /npm_execpath must be an absolute path/],
  ] as const) {
    await assert.rejects(
      runHost(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent"), {
        ...process.env,
        npm_execpath: npmExecPath,
      }),
      expectedError,
    );
  }
});

const npmExecPath = process.env.npm_execpath?.trim();

test("loads the packed extension through the selected npm CLI", async () => {
  const baselinePiRoot = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent");
  if (process.env.npm_execpath === undefined) {
    await assertHost(baselinePiRoot, "0.84.3");
    return;
  }

  assert.ok(npmExecPath, "npm_execpath must be non-empty for the host pack regression");
  const temporary = await mkdtemp(join(tmpdir(), "context-shunt-npm-cli-test-"));
  try {
    const isolatedNode = join(temporary, process.platform === "win32" ? "node.exe" : "node");
    await copyFile(process.execPath, isolatedNode);
    if (process.platform !== "win32") {
      await chmod(isolatedNode, 0o755);
      assert.equal(
        (await stat(isolatedNode)).mode & 0o111,
        0o111,
        "copied Node executable has POSIX execute permissions",
      );
    }
    assert.notEqual(
      dirname(npmExecPath),
      dirname(isolatedNode),
      "npm_execpath is outside the isolated Node install",
    );
    await assertHost(
      baselinePiRoot,
      "0.84.3",
      { ...process.env, npm_execpath: npmExecPath },
      isolatedNode,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const currentPiRoot = process.env.PI_CONTEXT_SHUNT_CURRENT_PI_ROOT;
const currentPiVersion = process.env.PI_CONTEXT_SHUNT_CURRENT_PI_VERSION;

test(
  "loads the packed extension through the explicitly configured current Pi CLI RPC host",
  { skip: !currentPiRoot || !currentPiVersion },
  async () => {
    assert.ok(currentPiRoot, "PI_CONTEXT_SHUNT_CURRENT_PI_ROOT is required");
    assert.ok(currentPiVersion, "PI_CONTEXT_SHUNT_CURRENT_PI_VERSION is required");
    await assertHost(currentPiRoot, currentPiVersion);
  },
);
