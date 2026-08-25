import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureDirectorySnapshot, mergeDirectoryWithBaseline, withDirectoryMergeLock } from "./workspace-restore-merge.js";

describe("workspace restore merge", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("preserves sibling files when sequential stale-baseline restores create the same nested directory tree", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);

    const targetDir = path.join(rootDir, "target");
    const sourceADir = path.join(rootDir, "source-a");
    const sourceBDir = path.join(rootDir, "source-b");
    await mkdir(targetDir, { recursive: true });
    await mkdir(path.join(sourceADir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });
    await mkdir(path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });

    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    await writeFile(
      path.join(sourceADir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"),
      "ssh claude\n",
      "utf8",
    );
    await writeFile(
      path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"),
      "ssh codex\n",
      "utf8",
    );

    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceADir,
      targetDir,
    });
    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceBDir,
      targetDir,
    });

    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"), "utf8"),
    ).resolves.toBe("ssh claude\n");
    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"), "utf8"),
    ).resolves.toBe("ssh codex\n");
  });

  it("ignores non-file entries when capturing snapshots", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);
    const socketPath = path.join(rootDir, "runtime.sock");
    const server = net.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });

      expect(snapshot.entries.has("runtime.sock")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("instance-scoped directory merge lock", () => {
    // Points PAPERCLIP_HOME (and, where noted, PAPERCLIP_INSTANCE_ID) at a
    // temporary directory so the lock root never touches the real Paperclip
    // instance, then restores the previous values. Mirrors the save-and-restore
    // pattern in acpx-engine/execute.test.ts.
    let previousHome: string | undefined;
    let previousInstanceId: string | undefined;

    function useTempPaperclipHome(homeDir: string, instanceId: string): void {
      previousHome = process.env.PAPERCLIP_HOME;
      previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_HOME = homeDir;
      process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    }

    afterEach(() => {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      previousHome = undefined;
      previousInstanceId = undefined;
    });

    it.skipIf(process.platform === "win32")(
      "restores successfully when the parent directory of the target is not writable",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        // The old lock sat beside the target, so it needed mkdir rights in the
        // target's parent. The new lock root lives under PAPERCLIP_HOME instead,
        // so a read-only parent must no longer block a restore.
        const readOnlyParent = path.join(rootDir, "read-only-parent");
        const targetDir = path.join(readOnlyParent, "target");
        const sourceDir = path.join(rootDir, "source");
        await mkdir(targetDir, { recursive: true });
        await mkdir(sourceDir, { recursive: true });

        const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });
        await writeFile(path.join(sourceDir, "new-file.md"), "new content\n", "utf8");

        await chmod(readOnlyParent, 0o500);
        try {
          await mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir });
        } finally {
          // Restore write access so the outer afterEach can remove rootDir.
          await chmod(readOnlyParent, 0o700).catch(() => undefined);
        }

        await expect(readFile(path.join(targetDir, "new-file.md"), "utf8")).resolves.toBe("new content\n");
      },
    );

    it.skipIf(process.platform === "win32")(
      "acquires the same lock for two alias paths that resolve to one canonical target",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        const paperclipHome = path.join(rootDir, "paperclip-home");
        useTempPaperclipHome(paperclipHome, "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");

        let lockNameViaTarget = "";
        await withDirectoryMergeLock(targetDir, async () => {
          const entries = await readdir(lockRootDir);
          lockNameViaTarget = entries[0] ?? "";
        });

        let lockNameViaAlias = "";
        await withDirectoryMergeLock(aliasDir, async () => {
          const entries = await readdir(lockRootDir);
          lockNameViaAlias = entries[0] ?? "";
        });

        expect(lockNameViaTarget).not.toBe("");
        expect(lockNameViaAlias).toBe(lockNameViaTarget);
      },
    );

    it("rejects a lock root that already exists as a symlink", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const locksDir = path.join(paperclipHome, "instances", "test-instance", "locks");
      const decoyDir = path.join(rootDir, "decoy");
      await mkdir(locksDir, { recursive: true });
      await mkdir(decoyDir, { recursive: true });
      await symlink(decoyDir, path.join(locksDir, "directory-merge"));

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
        /not a plain directory/,
      );
    });

    it("rejects a lock root that already exists as a non-directory", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const locksDir = path.join(paperclipHome, "instances", "test-instance", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(path.join(locksDir, "directory-merge"), "not a directory\n", "utf8");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
        /not a plain directory/,
      );
    });

    it("creates the lock root at mode 0o700 and removes the lock directory after release", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");
      let entriesDuringLock: string[] = [];
      await withDirectoryMergeLock(targetDir, async () => {
        entriesDuringLock = await readdir(lockRootDir);
      });

      expect((await stat(lockRootDir)).mode & 0o777).toBe(0o700);
      expect(entriesDuringLock).toHaveLength(1);
      await expect(readdir(lockRootDir)).resolves.toHaveLength(0);
    });

    it.skipIf(process.platform === "win32")(
      "serializes two concurrent writers that address one target through different aliases",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        let active = false;
        let overlapCount = 0;
        let completedCount = 0;
        const runWriter = (dir: string) =>
          withDirectoryMergeLock(dir, async () => {
            if (active) overlapCount += 1;
            active = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            active = false;
            completedCount += 1;
          });

        await Promise.all([runWriter(targetDir), runWriter(aliasDir)]);

        expect(overlapCount).toBe(0);
        expect(completedCount).toBe(2);
      },
    );
  });
});
