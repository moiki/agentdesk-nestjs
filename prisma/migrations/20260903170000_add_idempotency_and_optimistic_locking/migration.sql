-- Add idempotency + optimistic-locking support to the critical write paths.

-- Conversation: client-supplied idempotency key (unique per tenant so retried
-- POST /chat returns the same conversation), plus a version column for
-- compare-and-swap persistence.
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tenantId_idempotencyKey_key" ON "Conversation"("tenantId", "idempotencyKey");

-- Ticket: version column for compare-and-swap updates (detects lost updates).
-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;
