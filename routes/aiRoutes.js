const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getQuery, allQuery } = require('../db');
const customerAuth = require('../middleware/customerAuth');

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

const SITE_CONTEXT = `
اسم الموقع الرسمي: Arab Tech Server (ويقدم خدمات IMEI & Server Solutions وفتح الهواتف).
الصفحات: الرئيسية https://arab-tech1.online/ | الخدمات https://arab-tech1.online/services | الطلبات https://arab-tech1.online/orders | المحفظة https://arab-tech1.online/wallet | التسجيل/الدخول https://arab-tech1.online/login | توثيق API https://arab-tech1.online/api-docs.
التواصل الرسمي: واتساب https://wa.me/249123667227 و https://wa.me/16728972935 | مجتمع واتساب https://chat.whatsapp.com/DINRDwU2lVjFcGRowxT3m5 | تيليجرام https://t.me/arabtechserveronline | فيسبوك https://www.facebook.com/ARABTECHSERVEROnline | تيك توك https://tiktok.com/@arabtechsuppurt | يوتيوب https://youtube.com/@arab-tech-server | البريد arabtechserver@gmail.com.
عرّف المستخدم بالخدمات باستخدام search_services ولا تخترع سعراً أو مدة. الرصيد والطلبات معلومات خاصة. وجّه غير المسجل إلى رابط التسجيل/الدخول.
عند سؤال المستخدم عن أي خدمة أو باقة، استخدم search_services أولاً. إذا لم تُرجع الأداة نتيجة، قل بوضوح إن الخدمة غير موجودة حالياً ولا تقل إنها موجودة. إذا وُجدت نتيجة، اعرض الاسم والسعر والقسم والباقة والرابط المباشر كما وردت من الأداة.
عند سؤال المستخدم عن اسمه أو حسابه أو جميع طلباته أو ما اكتمل وما يزال قيد التنفيذ، استخدم get_customer_overview واعرض البيانات الفعلية كاملة مع الحالة والتاريخ، ولا تعتمد على الذاكرة أو التخمين.
`;

const tools = [
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
    if (toolCall.function.arguments) {
      args = JSON.parse(toolCall.function.arguments);
    }
  } catch (e) {
    console.error('[AI Tool] Error parsing arguments:', e);
  }

  try {
    if (name === 'get_customer_overview') {
      const customer = await getQuery('SELECT id, username, name, email, phone, balance FROM customers WHERE id = ?', [customerId]);
      const orders = await allQuery(`SELECT id, service_name, status, price, created_at, completed_at, rejection_reason FROM orders WHERE customer_id = ? ORDER BY id DESC`, [customerId]);
      return { customer: customer ? { username: customer.username, name: customer.name, email: customer.email, phone: customer.phone, balance: Number(customer.balance || 0) } : null, orders: orders || [] };
    }
    if (name === 'get_wallet_balance') {
      const customer = await getQuery('SELECT balance FROM customers WHERE id = ?', [customerId]);
      return { balance: Number(customer?.balance || 0) };
    } 
    
    if (name === 'get_latest_orders') {
      const orders = await allQuery(`
        SELECT id, service_name, status, price, created_at
        FROM orders
        WHERE customer_id = ?
        ORDER BY id DESC LIMIT 5
      `, [customerId]);
      return { orders };
    }

    if (name === 'search_services') {
      const query = (args.query || '').toLowerCase();
      if (!query) return { results: [] };

      // Search the live catalog (services, categories and packages), not only the imported IMEI snapshot.
      const liveRows = await allQuery(`
        SELECT s.id, s.name, s.price, s.packages, s.category_id, c.name AS category_name
        FROM services s LEFT JOIN categories c ON c.id = s.category_id
        WHERE LOWER(s.name) LIKE ? OR LOWER(COALESCE(s.description, '')) LIKE ? OR LOWER(COALESCE(c.name, '')) LIKE ?
        ORDER BY s.id DESC LIMIT 20
      `, [`%${query}%`, `%${query}%`, `%${query}%`]);
      const results = (liveRows || []).map(s => {
        let packages = [];
        try { packages = typeof s.packages === 'string' ? JSON.parse(s.packages || '[]') : (s.packages || []); } catch {}
        return { id: s.id, name: s.name, price: s.price, category: s.category_name, packages,
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
    throw new Error(`OpenRouter API responded with status ${response.status}`);
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
      ? await getQuery('SELECT id, username, name, email, phone FROM customers WHERE id = ?', [customerId])
      : null;
    const userContext = customer
      ? `\nحالة المستخدم: مسجل دخول ومصادق عليه. اسم المستخدم: ${customer.username || customer.name || 'غير محدد'}. لا تطلب منه التسجيل أو تسجيل الدخول. إذا سأل عن هويته، اذكر اسم المستخدم كما هو.\n`
      : '\nحالة المستخدم: غير مسجل. لا تعرض بيانات الرصيد أو الطلبات الخاصة.\n';

    // Construct messages array
    const messages = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n${SITE_CONTEXT}${userContext}` }
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
      throw e;
    }

    let responseMessage = openRouterResponse.choices[0].message;

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
      openRouterResponse = await callOpenRouter(messages);
      responseMessage = openRouterResponse.choices[0].message;
    }

    // Final response to frontend
    res.json({
      reply: responseMessage.content,
      history: [...messages.filter(m => m.role !== 'system' && m.role !== 'tool' && !m.tool_calls), { role: 'assistant', content: responseMessage.content }]
    });

  } catch (error) {
    console.error('[AI Chat] Error:', error);
    res.status(500).json({ reply: 'حدث خطأ أثناء التواصل مع المساعد الذكي. يرجى المحاولة لاحقاً.' });
  }
});

module.exports = router;
