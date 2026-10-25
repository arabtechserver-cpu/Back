import { prisma } from './prisma';

export const CATALOG_IMAGE_PREFIX = 'catalog-image:';

export function catalogImageKey(target: { serviceId?: string; categoryId?: string; groupName?: string }) {
  if (target.serviceId) return `${CATALOG_IMAGE_PREFIX}service:${encodeURIComponent(target.serviceId)}`;
  if (!target.categoryId || target.groupName === undefined) throw new Error('يجب اختيار الخدمة أو الباقة');
  return `${CATALOG_IMAGE_PREFIX}group:${encodeURIComponent(target.categoryId)}:${encodeURIComponent(target.groupName)}`;
}

export async function attachCatalogImages(categories: any[]) {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: CATALOG_IMAGE_PREFIX } }, select: { key: true, value: true }
  });
  const images = new Map(rows.map(row => [row.key, row.value]));
  return categories.map(category => ({ ...category, services: category.services.map((service: any) => ({
    ...service,
    imageUrl: images.get(catalogImageKey({ serviceId: service.id })) || null,
    groupImageUrl: images.get(catalogImageKey({ categoryId: category.id, groupName: service.groupName })) || null
  })) }));
}
