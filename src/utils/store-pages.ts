import { prisma } from './prisma';

export const PAGE_PREFIX = 'store-page:';
export const PLACEMENT_PREFIX = 'store-placement:';
export type Placement = { mode: 'inherit' | 'selected' | 'all'; pageIds: string[] };
export type StorePage = { id: string; title: string; titleEn: string; slug: string; description: string; descriptionEn: string; enabled: boolean; navbar: boolean; menu: boolean; order: number; archived: boolean };

export function placementKey(target: { serviceId?: string; categoryId?: string; groupName?: string }) {
  return target.serviceId ? `service:${encodeURIComponent(target.serviceId)}` : `group:${encodeURIComponent(target.categoryId || '')}:${encodeURIComponent(target.groupName || '')}`;
}

export function includesService(pageId: string, categoryId: string, service: any, placements: Record<string, Placement>) {
  if (service.isActive === false) return false;
  const own = placements[placementKey({ serviceId: service.id })];
  const group = placements[placementKey({ categoryId, groupName: service.groupName })];
  const choice = own && own.mode !== 'inherit' ? own : group;
  return choice?.mode === 'all' || choice?.pageIds?.includes(pageId) === true;
}

export function filterPageCatalog(categories: any[], pageId: string, placements: Record<string, Placement>) {
  return categories.map(category => ({ ...category, services: (category.services || []).filter((service: any) => includesService(pageId, category.id, service, placements)) })).filter(category => category.services.length > 0);
}

export function countPageServices(pageId: string, services: { id: string; categoryId: string | null; groupName: string | null; isActive: boolean }[], placements: Record<string, Placement>) {
  return services.reduce((count, service) => count + Number(service.categoryId !== null && includesService(pageId, service.categoryId, service, placements)), 0);
}

export function validatePage(input: any, id: string): StorePage {
  const text = (value: any, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const slug = text(input.slug, 80).toLowerCase();
  const title = text(input.title, 100);
  if (!title || slug === 'admin' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('اكتب اسم الصفحة ورابطًا بالإنجليزية مثل game-codes؛ رابط admin محجوز');
  return { id, title, titleEn: text(input.titleEn, 100), slug, description: text(input.description, 1000), descriptionEn: text(input.descriptionEn, 1000), enabled: input.enabled === true, navbar: input.navbar === true, menu: input.menu === true, order: Math.max(0, Math.min(999, Number(input.order) || 0)), archived: input.archived === true };
}

export async function readStorePages(includePlacements = true) {
  const rows = await prisma.setting.findMany({ where: includePlacements ? { OR: [{ key: { startsWith: PAGE_PREFIX } }, { key: { startsWith: PLACEMENT_PREFIX } }] } : { key: { startsWith: PAGE_PREFIX } }, select: { key: true, value: true } });
  const pages: StorePage[] = [];
  const placements: Record<string, Placement> = {};
  for (const row of rows) {
    try {
      const data = JSON.parse(row.value);
      if (row.key.startsWith(PAGE_PREFIX)) pages.push(data);
      else placements[row.key.slice(PLACEMENT_PREFIX.length)] = data;
    } catch { /* Ignore an invalid legacy row without publishing its contents. */ }
  }
  pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ar'));
  return { pages, placements };
}
