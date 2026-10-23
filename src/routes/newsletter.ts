import { Router } from 'express';

const router = Router();
router.use((_req, res) => res.status(410).json({ error: 'تم إلغاء الاشتراك في النشرة الإخبارية وإرسال النشرات' }));

// Retire background broadcasts too, while keeping historical database records.
export async function broadcastNewItemToSubscribers(_item: {
  title: string;
  message: string;
  category?: string;
  actionUrl?: string;
  actionText?: string;
}) {
  return { count: 0, disabled: true };
}

export default router;
