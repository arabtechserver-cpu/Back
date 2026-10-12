import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { isAdmin } from '../middleware/auth';
import { prisma } from '../utils/prisma';

const router = Router();
const DATA_FILE = path.join(__dirname, '../data/currencies.json');

export interface PaymentMethodItem {
  id: string;
  nameAr: string;
  nameEn: string;
  accountNumber: string;
  accountName?: string;
  badge: string;
  instructionsAr: string;
  instructionsEn: string;
  detailLabelAr?: string;
  detailLabelEn?: string;
  color?: string;
  icon?: string;
  isActive: boolean;
  isAutomaticPayPal?: boolean;
  isBankak?: boolean;
  isFawry?: boolean;
  isCustom?: boolean;
}

export interface CurrencyConfig {
  usdToSdg: number; // Sudanese Pound rate per 1 USD
  usdToEgp: number; // Egyptian Pound rate per 1 USD
  usdToSar: number; // Saudi Riyal rate per 1 USD
  usdToAed: number; // UAE Dirham rate per 1 USD
  bankak: {
    accountNumber: string;
    accountName: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  fawry?: {
    accountNumber: string;
    accountName: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  vodafone: {
    walletNumber: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  binance: {
    payId: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  cryptoBnb: {
    address: string;
    network: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  rewarble?: {
    address: string;
    transferName: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  paypal: {
    email: string;
    isActive: boolean;
  };
  paymentMethods?: PaymentMethodItem[];
  updatedAt?: string;
}

const DEFAULT_CONFIG: CurrencyConfig = {
  usdToSdg: 2850,
  usdToEgp: 50.0,
  usdToSar: 3.75,
  usdToAed: 3.67,
  bankak: {
    accountNumber: "6302273",
    accountName: "حسن",
    instructionsAr: "حول المبلغ بالجنيه السوداني عبر تطبيق بنكك إلى رقم الحساب ثم ارفع صورة إشعار التحويل للتأكيد الفوري.",
    instructionsEn: "Transfer in Sudanese Pounds via Bankak app then upload the transfer receipt image.",
    isActive: true
  },
  fawry: {
    accountNumber: "51589889",
    accountName: "الرقم البنكي الموحد",
    instructionsAr: "حول المبلغ بالجنيه السوداني عبر تطبيق فوري (بنك فيصل الإسلامي) إلى الرقم البنكي الموحد (51589889) ثم ارفع صورة إشعار التحويل للتأكيد الفوري.",
    instructionsEn: "Transfer in Sudanese Pounds via Fawri app to Unified Banking ID # 51589889 then upload the transfer receipt image.",
    isActive: true
  },
  vodafone: {
    walletNumber: "01097160605",
    instructionsAr: "حول المبلغ إلى رقم المحفظة واكتب الرقم المحول منه وارفق صورة رسالة أو إيصال التحويل.",
    instructionsEn: "Transfer funds to wallet number then attach receipt screenshot.",
    isActive: true
  },
  binance: {
    payId: "894642115",
    instructionsAr: "افتح تطبيق باينانس واكتب معرف Binance Pay ID ثم ارفق لقطة الشاشة للتأكيد.",
    instructionsEn: "Open Binance App and send funds via Pay ID then attach payment screenshot.",
    isActive: true
  },
  cryptoBnb: {
    address: "0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f",
    network: "BNB Smart Chain (BEP20)",
    instructionsAr: "طريقة تحويل عبر BNB معتمدة لكافة الأقسام والخدمات (شحن الألعاب المباشر، متاجر التطبيقات، أكواد الألعاب، الاشتراكات والترفيه، شرائح eSIM، وقسائم Rewarble): اسم التحويل BNB، قم بالتحويل إلى رابط المحفظة (0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f) ثم ارفع صورة إشعار التحويل للتأكيد الفوري.",
    instructionsEn: "Approved BNB transfer method for all sections (In-Game Top-Ups, App Stores, Game Codes, Subscriptions, eSIMs, and Rewarble Vouchers): Transfer Name BNB, transfer to wallet address (0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f) then upload transfer receipt.",
    isActive: true
  },
  rewarble: {
    address: "0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f",
    transferName: "BNB",
    instructionsAr: "طريقة تحويل خاصة بقسم Rewarble: اسم التحويل BNB، قم بالتحويل إلى رابط المحفظة (0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f) ثم ارفع صورة إشعار التحويل للتأكيد الفوري.",
    instructionsEn: "Dedicated transfer method for Rewarble: Transfer Name BNB, transfer to wallet address (0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f) then upload transfer receipt.",
    isActive: true
  },
  paypal: {
    email: "paypal@gsmteam.com",
    isActive: true
  }
};

function readConfigFile(): CurrencyConfig {
  try {
    if (!fs.existsSync(path.dirname(DATA_FILE))) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Failed to read currencies config file:', err);
  }
  return DEFAULT_CONFIG;
}

function writeConfigFile(config: CurrencyConfig): boolean {
  try {
    if (!fs.existsSync(path.dirname(DATA_FILE))) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to write currencies config file:', err);
    return false;
  }
}

function buildDefaultPaymentMethods(cfg: Partial<CurrencyConfig>): PaymentMethodItem[] {
  return [
    {
      id: 'bankak',
      nameAr: 'بنك الخرطوم (بنكك)',
      nameEn: 'Bank of Khartoum (Bankak)',
      badge: 'SD',
      icon: 'banknote',
      color: 'bg-blue-600',
      accountNumber: cfg.bankak?.accountNumber || '6302273',
      accountName: cfg.bankak?.accountName || 'حسن',
      instructionsAr: cfg.bankak?.instructionsAr || 'حول المبلغ بالجنيه السوداني عبر تطبيق بنكك إلى رقم الحساب ثم ارفع صورة إشعار التحويل للتأكيد.',
      instructionsEn: cfg.bankak?.instructionsEn || 'Transfer via Bankak app in Sudanese Pounds then upload receipt image for confirmation.',
      detailLabelAr: 'رقم حساب بنكك:',
      detailLabelEn: 'Bankak Account #:',
      isBankak: true,
      isActive: cfg.bankak?.isActive ?? true
    },
    {
      id: 'fawry',
      nameAr: 'فوري - بنك فيصل الإسلامي',
      nameEn: 'Fawri - Faisal Bank',
      badge: 'FAWRI',
      icon: 'banknote',
      color: 'bg-indigo-600',
      accountNumber: cfg.fawry?.accountNumber || '51589889',
      accountName: cfg.fawry?.accountName || 'الرقم البنكي الموحد',
      instructionsAr: cfg.fawry?.instructionsAr || 'حول المبلغ بالجنيه السوداني عبر تطبيق فوري إلى الرقم البنكي الموحد (51589889) ثم ارفع صورة إشعار التحويل للتأكيد.',
      instructionsEn: cfg.fawry?.instructionsEn || 'Transfer in Sudanese Pounds via Fawri app to Unified Banking ID # 51589889 then upload receipt image for confirmation.',
      detailLabelAr: 'الرقم البنكي الموحد (تطبيق فوري):',
      detailLabelEn: 'Unified Banking ID (Fawri App):',
      isFawry: true,
      isActive: cfg.fawry?.isActive ?? true
    },
    {
      id: 'vodafone',
      nameAr: 'فودافون كاش (Vodafone Cash)',
      nameEn: 'Vodafone Cash',
      badge: 'VF',
      icon: 'smartphone',
      color: 'bg-rose-600',
      accountNumber: cfg.vodafone?.walletNumber || '01097160605',
      instructionsAr: cfg.vodafone?.instructionsAr || 'حول المبلغ إلى رقم المحفظة واكتب الرقم المحول منه وارفق صورة رسالة أو إيصال التحويل.',
      instructionsEn: cfg.vodafone?.instructionsEn || 'Transfer funds to wallet number then attach receipt screenshot.',
      detailLabelAr: 'رقم محفظة فودافون كاش:',
      detailLabelEn: 'Vodafone Cash Wallet Number:',
      isActive: cfg.vodafone?.isActive ?? true
    },
    {
      id: 'binance',
      nameAr: 'Binance Pay (باينانس)',
      nameEn: 'Binance Pay',
      badge: 'PAY',
      icon: 'bitcoin',
      color: 'bg-amber-500',
      accountNumber: cfg.binance?.payId || '894642115',
      instructionsAr: cfg.binance?.instructionsAr || 'افتح تطبيق باينانس واكتب معرف Binance Pay ID ثم ارفع لقطة الشاشة للتأكيد.',
      instructionsEn: cfg.binance?.instructionsEn || 'Open Binance App and send funds via Pay ID then attach payment screenshot.',
      detailLabelAr: 'معرف باينانس باي (Binance Pay ID):',
      detailLabelEn: 'Binance Pay ID:',
      isActive: cfg.binance?.isActive ?? true
    },
    {
      id: 'bnb',
      nameAr: 'تحويل BNB (للألعاب والبطاقات والاشتراكات)',
      nameEn: 'BNB Transfer (Top-ups, Cards & Subscriptions)',
      badge: 'BNB',
      icon: 'wallet',
      color: 'bg-amber-600',
      accountNumber: cfg.cryptoBnb?.address || '0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f',
      instructionsAr: cfg.cryptoBnb?.instructionsAr || 'طريقة تحويل عبر BNB معتمدة لكافة الأقسام (شحن الألعاب المباشر، متاجر التطبيقات، أكواد الألعاب، الاشتراكات، و Rewarble): قم بالتحويل إلى رابط المحفظة (0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f) ثم ارفع صورة إشعار التحويل للتأكيد.',
      instructionsEn: cfg.cryptoBnb?.instructionsEn || 'Approved BNB transfer method for all sections. Transfer to wallet address then upload receipt.',
      detailLabelAr: 'عنوان المحفظة (BEP20 / BSC Link):',
      detailLabelEn: 'Wallet Address (BEP20 Link):',
      isActive: cfg.cryptoBnb?.isActive ?? true
    },
    {
      id: 'paypal',
      nameAr: 'باي بال PayPal (تلقائي فوري)',
      nameEn: 'PayPal (Instant Auto)',
      badge: 'PP',
      icon: 'credit-card',
      color: 'bg-blue-600',
      accountNumber: cfg.paypal?.email || 'paypal@gsmteam.com',
      instructionsAr: 'ادخل المبلغ واضغط زر الدفع عبر PayPal لإتمام العملية تلقائياً.',
      instructionsEn: 'Enter amount and click PayPal button to pay instantly.',
      detailLabelAr: 'الدفع التلقائي المباشر عبر PayPal:',
      detailLabelEn: 'Direct PayPal Instant Payment:',
      isAutomaticPayPal: true,
      isActive: cfg.paypal?.isActive ?? true
    }
  ];
}

// Load config from Database (Setting table) with fallback to file
async function loadConfig(): Promise<CurrencyConfig> {
  let config: CurrencyConfig = { ...DEFAULT_CONFIG };
  try {
    const record = await prisma.setting.findUnique({
      where: { key: 'currencies_config' }
    });
    if (record && record.value) {
      const parsed = JSON.parse(record.value);
      config = { ...DEFAULT_CONFIG, ...parsed };
    } else {
      config = readConfigFile();
    }
  } catch (err) {
    config = readConfigFile();
  }

  if (!Array.isArray(config.paymentMethods) || config.paymentMethods.length === 0) {
    config.paymentMethods = buildDefaultPaymentMethods(config);
  } else {
    const defaults = buildDefaultPaymentMethods(config);
    const existingIds = new Set(config.paymentMethods.map(m => m.id));
    for (const def of defaults) {
      if (!existingIds.has(def.id)) {
        config.paymentMethods.push(def);
      }
    }
  }

  return config;
}

// Save config to Database (Setting table) and local file as backup
async function saveConfig(config: CurrencyConfig): Promise<boolean> {
  writeConfigFile(config);
  try {
    await prisma.setting.upsert({
      where: { key: 'currencies_config' },
      update: { value: JSON.stringify(config, null, 2) },
      create: { key: 'currencies_config', value: JSON.stringify(config, null, 2) }
    });
    return true;
  } catch (err) {
    console.error('Failed to persist currencies in database:', err);
    return false;
  }
}

// GET /api/currencies - Public & Authenticated endpoint to get current exchange rates & bank details
router.get('/', async (req, res) => {
  const config = await loadConfig();
  res.json({ success: true, config });
});

// POST /api/currencies - Admin endpoint to update currency rates and payment settings
router.post('/', isAdmin, async (req, res) => {
  try {
    const current = await loadConfig();
    const {
      usdToSdg,
      usdToEgp,
      usdToSar,
      usdToAed,
      bankak,
      fawry,
      vodafone,
      binance,
      cryptoBnb,
      paypal,
      paymentMethods
    } = req.body;

    let updatedPaymentMethods: PaymentMethodItem[] = Array.isArray(paymentMethods)
      ? paymentMethods
      : (current.paymentMethods || buildDefaultPaymentMethods(current));

    const updatedBankak = bankak ? { ...current.bankak, ...bankak } : current.bankak;
    const updatedFawry = fawry ? { ...(current.fawry || DEFAULT_CONFIG.fawry), ...fawry } : current.fawry;
    const updatedVodafone = vodafone ? { ...current.vodafone, ...vodafone } : current.vodafone;
    const updatedBinance = binance ? { ...current.binance, ...binance } : current.binance;
    const updatedCryptoBnb = cryptoBnb ? { ...current.cryptoBnb, ...cryptoBnb } : current.cryptoBnb;
    const updatedPaypal = paypal ? { ...current.paypal, ...paypal } : current.paypal;

    if (Array.isArray(paymentMethods)) {
      const bankakFromMethods = paymentMethods.find(m => m.id === 'bankak');
      if (bankakFromMethods) {
        updatedBankak.accountNumber = bankakFromMethods.accountNumber || updatedBankak.accountNumber;
        updatedBankak.accountName = bankakFromMethods.accountName || updatedBankak.accountName;
        updatedBankak.instructionsAr = bankakFromMethods.instructionsAr || updatedBankak.instructionsAr;
        updatedBankak.instructionsEn = bankakFromMethods.instructionsEn || updatedBankak.instructionsEn;
        updatedBankak.isActive = bankakFromMethods.isActive ?? updatedBankak.isActive;
      }

      const fawryFromMethods = paymentMethods.find(m => m.id === 'fawry');
      if (fawryFromMethods && updatedFawry) {
        updatedFawry.accountNumber = fawryFromMethods.accountNumber || updatedFawry.accountNumber;
        updatedFawry.accountName = fawryFromMethods.accountName || updatedFawry.accountName;
        updatedFawry.instructionsAr = fawryFromMethods.instructionsAr || updatedFawry.instructionsAr;
        updatedFawry.instructionsEn = fawryFromMethods.instructionsEn || updatedFawry.instructionsEn;
        updatedFawry.isActive = fawryFromMethods.isActive ?? updatedFawry.isActive;
      }

      const vodafoneFromMethods = paymentMethods.find(m => m.id === 'vodafone');
      if (vodafoneFromMethods) {
        updatedVodafone.walletNumber = vodafoneFromMethods.accountNumber || updatedVodafone.walletNumber;
        updatedVodafone.instructionsAr = vodafoneFromMethods.instructionsAr || updatedVodafone.instructionsAr;
        updatedVodafone.instructionsEn = vodafoneFromMethods.instructionsEn || updatedVodafone.instructionsEn;
        updatedVodafone.isActive = vodafoneFromMethods.isActive ?? updatedVodafone.isActive;
      }

      const binanceFromMethods = paymentMethods.find(m => m.id === 'binance');
      if (binanceFromMethods) {
        updatedBinance.payId = binanceFromMethods.accountNumber || updatedBinance.payId;
        updatedBinance.instructionsAr = binanceFromMethods.instructionsAr || updatedBinance.instructionsAr;
        updatedBinance.instructionsEn = binanceFromMethods.instructionsEn || updatedBinance.instructionsEn;
        updatedBinance.isActive = binanceFromMethods.isActive ?? updatedBinance.isActive;
      }

      const bnbFromMethods = paymentMethods.find(m => m.id === 'bnb');
      if (bnbFromMethods) {
        updatedCryptoBnb.address = bnbFromMethods.accountNumber || updatedCryptoBnb.address;
        updatedCryptoBnb.instructionsAr = bnbFromMethods.instructionsAr || updatedCryptoBnb.instructionsAr;
        updatedCryptoBnb.instructionsEn = bnbFromMethods.instructionsEn || updatedCryptoBnb.instructionsEn;
        updatedCryptoBnb.isActive = bnbFromMethods.isActive ?? updatedCryptoBnb.isActive;
      }

      const paypalFromMethods = paymentMethods.find(m => m.id === 'paypal');
      if (paypalFromMethods) {
        updatedPaypal.email = paypalFromMethods.accountNumber || updatedPaypal.email;
        updatedPaypal.isActive = paypalFromMethods.isActive ?? updatedPaypal.isActive;
      }
    }

    const updatedConfig: CurrencyConfig = {
      usdToSdg: usdToSdg !== undefined ? Number(usdToSdg) : current.usdToSdg,
      usdToEgp: usdToEgp !== undefined ? Number(usdToEgp) : current.usdToEgp,
      usdToSar: usdToSar !== undefined ? Number(usdToSar) : current.usdToSar,
      usdToAed: usdToAed !== undefined ? Number(usdToAed) : current.usdToAed,
      bankak: updatedBankak,
      fawry: updatedFawry,
      vodafone: updatedVodafone,
      binance: updatedBinance,
      cryptoBnb: updatedCryptoBnb,
      paypal: updatedPaypal,
      paymentMethods: updatedPaymentMethods,
      updatedAt: new Date().toISOString()
    };

    await saveConfig(updatedConfig);

    return res.json({
      success: true,
      message: 'تم حفظ وتثبيت أسعار الصرف وطرق الدفع في قاعدة البيانات بنجاح!',
      config: updatedConfig
    });
  } catch (error: any) {
    console.error('Error updating currency config:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء حفظ الإعدادات في قاعدة البيانات' });
  }
});

export default router;
