import type { IPersistenceRegistry } from "../contract/configuration.types.js";
import type { ICredentialsResolver } from "../vault/credentials.resolver.js";
import { fail, segment } from "../contract/validation.js";
import { SqlDocumentStore, type IDocumentStore } from "./sql.document.store.js";
import { sqlConnector, type ISqlTarget } from "./sql.connection.js";

export interface IDatabaseRouter { resolveAsync(databaseId: string): Promise<IDocumentStore> }
export class PersistenceDatabaseRouter implements IDatabaseRouter {
    private readonly stores = new Map<string, { revision: string; store: SqlDocumentStore }>();
    constructor(private readonly registry: IPersistenceRegistry, private readonly vault: ICredentialsResolver | undefined, private readonly targets: readonly ISqlTarget[]) {}
    async resolveAsync(databaseId: string): Promise<IDocumentStore> {
        const context = { subject: "persistence-service" };
        const database = await this.registry.getDatabaseAsync(segment(databaseId), context);
        const server = await this.registry.getServerAsync(database.serverId, context);
        if (!this.vault) fail("unsupported_format", "Configure the vault service identity before opening a remote database");
        const revision = `${database.revision}:${server.revision}`;
        const cached = this.stores.get(databaseId);
        if (cached?.revision === revision) return cached.store;
        const connector = sqlConnector(server, database, this.vault, this.targets);
        const store = new SqlDocumentStore(server.driver as "postgresql" | "mysql", connector);
        this.stores.set(databaseId, { revision, store }); return store;
    }
}
