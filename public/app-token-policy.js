export const APP_TOKEN_MINIMUM_LENGTH = 32;
export const APP_TOKEN_MAXIMUM_LENGTH = 512;
export const APP_TOKEN_GENERATED_BYTES = 32;

export const APP_TOKEN_REJECTED_VALUES = Object.freeze([
  'replace-with-a-long-random-local-token',
]);

export const APP_TOKEN_REJECTED_FRAGMENTS = Object.freeze([
  'change-me',
  'changeme',
  'example-token',
  'password',
  'placeholder',
  'redacted',
  'replace-with',
  'sample-token',
  'your-app-token',
]);

export const APP_TOKEN_REQUIREMENTS_MESSAGE =
  'APP_TOKEN must be 32 to 512 printable ASCII characters with no surrounding whitespace and cannot use a sample or generic placeholder value. Replace it in local setup or .env with 32 random bytes encoded as 64 hexadecimal characters (for example, run: openssl rand -hex 32).';

export function normalizeAppToken(value) {
  if (typeof value !== 'string'
      || value.length < APP_TOKEN_MINIMUM_LENGTH
      || value.length > APP_TOKEN_MAXIMUM_LENGTH
      || value.trim() !== value) {
    return '';
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint > 0x7e) return '';
  }

  const lowered = value.toLowerCase();
  if (APP_TOKEN_REJECTED_VALUES.includes(lowered)
      || APP_TOKEN_REJECTED_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
    return '';
  }
  return value;
}

export function requireSafeAppToken(value) {
  const token = normalizeAppToken(value);
  if (!token) throw new Error(APP_TOKEN_REQUIREMENTS_MESSAGE);
  return token;
}

export function resolveAppToken({ hasExplicitValue, explicitValue, generateToken }) {
  if (hasExplicitValue) {
    return { token: requireSafeAppToken(explicitValue), generated: false };
  }

  const token = requireSafeAppToken(generateToken());
  return { token, generated: true };
}
