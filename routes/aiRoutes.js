const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getQuery, allQuery, runQuery } = require('../db');
const customerAuth = require('../middleware/customerAuth');
const telegram = require('../utils/telegramService');

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
أنت مساعد ذكي واحترافي لموقع إلكتروني مخصص لبيع خدمات IMEI وسيرفرات لفتح الهواتف والشحن.
مهمتك هي مساعدة المستخدمين بكل احترافية وسرعة. يمكنك التحدث باللغة العربية بطلاقة.
بناءً على طلب المستخدم، يمكنك:
1. جلب رصيد محفظته الحالي.
2. جلب آخر طلباته وحالتها.
3. البحث عن الخدمات المتاحة (IMEI/Server) وعرض أسعارها والوقت المتوقع لإنجازها.

إذا سأل المستخدم عن خدمة، استخدم أداة 'search_services' للبحث عن الكلمات المفتاحية وتقديم أنسب الخيارات.
إذا سأل عن رصيده أو طلباته، استخدم 'get_wallet_balance' أو 'get_latest_orders'.

كن ودوداً، مختصراً، واحترافياً. استخدم التنسيق المناسب لعرض المعلومات.
`;

const LANGUAGE_GUIDANCE = `
Understand Modern Standard Arabic, Egyptian Arabic, Sudanese Arabic, Gulf, Levantine and Maghrebi dialects, plus Arabizi, abbreviations, missing punctuation, typos and phonetic spelling. Infer the user's intent before answering, and ask for clarification only when the meaning is genuinely ambiguous. Reply in the same language and dialect style as the user. Normalize common spelling variants when searching services (for example اشتراك/اشتراكات, شات/تشات, جي بي تي/ChatGPT) and never claim a service is unavailable before searching the live catalog and packages.
`;

const SITE_CONTEXT = `
اسم الموقع الرسمي: Arab Tech Server (ويقدم خدمات IMEI & Server Solutions وفتح الهواتف).
مصمم ومبرمج الموقع: Mina Samir — رقم التواصل: 01279301263. عند السؤال عن مصمم الموقع أو المبرمج أو المطور، اذكر هذه المعلومة كما هي.
الصفحات: الرئيسية https://arab-tech1.online/ | الخدمات https://arab-tech1.online/services | الطلبات https://arab-tech1.online/orders | المحفظة https://arab-tech1.online/wallet | التسجيل/الدخول https://arab-tech1.online/login | توثيق API https://arab-tech1.online/api-docs.
التواصل الرسمي: واتساب https://wa.me/249123667227 و https://wa.me/16728972935 | مجتمع واتساب https://chat.whatsapp.com/DINRDwU2lVjFcGRowxT3m5 | تيليجرام https://t.me/arabtechserveronline | فيسبوك https://www.facebook.com/ARABTECHSERVEROnline | تيك توك https://tiktok.com/@arabtechsuppurt | يوتيوب https://youtube.com/@arab-tech-server | البريد arabtechserver@gmail.com.
عرّف المستخدم بالخدمات باستخدام search_services ولا تخترع سعراً أو مدة. الرصيد والطلبات معلومات خاصة. وجّه غير المسجل إلى رابط التسجيل/الدخول.
عند سؤال المستخدم عن أي خدمة أو باقة، استخدم search_services أولاً. إذا لم تُرجع الأداة نتيجة، قل بوضوح إن الخدمة غير موجودة حالياً ولا تقل إنها موجودة. إذا وُجدت نتيجة، اعرض الاسم والسعر والقسم والباقة والرابط المباشر كما وردت من الأداة.
عند سؤال المستخدم عن اسمه أو حسابه أو جميع طلباته أو ما اكتمل وما يزال قيد التنفيذ، استخدم get_customer_overview واعرض البيانات الفعلية كاملة مع الحالة والتاريخ، ولا تعتمد على الذاكرة أو التخمين.
إذا قدم المستخدم شكوى أو مشكلة، اجمع عنواناً وتفاصيل واضحة ورقم الطلب إن ذكره، ثم استخدم submit_complaint. أعطه رقم الشكوى بعد نجاح التسجيل وأخبره أنها أُرسلت للدعم عبر تيليجرام.
`;

const tools = [
  {
    type: "function",
    function: {
      name: "submit_complaint",
      description: "Create a complaint for the authenticated customer and notify the super admin on Telegram.",
      parameters: { type: "object", required: ["subject", "details"], properties: {
        subject: { type: "string" }, details: { type: "string" }, order_id: { type: "string" }
      }}
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

// Tool execution logic
async function executeToolCall(toolCall, customerId) {
  const name = toolCall.function.name;
  let args = {};
  try {
    if (toolCall.function.arguments) args = JSON.parse(toolCall.function.arguments);
    if (name === 'submit_complaint') {
      const subject = String(args.subject || '').trim();
      const details = String(args.details || '').trim();
      if (!subject || !details) return { error: 'Subject and details are required' };
      const orderId = args.order_id ? Number.parseInt(args.order_id, 10) : null;
      const result = await runQuery('INSERT INTO complaints (customer_id, order_id, subject, details) VALUES (?, ?, ?, ?) RETURNING id', [customerId, Number.isFinite(orderId) ? orderId : null, subject, details]);
      const complaintId = result?.id || result?.lastID;
      const customer = await getQuery('SELECT username, email, phone FROM customers WHERE id = ?', [customerId]);
      const admins = await telegram.getAdminChatIds();
      const text = `📣 *شكوى جديدة #${complaintId}*\n👤 العميل: ${customer?.username || customerId}\n📧 ${customer?.email || ''}\n📱 ${customer?.phone || ''}\n📦 الطلب: ${orderId || 'غير محدد'}\n📝 *${subject}*\n${details}`;
      for (const adminId of admins) await telegram.sendMessage(String(adminId), text).catch(() => {});
      return { success: true, complaint_id: complaintId, message: `تم تسجيل الشكوى برقم #${complaintId} وإرسالها للدعم.` };
    }
  } catch (e) {
    console.error('[AI Tool] Error parsing arguments:', e);
  }

  try {
    if (name === 'get_customer_overview') {
      const customer = await getQuery('SELECT id, username, email, phone, balance FROM customers WHERE id = ?', [customerId]);
      const orders = await allQuery(`SELECT id, service_name, status, package_price, created_at, code, download_link FROM orders WHERE customer_id = ? ORDER BY id DESC`, [customerId]);
      return { customer: customer ? { username: customer.username, email: customer.email, phone: customer.phone, balance: Number(customer.balance || 0) } : null, orders: orders || [] };
    }
    if (name === 'get_wallet_balance') {
      const customer = await getQuery('SELECT balance FROM customers WHERE id = ?', [customerId]);
      return { balance: Number(customer?.balance || 0) };
    } 
    
    if (name === 'get_latest_orders') {
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

      // Search the live catalog (services, categories and packages), not only the imported IMEI snapshot.
      const liveRows = await allQuery(`
        SELECT s.id, s.name, s.price, s.packages, s.category_id, c.name AS category_name
        FROM services s LEFT JOIN categories c ON c.id = s.category_id
        WHERE ${searchTerms.map(() => `(LOWER(s.name) LIKE ? OR LOWER(COALESCE(s.description, '')) LIKE ? OR LOWER(COALESCE(s.packages, '')) LIKE ? OR LOWER(COALESCE(s.fields, '')) LIKE ? OR LOWER(COALESCE(c.name, '')) LIKE ?)`).join(' OR ')}
        ORDER BY s.id DESC LIMIT 8
      `, searchTerms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`)]);
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

async function buildLocalReply(message, customerId) {
  const text = String(message || '').trim();
  const normalized = text.toLowerCase();
  if (/مصمم|مبرمج|مطور|مين عمل|developer|programmer|designer/.test(normalized)) return 'مصمم ومبرمج موقع Arab Tech Server هو Mina Samir، ورقم التواصل: 01279301263.';
  if (/تواصل|واتس|واتساب|تلجرام|تيليجرام|فيسبوك|رقمكم|contact/.test(normalized)) return 'قنوات التواصل الرسمية:\n• واتساب: https://wa.me/249123667227 أو https://wa.me/16728972935\n• تيليجرام: https://t.me/arabtechserveronline\n• فيسبوك: https://www.facebook.com/ARABTECHSERVEROnline\n• البريد: arabtechserver@gmail.com';
  if (/اسمي|اسم حسابي|مين انا|my name|username/.test(normalized)) {
    const customer = await getQuery('SELECT username FROM customers WHERE id = ?', [customerId]);
    return customer?.username ? `اسم حسابك هو: ${customer.username}` : 'تعذر العثور على بيانات حسابك.';
  }
  if (/رصيد|محفظ|balance|wallet/.test(normalized)) {
    const customer = await getQuery('SELECT balance FROM customers WHERE id = ?', [customerId]);
    return `رصيد محفظتك الحالي: ${Number(customer?.balance || 0).toFixed(2)} USD\nشحن المحفظة: https://arab-tech1.online/wallet`;
  }
  if (/طلب|طلبات|order|اتعمل|اكتمل|لسه/.test(normalized)) {
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
  return 'أهلاً بك في Arab Tech Server. أستطيع البحث في الخدمات الفعلية، وعرض رصيدك وطلباتك وحالتها. اكتب اسم الخدمة التي تريدها أو اسألني عن رصيدك أو طلباتك.\nالخدمات: https://arab-tech1.online/services';
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
router.post('/chat', customerAuth, async (req, res) => {
  try {
    const { history, message } = req.body;
    const customerId = req.user?.id || req.user?.customer_id;

    if (!message) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const customer = customerId
      ? await getQuery('SELECT id, username, email, phone FROM customers WHERE id = ?', [customerId])
      : null;
    const userContext = customer
      ? `\nحالة المستخدم: مسجل دخول ومصادق عليه. اسم المستخدم: ${customer.username || customer.name || 'غير محدد'}. لا تطلب منه التسجيل أو تسجيل الدخول. إذا سأل عن هويته، اذكر اسم المستخدم كما هو.\n`
      : '\nحالة المستخدم: غير مسجل. لا تعرض بيانات الرصيد أو الطلبات الخاصة.\n';

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
      if (e.message.includes('not configured')) {
        return res.json({ 
          reply: 'عذراً، لم يتم إعداد مفتاح API الخاص بـ OpenRouter بعد. يرجى إضافته في إعدادات النظام.',
          history: [...(history || []), { role: 'user', content: message }, { role: 'assistant', content: 'عذراً، لم يتم إعداد مفتاح API الخاص بـ OpenRouter بعد.' }]
        });
      }
      console.error('[AI Chat] Provider unavailable, using local assistant:', e.message);
      const reply = await buildLocalReply(message, customerId);
      return res.json({ reply, history: makeHistory(history, message, reply), fallback: true });
    }

    let responseMessage = openRouterResponse?.choices?.[0]?.message;
    if (!responseMessage) throw new Error('AI provider returned an empty response');

    // Handle tool calls if any
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      messages.push(responseMessage); // Add assistant's tool call request

      for (const toolCall of responseMessage.tool_calls) {
        const toolResult = await executeToolCall(toolCall, customerId);
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
        const reply = await buildLocalReply(message, customerId);
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
      const { history, message } = req.body || {};
      const reply = await buildLocalReply(message, req.user?.id || req.user?.customer_id);
      res.json({ reply, history: makeHistory(history, message, reply), fallback: true });
    } catch (fallbackError) {
      console.error('[AI Chat] Local fallback error:', fallbackError);
      res.status(503).json({ reply: 'المساعد غير متاح مؤقتاً. تواصل معنا عبر https://t.me/arabtechserveronline' });
    }
  }
});

module.exports = router;
