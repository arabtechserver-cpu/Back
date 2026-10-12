function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Dhru's PHP API reads an XML string in parameters. Flat aliases remain available
// for providers that use form fields instead; CUSTOMFIELD carries non-XML field names.
export function serializeProviderParameters(parameters: Record<string, any>): string {
  const fields = Object.entries(parameters)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) && value !== null && value !== undefined)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`);
  return `<PARAMETERS>${fields.join('')}</PARAMETERS>`;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('Invalid XML character');
    return String.fromCodePoint(code);
  });
}

export function parseProviderParameters(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value !== 'string') throw new Error('parameters must be a JSON object or PARAMETERS XML');
  const trimmed = value.trim();
  if (!trimmed.startsWith('<')) {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('parameters must be an object');
    return parsed;
  }
  // Only a flat scalar envelope is supported. No DTDs, external entities or nested XML.
  const root = trimmed.replace(/^<\?xml[^?]*\?>\s*/i, '').match(/^<PARAMETERS\s*>([\s\S]*)<\/PARAMETERS>$/i);
  if (!root) throw new Error('Invalid PARAMETERS XML');
  const parsed: Record<string, any> = Object.create(null);
  let remaining = root[1];
  const field = /^\s*<([A-Za-z_][A-Za-z0-9_.-]*)>([\s\S]*?)<\/\1>/;
  while (remaining.trim()) {
    const match = remaining.match(field);
    if (!match) throw new Error('Invalid XML parameter field');
    const raw = match[2];
    const cdata = raw.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
    if (!cdata && (raw.includes('<') || /&(?!(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(raw))) throw new Error('Invalid XML parameter value');
    parsed[match[1]] = cdata ? cdata[1] : decodeXml(raw);
    remaining = remaining.slice(match[0].length);
  }
  return parsed;
}
