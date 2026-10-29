// This bundled legacy client is confirmed disabled by Google's authorization UI.
const DISABLED_LEGACY_CLIENT = '149631802250-7n94rcr7nd1041iq06ck2310uctituve.apps.googleusercontent.com';

export function googleAuthConfig(env = process.env) {
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  const enabled = env.GOOGLE_AUTH_ENABLED !== 'false' && Boolean(clientId) &&
    (clientId !== DISABLED_LEGACY_CLIENT || env.GOOGLE_AUTH_ENABLED === 'true');
  return { enabled, clientId: enabled ? clientId : null };
}
