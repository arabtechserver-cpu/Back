import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticateToken } from '../middleware/auth';
import { getServiceQuantityConfig } from '../utils/provider-quantity';
import crypto from 'crypto';

const router = Router();

export function quoteCartItem(item: any, service: any, user: any) {
  if (!user || user.status === 'suspended') throw new Error('SERVICE_UNAVAILABLE');
  if (!service?.isActive) throw new Error('SERVICE_UNAVAILABLE');
  const quantity = Number(item.quantity);
  const config = getServiceQuantityConfig(service);
  // A manual package can be purchased more than once. This counts packages,
  // independently from a provider's dynamic QNT field.
  const manualPackage = service.providerId === null;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000 ||
      (!manualPackage && !config.supportsQty && quantity !== 1) ||
      (config.supportsQty && (quantity < config.minQty || (config.maxQty > 0 && quantity > config.maxQty)))) {
    throw new Error('INVALID_QUANTITY');
  }
  const base = Number(service.credit) + Number(service.margin);
  if (!Number.isFinite(base) || base <= 0) throw new Error('PRICE_UNAVAILABLE');
  const discount = Math.max(0, Math.min(100, Math.max(user.customDiscount || 0, user.membershipTier?.discountPercentage || 0)));
  const price = base * (1 - discount / 100);
  const total = price > 0 ? Math.max(0.01, Number((price * quantity).toFixed(2))) : 0;
  return { ...item, serviceName: service.name, groupName: service.groupName, quantity, price, total };
}

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

    const qty = Number(quantity);
    const service = await prisma.dhruService.findUnique({ where: { id: String(serviceId) } });
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { membershipTier: true } });
    const quoted = quoteCartItem({ quantity: qty }, service, user);
    const parsedPrice = quoted.price;
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
      quoteCartItem({ quantity: existing.quantity + qty }, service, user);
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
          serviceName: service!.name,
          groupName: service!.groupName,
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
    if (['SERVICE_UNAVAILABLE', 'INVALID_QUANTITY', 'PRICE_UNAVAILABLE'].includes(error.message)) return res.status(400).json({ success: false, error: 'الخدمة غير متاحة أو السعر أو الكمية غير صالح' });
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

    const qty = quantity === undefined ? undefined : Number(quantity);
    if (qty !== undefined && (!Number.isSafeInteger(qty) || qty > 1_000_000)) return res.status(400).json({ error: 'Invalid quantity' });
    if (qty !== undefined && qty <= 0) {
      await prisma.cartItem.delete({ where: { id } });
      return res.json({ success: true, message: 'تم حذف العنصر من السلة', deleted: true });
    }

    const updateData: any = {};
    if (qty !== undefined) {
      const service = await prisma.dhruService.findUnique({ where: { id: existing.serviceId } });
      const user = await prisma.user.findUnique({ where: { id: userId }, include: { membershipTier: true } });
      const quoted = quoteCartItem({ quantity: qty }, service, user);
      updateData.quantity = qty;
      updateData.price = quoted.price;
    }
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
    if (['SERVICE_UNAVAILABLE', 'INVALID_QUANTITY', 'PRICE_UNAVAILABLE'].includes(error.message)) return res.status(400).json({ success: false, error: 'الخدمة غير متاحة أو السعر أو الكمية غير صالح' });
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
    if (!Array.isArray(items) || items.length > 100) return res.status(400).json({ error: 'Invalid cart size' });
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { membershipTier: true } });

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

      const qty = Number(item.quantity ?? 1);
      const service = await prisma.dhruService.findUnique({ where: { id: String(item.serviceId) } });
      const price = quoteCartItem({ quantity: qty }, service, user).price;
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
        quoteCartItem({ quantity: existing.quantity + qty }, service, user);
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
            serviceName: service!.name,
            groupName: service!.groupName,
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
    if (['SERVICE_UNAVAILABLE', 'INVALID_QUANTITY', 'PRICE_UNAVAILABLE'].includes(error.message)) return res.status(400).json({ success: false, error: 'الخدمة غير متاحة أو السعر أو الكمية غير صالح' });
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

    const createdOrderIds: string[] = [];
    let itemsCount = 0;
    await prisma.$transaction(async (tx) => {
      const storedItems = await tx.cartItem.findMany({ where: whereClause, take: 101 });
      if (!storedItems.length || storedItems.length > 100) throw new Error('INVALID_CART');
      const user = await tx.user.findUnique({ where: { id: userId }, include: { membershipTier: true } });
      const services = await tx.dhruService.findMany({ where: { id: { in: storedItems.map(item => item.serviceId) } } });
      const serviceMap = new Map(services.map(service => [service.id, service]));
      const cartItems = storedItems.map(item => quoteCartItem(item, serviceMap.get(item.serviceId), user));
      const roundedTotal = Number(cartItems.reduce((sum, item) => sum + item.total, 0).toFixed(2));
      itemsCount = cartItems.length;
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
        const itemTotal = item.total;
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
          refNo: `CART-${crypto.randomUUID()}`,
          status: 'completed',
        },
      });

      // 4. Remove checked out items from cart
      await tx.cartItem.deleteMany({
        where: { id: { in: cartItems.map((c) => c.id) } },
      });
    }, { isolationLevel: 'Serializable', timeout: 15000 });

    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    });

    return res.json({
      success: true,
      message: 'تم إتمام الشراء بنجاح وخصم التكلفة من المحفظة!',
      orderIds: createdOrderIds,
      newBalance: updatedUser?.balance || 0,
      itemsCount,
    });
  } catch (error: any) {
    console.error('Error checking out cart:', error);
    if (error.code === 'P2034') return res.status(409).json({ success: false, error: 'تم تعديل السلة بالتزامن. راجع طلباتك قبل المحاولة مجدداً.' });
    const cartErrors: Record<string, string> = {
      SERVICE_UNAVAILABLE: 'إحدى خدمات السلة لم تعد متاحة. احذفها أو اختر باقة أخرى.',
      INVALID_QUANTITY: 'كمية إحدى الباقات غير مسموح بها. راجع الكميات في السلة.',
      PRICE_UNAVAILABLE: 'إحدى الباقات لم يتم تسعيرها بعد. يرجى التواصل مع الإدارة قبل الشراء.',
      INVALID_CART: 'السلة فارغة أو تجاوزت الحد الأقصى (١٠٠ منتج).',
    };
    if (cartErrors[error.message]) return res.status(400).json({ success: false, error: cartErrors[error.message] });
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ success: false, error: 'رصيد المحفظة غير كافٍ لإتمام العملية' });
    }
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء تنفيذ عملية الشراء' });
  }
});

export default router;
