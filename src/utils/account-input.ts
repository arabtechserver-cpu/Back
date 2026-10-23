export function validPlainText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max
    && !/[<>\u0000-\u001f\u007f]/u.test(value);
}

export function validEmail(value: unknown): value is string {
  return validPlainText(value, 3, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 72;
}
