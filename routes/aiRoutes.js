const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { getQuery, allQuery, runQuery } = require('../db');
const { getJwtSecret } = require('../utils/security');
const telegram = require('../utils/telegramService');

// Optional Customer Auth Middleware for AI chat & tickets
const optionalCustomerAuth = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      if (token) {
        const decoded = jwt.verify(token, getJwtSecret());
        if (decoded && decoded.role === 'customer') {
          req.customer = decoded;
          req.user = decoded;
        }
      }
    }
  } catch (e) {
    // Ignore invalid token and proceed as guest
  }
  next();
};

// Cache IMEI services in memory for fast searching
let imeiServices = [];
try {
  const imeiPath = path.join(__dirname, '../imei_response.json');
  if (fs.existsSync(imeiPath)) {
    const rawData = JSON.parse(fs.readFileSync(imeiPath, 'utf8'));
    if (rawData && rawData.SUCCESS && rawData.SUCCESS[0] && rawData.SUCCESS[0].LIST) {
      const list = rawData.SUCCESS[0].LIST;
      for (const groupName in list) {
        const group = list[groupName];
        if (group.SERVICES) {
          for (const serviceId in group.SERVICES) {
            const service = group.SERVICES[serviceId];
            imeiServices.push({
              id: service.SERVICEID,
              name: service.SERVICENAME,
              credit: service.CREDIT,
              time: service.TIME,
              group: groupName,
            });
          }
        }
      }
    }
  }
} catch (error) {
  console.error('[AI Route] Error loading imei_response.json:', error);
}

// System prompt to define the AI's behavior
const SYSTEM_PROMPT = `
أنت المساعد الذكي والمتخصص في الدعم الفني وخدمة العملاء لمنصة "Arab Tech Server" (عرب تك سيرفر).
مهمتك الأساسية هي:
1. استقبال استفسارات وشكاوى وطلبات العملاء بكل لباقة واحترافية باللغة العربية (أو لغة العميل).
2. الاستماع للمشكلة وسؤال العميل بلطف عن أي تفاصيل ناقصة (مثل: رقم الطلب Order ID، نوع المشكلة، أو ما إذا كان يريد استرجاع رصيد أو تسريع طلب أو حل مشكلة في كود).
3. بمجرد أن يقدم العميل شكواه أو مشكلته أو طلب الاسترجاع، قم فوراً باستدعاء أداة 'submit_complaint' لرفع التذكرة وإرسال إشعار فوري إلى إدارة السيرفر على تيليجرام.
4. بعد استدعاء أداة 'submit_complaint'، زوّد العميل برقم التذكرة الناتج (Ticket ID) وأكد له أن التذكرة وصلت للإدارة وفريق الدعم على تيليجرام وسيقومون بمراجعتها والرد عليه في أسرع وقت.
5. الإجابة عن شروط الخدمة وسياسة الاسترجاع (أن الاسترجاع مضمون 100% إلى المحفظة في حال فشل السيرفر أو تعذر توفير الكود، أو إمكانية إلغاء الطلبات المعلقة المتأخرة).
6. البحث عن الخدمات والباقات والأسعار باستخدام أداة 'search_services'.
7. عرض رصيد المحفظة والطلبات للمستخدمين المسجلين فقط.

كن داعماً، سريع البديهة، واثقاً، ومحترفاً.
`;

const LANGUAGE_GUIDANCE = `
Understand Modern Standard Arabic, Egyptian Arabic, Sudanese Arabic, Gulf, Levantine and Maghrebi dialects, plus Arabizi, abbreviations, missing punctuation, typos and phonetic spelling. Infer the user's intent before answering, and ask for clarification only when the meaning is genuinely ambiguous. Reply in the same language and dialect style as the user. Normalize common spelling variants when searching services (for example اشتراك/اشتراكات, شات/تشات, جي بي تي/ChatGPT) and never claim a service is unavailable before searching the live catalog and packages.
`;

const SITE_CONTEXT = `
اسم الموقع الرسمي: Arab Tech Server (عرب تك سيرفر) لخدمات السيرفرات والأدوات وفتح الهواتف والشحن.
مصمم ومبرمج الموقع: Mina Samir — رقم التواصل: 01279301263. عند السؤال عن مصمم الموقع أو المبرمج أو المطور، اذكر هذه المعلومة كما هي.
الصفحات: الرئيسية https://arab-tech1.online/ | الخدمات https://arab-tech1.online/services | الطلبات https://arab-tech1.online/orders | المحفظة https://arab-tech1.online/wallet | الشروط وسياسة الاسترجاع https://arab-tech1.online/terms | تذكرة دعم جديدة https://arab-tech1.online/tickets/new | توثيق API https://arab-tech1.online/api-docs.
التواصل الرسمي: واتساب https://wa.me/249123667227 و https://wa.me/16728972935 | مجتمع واتساب https://chat.whatsapp.com/DINRDwU2lVjFcGRowxT3m5 | تيليجرام https://t.me/arabtechserveronline | البريد arabtechserver@gmail.com.
إذا أراد المستخدم فتح تذكرة دعم فني أو رفع شكوى، اجمع منه المشكلة ورقم الطلب واطلب 'submit_complaint' فوراً لإشعار الإدارة على تيليجرام.
`;

const tools = [
  {
    type: "function",
    function: {
      name: "submit_complaint",
      description: "Create a support ticket / complaint in the database and dispatch an instant priority alert directly to the administration team on Telegram.",
      parameters: {
        type: "object",
        required: ["subject", "details"],
        properties: {
          subject: { type: "string", description: "Brief title or summary of the issue/complaint" },
          details: { type: "string", description: "Comprehensive description of the customer problem or request" },
          order_id: { type: "string", description: "Order ID if related to a specific order (optional)" },
          customer_name: { type: "string", description: "Customer name or username" },
          customer_phone: { type: "string", description: "Customer phone or WhatsApp number" },
          customer_email: { type: "string", description: "Customer email address" },
          category: { type: "string", description: "Category of issue (e.g. استرجاع رصيد / تأخر تنفيذ / كود لا يعمل / شحن محفظة / استفسار عام)" },
          urgency: { type: "string", enum: ["عادية", "متوسطة", "عاجلة"], description: "Urgency level" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_customer_overview",
      description: "Get the authenticated customer's profile, wallet balance, and complete order history with statuses.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: "Get the current wallet balance of the user.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_latest_orders",
      description: "Get the 5 most recent orders for the user.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_services",
      description: "Search available IMEI and Server services by keyword.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search keyword (e.g., 'Realme', 'Xiaomi', 'iPhone Bypass')"
          }
        },
        required: ["query"]
      }
    }
  }
];

const CATALOG_WORDS = /(?:خدم|خدمة|خدمات|باقه|باقة|باقات|قسم|اقسام|أقسام|سعر|اسعار|أسعار|اشتراك|اشتراكات|متاح|متوفر|موجود|عندكم|عندكو|شراء|اشتر|service|package|category|price|subscription|available|have|buy)/i;
const CATALOG_STOP_WORDS = new Set([
  'هل', 'في', 'فيه', 'يوجد', 'عندكم', 'عندكو', 'عايز', 'اريد', 'أريد', 'محتاج', 'ممكن', 'طيب', 'طب',
  'خدمة', 'خدمات', 'باقه', 'باقة', 'باقات', 'بقات', 'البقات', 'قسم', 'اقسام', 'أقسام', 'سعر', 'اسعار', 'أسعار',
  'متاح', 'متاحة', 'موجود', 'موجودة', 'شراء', 'اشتري', 'عن', 'على', 'من', 'الى', 'إلى', 'اي', 'أي',
  'the', 'a', 'an', 'do', 'you', 'have', 'service', 'services', 'package', 'packages', 'category', 'price', 'buy'
]);

const CATALOG_ALIASES = new Map([
  ['هونر', 'honor'], ['هونور', 'honor'],
  ['هواوي', 'huawei'], ['شاومي', 'xiaomi'], ['شياومي', 'xiaomi'],
  ['سامسونج', 'samsung'], ['ايفون', 'iphone'], ['آيفون', 'iphone'],
  ['ريلمي', 'realme'], ['اوبو', 'oppo'], ['أوبو', 'oppo'],
  ['فيفو', 'vivo'], ['انفنكس', 'infinix'], ['تكنو', 'tecno'],
  ['ايكلاود', 'icloud'], ['آيكلاود', 'icloud']
]);

function normalizeCatalogWord(word) {
  let normalized = word;
  if (normalized.startsWith('و') && normalized.length > 3) normalized = normalized.slice(1);
  normalized = normalized.replace(/^ال(?=.{3,})/, '');
  return CATALOG_ALIASES.get(normalized) || normalized;
}

function getCatalogQuery(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[؟?!.,،:;()[\]{}"']/g, ' ')
    .split(/\s+/)
    .map(normalizeCatalogWord)
    .filter(word => word.length > 1 && !CATALOG_STOP_WORDS.has(word))
    .slice(0, 8)
    .join(' ');
}

function formatCatalogReply(results) {
  const lines = results.slice(0, 6).map(service => {
    const packages = Array.isArray(service.packages) ? service.packages.slice(0, 4) : [];
    const packageText = packages.length
      ? `\n${packages.map(pkg => `  - ${pkg.name || 'باقة'} — ${Number(pkg.price ?? pkg.usd_price ?? service.price ?? 0).toFixed(2)} USD`).join('\n')}`
      : '';
    return `• ${service.name} — ${Number(service.price || service.credit || 0).toFixed(2)} USD${service.category ? ` — قسم ${service.category}` : ''}${packageText}\n  [عرض وشراء الخدمة](${service.url})`;
  });
  return `وجدت هذه النتائج المتاحة في المتجر:\n${lines.join('\n')}`;
}

// Helper to send ticket notification to Telegram Admins
async function sendTicketTelegramNotification({ complaintId, customerName, email, phone, orderId, category, urgency, subject, details }) {
  try {
    const admins = await telegram.getAdminChatIds();
    const formattedDate = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
    const urgencyIcon = urgency === 'عاجلة' ? '🔴' : (urgency === 'متوسطة' ? '🟡' : '🟢');

    const tgMessage = 
      `🚨 *تذكرة دعم فني / شكوى جديدة #${complaintId}* 🚨\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *العميل:* \`${customerName || 'زائر'}\`\n` +
      (email ? `📧 *البريد:* \`${email}\`\n` : '') +
      (phone ? `📱 *الهاتف / واتساب:* \`${phone}\`\n` : '') +
      (orderId ? `📦 *رقم الطلب:* \`#${orderId}\`\n` : '') +
      (category ? `🏷️ *القسم:* *${category}*\n` : '') +
      `⚡ *الأولوية:* ${urgencyIcon} *${urgency || 'عادية'}*\n\n` +
      `📝 *عنوان التذكرة:*\n*${subject}*\n\n` +
      `📄 *تفاصيل المشكلة:*\n${details}\n\n` +
      `🕒 *التاريخ والوقت:* ${formattedDate}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 *تم الإنشاء بواسطة:* _Ared AI Smart Assistant_`;

    for (const adminId of admins) {
      await telegram.sendMessage(String(adminId), tgMessage).catch(err => {
        console.warn(`[Telegram Ticket] Failed sending to admin ${adminId}:`, err.message);
      });
    }
    return true;
  } catch (err) {
    console.error('[Telegram Ticket] Notification error:', err.message);
    return false;
  }
}

// Tool execution logic
async function executeToolCall(toolCall, customerId, guestInfo = {}) {
  const name = toolCall.function.name;
  let args = {};
  try {
    if (toolCall.function.arguments) args = JSON.parse(toolCall.function.arguments);
    if (name === 'submit_complaint') {
      const subject = String(args.subject || '').trim();
      const details = String(args.details || '').trim();
      if (!subject || !details) return { error: 'Subject and details are required' };

      const orderId = args.order_id ? Number.parseInt(args.order_id, 10) : null;
      const category = args.category || 'دعم فني عام';
      const urgency = args.urgency || 'متوسطة';

      // Insert into database
      const result = await runQuery(
        'INSERT INTO complaints (customer_id, order_id, subject, details, status) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [customerId || null, Number.isFinite(orderId) ? orderId : null, subject, details, 'open']
      );
      const complaintId = result?.id || result?.lastID || Date.now();

      // Retrieve customer info
      let customerName = args.customer_name || guestInfo.name || 'عميل الموقع';
      let customerEmail = args.customer_email || guestInfo.email || '';
      let customerPhone = args.customer_phone || guestInfo.phone || '';

      if (customerId) {
        const customer = await getQuery('SELECT username, email, phone FROM customers WHERE id = ?', [customerId]);
        if (customer) {
          customerName = customer.username || customerName;
          customerEmail = customer.email || customerEmail;
          customerPhone = customer.phone || customerPhone;
        }
      }

      // Send Instant Telegram Notification
      await sendTicketTelegramNotification({
        complaintId,
        customerName,
        email: customerEmail,
        phone: customerPhone,
        orderId,
        category,
        urgency,
        subject,
        details
      });

      return {
        success: true,
        complaint_id: complaintId,
        ticket_id: `#TICK-${complaintId}`,
        message: `تم تسجيل تذكرة الدعم بنجاح برقم #${complaintId} وتم إرسال الإشعار والتفاصيل كاملة للإدارة والدعم الفني على تيليجرام فورياً.`
      };
    }
  } catch (e) {
    console.error('[AI Tool] Error parsing arguments:', e);
  }

  try {
    if (name === 'get_customer_overview') {
      if (!customerId) return { customer: null, orders: [], note: 'User is not logged in.' };
      const customer = await getQuery('SELECT id, username, email, phone, balance FROM customers WHERE id = ?', [customerId]);
      const orders = await allQuery(`SELECT id, service_name, status, package_price, created_at, code, download_link FROM orders WHERE customer_id = ? ORDER BY id DESC`, [customerId]);
      return { customer: customer ? { username: customer.username, email: customer.email, phone: customer.phone, balance: Number(customer.balance || 0) } : null, orders: orders || [] };
    }
    if (name === 'get_wallet_balance') {
      if (!customerId) return { balance: 0, note: 'User is not logged in.' };
      const customer = await getQuery('SELECT balance FROM customers WHERE id = ?', [customerId]);
      return { balance: Number(customer?.balance || 0) };
    } 
    
    if (name === 'get_latest_orders') {
      if (!customerId) return { orders: [], note: 'User is not logged in.' };
      const orders = await allQuery(`
        SELECT id, service_name, status, package_price, created_at
        FROM orders
        WHERE customer_id = ?
        ORDER BY id DESC LIMIT 5
      `, [customerId]);
      return { orders };
    }

    if (name === 'search_services') {
      const query = String(args.query || '').toLowerCase().trim();
      if (!query) return { results: [] };
      const searchTerms = [...new Set(query.split(/\s+/).filter(word => word.length > 1))].slice(0, 8);

      const liveRows = await allQuery(`
        SELECT s.id, s.name, s.price, s.packages, s.category_id, c.name AS category_name
        FROM services s LEFT JOIN categories c ON c.id = s.category_id
        WHERE ${searchTerms.map(() => `(LOWER(s.name) LIKE ? OR LOWER(COALESCE(s.description, '')) LIKE ? OR LOWER(COALESCE(s.packages, '')) LIKE ? OR LOWER(COALESCE(s.fields, '')) LIKE ? OR LOWER(COALESCE(c.name, '')) LIKE ?)`).join(' OR ')}
        ORDER BY s.id DESC LIMIT 8
      `, searchTerms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`]));
      const results = (liveRows || []).map(s => {
        let packages = [];
        try { packages = typeof s.packages === 'string' ? JSON.parse(s.packages || '[]') : (s.packages || []); } catch {}
        const matchingPackages = packages.filter(pkg => searchTerms.some(term => JSON.stringify(pkg).toLowerCase().includes(term)));
        return { id: s.id, name: s.name, price: s.price, category: s.category_name, packages: matchingPackages.length ? matchingPackages : packages,
          url: `https://arab-tech1.online/service/${s.id}` };
      });
      if (results.length) return { results };
      const fallback = imeiServices.filter(s => s.name.toLowerCase().includes(query) || s.group.toLowerCase().includes(query)).slice(0, 5)
        .map(s => ({ ...s, url: `https://arab-tech1.online/service/${s.id}` }));
      return { results: fallback };
    }
  } catch (e) {
    console.error(`[AI Tool] Execution error for ${name}:`, e);
    return { error: 'Failed to execute tool' };
  }

  return { error: 'Tool not found' };
}

function makeHistory(history, message, reply) {
  const safeHistory = Array.isArray(history)
    ? history.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-20)
    : [];
  return [...safeHistory, { role: 'user', content: message }, { role: 'assistant', content: reply }];
}

function formatOrderStatus(status) {
  const labels = { pending: 'قيد الانتظار', processing: 'قيد التنفيذ', completed: 'مكتمل', rejected: 'مرفوض', cancelled: 'ملغي', canceled: 'ملغي', refunded: 'تم رد الرصيد' };
  return labels[String(status || '').toLowerCase()] || status || 'غير محدد';
}

async function buildLocalReply(message, customerId, guestInfo = {}) {
  const text = String(message || '').trim();
  const normalized = text.toLowerCase();

  // Handling complaints & refund requests locally if OpenRouter is unreachable
  if (/شكوى|تذكرة|مشكلة|استرجاع|استرداد|فلوس|تأخر|معلق|كود غلط|ticket|complaint|refund|issue/.test(normalized)) {
    const orderMatch = text.match(/#?(\d{3,7})/);
    const orderId = orderMatch ? orderMatch[1] : null;

    try {
      const toolRes = await executeToolCall({
        function: {
          name: 'submit_complaint',
          arguments: JSON.stringify({
            subject: text.slice(0, 80),
            details: text,
            order_id: orderId,
            customer_name: guestInfo.name,
            customer_phone: guestInfo.phone,
            customer_email: guestInfo.email,
            category: /استرجاع|استرداد|فلوس/.test(normalized) ? 'طلب استرجاع رصيد' : 'دعم فني وشكاوى'
          })
        }
      }, customerId, guestInfo);

      if (toolRes && toolRes.success) {
        return `✅ تم استلام شكواك وتسجيل تذكرة دعم فني برقم **#${toolRes.complaint_id}**.\n\n📲 **تم إرسال تفاصيل الشكوى فوراً إلى الإدارة عبر تيليجرام**.\nفريق الدعم الفني سيقوم بمراجعتها وحل المشكلة معك في أسرع وقت. يمكنك أيضاً متابعتنا على تيليجرام: https://t.me/arabtechserveronline`;
      }
    } catch (e) {
      console.error('[AI Local Ticket] Error:', e);
    }
    return `أهلاً بك! لقد استلمت تفاصيل مشكلتك وسنقوم برفع تذكرة دعم فني بها فوراً للإدارة عبر تيليجرام. إذا كان لديك رقم طلب أو تفاصيل إضافية يرجى تزويدنا بها.`;
  }

  if (/مصمم|مبرمج|مطور|مين عمل|developer|programmer|designer/.test(normalized)) return 'مصمم ومبرمج موقع Arab Tech Server هو Mina Samir، ورقم التواصل: 01279301263.';
  if (/تواصل|واتس|واتساب|تلجرام|تيليجرام|فيسبوك|رقمكم|contact/.test(normalized)) return 'قنوات التواصل الرسمية:\n• واتساب: https://wa.me/249123667227 أو https://wa.me/16728972935\n• تيليجرام: https://t.me/arabtechserveronline\n• فيسبوك: https://www.facebook.com/ARABTECHSERVEROnline\n• البريد: arabtechserver@gmail.com';
  if (/اسمي|اسم حسابي|مين انا|my name|username/.test(normalized)) {
    if (!customerId) return 'أنت تتحدث كزائر حالياً. يرجى تسجيل الدخول لعرض بيانات حسابك: https://arab-tech1.online/login';
    const customer = await getQuery('SELECT username FROM customers WHERE id = ?', [customerId]);
    return customer?.username ? `اسم حسابك هو: ${customer.username}` : 'تعذر العثور على بيانات حسابك.';
  }
  if (/رصيد|محفظ|balance|wallet/.test(normalized)) {
    if (!customerId) return 'لعرض رصيدك والشحن، يرجى تسجيل الدخول: https://arab-tech1.online/login';
    const customer = await getQuery('SELECT balance FROM customers WHERE id = ?', [customerId]);
    return `رصيد محفظتك الحالي: ${Number(customer?.balance || 0).toFixed(2)} USD\nشحن المحفظة: https://arab-tech1.online/wallet`;
  }
  if (/طلب|طلبات|order|اتعمل|اكتمل|لسه/.test(normalized)) {
    if (!customerId) return 'لعرض قائمة طلباتك وتتبعها، يرجى تسجيل الدخول: https://arab-tech1.online/login';
    const rows = await allQuery(`SELECT id, service_name, package_name, package_price, status, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 10`, [customerId]);
    if (!rows?.length) return 'لا توجد طلبات مسجلة على حسابك حتى الآن. تصفح الخدمات: https://arab-tech1.online/services';
    return `آخر طلباتك الفعلية:\n${rows.map(order => `• #${order.id} — ${order.service_name || 'خدمة'}${order.package_name ? ` / ${order.package_name}` : ''} — ${formatOrderStatus(order.status)} — ${Number(order.package_price || 0).toFixed(2)} USD`).join('\n')}\nكل الطلبات: https://arab-tech1.online/orders`;
  }
  const isGreeting = /^(مرحبا|مرحباً|اهلا|أهلا|السلام عليكم|الو|hello|hi)\s*[!.؟]*$/i.test(text);
  if (!isGreeting) {
    const terms = normalized.replace(/[؟?!.,،:;()[\]{}]/g, ' ').split(/\s+/).filter(word => word.length > 1 && !['هل', 'يوجد', 'عايز', 'اريد', 'خدمة', 'اشتراك', 'عندكم', 'متاح', 'موجود', 'في', 'عن', 'على', 'من', 'the', 'have', 'service'].includes(word));
    const result = await executeToolCall({ function: { name: 'search_services', arguments: JSON.stringify({ query: terms.slice(0, 6).join(' ') || normalized }) } }, customerId);
    if (!result?.results?.length && terms.length > 1) {
      const retries = await Promise.all(terms.slice(0, 4).map(term => executeToolCall({ function: { name: 'search_services', arguments: JSON.stringify({ query: term }) } }, customerId)));
      result.results = retries.flatMap(item => item?.results || []).filter((item, index, all) => all.findIndex(x => String(x.id) === String(item.id)) === index).slice(0, 8);
    }
    if (result?.results?.length) return `وجدت هذه الخدمات المتاحة فعلياً:\n${result.results.slice(0, 5).map(service => `• ${service.name} — ${Number(service.price || service.credit || 0).toFixed(2)} USD${service.category ? ` — ${service.category}` : ''}\n  ${service.url}`).join('\n')}`;
  }
  return 'أهلاً بك في الدعم الفني الذكي لمنصة Arab Tech Server. أستطيع مساعدتك في الاستفسار عن الخدمات والأسعار، ومتابعة الطلبات، أو رفع شكوى وتذكرة دعم فني مباشرة إلى الإدارة على تيليجرام. كيف يمكنني مساعدتك اليوم؟\nفتح تذكرة دعم: https://arab-tech1.online/tickets/new';
}

// Make call to OpenRouter API
async function callOpenRouter(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured in the backend.');
  }

  const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
  
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://arab-tech1.online', 
      'X-Title': 'Spider Store Front'
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      tools: tools,
      tool_choice: "auto",
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[AI Route] OpenRouter API Error:', errText);
    throw new Error(`OpenRouter API responded with status ${response.status}: ${errText.slice(0, 300)}`);
  }

  return await response.json();
}

/**
 * POST /api/ai/chat
 */
router.post('/chat', optionalCustomerAuth, async (req, res) => {
  try {
    const { history, message, guest_name, guest_email, guest_phone } = req.body;
    const customerId = req.customer?.id || req.user?.id || req.user?.customer_id;
    const guestInfo = {
      name: guest_name,
      email: guest_email,
      phone: guest_phone
    };

    if (!message) {
      return res.status(400).json({ message: 'Message is required' });
    }

    // Product discovery must not depend on whether the language model decides to call a tool.
    if (CATALOG_WORDS.test(String(message))) {
      const catalogQuery = getCatalogQuery(message) || String(message).trim();
      const catalogResult = await executeToolCall({
        function: { name: 'search_services', arguments: JSON.stringify({ query: catalogQuery }) }
      }, customerId, guestInfo);
      if (catalogResult?.results?.length) {
        const reply = formatCatalogReply(catalogResult.results);
        return res.json({ reply, history: makeHistory(history, message, reply), catalog_search: true });
      }
    }

    const customer = customerId
      ? await getQuery('SELECT id, username, email, phone FROM customers WHERE id = ?', [customerId])
      : null;
    const userContext = customer
      ? `\nحالة المستخدم: مسجل دخول ومصادق عليه. اسم المستخدم: ${customer.username || customer.name || 'غير محدد'}. البريد: ${customer.email || ''}. الهاتف: ${customer.phone || ''}. إذا طلب رفع شكوى استخدم بيانات حسابه.\n`
      : `\nحالة المستخدم: زائر / غير مسجل دخول.${guest_name ? ` اسم الزائر: ${guest_name}.` : ''}${guest_phone ? ` هاتف الزائر: ${guest_phone}.` : ''}\n`;

    // Construct messages array
    const messages = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n${LANGUAGE_GUIDANCE}\n${SITE_CONTEXT}${userContext}` }
    ];

    if (Array.isArray(history)) {
      messages.push(...history);
    }

    messages.push({ role: 'user', content: message });

    // 1st API Call
    let openRouterResponse;
    try {
      openRouterResponse = await callOpenRouter(messages);
    } catch (e) {
      console.warn('[AI Chat] OpenRouter call failed or key not set, using smart local assistant:', e.message);
      const reply = await buildLocalReply(message, customerId, guestInfo);
      return res.json({ reply, history: makeHistory(history, message, reply), fallback: true });
    }

    let responseMessage = openRouterResponse?.choices?.[0]?.message;
    if (!responseMessage) throw new Error('AI provider returned an empty response');

    // Handle tool calls if any
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      messages.push(responseMessage); // Add assistant's tool call request

      for (const toolCall of responseMessage.tool_calls) {
        const toolResult = await executeToolCall(toolCall, customerId, guestInfo);
        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: JSON.stringify(toolResult)
        });
      }

      // 2nd API Call with tool results
      try {
        openRouterResponse = await callOpenRouter(messages);
      } catch (e) {
        console.error('[AI Chat] Provider failed after tool call, using local assistant:', e.message);
        const reply = await buildLocalReply(message, customerId, guestInfo);
        return res.json({ reply, history: makeHistory(history, message, reply), fallback: true });
      }
      responseMessage = openRouterResponse?.choices?.[0]?.message;
      if (!responseMessage) throw new Error('AI provider returned an empty tool response');
    }

    // Final response to frontend
    res.json({
      reply: responseMessage.content,
      history: [...messages.filter(m => m.role !== 'system' && m.role !== 'tool' && !m.tool_calls), { role: 'assistant', content: responseMessage.content }]
    });

  } catch (error) {
    console.error('[AI Chat] Error:', error);
    try {
      const { history, message, guest_name, guest_email, guest_phone } = req.body || {};
      const reply = await buildLocalReply(message, req.customer?.id || req.user?.id, { name: guest_name, email: guest_email, phone: guest_phone });
      res.json({ reply, history: makeHistory(history, message, reply), fallback: true });
    } catch (fallbackError) {
      console.error('[AI Chat] Local fallback error:', fallbackError);
      res.status(503).json({ reply: 'المساعد الذكي غير متاح مؤقتاً. تواصل مع الدعم الفني مباشرة عبر تليجرام: https://t.me/arabtechserveronline أو واتساب: +16728972935' });
    }
  }
});

/**
 * POST /api/ai/tickets — Direct Support Ticket creation & instant Telegram alert
 */
router.post('/tickets', optionalCustomerAuth, async (req, res) => {
  try {
    const { subject, details, order_id, name, email, phone, category, urgency } = req.body;
    const customerId = req.customer?.id || req.user?.id || null;

    if (!subject || !details) {
      return res.status(400).json({ message: 'عنوان التذكرة وتفاصيل المشكلة مطلوبان.' });
    }

    let customerName = name || 'عميل';
    let customerEmail = email || '';
    let customerPhone = phone || '';

    if (customerId) {
      const customer = await getQuery('SELECT username, email, phone FROM customers WHERE id = ?', [customerId]);
      if (customer) {
        customerName = customer.username || customerName;
        customerEmail = customer.email || customerEmail;
        customerPhone = customer.phone || customerPhone;
      }
    }

    const orderId = order_id ? Number.parseInt(order_id, 10) : null;
    const cleanUrgency = urgency || 'متوسطة';
    const cleanCategory = category || 'دعم فني عام';

    // Insert into DB
    const result = await runQuery(
      'INSERT INTO complaints (customer_id, order_id, subject, details, status) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [customerId, Number.isFinite(orderId) ? orderId : null, subject.trim(), details.trim(), 'open']
    );
    const complaintId = result?.id || result?.lastID || Date.now();

    // Send Instant Telegram Notification
    const tgSent = await sendTicketTelegramNotification({
      complaintId,
      customerName,
      email: customerEmail,
      phone: customerPhone,
      orderId,
      category: cleanCategory,
      urgency: cleanUrgency,
      subject: subject.trim(),
      details: details.trim()
    });

    return res.status(201).json({
      success: true,
      ticket_id: `#TICK-${complaintId}`,
      complaint_id: complaintId,
      telegram_sent: tgSent,
      message: `تم فتح تذكرة الدعم الفني بنجاح برقم #${complaintId} وتم إشعار فريق الدعم والإدارة على تيليجرام.`
    });
  } catch (error) {
    console.error('[AI Tickets] Error creating ticket:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء تذكرة الدعم الفني.' });
  }
});

/**
 * GET /api/ai/tickets — Get tickets of logged in customer
 */
router.get('/tickets', optionalCustomerAuth, async (req, res) => {
  try {
    const customerId = req.customer?.id || req.user?.id;
    if (!customerId) {
      return res.status(401).json({ message: 'يرجى تسجيل الدخول لعرض تذاكرك السابقة.' });
    }

    const tickets = await allQuery(
      'SELECT id, order_id, subject, details, status, created_at FROM complaints WHERE customer_id = ? ORDER BY id DESC LIMIT 50',
      [customerId]
    );

    return res.json(tickets || []);
  } catch (error) {
    console.error('[AI Tickets] Error fetching tickets:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب تذاكر الدعم.' });
  }
});

module.exports = router;
