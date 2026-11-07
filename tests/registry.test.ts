import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SqlitePersistenceRegistry, VaultCredentialsResolver } from "../src/index.js";
import { MemoryVaultStore } from "@cyanmycelium/mcp-vault";

describe("connection registry and vault references", () => {
    const context = { subject: "operator" };
    const registries: SqlitePersistenceRegistry[] = [];
    const create = (root = mkdtempSync(join(tmpdir(), "persistence-registry-"))) => { const registry = new SqlitePersistenceRegistry(root); registries.push(registry); return { root, registry }; };
    const server = () => ({ id: "postgres", driver: "postgresql", host: "db.example.com", credentialsRef: { slot: "vault", path: "persistence/postgres" }, expectedRevision: 0, idempotencyKey: randomUUID() });
    afterEach(async () => { for (const registry of registries.splice(0)) await registry.closeAsync(); });
    it("seeds local/default, protects startup registrations and persists changes across restart", async () => {
        const { root, registry } = create();
        expect(await registry.getServerAsync("local", context)).toMatchObject({ driver: "sqlite", managed: true });
        expect(await registry.getDatabaseAsync("default", context)).toMatchObject({ serverId: "local", managed: true });
        await expect(registry.registerServerAsync({ ...server(), id: "local", expectedRevision: 1 }, context)).rejects.toMatchObject({ code: "policy_denied" });
        const input = server(), saved = await registry.registerServerAsync(input, context);
        expect(await registry.registerServerAsync(input, context)).toEqual(saved);
        await expect(registry.registerServerAsync({ ...input, host: "other.example.com" }, context)).rejects.toMatchObject({ code: "idempotency_conflict" });
        await expect(registry.registerServerAsync({ ...input, idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "revision_conflict" });
        await registry.registerDatabaseAsync({ id: "remote", serverId: input.id, name: "documents", expectedRevision: 0, idempotencyKey: randomUUID() }, context);
        await registry.closeAsync();
        const reopened = create(root).registry;
        expect(await reopened.getServerAsync("postgres", context)).toEqual(saved);
        expect((await reopened.getDatabaseAsync("remote", context)).name).toBe("documents");
        expect(readFileSync(join(root, "connections.sqlite")).includes(Buffer.from("persistence/postgres"))).toBe(true);
    });
    it("rejects raw credentials, URLs, unknown reference fields and absent servers", async () => {
        const { registry } = create();
        for (const extra of [{ password: "never-store-me" }, { connectionString: "postgres://user:secret@host/db" }, { host: "user:secret@host" }, { credentialsRef: { slot: "vault", path: "persistence/db", password: "secret" } }]) {
            await expect(registry.registerServerAsync({ ...server(), ...extra }, context)).rejects.toMatchObject({ code: "invalid_request" });
        }
        await expect(registry.registerDatabaseAsync({ id: "missing", serverId: "absent", name: "db", expectedRevision: 0, idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "not_found" });
    });
    it("binds encrypted pagination to filters and store subject", async () => {
        const { registry } = create();
        await registry.registerServerAsync(server(), context);
        const page = await registry.listServersAsync({ limit: 1 }, context);
        expect(page.nextCursor).toBeTruthy();
        expect((await registry.listServersAsync({ cursor: page.nextCursor }, context)).items).toHaveLength(1);
        await expect(registry.listServersAsync({ cursor: page.nextCursor }, { subject: "other" })).rejects.toMatchObject({ code: "invalid_request" });
        await expect(registry.listDatabasesAsync({ cursor: page.nextCursor }, context)).rejects.toMatchObject({ code: "invalid_request" });
    });
    it("resolves latest and pinned secret versions and enforces slot/prefix boundaries", async () => {
        const store = new MemoryVaultStore();
        const resolver = new VaultCredentialsResolver(new Map([["vault", store]]));
        const reference = { slot: "vault", path: "persistence/postgres" };
        await store.writeAsync({ path: reference.path, content: { kind: "keys", data: { password: "first" } } });
        await store.writeAsync({ path: reference.path, content: { kind: "keys", data: { password: "second" } } });
        expect((await resolver.resolveAsync(reference)).version).toBe(2);
        expect((await resolver.resolveAsync({ ...reference, version: 1 })).version).toBe(1);
        await expect(resolver.resolveAsync({ ...reference, slot: "other" })).rejects.toMatchObject({ code: "policy_denied" });
        await expect(resolver.resolveAsync({ ...reference, path: "persistence-evil/db" })).rejects.toMatchObject({ code: "policy_denied" });
        await store.closeAsync();
    });
});
