import { prisma } from './prisma';
import { manualStoreCatalogSql } from '../data/manual-store-catalog';

export const MANUAL_CATALOG_INSTALL_KEY = 'catalog-install:zoalna:20261028:v1';

/** Install the checked-in catalog once on the actual database this server uses. */
export async function installManualCatalog(database = prisma): Promise<boolean> {
  return database.$transaction(async tx => {
    // All instances use the same lock; the second instance checks the marker
    // after the first commits. The default READ COMMITTED isolation is intended.
    await tx.$executeRawUnsafe('DO $lock$ BEGIN PERFORM pg_advisory_xact_lock(20261028, 1); END $lock$;');
    const installed = await tx.setting.findUnique({ where: { key: MANUAL_CATALOG_INSTALL_KEY } });
    if (installed) return false;

    // Fixed, trusted source generated with the migration; no request input.
    await tx.$executeRawUnsafe(manualStoreCatalogSql);
    await tx.setting.create({ data: {
      key: MANUAL_CATALOG_INSTALL_KEY,
      value: JSON.stringify({ version: 1, installedAt: new Date().toISOString() }),
    } });
    return true;
  }, { maxWait: 30000, timeout: 60000 });
}
