ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "receiptHash" TEXT;
CREATE INDEX IF NOT EXISTS "Transaction_receiptHash_idx" ON "Transaction"("receiptHash");
