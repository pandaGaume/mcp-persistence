import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { IPersistenceStore } from "../contract/persistence.store.js";
import type { IDocument, IDocumentKey, IPutDocument, IDeleteDocument, IListDocuments, IPageRequest, IPage, IStoreContext, IPurge } from "../contract/persistence.types.js";
import { PersistenceError } from "../contract/errors.js";
import { canonical, digest, fail, integer, segment, text } from "../contract/validation.js";
import type { ISqlSession, SqlConnect } from "./sql.connection.js";
import { exact } from "../configuration/validation.js";

export type IDocumentStore = Pick<IPersistenceStore, "getAsync" | "putAsync" | "deleteAsync" | "listAsync" | "listRevisionsAsync" | "purgeAsync">;
const MAX_BYTES = 1024 * 1024;
const MAX_NAMESPACE_BYTES = 100 * 1024 ** 3;
const RETENTION = 7 * 86400000;

/** Revisions, references, CAS and replay results are committed in the selected SQL database. */
export class SqlDocumentStore implements IDocumentStore {
    private key?: Buffer;
    private ready = false;
    private initializing?: Promise<void>;
    constructor(readonly driver: "postgresql" | "mysql", private readonly connect: SqlConnect, private readonly retentionMs = Infinity) {}

    private async initialize(db: ISqlSession): Promise<void> {
        if (this.ready) return;
        const suffix = this.driver === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin" : "";
        const large = this.driver === "mysql" ? "LONGTEXT" : "TEXT";
        // One lock serializes mutations across processes, including reference checks and idempotence.
        await db.query(`CREATE TABLE IF NOT EXISTS mcp_persistence_meta (id VARCHAR(64) PRIMARY KEY, value TEXT NOT NULL)${suffix}`);
        const insert = this.driver === "postgresql" ? "INSERT INTO mcp_persistence_meta (id,value) VALUES (?,?) ON CONFLICT (id) DO NOTHING" : "INSERT IGNORE INTO mcp_persistence_meta (id,value) VALUES (?,?)";
        await db.query(insert, ["schema", "1"]);
        const schema = (await db.query("SELECT value FROM mcp_persistence_meta WHERE id=?", ["schema"]))[0]?.value;
        if (schema !== "1") fail("unsupported_format", "Unsupported SQL document schema");
        await db.query(`CREATE TABLE IF NOT EXISTS mcp_persistence_revisions (namespace VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, revision BIGINT NOT NULL, kind VARCHAR(256) NOT NULL, deleted INTEGER NOT NULL, document ${large} NOT NULL, bytes BIGINT NOT NULL, PRIMARY KEY(namespace,id,revision))${suffix}`);
        await db.query(`CREATE TABLE IF NOT EXISTS mcp_persistence_references (source_namespace VARCHAR(128) NOT NULL, source_id VARCHAR(128) NOT NULL, source_revision BIGINT NOT NULL, target_namespace VARCHAR(128) NOT NULL, target_id VARCHAR(128) NOT NULL, target_revision BIGINT NOT NULL)${suffix}`);
        await db.query(`CREATE TABLE IF NOT EXISTS mcp_persistence_idempotency (scope VARCHAR(64) NOT NULL, token VARCHAR(64) NOT NULL, namespace VARCHAR(128) NOT NULL, hash VARCHAR(64) NOT NULL, result ${large} NOT NULL, expires BIGINT NOT NULL, bytes BIGINT NOT NULL, PRIMARY KEY(scope,token))${suffix}`);
        await db.query(insert, ["cursor-key", randomBytes(32).toString("hex")]);
        const key = (await db.query("SELECT value FROM mcp_persistence_meta WHERE id=?", ["cursor-key"]))[0]?.value;
        if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) fail("integrity_error", "Invalid database cursor key");
        this.key = Buffer.from(key, "hex"); this.ready = true;
    }
    private async use<T>(context: IStoreContext, write: boolean, action: (db: ISqlSession) => Promise<T>): Promise<T> {
        text(context.subject, 512); context.signal?.throwIfAborted();
        let db: ISqlSession | undefined;
        try {
            db = await this.connect();
            if (!this.ready) {
                this.initializing ??= this.initialize(db).finally(() => { this.initializing = undefined; });
                await this.initializing;
            }
            if (write) {
                // MySQL's default REPEATABLE READ could preserve a snapshot from before this lock.
                if (this.driver === "mysql") await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
                await db.query("BEGIN");
                await db.query("SELECT value FROM mcp_persistence_meta WHERE id=? FOR UPDATE", ["schema"]);
            }
            const result = await action(db);
            context.signal?.throwIfAborted();
            if (write) await db.query("COMMIT");
            return result;
        } catch (error) {
            if (write) await db?.query("ROLLBACK").catch(() => {});
            if (error instanceof PersistenceError) throw error;
            return fail("store_unavailable", "SQL document operation failed");
        } finally { await db?.close().catch(() => {}); }
    }
    private async read(db: ISqlSession, key: IDocumentKey, revision?: number): Promise<IDocument> {
        const values: (string | number)[] = [segment(key.namespace), segment(key.id)];
        if (revision !== undefined) values.push(integer(revision, 1));
        const rows = await db.query(`SELECT document FROM mcp_persistence_revisions WHERE namespace=? AND id=?${revision === undefined ? " ORDER BY revision DESC LIMIT 1" : " AND revision=?"}`, values);
        if (!rows[0]) fail("not_found", "Document revision not found");
        return JSON.parse(rows[0].document as string) as IDocument;
    }
    getAsync(request: IDocumentKey & { revision?: number }, context: IStoreContext): Promise<IDocument> {
        return this.use(context, false, async db => {
            const document = await this.read(db, request, request.revision);
            if (document.deleted && request.revision === undefined) fail("not_found", "Document is deleted");
            return document;
        });
    }
    private async mutate<T>(method: string, request: { namespace: string; idempotencyKey: string }, context: IStoreContext, action: (db: ISqlSession) => Promise<T>): Promise<T> {
        const namespace = segment(request.namespace), token = digest(text(request.idempotencyKey, 128));
        const scope = digest({ subject: text(context.subject, 512), namespace });
        const hash = digest({ method, request });
        return this.use(context, true, async db => {
            await db.query("DELETE FROM mcp_persistence_idempotency WHERE expires<?", [Date.now()]);
            const previous = (await db.query("SELECT hash,result FROM mcp_persistence_idempotency WHERE scope=? AND token=?", [scope, token]))[0];
            if (previous) {
                if (previous.hash !== hash) fail("idempotency_conflict", "Idempotency key already used for another mutation");
                return JSON.parse(previous.result as string) as T;
            }
            const count = (await db.query("SELECT COUNT(*) AS total FROM mcp_persistence_idempotency WHERE namespace=?", [namespace]))[0];
            if (Number(count?.total) >= 100000) fail("quota_exceeded", "Namespace idempotency quota reached");
            const result = await action(db), encoded = canonical(result);
            const bytes = Buffer.byteLength(encoded) + 256;
            const revisions = (await db.query("SELECT COALESCE(SUM(bytes),0) AS total FROM mcp_persistence_revisions WHERE namespace=?", [namespace]))[0];
            const replay = (await db.query("SELECT COALESCE(SUM(bytes),0) AS total FROM mcp_persistence_idempotency WHERE namespace=?", [namespace]))[0];
            if (Number(revisions?.total) + Number(replay?.total) + bytes > MAX_NAMESPACE_BYTES) fail("quota_exceeded", "Namespace storage quota reached");
            await db.query("INSERT INTO mcp_persistence_idempotency (scope,token,namespace,hash,result,expires,bytes) VALUES (?,?,?,?,?,?,?)", [scope, token, namespace, hash, encoded, Date.now() + RETENTION, bytes]);
            return result;
        });
    }
    putAsync(request: IPutDocument, context: IStoreContext): Promise<IDocument> {
        segment(request.namespace); segment(request.id); integer(request.expectedRevision); text(request.kind); text(request.schemaVersion);
        if (!Array.isArray(request.references) || request.references.length > 256) fail("invalid_request", "Invalid document references");
        if (Buffer.byteLength(canonical(request)) > MAX_BYTES) fail("quota_exceeded", "Document request exceeds 1 MiB");
        return this.mutate("put", request, context, async db => {
            let previous: IDocument | undefined;
            try { previous = await this.read(db, request); } catch (error) { if (!(error instanceof PersistenceError) || error.code !== "not_found") throw error; }
            if ((previous?.revision ?? 0) !== request.expectedRevision) fail("revision_conflict", "Expected revision differs from the current revision");
            for (const reference of request.references) {
                exact(reference, reference.type === "document" ? ["type", "namespace", "id", "revision"] : ["type", "namespace", "id"]);
                segment(reference.namespace); segment(reference.id);
                if (reference.type === "artifact") fail("unsupported_format", "SQL documents cannot reference local artifacts");
                if (reference.type !== "document") fail("invalid_request", "Invalid reference type");
                const target = await this.read(db, reference, integer(reference.revision, 1));
                if (target.deleted) fail("not_found", "Referenced document is deleted");
            }
            const now = new Date().toISOString();
            const document: IDocument = { namespace: request.namespace, id: request.id, kind: request.kind, schemaVersion: request.schemaVersion, revision: integer((previous?.revision ?? 0) + 1, 1), createdAt: previous?.createdAt ?? now, updatedAt: now, deleted: false, payload: request.payload, references: request.references };
            await this.insert(db, document); return document;
        });
    }
    private async insert(db: ISqlSession, document: IDocument): Promise<void> {
        const encoded = canonical(document);
        await db.query("INSERT INTO mcp_persistence_revisions (namespace,id,revision,kind,deleted,document,bytes) VALUES (?,?,?,?,?,?,?)", [document.namespace, document.id, document.revision, document.kind, document.deleted ? 1 : 0, encoded, Buffer.byteLength(encoded) + document.references.length * 512 + 128]);
        for (const ref of document.references) {
            if (ref.type === "document") await db.query("INSERT INTO mcp_persistence_references (source_namespace,source_id,source_revision,target_namespace,target_id,target_revision) VALUES (?,?,?,?,?,?)", [document.namespace, document.id, document.revision, ref.namespace, ref.id, ref.revision]);
        }
    }
    deleteAsync(request: IDeleteDocument, context: IStoreContext): Promise<IDocument> {
        integer(request.expectedRevision, 1);
        return this.mutate("delete", request, context, async db => {
            const current = await this.read(db, request);
            if (current.revision !== request.expectedRevision) fail("revision_conflict", "Expected revision differs from the current revision");
            const document = { ...current, revision: integer(current.revision + 1, 1), updatedAt: new Date().toISOString(), deleted: true, payload: null, references: [] };
            await this.insert(db, document); return document;
        });
    }
    private cursor(binding: string, last: string | number): string {
        const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key!, iv);
        const bytes = Buffer.concat([cipher.update(canonical({ binding, last, expires: Date.now() + 900000 })), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
    }
    private after(cursor: string | undefined, binding: string): string | number | undefined {
        if (cursor === undefined) return undefined;
        try {
            const raw = Buffer.from(text(cursor, 4096), "base64url"), decipher = createDecipheriv("aes-256-gcm", this.key!, raw.subarray(0, 12));
            decipher.setAuthTag(raw.subarray(12, 28));
            const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString()) as { binding: string; expires: number; last: string | number };
            if (value.binding !== binding || value.expires < Date.now() || !["string", "number"].includes(typeof value.last)) throw new Error();
            return value.last;
        } catch { fail("invalid_request", "Invalid or expired pagination cursor"); }
    }
    listAsync(request: IListDocuments, context: IStoreContext): Promise<IPage<IDocument>> {
        const namespace = segment(request.namespace), limit = integer(request.limit ?? 50, 1, 200);
        if (request.kind !== undefined) text(request.kind);
        if (request.includeDeleted !== undefined && typeof request.includeDeleted !== "boolean") fail("invalid_request", "Invalid includeDeleted flag");
        const binding = digest({ subject: context.subject, namespace, kind: request.kind ?? null, deleted: request.includeDeleted ?? false, method: "list" });
        return this.use(context, false, async db => {
            const last = this.after(request.cursor, binding);
            const rows = await db.query(`SELECT r.document FROM mcp_persistence_revisions r JOIN (SELECT id,MAX(revision) AS head FROM mcp_persistence_revisions WHERE namespace=? GROUP BY id) h ON r.id=h.id AND r.revision=h.head WHERE r.namespace=? AND r.id>?${request.includeDeleted ? "" : " AND r.deleted=0"}${request.kind === undefined ? "" : " AND r.kind=?"} ORDER BY r.id LIMIT ${limit + 1}`, [namespace, namespace, last ?? "", ...(request.kind === undefined ? [] : [request.kind])]);
            const items = rows.slice(0, limit).map(r => JSON.parse(r.document as string) as IDocument);
            return { items, ...(rows.length > limit ? { nextCursor: this.cursor(binding, items.at(-1)!.id) } : {}) };
        });
    }
    listRevisionsAsync(request: IDocumentKey & IPageRequest, context: IStoreContext): Promise<IPage<IDocument>> {
        const namespace = segment(request.namespace), id = segment(request.id), limit = integer(request.limit ?? 50, 1, 200);
        const binding = digest({ subject: context.subject, namespace, id, method: "revisions" });
        return this.use(context, false, async db => {
            await this.read(db, { namespace, id });
            const last = this.after(request.cursor, binding);
            const rows = await db.query(`SELECT document FROM mcp_persistence_revisions WHERE namespace=? AND id=? AND revision>? ORDER BY revision LIMIT ${limit + 1}`, [namespace, id, last ?? 0]);
            const items = rows.slice(0, limit).map(r => JSON.parse(r.document as string) as IDocument);
            return { items, ...(rows.length > limit ? { nextCursor: this.cursor(binding, items.at(-1)!.revision) } : {}) };
        });
    }
    async purgeAsync(request: IPurge, context: IStoreContext): Promise<void> {
        if (request.target.type !== "document") fail("unsupported_format", "SQL storage supports document revisions");
        const target = request.target;
        await this.mutate("purge", request, context, async db => {
            const key = { namespace: request.namespace, id: segment(target.id) }, revision = integer(target.revision, 1);
            const document = await this.read(db, key, revision), current = await this.read(db, key);
            if (current.revision === revision || Date.now() - Date.parse(document.updatedAt) < this.retentionMs) fail("retention_blocked", "Revision is current or inside retention");
            const incoming = await db.query("SELECT source_id FROM mcp_persistence_references WHERE target_namespace=? AND target_id=? AND target_revision=? LIMIT 1", [key.namespace, key.id, revision]);
            if (incoming.length) fail("retention_blocked", "Revision has incoming references");
            await db.query("DELETE FROM mcp_persistence_references WHERE source_namespace=? AND source_id=? AND source_revision=?", [key.namespace, key.id, revision]);
            await db.query("DELETE FROM mcp_persistence_revisions WHERE namespace=? AND id=? AND revision=?", [key.namespace, key.id, revision]);
            return { ok: true };
        });
    }
}
