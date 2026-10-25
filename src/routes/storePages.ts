import { Router } from 'express';
import { randomUUID } from 'crypto';
import { isAdmin } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { loadServiceCategories } from './dhru';
import { PAGE_PREFIX, PLACEMENT_PREFIX, readStorePages, validatePage, placementKey, filterPageCatalog, countPageServices } from '../utils/store-pages';

const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

router.get('/', async (_req, res) => {
  try {
    const { pages, placements } = await readStorePages();
    const published = pages.filter(page => page.enabled && !page.archived);
    const services = published.length ? await prisma.dhruService.findMany({ where: { isActive: true }, select: { id: true, categoryId: true, groupName: true, isActive: true } }) : [];
    res.json({ pages: published.map(page => ({ ...page, serviceCount: countPageServices(page.id, services, placements) })) });
  }
  catch { res.status(500).json({ error: 'تعذر تحميل صفحات المتجر' }); }
});

router.get('/admin', isAdmin, async (_req, res) => {
  try { res.json(await readStorePages()); }
  catch { res.status(500).json({ error: 'تعذر تحميل إعدادات الصفحات' }); }
});

router.post('/admin/pages', isAdmin, async (req, res) => {
  try {
    const { pages } = await readStorePages(false);
    const existing = req.body?.id ? pages.find(page => page.id === req.body.id) : null;
    if (req.body?.id && !existing) return res.status(404).json({ error: 'الصفحة غير موجودة' });
    if (!existing && pages.length >= 60) return res.status(400).json({ error: 'الحد الأقصى ٦٠ صفحة' });
    const page = validatePage(req.body, existing?.id || randomUUID());
    if (pages.some(other => other.id !== page.id && other.slug === page.slug)) return res.status(409).json({ error: 'هذا الرابط مستخدم لصفحة أخرى' });
    await prisma.$transaction(async tx => {
      const slugKey = `store-page-slug:${page.slug}`;
      const owner = await tx.setting.findUnique({ where: { key: slugKey } });
      if (owner && owner.value !== page.id) throw new Error('SLUG_CONFLICT');
      if (!owner) await tx.setting.create({ data: { key: slugKey, value: page.id } });
      if (existing && existing.slug !== page.slug) await tx.setting.deleteMany({ where: { key: `store-page-slug:${existing.slug}`, value: page.id } });
      await tx.setting.upsert({ where: { key: PAGE_PREFIX + page.id }, create: { key: PAGE_PREFIX + page.id, value: JSON.stringify(page) }, update: { value: JSON.stringify(page) } });
    });
    return res.json({ success: true, page });
  } catch (error: any) {
    if (error?.code === 'P2002' || error?.message === 'SLUG_CONFLICT') return res.status(409).json({ error: 'هذا الرابط مستخدم لصفحة أخرى' });
    const invalidInput = error instanceof Error && error.message.startsWith('اكتب اسم الصفحة');
    return res.status(invalidInput ? 400 : 500).json({ error: invalidInput ? error.message : 'تعذر حفظ الصفحة' });
  }
});

router.post('/admin/placement', isAdmin, async (req, res) => {
  try {
    const { serviceId, categoryId, groupName, mode, pageIds } = req.body || {};
    if (!['inherit', 'selected', 'all'].includes(mode) || !Array.isArray(pageIds) || pageIds.length > 60 || pageIds.some(id => typeof id !== 'string')) return res.status(400).json({ error: 'اختيار الصفحات غير صالح' });
    if (serviceId ? typeof serviceId !== 'string' : typeof categoryId !== 'string' || typeof groupName !== 'string' || mode === 'inherit') return res.status(400).json({ error: 'حدد الخدمة أو الباقة' });
    const found = serviceId ? await prisma.dhruService.findUnique({ where: { id: serviceId }, select: { id: true } }) : await prisma.dhruService.findFirst({ where: { categoryId, groupName }, select: { id: true } });
    if (!found) return res.status(404).json({ error: 'الخدمة أو الباقة غير موجودة' });
    const { pages } = await readStorePages();
    if (pageIds.some(id => !pages.some(page => page.id === id))) return res.status(400).json({ error: 'إحدى الصفحات لم تعد موجودة؛ أعد تحميل القائمة' });
    const selection = { mode, pageIds: mode === 'selected' ? [...new Set(pageIds)] : [] };
    const key = PLACEMENT_PREFIX + placementKey({ serviceId, categoryId, groupName });
    await prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(selection) }, update: { value: JSON.stringify(selection) } });
    return res.json({ success: true, key: key.slice(PLACEMENT_PREFIX.length), selection });
  } catch { return res.status(500).json({ error: 'تعذر حفظ ظهور العنصر في الصفحات' }); }
});

router.get('/:slug', async (req, res) => {
  try {
    const { pages, placements } = await readStorePages();
    const page = pages.find(page => page.slug === req.params.slug && page.enabled && !page.archived);
    if (!page) return res.status(404).json({ error: 'الصفحة غير متاحة' });
    const categories = filterPageCatalog(await loadServiceCategories(false, true), page.id, placements);
    return res.json({ page, categories });
  } catch { return res.status(500).json({ error: 'تعذر تحميل خدمات الصفحة' }); }
});

export default router;
