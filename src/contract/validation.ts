import { createHash } from "node:crypto";
import { PersistenceError } from "./errors.js";

export function fail(code: ConstructorParameters<typeof PersistenceError>[0], message: string): never {
    throw new PersistenceError(code, message);
}
export function segment(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(value)) fail("invalid_request", "Invalid resource segment");
    return value;
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("invalid_request", "Invalid integer");
    return value;
}
export function text(value: unknown, max = 256): string {
    if (typeof value !== "string" || !value.length || value.length > max) fail("invalid_request", "Invalid string");
    return value;
}
export function canonical(value: unknown): string {
    let nodes = 0;
    const seen = new Set<object>();
    function visit(v: unknown, depth: number): unknown {
        if (++nodes > 100_000 || depth > 64) fail("invalid_request", "JSON is too complex");
        if (v === null || typeof v === "boolean" || typeof v === "string") return v;
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v !== "object" || seen.has(v)) fail("invalid_request", "Expected finite, acyclic JSON");
        if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail("invalid_request", "Expected plain JSON");
        seen.add(v);
        const out = Array.isArray(v) ? v.map(x => visit(x, depth + 1)) : Object.fromEntries(Object.keys(v).sort().map(k => [k, visit((v as Record<string, unknown>)[k], depth + 1)]));
        seen.delete(v);
        return out;
    }
    return JSON.stringify(visit(value, 0));
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
