import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { sendDocumentToAdmins } from '../utils/telegramService';
import { prisma } from "../utils/prisma";
import { writeJsonSnapshot } from "../utils/json-snapshot";

export function initBackupCron() {
  console.log('[CRON] Initializing Daily JSON Backup Cron Job (runs at 00:00 every day)');

  // Run every day at midnight (00:00)
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Running daily JSON backup...');
    try {
      await performJSONBackupAndSend();
    } catch (error) {
      console.error('[CRON] General error in JSON backup:', error);
    }
  });
}

export async function performJSONBackupAndSend() {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const jsonFilename = `backup_report_${dateStr}.json`;
    const backupsDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const jsonFilePath = path.join(backupsDir, jsonFilename);

    console.log(`[Backup] Fetching data from database for JSON report...`);
    
    const userArgs = {
      select: {
        id: true,
        fullName: true,
        email: true,
        username: true,
        phone: true,
        country: true,
        role: true,
        status: true,
        balance: true,
        membershipTierId: true,
        customDiscount: true,
        createdAt: true,
        updatedAt: true,
        apiEnabled: true,
        apiMargin: true,
        apiSiteName: true,
        apiSiteUrl: true
      }
    };
    const [totalUsers, totalOrders, totalTransactions, totalWalletTransactions] = await Promise.all([
      prisma.user.count(), prisma.order.count(), prisma.transaction.count(), prisma.walletTransaction.count()
    ]);
    const summary = { totalUsers, totalOrders, totalTransactions, totalWalletTransactions };
    await writeJsonSnapshot(jsonFilePath, { timestamp: new Date().toISOString(), summary }, {
      users: { model: prisma.user, args: userArgs }, orders: { model: prisma.order, batchSize: 10 },
      transactions: { model: prisma.transaction, batchSize: 1 }, walletTransactions: { model: prisma.walletTransaction }
    });

    const stats = fs.statSync(jsonFilePath);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
    
    const caption = `[REPORT] <b>تقرير النسخة الاحتياطية اليومي (JSON)</b>\n\n<b>التاريخ:</b> ${dateStr}\n<b>المستخدمين:</b> ${totalUsers}\n<b>الطلبات:</b> ${totalOrders}\n<b>المعاملات:</b> ${totalTransactions}\n<b>الحجم:</b> ${fileSizeMB} MB`;
    
    const delivered = await sendDocumentToAdmins(jsonFilePath, caption);
    if (delivered) {
      console.log('[Backup] JSON Backup sent to Telegram successfully.');
      if (fs.existsSync(jsonFilePath)) {
        fs.unlinkSync(jsonFilePath);
        console.log(`[Backup] Cleaned up temporary backup file ${jsonFilePath}.`);
      }
    } else {
      console.warn(`[Backup] Telegram delivery could not be completed. Local backup preserved at: ${jsonFilePath}`);
    }
  } catch (err) {
    console.error('[Backup] Error creating or sending JSON backup:', err);
    throw err;
  }
}
