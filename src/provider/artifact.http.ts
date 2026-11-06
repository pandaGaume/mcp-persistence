import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { McpClient } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import type { IPersistenceStore } from "../contract/persistence.store.js";
import type { IArtifact } from "../contract/persistence.types.js";
import { PersistenceError } from "../contract/errors.js";
import { segment } from "../contract/validation.js";
import { MCP_STORE_CONTEXT } from "../server/persistence.behavior.js";
import { slotPayload } from "../server/persistence.slot.store.js";

/** Every stream is authorized by a fresh MCP call made with the HTTP caller's bearer. */
export function createArtifactTransferServer(options: { store: IPersistenceStore; brokerMcpUrl: string; dev?: boolean }): Server {
    const server = createServer(async (request, response) => {
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        response.once("close", () => { if (!response.writableFinished) controller.abort(); });
        let client: McpClient | undefined;
        try {
            const path = new URL(request.url ?? "/", "http://localhost").pathname;
            const match = /^\/(uploads|artifacts)\/([^/]+)\/([^/]+)$/.exec(path);
            if (!match || !((match[1] === "uploads" && request.method === "PUT") || (match[1] === "artifacts" && request.method === "GET"))) { response.writeHead(404).end(); return; }
            const namespace = segment(match[2]), id = segment(match[3]);
            const auth = request.headers.authorization;
            if (!options.dev && (!auth || !/^Bearer [^\s]+$/i.test(auth))) throw new PersistenceError("policy_denied", "Bearer authorization required");
            client = new McpClient({ name: "persistence-transfer", version: "0.1.0" }, new StreamableHttpTransport(options.brokerMcpUrl, { headers: auth ? { Authorization: auth } : {} }), 15_000);
            let permission: unknown;
            try {
                await client.connect();
                permission = slotPayload(await client.callTool(match[1] === "uploads" ? "persistence.uploadAccess" : "persistence.getArtifact", { namespace, ...(match[1] === "uploads" ? { uploadId: id } : { id }) }));
            } catch (error) { if (error instanceof PersistenceError) throw error; throw new PersistenceError("policy_denied", "Broker did not authorize transfer"); }
            const context = { ...MCP_STORE_CONTEXT, signal: controller.signal };
            if (match[1] === "uploads") {
                await options.store.writeArtifactAsync({ namespace, uploadId: id, bytes: request }, context);
                response.writeHead(204).end();
            } else {
                const metadata = permission as IArtifact;
                const bytes = await options.store.readArtifactAsync({ namespace, id }, context);
                response.writeHead(200, { "Content-Type": metadata.mimeType, "Content-Length": metadata.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
                await pipeline(Readable.from(bytes), response, { signal: controller.signal });
            }
        } catch (error) {
            if (response.headersSent) response.destroy();
            else {
                const code = error instanceof PersistenceError ? error.code : "store_unavailable";
                const status = code === "policy_denied" ? 403 : code === "not_found" ? 404 : code === "quota_exceeded" ? 413 : ["invalid_request", "transfer_incomplete", "integrity_error"].includes(code) ? 400 : 500;
                response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code, message: "Artifact transfer refused or failed" } }));
            }
        } finally { client?.disconnect(); }
    });
    server.requestTimeout = 30 * 60_000;
    server.headersTimeout = 15_000;
    return server;
}
