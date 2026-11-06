import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { IPersistenceStore } from "../contract/persistence.store.js";
import type { IStoreContext } from "../contract/persistence.types.js";

/** Reuse on a direct backend or a PersistenceSlotStore with the same caller privileges. */
export function describePersistenceStoreConformance(name: string, getStore: () => IPersistenceStore, context: IStoreContext = { subject: "conformance" }): void {
    describe(name, () => {
        const namespace = "explorer";
        const put = (id: string, key: string, expectedRevision = 0, payload = { saved: true }) => ({ namespace, id, kind: "checkpoint", schemaVersion: "1", payload, expectedRevision, references: [], idempotencyKey: key });
        it("keeps immutable revisions and rejects a stale write", async () => {
            const store = getStore(), id = randomUUID();
            const first = await store.putAsync(put(id, randomUUID()), context);
            await store.putAsync(put(id, randomUUID(), 1, { saved: false }), context);
            expect((await store.getAsync({ namespace, id, revision: 1 }, context)).payload).toEqual(first.payload);
            await expect(store.putAsync(put(id, randomUUID(), 1), context)).rejects.toMatchObject({ code: "revision_conflict" });
        });
        it("replays a mutation and rejects reuse with different content", async () => {
            const store = getStore(), id = randomUUID(), request = put(id, randomUUID());
            const result = await store.putAsync(request, context);
            expect(await store.putAsync(request, context)).toEqual(result);
            await expect(store.putAsync({ ...request, payload: { saved: false } }, context)).rejects.toMatchObject({ code: "idempotency_conflict" });
            expect((await store.listRevisionsAsync({ namespace, id }, context)).items).toHaveLength(1);
        });
        it("serializes competing writes to the same revision", async () => {
            const store = getStore(), id = randomUUID();
            await store.putAsync(put(id, randomUUID()), context);
            const results = await Promise.allSettled([store.putAsync(put(id, randomUUID(), 1), context), store.putAsync(put(id, randomUUID(), 1), context)]);
            expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
            expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
        });
        it("deletes logically while keeping pinned history", async () => {
            const store = getStore(), id = randomUUID();
            await store.putAsync(put(id, randomUUID()), context);
            const deleted = await store.deleteAsync({ namespace, id, expectedRevision: 1, idempotencyKey: randomUUID() }, context);
            expect(deleted.deleted).toBe(true);
            await expect(store.getAsync({ namespace, id }, context)).rejects.toMatchObject({ code: "not_found" });
            expect((await store.getAsync({ namespace, id, revision: 1 }, context)).revision).toBe(1);
            await expect(store.putAsync(put(id, randomUUID()), context)).rejects.toMatchObject({ code: "revision_conflict" });
        });
        it("rejects a missing artifact reference transactionally", async () => {
            const store = getStore(), id = randomUUID();
            await expect(store.putAsync({ ...put(id, randomUUID()), references: [{ type: "artifact", namespace, id: randomUUID() }] }, context)).rejects.toMatchObject({ code: "not_found" });
            await expect(store.getAsync({ namespace, id }, context)).rejects.toMatchObject({ code: "not_found" });
        });
        it("binds signed pagination to its filters", async () => {
            const store = getStore();
            for (let i = 0; i < 3; ++i) await store.putAsync(put(randomUUID(), randomUUID()), context);
            const page = await store.listAsync({ namespace, limit: 1 }, context);
            expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeTruthy();
            const next = await store.listAsync({ namespace, limit: 1, cursor: page.nextCursor }, context);
            expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
            await expect(store.listAsync({ namespace, kind: "other", cursor: page.nextCursor }, context)).rejects.toMatchObject({ code: "invalid_request" });
        });
    });
}
