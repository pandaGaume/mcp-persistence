import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpClient, McpServerBuilder, type IMcpServer } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";
import { SqlitePersistenceStore, SqlitePersistenceRegistry, PersistenceBehavior, PersistenceSlotStore, PERSISTENCE_TOOLS, buildPersistenceDeclaration, createArtifactTransferServer } from "../src/index.js";
import { validateSlotClient } from "./protocol.validator.js";
import { describePersistenceStoreConformance } from "../src/conformance/persistence.conformance.js";

describe("persistence through a real broker", () => {
    let broker: ITestBroker, disk: SqlitePersistenceStore, server: IMcpServer;
    let registry: SqlitePersistenceRegistry;
    let http: ReturnType<typeof createArtifactTransferServer>, transferUrl: string;
    let writer: PersistenceSlotStore, reader: PersistenceSlotStore, foreign: PersistenceSlotStore;
    const clients: McpClient[] = [];
    const context = { subject: "client-supplied-value-is-ignored" };
    let writerClient: McpClient;
    const root = "/site1/persistence";
    async function as(name: string): Promise<PersistenceSlotStore> {
        const client = new McpClient({ name, version: "1" }, new StreamableHttpTransport(broker.mcpUrl("persistence"), { headers: broker.bearer(name) }), 5000);
        await client.connect(); clients.push(client); if (name === "writer") writerClient = client;
        return new PersistenceSlotStore("persistence", validateSlotClient(client), { baseUrl: transferUrl, headers: () => broker.bearer(name) });
    }
    beforeAll(async () => {
        broker = await startTestBroker({
            callers: { writer: { groups: ["writers"] }, reader: { groups: ["readers"] }, foreign: { groups: ["foreign"] } },
            providers: { persistence: { subjects: ["service:persistence"], allowedResources: [`${root}/**`] } },
            policy: {
                slotResources: { persistence: root },
                roles: { caller: { capabilities: ["mcp.tools.list", "mcp.tools.call", "mcp.resources.read"] }, writer: { capabilities: ["persistence.read", "persistence.write", "persistence.delete"] }, reader: { capabilities: ["persistence.read"] } },
                assignments: [
                    ...["writers", "readers", "foreign"].map(group => ({ id: `${group}-slot`, subject: `group:${group}`, role: "caller", resource: root })),
                    { id: "writers-docs", subject: "group:writers", role: "writer", resource: `${root}/namespaces/explorer/**` },
                    { id: "readers-docs", subject: "group:readers", role: "reader", resource: `${root}/namespaces/explorer/**` },
                ],
            },
        });
        disk = new SqlitePersistenceStore({ directory: mkdtempSync(join(tmpdir(), "mcp-persistence-broker-")), allowFileSyncOnly: process.platform === "win32" });
        registry = new SqlitePersistenceRegistry(disk.directory);
        const transport = new DirectTransport(broker.providerUrl("persistence"), { secret: broker.providerSecret("persistence") });
        server = new McpServerBuilder().withName("persistence").withTransport(transport).register(new PersistenceBehavior(disk, new BrokerAccessGuard(transport.broker), { namespace: root, registry })).build();
        await server.start(); expect((await transport.broker.declare(buildPersistenceDeclaration({ version: "1", namespace: root }))).accepted).toBe(true);
        http = createArtifactTransferServer({ store: disk, brokerMcpUrl: broker.mcpUrl("persistence") });
        await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
        transferUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
        writer = await as("writer"); reader = await as("reader"); foreign = await as("foreign");
    });
    afterAll(async () => {
        for (const client of clients) client.disconnect();
        if (http) await new Promise<void>(resolve => http.close(() => resolve()));
        await server?.stop?.(); await registry?.closeAsync(); await disk?.closeAsync(); await broker?.stop();
    });
    describePersistenceStoreConformance("remote contract", () => writer, context);
    it("filters lists and protects revisions without trusting client subject", async () => {
        expect((await foreign.listAsync({ namespace: "explorer" }, context)).items).toEqual([]);
        const doc = (await writer.listAsync({ namespace: "explorer" }, context)).items[0]!;
        expect(doc).toBeTruthy();
        await expect(foreign.getAsync(doc, { subject: "writer" })).rejects.toMatchObject({ code: "policy_denied" });
        await expect(foreign.listRevisionsAsync(doc, context)).rejects.toMatchObject({ code: "policy_denied" });
        await expect(reader.deleteAsync({ namespace: doc.namespace, id: doc.id, expectedRevision: doc.revision, idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "policy_denied" });
        await expect(writer.putAsync({ namespace: "other", id: "denied", kind: "checkpoint", schemaVersion: "1", payload: {}, expectedRevision: 0, references: [], idempotencyKey: randomUUID() }, context)).rejects.toMatchObject({ code: "policy_denied" });
    });
    it("streams bytes outside MCP and rechecks download permissions", async () => {
        const data = Buffer.alloc(512 * 1024, 7);
        const upload = await writer.beginArtifactAsync({ namespace: "explorer", mimeType: "application/octet-stream", size: data.length, hash: { algorithm: "sha256", value: createHash("sha256").update(data).digest("hex") }, provenance: { capture: "one" }, idempotencyKey: randomUUID() }, context);
        async function* chunks() { for (let i = 0; i < data.length; i += 8192) yield data.subarray(i, i + 8192); }
        await expect(reader.writeArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, bytes: chunks() }, context)).rejects.toMatchObject({ code: "policy_denied" });
        await writer.writeArtifactAsync({ namespace: "explorer", uploadId: upload.uploadId, bytes: chunks() }, context);
        const finish = { namespace: "explorer", uploadId: upload.uploadId, idempotencyKey: randomUUID() };
        const metadata = await writer.commitArtifactAsync(finish, context);
        expect(await writer.commitArtifactAsync(finish, context)).toEqual(metadata);
        const received: Buffer[] = []; for await (const chunk of await reader.readArtifactAsync(metadata, context)) received.push(Buffer.from(chunk));
        expect(Buffer.concat(received)).toEqual(data);
        await expect(foreign.readArtifactAsync(metadata, context)).rejects.toMatchObject({ code: "policy_denied" });
        expect((await fetch(`${transferUrl}/artifacts/explorer/${metadata.id}`)).status).toBe(403);
        expect(JSON.stringify(await writer.getArtifactAsync(metadata, context))).not.toContain("base64");
    });
    it("publishes resource templates, resources and grammar keys", async () => {
        const tools = await writerClient.listTools();
        expect(tools.map(t => t.name).sort()).toEqual(PERSISTENCE_TOOLS.map(t => t.name).sort());
        for (const tool of tools) {
            const contract = PERSISTENCE_TOOLS.find(t => t.name === tool.name)!;
            expect(tool.inputSchema).toEqual(contract.inputSchema);
            expect(tool.outputSchema).toEqual(contract.outputSchema);
        }
        expect((await writerClient.listResourceTemplates()).length).toBe(7);
        const doc = (await writer.listAsync({ namespace: "explorer" }, context)).items[0]!;
        const resource = await writerClient.readResource(`persistence://documents/explorer/${doc.id}`);
        expect(JSON.stringify(resource)).toContain(doc.id);
        const behavior = new PersistenceBehavior(disk, { async authorizeAsync(checks) { return checks.map(() => ({ allowed: false, reason: "test" })); }, report() {} }, { namespace: root });
        expect(behavior.listGrammarKeys()).toContain("default:fr");
    });
});
