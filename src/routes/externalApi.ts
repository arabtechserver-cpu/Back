import { parseProviderParameters } from '../utils/provider-api-parameters';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../utils/prisma';
import { sendTelegramPhotoNotification, escapeHtml } from '../utils/telegramService';
import { resolveOrderServiceType } from '../utils/order-response';

const router = Router();

const externalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: {
    SUCCESS: [{
      ERROR: "Too many requests. Rate limit exceeded, please try again in a minute."
    }]
  },
  validate: { xForwardedForHeader: false }
});

router.use(externalApiLimiter);

// Middleware to authenticate API requests with username and API key or Bearer token
export const authenticateApi = async (req: any, res: any, next: any) => {
  try {
    const authHeader = (req.headers['authorization'] || '').toString().trim();
    let bearerToken = '';
    if (authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')) {
      bearerToken = authHeader.slice(7).trim();
    }

    const apiKey = (
      bearerToken ||
      req.body?.apiaccesskey ||
      req.body?.key ||
      req.body?.apiKey ||
      req.query?.apiaccesskey ||
      req.query?.key ||
      req.headers['x-api-key'] ||
      ''
    ).toString().trim();

    const username = (
      req.body?.username ||
      req.query?.username ||
      req.headers['x-username'] ||
      ''
    ).toString().trim();

    if (!apiKey && !username) {
      return res.status(401).json({
        SUCCESS: [{
          ERROR: "Invalid authentication. Please provide API key or Bearer token."
        }]
      });
    }

    let user = null;
    if (apiKey && username) {
      user = await prisma.user.findFirst({
        where: {
          OR: [
            { username: { equals: username, mode: 'insensitive' } },
            { email: { equals: username, mode: 'insensitive' } }
          ],
          apiKey: apiKey,
          apiEnabled: true
        }
      });
    } else if (apiKey) {
      user = await prisma.user.findFirst({
        where: {
          apiKey: apiKey,
          apiEnabled: true
        }
      });
    }

    if (!user) {
      return res.status(401).json({
        SUCCESS: [{
          ERROR: "Authentication failed or API access is disabled for this account."
        }]
      });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({
        SUCCESS: [{
          ERROR: "Account is suspended. API access is blocked."
        }]
      });
    }

    req.apiUser = user;
    next();
  } catch (error: any) {
    console.error("API auth error:", error?.message || error);
    return res.status(500).json({
      SUCCESS: [{
        ERROR: "Internal Server Error during API authentication: " + (error?.message || "")
      }]
    });
  }
};

export async function getUnifiedSectionsStats(user?: any) {
  const activeServices = await prisma.dhruService.findMany({
    where: {
      isActive: true,
      OR: [
        { apiProvider: { isActive: true } },
        { providerId: null }
      ]
    },
    include: {
      dhruCategory: { select: { name: true } }
    }
  });

  const imeiGroups = new Set<string>();
  const serverGroups = new Set<string>();
  const remoteGroups = new Set<string>();
  const topupsGroups = new Set<string>();
  const appstoresGroups = new Set<string>();
  const gamecodesGroups = new Set<string>();
  const subscriptionsGroups = new Set<string>();
  const esimGroups = new Set<string>();

  let imeiCount = 0;
  let serverCount = 0;
  let remoteCount = 0;
  let topupsCount = 0;
  let appStoresCount = 0;
  let gameCodesCount = 0;
  let subscriptionsCount = 0;
  let esimCount = 0;

  for (const srv of activeServices) {
    const srvType = srv.apiServiceType || resolveOrderServiceType(
      srv.apiServiceType,
      srv.dhruCategory?.name,
      srv.groupName
    );
    const grp = srv.groupName?.trim() || "General";
    if (srvType === 'imei') {
      imeiCount++;
      imeiGroups.add(grp);
    } else if (srvType === 'remote') {
      remoteCount++;
      remoteGroups.add(grp);
    } else if (srvType === 'topups') {
      topupsCount++;
      topupsGroups.add(grp);
    } else if (srvType === 'appstores') {
      appStoresCount++;
      appstoresGroups.add(grp);
    } else if (srvType === 'gamecodes') {
      gameCodesCount++;
      gamecodesGroups.add(grp);
    } else if (srvType === 'subscriptions') {
      subscriptionsCount++;
      subscriptionsGroups.add(grp);
    } else if (srvType === 'esim') {
      esimCount++;
      esimGroups.add(grp);
    } else {
      serverCount++;
      serverGroups.add(grp);
    }
  }

  const sections = [
    {
      id: "imei",
      nameEn: "IMEI",
      nameAr: "خدمات IMEI",
      type: "gsm",
      icon: "fingerprint",
      servicesCount: imeiCount,
      packagesCount: imeiGroups.size,
      descriptionAr: "فك شفرات الشبكات وتخطي الحسابات وفحص أرقام السيريال",
      descriptionEn: "Carrier network unlock, iCloud/FRP bypass, and serial checks",
      apiAction: "imeiservicelist"
    },
    {
      id: "server",
      nameEn: "Server",
      nameAr: "خدمات السيرفر",
      type: "gsm",
      icon: "dns",
      servicesCount: serverCount,
      packagesCount: serverGroups.size,
      descriptionAr: "تفعيلات البوكسات والدونجل وسيرفرات البرمجة وشراء الكردت",
      descriptionEn: "Dongle/Box activations, server credits, and digital licenses",
      apiAction: "serverservicelist"
    },
    {
      id: "remote",
      nameEn: "Remote",
      nameAr: "خدمات التحكم عن بعد",
      type: "gsm",
      icon: "settings_remote",
      servicesCount: remoteCount,
      packagesCount: remoteGroups.size,
      descriptionAr: "خدمات الدعم الفني والعمليات السريعة عبر مشاركة منفذ USB",
      descriptionEn: "Live technical assistance and remote flashing/bypass over USB",
      apiAction: "remoteservicelist"
    },
    {
      id: "topups",
      nameEn: "In-Game Top-Ups",
      nameAr: "شحن الألعاب المباشر",
      type: "digital",
      icon: "sports_esports",
      servicesCount: topupsCount,
      packagesCount: topupsGroups.size,
      descriptionAr: "شحن مباشر لحسابات الألعاب العالمية عبر الـ ID واللاعب",
      descriptionEn: "Direct player ID top-ups for major online multiplayer games",
      apiAction: "topups"
    },
    {
      id: "appStores",
      nameEn: "App Stores",
      nameAr: "متاجر التطبيقات",
      type: "digital",
      icon: "store",
      servicesCount: appStoresCount,
      packagesCount: appstoresGroups.size,
      descriptionAr: "بطاقات وقسائم متاجر التطبيقات الرسمية مثل Apple وGoogle Play",
      descriptionEn: "Official digital store cards for iOS App Store and Google Play",
      apiAction: "appstores"
    },
    {
      id: "gameCodes",
      nameEn: "Game Codes",
      nameAr: "أكواد وبطاقات الألعاب",
      type: "digital",
      icon: "vpn_key",
      servicesCount: gameCodesCount,
      packagesCount: gamecodesGroups.size,
      descriptionAr: "أكواد شحن الألعاب وبطاقات المنصات مثل PlayStation وXbox وSteam",
      descriptionEn: "Prepaid game cards and digital voucher redemption codes",
      apiAction: "gamecodes"
    },
    {
      id: "subscriptions",
      nameEn: "Subscriptions",
      nameAr: "الاشتراكات والترفيه",
      type: "digital",
      icon: "subscriptions",
      servicesCount: subscriptionsCount,
      packagesCount: subscriptionsGroups.size,
      descriptionAr: "اشتراكات المنصات الترفيهية والتطبيقات الرقمية المعتمدة",
      descriptionEn: "Entertainment and productivity streaming subscription plans",
      apiAction: "subscriptions"
    },
    {
      id: "esim",
      nameEn: "eSIM",
      nameAr: "شرائح الإنترنت eSIM",
      type: "digital",
      icon: "sim_card",
      servicesCount: esimCount,
      packagesCount: esimGroups.size,
      descriptionAr: "باقات شرائح الاتصال وبيانات الإنترنت المتجولة لمختلف دول العالم",
      descriptionEn: "International mobile data roaming plans and travel eSIM profiles",
      apiAction: "esim"
    }
  ];

  const totalGsmServices = imeiCount + serverCount + remoteCount;
  const totalDigitalBundles = topupsCount + appStoresCount + gameCodesCount + subscriptionsCount + esimCount;

  return {
    success: true,
    account: user ? {
      username: user.username,
      balance: user.balance,
      currency: "USD",
      email: user.email
    } : null,
    total_sections: sections.length,
    total_gsm_services: totalGsmServices,
    total_digital_bundles: totalDigitalBundles,
    total_services_and_bundles: totalGsmServices + totalDigitalBundles,
    sections
  };
}

const handleDhruApiRequest = async (req: any, res: any) => {
  const action = req.body?.action || req.query?.action || req.headers?.['x-action'];
  const parameters = req.body?.parameters || req.query?.parameters;
  const user = req.apiUser;

  const writeActions = ['placeimeiorder', 'placeserverorder'];
  if (writeActions.includes(String(action).toLowerCase()) && req.method === 'GET') {
    return res.status(405).json({
      SUCCESS: [{
        ERROR: "HTTP GET method is not allowed for order placement. Please use POST."
      }]
    });
  }

  try {
    // Dhru sends XML; custom integrations can send JSON or a parameters object.
    let parsedParams: Record<string, any>;
    try {
      parsedParams = parseProviderParameters(parameters);
    } catch {
      return res.status(400).json({ ERROR: [{ MESSAGE: 'Invalid parameters: use a JSON object or PARAMETERS XML' }] });
    }

    // Also pick up flat fields from req.body and req.query (e.g. ID, IMEI, customfield, format, etc.)
    const combinedInput = { ...(req.query || {}), ...(req.body || {}) };
    for (const [key, value] of Object.entries(combinedInput)) {
      if (['username', 'apiaccesskey', 'key', 'apiKey', 'action', 'parameters'].includes(key)) continue;
      const match = key.match(/^parameters\[(.+)\]$/);
      if (match) {
        parsedParams[match[1]] = value;
      } else if (parsedParams[key] === undefined) {
        parsedParams[key] = value;
      }
    }

    const normalizedAction = (action || '').toString().toLowerCase().trim();

    switch (normalizedAction) {
      // ----------------------------------------------------
      // 0. Unified Sections & Stats
      // ----------------------------------------------------
      case 'sections':
      case 'getsections':
      case 'categories': {
        const stats = await getUnifiedSectionsStats(user);
        return res.json({
          SUCCESS: [{
            total_sections: stats.total_sections,
            total_gsm_services: stats.total_gsm_services,
            total_digital_bundles: stats.total_digital_bundles,
            SECTIONS: stats.sections
          }],
          ...stats
        });
      }

      // ----------------------------------------------------
      // 1. Account Info
      // ----------------------------------------------------
      case 'accountinfo': {
        return res.json({
          SUCCESS: [{
            accoutinfo: {
              credit: user.balance.toFixed(2),
              balance: user.balance.toFixed(2),
              currency: "USD",
              mail: user.email,
              username: user.username,
              siteName: user.apiSiteName || "",
              siteUrl: user.apiSiteUrl || ""
            }
          }]
        });
      }

      // ----------------------------------------------------
      // 2. Service Lists (IMEI, Server, Remote, All)
      // ----------------------------------------------------
      case 'imeiservicelist':
      case 'serverservicelist':
      case 'remoteservicelist':
      case 'servicelist':
      case 'serviceslist':
      case 'getservicelist':
      case 'getservices':
      case 'services': {
        const isImei = normalizedAction === 'imeiservicelist';
        const isRemote = normalizedAction === 'remoteservicelist';
        const isServer = normalizedAction === 'serverservicelist';

        // Fetch active services that belong to an active provider or have no provider requirement
        const services = await prisma.dhruService.findMany({
          where: {
            isActive: true,
            OR: [
              { apiProvider: { isActive: true } },
              { providerId: null }
            ]
          },
          include: {
            dhruCategory: { select: { id: true, name: true } },
            apiProvider: { select: { id: true, name: true, isActive: true } }
          },
          orderBy: [
            { groupName: 'asc' },
            { name: 'asc' }
          ]
        });

        // Filter services matching the requested type
        const filteredServices = services.filter((srv) => {
          const srvType = resolveOrderServiceType(
            srv.apiServiceType,
            srv.dhruCategory?.name,
            srv.groupName
          );

          if (isImei) return srvType === 'imei';
          if (isRemote) return srvType === 'remote';
          if (isServer) return srvType === 'server';
          return true;
        });

        // Margin calculation: Default is strictly 8% profit margin added to provider base cost
        const marginPercent = typeof user.apiMargin === 'number' && user.apiMargin >= 0
          ? user.apiMargin
          : 8.0;

        // Group services strictly by their actual package name (groupName)
        const groupsMap = new Map<string, any>();
        const groupsObject: Record<string, any> = {};

        for (const srv of filteredServices) {
          const rawGroupName = (srv.groupName && srv.groupName.trim() !== ''
            ? srv.groupName
            : (srv.dhruCategory?.name || (isImei ? 'IMEI Services' : 'Server Services'))).trim();
          const groupName = rawGroupName;

          if (!groupsMap.has(groupName)) {
            const groupData = {
              GROUPNAME: groupName,
              group_name: groupName,
              GroupName: groupName,
              name: groupName,
              package_name: groupName,
              package: groupName,
              category: srv.dhruCategory?.name || (isImei ? 'IMEI Services' : 'Server Services'),
              SERVICES: [] as any[],
              services: [] as any[]
            };
            groupsMap.set(groupName, groupData);
            groupsObject[groupName] = groupData;
          }

          // Provider base price (cost)
          const baseCost = Math.max(0, srv.credit || 0);
          // Calculate price with 8% profit margin only: baseCost * (1 + 8/100)
          const finalPrice = Number((baseCost * (1 + (marginPercent / 100))).toFixed(4));

          // Parse and build custom fields specifications
          let customReq: any[] = [];
          if (srv.requiresCustom) {
            try {
              const parsed = typeof srv.requiresCustom === 'string' ? JSON.parse(srv.requiresCustom) : srv.requiresCustom;
              if (Array.isArray(parsed)) customReq = parsed;
              else if (typeof parsed === 'object' && parsed !== null) customReq = Object.values(parsed);
            } catch {}
          }

          const requiresFields: string[] = [];
          if (isImei) {
            requiresFields.push("IMEI");
          }

          for (const f of customReq) {
            const fname = f.name || f.fieldname || f.label || f.field_id;
            if (fname && !requiresFields.some(existing => existing.toLowerCase() === String(fname).toLowerCase())) {
              requiresFields.push(String(fname));
            }
          }

          if (requiresFields.length === 0 && isImei) {
            requiresFields.push("IMEI");
          }

          const srvItem = {
            SERVICEID: srv.dhruId || srv.id,
            service_id: srv.dhruId || srv.id,
            ID: srv.id,
            id: srv.id,
            SERVICENAME: srv.name,
            service_name: srv.name,
            name: srv.name,
            CREDIT: finalPrice.toFixed(2),
            credit: finalPrice.toFixed(2),
            PRICE: finalPrice.toFixed(2),
            price: finalPrice.toFixed(2),
            TIME: srv.time || "1-24 Hours",
            time: srv.time || "1-24 Hours",
            INFO: srv.info || "",
            info: srv.info || "",
            GROUPNAME: groupName,
            group_name: groupName,
            GroupName: groupName,
            group: groupName,
            package: groupName,
            PACKAGE: groupName,
            category: srv.dhruCategory?.name || (isImei ? "IMEI Service" : "Server Service"),
            Requires: requiresFields.join(","),
            RequiresCustom: customReq.length > 0 ? customReq : undefined,
            CUSTOM: customReq.length > 0 ? customReq : undefined,
            SupportsQty: srv.supportsQty,
            supports_quantity: srv.supportsQty,
            MIN_QNT: srv.minQty || 1,
            MAX_QNT: srv.maxQty || 0
          };

          const targetGroup = groupsMap.get(groupName);
          targetGroup.SERVICES.push(srvItem);
          targetGroup.services.push(srvItem);
        }

        const groupsList = Array.from(groupsMap.values());
        const isObjectFormat = req.query.format === 'object' || parsedParams.format === 'object';
        const listPayload = isObjectFormat ? groupsObject : groupsList;

        return res.json({
          SUCCESS: [{
            LIST: listPayload,
            GROUPS: groupsList,
            PACKAGES: groupsList,
            serviceList: groupsList,
            total_groups: groupsList.length,
            total_services: filteredServices.length
          }]
        });
      }

      // ----------------------------------------------------
      // 3. Place Order (IMEI / Server)
      // ----------------------------------------------------
      case 'placeimeiorder':
      case 'placeserverorder': {
        const targetServiceId = String(
          parsedParams.ID ||
          parsedParams.SERVICEID ||
          parsedParams.serviceid ||
          parsedParams.id ||
          ''
        ).trim();

        if (!targetServiceId) {
          return res.json({ SUCCESS: [{ ERROR: "Service ID (ID) is required" }] });
        }

        // Support lookup by UUID or Provider DhruId
        const service = await prisma.dhruService.findFirst({
          where: {
            OR: [
              { id: targetServiceId },
              { dhruId: targetServiceId }
            ],
            isActive: true
          },
          include: {
            apiProvider: true,
            dhruCategory: true
          }
        });

        if (!service) {
          return res.json({ SUCCESS: [{ ERROR: "Service not found or inactive" }] });
        }

        const rawQty = parseInt(parsedParams.QNT || parsedParams.quantity || parsedParams.custom_QNT || '1', 10) || 1;
        if (service.supportsQty) {
          if (service.minQty && rawQty < service.minQty) {
            return res.json({ SUCCESS: [{ ERROR: `Quantity is less than minimum allowed limit (${service.minQty})` }] });
          }
          if (service.maxQty && service.maxQty > 0 && rawQty > service.maxQty) {
            return res.json({ SUCCESS: [{ ERROR: `Quantity exceeds maximum allowed limit (${service.maxQty})` }] });
          }
        }
        const finalQty = service.supportsQty ? rawQty : 1;

        const clientOrderId = parsedParams.clientorderid || parsedParams.apiClientOrderId;
        if (clientOrderId) {
          const cleanClientOrderId = String(clientOrderId).trim();
          const existingClientOrder = await prisma.order.findFirst({
            where: {
              userId: user.id,
              apiClientOrderId: cleanClientOrderId
            }
          });
          if (existingClientOrder) {
            return res.json({
              SUCCESS: [{
                REFERENCEID: existingClientOrder.id,
                MESSAGE: "Order already submitted with this client order ID"
              }]
            });
          }
        }

        // Base provider cost + 8% margin
        const baseCost = Math.max(0, service.credit || 0);
        if (!Number.isFinite(baseCost) || baseCost <= 0) {
          return res.json({ ERROR: [{ MESSAGE: 'Service price is unavailable. Contact the administrator.' }] });
        }
        const marginPercent = typeof user.apiMargin === 'number' && user.apiMargin >= 0
          ? user.apiMargin
          : 8.0;

        const unitPrice = Number((baseCost * (1 + (marginPercent / 100))).toFixed(4));
        const finalTotalPrice = Math.max(0.01, Number((unitPrice * finalQty).toFixed(2)));

        // Balance validation
        if (user.balance < finalTotalPrice) {
          return res.json({
            SUCCESS: [{
              ERROR: `Insufficient balance! Total required: $${finalTotalPrice.toFixed(2)} USD. Your balance: $${user.balance.toFixed(2)} USD. Please deposit funds first.`
            }]
          });
        }

        // Parse custom field parameters (handle Base64 JSON, JSON string, or Object)
        let customFieldsObj: Record<string, string> = {};
        const rawCustomField = parsedParams.customfield || parsedParams.CUSTOMFIELD;

        if (rawCustomField) {
          if (typeof rawCustomField === 'string') {
            try {
              // Try base64 decode first
              const decoded = Buffer.from(rawCustomField, 'base64').toString('utf8');
              const parsed = JSON.parse(decoded);
              if (parsed && typeof parsed === 'object') customFieldsObj = parsed;
            } catch {
              try {
                const parsed = JSON.parse(rawCustomField);
                if (parsed && typeof parsed === 'object') customFieldsObj = parsed;
              } catch {
                customFieldsObj = { custom: rawCustomField };
              }
            }
          } else if (typeof rawCustomField === 'object' && rawCustomField !== null) {
            customFieldsObj = { ...rawCustomField };
          }
        }

        // Support flat parameters starting with custom_
        for (const [pKey, pVal] of Object.entries(parsedParams)) {
          if (pKey.startsWith('custom_') && pVal !== undefined && pVal !== null) {
            customFieldsObj[pKey] = String(pVal);
            customFieldsObj[pKey.replace(/^custom_/, '')] = String(pVal);
          }
        }

        const rawImei = (
          parsedParams.IMEI ||
          parsedParams.imei ||
          parsedParams.sn ||
          parsedParams.serial ||
          ''
        ).toString().trim();

        // Determine final target input
        let finalTargetInput = rawImei;
        if (!finalTargetInput && Object.keys(customFieldsObj).length > 0) {
          const firstVal = Object.values(customFieldsObj)[0];
          finalTargetInput = String(firstVal);
        }
        if (!finalTargetInput) {
          finalTargetInput = `API-${user.username}`;
        }

        // Structure timeline events and notes for dashboard inspection
        const now = new Date();
        const timelineEvents = [
          {
            time: now.toISOString(),
            action: 'API_ORDER_CREATED',
            title: 'استلام طلب عبر الـ API وخصم الرصيد',
            desc: `تم استلام الطلب بنجاح عبر API من موقع (${user.apiSiteName || 'بدون اسم موقع'}) بواسطة العميل (@${user.username}) وخصم $${finalTotalPrice.toFixed(2)} USD من رصيد محفظته. الطلب في انتظار مراجعة وموافقة الإدارة.`
          }
        ];

        if (service.apiProvider) {
          timelineEvents.push({
            time: now.toISOString(),
            action: 'PROVIDER_LINKED',
            title: 'ربط المزود',
            desc: `الخدمة مربوطة بالمزود (${service.apiProvider.name}) برقم خدمة #${service.dhruId}. الطلب في انتظار موافقة الإدارة للإرسال للمزود أو التنفيذ اليدوي.`
          });
        }

        const mergedCustomFields: Record<string, string> = { ...customFieldsObj };
        if (service.supportsQty) {
          mergedCustomFields['QNT'] = String(finalQty);
          mergedCustomFields['custom_QNT'] = String(finalQty);
        }

        const structuredNotes = JSON.stringify({
          userNote: `طلب API وارد من موقع: ${user.apiSiteName || 'N/A'} (العميل: @${user.username})`,
          rawImei: rawImei || finalTargetInput,
          customFields: Object.keys(mergedCustomFields).length > 0 ? mergedCustomFields : null,
          apiDetails: {
            username: user.username,
            email: user.email,
            fullName: user.fullName,
            siteName: user.apiSiteName || null,
            siteUrl: user.apiSiteUrl || null,
            apiKey: user.apiKey ? user.apiKey.slice(0, 8) + '...' : null,
            margin: marginPercent
          },
          originalPrice: baseCost * finalQty,
          finalPrice: finalTotalPrice,
          events: timelineEvents
        });

        // Deduct balance, record transaction, and create order with status: 'pending'
        let order;
        try {
          order = await prisma.$transaction(async (tx: any) => {
            const updatedUserResult = await tx.user.updateMany({
              where: { id: user.id, balance: { gte: finalTotalPrice } },
              data: { balance: { decrement: finalTotalPrice } }
            });

            if (updatedUserResult.count === 0) {
              throw new Error('INSUFFICIENT_BALANCE_RACE');
            }

            await tx.transaction.create({
              data: {
                userId: user.id,
                type: `طلب API: ${service.name.slice(0, 35)}`,
                amount: finalTotalPrice,
                method: 'رصيد API',
                status: 'completed',
                refNo: `API-${Date.now()}`
              }
            });

            const newOrder = await tx.order.create({
              data: {
                userId: user.id,
                serviceId: service.id,
                serviceName: service.name,
                targetInput: finalTargetInput,
                quantity: finalQty,
                price: finalTotalPrice,
                status: 'pending',
                source: 'api',
                notes: structuredNotes,
                apiClientOrderId: parsedParams.clientorderid || parsedParams.apiClientOrderId || null
              }
            });

            return newOrder;
          });
        } catch (err: any) {
          if (err.message === 'INSUFFICIENT_BALANCE_RACE') {
            return res.json({
              SUCCESS: [{
                ERROR: `Insufficient balance during transaction. Your balance may have changed. Please try again.`
              }]
            });
          }
          throw err;
        }

        // Send Telegram alert to admin for manual approval
        const providerName = service.apiProvider?.name || 'سيرفر محلي / يدوي';
        const caption = `
[NEW API ORDER] <b>طلب API جديد في انتظار موافقة الإدارة! (New API Order Pending)</b>

<b>رقم الطلب:</b> #${order.id.slice(-6)}
<b>مصدر الطلب:</b> API (${escapeHtml(user.apiSiteName || 'موقع عميل')})
<b>رابط الموقع:</b> ${escapeHtml(user.apiSiteUrl || 'N/A')}
<b>العميل:</b> ${escapeHtml(user.fullName)} (@${escapeHtml(user.username)})
<b>الإيميل:</b> <code>${escapeHtml(user.email)}</code>
<b>اسم الخدمة:</b> ${escapeHtml(order.serviceName)}
<b>المزود المربوط:</b> ${escapeHtml(providerName)} (ID: ${escapeHtml(service.dhruId || 'N/A')})
<b>البيانات / IMEI:</b> <code>${escapeHtml(order.targetInput)}</code>
<b>الكمية:</b> ${order.quantity}
<b>المبلغ المخصوم (تكلفة + 8% ربح):</b> <code>$${order.price.toFixed(2)} USD</code>
<b>رصيد العميل المتبقي:</b> <code>$${(user.balance - finalTotalPrice).toFixed(2)} USD</code>
<b>التاريخ:</b> ${new Date().toLocaleString('ar-EG')}

<b>الحالة:</b> في انتظار مراجعة وموافقة الإدارة بالداشبورد
        `.trim();

        sendTelegramPhotoNotification({ caption }).catch((err) => {
          console.error('[API Order Telegram Alert Error]:', err?.message || err);
        });

        return res.json({
          SUCCESS: [{
            MESSAGE: "Order placed successfully and is pending admin approval",
            REFERENCEID: order.id
          }]
        });
      }

      // ----------------------------------------------------
      // 4. Check Order Status & Retrieve Code (IMEI & Server)
      // ----------------------------------------------------
      case 'getimeiorder':
      case 'getserverorder':
      case 'getorder': {
        const orderId = String(
          parsedParams.ID ||
          parsedParams.orderid ||
          parsedParams.referenceid ||
          parsedParams.id ||
          ''
        ).trim();

        if (!orderId) {
          return res.json({ SUCCESS: [{ ERROR: "Order ID (ID) is required" }] });
        }

        const order = await prisma.order.findUnique({
          where: { id: orderId }
        });

        if (!order || order.userId !== user.id) {
          return res.json({ SUCCESS: [{ ERROR: "Order not found" }] });
        }

        // Dhru Standard Status Codes:
        // 1 = Pending (في انتظار الموافقة)
        // 2 = In Process (قيد التنفيذ بالمزود)
        // 3 = Rejected / Cancelled (ملغي ومسترجع)
        // 4 = Success / Completed (مكتمل ومسلم)
        let statusCode = "1";
        let statusMessage = "Pending admin verification and approval";
        let replyCode = "";

        if (order.status === 'completed') {
          statusCode = "4";
          statusMessage = "Order completed successfully";
          replyCode = order.reply || "Completed";
        } else if (order.status === 'rejected' || order.status === 'cancelled') {
          statusCode = "3";
          statusMessage = "Order rejected or cancelled by admin";
          replyCode = order.reply || "Rejected by admin";
        } else if (order.status === 'processing') {
          statusCode = "2";
          statusMessage = "Order in process with provider";
          replyCode = "In process";
        } else {
          statusCode = "1";
          statusMessage = "Order pending admin approval";
          replyCode = "Pending";
        }

        return res.json({
          SUCCESS: [{
            STATUS: statusCode,
            CODE: replyCode,
            MESSAGE: statusMessage,
            REFERENCEID: order.id
          }]
        });
      }

      default: {
        return res.status(400).json({
          SUCCESS: [{
            ERROR: `Action "${action}" is not supported.`
          }]
        });
      }
    }
  } catch (error: any) {
    console.error("API error:", error);
    return res.status(500).json({
      SUCCESS: [{
        ERROR: "Internal Server Error"
      }]
    });
  }
};

router.all('/', authenticateApi, handleDhruApiRequest);

router.all('/sections', authenticateApi, async (req: any, res: any) => {
  const action = req.body?.action || req.query?.action || req.headers?.['x-action'];
  if (action && String(action).toLowerCase() !== 'sections') {
    return handleDhruApiRequest(req, res);
  }
  try {
    const stats = await getUnifiedSectionsStats(req.apiUser);
    return res.json({
      SUCCESS: [{
        total_sections: stats.total_sections,
        total_gsm_services: stats.total_gsm_services,
        total_digital_bundles: stats.total_digital_bundles,
        SECTIONS: stats.sections
      }],
      ...stats
    });
  } catch (error: any) {
    console.error("Error fetching sections:", error);
    return res.status(500).json({
      SUCCESS: [{ ERROR: "Failed to fetch sections" }]
    });
  }
});

export default router;
