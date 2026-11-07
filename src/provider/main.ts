#!/usr/bin/env node
import { McpServerBuilder } from "@cyanmycelium/mcp-core";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { BrokerAccessGuard, openGuard } from "@cyanmycelium/mcp-uns";
import { SqlitePersistenceStore } from "../sqlite/sqlite.persistence.store.js";
import { PersistenceBehavior } from "../server/persistence.behavior.js";
import { buildPersistenceDeclaration } from "../server/declaration.js";
import { createArtifactTransferServer } from "./artifact.http.js";
import { integer } from "../contract/validation.js";
import { SqlitePersistenceRegistry } from "../configuration/sqlite.registry.js";
import { BrokerVaultCredentialsResolver } from "../vault/credentials.resolver.js";
import { PersistenceDatabaseRouter } from "../sql/database.router.js";
import type { ISqlTarget } from "../sql/sql.connection.js";

async function main(): Promise<void> {
    const dev = process.argv.includes("--dev");
    if (process.argv.slice(2).some(arg => arg !== "--dev")) throw new Error("Usage: mcp-persistence [--dev]");
    const root = process.env.MCP_PERSISTENCE_RESOURCE_ROOT ?? "/local/persistence";
    const brokerBase = process.env.MCP_PERSISTENCE_BROKER_URL ?? "http://127.0.0.1:3000";
    const brokerUrl = new URL(brokerBase);
    if (!["http:", "https:"].includes(brokerUrl.protocol) || brokerUrl.username || brokerUrl.password || brokerUrl.pathname !== "/" || brokerUrl.search || brokerUrl.hash) throw new Error("Broker URL must be an HTTP(S) origin without credentials");
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(brokerUrl.hostname);
    const secret = process.env.MCP_PERSISTENCE_PROVIDER_SECRET;
    if (!dev && !secret) throw new Error("Production requires MCP_PERSISTENCE_PROVIDER_SECRET; use --dev explicitly for the local open guard");
    if (!dev && brokerUrl.protocol !== "https:" && !loopback) throw new Error("Remote production broker requires HTTPS");
    if (dev && (!loopback || brokerUrl.protocol !== "http:")) throw new Error("--dev requires a loopback HTTP broker");
    let localBroker: { start(): Promise<void>; stop(): Promise<void> } | undefined;
    let server: ReturnType<McpServerBuilder["build"]> | undefined;
    let store: SqlitePersistenceStore | undefined;
    let registry: SqlitePersistenceRegistry | undefined;
    let credentials: BrokerVaultCredentialsResolver | undefined;
    let http: ReturnType<typeof createArtifactTransferServer> | undefined;
    try {
        if (dev) {
            const { WsTunnelBuilder } = await import("@cyanmycelium/mcp-broker");
            localBroker = new WsTunnelBuilder().withHost("127.0.0.1").withPort(Number(brokerUrl.port || 80)).build();
            await localBroker.start();
            console.error("[persistence] DEV: openGuard enabled, loopback only, no access policy. Use a separate data root.");
        }
        store = new SqlitePersistenceStore({ directory: process.env.MCP_PERSISTENCE_DATA ?? (dev ? "./data-dev" : "./data"), allowFileSyncOnly: process.env.MCP_PERSISTENCE_ALLOW_FILE_SYNC_ONLY === "1" });
        registry = new SqlitePersistenceRegistry(store.directory);
        if (process.env.MCP_PERSISTENCE_VAULT_TOKEN) credentials = new BrokerVaultCredentialsResolver({
            brokerUrl: brokerUrl.toString(),
            token: () => process.env.MCP_PERSISTENCE_VAULT_TOKEN ?? "",
            slot: process.env.MCP_PERSISTENCE_VAULT_SLOT ?? "vault",
            prefixes: [process.env.MCP_PERSISTENCE_VAULT_PREFIX ?? "persistence"],
        });
        const ws = new URL("/provider/persistence", brokerUrl); ws.protocol = brokerUrl.protocol === "https:" ? "wss:" : "ws:";
        const transport = new DirectTransport(ws.toString(), dev ? { aggregate: true } : { secret });
        const guard = dev ? openGuard() : new BrokerAccessGuard(transport.broker);
        const targets: ISqlTarget[] = JSON.parse(process.env.MCP_PERSISTENCE_SQL_TARGETS ?? "[]") as ISqlTarget[];
        if (!Array.isArray(targets) || targets.some(t => !t || !["postgresql", "mysql"].includes(t.driver) || typeof t.host !== "string" || !t.host || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535 || (t.allowPlaintext !== undefined && typeof t.allowPlaintext !== "boolean"))) throw new Error("Invalid MCP_PERSISTENCE_SQL_TARGETS operator allowlist");
        const databases = new PersistenceDatabaseRouter(registry, credentials, targets);
        server = new McpServerBuilder().withName("persistence").withTransport(transport).withGrammarResolver(() => `default:${process.env.MCP_PERSISTENCE_LOCALE === "fr" ? "fr" : "en"}`).register(new PersistenceBehavior(store, guard, { namespace: root, registry, credentials, databases })).build();
        await server.start();
        if (!dev) {
            const declaration = await transport.broker.declare(buildPersistenceDeclaration({ version: "1", namespace: root }));
            if (!declaration.accepted) throw new Error("Broker refused the persistence declaration");
        }
        http = createArtifactTransferServer({ store, brokerMcpUrl: new URL("/persistence/mcp", brokerUrl).toString(), dev });
        const port = integer(Number(process.env.MCP_PERSISTENCE_TRANSFER_PORT ?? 3001), 1, 65535);
        await new Promise<void>((resolve, reject) => { http!.once("error", reject); http!.listen(port, "127.0.0.1", resolve); });
        console.error(`[persistence] ${dev ? "DEV" : "broker-authorized"} provider started; transfer endpoint on loopback:${port}`);
        let stopping = false;
        const stop = async () => {
            if (stopping) return; stopping = true;
            try {
                await new Promise<void>(resolve => http!.close(() => resolve()));
                await server?.stop?.(); await credentials?.closeAsync(); await registry?.closeAsync(); await store?.closeAsync(); await localBroker?.stop();
            } catch { console.error("[persistence] Shutdown failed"); process.exitCode = 1; }
        };
        process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
    } catch (error) {
        http?.close(); await server?.stop?.(); await credentials?.closeAsync(); await registry?.closeAsync(); await store?.closeAsync(); await localBroker?.stop(); throw error;
    }
}
main().catch(error => { console.error(`[persistence] ${error instanceof Error && !error.message.includes("\\") ? error.message : "Startup failed"}`); process.exitCode = 1; });
