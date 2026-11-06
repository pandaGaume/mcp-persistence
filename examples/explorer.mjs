import { randomUUID } from "node:crypto";
import { McpClient } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { PersistenceSlotStore } from "../dist/index.js";

const broker = process.env.MCP_PERSISTENCE_BROKER_URL ?? "http://127.0.0.1:3000";
const token = process.env.MCP_PERSISTENCE_CLIENT_TOKEN;
const headers = () => token ? { Authorization: `Bearer ${token}` } : {};
const client = new McpClient({ name: "explorer-checkpoint", version: "1" }, new StreamableHttpTransport(`${broker}/persistence/mcp`, { headers: headers() }));
try {
    await client.connect();
    const store = new PersistenceSlotStore("persistence", client, { baseUrl: process.env.MCP_PERSISTENCE_TRANSFER_URL ?? "http://127.0.0.1:3001", headers });
    // Local context is not sent as identity. The broker authenticates the MCP transport.
    const context = { subject: "unused-by-remote-store" };
    const checkpoint = await store.putAsync({
        namespace: "explorer", id: randomUUID(), kind: "checkpoint", schemaVersion: "1",
        expectedRevision: 0, idempotencyKey: randomUUID(), references: [],
        payload: { sessionId: "demo", astronomicalDate: "2042-01-01T00:00:00Z", body: "Earth", frame: "ICRF", camera: { position: [0, 0, 10], target: [0, 0, 0] }, projection: "perspective", layers: [], objects: [], selection: [], dataVersions: [] },
    }, context);
    const restored = await store.getAsync({ namespace: checkpoint.namespace, id: checkpoint.id, revision: checkpoint.revision }, context);
    console.log(JSON.stringify({ id: restored.id, revision: restored.revision, sessionId: restored.payload.sessionId }));
} finally { client.disconnect(); }
