import { normalizeProviderCustomFields, placeImeiOrder, placeServerOrder } from './dhru-api';
import { getProviderRemoteServiceId } from './provider-service-id';
import { parseOrderMetadata, resolveOrderServiceType } from './order-response';
import { getServiceQuantityConfig } from './provider-quantity';

export async function sendOrderToProvider(order: any, service: any) {
  const provider = service?.apiProvider;
  if (!service?.dhruId || !provider || provider.isActive === false || !provider.apiUrl || !provider.apiKey) {
    throw new Error('الخدمة غير مربوطة بمزود فعال بإعدادات API مكتملة');
  }
  const config = { apiUrl: provider.apiUrl, username: provider.username, apiKey: provider.apiKey };
  const metadata = parseOrderMetadata(order.notes);
  const fields = normalizeProviderCustomFields(metadata.customFields || {}, service.requiresCustom);
  if (getServiceQuantityConfig(service).supportsQty) fields.QNT = String(order.quantity);

  // The display summary and instant-order label are not provider identifiers.
  const displayTarget = String(order.targetInput || '').trim();
  const isFieldSummary = Object.keys(metadata.customFields || {}).some(key => displayTarget.includes(key + ': '));
  const candidateTarget = metadata.rawImei || (!isFieldSummary ? displayTarget : '');
  const isPlaceholder = /^(طلب فوري|instant order)$/i.test(candidateTarget)
    || (metadata.apiDetails?.username && candidateTarget === 'API-' + metadata.apiDetails.username);
  const target = isPlaceholder ? '' : candidateTarget;
  const id = getProviderRemoteServiceId(service.dhruId);
  if (resolveOrderServiceType(service.apiServiceType, service.dhruCategory?.name, service.groupName) === 'imei') {
    return placeImeiOrder(id, target, fields, config);
  }
  return placeServerOrder(id, order.quantity, fields, target, config);
}

export function getProviderDispatchResult(response: any): { reference: string | null; error: string | null; unconfirmed: boolean } {
  const success = Array.isArray(response?.SUCCESS) ? response.SUCCESS[0] : response?.SUCCESS;
  const error = response?.ERROR || response?.Error || response?.error || success?.ERROR || success?.Error || success?.error;
  if (error || response?.SUCCESS === false || response?.success === false) {
    const detail = Array.isArray(error) ? error[0] : error;
    return { reference: null, error: String(detail?.MESSAGE || detail?.FULL_DESCRIPTION || detail?.message || detail || 'رفض المزود الطلب'), unconfirmed: false };
  }
  const rawReference = success?.REFERENCEID ?? response?.REFERENCEID;
  const reference = typeof rawReference === 'string' || (typeof rawReference === 'number' && Number.isFinite(rawReference) && rawReference > 0) ? String(rawReference).trim() : '';
  if (!reference || /^(0|null|undefined|sent|n\/a)$/i.test(reference)) {
    return { reference: null, error: 'لم يؤكد المزود استلام الطلب برقم مرجع صالح. يرجى مراجعة الطلب لدى المزود قبل إعادة الإرسال.', unconfirmed: true };
  }
  return { reference, error: null, unconfirmed: false };
}
