import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpClient, McpServerBuilder, type IMcpServer } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";
import { MemoryVaultStore, VaultBehavior, VaultKeyPair, VaultSlotStore, buildVaultDeclaration } from "@cyanmycelium/mcp-vault";
import { BrokerVaultCredentialsResolver, PersistenceDatabaseRouter, PersistenceBehavior, PersistenceSlotStore, SqlitePersistenceRegistry, SqlitePersistenceStore, buildPersistenceDeclaration, sqlConnector, type ISqlTarget } from "../src/index.js";
import { validateSlotClient } from "./protocol.validator.js";

describe("registry and sealed vault through a real broker", () => {
    let broker: ITestBroker, disk: SqlitePersistenceStore, registry: SqlitePersistenceRegistry, credentials: BrokerVaultCredentialsResolver;
    let operator: PersistenceSlotStore, reader: PersistenceSlotStore, stranger: PersistenceSlotStore, vault: VaultSlotStore;
    let router: PersistenceDatabaseRouter;
    const servers: IMcpServer[] = [], clients: McpClient[] = [], wire: unknown[] = [];
    const root = "/site1/persistence", vaultRoot = "/site1/vault", context = { subject: "ignored" };
    const secret = `canary-${randomUUID()}`;
    const targets: ISqlTarget[] = [];
    const connection = (name: string, slot: string) => {
        const client = new McpClient({ name, version: "1" }, new StreamableHttpTransport(broker.mcpUrl(slot), { headers: broker.bearer(name) }), 15000);
        clients.push(client); return client;
    };
    beforeAll(async () => {
        broker = await startTestBroker({
            callers: { operator: { groups: ["operators"] }, reader: { groups: ["readers"] }, stranger: { groups: ["strangers"] }, "persistence-vault": { groups: ["persistence-services"] } },
            providers: { persistence: { subjects: ["service:persistence"], allowedResources: [`${root}/**`] }, vault: { subjects: ["service:vault"], allowedResources: [`${vaultRoot}/**`] } },
            policy: {
                slotResources: { persistence: root, vault: vaultRoot },
                roles: {
                    mcp: { capabilities: ["mcp.tools.list", "mcp.tools.call", "mcp.resources.read"] },
                    operator: { capabilities: ["persistence.read", "persistence.write", "persistence.delete", "persistence.admin", "persistence.configure"] },
                    reader: { capabilities: ["persistence.read"] },
                    vaultOwner: { capabilities: ["vault.read", "vault.write", "vault.share"] }, vaultReader: { capabilities: ["vault.read"] },
                },
                assignments: [
                    ...["operators", "readers", "strangers"].map(group => ({ id: `mcp-${group}`, subject: `group:${group}`, role: "mcp", resource: root })),
                    { id: "operator-data", subject: "group:operators", role: "operator", resource: `${root}/**` },
                    { id: "reader-data", subject: "group:readers", role: "reader", resource: `${root}/**` },
                    { id: "vault-owner-mcp", subject: "group:operators", role: "mcp", resource: vaultRoot },
                    { id: "vault-owner", subject: "group:operators", role: "vaultOwner", resource: `${vaultRoot}/**` },
                    { id: "vault-service-mcp", subject: "group:persistence-services", role: "mcp", resource: vaultRoot },
                    { id: "vault-service", subject: "group:persistence-services", role: "vaultReader", resource: `${vaultRoot}/audiences/persistence` },
                ],
            },
        });
        const memory = new MemoryVaultStore();
        const vt = new DirectTransport(broker.providerUrl("vault"), { secret: broker.providerSecret("vault") });
        const vs = new McpServerBuilder().withName("vault").withTransport(vt).register(new VaultBehavior(memory, new BrokerAccessGuard(vt.broker), { keyPair: VaultKeyPair.generate(), namespace: vaultRoot })).build();
        servers.push(vs); await vs.start(); expect((await vt.broker.declare(buildVaultDeclaration({ version: "1", namespace: vaultRoot }))).accepted).toBe(true);
        const vc = connection("operator", "vault"); await vc.connect();
        vault = new VaultSlotStore("vault", { async callTool(name, args) { wire.push(args); const result = await vc.callTool(name, args); wire.push(result); return result; } });
        await vault.writeAsync({ path: "persistence/canary", content: { kind: "keys", data: { username: "test", password: secret } } });
        await vault.shareAsync({ path: "persistence/canary", audiences: ["persistence"] });
        disk = new SqlitePersistenceStore({ directory: mkdtempSync(join(tmpdir(), "persistence-config-broker-")), allowFileSyncOnly: process.platform === "win32" });
        registry = new SqlitePersistenceRegistry(disk.directory);
        credentials = new BrokerVaultCredentialsResolver({ brokerUrl: new URL(broker.mcpUrl("vault")).origin, token: () => "persistence-vault" });
        router = new PersistenceDatabaseRouter(registry, credentials, targets);
        const pt = new DirectTransport(broker.providerUrl("persistence"), { secret: broker.providerSecret("persistence") });
        const ps = new McpServerBuilder().withName("persistence").withTransport(pt).register(new PersistenceBehavior(disk, new BrokerAccessGuard(pt.broker), { namespace: root, registry, credentials, databases: { resolveAsync: id => router.resolveAsync(id) } })).build();
        servers.push(ps); await ps.start(); expect((await pt.broker.declare(buildPersistenceDeclaration({ version: "2", namespace: root }))).accepted).toBe(true);
        const pc = connection("operator", "persistence"), rc = connection("reader", "persistence"), sc = connection("stranger", "persistence");
        await Promise.all([pc.connect(), rc.connect(), sc.connect()]);
        operator = new PersistenceSlotStore("persistence", validateSlotClient(pc)); reader = new PersistenceSlotStore("persistence", rc); stranger = new PersistenceSlotStore("persistence", sc);
    });
    afterAll(async () => { for (const c of clients) c.disconnect(); for (const server of servers.reverse()) await server.stop?.(); await credentials?.closeAsync(); await registry?.closeAsync(); await disk?.closeAsync(); await broker?.stop(); });
    const serverInput = (id: string, extra = {}) => ({ id, driver: "postgresql", host: "127.0.0.1", credentialsRef: { slot: "vault", path: "persistence/canary" }, expectedRevision: 0, idempotencyKey: randomUUID(), ...extra });
    const put = (databaseId: string | undefined, id = randomUUID(), expectedRevision = 0) => ({ ...(databaseId ? { databaseId } : {}), namespace: "explorer", id, expectedRevision, kind: "checkpoint", schemaVersion: "1", payload: { saved: "in-selected-database" }, references: [], idempotencyKey: randomUUID() });

    it("keeps the local startup default usable without credentials", async () => {
        expect(await operator.getServerAsync("local", context)).toMatchObject({ driver: "sqlite", managed: true });
        expect(await operator.getDatabaseAsync("default", context)).toMatchObject({ serverId: "local", managed: true });
        expect(await operator.checkCredentialsAsync({ target: "database", id: "default" }, context)).toEqual({ target: "database", id: "default", available: false });
        const request = put(undefined); await operator.putAsync(request, context);
        expect((await operator.getAsync({ ...request, databaseId: "default" }, context)).revision).toBe(1);
    });
    it("stores only references, inherits database credentials and filters unauthorized metadata", async () => {
        await operator.registerServerAsync(serverInput("generic"), context);
        await operator.registerDatabaseAsync({ id: "generic-db", serverId: "generic", name: "documents", expectedRevision: 0, idempotencyKey: randomUUID() }, context);
        const result = await operator.checkCredentialsAsync({ target: "database", id: "generic-db" }, context);
        expect(result).toMatchObject({ available: true, source: "server", version: 1 });
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(wire)).not.toContain(secret);
        for (const file of readdirSync(disk.directory).filter(f => f.startsWith("connections.sqlite"))) expect(readFileSync(join(disk.directory, file)).includes(Buffer.from(secret))).toBe(false);
        expect((await stranger.listServersAsync({}, context)).items).toEqual([]);
        await expect(reader.registerServerAsync(serverInput("denied"), context)).rejects.toMatchObject({ code: "policy_denied" });
        await expect(reader.checkCredentialsAsync({ target: "server", id: "generic" }, context)).rejects.toMatchObject({ code: "policy_denied" });
        await expect(stranger.getServerAsync("generic", context)).rejects.toMatchObject({ code: "policy_denied" });
        await expect(operator.putAsync(put("generic-db"), context)).rejects.toMatchObject({ code: "policy_denied" });
    });
    it("honors secret rotation, pinned versions, audience revocation and prefix boundaries", async () => {
        await vault.writeAsync({ path: "persistence/canary", content: { kind: "keys", data: { username: "test", password: `${secret}-rotated` } } });
        expect((await operator.checkCredentialsAsync({ target: "server", id: "generic" }, context)).version).toBe(2);
        await operator.registerServerAsync(serverInput("pinned", { credentialsRef: { slot: "vault", path: "persistence/canary", version: 1 } }), context);
        expect((await operator.checkCredentialsAsync({ target: "server", id: "pinned" }, context)).version).toBe(1);
        await vault.shareAsync({ path: "persistence/canary", audiences: [] });
        await expect(operator.checkCredentialsAsync({ target: "server", id: "generic" }, context)).rejects.toMatchObject({ code: "policy_denied" });
        await operator.registerServerAsync(serverInput("outside", { credentialsRef: { slot: "vault", path: "other/secret" } }), context);
        await expect(operator.checkCredentialsAsync({ target: "server", id: "outside" }, context)).rejects.toMatchObject({ code: "policy_denied" });
    });

    for (const driver of ["postgresql", "mysql"] as const) {
        const env = driver === "postgresql" ? "PERSISTENCE_TEST_POSTGRES" : "PERSISTENCE_TEST_MYSQL";
        describe.skipIf(!process.env[env])(`${driver} real document storage through broker and vault`, () => {
            const databaseId = `db-${driver}`;
            beforeAll(async () => {
                const config = JSON.parse(process.env[env]!) as { host: string; port: number; database: string; username: string; password: string };
                targets.push({ driver, host: config.host, port: config.port, allowPlaintext: true });
                const path = `persistence/${driver}`;
                await vault.writeAsync({ path, content: { kind: "keys", data: { username: config.username, password: config.password } } });
                await vault.shareAsync({ path, audiences: ["persistence"] });
                await operator.registerServerAsync(serverInput(driver, { driver, host: config.host, port: config.port, credentialsRef: { slot: "vault", path } }), context);
                await operator.registerDatabaseAsync({ id: databaseId, serverId: driver, name: config.database, expectedRevision: 0, idempotencyKey: randomUUID() }, context);
            });
            it("persists remotely, replays mutations, arbitrates concurrency and survives a new router", async () => {
                const request = put(databaseId), first = await operator.putAsync(request, context);
                expect(await operator.putAsync(request, context)).toEqual(first);
                await expect(operator.putAsync({ ...request, payload: {} }, context)).rejects.toMatchObject({ code: "idempotency_conflict" });
                await expect(disk.getAsync(request, context)).rejects.toMatchObject({ code: "not_found" });
                const server = await registry.getServerAsync(driver, context), database = await registry.getDatabaseAsync(databaseId, context);
                const sql = await sqlConnector(server, database, credentials, targets)();
                try { const rows = await sql.query("SELECT document FROM mcp_persistence_revisions WHERE namespace=? AND id=?", [request.namespace, request.id]); expect(JSON.parse(rows[0]!.document as string).payload).toEqual(request.payload); } finally { await sql.close(); }
                const results = await Promise.allSettled([operator.putAsync(put(databaseId, request.id, 1), context), operator.putAsync(put(databaseId, request.id, 1), context)]);
                expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
                expect(results.filter(r => r.status === "rejected")).toMatchObject([{ reason: { code: "revision_conflict" } }]);
                router = new PersistenceDatabaseRouter(registry, credentials, targets);
                expect((await operator.getAsync({ ...request, revision: 1 }, context)).payload).toEqual(first.payload);
                expect((await operator.listRevisionsAsync(request, context)).items).toHaveLength(2);
                const deleted = await operator.deleteAsync({ databaseId, namespace: request.namespace, id: request.id, expectedRevision: 2, idempotencyKey: randomUUID() }, context);
                expect(deleted.deleted).toBe(true);
                await expect(operator.getAsync(request, context)).rejects.toMatchObject({ code: "not_found" });
                expect((await operator.getAsync({ ...request, revision: 1 }, context)).revision).toBe(1);
                await expect(reader.putAsync(put(databaseId), context)).rejects.toMatchObject({ code: "policy_denied" });
            });
            it("keeps pinned references, encrypted pages and never falls back to local storage", async () => {
                const source = put(databaseId), target = await operator.putAsync(source, context);
                const referencing = { ...put(databaseId), references: [{ type: "document" as const, namespace: source.namespace, id: source.id, revision: target.revision }] };
                await operator.putAsync(referencing, context);
                await expect(operator.putAsync({ ...put(databaseId), references: [{ type: "document", namespace: source.namespace, id: "absent", revision: 1 }] }, context)).rejects.toMatchObject({ code: "not_found" });
                const page = await operator.listAsync({ databaseId, namespace: source.namespace, limit: 1 }, context);
                expect(page.nextCursor).toBeTruthy();
                expect((await operator.listAsync({ databaseId, namespace: source.namespace, limit: 1, cursor: page.nextCursor }, context)).items[0]!.id).not.toBe(page.items[0]!.id);
                await expect(operator.listAsync({ databaseId, namespace: "other", cursor: page.nextCursor }, context)).rejects.toMatchObject({ code: "invalid_request" });
                await expect(operator.purgeAsync({ databaseId, namespace: source.namespace, target: { type: "document", id: source.id, revision: 1 }, idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "retention_blocked" });
                await vault.shareAsync({ path: `persistence/${driver}`, audiences: [] });
                const blocked = put(databaseId);
                await expect(operator.putAsync(blocked, context)).rejects.toMatchObject({ code: "policy_denied" });
                await expect(disk.getAsync(blocked, context)).rejects.toMatchObject({ code: "not_found" });
                await vault.shareAsync({ path: `persistence/${driver}`, audiences: ["persistence"] });
            });
            it("uses rotated credentials for every connection and sanitizes driver errors", async () => {
                const config = JSON.parse(process.env[env]!) as { username: string; password: string };
                const path = `persistence/${driver}`, badPassword = `invalid-${randomUUID()}`;
                await vault.writeAsync({ path, content: { kind: "keys", data: { username: config.username, password: badPassword } } });
                const request = put(databaseId);
                try {
                    await expect(operator.putAsync(request, context)).rejects.toMatchObject({ code: "store_unavailable", message: driver === "postgresql" ? "PostgreSQL connection failed" : "MySQL connection failed" });
                    await expect(disk.getAsync(request, context)).rejects.toMatchObject({ code: "not_found" });
                } finally { await vault.writeAsync({ path, content: { kind: "keys", data: { username: config.username, password: config.password } } }); }
                expect((await operator.putAsync(request, context)).revision).toBe(1);
            });
        });
    }
});
