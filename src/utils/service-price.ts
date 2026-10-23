/** Catalogs differ in casing, currency labels and decimal separators. */
export function parseProviderPrice(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.length > 80) return null;
  let text = value.trim().replace(/^(?:USD|EUR|GBP|EGP|SAR|AED|\$|€|£)\s*/i, '')
    .replace(/\s*(?:USD|EUR|GBP|EGP|SAR|AED)$/i, '').replace(/[\s\u00a0]/g, '');
  if (/^0,\d+$/.test(text)) text = text.replace(',', '.');
  else if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  else if (/^\d+,\d{1,6}$/.test(text)) text = text.replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function getProviderPrice(service: Record<string, unknown>): number | null {
  const candidates = ['CREDIT', 'credit', 'PRICE', 'price', 'rate', 'RATE', 'cost', 'COST']
    .map(key => parseProviderPrice(service[key])).filter((value): value is number => value !== null);
  return candidates.find(value => value > 0) ?? candidates[0] ?? null;
}

export function sellingPrice(credit: number, margin: number): number {
  const price = Number(credit) + Number(margin);
  return Number.isFinite(price) && price >= 0 ? Number(price.toFixed(6)) : 0;
}
