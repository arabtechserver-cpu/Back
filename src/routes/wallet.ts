import { Router } from 'express';
import { prisma } from "../utils/prisma";
import { authenticateToken } from '../middleware/auth';

const router = Router();

router.get('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true }
    });

    const transactions = await prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      balance: user?.balance || 0,
      transactions: transactions.map(t => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        status: t.status,
        method: t.method,
        createdAt: t.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch wallet info' });
  }
});

router.post('/', authenticateToken, async (req: any, res) => {
  return res.status(410).json({ error: 'يرجى تقديم الإيداع مع الإيصال ورقم المرجع عبر /api/transactions' });
});

export default router;
