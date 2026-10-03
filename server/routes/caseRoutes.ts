import { Router, Request, Response } from 'express';
import { validateQrLookupRequest } from '../validators/caseValidators.ts';
import { caseLookupService } from '../services/caseLookupService.ts';

export function createCaseRoutes(getDb?: () => any): Router {
  const router = Router();

  /**
   * POST /api/cases/qr-lookup
   * Official Judicial QR & e-Courts Barcode lookup endpoint
   */
  router.post('/qr-lookup', async (req: Request, res: Response) => {
    // 1. Security & format validation
    const validation = validateQrLookupRequest(req.body);

    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        status: validation.errorCode || 'INVALID_QR',
        error: validation.errorMessage || 'Invalid QR payload format.',
      });
    }

    try {
      // 2. Perform modular lookup
      const db = getDb ? getDb() : (req.app?.locals?.db || null);
      const result = await caseLookupService.lookupCase(
        validation.sanitizedPayload,
        validation.source,
        db
      );

      // 3. Map status to HTTP response codes
      if (result.success && result.status === 'FOUND') {
        return res.status(200).json(result);
      }

      if (result.status === 'USER_ACTION_REQUIRED') {
        return res.status(200).json(result);
      }

      if (result.status === 'CASE_NOT_FOUND') {
        return res.status(200).json(result);
      }

      if (result.status === 'INVALID_CASE_IDENTIFIER' || result.status === 'UNSUPPORTED_QR') {
        return res.status(400).json(result);
      }

      if (result.status === 'RATE_LIMITED') {
        return res.status(429).json(result);
      }

      // Default fallback
      return res.status(200).json(result);
    } catch (err: any) {
      console.error('[CaseRoutes] Error in /qr-lookup:', err);
      return res.status(500).json({
        success: false,
        status: 'INTERNAL_ERROR',
        error: 'An internal server error occurred while processing the judicial case lookup.',
      });
    }
  });

  /**
   * POST /api/cases/lookup
   * Direct identifier lookup endpoint (CNR or Case Number)
   * Receives: { identifierType: 'CNR', identifier: '<CNR>' }
   */
  router.post('/lookup', async (req: Request, res: Response) => {
    const rawId = req.body.identifier || req.body.cnr || req.body.cnrNumber || req.body.payload;
    const identifierType = req.body.identifierType || 'CNR';

    if (!rawId || typeof rawId !== 'string' || !rawId.trim()) {
      return res.status(200).json({
        success: false,
        status: 'INVALID_CASE_IDENTIFIER',
        message: 'CNR could not be matched. Please verify the CNR.',
        officialUrl: 'https://services.ecourts.gov.in/',
      });
    }

    const identifier = rawId.trim().toUpperCase();

    // Verify 16-character CNR format
    if (identifierType === 'CNR') {
      const cnrRegex = /^[A-Z]{2}[A-Z0-9]{2}\d{12}$/;
      if (!cnrRegex.test(identifier)) {
        return res.status(200).json({
          success: false,
          status: 'INVALID_CASE_IDENTIFIER',
          message: 'CNR could not be matched. Please verify the CNR.',
          officialUrl: 'https://services.ecourts.gov.in/',
        });
      }
    }

    try {
      const db = getDb ? getDb() : (req.app?.locals?.db || null);
      const result = await caseLookupService.lookupCase(
        identifier,
        'cnr-lookup',
        db
      );

      return res.status(200).json({
        ...result,
        officialUrl: result.officialUrl || 'https://services.ecourts.gov.in/',
      });
    } catch (err: any) {
      console.error('[CaseRoutes] Error in /lookup:', err);
      return res.status(200).json({
        success: false,
        status: 'SOURCE_UNAVAILABLE',
        message: 'Unable to retrieve case details automatically.',
        officialUrl: 'https://services.ecourts.gov.in/',
      });
    }
  });

  return router;
}
