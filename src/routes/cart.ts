import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticateToken } from '../middleware/auth';

const router = Router();

function safeJsonParse(val: any, fallback: any = null) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

// GET /api/cart - Get user's cart items
router.get('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const items = await prisma.cartItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    const parsedItems = items.map((item) => ({
      ...item,
      customFields: safeJsonParse(item.customFields, {}),
    }));

    const totalCount = parsedItems.reduce((acc, it) => acc + (it.quantity || 1), 0);
    const totalPrice = parsedItems.reduce((acc, it) => acc + (it.price || 0) * (it.quantity || 1), 0);

    return res.json({
      success: true,
      items: parsedItems,
      count: totalCount,
      total: Number(totalPrice.toFixed(2)),
    });
  } catch (error: any) {
    console.error('Error fetching cart:', error);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب عناصر السلة' });
  }
});

// POST /api/cart - Add item to cart
router.post('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const {
      serviceId,
      serviceName,
      groupName,
      targetInput,
      customFields,
      quantity = 1,
      price = 0,
      notes,
    } = req.body;

    if (!serviceId || !serviceName) {
      return res.status(400).json({ success: false, error: 'الخدمة واسمها مطلوبان لإضافتها للسلة' });
    }

    const qty = Math.max(1, parseInt(String(quantity), 10) || 1);
    const parsedPrice = Math.max(0, parseFloat(String(price)) || 0);
    const serializedCustom = customFields ? (typeof customFields === 'string' ? customFields : JSON.stringify(customFields)) : null;
    const cleanTarget = targetInput ? String(targetInput).trim() : '';

    // Check if matching item exists
    const existing = await prisma.cartItem.findFirst({
      where: {
        userId,
        serviceId: String(serviceId),
        targetInput: cleanTarget || null,
        customFields: serializedCustom,
      },
    });

    let item;
    if (existing) {
      item = await prisma.cartItem.update({
        where: { id: existing.id },
        data: {
          quantity: existing.quantity + qty,
          price: parsedPrice > 0 ? parsedPrice : existing.price,
        },
      });
    } else {
      item = await prisma.cartItem.create({
        data: {
          userId,
          serviceId: String(serviceId),
          serviceName: String(serviceName).trim(),
          groupName: groupName ? String(groupName).trim() : null,
          targetInput: cleanTarget || null,
          customFields: serializedCustom,
          quantity: qty,
          price: parsedPrice,
          notes: notes ? String(notes).trim() : null,
        },
      });
    }

    const totalCount = await prisma.cartItem.count({ where: { userId } });

    return res.json({
      success: true,
      item: {
        ...item,
        customFields: safeJsonParse(item.customFields, {}),
      },
      count: totalCount,
      message: 'تمت إضافة المنتج إلى السلة بنجاح',
    });
  } catch (error: any) {
    console.error('Error adding to cart:', error);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء إضافة العنصر إلى السلة' });
  }
});

// PUT /api/cart/:id - Update cart item quantity or details
router.put('/:id', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { quantity, targetInput, customFields, notes } = req.body;

    const existing = await prisma.cartItem.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ success: false, error: 'العنصر غير موجود في السلة' });
    }

    const qty = parseInt(String(quantity), 10);
    if (qty <= 0) {
      await prisma.cartItem.delete({ where: { id } });
      return res.json({ success: true, message: 'تم حذف العنصر من السلة', deleted: true });
    }

    const updateData: any = {};
    if (!isNaN(qty)) updateData.quantity = qty;
    if (targetInput !== undefined) updateData.targetInput = String(targetInput).trim();
    if (customFields !== undefined) {
      updateData.customFields = typeof customFields === 'string' ? customFields : JSON.stringify(customFields);
    }
    if (notes !== undefined) updateData.notes = String(notes).trim();

    const updated = await prisma.cartItem.update({
      where: { id },
      data: updateData,
    });

    return res.json({
      success: true,
      item: {
        ...updated,
        customFields: safeJsonParse(updated.customFields, {}),
      },
    });
  } catch (error: any) {
    console.error('Error updating cart item:', error);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء تعديل عنصر السلة' });
  }
});

// DELETE /api/cart/:id - Remove item from cart
router.delete('/:id', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const existing = await prisma.cartItem.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ success: false, error: 'العنصر غير موجود في السلة' });
    }

    await prisma.cartItem.delete({ where: { id } });
    const count = await prisma.cartItem.count({ where: { userId } });

    return res.json({ success: true, message: 'تم حذف المنتج من السلة', count });
  } catch (error: any) {
    console.error('Error deleting cart item:', error);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء حذف العنصر من السلة' });
  }
});

// DELETE /api/cart - Clear entire cart
router.delete('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;
    await prisma.cartItem.deleteMany({ where: { userId } });
    return res.json({ success: true, message: 'تم إفراغ السلة بنجاح', count: 0 });
  } catch (error: any) {
    console.error('Error clearing cart:', error);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء إفراغ السلة' });
  }
});

// POST /api/cart/sync - Sync guest cart items into user's DB cart on login
router.post('/sync', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const { items = [] } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      const userItems = await prisma.cartItem.findMany({ where: { userId } });
      return res.json({
        success: true,
        items: userItems.map((it) => ({ ...it, customFields: safeJsonParse(it.customFields, {}) })),
        count: userItems.length,
      });
    }

    for (const item of items) {
      if (!item.serviceId || !item.serviceName) continue;

      const qty = Math.max(1, parseInt(String(item.quantity), 10) || 1);
      const price = Math.max(0, parseFloat(String(item.price)) || 0);
      const cleanTarget = item.targetInput ? String(item.targetInput).trim() : '';
      const serializedCustom = item.customFields
        ? typeof item.customFields === 'string'
          ? item.customFields
          : JSON.stringify(item.customFields)
        : null;

      const existing = await prisma.cartItem.findFirst({
        where: {
          userId,
          serviceId: String(item.serviceId),
          targetInput: cleanTarget || null,
          customFields: serializedCustom,
        },
      });

      if (existing) {
        await prisma.cartItem.update({
          where: { id: existing.id },
          data: {
            quantity: existing.quantity + qty,
            price: price > 0 ? price : existing.price,
          },
        });
      } else {
        await prisma.cartItem.create({
          data: {
            userId,
            serviceId: String(item.serviceId),
            serviceName: String(item.serviceName).trim(),
            groupName: item.groupName ? String(item.groupName).trim() : null,
            targetInput: cleanTarget || null,
            customFields: serializedCustom,
            quantity: qty,
            price,
            notes: item.notes ? String(item.notes).trim() : null,
          },
        });
      }
    }

    const allItems = await prisma.cartItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    const parsed = allItems.map((it) => ({
      ...it,
      customFields: safeJsonParse(it.customFields, {}),
    }));

    return res.json({
      success: true,
      items: parsed,
      count: parsed.reduce((sum, it) => sum + (it.quantity || 1), 0),
      message: 'تمت مزامنة سلة المشتريات بنجاح',
    });
  } catch (error: any) {
    console.error('Error syncing cart:', error);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء مزامنة عناصر السلة' });
  }
});

// POST /api/cart/checkout - Execute batch order from cart using wallet balance
router.post('/checkout', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const { itemIds } = req.body;

    const whereClause: any = { userId };
    if (Array.isArray(itemIds) && itemIds.length > 0) {
      whereClause.id = { in: itemIds };
    }

    const cartItems = await prisma.cartItem.findMany({ where: whereClause });
    if (cartItems.length === 0) {
      return res.status(400).json({ success: false, error: 'السلة فارغة، لا توجد عناصر للشراء' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    const totalCost = cartItems.reduce(
      (acc, it) => acc + (it.price || 0) * (it.quantity || 1),
      0
    );
    const roundedTotal = Number(totalCost.toFixed(2));

    if (user.balance < roundedTotal) {
      return res.status(400).json({
        success: false,
        error: `رصيد المحفظة غير كافٍ. المبلغ المطلوب: $${roundedTotal} USD، والرصيد المتاح: $${user.balance.toFixed(2)} USD. يرجى شحن المحفظة أولاً.`,
      });
    }

    const createdOrderIds: string[] = [];

    await prisma.$transaction(async (tx) => {
      // 1. Deduct balance
      const updateResult = await tx.user.updateMany({
        where: { id: userId, balance: { gte: roundedTotal } },
        data: { balance: { decrement: roundedTotal } },
      });

      if (updateResult.count === 0) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // 2. Create Order for each cart item
      for (const item of cartItems) {
        const itemTotal = Number(((item.price || 0) * (item.quantity || 1)).toFixed(2));
        const customFieldsObj = safeJsonParse(item.customFields, null);

        const structuredNotes = JSON.stringify({
          source: 'cart_checkout',
          groupName: item.groupName,
          customFields: customFieldsObj,
          userNote: item.notes,
        });

        const newOrder = await tx.order.create({
          data: {
            userId,
            serviceId: item.serviceId,
            serviceName: item.serviceName,
            targetInput: item.targetInput || 'N/A',
            quantity: item.quantity,
            price: itemTotal,
            status: 'pending',
            notes: structuredNotes,
          },
        });

        createdOrderIds.push(newOrder.id);
      }

      // 3. Record transaction
      await tx.transaction.create({
        data: {
          userId,
          type: `شراء سلة مشتريات (${cartItems.length} منتجات)`,
          amount: roundedTotal,
          method: 'رصيد المحفظة',
          refNo: `CART-#${Date.now().toString().slice(-6)}`,
          status: 'completed',
        },
      });

      // 4. Remove checked out items from cart
      await tx.cartItem.deleteMany({
        where: { id: { in: cartItems.map((c) => c.id) } },
      });
    });

    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    });

    return res.json({
      success: true,
      message: 'تم إتمام الشراء بنجاح وخصم التكلفة من المحفظة!',
      orderIds: createdOrderIds,
      newBalance: updatedUser?.balance || 0,
      itemsCount: cartItems.length,
    });
  } catch (error: any) {
    console.error('Error checking out cart:', error);
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ success: false, error: 'رصيد المحفظة غير كافٍ لإتمام العملية' });
    }
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء تنفيذ عملية الشراء' });
  }
});

export default router;
