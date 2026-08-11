const telegram = require('./telegramService');
const emailService = require('./emailService');
const { getQuery } = require('../db');
const whatsapp = require('../whatsapp');

/**
 * Unified notification helper to alert customers on Telegram and Gmail
 * for order status updates (completed, cancelled, etc.)
 */
async function notifyCustomerOfOrderUpdate(orderId, nextStatus, nextCode = '', nextDownloadLink = '', nextDownloadLinkTitle = '') {
  try {
    const order = await getQuery('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) {
      console.warn(`[Notification Helper] Order #${orderId} not found.`);
      return;
    }

    const customerRow = order.customer_id
      ? await getQuery('SELECT id, email, telegram_chat_id, username FROM customers WHERE id = ?', [order.customer_id])
      : null;

    const targetEmail = customerRow ? customerRow.email : '';

    console.log(`[Notification Helper] Notifying customer for Order #${orderId}: Email=${targetEmail}, Status=${nextStatus}`);

    const statusLabel =
      nextStatus === 'completed' ? '✅ تم تنفيذ وتفعيل طلبك بنجاح!' :
      nextStatus === 'cancelled' ? '❌ تم إلغاء الطلب الخاص بك.' :
      '🔔 تحديث جديد بخصوص طلبك';

    // ── 1. Telegram notification ──────────────────────────────────────────
    if (customerRow && customerRow.telegram_chat_id) {
      const tgLines = [
        `${statusLabel}`,
        ``,
        `🛒 رقم الطلب: *#${order.id}*`,
        `🎮 الخدمة: *${order.service_name}*`,
        `📦 الباقة: *${order.package_name}*`,
        nextCode ? `🔑 كود التفعيل:\n\`${nextCode}\`` : null,
        nextDownloadLink ? `🔗 [${nextDownloadLinkTitle || 'رابط التحميل'}](${nextDownloadLink})` : null,
        ``,
        `شكراً لتعاملك معنا ❤️ — عرب تك سيرفر`
      ].filter(Boolean).join('\n');

      try {
        await telegram.sendMessage(customerRow.telegram_chat_id, tgLines);
        console.log(`[Telegram Customer] Order #${orderId} update sent to customer ${customerRow.username || customerRow.id} ✓`);
      } catch (tgErr) {
        console.warn('[Telegram Customer] Failed to send order update:', tgErr.message);
      }
    } else {
      console.log(`[Notification Helper] No Telegram chat_id for customer ${order.customer_id || 'guest'} — skipping Telegram`);
    }

    // ── 2. Gmail/HTML notification for completed orders ───────────────────
    if (targetEmail && nextStatus === 'completed') {
      try {
        await emailService.sendOrderCompletedEmail(targetEmail, {
          orderId: order.id,
          serviceName: order.service_name,
          packageName: order.package_name,
          code: nextCode,
          downloadLink: nextDownloadLink
        });
        console.log(`[Gmail Customer] Order #${orderId} completed email sent to ${targetEmail} ✓`);
      } catch (emailErr) {
        console.warn('[Gmail Customer] Failed to send order completed email:', emailErr.message);
      }
    }

    // ── 3. Gmail for cancelled orders too ────────────────────────────────
    if (targetEmail && nextStatus === 'cancelled') {
      try {
        await emailService.sendOrderCancelledEmail(targetEmail, {
          orderId: order.id,
          serviceName: order.service_name,
          packageName: order.package_name
        });
      } catch (emailErr) {
        // Not critical — don't block
        console.warn('[Gmail Customer] Failed to send cancellation email:', emailErr.message);
      }
    }

  } catch (err) {
    console.error('[Notification Helper] Error notifying customer:', err.message);
  }
}

module.exports = {
  notifyCustomerOfOrderUpdate
};
