const DB_NUMERIC_MAX = 9999999999.99;

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function normalizeDbMoney(rawValue, options = {}) {
  const { fallback = 0 } = options;
  const numericValue = Number(rawValue);

  if (!Number.isFinite(numericValue)) {
    return {
      value: roundMoney(fallback),
      invalid: true,
      clamped: false,
    };
  }

  if (numericValue > DB_NUMERIC_MAX) {
    return {
      value: DB_NUMERIC_MAX,
      invalid: false,
      clamped: true,
    };
  }

  if (numericValue < -DB_NUMERIC_MAX) {
    return {
      value: -DB_NUMERIC_MAX,
      invalid: false,
      clamped: true,
    };
  }

  return {
    value: roundMoney(numericValue),
    invalid: false,
    clamped: false,
  };
}

function normalizeQuantity(rawValue, fallback = 0) {
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) return fallback;
  if (numericValue < 0) return fallback;
  return Math.floor(numericValue);
}

module.exports = {
  DB_NUMERIC_MAX,
  normalizeDbMoney,
  normalizeQuantity,
};
