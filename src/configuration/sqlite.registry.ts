import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstatSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IRegisteredDatabase, IRegisteredServer, IRegisterDatabase, IRegisterServer, IListDatabases, IPersistenceRegistry } from "../contract/configuration.types.js";
import type { IPage, IPageRequest, IStoreContext } from "../contract/persistence.types.js";
import { canonical, digest, fail, integer, segment, text } from "../contract/validation.js";
import { registerDatabase, registerServer } from "./validation.js";

type Row = Record<string, string | number>;
interface Database {
    exec(sql: string): void;
    prepare(sql: string): { get(...args: (string | number)[]): Row | undefined; all(...args: (string | number)[]): Row[]; run(...args: (string | number)[]): unknown };
    close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => Database };
const KEEP_MS = 7 * 86400_000;
export class SqlitePersistenceRegistry implements IPersistenceRegistry {
    private readonly db: Database;
    private readonly cursorKey: Buffer;
    private closed = false;

    /** directory is the operator-owned, already created storage root. No MCP-provided physical path. */
    constructor(directory: string) {
        const root = resolve(directory);
        if (!existsSync(root) || lstatSync(root).isSymbolicLink() || realpathSync(root).toLowerCase() !== root.toLowerCase()) fail("invalid_request", "Registry requires a canonical local storage root");
        const path = join(root, "connections.sqlite");
        for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail("integrity_error", "Registry contains a symbolic link");
        this.db = new DatabaseSync(path);
        try {
            this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
            if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) > 1) fail("unsupported_format", "Registry schema is newer than this service");
            this.db.exec(`BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS databases(id TEXT PRIMARY KEY,server TEXT NOT NULL REFERENCES servers(id),json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS idempotency(subject TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(subject,key));
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                PRAGMA user_version=1; COMMIT;`);
            this.db.exec("BEGIN IMMEDIATE");
            try {
                const now = new Date().toISOString(), metadata = { revision: 1, managed: true, createdAt: now, updatedAt: now };
                this.db.prepare("INSERT OR IGNORE INTO servers VALUES(?,?)").run("local", canonical({ id: "local", driver: "sqlite", ...metadata }));
                this.db.prepare("INSERT OR IGNORE INTO databases VALUES(?,?,?)").run("default", "local", canonical({ id: "default", serverId: "local", name: "default", ...metadata }));
                this.db.prepare("INSERT OR IGNORE INTO metadata VALUES('cursor-key',?)").run(randomBytes(32).toString("hex"));
                this.db.exec("COMMIT");
            } catch (error) { this.db.exec("ROLLBACK"); throw error; }
            this.cursorKey = Buffer.from(String(this.db.prepare("SELECT value FROM metadata WHERE key='cursor-key'").get()!.value), "hex");
            if (this.cursorKey.length !== 32) fail("integrity_error", "Invalid registry cursor key");
        } catch (error) { this.db.close(); throw error; }
    }
    private check(context: IStoreContext): void { if (this.closed) fail("busy", "Registry is closed"); text(context.subject, 512); context.signal?.throwIfAborted(); }
    private get<T>(table: "servers" | "databases", id: string): T {
        segment(id); const row = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id);
        if (!row) fail("not_found", "Registration not found"); return JSON.parse(String(row.json)) as T;
    }
    private mutate<T>(request: { expectedRevision: number; idempotencyKey: string }, method: string, context: IStoreContext, action: () => T): T {
        this.check(context); const hash = digest({ method, request });
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("DELETE FROM idempotency WHERE expires<=?").run(Date.now());
            const old = this.db.prepare("SELECT hash,result FROM idempotency WHERE subject=? AND key=?").get(context.subject, request.idempotencyKey);
            if (old) {
                if (old.hash !== hash) fail("idempotency_conflict", "Idempotency key identifies another registration");
                this.db.exec("COMMIT"); return JSON.parse(String(old.result)) as T;
            }
            if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM idempotency").get()!.n) >= 10000) fail("quota_exceeded", "Registry idempotency quota exceeded");
            const result = action();
            this.db.prepare("INSERT INTO idempotency VALUES(?,?,?,?,?)").run(context.subject, request.idempotencyKey, hash, canonical(result), Date.now() + KEEP_MS);
            this.db.exec("COMMIT"); return result;
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    private previous<T extends { revision: number; managed: boolean }>(table: "servers" | "databases", id: string, expected: number): T | undefined {
        const row = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id);
        const old = row ? JSON.parse(String(row.json)) as T : undefined;
        if (old?.managed) fail("policy_denied", "Startup-managed registrations cannot be modified through MCP");
        if ((old?.revision ?? 0) !== expected) fail("revision_conflict", "Expected registration revision does not match");
        if (!old && Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n) >= 1000) fail("quota_exceeded", "Registry entry quota exceeded");
        return old;
    }
    async registerServerAsync(input: IRegisterServer, context: IStoreContext): Promise<IRegisteredServer> {
        const request = registerServer(input);
        return this.mutate(request, "server.register", context, () => {
            const old = this.previous<IRegisteredServer>("servers", request.id, request.expectedRevision), now = new Date().toISOString();
            const { expectedRevision: _expected, idempotencyKey: _key, ...definition } = request;
            const value = { ...definition, revision: (old?.revision ?? 0) + 1, managed: false, createdAt: old?.createdAt ?? now, updatedAt: now };
            this.db.prepare("INSERT INTO servers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(value.id, canonical(value)); return value;
        });
    }
    async registerDatabaseAsync(input: IRegisterDatabase, context: IStoreContext): Promise<IRegisteredDatabase> {
        const request = registerDatabase(input);
        return this.mutate(request, "database.register", context, () => {
            this.get("servers", request.serverId);
            const old = this.previous<IRegisteredDatabase>("databases", request.id, request.expectedRevision), now = new Date().toISOString();
            const { expectedRevision: _expected, idempotencyKey: _key, ...definition } = request;
            const value = { ...definition, revision: (old?.revision ?? 0) + 1, managed: false, createdAt: old?.createdAt ?? now, updatedAt: now };
            this.db.prepare("INSERT INTO databases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET server=excluded.server,json=excluded.json").run(value.id, value.serverId, canonical(value)); return value;
        });
    }
    async getServerAsync(id: string, context: IStoreContext): Promise<IRegisteredServer> { this.check(context); return this.get("servers", id); }
    async getDatabaseAsync(id: string, context: IStoreContext): Promise<IRegisteredDatabase> { this.check(context); return this.get("databases", id); }
    private list<T>(table: "servers" | "databases", request: IListDatabases, context: IStoreContext): IPage<T> {
        this.check(context);
        const limit = request.limit === undefined ? 50 : integer(request.limit, 1, 200);
        if (request.serverId !== undefined) segment(request.serverId);
        const binding = digest({ table, serverId: request.serverId ?? null, subject: context.subject });
        let after = "";
        if (request.cursor !== undefined) {
            try {
                const raw = Buffer.from(text(request.cursor, 4096), "base64url");
                const decipher = createDecipheriv("aes-256-gcm", this.cursorKey, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28));
                const data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString()) as { after: string; binding: string; expires: number };
                if (data.binding !== binding || data.expires <= Date.now()) fail("invalid_request", "Expired or mismatched cursor");
                after = segment(data.after);
            } catch { fail("invalid_request", "Invalid registry cursor"); }
        }
        const rows = table === "databases" && request.serverId !== undefined
            ? this.db.prepare("SELECT id,json FROM databases WHERE id>? AND server=? ORDER BY id LIMIT ?").all(after, request.serverId, limit + 1)
            : this.db.prepare(`SELECT id,json FROM ${table} WHERE id>? ORDER BY id LIMIT ?`).all(after, limit + 1);
        const items = rows.slice(0, limit).map(row => JSON.parse(String(row.json)) as T);
        if (rows.length <= limit) return { items };
        const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.cursorKey, iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify({ binding, after: rows[limit - 1]!.id, expires: Date.now() + 900000 })), cipher.final()]);
        return { items, nextCursor: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url") };
    }
    async listServersAsync(request: IPageRequest, context: IStoreContext): Promise<IPage<IRegisteredServer>> { return this.list("servers", request, context); }
    async listDatabasesAsync(request: IListDatabases, context: IStoreContext): Promise<IPage<IRegisteredDatabase>> { return this.list("databases", request, context); }
    async closeAsync(): Promise<void> { if (!this.closed) { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); this.closed = true; } }
}
