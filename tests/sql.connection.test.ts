import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pg: vi.fn(), mysql: vi.fn(), connect: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({ Client: class { constructor(options: unknown) { mocks.pg(options); } on() {} connect = mocks.connect; end = mocks.end; } }));
vi.mock("mysql2/promise", () => ({ createConnection: mocks.mysql }));
import { sqlConnector } from "../src/sql/sql.connection.js";
import type { ICredentialsResolver } from "../src/vault/credentials.resolver.js";

describe("SQL credential and TLS boundary", () => {
    const metadata = { revision: 1, managed: false, createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z" };
    const database = { id: "db", name: "documents", serverId: "server", ...metadata };
    const ref = { slot: "vault", path: "persistence/db" };
    const canary = "credential-canary-do-not-return";
    const resolve = vi.fn<ICredentialsResolver["resolveAsync"]>();
    const vault = { resolveAsync: resolve };
    beforeEach(() => {
        vi.clearAllMocks(); mocks.connect.mockResolvedValue(undefined); mocks.end.mockResolvedValue(undefined);
        mocks.mysql.mockResolvedValue({ end: mocks.end });
        resolve.mockResolvedValue({ path: ref.path, version: 1, createdTime: metadata.createdAt, content: { kind: "keys", data: { username: "service", password: canary, host: "attacker.example", port: 1234 } } });
    });
    it("refuses an unapproved endpoint before resolving or sending a secret", () => {
        expect(() => sqlConnector({ id: "server", driver: "postgresql", host: "unapproved.example", credentialsRef: ref, ...metadata }, database, vault, [])).toThrow("operator allowlist");
        expect(resolve).not.toHaveBeenCalled(); expect(mocks.pg).not.toHaveBeenCalled();
    });
    for (const driver of ["postgresql", "mysql"] as const) {
        it(`${driver} verifies TLS by default and ignores destination overrides in secrets`, async () => {
            const port = driver === "postgresql" ? 5432 : 3306;
            const session = await sqlConnector({ id: "server", driver, host: "approved.example", port, credentialsRef: ref, ...metadata }, database, vault, [{ driver, host: "approved.example", port }])();
            const options = (driver === "postgresql" ? mocks.pg : mocks.mysql).mock.calls[0]![0];
            expect(options).toMatchObject({ host: "approved.example", port, database: "documents", user: "service", password: canary, ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2" } });
            if (driver === "mysql") expect(options.ssl.verifyIdentity).toBe(true);
            await session.close(); expect(mocks.end).toHaveBeenCalled();
        });
        it(`${driver} sanitizes authentication errors that contain a secret`, async () => {
            mocks.connect.mockRejectedValue(new Error(canary)); mocks.mysql.mockRejectedValue(new Error(canary));
            const port = driver === "postgresql" ? 5432 : 3306;
            const connect = sqlConnector({ id: "server", driver, host: "approved.example", port, credentialsRef: ref, ...metadata }, database, vault, [{ driver, host: "approved.example", port }]);
            await expect(connect()).rejects.toMatchObject({ code: "store_unavailable", message: driver === "postgresql" ? "PostgreSQL connection failed" : "MySQL connection failed" });
        });
    }
});
