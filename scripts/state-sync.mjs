#!/usr/bin/env node
// Persist the runner's durable state across ephemeral hosts (e.g. GitHub Actions runners) by
// syncing .circuit-trader/ to a private Vercel Blob prefix. `pull` before the cycle, `push` after.
//
//   node scripts/state-sync.mjs pull   # Blob -> local (no-op on a fresh store)
//   node scripts/state-sync.mjs push   # local -> Blob (clears the journal blob when none pending)
//
// Requires BLOB_READ_WRITE_TOKEN (same Blob store the dashboard uses). The runner lock is NOT
// synced — each host owns its own lock, and a stale PID from another host is reaped locally.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BlobNotFoundError, del, get, put } from "@vercel/blob";

const mode = process.argv[2];
if (mode !== "pull" && mode !== "push") {
  console.error("usage: state-sync.mjs <pull|push>");
  process.exit(2);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required");

const dir = resolve(process.env.RUNNER_DIR ?? ".circuit-trader");
const prefix = (process.env.STATE_BLOB_PREFIX ?? "circuit-trader/live").replace(/\/+$/, "");

const FILES = [
  { local: `${dir}/state.json`, blob: `${prefix}/state.json`, contentType: "application/json" },
  { local: `${dir}/execution-journal.json`, blob: `${prefix}/execution-journal.json`, contentType: "application/json", clearWhenAbsent: true },
  { local: `${dir}/timeline.jsonl`, blob: `${prefix}/timeline.jsonl`, contentType: "application/x-ndjson" },
];

if (mode === "pull") {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const f of FILES) {
    try {
      const r = await get(f.blob, { access: "private", useCache: false });
      if (!r?.stream) {
        console.error(`pull: ${f.blob} empty — skipping`);
        continue;
      }
      const text = await new Response(r.stream).text();
      await writeFile(f.local, text, { mode: 0o600 });
      console.error(`pull: ${f.blob} -> ${f.local} (${text.length}b)`);
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        console.error(`pull: ${f.blob} not found — fresh start`);
        continue;
      }
      throw error;
    }
  }
} else {
  for (const f of FILES) {
    let text;
    try {
      text = await readFile(f.local, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        if (f.clearWhenAbsent) {
          // Journal gone = no pending intent. Clear the blob so a later host can't "recover" a stale one.
          await del(f.blob).catch(() => {});
          console.error(`push: ${f.local} absent — cleared ${f.blob}`);
        } else {
          console.error(`push: ${f.local} absent — skipping`);
        }
        continue;
      }
      throw error;
    }
    await put(f.blob, text, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: f.contentType,
      cacheControlMaxAge: 60,
    });
    console.error(`push: ${f.local} -> ${f.blob} (${text.length}b)`);
  }
}
