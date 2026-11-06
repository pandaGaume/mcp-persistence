import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { McpClient } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { SqlitePersistenceStore } from "../src/index.js";

async function port(): Promise<number> {
    const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const p = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return p;
}
describe("provider entry point", () => {
    it("fails closed without production credentials", () => {
        const env = { ...process.env }; delete env.MCP_PERSISTENCE_PROVIDER_SECRET;
        const child = spawnSync(process.execPath, ["dist/provider/main.js"], { cwd: process.cwd(), env, encoding: "utf8" });
        expect(child.status).toBe(1); expect(child.stderr).toContain("Production requires"); expect(child.stderr).not.toContain("DEV:");
    });
    it("starts an explicitly open loopback development environment", async () => {
        const brokerPort = await port(), transferPort = await port();
        const devRoot = mkdtempSync(join(tmpdir(), "mcp-persistence-dev-"));
        const child = spawn(process.execPath, ["dist/provider/main.js", "--dev"], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, MCP_PERSISTENCE_BROKER_URL: `http://127.0.0.1:${brokerPort}`, MCP_PERSISTENCE_TRANSFER_PORT: String(transferPort), MCP_PERSISTENCE_DATA: devRoot, MCP_PERSISTENCE_ALLOW_FILE_SYNC_ONLY: process.platform === "win32" ? "1" : "0" } });
        let output = "";
        let client: McpClient | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Dev startup timeout: ${output}`)), 15_000);
                child.stderr.on("data", chunk => { output += String(chunk); if (output.includes("transfer endpoint on loopback")) { clearTimeout(timer); resolve(); } });
                child.once("exit", code => { clearTimeout(timer); reject(new Error(`Dev exited ${code}: ${output}`)); });
            });
            client = new McpClient({ name: "dev-test", version: "1" }, new StreamableHttpTransport(`http://127.0.0.1:${brokerPort}/persistence/mcp`), 5000);
            await client.connect();
            const result = await client.callTool("persistence.put", { namespace: "explorer", id: "dev", expectedRevision: 0, kind: "checkpoint", schemaVersion: "1", payload: {}, references: [], idempotencyKey: "dev-one" });
            expect(result.isError).not.toBe(true); expect(output).toContain("openGuard enabled");
        } finally { client?.disconnect(); child.kill(); if (child.exitCode === null) await once(child, "exit"); }
        const reopened = new SqlitePersistenceStore({ directory: devRoot, allowFileSyncOnly: process.platform === "win32" });
        try { expect((await reopened.getAsync({ namespace: "explorer", id: "dev" }, { subject: "recovery" })).revision).toBe(1); }
        finally { await reopened.closeAsync(); }
    });
});
