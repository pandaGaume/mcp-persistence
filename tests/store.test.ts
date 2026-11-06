import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SqlitePersistenceStore } from "../src/index.js";
import { describePersistenceStoreConformance } from "../src/conformance/persistence.conformance.js";
const context = { subject: "test" };
const dirs: string[] = [];
function directory(): string { const dir = mkdtempSync(join(tmpdir(), "mcp-persistence-")); dirs.push(dir); return dir; }
const options = (dir: string) => ({ directory: dir, allowFileSyncOnly: process.platform === "win32", retentionMs: 0 });
async function* bytes(content: Buffer) { yield content; }
const content = Buffer.from("persistent artifact\n");
const request = () => ({ namespace: "explorer", mimeType: "application/octet-stream", size: content.length, hash: { algorithm: "sha256" as const, value: createHash("sha256").update(content).digest("hex") }, provenance: { source: "capture" }, idempotencyKey: randomUUID() });

describe("SQLite persistence", () => {
    let store: SqlitePersistenceStore;
    beforeAll(() => { store = new SqlitePersistenceStore(options(directory())); });
    afterAll(async () => { await store.closeAsync(); });
    describePersistenceStoreConformance("direct contract", () => store);
    it("reopens acknowledged data and idempotency results", async () => {
        const dir = directory(); let disk = new SqlitePersistenceStore(options(dir));
        const input = { namespace: "explorer", id: "restart", kind: "checkpoint", schemaVersion: "1", expectedRevision: 0, payload: { sessionId: "session-1", astronomicalDate: "2042-01-01", camera: { x: 1 } }, references: [], idempotencyKey: "restart-key" };
        const first = await disk.putAsync(input, context); await disk.closeAsync();
        disk = new SqlitePersistenceStore(options(dir));
        expect(await disk.getAsync({ namespace: "explorer", id: "restart" }, context)).toEqual(first);
        expect(await disk.putAsync(input, context)).toEqual(first); await disk.closeAsync();
    });
    it("recovers a completed upload renamed before a rolled-back metadata commit", async () => {
        const dir = directory(); let disk = new SqlitePersistenceStore(options(dir));
        const upload = await disk.beginArtifactAsync(request(), context);
        await disk.writeArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, bytes: bytes(content) }, context);
        await disk.closeAsync();
        renameSync(join(dir, "staging", upload.uploadId), join(dir, "artifacts", upload.artifactId));
        disk = new SqlitePersistenceStore(options(dir));
        const commit = { namespace: "explorer", uploadId: upload.uploadId, idempotencyKey: randomUUID() };
        const metadata = await disk.commitArtifactAsync(commit, context);
        expect(await disk.commitArtifactAsync(commit, context)).toEqual(metadata);
        const chunks: Buffer[] = []; for await (const chunk of await disk.readArtifactAsync({ namespace: "explorer", id: metadata.id }, context)) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(content); await disk.closeAsync();
    });
    it("keeps interrupted and corrupt transfers unavailable", async () => {
        const upload = await store.beginArtifactAsync(request(), context);
        async function* interrupted() { yield content.subarray(0, 2); throw new Error("connection lost"); }
        await expect(store.writeArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, bytes: interrupted() }, context)).rejects.toThrow("connection lost");
        await expect(store.commitArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "transfer_incomplete" });
        await expect(store.getArtifactAsync({ namespace: "explorer", id: upload.artifactId }, context)).rejects.toMatchObject({ code: "not_found" });
        await expect(store.writeArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, bytes: bytes(Buffer.alloc(content.length)) }, context)).rejects.toMatchObject({ code: "integrity_error" });
        await store.abortArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, idempotencyKey: randomUUID() }, context);
    });
    it("refuses purge of referenced evidence and detects file tampering", async () => {
        const upload = await store.beginArtifactAsync(request(), context);
        await store.writeArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, bytes: bytes(content) }, context);
        const metadata = await store.commitArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, idempotencyKey: randomUUID() }, context);
        await store.putAsync({ namespace: "explorer", id: "mission-evidence", kind: "mission", schemaVersion: "1", expectedRevision: 0, payload: {}, references: [{ type: "artifact", namespace: "explorer", id: metadata.id }], idempotencyKey: randomUUID() }, context);
        await expect(store.purgeAsync({ namespace: "explorer", target: { type: "artifact", id: metadata.id }, idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "retention_blocked" });
        writeFileSync(join(store.directory, "artifacts", metadata.id), Buffer.alloc(content.length));
        await expect(store.readArtifactAsync({ namespace: "explorer", id: metadata.id }, context)).rejects.toMatchObject({ code: "integrity_error" });
        writeFileSync(join(store.directory, "artifacts", metadata.id), content);
    });
    it("rolls back a quota failure without consuming its idempotency key", async () => {
        const disk = new SqlitePersistenceStore({ ...options(directory()), limits: { maxNamespaceBytes: 1500 } });
        const input = { namespace: "explorer", id: "quota", kind: "checkpoint", schemaVersion: "1", expectedRevision: 0, payload: "x".repeat(1400), references: [], idempotencyKey: "quota" };
        await expect(disk.putAsync(input, context)).rejects.toMatchObject({ code: "quota_exceeded" });
        expect((await disk.putAsync({ ...input, payload: {} }, context)).revision).toBe(1);
        await disk.closeAsync();
    });
    it("keeps physical paths independent from client ids and refuses a second writer", async () => {
        await expect(store.getAsync({ namespace: "explorer", id: "../escape" }, context)).rejects.toMatchObject({ code: "invalid_request" });
        expect(() => new SqlitePersistenceStore(options(store.directory))).toThrow("writer");
        expect(readdirSync(join(store.directory, "artifacts")).every(name => /^[a-f0-9-]{36}$/.test(name))).toBe(true);
        expect(readFileSync(join(store.directory, "writer.lock"), "utf8")).toBe(String(process.pid));
    });
    it("pins mission evidence to an exact view revision", async () => {
        const view = { namespace: "explorer", id: "pinned-view", kind: "view", schemaVersion: "1", expectedRevision: 0, payload: { camera: 1 }, references: [], idempotencyKey: randomUUID() };
        await store.putAsync(view, context);
        await store.putAsync({ ...view, id: "mission-with-view", kind: "mission", payload: { camera: 0 }, references: [{ type: "document", namespace: "explorer", id: view.id, revision: 1 }], idempotencyKey: randomUUID() }, context);
        await store.putAsync({ ...view, expectedRevision: 1, payload: { camera: 2 }, idempotencyKey: randomUUID() }, context);
        expect((await store.getAsync({ namespace: "explorer", id: view.id, revision: 1 }, context)).payload).toEqual({ camera: 1 });
        await expect(store.purgeAsync({ namespace: "explorer", target: { type: "document", id: view.id, revision: 1 }, idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "retention_blocked" });
    });
    it("replays abort and cleans bytes without publishing an artifact", async () => {
        const upload = await store.beginArtifactAsync(request(), context);
        await store.writeArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, bytes: bytes(content) }, context);
        const abort = { namespace: "explorer", uploadId: upload.uploadId, idempotencyKey: randomUUID() };
        await store.abortArtifactAsync(abort, context); await store.abortArtifactAsync(abort, context);
        expect(readdirSync(join(store.directory, "staging"))).not.toContain(upload.uploadId);
        await expect(store.commitArtifactAsync({ ...abort, idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "transfer_incomplete" });
    });
});
