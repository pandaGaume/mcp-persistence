export type PersistenceErrorCode =
    | "not_found" | "revision_conflict" | "idempotency_conflict"
    | "policy_denied" | "quota_exceeded" | "transfer_incomplete"
    | "integrity_error" | "invalid_request" | "unsupported_format"
    | "retention_blocked" | "busy" | "store_unavailable";

export class PersistenceError extends Error {
    constructor(readonly code: PersistenceErrorCode, message: string) {
        super(message);
        this.name = "PersistenceError";
    }
}
