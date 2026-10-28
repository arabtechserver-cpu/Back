import { prisma } from './prisma';

// Matches 20261028010000_cart_storage. Embedded for direct Node deployments
// which previously installed catalog data without running schema migrations.
export const CART_SCHEMA_SQL = `
DO $cart_storage$
BEGIN
CREATE TABLE IF NOT EXISTS "CartItem" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "serviceName" TEXT NOT NULL,
  "groupName" TEXT,
  "targetInput" TEXT,
  "customFields" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "groupName" TEXT;
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "targetInput" TEXT;
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "customFields" TEXT;
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "price" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS "CartItem_userId_idx" ON "CartItem"("userId");
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CartItem_userId_fkey' AND conrelid = '"CartItem"'::regclass) THEN
    ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END $cart_storage$;
`;

export async function ensureCartSchema(database = prisma): Promise<void> {
  const result = await database.$queryRawUnsafe<{ ready: boolean }[]>(`
    SELECT count(*) = 12 AS ready FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'CartItem'
      AND column_name IN ('id','userId','serviceId','serviceName','groupName','targetInput',
        'customFields','quantity','price','notes','createdAt','updatedAt')
  `);
  if (result[0]?.ready) return;
  await database.$transaction(async tx => {
    await tx.$executeRawUnsafe('DO $lock$ BEGIN PERFORM pg_advisory_xact_lock(20261028, 2); END $lock$;');
    await tx.$executeRawUnsafe(CART_SCHEMA_SQL);
  }, { maxWait: 30000, timeout: 30000 });
}
