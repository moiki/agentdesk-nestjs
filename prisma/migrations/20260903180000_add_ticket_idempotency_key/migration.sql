-- Add DB-level idempotency for the create_ticket tool.
--
-- The agent pass: create_ticket now stamps each created ticket with the
-- originating toolCallId. The unique (tenantId, idempotencyKey) constraint is
-- the atomic guard that prevents a retried agent turn (possibly in a fresh
-- process, where the in-memory per-turn dedup cache no longer exists) from
-- creating a duplicate business record.
-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_tenantId_idempotencyKey_key" ON "Ticket"("tenantId", "idempotencyKey");
