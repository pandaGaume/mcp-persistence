import { isIP } from "node:net";
import { fail, integer, segment, text } from "../contract/validation.js";
import type { IDatabaseDefinition, IRegisterDatabase, IRegisterServer, IServerDefinition, IVaultSecretReference } from "../contract/configuration.types.js";

export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail("invalid_request", "Unknown configuration field; credentials must be vault references");
    return value as Record<string, unknown>;
}
export function vaultReference(value: unknown): IVaultSecretReference {
    const ref = exact(value, ["slot", "path", "version"]);
    const path = text(ref.path, 512);
    for (const part of path.split("/")) segment(part);
    return { slot: segment(ref.slot), path, ...(ref.version === undefined ? {} : { version: integer(ref.version, 1) }) };
}
export function serverDefinition(value: unknown): IServerDefinition {
    const r = exact(value, ["id", "driver", "host", "port", "credentialsRef", "expectedRevision", "idempotencyKey"]);
    let host: string | undefined;
    if (r.host !== undefined) {
        host = text(r.host, 253);
        if (!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) fail("invalid_request", "Use a hostname or IP address, never a credential-bearing URL");
    }
    return { id: segment(r.id), driver: segment(r.driver), ...(host === undefined ? {} : { host }), ...(r.port === undefined ? {} : { port: integer(r.port, 1, 65535) }), ...(r.credentialsRef === undefined ? {} : { credentialsRef: vaultReference(r.credentialsRef) }) };
}
export function databaseDefinition(value: unknown): IDatabaseDefinition {
    const r = exact(value, ["id", "serverId", "name", "credentialsRef", "expectedRevision", "idempotencyKey"]);
    return { id: segment(r.id), serverId: segment(r.serverId), name: segment(r.name), ...(r.credentialsRef === undefined ? {} : { credentialsRef: vaultReference(r.credentialsRef) }) };
}
export function registerServer(value: unknown): IRegisterServer {
    const d = serverDefinition(value), r = value as Record<string, unknown>;
    return { ...d, expectedRevision: integer(r.expectedRevision), idempotencyKey: text(r.idempotencyKey, 128) };
}
export function registerDatabase(value: unknown): IRegisterDatabase {
    const d = databaseDefinition(value), r = value as Record<string, unknown>;
    return { ...d, expectedRevision: integer(r.expectedRevision), idempotencyKey: text(r.idempotencyKey, 128) };
}
