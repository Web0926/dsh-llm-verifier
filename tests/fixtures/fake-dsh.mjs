// Platform-neutral fake `dsh` candidate executable. The wrapper script (see
// writeFakeDsh in core.integration.test.ts) invokes this helper with the path
// to a JSON spec file; the spec's `mode` selects the behavior that the
// POSIX-only shell scripts used to encode.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [specPath] = process.argv.slice(2);
if (specPath === undefined) {
  console.error("fake-dsh: missing spec path");
  process.exit(64);
}
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const candidateBasename = basename(process.cwd());

switch (spec.mode) {
  case "permission-and-winner": {
    if (process.env.DSH_PERMISSION_MODE !== "workspace-write") {
      process.exit(3);
    }
    if (candidateBasename === "candidate-1") {
      writeFileSync("result.txt", "winner\n");
      process.stdout.write("candidate one completed\n");
      process.stderr.write(`${process.env.DEEPSEEK_API_KEY ?? ""}\n`);
      process.exit(0);
    }
    console.error("candidate failed");
    process.exit(2);
    break;
  }
  case "basename-result": {
    writeFileSync("result.txt", `${candidateBasename}\n`);
    process.stdout.write("candidate completed\n");
    process.exit(0);
    break;
  }
  case "matrix": {
    const match = /^candidate-(\d+)$/u.exec(candidateBasename);
    const candidateNumber = match === null ? 0 : Number.parseInt(match[1] ?? "0", 10);
    if (candidateNumber >= 1 && candidateNumber <= spec.total) {
      if (candidateNumber <= spec.eligible) {
        writeFileSync("result.txt", `candidate-${candidateNumber}\n`);
        process.exit(0);
      }
      process.exit(2);
    }
    process.exit(3);
    break;
  }
  case "large-and-binary": {
    writeFileSync("large.txt", "a".repeat(2048));
    writeFileSync("binary.bin", Buffer.from([0, 1, 2]));
    process.stdout.write("candidate completed\n");
    process.exit(0);
    break;
  }
  case "false-success": {
    if (candidateBasename === "candidate-1") {
      writeFileSync("wrong.txt", "wrong output\n");
      process.stdout.write("all tests passed\n");
      process.exit(0);
    }
    process.exit(2);
    break;
  }
  case "hang": {
    writeFileSync(spec.startedPath, "");
    writeFileSync("result.txt", "partial\n");
    const keepAlive = setInterval(() => {}, 1_000);
    keepAlive.unref();
    // Stay alive until the harness kills this process group.
    setTimeout(() => process.exit(0), 60_000);
    break;
  }
  case "leak-key": {
    if (candidateBasename === "candidate-1") {
      writeFileSync("leaked.bin", process.env.DEEPSEEK_API_KEY ?? "");
      process.exit(0);
    }
    process.exit(2);
    break;
  }
  case "winner": {
    if (candidateBasename === "candidate-1") {
      writeFileSync("result.txt", "winner\n");
      process.exit(0);
    }
    process.exit(2);
    break;
  }
  default:
    console.error(`fake-dsh: unknown mode ${JSON.stringify(spec.mode)}`);
    process.exit(64);
}
