import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const WRAPPER_TIMEOUT_MS = 90_000;
const WRAPPER_OUTPUT_LIMIT_BYTES = 1_000_000;
const ALLOWED_FAILURE_PHASES = new Set([
  "host-load",
  "pack",
  "provider-start",
  "provider-request-cap",
  "provider-auth",
  "provider-payload",
  "provider-handler",
  "success-child-schema",
  "recover-receipt-mismatch",
  "success-case",
  "cancel-case",
  "unavailable-case",
  "rpc-timeout",
  "rpc-protocol",
  "rpc-output-cap",
  "rpc-host-exit",
  "cleanup",
]);

type ReaderHostFacts = Partial<{
  cancelObserved: boolean;
  childSocketClosed: boolean;
  childAnswerNotRelayed: boolean;
  readerUnavailable: boolean;
  noChildRequest: boolean;
  noStarted: boolean;
  exactOneCancel: boolean;
  toolOnly: boolean;
  modelMatches: boolean;
  thinkingMatches: boolean;
  terminalDigestFormatValid: boolean;
  responseValidated: boolean;
  recoveryReachedMainProvider: boolean;
  splitPromptRecovery: boolean;
  firstSettleObserved: boolean;
  secondSettleObserved: boolean;
  recoveryExact: boolean;
  updateCount: number;
  updatePayloadsMetadataOnly: boolean;
}>;

type ReaderHostFailure = { phase: string };

type ReaderHostReport = {
  status: "passed" | "failed";
  offline: boolean;
  loopbackOnly: boolean;
  tarball: { sha256: string; excludesPiSubagents: boolean };
  hosts: Array<{
    hostVersion: string;
    case: "success" | "cancel" | "unavailable";
    status: "passed";
    mainRequests: number;
    childRequests: number;
    auditEntries: number;
    recovery?: { bytes: number; hash: string; matchesExpected: boolean };
    facts: ReaderHostFacts;
  }>;
  failures: ReaderHostFailure[];
};

const currentRoot = process.env.PI_CONTEXT_SHUNT_CURRENT_PI_ROOT;
const currentVersion = process.env.PI_CONTEXT_SHUNT_CURRENT_PI_VERSION;
const subagentsRoot = process.env.PI_CONTEXT_SHUNT_SUBAGENTS_ROOT;
const enabled = Boolean(currentRoot && currentVersion && subagentsRoot);

function terminateTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through when the child is not a process-group leader.
    }
  }
  child.kill();
}

function runReaderHost(reportPath: string): Promise<number> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      ["scripts/test-context-shunt-reader-host.mjs", "--report", reportPath],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, stop = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stop) {
        child.stdout.destroy();
        child.stderr.destroy();
        terminateTree(child);
      }
      if (error) rejectRun(error);
      else resolveRun(child.exitCode ?? -1);
    };
    const receive = (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > WRAPPER_OUTPUT_LIMIT_BYTES)
        finish(new Error("reader host output exceeded wrapper limit"), true);
    };
    const timer = setTimeout(
      () => finish(new Error("reader host exceeded wrapper deadline"), true),
      WRAPPER_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", (error) => finish(error, true));
    child.once("close", (_code) => {
      finish();
    });
  });
}

test(
  "runs packed reader host coverage only when every external root is explicit",
  { skip: !enabled },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "context-shunt-reader-host-test-"));
    const reportPath = join(temporary, "report.json");
    try {
      const exitCode = await runReaderHost(reportPath);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as ReaderHostReport;
      if (report.status === "failed") {
        assert.notEqual(exitCode, 0, "failed host coverage exits nonzero");
        assert.ok(report.failures.length > 0, "failed host coverage reports a phase");
        for (const failure of report.failures) {
          assert.deepEqual(Object.keys(failure), ["phase"]);
          assert.equal(ALLOWED_FAILURE_PHASES.has(failure.phase), true);
        }
        assert.fail("reader host coverage failed with an allowlisted phase");
      }
      assert.equal(exitCode, 0);
      assert.equal(report.status, "passed");
      assert.equal(report.offline, true);
      assert.equal(report.loopbackOnly, true);
      assert.match(report.tarball.sha256, /^[a-f0-9]{64}$/);
      assert.equal(report.tarball.excludesPiSubagents, true);
      const expectedCells = [
        [currentVersion!, "success"],
        [currentVersion!, "cancel"],
        [currentVersion!, "unavailable"],
      ];
      assert.deepEqual(
        report.hosts.map((entry) => [entry.hostVersion, entry.case]),
        expectedCells,
      );
      assert.equal(
        new Set(report.hosts.map((entry) => `${entry.hostVersion}/${entry.case}`)).size,
        3,
        "report has exactly three unique host/case cells",
      );
      assert.doesNotMatch(
        JSON.stringify(report),
        /B17-READER-(?:SOURCE|ANSWER)|synthetic-local-only/i,
      );
      assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:[\\/]/);
      for (const entry of report.hosts) {
        assert.equal(entry.status, "passed");
        assert.ok(entry.auditEntries >= 0);
        if (entry.case === "success") {
          assert.equal(entry.mainRequests, 5);
          assert.equal(entry.childRequests, 1);
          assert.deepEqual(Object.keys(entry.recovery ?? {}).sort(), [
            "bytes",
            "hash",
            "matchesExpected",
          ]);
          assert.match(entry.recovery?.hash ?? "", /^[a-f0-9]{64}$/);
          assert.ok((entry.recovery?.bytes ?? 0) > 0);
          assert.equal(entry.recovery?.matchesExpected, true);
          assert.deepEqual(entry.facts, {
            toolOnly: true,
            modelMatches: true,
            thinkingMatches: true,
            terminalDigestFormatValid: true,
            responseValidated: true,
            recoveryReachedMainProvider: true,
            splitPromptRecovery: true,
            firstSettleObserved: true,
            secondSettleObserved: true,
            recoveryExact: true,
            updateCount: entry.facts.updateCount,
            updatePayloadsMetadataOnly: true,
          });
          assert.ok((entry.facts.updateCount ?? -1) >= 0);
          assert.equal(entry.facts.updatePayloadsMetadataOnly, true);
        } else if (entry.case === "cancel") {
          assert.equal(entry.childRequests, 1);
          assert.deepEqual(entry.facts, {
            cancelObserved: true,
            childSocketClosed: true,
            childAnswerNotRelayed: true,
          });
        } else {
          assert.equal(entry.childRequests, 0);
          assert.deepEqual(entry.facts, {
            readerUnavailable: true,
            noChildRequest: true,
            noStarted: true,
            exactOneCancel: true,
          });
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
