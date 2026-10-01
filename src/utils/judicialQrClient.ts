/**
 * Client-Side Judicial QR Security Validator & Parser
 * Validates payloads before network transmission and identifies QR types.
 * Rejects javascript:, data:, and suspicious protocols.
 */

export type ClientJudicialQrType = 'CNR' | 'URL' | 'STRUCTURED' | 'CASE_IDENTIFIER' | 'UNKNOWN';

export interface ClientParsedQr {
  type: ClientJudicialQrType;
  value?: string;
  rawValue: string;
  cnrNumber?: string;
  caseNumber?: string;
  isSecure: boolean;
  securityError?: string;
}

const CNR_REGEX = /\b([A-Za-z]{2}[A-Za-z0-9]{2}\d{12})\b/;
const STRICT_CNR_EXACT = /^[A-Za-z]{2}[A-Za-z0-9]{2}\d{12}$/;
const DANGEROUS_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];

/**
 * Validates the raw QR string client-side before sending to backend.
 * Rejects malicious schemes, oversized payloads, or binary corruption.
 */
export function validateClientQrPayload(raw: string): { isValid: boolean; error?: string } {
  if (!raw || typeof raw !== 'string') {
    return { isValid: false, error: 'Empty or invalid QR code data.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length > 4096) {
    return { isValid: false, error: 'QR payload is excessively large (>4KB).' };
  }

  const lower = trimmed.toLowerCase();
  for (const proto of DANGEROUS_PROTOCOLS) {
    if (lower.startsWith(proto) || lower.includes(`href="${proto}`) || lower.includes(`src="${proto}`)) {
      return { isValid: false, error: 'Security alert: payload contains forbidden executable protocol.' };
    }
  }

  return { isValid: true };
}

/**
 * Parses judicial QR code client-side without altering identifiers.
 */
export function parseJudicialQR(payload: string): ClientParsedQr {
  const rawValue = (payload || '').trim();
  const validation = validateClientQrPayload(rawValue);

  if (!validation.isValid) {
    return {
      type: 'UNKNOWN',
      rawValue,
      isSecure: false,
      securityError: validation.error,
    };
  }

  // 1. Direct 16-character CNR
  if (STRICT_CNR_EXACT.test(rawValue)) {
    const cnr = rawValue.toUpperCase();
    return {
      type: 'CNR',
      value: cnr,
      cnrNumber: cnr,
      rawValue,
      isSecure: true,
    };
  }

  // 1b. Prefixed CNR (e.g. "CNR: DLCT010044022026")
  const prefixedCnr = rawValue.match(/^CNR(?:\s*NO\.?|\s*NUMBER)?\s*[:=-]\s*([A-Za-z]{2}[A-Za-z0-9]{2}\d{12})$/i);
  if (prefixedCnr) {
    const cnr = prefixedCnr[1].toUpperCase();
    return {
      type: 'CNR',
      value: cnr,
      cnrNumber: cnr,
      rawValue,
      isSecure: true,
    };
  }

  // 2. Official e-Courts or Judicial URL
  if (/^https?:\/\//i.test(rawValue)) {
    let extractedCnr: string | undefined;
    const match = rawValue.match(CNR_REGEX);
    if (match) {
      extractedCnr = match[1].toUpperCase();
    }

    return {
      type: 'URL',
      value: rawValue,
      cnrNumber: extractedCnr,
      rawValue,
      isSecure: true,
    };
  }

  // 3. Structured text with pipe or newline
  if (rawValue.includes('|') || rawValue.includes(';') || rawValue.includes('\n')) {
    const cnrMatch = rawValue.match(CNR_REGEX);
    return {
      type: 'STRUCTURED',
      value: cnrMatch ? cnrMatch[1].toUpperCase() : rawValue,
      cnrNumber: cnrMatch ? cnrMatch[1].toUpperCase() : undefined,
      rawValue,
      isSecure: true,
    };
  }

  // 4. Embedded CNR in text
  const match = rawValue.match(CNR_REGEX);
  if (match) {
    const cnr = match[1].toUpperCase();
    return {
      type: 'CNR',
      value: cnr,
      cnrNumber: cnr,
      rawValue,
      isSecure: true,
    };
  }

  return {
    type: 'UNKNOWN',
    rawValue,
    isSecure: true,
  };
}

/**
 * Normalized Case Data Interface from Backend
 */
export interface NormalizedCaseData {
  cnrNumber: string;
  caseNumber: string;
  caseType?: string;
  courtName?: string;
  courtNumber?: string;
  state?: string;
  district?: string;
  filingDate?: string;
  registrationDate?: string;
  nextHearingDate?: string;
  caseStatus?: string;
  petitioner?: string[];
  respondent?: string[];
  advocates?: string[];
  firNumber?: string;
  policeStation?: string;
  acts?: string[];
  sections?: string[];
  source?: 'eCourts' | string;
  sourceVerification?: string;
  verifiedAt?: string;
  fetchedAt?: string;
}

export interface QrLookupResponse {
  success: boolean;
  status:
    | 'FOUND'
    | 'CASE_NOT_FOUND'
    | 'USER_ACTION_REQUIRED'
    | 'CAPTCHA_REQUIRED'
    | 'INVALID_CASE_IDENTIFIER'
    | 'UNSUPPORTED_QR'
    | 'INVALID_QR'
    | 'RATE_LIMITED'
    | 'SOURCE_UNAVAILABLE'
    | 'TIMEOUT'
    | 'NETWORK_ERROR'
    | 'INTERNAL_ERROR';
  message?: string;
  error?: string;
  officialUrl?: string;
  caseData?: NormalizedCaseData;
  requestId?: string;
  parsedQr?: {
    type: string;
    cnrNumber?: string;
    caseNumber?: string;
  };
}

/**
 * Call backend to lookup judicial case by QR payload
 */
export async function lookupJudicialCaseByQr(
  payload: string,
  source: string = 'judicial-qr',
  signal?: AbortSignal
): Promise<QrLookupResponse> {
  const validation = validateClientQrPayload(payload);
  if (!validation.isValid) {
    return {
      success: false,
      status: 'INVALID_QR',
      message: validation.error,
    };
  }

  try {
    const res = await fetch('/api/cases/qr-lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payload: payload.trim(),
        source,
      }),
      signal,
    });

    const data: QrLookupResponse = await res.json();
    return data;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return {
        success: false,
        status: 'TIMEOUT',
        message: 'Official case lookup is temporarily unavailable.',
      };
    }

    return {
      success: false,
      status: 'NETWORK_ERROR',
      message: 'Network connection failed. Please try again.',
    };
  }
}

/**
 * Safe function to open official e-Courts search in a new tab without navigating SummonsMitra away
 * and automatically copy the CNR to clipboard.
 */
export function openECourtsSearch(cnr?: string): boolean {
  if (cnr && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(cnr.trim()).catch(() => {});
  }

  if (typeof window !== 'undefined') {
    try {
      const opened = window.open(
        'https://services.ecourts.gov.in/ecourtindia_v6/',
        '_blank',
        'noopener,noreferrer'
      );
      return !!opened;
    } catch (e) {
      console.warn('Popup blocked for official e-Courts:', e);
      return false;
    }
  }
  return false;
}

/**
 * Call backend to lookup judicial case by direct identifier (CNR)
 * Endpoint: POST /api/cases/lookup
 */
export async function lookupCaseByIdentifier(
  identifier: string,
  identifierType: 'CNR' | 'CASE_NUMBER' = 'CNR',
  signal?: AbortSignal
): Promise<QrLookupResponse> {
  const cleanId = (identifier || '').trim().toUpperCase();
  if (!cleanId) {
    return {
      success: false,
      status: 'INVALID_CASE_IDENTIFIER',
      message: 'CNR could not be matched. Please verify the CNR.',
      officialUrl: 'https://services.ecourts.gov.in/',
    };
  }

  try {
    const res = await fetch('/api/cases/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        identifierType,
        identifier: cleanId,
      }),
      signal,
    });

    const data: QrLookupResponse = await res.json();
    return data;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return {
        success: false,
        status: 'TIMEOUT',
        message: 'Official case lookup is temporarily unavailable.',
        officialUrl: 'https://services.ecourts.gov.in/',
      };
    }

    return {
      success: false,
      status: 'NETWORK_ERROR',
      message: 'Network connection failed. Please try again.',
      officialUrl: 'https://services.ecourts.gov.in/',
    };
  }
}

