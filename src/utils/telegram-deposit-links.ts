import { isIP } from 'net';
import { isPrivateIP } from './dhru-api';

/** URL buttons require a public website; receipts are attached directly in local development. */
export function getTelegramAppLink(receiptPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.APP_URL, env.FRONTEND_URL].flatMap(value => (value || '').split(','));
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate.trim());
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) continue;
      const hostname = base.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
      if (isIP(hostname)) {
        if (isPrivateIP(hostname)) continue;
      } else if (!hostname.includes('.') || /(^|\.)(localhost|local|internal|lan|test|invalid)$/.test(hostname)) continue;
      const link = new URL(receiptPath, base);
      if (link.origin !== base.origin || link.username || link.password) continue;
      return link.href;
    } catch {}
  }
  return null;
}

export function buildDepositTelegramLinks(transactionId: string, receiptPath: string | null, env: NodeJS.ProcessEnv = process.env) {
  const receiptUrl = receiptPath ? getTelegramAppLink(receiptPath, env) : null;
  const inlineKeyboard: any[][] = [];
  if (receiptUrl) inlineKeyboard.push([{ text: 'فتح الإيصال بالدقة الكاملة', url: receiptUrl }]);
  inlineKeyboard.push([
    { text: 'موافقة وشحن الرصيد', callback_data: 'approve_tx_' + transactionId },
    { text: 'رفض الإيداع', callback_data: 'reject_tx_' + transactionId }
  ]);
  return { receiptUrl, replyMarkup: { inline_keyboard: inlineKeyboard } };
}
