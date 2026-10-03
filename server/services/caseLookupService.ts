import { parseJudicialQR, ParsedJudicialQr } from './judicialQrParser.ts';
import { CaseLookupProvider, ECourtsProvider, CaseLookupResult } from './eCourtsProvider.ts';
import crypto from 'crypto';

export class CaseLookupService {
  private provider: CaseLookupProvider;

  constructor(provider?: CaseLookupProvider) {
    this.provider = provider || new ECourtsProvider();
  }

  /**
   * Set a different lookup provider (e.g. for another official judicial state provider)
   */
  public setProvider(provider: CaseLookupProvider) {
    this.provider = provider;
  }

  /**
   * Execute judicial QR case lookup
   */
  async lookupCase(payload: string, source: string, db?: any): Promise<CaseLookupResult & { requestId: string; parsedQr: { type: string; cnrNumber?: string; caseNumber?: string } }> {
    const requestId = `req_jqr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startTime = Date.now();

    // 1. Parse QR payload safely
    const parsed: ParsedJudicialQr = parseJudicialQR(payload);

    // Logging (Safe: NEVER logs full sensitive payload, tokens, secrets, or personal data)
    console.info(`[JudicialQR:${requestId}] QR detected. Source: ${source}. Type: ${parsed.type}. Identifier: ${parsed.cnrNumber || parsed.caseNumber || 'N/A'}`);
    console.info(`[JudicialQR:${requestId}] Lookup started using provider: ${this.provider.name}`);

    try {
      let result: CaseLookupResult;

      // 2. Route by parsed QR type
      if (parsed.cnrNumber) {
        result = await this.provider.lookupByCnr(parsed.cnrNumber, db);
      } else if (parsed.type === 'URL' && parsed.value) {
        result = await this.provider.lookupByUrl(parsed.value, db);
      } else if (parsed.caseNumber) {
        result = await this.provider.lookupByCaseNumber(parsed.caseNumber, parsed.courtName, db);
      } else if (parsed.type === 'UNKNOWN') {
        result = {
          success: false,
          status: 'UNSUPPORTED_QR',
          message: 'The scanned barcode did not contain a recognizable e-Courts CNR, judicial case number, or official portal link.',
        };
      } else {
        result = {
          success: false,
          status: 'INVALID_CASE_IDENTIFIER',
          message: 'Could not extract a valid judicial case identifier from this QR code.',
        };
      }

      const latencyMs = Date.now() - startTime;

      if (result.success) {
        console.info(`[JudicialQR:${requestId}] Lookup completed successfully. Status: ${result.status}. Latency: ${latencyMs}ms`);
      } else {
        console.warn(`[JudicialQR:${requestId}] Lookup failed. Status: ${result.status}. Reason: ${result.message || 'Unknown'}. Latency: ${latencyMs}ms`);
      }

      return {
        ...result,
        requestId,
        parsedQr: {
          type: parsed.type,
          cnrNumber: parsed.cnrNumber,
          caseNumber: parsed.caseNumber,
        },
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      console.error(`[JudicialQR:${requestId}] Lookup exception. Latency: ${latencyMs}ms. Error:`, err?.message || err);
      return {
        success: false,
        status: 'SOURCE_UNAVAILABLE',
        message: 'The official judicial case service is temporarily unreachable. Please try again.',
        requestId,
        parsedQr: {
          type: parsed.type,
          cnrNumber: parsed.cnrNumber,
          caseNumber: parsed.caseNumber,
        },
      };
    }
  }
}

// Export singleton instance
export const caseLookupService = new CaseLookupService();
