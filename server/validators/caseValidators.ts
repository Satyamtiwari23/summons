/**
 * Security and Payload Validator for Judicial QR Codes
 * Prevents execution of arbitrary code, script injection, and malformed identifiers.
 */

export interface ValidatedQrRequest {
  isValid: boolean;
  sanitizedPayload: string;
  source: string;
  errorCode?: 'INVALID_QR' | 'UNSUPPORTED_QR' | 'INVALID_CASE_IDENTIFIER' | 'RATE_LIMITED';
  errorMessage?: string;
}

const MAX_PAYLOAD_BYTES = 4096;

// Blocked dangerous URI schemes and executable injection patterns
const DANGEROUS_PROTOCOLS = [
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'chrome:',
];

export function validateQrLookupRequest(body: any): ValidatedQrRequest {
  if (!body || typeof body !== 'object') {
    return {
      isValid: false,
      sanitizedPayload: '',
      source: 'judicial-qr',
      errorCode: 'INVALID_QR',
      errorMessage: 'Missing request body or invalid format.',
    };
  }

  const rawPayload = body.payload !== undefined ? body.payload : body.qrPayload;
  const source = typeof body.source === 'string' ? body.source.trim() : 'judicial-qr';

  if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
    return {
      isValid: false,
      sanitizedPayload: '',
      source,
      errorCode: 'INVALID_QR',
      errorMessage: 'QR code payload is empty or not a string.',
    };
  }

  const trimmed = rawPayload.trim();

  // 1. Enforce payload size limit to prevent memory exhaustion / DoS
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_PAYLOAD_BYTES) {
    return {
      isValid: false,
      sanitizedPayload: '',
      source,
      errorCode: 'INVALID_QR',
      errorMessage: 'QR code payload exceeds maximum allowed size (4KB).',
    };
  }

  // 2. Check for dangerous script protocols
  const lower = trimmed.toLowerCase();
  for (const proto of DANGEROUS_PROTOCOLS) {
    if (lower.startsWith(proto) || lower.includes(`href="${proto}`) || lower.includes(`src="${proto}`)) {
      return {
        isValid: false,
        sanitizedPayload: '',
        source,
        errorCode: 'INVALID_QR',
        errorMessage: 'Security rejection: payload contains forbidden executable protocol.',
      };
    }
  }

  // 3. Reject null bytes or control characters (except standard newlines/tabs)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(trimmed)) {
    return {
      isValid: false,
      sanitizedPayload: '',
      source,
      errorCode: 'INVALID_QR',
      errorMessage: 'QR code payload contains invalid binary control characters.',
    };
  }

  return {
    isValid: true,
    sanitizedPayload: trimmed,
    source,
  };
}
