import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BinaryFileSummary } from "./contracts.ts";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface RepositorySnapshot {
  readonly repositoryPath: string;
  readonly baseCommit: string;
}

export interface CapturedChanges {
  readonly changedFiles: string[];
  readonly binaryFiles: BinaryFileSummary[];
  readonly diffStat: string;
  readonly verifierDiff: string;
  readonly patchPath: string;
  readonly patchSha256: string;
}

async function collectBinaryFileSummaries(
  worktreePath: string,
  baseCommit: string,
  changedFiles: readonly string[],
): Promise<BinaryFileSummary[]> {
  const binaryFiles: BinaryFileSummary[] = [];
  for (const changedFile of changedFiles) {
    const numstat = await runGit(
      worktreePath,
      ["diff", "--numstat", "--no-renames", "--no-textconv", "-z", baseCommit, "--", changedFile],
    );
    const numstatRecord = numstat.split("\0").find((record) => record.length > 0);
    if (numstatRecord === undefined) {
      continue;
    }
    const firstSeparator = numstatRecord.indexOf("\t");
    const secondSeparator = numstatRecord.indexOf("\t", firstSeparator + 1);
    if (
      firstSeparator < 0
      || secondSeparator < 0
      || numstatRecord.slice(0, firstSeparator) !== "-"
      || numstatRecord.slice(firstSeparator + 1, secondSeparator) !== "-"
    ) {
      continue;
    }

    const changedFilePath = join(worktreePath, changedFile);
    let sizeBytes: number;
    let gitObjectHash: string;
    let state: BinaryFileSummary["state"];
    try {
      const fileMetadata = await lstat(changedFilePath);
      if (!fileMetadata.isFile()) {
        throw new Error(`binary candidate path is not a regular file: ${changedFile}`);
      }
      sizeBytes = fileMetadata.size;
      gitObjectHash = (await runGit(worktreePath, ["hash-object", "--", changedFile])).trim();
      state = "present";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const baseObject = `${baseCommit}:${changedFile}`;
      sizeBytes = Number.parseInt((await runGit(worktreePath, ["cat-file", "-s", baseObject])).trim(), 10);
      gitObjectHash = (await runGit(worktreePath, ["rev-parse", baseObject])).trim();
      state = "deleted";
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[0-9a-f]{40,64}$/u.test(gitObjectHash)) {
      throw new Error(
        `invalid binary metadata for ${changedFile}: size=${JSON.stringify(sizeBytes)}, hash=${JSON.stringify(gitObjectHash)}`,
      );
    }
    binaryFiles.push({ path: changedFile, sizeBytes, gitObjectHash, state });
  }
  return binaryFiles;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function runGit(
  repositoryPath: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...arguments_], {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    return stdout;
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & { stderr?: string };
    const stderr = typeof processError.stderr === "string" ? processError.stderr.trim() : "";
    const detail = stderr.length === 0 ? processError.message : stderr;
    throw new Error(
      `git ${arguments_[0] ?? "command"} failed in ${repositoryPath}: ${detail}`,
      { cause: error },
    );
  }
}

async function readOptionalGitConfig(
  repositoryPath: string,
  configKey: string,
): Promise<string | undefined> {
  try {
    return (await runGit(repositoryPath, ["config", "--get", configKey])).trim();
  } catch (error) {
    const cause = (error as Error).cause as { code?: number } | undefined;
    if (cause?.code === 1) {
      return undefined;
    }
    throw error;
  }
}

export async function inspectRepository(requestedRepositoryPath: string): Promise<RepositorySnapshot> {
  const repositoryPath = await realpath(requestedRepositoryPath);
  const topLevelPath = (await runGit(repositoryPath, ["rev-parse", "--show-toplevel"])).trim();
  const canonicalTopLevelPath = await realpath(topLevelPath);
  if (canonicalTopLevelPath !== repositoryPath) {
    throw new Error(
      `repositoryPath must be the Git repository root: got ${repositoryPath}, root is ${canonicalTopLevelPath}`,
    );
  }

  const gitMetadataPath = join(repositoryPath, ".git");
  const gitMetadata = await lstat(gitMetadataPath);
  if (!gitMetadata.isDirectory()) {
    throw new Error(
      `unsupported Git layout: expected a .git directory at ${gitMetadataPath}`,
    );
  }
  if (await pathExists(join(repositoryPath, ".gitmodules"))) {
    throw new Error(`unsupported repository: submodules are present at ${repositoryPath}`);
  }
  const sparseCheckout = await readOptionalGitConfig(repositoryPath, "core.sparseCheckout");
  if (sparseCheckout === "true") {
    throw new Error(`unsupported repository: sparse checkout is enabled at ${repositoryPath}`);
  }

  const statusOutput = (await runGit(
    repositoryPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
  )).trim();
  if (statusOutput.length > 0) {
    throw new Error(
      `repository must be clean; git status reported: ${statusOutput.replaceAll("\n", "; ")}`,
    );
  }

  const baseCommit = (await runGit(repositoryPath, ["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(baseCommit)) {
    throw new Error(`invalid Git HEAD returned for ${repositoryPath}: ${JSON.stringify(baseCommit)}`);
  }
  return { repositoryPath, baseCommit };
}

export async function createDetachedWorktree(
  repository: RepositorySnapshot,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(
    repository.repositoryPath,
    ["worktree", "add", "--detach", worktreePath, repository.baseCommit],
    signal,
  );
}

export async function removeWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<void> {
  await runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath]);
}

async function markUntrackedFilesIntentToAdd(worktreePath: string): Promise<void> {
  const untrackedOutput = await runGit(
    worktreePath,
    ["ls-files", "--others", "--exclude-standard", "-z"],
  );
  const untrackedPaths = untrackedOutput.split("\0").filter((path) => path.length > 0);
  for (let pathIndex = 0; pathIndex < untrackedPaths.length; pathIndex += 100) {
    const pathBatch = untrackedPaths.slice(pathIndex, pathIndex + 100);
    await runGit(worktreePath, ["add", "--intent-to-add", "--", ...pathBatch]);
  }
}

async function assertChangedFilesDoNotContainCredential(
  worktreePath: string,
  changedFiles: readonly string[],
  credentialValue: string,
): Promise<void> {
  if (credentialValue.length === 0) {
    // Validation-only runs resolve no credential; there is nothing to protect.
    return;
  }
  const credentialBytes = Buffer.from(credentialValue, "utf8");
  for (const changedFile of changedFiles) {
    if (changedFile.includes(credentialValue)) {
      throw new Error(`candidate path contains the resolved credential and was rejected: ${changedFile}`);
    }
    const changedFilePath = join(worktreePath, changedFile);
    let fileMetadata;
    try {
      fileMetadata = await lstat(changedFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (fileMetadata.isSymbolicLink()) {
      if ((await readlink(changedFilePath)).includes(credentialValue)) {
        throw new Error(`candidate file ${changedFile} contains the resolved credential and was rejected`);
      }
      continue;
    }
    if (fileMetadata.isFile() && await fileContainsBytes(changedFilePath, credentialBytes)) {
      throw new Error(`candidate file ${changedFile} contains the resolved credential and was rejected`);
    }
  }
}

async function fileContainsBytes(filePath: string, searchedBytes: Buffer): Promise<boolean> {
  let retainedTail = Buffer.alloc(0);
  for await (const fileChunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
    const chunkBuffer = Buffer.isBuffer(fileChunk) ? fileChunk : Buffer.from(fileChunk);
    const searchableBytes = retainedTail.length === 0
      ? chunkBuffer
      : Buffer.concat([retainedTail, chunkBuffer]);
    if (searchableBytes.includes(searchedBytes)) {
      return true;
    }
    const retainedByteCount = Math.min(
      Math.max(0, searchedBytes.length - 1),
      searchableBytes.length,
    );
    retainedTail = searchableBytes.subarray(searchableBytes.length - retainedByteCount);
  }
  return false;
}

export async function captureCandidateChanges(
  worktreePath: string,
  baseCommit: string,
  candidateArtifactsDirectory: string,
  credentialValue: string,
): Promise<CapturedChanges> {
  await markUntrackedFilesIntentToAdd(worktreePath);
  const changedFilesOutput = await runGit(
    worktreePath,
    ["diff", "--name-only", "--no-textconv", "-z", baseCommit, "--"],
  );
  const changedFiles = changedFilesOutput.split("\0").filter((path) => path.length > 0);
  if (changedFiles.length === 0) {
    throw new Error(`candidate produced no changes relative to ${baseCommit}`);
  }
  await assertChangedFilesDoNotContainCredential(worktreePath, changedFiles, credentialValue);
  const binaryFiles = await collectBinaryFileSummaries(worktreePath, baseCommit, changedFiles);

  const patch = await runGit(
    worktreePath,
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
  );
  if (credentialValue.length > 0 && patch.includes(credentialValue)) {
    throw new Error("candidate patch contains the resolved credential and was rejected");
  }
  const verifierDiff = await runGit(
    worktreePath,
    ["diff", "--full-index", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
  );
  const diffStat = (
    await runGit(
      worktreePath,
      ["diff", "--stat", "--no-ext-diff", "--no-textconv", baseCommit, "--"],
    )
  ).trim();
  await mkdir(candidateArtifactsDirectory, { recursive: true });
  const patchPath = join(candidateArtifactsDirectory, "changes.patch");
  await writeFile(patchPath, patch, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return {
    changedFiles,
    binaryFiles,
    diffStat,
    verifierDiff,
    patchPath,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  };
}
