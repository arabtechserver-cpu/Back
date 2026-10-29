import { sendTelegramPhotoNotification } from './telegramService';

function escape(value: unknown, maxLength = 400): string {
  return String(value ?? '').slice(0, maxLength).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function sendCartOrderNotifications(orders: Array<{
  id: string; serviceName: string; targetInput: string; quantity: number; price: number; notes: string | null;
}>, customer: { fullName?: string; username?: string; email?: string; balance?: number }): Promise<void> {
  for (const order of orders) {
    let notes: any = {};
    try { notes = JSON.parse(order.notes || '{}'); } catch { /* Legacy plain-text notes. */ }
    const fields = notes?.customFields && typeof notes.customFields === 'object'
      ? Object.entries(notes.customFields).slice(0, 8).map(([key, value]) => `${escape(key, 60)}: <code>${escape(value, 120)}</code>`).join('\n') : '';
    const caption = [
      '<b>طلب جديد من سلة المشتريات — في انتظار التنفيذ</b>',
      `<b>رقم الطلب:</b> #${escape(order.id.slice(-6))}`,
      `<b>العميل:</b> ${escape(customer.fullName, 100)} (@${escape(customer.username, 80)})`,
      `<b>الإيميل:</b> <code>${escape(customer.email, 150)}</code>`,
      `<b>الخدمة:</b> ${escape(notes?.groupName, 100)} — ${escape(order.serviceName, 160)}`,
      `<b>الآيدي / بيانات الطلب:</b> <code>${escape(order.targetInput)}</code>`,
      fields,
      notes?.userNote ? `<b>ملاحظات العميل:</b> ${escape(notes.userNote)}` : '',
      `<b>الكمية:</b> ${order.quantity}`,
      `<b>الإجمالي:</b> <code>$${order.price.toFixed(2)} USD</code>`,
      typeof customer.balance === 'number' ? `<b>رصيد العميل المتبقي:</b> <code>$${customer.balance.toFixed(2)} USD</code>` : '',
    ].filter(Boolean).join('\n');
    const delivered = await sendTelegramPhotoNotification({ caption });
    if (!delivered) console.error(`[Cart Telegram] Notification not delivered for order ${order.id}`);
  }
}
