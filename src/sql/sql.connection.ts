import { Client } from "pg";
import { createConnection } from "mysql2/promise";
import type { IRegisteredDatabase, IRegisteredServer } from "../contract/configuration.types.js";
import type { ICredentialsResolver } from "../vault/credentials.resolver.js";
import { fail, text } from "../contract/validation.js";

export interface ISqlSession {
    query(sql: string, values?: readonly (string | number | boolean | null)[]): Promise<Record<string, unknown>[]>;
    close(): Promise<void>;
}
export interface ISqlTarget {
    driver: "postgresql" | "mysql";
    host: string;
    port: number;
    /** Operator setting only. MCP arguments cannot disable TLS. */
    allowPlaintext?: boolean;
}
export type SqlConnect = () => Promise<ISqlSession>;

/** Values are bound, identifiers are fixed by the backend, driver errors never leave this boundary. */
export function sqlConnector(server: IRegisteredServer, database: IRegisteredDatabase, vault: ICredentialsResolver, targets: readonly ISqlTarget[]): SqlConnect {
    const driver = server.driver;
    if (driver !== "postgresql" && driver !== "mysql") fail("unsupported_format", "No storage backend for this driver");
    const host = server.host, port = server.port ?? (driver === "postgresql" ? 5432 : 3306);
    const target = targets.find(t => t.driver === driver && t.host === host && t.port === port);
    if (!host || !target) fail("policy_denied", "Database endpoint is outside the operator allowlist");
    const reference = database.credentialsRef ?? server.credentialsRef;
    if (!reference) fail("invalid_request", "The database requires a vault credentials reference");
    return async () => {
        const entry = await vault.resolveAsync(reference);
        if (entry.content.kind !== "keys") fail("invalid_request", "Database credentials must be vault keys");
        const data = entry.content.data;
        const user = text(data.username, 256), password = text(data.password, 16384);
        const ca = data.ca === undefined ? undefined : text(data.ca, 262144);
        const ssl = target.allowPlaintext ? undefined : { rejectUnauthorized: true, verifyIdentity: true, minVersion: "TLSv1.2" as const, ...(ca ? { ca } : {}) };
        if (driver === "postgresql") {
            const client = new Client({ host, port, database: database.name, user, password, ssl: ssl ?? false, connectionTimeoutMillis: 15000 });
            client.on("error", () => {});
            try { await client.connect(); }
            catch { await client.end().catch(() => {}); fail("store_unavailable", "PostgreSQL connection failed"); }
            return {
                async query(sql, values = []) {
                    let index = 0;
                    return (await client.query(sql.replace(/\?/g, () => `$${++index}`), [...values])).rows as Record<string, unknown>[];
                },
                async close() { await client.end(); },
            };
        }
        try {
            const client = await createConnection({ host, port, database: database.name, user, password, ssl, connectTimeout: 15000, multipleStatements: false, charset: "utf8mb4" });
            return {
                async query(sql, values = []) {
                    const [rows] = values.length ? await client.execute(sql, [...values]) : await client.query(sql);
                    return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
                },
                async close() { await client.end(); },
            };
        } catch { fail("store_unavailable", "MySQL connection failed"); }
    };
}
