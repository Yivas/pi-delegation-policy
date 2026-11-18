import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const WRAPPER_TIMEOUT_MS = 300_000;
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
  "refused-case",
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
    case: "success" | "cancel" | "unavailable" | "refused";
    status: "passed";
    mainRequests: number;
    childRequests: number;
    auditEntries: number;
    recovery?: { bytes: number; hash: string; matchesExpected: boolean };
    permissionPolicy?: "allow" | "ask" | "deny";
    permissionRuntime?: {
      debugLogLines: number;
      decisions: Array<{ tool: string; action: string }>;
      childToolNames: string[][];
    };
    // Booleans, counts and hashes only: the child prompt itself never enters the report.
    systemPrompt?: {
      childRequests: number;
      equalsBaselineWithSurfaceBlock: boolean;
      baselineSha256: string;
      sha256: string;
      utf8Bytes: number;
      canaryAbsent: boolean;
      skillsAbsent: boolean;
      projectContextAbsent: boolean;
      availableToolsAbsent: boolean;
    };
    facts: ReaderHostFacts;
  }>;
  failures: ReaderHostFailure[];
};

const currentRoot = process.env.PI_CONTEXT_SHUNT_CURRENT_PI_ROOT;
const currentVersion = process.env.PI_CONTEXT_SHUNT_CURRENT_PI_VERSION;
const subagentsRoot = process.env.PI_CONTEXT_SHUNT_SUBAGENTS_ROOT;
const enabled = Boolean(currentRoot && currentVersion && subagentsRoot);
const permissionSystemRoot = process.env.PI_CONTEXT_SHUNT_PERMISSION_SYSTEM_ROOT;

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
      // Permission cells: `allow` is the positive authorized host; `ask` and `deny` are expected
      // fail-closed refusals. Each must end without an accepted answer.
      const expectedCells = [
        [currentVersion!, "success", "prompt-only"],
        [currentVersion!, "cancel", "prompt-only"],
        [currentVersion!, "unavailable", "prompt-only"],
        ...(permissionSystemRoot
          ? [
              [currentVersion!, "success", "allow"],
              [currentVersion!, "refused", "ask"],
              [currentVersion!, "refused", "deny"],
            ]
          : []),
      ];
      assert.deepEqual(
        report.hosts.map((entry) => [
          entry.hostVersion,
          entry.case,
          entry.permissionPolicy ?? "prompt-only",
        ]),
        expectedCells,
      );
      assert.equal(
        new Set(
          report.hosts.map(
            (entry) =>
              `${entry.hostVersion}/${entry.case}/${entry.permissionPolicy ?? "prompt-only"}`,
          ),
        ).size,
        expectedCells.length,
        "report has one unique cell per expected host, case and runtime",
      );
      assert.doesNotMatch(
        JSON.stringify(report),
        /B17-READER-(?:SOURCE|ANSWER)|synthetic-local-only/i,
      );
      assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:[\\/]/);
      for (const entry of report.hosts) {
        assert.equal(entry.status, "passed");
        if (entry.permissionPolicy === "allow") {
          // The authorized host allows only the reader's structured output; ordinary tools stay out.
          assert.deepEqual(
            entry.permissionRuntime?.decisions.filter(
              (decision) => decision.tool === "structured_output",
            ),
            [{ tool: "structured_output", action: "allow" }],
          );
          assert.deepEqual(entry.permissionRuntime?.childToolNames, [["structured_output"]]);
        }
        if (entry.permissionPolicy === "ask") {
          // Ask keeps structured_output visible to both child requests; the host records a block only.
          assert.deepEqual(entry.permissionRuntime?.childToolNames, [
            ["structured_output"],
            ["structured_output"],
          ]);
          assert.ok(
            entry.permissionRuntime?.decisions.some(
              (decision) => decision.tool === "structured_output" && decision.action === "block",
            ),
          );
          assert.equal(
            entry.permissionRuntime?.decisions.some((decision) => decision.action === "allow"),
            false,
          );
        }
        if (entry.permissionPolicy === "deny") {
          // Deny removes every tool from the child surface and records no allow decision.
          assert.deepEqual(entry.permissionRuntime?.childToolNames, [[]]);
          assert.equal(
            entry.permissionRuntime?.decisions.some((decision) => decision.action === "allow"),
            false,
          );
        }
        if (entry.permissionPolicy !== undefined) {
          assert.deepEqual(entry.systemPrompt && Object.keys(entry.systemPrompt).sort(), [
            "availableToolsAbsent",
            "baselineSha256",
            "canaryAbsent",
            "childRequests",
            "equalsBaselineWithSurfaceBlock",
            "projectContextAbsent",
            "sha256",
            "skillsAbsent",
            "utf8Bytes",
          ]);
          assert.equal(entry.systemPrompt?.childRequests, entry.childRequests);
          assert.equal(entry.systemPrompt?.equalsBaselineWithSurfaceBlock, true);
          assert.equal(entry.systemPrompt?.canaryAbsent, true);
          assert.equal(entry.systemPrompt?.skillsAbsent, true);
          assert.equal(entry.systemPrompt?.projectContextAbsent, true);
          assert.equal(entry.systemPrompt?.availableToolsAbsent, true);
          assert.match(entry.systemPrompt?.sha256 ?? "", /^[a-f0-9]{64}$/);
          assert.match(entry.systemPrompt?.baselineSha256 ?? "", /^[a-f0-9]{64}$/);
        }
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
        } else if (entry.case === "refused") {
          assert.ok(entry.childRequests >= 1 && entry.childRequests <= 2);
          assert.deepEqual(entry.facts, {
            refused: true,
            singleRequest: true,
            noAcceptedAnswer: true,
            noConsumerFallback: true,
            boundedChild: true,
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
      // Every permission cell sends the same child prompt, so the host adds the same block in each.
      const permissionPrompts = report.hosts
        .filter((entry) => entry.permissionPolicy !== undefined)
        .map((entry) => entry.systemPrompt);
      assert.equal(permissionPrompts.length, permissionSystemRoot ? 3 : 0);
      assert.equal(new Set(permissionPrompts.map((prompt) => prompt?.sha256)).size, 1);
      assert.equal(new Set(permissionPrompts.map((prompt) => prompt?.baselineSha256)).size, 1);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
