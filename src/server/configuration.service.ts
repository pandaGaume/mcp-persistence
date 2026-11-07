import type { IMcpRequestContext } from "@cyanmycelium/mcp-core";
import type { IAccessCheck, IAccessDecision, IAccessGuard } from "@cyanmycelium/mcp-uns";
import type { ICheckCredentials, ICredentialsCheck, IListDatabases, IPersistenceRegistry } from "../contract/configuration.types.js";
import type { IPageRequest, IStoreContext } from "../contract/persistence.types.js";
import type { ICredentialsResolver } from "../vault/credentials.resolver.js";
import { PersistenceError } from "../contract/errors.js";
import { fail, segment } from "../contract/validation.js";
import { registerDatabase, registerServer } from "../configuration/validation.js";
import { PersistenceResources } from "./declaration.js";

export class PersistenceConfigurationService {
    private readonly paths: PersistenceResources;
    private readonly context: IStoreContext = { subject: "broker-namespace" };
    constructor(private readonly registry: IPersistenceRegistry, private readonly guard: IAccessGuard, root: string, private readonly vault?: ICredentialsResolver) { this.paths = new PersistenceResources(root); }
    private check(kind: "server" | "database", id: string, capability = "read"): IAccessCheck {
        return { capability: `persistence.${capability}`, resource: `persistence:${kind}:${segment(id)}`, resourcePath: this.paths[kind](id) };
    }
    private async decisions(checks: IAccessCheck[], request?: IMcpRequestContext): Promise<IAccessDecision[]> {
        const decisions = await this.guard.authorizeAsync(checks, request);
        if (decisions.length !== checks.length) fail("policy_denied", "Incomplete configuration authorization");
        return decisions;
    }
    private async authorized<T>(checks: IAccessCheck[], request: IMcpRequestContext | undefined, action: () => Promise<T>): Promise<T> {
        const decisions = await this.decisions(checks, request);
        if (decisions.some(d => !d.allowed || d.constraints)) {
            for (const d of decisions) if (d.allowed) this.guard.report(d, "refused", "policy_denied");
            fail("policy_denied", "Configuration access refused");
        }
        try { const result = await action(); for (const d of decisions) this.guard.report(d, "success"); return result; }
        catch (error) { for (const d of decisions) this.guard.report(d, "failure", error instanceof PersistenceError ? error.code : "store_unavailable"); throw error; }
    }
    async invoke(name: string, args: Record<string, unknown>, request?: IMcpRequestContext): Promise<unknown> {
        switch (name) {
            case "server.register": {
                const input = registerServer(args);
                return this.authorized([this.check("server", input.id, "configure")], request, () => this.registry.registerServerAsync(input, this.context));
            }
            case "database.register": {
                const input = registerDatabase(args);
                return this.authorized([this.check("database", input.id, "configure"), this.check("server", input.serverId)], request, () => this.registry.registerDatabaseAsync(input, this.context));
            }
            case "server.get": return this.authorized([this.check("server", segment(args.id))], request, () => this.registry.getServerAsync(segment(args.id), this.context));
            case "database.get": return this.authorized([this.check("database", segment(args.id))], request, () => this.registry.getDatabaseAsync(segment(args.id), this.context));
            case "server.list": {
                const page = await this.registry.listServersAsync(args as IPageRequest, this.context);
                const decisions = await this.decisions(page.items.map(item => this.check("server", item.id)), request);
                return { ...page, items: page.items.filter((_, i) => decisions[i]?.allowed && !decisions[i]?.constraints) };
            }
            case "database.list": {
                const page = await this.registry.listDatabasesAsync(args as IListDatabases, this.context);
                const decisions = await this.decisions(page.items.map(item => this.check("database", item.id)), request);
                return { ...page, items: page.items.filter((_, i) => decisions[i]?.allowed && !decisions[i]?.constraints) };
            }
            case "credentials.check": {
                const input = args as unknown as ICheckCredentials;
                if (input.target !== "server" && input.target !== "database") fail("invalid_request", "Invalid credentials target");
                const id = segment(input.id);
                return this.authorized([this.check(input.target, id, "configure")], request, async (): Promise<ICredentialsCheck> => {
                    const target = input.target === "server" ? await this.registry.getServerAsync(id, this.context) : await this.registry.getDatabaseAsync(id, this.context);
                    let reference = target.credentialsRef, source = input.target;
                    if (!reference && "serverId" in target) { reference = (await this.registry.getServerAsync(target.serverId, this.context)).credentialsRef; source = "server"; }
                    if (!reference) return { target: input.target, id, available: false };
                    if (!this.vault) fail("unsupported_format", "Configure the vault service identity before resolving credentials");
                    const entry = await this.vault.resolveAsync(reference);
                    return { target: input.target, id, available: true, source, credentialsRef: reference, version: entry.version, kind: entry.content.kind };
                });
            }
            default: fail("invalid_request", "Unknown configuration tool");
        }
    }
}
