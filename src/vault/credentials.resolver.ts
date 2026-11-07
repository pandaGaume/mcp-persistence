import { McpClient } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { VaultSlotStore, type ISecretEntry, type ISecretStore } from "@cyanmycelium/mcp-vault";
import type { IVaultSecretReference } from "../contract/configuration.types.js";
import { fail, segment, text } from "../contract/validation.js";
import { vaultReference } from "../configuration/validation.js";

export interface ICredentialsResolver {
    /** Trusted internal API. Content stays transient and must never enter MCP results or registry rows. */
    resolveAsync(reference: IVaultSecretReference, signal?: AbortSignal): Promise<ISecretEntry>;
}
export interface IVaultResolverOptions { prefixes?: readonly string[] }

export class VaultCredentialsResolver implements ICredentialsResolver {
    private readonly prefixes: readonly string[];
    constructor(private readonly stores: ReadonlyMap<string, Pick<ISecretStore, "readAsync">>, options: IVaultResolverOptions = {}) {
        this.prefixes = [...(options.prefixes ?? ["persistence"])];
        if (!this.prefixes.length || this.prefixes.length > 16) fail("invalid_request", "Configure 1 to 16 vault path prefixes");
        for (const prefix of this.prefixes) vaultReference({ slot: "vault", path: prefix });
    }
    async resolveAsync(input: IVaultSecretReference, signal?: AbortSignal): Promise<ISecretEntry> {
        const reference = vaultReference(input);
        const store = this.stores.get(reference.slot);
        if (!store || !this.prefixes.some(p => reference.path === p || reference.path.startsWith(`${p}/`))) fail("policy_denied", "Vault reference is outside the configured boundary");
        signal?.throwIfAborted();
        try { return await store.readAsync({ path: reference.path, ...(reference.version === undefined ? {} : { version: reference.version }) }, signal); }
        catch (error) {
            const code = (error as { code?: string }).code;
            if (code === "policy_denied" || code === "authorization_unavailable") fail("policy_denied", "Vault access refused");
            if (code === "not_found") fail("not_found", "Referenced vault secret not found");
            fail("store_unavailable", "Vault credentials could not be resolved");
        }
    }
}

/** Uses a separate authenticated MCP client identity after the provider connects to the broker. */
export class BrokerVaultCredentialsResolver implements ICredentialsResolver {
    private client?: McpClient;
    private connecting?: Promise<McpClient>;
    private readonly resolver: VaultCredentialsResolver;
    private closed = false;

    constructor(private readonly options: { brokerUrl: string; token: () => string; slot?: string; prefixes?: readonly string[] }) {
        const base = new URL(options.brokerUrl);
        if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) fail("invalid_request", "Vault broker must be an HTTPS origin or loopback HTTP");
        const slot = segment(options.slot ?? "vault");
        if (slot.startsWith("_")) fail("invalid_request", "Vault must have a dedicated provider slot");
        const store = new VaultSlotStore(slot, { callTool: async (name, args) => {
            const client = await this.connected();
            try { return await client.callTool(name, args); }
            catch { client.disconnect(); if (this.client === client) this.client = undefined; fail("store_unavailable", "Vault MCP request failed"); }
        } });
        this.resolver = new VaultCredentialsResolver(new Map([[slot, store]]), { prefixes: options.prefixes });
    }
    private connected(): Promise<McpClient> {
        if (this.closed) fail("busy", "Vault resolver is closed");
        if (this.client) return Promise.resolve(this.client);
        this.connecting ??= (async () => {
            const token = text(this.options.token(), 16384);
            if (/\s/.test(token)) fail("invalid_request", "Invalid vault client bearer");
            const url = new URL(`/${segment(this.options.slot ?? "vault")}/mcp`, this.options.brokerUrl);
            const client = new McpClient({ name: "mcp-persistence-vault", version: "1" }, new StreamableHttpTransport(url.toString(), { headers: { Authorization: `Bearer ${token}` } }), 15000);
            try {
                await client.connect();
                if (this.closed) { client.disconnect(); fail("busy", "Vault resolver is closed"); }
                this.client = client; return client;
            } catch { client.disconnect(); fail("store_unavailable", "Vault client could not connect to the broker"); }
        })().finally(() => { this.connecting = undefined; });
        return this.connecting;
    }
    resolveAsync(reference: IVaultSecretReference, signal?: AbortSignal): Promise<ISecretEntry> { return this.resolver.resolveAsync(reference, signal); }
    async closeAsync(): Promise<void> { this.closed = true; this.client?.disconnect(); this.client = undefined; await this.connecting?.catch(() => {}); }
}
