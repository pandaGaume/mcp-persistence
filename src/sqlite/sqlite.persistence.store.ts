import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import type { IPersistenceStore } from "../contract/persistence.store.js";
import type { IArtifact, IBeginArtifact, IDeleteDocument, IDocument, IDocumentKey, IFinishArtifact, IListDocuments, IPage, IPageRequest, IPersistenceCapabilities, IPurge, IPutDocument, IStoreContext, IUpload } from "../contract/persistence.types.js";
import { canonical, digest, fail, integer, segment, text } from "../contract/validation.js";
import { PersistenceError } from "../contract/errors.js";

type Row = Record<string, string | number | null>;
type Input = string | number | null;
// The small synchronous node:sqlite surface used here, compatible with Node 22.13+.
interface Database {
    exec(sql: string): void;
    prepare(sql: string): { get(...args: Input[]): Row | undefined; all(...args: Input[]): Row[]; run(...args: Input[]): unknown };
    close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => Database };
const DAY = 86_400_000;
const DEFAULTS = { maxDocumentBytes: 1_048_576, maxArtifactBytes: 10 * 1024 ** 3, maxReferences: 256, maxPageSize: 200, maxNamespaceBytes: 100 * 1024 ** 3, idempotencyRetentionSeconds: 7 * 86400 };
export interface ISqlitePersistenceOptions {
    directory: string;
    limits?: Partial<typeof DEFAULTS>;
    retentionMs?: number;
    /** Windows cannot fsync directories through Node. Opt in explicitly to file-sync durability. */
    allowFileSyncOnly?: boolean;
}

/** One provider process owns one local data root. SQLite serializes all metadata mutations. */
export class SqlitePersistenceStore implements IPersistenceStore {
    readonly id = "sqlite-files";
    readonly directory: string;
    private readonly db: Database;
    private readonly limits: typeof DEFAULTS;
    private readonly cursorKey: Buffer;
    private readonly retentionMs: number;
    private readonly fileSyncOnly: boolean;
    private readonly active = new Set<string>();
    private readonly readers = new Map<string, number>();
    private closed = false;

    constructor(options: ISqlitePersistenceOptions) {
        this.limits = { ...DEFAULTS, ...options.limits };
        for (const value of Object.values(this.limits)) integer(value, 1);
        if (this.limits.maxPageSize > 200 || this.limits.maxReferences > 256) fail("invalid_request", "Page and reference limits exceed persistence.v1 protocol ceilings");
        if (this.limits.idempotencyRetentionSeconds < 7 * 86400) fail("invalid_request", "Idempotency retention must be at least seven days");
        this.retentionMs = options.retentionMs === undefined ? Infinity : integer(options.retentionMs);
        this.fileSyncOnly = options.allowFileSyncOnly === true;
        if (process.platform === "win32" && !this.fileSyncOnly) fail("unsupported_format", "Windows requires explicit allowFileSyncOnly; directory synchronization is unavailable");
        const dir = resolve(options.directory);
        mkdirSync(dir, { recursive: true });
        if (lstatSync(dir).isSymbolicLink() || realpathSync(dir).toLowerCase() !== dir.toLowerCase()) fail("invalid_request", "Storage root must be a canonical local directory");
        this.directory = dir;
        for (const sub of ["staging", "artifacts"]) { mkdirSync(join(dir, sub), { recursive: true }); this.safe(sub); }
        for (const f of ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm", "cursor.key", "writer.lock"]) if (existsSync(join(dir, f))) this.safe(f);
        const lock = join(dir, "writer.lock");
        if (existsSync(lock)) {
            const pid = Number(readFileSync(lock, "utf8"));
            if (!Number.isSafeInteger(pid) || pid < 1) fail("busy", "Storage lock needs operator inspection");
            try { process.kill(pid, 0); fail("busy", "Data root already has a writer"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            unlinkSync(lock);
        }
        writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        let opened: Database | undefined;
        try {
            opened = new DatabaseSync(join(dir, "store.sqlite"));
            this.db = opened;
            this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
            const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
            if (version > 2) fail("unsupported_format", "Database schema is newer than this service");
            this.db.exec(`BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS revisions(ns TEXT NOT NULL,id TEXT NOT NULL,rev INTEGER NOT NULL,json TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(ns,id,rev));
                CREATE TABLE IF NOT EXISTS heads(ns TEXT NOT NULL,id TEXT NOT NULL,rev INTEGER NOT NULL,PRIMARY KEY(ns,id),FOREIGN KEY(ns,id,rev) REFERENCES revisions(ns,id,rev));
                CREATE TABLE IF NOT EXISTS refs(ns TEXT NOT NULL,id TEXT NOT NULL,rev INTEGER NOT NULL,type TEXT NOT NULL,targetNs TEXT NOT NULL,targetId TEXT NOT NULL,targetRev INTEGER NOT NULL,FOREIGN KEY(ns,id,rev) REFERENCES revisions(ns,id,rev) ON DELETE CASCADE);
                CREATE INDEX IF NOT EXISTS ref_target ON refs(type,targetNs,targetId,targetRev);
                CREATE TABLE IF NOT EXISTS artifacts(ns TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(ns,id));
                CREATE TABLE IF NOT EXISTS uploads(ns TEXT NOT NULL,id TEXT NOT NULL,artifact TEXT NOT NULL,subject TEXT NOT NULL,json TEXT NOT NULL,size INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(ns,id));
                CREATE TABLE IF NOT EXISTS idem(ns TEXT NOT NULL,subject TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(ns,subject,key));
                CREATE TABLE IF NOT EXISTS garbage(ns TEXT NOT NULL,path TEXT PRIMARY KEY,size INTEGER NOT NULL);
                PRAGMA user_version=2; COMMIT;`);
            if (!existsSync(join(dir, "cursor.key"))) this.writeDurable(join(dir, "cursor.key"), randomBytes(32));
            this.cursorKey = readFileSync(this.safe("cursor.key"));
            if (this.cursorKey.length !== 32) fail("integrity_error", "Invalid cursor signing key");
            this.recover();
            this.syncDirectory(dir);
        } catch (error) { opened?.close(); unlinkSync(lock); throw error; }
    }

    private safe(relative: string): string {
        const parts = relative.split("/");
        let path = this.directory;
        for (const part of parts) {
            if (!/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..") fail("invalid_request", "Invalid internal path");
            path = join(path, part);
            if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail("integrity_error", "Storage contains a symbolic link");
        }
        return path;
    }
    private syncDirectory(dir: string): void {
        if (process.platform === "win32" && this.fileSyncOnly) return;
        const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    private writeDurable(path: string, data: Uint8Array): void {
        const fd = openSync(path, "wx", 0o600);
        try { let offset = 0; while (offset < data.length) offset += writeSync(fd, data, offset); fsyncSync(fd); } finally { closeSync(fd); }
        this.syncDirectory(this.directory);
    }
    private check(context: IStoreContext): void {
        if (this.closed) fail("busy", "Store is closed");
        text(context.subject, 512); context.signal?.throwIfAborted();
    }
    private key(key: IDocumentKey): void { segment(key.namespace); segment(key.id); }
    private quota(namespace: string): void {
        const row = this.db.prepare(`SELECT
            COALESCE((SELECT SUM(bytes) FROM revisions WHERE ns=?),0)+
            COALESCE((SELECT SUM(size+length(json)+128) FROM artifacts WHERE ns=?),0)+
            COALESCE((SELECT SUM(size+length(json)+128) FROM uploads WHERE ns=?),0)+
            COALESCE((SELECT SUM(length(result)*4+length(key)*4+length(subject)*4+256) FROM idem WHERE ns=?),0)+
            COALESCE((SELECT SUM(size) FROM garbage WHERE ns=?),0) AS total`).get(namespace, namespace, namespace, namespace, namespace)!;
        if (Number(row.total) > this.limits.maxNamespaceBytes) fail("quota_exceeded", "Namespace storage quota exceeded");
    }
    private mutation<T>(method: string, request: { namespace: string; idempotencyKey: string }, context: IStoreContext, action: () => T): T {
        this.check(context); segment(request.namespace); text(request.idempotencyKey, 128);
        const fingerprint = digest({ method, request });
        this.expireUploads(); this.collectGarbage();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("DELETE FROM idem WHERE expires<=?").run(Date.now());
            const old = this.db.prepare("SELECT fingerprint,result FROM idem WHERE ns=? AND subject=? AND key=?").get(request.namespace, context.subject, request.idempotencyKey);
            if (old) {
                if (old.fingerprint !== fingerprint) fail("idempotency_conflict", "Idempotency key already identifies another mutation");
                this.db.exec("COMMIT"); return JSON.parse(String(old.result)) as T;
            }
            const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM idem WHERE ns=?").get(request.namespace)!.n);
            if (count >= 100_000) fail("quota_exceeded", "Idempotency quota exceeded");
            const result = action();
            this.db.prepare("INSERT INTO idem VALUES(?,?,?,?,?,?)").run(request.namespace, context.subject, request.idempotencyKey, fingerprint, JSON.stringify(result ?? null), Date.now() + this.limits.idempotencyRetentionSeconds * 1000);
            this.quota(request.namespace); this.db.exec("COMMIT"); return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            if ((error as { code?: string }).code === "SQLITE_BUSY") fail("busy", "Storage is busy");
            throw error;
        }
    }
    async getCapabilitiesAsync(): Promise<IPersistenceCapabilities> {
        return { contract: "persistence.v1", limits: { ...this.limits }, durability: this.fileSyncOnly ? "file-sync" : "file-and-directory-sync" };
    }
    private document(key: IDocumentKey, revision?: number): IDocument {
        this.key(key);
        if (revision !== undefined) integer(revision, 1);
        const row = revision === undefined
            ? this.db.prepare("SELECT r.json FROM heads h JOIN revisions r ON r.ns=h.ns AND r.id=h.id AND r.rev=h.rev WHERE h.ns=? AND h.id=?").get(key.namespace, key.id)
            : this.db.prepare("SELECT json FROM revisions WHERE ns=? AND id=? AND rev=?").get(key.namespace, key.id, revision);
        if (!row) fail("not_found", "Document revision not found");
        return JSON.parse(String(row.json)) as IDocument;
    }
    async getAsync(request: IDocumentKey & { revision?: number }, context: IStoreContext): Promise<IDocument> {
        this.check(context); const doc = this.document(request, request.revision);
        if (request.revision === undefined && doc.deleted) fail("not_found", "Document is deleted"); return doc;
    }
    private insert(doc: IDocument): IDocument {
        const json = canonical(doc);
        this.db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?)").run(doc.namespace, doc.id, doc.revision, json, Buffer.byteLength(json) + doc.references.length * 512 + 128);
        this.db.prepare("INSERT INTO heads VALUES(?,?,?) ON CONFLICT(ns,id) DO UPDATE SET rev=excluded.rev").run(doc.namespace, doc.id, doc.revision);
        for (const ref of doc.references) this.db.prepare("INSERT INTO refs VALUES(?,?,?,?,?,?,?)").run(doc.namespace, doc.id, doc.revision, ref.type, ref.namespace, ref.id, ref.type === "document" ? ref.revision : 0);
        return doc;
    }
    async putAsync(request: IPutDocument, context: IStoreContext): Promise<IDocument> {
        this.key(request); integer(request.expectedRevision); text(request.kind); text(request.schemaVersion);
        if (!Array.isArray(request.references) || request.references.length > this.limits.maxReferences) fail("invalid_request", "Invalid reference list");
        if (Buffer.byteLength(canonical(request)) > this.limits.maxDocumentBytes) fail("quota_exceeded", "Document exceeds byte limit");
        return this.mutation("put", request, context, () => {
            let old: IDocument | undefined;
            try { old = this.document(request); } catch (error) { if (!(error instanceof PersistenceError) || error.code !== "not_found") throw error; }
            if ((old?.revision ?? 0) !== request.expectedRevision) fail("revision_conflict", "Expected revision does not match");
            for (const ref of request.references) {
                this.key(ref);
                if (ref.type === "document") { if (this.document(ref, integer(ref.revision, 1)).deleted) fail("not_found", "Referenced revision is deleted"); }
                else if (ref.type === "artifact") this.artifact(ref);
                else fail("invalid_request", "Unsupported reference type");
            }
            const now = new Date().toISOString();
            return this.insert({ namespace: request.namespace, id: request.id, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now, kind: request.kind, schemaVersion: request.schemaVersion, payload: request.payload, references: request.references, deleted: false });
        });
    }
    private page<T>(request: IPageRequest, binding: object, rows: () => Row[]): IPage<T> {
        const limit = request.limit === undefined ? Math.min(50, this.limits.maxPageSize) : integer(request.limit, 1, this.limits.maxPageSize);
        let after: string | number = "";
        if (request.cursor !== undefined) {
            text(request.cursor, 4096);
            try {
                const raw = Buffer.from(request.cursor, "base64url");
                const cipher = createDecipheriv("aes-256-gcm", this.cursorKey, raw.subarray(0, 12)); cipher.setAuthTag(raw.subarray(12, 28));
                const cursor = JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString()) as { binding: string; after: string | number; expires: number };
                if (cursor.binding !== digest(binding) || cursor.expires <= Date.now()) fail("invalid_request", "Expired or mismatched cursor");
                after = cursor.after;
            } catch { fail("invalid_request", "Invalid cursor"); }
        }
        // SQL queries below are keyset queries with a bounded LIMIT, including an extra row.
        this.pageAfter = after; this.pageLimit = limit;
        const found = rows();
        const items = found.slice(0, limit).map(r => JSON.parse(String(r.json)) as T);
        if (found.length <= limit) return { items };
        const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.cursorKey, iv);
        const encoded = Buffer.concat([cipher.update(JSON.stringify({ binding: digest(binding), after: found[limit - 1]!.key, expires: Date.now() + 900_000 })), cipher.final()]);
        return { items, nextCursor: Buffer.concat([iv, cipher.getAuthTag(), encoded]).toString("base64url") };
    }
    private pageAfter: string | number = "";
    private pageLimit = 50;
    async listAsync(request: IListDocuments, context: IStoreContext): Promise<IPage<IDocument>> {
        this.check(context); segment(request.namespace);
        if (request.kind !== undefined) text(request.kind);
        if (request.includeDeleted !== undefined && typeof request.includeDeleted !== "boolean") fail("invalid_request", "Invalid deleted filter");
        return this.page(request, { method: "list", ns: request.namespace, kind: request.kind ?? null, deleted: request.includeDeleted ?? false, subject: context.subject }, () =>
            this.db.prepare(`SELECT h.id AS key,r.json FROM heads h JOIN revisions r ON r.ns=h.ns AND r.id=h.id AND r.rev=h.rev
            WHERE h.ns=? AND h.id>? AND (? IS NULL OR json_extract(r.json,'$.kind')=?) AND (?=1 OR json_extract(r.json,'$.deleted')=0) ORDER BY h.id LIMIT ?`)
                .all(request.namespace, String(this.pageAfter), request.kind ?? null, request.kind ?? null, request.includeDeleted ? 1 : 0, this.pageLimit + 1));
    }
    async listRevisionsAsync(request: IDocumentKey & IPageRequest, context: IStoreContext): Promise<IPage<IDocument>> {
        this.check(context); this.key(request); this.document(request);
        return this.page(request, { method: "revisions", ns: request.namespace, id: request.id, subject: context.subject }, () =>
            this.db.prepare("SELECT rev AS key,json FROM revisions WHERE ns=? AND id=? AND rev>? ORDER BY rev LIMIT ?").all(request.namespace, request.id, Number(this.pageAfter) || 0, this.pageLimit + 1));
    }
    async deleteAsync(request: IDeleteDocument, context: IStoreContext): Promise<IDocument> {
        this.key(request); integer(request.expectedRevision, 1);
        return this.mutation("delete", request, context, () => {
            const old = this.document(request);
            if (old.revision !== request.expectedRevision) fail("revision_conflict", "Expected revision does not match");
            return this.insert({ ...old, revision: old.revision + 1, updatedAt: new Date().toISOString(), deleted: true, payload: null, references: [] });
        });
    }
    async beginArtifactAsync(request: IBeginArtifact, context: IStoreContext): Promise<IUpload> {
        integer(request.size, 0, this.limits.maxArtifactBytes); text(request.mimeType, 128);
        if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(request.mimeType)) fail("invalid_request", "Invalid MIME type");
        if (request.hash?.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(request.hash.value)) fail("invalid_request", "Expected SHA-256 hash");
        if (Buffer.byteLength(canonical(request.provenance)) > this.limits.maxDocumentBytes) fail("quota_exceeded", "Provenance exceeds limit");
        return this.mutation("beginArtifact", request, context, () => {
            if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE subject=? AND state IN ('pending','complete')").get(context.subject)!.n) >= 4) fail("quota_exceeded", "Too many active uploads");
            const upload: IUpload = { namespace: request.namespace, artifactId: randomUUID(), uploadId: randomUUID(), expiresAt: new Date(Date.now() + DAY).toISOString() };
            const metadata: IArtifact = { namespace: request.namespace, id: upload.artifactId, mimeType: request.mimeType, size: request.size, hash: request.hash, provenance: request.provenance, createdAt: new Date().toISOString() };
            this.db.prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?)").run(request.namespace, upload.uploadId, upload.artifactId, context.subject, canonical(metadata), request.size, Date.parse(upload.expiresAt), "pending");
            return upload;
        });
    }
    private upload(namespace: string, id: string, context: IStoreContext): Row {
        this.check(context); segment(namespace); segment(id);
        const row = this.db.prepare("SELECT * FROM uploads WHERE ns=? AND id=? AND subject=?").get(namespace, id, context.subject);
        if (!row || Number(row.expires) <= Date.now()) fail("not_found", "Upload not found or expired"); return row;
    }
    async inspectUploadAsync(namespace: string, uploadId: string, context: IStoreContext): Promise<IUpload> {
        const row = this.upload(namespace, uploadId, context);
        return { namespace, uploadId, artifactId: String(row.artifact), expiresAt: new Date(Number(row.expires)).toISOString() };
    }
    async writeArtifactAsync(request: { namespace: string; uploadId: string; bytes: AsyncIterable<Uint8Array> }, context: IStoreContext): Promise<void> {
        const row = this.upload(request.namespace, request.uploadId, context);
        if (this.active.has(request.uploadId) || row.state !== "pending") fail("busy", "Upload is already writing or complete");
        this.active.add(request.uploadId);
        const path = this.safe(`staging/${request.uploadId}`);
        let fd: number | undefined;
        try {
            rmSync(path, { force: true }); fd = openSync(path, "wx", 0o600);
            const hash = createHash("sha256"); let size = 0;
            for await (const bytes of request.bytes) {
                context.signal?.throwIfAborted();
                if (Date.now() > Number(row.expires)) fail("transfer_incomplete", "Upload expired");
                if (!(bytes instanceof Uint8Array)) fail("invalid_request", "Expected binary chunks");
                size += bytes.byteLength;
                if (size > Number(row.size)) fail("quota_exceeded", "Upload exceeds reserved size");
                hash.update(bytes); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
            }
            const expected = JSON.parse(String(row.json)) as IArtifact;
            if (size !== expected.size) fail("transfer_incomplete", "Upload is incomplete");
            if (hash.digest("hex") !== expected.hash.value) fail("integrity_error", "Artifact hash does not match");
            fsyncSync(fd); closeSync(fd); fd = undefined; this.syncDirectory(this.safe("staging"));
            this.db.prepare("UPDATE uploads SET state='complete' WHERE ns=? AND id=?").run(request.namespace, request.uploadId);
        } catch (error) { if (fd !== undefined) closeSync(fd); rmSync(path, { force: true }); throw error; }
        finally { this.active.delete(request.uploadId); }
    }
    async commitArtifactAsync(request: IFinishArtifact, context: IStoreContext): Promise<IArtifact> {
        return this.mutation("commitArtifact", request, context, () => {
            const row = this.upload(request.namespace, request.uploadId, context);
            if (row.state !== "complete" || this.active.has(request.uploadId)) fail("transfer_incomplete", "Upload has not completed");
            const metadata = JSON.parse(String(row.json)) as IArtifact;
            const stage = this.safe(`staging/${request.uploadId}`), final = this.safe(`artifacts/${metadata.id}`);
            // A previous rolled-back commit can leave the verified file at its final path.
            const source = existsSync(stage) ? stage : final;
            this.verifyFile(source, metadata);
            if (source === stage) renameSync(stage, final);
            this.syncDirectory(this.safe("artifacts")); this.syncDirectory(this.safe("staging"));
            this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?)").run(metadata.namespace, metadata.id, canonical(metadata), metadata.size);
            this.db.prepare("UPDATE uploads SET state='committed',size=0,expires=? WHERE ns=? AND id=?").run(Date.now() + this.limits.idempotencyRetentionSeconds * 1000, request.namespace, request.uploadId);
            return metadata;
        });
    }
    async abortArtifactAsync(request: IFinishArtifact, context: IStoreContext): Promise<void> {
        this.mutation("abortArtifact", request, context, () => {
            const row = this.upload(request.namespace, request.uploadId, context);
            if (this.active.has(request.uploadId)) fail("busy", "Upload is active");
            if (row.state === 'committed') fail("revision_conflict", "Committed artifacts cannot be aborted");
            for (const path of [`staging/${request.uploadId}`, `artifacts/${row.artifact}`]) {
                const full = this.safe(path);
                if (existsSync(full)) this.db.prepare("INSERT OR IGNORE INTO garbage VALUES(?,?,?)").run(request.namespace, path, statSync(full).size);
            }
            this.db.prepare("UPDATE uploads SET state='aborted',size=0,expires=? WHERE ns=? AND id=?").run(Date.now() + this.limits.idempotencyRetentionSeconds * 1000, request.namespace, request.uploadId);
            // Files are collected after commit so rollback never destroys a live upload.
            return { artifact: String(row.artifact) };
        });
        this.collectGarbage();
        this.collectOrphans();
    }
    private artifact(key: IDocumentKey): IArtifact {
        this.key(key); const row = this.db.prepare("SELECT json FROM artifacts WHERE ns=? AND id=?").get(key.namespace, key.id);
        if (!row) fail("not_found", "Artifact not found"); return JSON.parse(String(row.json)) as IArtifact;
    }
    async getArtifactAsync(request: IDocumentKey, context: IStoreContext): Promise<IArtifact> { this.check(context); return this.artifact(request); }
    async readArtifactAsync(request: IDocumentKey, context: IStoreContext): Promise<AsyncIterable<Uint8Array>> {
        this.check(context); const metadata = this.artifact(request), path = this.safe(`artifacts/${metadata.id}`);
        this.verifyFile(path, metadata);
        const fd = openSync(path, "r");
        const stream = createReadStream(path, { fd, autoClose: true, signal: context.signal });
        const readKey = `read-${randomUUID()}`;
        this.active.add(readKey);
        this.readers.set(metadata.id, (this.readers.get(metadata.id) ?? 0) + 1);
        stream.once("close", () => {
            this.active.delete(readKey); const n = this.readers.get(metadata.id)! - 1;
            if (n) this.readers.set(metadata.id, n); else this.readers.delete(metadata.id);
            if (!this.closed) this.collectGarbage();
        });
        return stream;
    }
    private verifyFile(path: string, metadata: IArtifact): void {
        if (!existsSync(path) || !lstatSync(path).isFile() || statSync(path).size !== metadata.size) fail("integrity_error", "Artifact file missing or wrong size");
        const fd = openSync(path, "r");
        try {
            const hash = createHash("sha256"), buffer = Buffer.alloc(128 * 1024);
            // Synchronous verification is bounded in memory and runs before publishing/serving bytes.
            let n: number;
            while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
            if (hash.digest("hex") !== metadata.hash.value) fail("integrity_error", "Artifact hash does not match");
        } finally { closeSync(fd); }
    }
    async purgeAsync(request: IPurge, context: IStoreContext): Promise<void> {
        segment(request.target.id);
        this.mutation("purge", request, context, () => {
            const t = request.target;
            if (t.type !== "document" && t.type !== "artifact") fail("invalid_request", "Invalid purge target");
            const revision = t.type === "document" ? integer(t.revision, 1) : 0;
            const created = t.type === "document" ? this.document({ namespace: request.namespace, id: t.id }, revision).updatedAt : this.artifact({ namespace: request.namespace, id: t.id }).createdAt;
            if (Date.now() - Date.parse(created) < this.retentionMs) fail("retention_blocked", "Minimum retention has not elapsed");
            if (this.db.prepare("SELECT 1 FROM refs WHERE type=? AND targetNs=? AND targetId=? AND targetRev=? LIMIT 1").get(t.type, request.namespace, t.id, revision)) fail("retention_blocked", "Target is referenced by an immutable revision");
            if (t.type === "artifact") {
                const metadata = this.artifact({ namespace: request.namespace, id: t.id });
                this.db.prepare("INSERT INTO garbage VALUES(?,?,?)").run(request.namespace, `artifacts/${t.id}`, metadata.size);
                this.db.prepare("DELETE FROM artifacts WHERE ns=? AND id=?").run(request.namespace, t.id);
            }
            else {
                if (this.db.prepare("SELECT 1 FROM heads WHERE ns=? AND id=? AND rev=?").get(request.namespace, t.id, revision)) fail("retention_blocked", "Current head cannot be purged");
                this.db.prepare("DELETE FROM revisions WHERE ns=? AND id=? AND rev=?").run(request.namespace, t.id, revision);
            }
            return null;
        });
        this.collectGarbage();
        this.collectOrphans();
    }
    private collectGarbage(): void {
        for (const row of this.db.prepare("SELECT * FROM garbage").all()) {
            const path = String(row.path), id = path.split("/")[1]!;
            if (this.readers.has(id)) continue;
            const held = path.startsWith("staging/") ? this.db.prepare("SELECT 1 FROM uploads WHERE id=? AND state IN ('pending','complete')").get(id)
                : this.db.prepare("SELECT 1 FROM artifacts WHERE id=? UNION ALL SELECT 1 FROM uploads WHERE artifact=? AND state IN ('pending','complete')").get(id, id);
            if (held) continue;
            try {
                rmSync(this.safe(path), { force: true }); this.syncDirectory(this.safe(path.split("/")[0]!));
                this.db.prepare("DELETE FROM garbage WHERE path=?").run(path);
            } catch { /* Keep accounting reserved and retry at recovery or the next collection. */ }
        }
    }
    private expireUploads(): void {
        for (const row of this.db.prepare("SELECT * FROM uploads WHERE expires<=?").all(Date.now())) {
            if (this.active.has(String(row.id))) continue;
            for (const path of [`staging/${row.id}`, `artifacts/${row.artifact}`]) {
                const file = this.safe(path);
                if (existsSync(file) && !this.db.prepare("SELECT 1 FROM artifacts WHERE id=?").get(String(row.artifact))) this.db.prepare("INSERT OR IGNORE INTO garbage VALUES(?,?,?)").run(String(row.ns), path, statSync(file).size);
            }
            this.db.prepare("DELETE FROM uploads WHERE ns=? AND id=?").run(String(row.ns), String(row.id));
        }
    }
    private collectOrphans(): void {
        for (const sub of ["staging", "artifacts"]) for (const name of readdirSync(this.safe(sub))) {
            const path = this.safe(`${sub}/${name}`);
            const held = sub === "staging" ? this.db.prepare("SELECT 1 FROM uploads WHERE id=? AND state IN ('pending','complete')").get(name)
                : this.db.prepare("SELECT 1 FROM artifacts WHERE id=? UNION ALL SELECT 1 FROM uploads WHERE artifact=? AND state IN ('pending','complete')").get(name, name);
            if (!held && !this.active.has(name) && Date.now() - statSync(path).mtimeMs > DAY) rmSync(path, { force: true });
        }
    }
    private recover(): void {
        this.collectGarbage();
        this.expireUploads();
        for (const row of this.db.prepare("SELECT * FROM uploads").all()) {
            const stage = this.safe(`staging/${row.id}`), final = this.safe(`artifacts/${row.artifact}`);
            if (row.state === "complete") this.verifyFile(existsSync(stage) ? stage : final, JSON.parse(String(row.json)) as IArtifact);
            else {
                rmSync(stage, { force: true });
                if (row.state === "aborted" && !this.db.prepare("SELECT 1 FROM artifacts WHERE id=?").get(String(row.artifact))) rmSync(final, { force: true });
            }
        }
        for (const row of this.db.prepare("SELECT json FROM artifacts").all()) { const metadata = JSON.parse(String(row.json)) as IArtifact; this.verifyFile(this.safe(`artifacts/${metadata.id}`), metadata); }
        this.collectOrphans();
    }
    async closeAsync(): Promise<void> {
        if (this.closed) return;
        if (this.active.size) fail("busy", "Transfers are still active");
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); this.closed = true; unlinkSync(this.safe("writer.lock"));
    }
}
