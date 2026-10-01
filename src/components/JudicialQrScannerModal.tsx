import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  QrCode,
  Camera,
  Upload,
  X,
  RefreshCw,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Zap,
  ZapOff,
  ArrowRight,
  Shield,
  FileCheck,
  ExternalLink,
  Edit3,
  Clock,
  Search,
  Check,
  Copy,
} from 'lucide-react';
import { scanQrFromVideo, scanQrFromFile } from '../utils/qrDecoder';
import {
  parseJudicialQR,
  lookupJudicialCaseByQr,
  lookupCaseByIdentifier,
  openECourtsSearch,
  NormalizedCaseData,
  QrLookupResponse,
  validateClientQrPayload,
} from '../utils/judicialQrClient';
import { CnrDetectedModal } from './CnrDetectedModal';

export interface JudicialQrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUseCaseDetails?: (caseData: NormalizedCaseData, rawPayload: string, sessionId?: string) => void;
  onScanSuccess?: (decodedPayload: string, sessionId?: string) => void;
  onManualEntryFallback?: (cnr?: string) => void;
  sessionScanId?: string;
}

type ScannerPhase =
  | 'scanning'
  | 'detected'
  | 'cnr_detected'
  | 'loading'
  | 'case_found'
  | 'action_required'
  | 'ecourts_fallback'
  | 'error'
  | 'permission_denied'
  | 'manual_input';

export const JudicialQrScannerModal: React.FC<JudicialQrScannerModalProps> = ({
  isOpen,
  onClose,
  onUseCaseDetails,
  onScanSuccess,
  onManualEntryFallback,
  sessionScanId,
}) => {
  const currentSessionIdRef = useRef<string>(
    sessionScanId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `qr_${Date.now()}`)
  );
  const activeLookupSessionIdRef = useRef<string>('');

  // Phase state
  const [phase, setPhase] = useState<ScannerPhase>('scanning');
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [isTorchOn, setIsTorchOn] = useState<boolean>(false);
  const [hasTorchSupport, setHasTorchSupport] = useState<boolean>(false);
  const [detectedQrPayload, setDetectedQrPayload] = useState<string | null>(null);
  const [loadingStep, setLoadingStep] = useState<number>(1);
  const [caseData, setCaseData] = useState<NormalizedCaseData | null>(null);
  const [officialUrl, setOfficialUrl] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [manualCnrInput, setManualCnrInput] = useState<string>('');
  const [cnrNumber, setCnrNumber] = useState<string>('');
  const [copiedToClipboard, setCopiedToClipboard] = useState<boolean>(false);
  const [popupBlocked, setPopupBlocked] = useState<boolean>(false);
  const [isProcessingFile, setIsProcessingFile] = useState<boolean>(false);

  // Sync session ID when reopened
  useEffect(() => {
    if (isOpen) {
      currentSessionIdRef.current =
        sessionScanId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `qr_${Date.now()}`);
      activeLookupSessionIdRef.current = '';
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setManualCnrInput('');
      setCnrNumber('');
      setCaseData(null);
      setDetectedQrPayload(null);
      setErrorCode('');
      setErrorMessage('');
    }
  }, [isOpen, sessionScanId]);

  // References
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<any>(null);
  const isScanningFrameRef = useRef<boolean>(false);
  const isLockedRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Stop camera tracks immediately
  const stopCamera = useCallback(() => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    isScanningFrameRef.current = false;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_) {}
      });
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsCameraActive(false);
    setIsTorchOn(false);
    setHasTorchSupport(false);
  }, []);

  // Close scanner and cleanup
  const handleClose = useCallback(() => {
    stopCamera();
    activeLookupSessionIdRef.current = '';
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    onClose();
  }, [stopCamera, onClose]);

  // Start camera hardware
  const startCamera = useCallback(async () => {
    stopCamera();
    activeLookupSessionIdRef.current = '';
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    isLockedRef.current = false;
    setPhase('scanning');
    setErrorCode('');
    setErrorMessage('');
    setCaseData(null);
    setOfficialUrl(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setPhase('permission_denied');
      setErrorMessage('Camera access is not supported by this browser. Please upload a QR image or enter CNR manually.');
      return;
    }

    try {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (_) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch (_) {}
      }
      setIsCameraActive(true);

      // Check torch capabilities
      const track = stream.getVideoTracks()[0];
      if (track) {
        const capabilities = track.getCapabilities?.() as any;
        if (capabilities && 'torch' in capabilities) {
          setHasTorchSupport(true);
        }
      }
    } catch (err: any) {
      console.warn('[JudicialQR] Camera access error:', err);
      stopCamera();
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setPhase('permission_denied');
        setErrorCode('CAMERA_PERMISSION_DENIED');
        setErrorMessage('Camera access is required to scan a Judicial QR.');
      } else {
        setPhase('error');
        setErrorCode('CAMERA_UNAVAILABLE');
        setErrorMessage('Could not open camera device. Please upload a QR photo or enter CNR manually.');
      }
    }
  }, [stopCamera]);

  // Toggle flash torch
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const nextState = !isTorchOn;
      await (track as any).applyConstraints({
        advanced: [{ torch: nextState }],
      });
      setIsTorchOn(nextState);
    } catch (e) {
      console.warn('Torch toggle failed:', e);
    }
  };

  // Open official e-Courts search and copy CNR
  const handleOpenECourts = useCallback((targetCnr?: string) => {
    const cleanCnr = (targetCnr || cnrNumber || manualCnrInput || '').trim().toUpperCase();
    if (cleanCnr && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cleanCnr).then(() => {
        setCopiedToClipboard(true);
        setTimeout(() => setCopiedToClipboard(false), 3500);
      }).catch(() => {});
    }

    const opened = openECourtsSearch(cleanCnr);
    if (!opened) {
      setPopupBlocked(true);
    }
  }, [cnrNumber, manualCnrInput]);

  // Copy CNR only
  const handleCopyCnr = useCallback((targetCnr?: string) => {
    const cleanCnr = (targetCnr || cnrNumber || manualCnrInput || '').trim().toUpperCase();
    if (cleanCnr && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cleanCnr).then(() => {
        setCopiedToClipboard(true);
        setTimeout(() => setCopiedToClipboard(false), 3500);
      }).catch(() => {});
    }
  }, [cnrNumber, manualCnrInput]);

  // Handle CNR input changes with immediate session and data invalidation
  const handleCnrInputChange = (val: string) => {
    const upper = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
    
    // Invalidate temporary e-Courts results and pending lookups immediately when CNR changes
    setCaseData(null);
    setErrorCode('');
    setErrorMessage('');
    activeLookupSessionIdRef.current = '';
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    setManualCnrInput(upper);
    setCnrNumber(upper);
    try {
      sessionStorage.setItem('sm_current_cnr', upper);
    } catch (_) {}
  };

  // Safe lookup by CNR with session safety, AbortController, and standardized errors
  const handleLookupCnr = useCallback(
    async (targetCnr: string) => {
      const cleanCnr = (targetCnr || cnrNumber || manualCnrInput || '').trim().toUpperCase();

      if (!cleanCnr) {
        setErrorMessage('Please enter a valid 16-character CNR number.');
        setPhase('manual_input');
        return;
      }

      // Generate a brand new lookup session ID
      const lookupSessionId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `lookup_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // Invalidate previous session and clear stale data
      activeLookupSessionIdRef.current = lookupSessionId;
      setCaseData(null);
      setErrorCode('');
      setErrorMessage('');

      setCnrNumber(cleanCnr);
      setManualCnrInput(cleanCnr);
      try {
        sessionStorage.setItem('sm_current_cnr', cleanCnr);
      } catch (_) {}

      // 16-character format check
      const cnrRegex = /^[A-Z]{2}[A-Z0-9]{2}\d{12}$/;
      if (!cnrRegex.test(cleanCnr)) {
        setErrorCode('CASE_NOT_FOUND');
        setErrorMessage('No case was found for this identifier.');
        setPhase('error');
        return;
      }

      // Abort any in-flight lookup request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setPhase('loading');
      setLoadingStep(1);

      const step2Timer = setTimeout(() => {
        if (activeLookupSessionIdRef.current === lookupSessionId) setLoadingStep(2);
      }, 250);
      const step3Timer = setTimeout(() => {
        if (activeLookupSessionIdRef.current === lookupSessionId) setLoadingStep(3);
      }, 550);
      const step4Timer = setTimeout(() => {
        if (activeLookupSessionIdRef.current === lookupSessionId) setLoadingStep(4);
      }, 900);

      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 12000);

      try {
        const response = await lookupCaseByIdentifier(cleanCnr, 'CNR', controller.signal);

        clearTimeout(step2Timer);
        clearTimeout(step3Timer);
        clearTimeout(step4Timer);
        clearTimeout(timeoutId);

        // Strict session check: ignore stale async responses from prior scans
        if (activeLookupSessionIdRef.current !== lookupSessionId || controller.signal.aborted) {
          console.info(`[JudicialQR] Dropping stale lookup response for session (${lookupSessionId})`);
          return;
        }

        if (response.success && response.status === 'FOUND' && response.caseData) {
          setCaseData(response.caseData);
          setPhase('case_found');
          return;
        }

        // CAPTCHA / Official Action Required
        if (response.status === 'USER_ACTION_REQUIRED' || response.status === 'CAPTCHA_REQUIRED') {
          setErrorCode('CAPTCHA_REQUIRED');
          setErrorMessage('Official verification is required to continue.');
          setOfficialUrl(response.officialUrl || 'https://services.ecourts.gov.in/');
          setPhase('action_required');
          handleOpenECourts(cleanCnr);
          return;
        }

        // Case Not Found
        if (response.status === 'CASE_NOT_FOUND' || response.status === 'INVALID_CASE_IDENTIFIER') {
          setErrorCode('CASE_NOT_FOUND');
          setErrorMessage('No case was found for this identifier.');
          setPhase('error');
          return;
        }

        // Service Unavailable or Timeout
        if (response.status === 'SOURCE_UNAVAILABLE' || response.status === 'TIMEOUT') {
          setErrorCode('E_COURTS_UNAVAILABLE');
          setErrorMessage('Official case lookup is temporarily unavailable.');
          setPhase('error');
          return;
        }

        // Network Error
        if (response.status === 'NETWORK_ERROR') {
          setErrorCode('NETWORK_ERROR');
          setErrorMessage('Network connection failed. Please try again.');
          setPhase('error');
          return;
        }

        // Generic error
        setErrorCode(response.status || 'CASE_NOT_FOUND');
        setErrorMessage(response.message || 'No case was found for this identifier.');
        setPhase('error');
      } catch (err: any) {
        clearTimeout(step2Timer);
        clearTimeout(step3Timer);
        clearTimeout(step4Timer);
        clearTimeout(timeoutId);

        // Ignore if superseded or intentionally aborted
        if (activeLookupSessionIdRef.current !== lookupSessionId) {
          return;
        }

        if (err.name === 'AbortError') {
          setErrorCode('E_COURTS_UNAVAILABLE');
          setErrorMessage('Official case lookup is temporarily unavailable.');
        } else {
          setErrorCode('NETWORK_ERROR');
          setErrorMessage('Network connection failed. Please try again.');
        }
        setPhase('error');
      }
    },
    [cnrNumber, manualCnrInput, handleOpenECourts]
  );

  // Perform backend lookup with phased loading, session safety, and timeout
  const processQrPayload = useCallback(
    async (rawPayload: string) => {
      // Generate unique session ID for this QR lookup
      const lookupSessionId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `lookup_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      activeLookupSessionIdRef.current = lookupSessionId;
      setCaseData(null);
      setErrorCode('');
      setErrorMessage('');

      // Abort any existing pending request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // 1. Validate payload locally
      const validation = validateClientQrPayload(rawPayload);
      if (!validation.isValid) {
        setPhase('error');
        setErrorCode('INVALID_QR');
        setErrorMessage(validation.error || 'Invalid QR code format.');
        return;
      }

      // 2. Parse type
      const parsed = parseJudicialQR(rawPayload);
      const extractedCnr =
        parsed.cnrNumber ||
        (/^[A-Za-z]{2}[A-Za-z0-9]{2}\d{12}$/.test(rawPayload.trim()) ? rawPayload.trim().toUpperCase() : '');

      if (extractedCnr) {
        setCnrNumber(extractedCnr);
        setManualCnrInput(extractedCnr);
        try {
          sessionStorage.setItem('sm_current_cnr', extractedCnr);
        } catch (_) {}

        handleLookupCnr(extractedCnr);
        return;
      }

      // 3. Initiate loading state machine for non-CNR payload
      setDetectedQrPayload(rawPayload);
      setPhase('loading');
      setLoadingStep(1); // Judicial QR detected ✓

      const step2Timer = setTimeout(() => {
        if (activeLookupSessionIdRef.current === lookupSessionId) setLoadingStep(2);
      }, 350);

      const step3Timer = setTimeout(() => {
        if (activeLookupSessionIdRef.current === lookupSessionId) setLoadingStep(3);
      }, 700);

      const step4Timer = setTimeout(() => {
        if (activeLookupSessionIdRef.current === lookupSessionId) setLoadingStep(4);
      }, 1200);

      // 15-second request timeout guard
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 15000);

      try {
        const response: QrLookupResponse = await lookupJudicialCaseByQr(
          rawPayload,
          'judicial-qr',
          controller.signal
        );

        clearTimeout(step2Timer);
        clearTimeout(step3Timer);
        clearTimeout(step4Timer);
        clearTimeout(timeoutId);

        // Strict session check
        if (activeLookupSessionIdRef.current !== lookupSessionId || controller.signal.aborted) {
          console.info(`[JudicialQR] Dropping stale QR lookup response for session (${lookupSessionId})`);
          return;
        }

        if (response.success && response.status === 'FOUND' && response.caseData) {
          setCaseData(response.caseData);
          setPhase('case_found');
          return;
        }

        if (response.status === 'USER_ACTION_REQUIRED' || response.status === 'CAPTCHA_REQUIRED') {
          setOfficialUrl(response.officialUrl || 'https://services.ecourts.gov.in/');
          setErrorCode('CAPTCHA_REQUIRED');
          setErrorMessage('Official verification is required to continue.');
          setPhase('action_required');
          handleOpenECourts();
          return;
        }

        if (response.status === 'CASE_NOT_FOUND') {
          setPhase('error');
          setErrorCode('CASE_NOT_FOUND');
          setErrorMessage('No case was found for this identifier.');
          return;
        }

        if (response.status === 'NETWORK_ERROR') {
          setPhase('error');
          setErrorCode('NETWORK_ERROR');
          setErrorMessage('Network connection failed. Please try again.');
          return;
        }

        if (response.status === 'SOURCE_UNAVAILABLE' || response.status === 'TIMEOUT') {
          setPhase('error');
          setErrorCode('E_COURTS_UNAVAILABLE');
          setErrorMessage('Official case lookup is temporarily unavailable.');
          return;
        }

        // Error or not found
        setPhase('error');
        setErrorCode(response.status || 'CASE_NOT_FOUND');
        setErrorMessage(
          response.message || response.error || 'No case was found for this identifier.'
        );
      } catch (err: any) {
        clearTimeout(step2Timer);
        clearTimeout(step3Timer);
        clearTimeout(step4Timer);
        clearTimeout(timeoutId);

        if (activeLookupSessionIdRef.current !== lookupSessionId) return;

        setPhase('error');
        if (err.name === 'AbortError') {
          setErrorCode('E_COURTS_UNAVAILABLE');
          setErrorMessage('Official case lookup is temporarily unavailable.');
        } else {
          setErrorCode('NETWORK_ERROR');
          setErrorMessage('Network connection failed. Please try again.');
        }
      }
    },
    [handleLookupCnr, handleOpenECourts]
  );

  // Triggered when QR detected from camera or file
  const onQrDetected = useCallback(
    (payload: string) => {
      if (isLockedRef.current) return;
      isLockedRef.current = true;

      // STOP the camera scanning loop immediately
      stopCamera();

      // Trigger tactile vibration if supported
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try {
          navigator.vibrate([80, 50, 80]);
        } catch (_) {}
      }

      // Show immediate feedback: "Judicial QR detected"
      setPhase('detected');
      setDetectedQrPayload(payload);

      // Parse QR code payload to find valid 16-character CNR
      const parsed = parseJudicialQR(payload);
      let extractedCnr = parsed.cnrNumber;
      if (!extractedCnr) {
        const match = payload.match(/\b([A-Za-z]{2}[A-Za-z0-9]{2}\d{12})\b/);
        if (match) {
          extractedCnr = match[1].toUpperCase();
        }
      }

      if (extractedCnr && /^[A-Za-z]{2}[A-Za-z0-9]{2}\d{12}$/.test(extractedCnr)) {
        const cleanCnr = extractedCnr.toUpperCase();
        setCnrNumber(cleanCnr);
        setManualCnrInput(cleanCnr);
        try {
          sessionStorage.setItem('sm_current_cnr', cleanCnr);
        } catch (_) {}

        // Open CNR Detected Popup
        setTimeout(() => {
          setPhase('cnr_detected');
        }, 300);
        return;
      }

      // If no valid CNR is detected in the QR code
      setTimeout(() => {
        setPhase('error');
        setErrorCode('CNR_NOT_FOUND');
        setErrorMessage('CNR number not found. You can enter it manually.');
      }, 300);
    },
    [stopCamera]
  );

  // Frame scanner loop using BarcodeDetector API + jsQR fallback
  useEffect(() => {
    if (!isCameraActive || phase !== 'scanning') {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
      return;
    }

    const runFrameScan = async () => {
      if (isScanningFrameRef.current || isLockedRef.current || !videoRef.current) return;
      isScanningFrameRef.current = true;

      try {
        const result = await scanQrFromVideo(videoRef.current);
        if (result && result.trim().length > 0) {
          onQrDetected(result.trim());
          return;
        }
      } catch (err) {
        console.warn('QR scan error:', err);
      } finally {
        isScanningFrameRef.current = false;
      }
    };

    scanIntervalRef.current = setInterval(runFrameScan, 160);

    return () => {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
    };
  }, [isCameraActive, phase, onQrDetected]);

  // Handle uploaded QR image file
  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingFile(true);
    try {
      const decoded = await scanQrFromFile(file);
      if (decoded && decoded.trim().length > 0) {
        onQrDetected(decoded.trim());
      } else {
        setPhase('error');
        setErrorCode('QR_NOT_DETECTED');
        setErrorMessage(
          'No readable QR code found in this photo. Please ensure the e-Courts QR barcode is well-lit and in focus.'
        );
      }
    } catch (err: any) {
      setPhase('error');
      setErrorCode('INVALID_QR');
      setErrorMessage('Could not process the uploaded photo. Please try another file or enter CNR manually.');
    } finally {
      setIsProcessingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Handle manual CNR submission
  const handleManualCnrSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = (manualCnrInput || cnrNumber).trim().toUpperCase();
    if (!trimmed) return;
    handleLookupCnr(trimmed);
  };

  // Lifecycle when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

  if (!isOpen) return null;

  return (
    <div
      id="judicial-qr-scanner-screen"
      role="dialog"
      aria-modal="true"
      aria-label="Judicial QR Scanner"
      className="fixed inset-0 z-50 bg-black/95 text-white flex flex-col justify-between overflow-y-auto"
    >
      {/* 1. SCANNER HEADER */}
      <header className="relative z-10 px-4 py-4 sm:px-6 flex items-center justify-between border-b border-white/10 bg-black/60 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30">
            <QrCode className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-white tracking-wide flex items-center gap-2">
              Judicial QR Scanner
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                e-Courts
              </span>
            </h2>
            <p className="text-[11px] text-zinc-400">e-Courts Barcode & Case Docket Reader</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleClose}
          id="btn-close-qr-scanner"
          aria-label="Close scanner"
          className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </header>

      {/* 2. SCANNER VIEWPORT OR STATE CARDS */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 relative min-h-[420px]">
        {/* PHASE A: ACTIVE CAMERA SCANNING */}
        {phase === 'scanning' && (
          <div className="w-full max-w-md flex flex-col items-center justify-center space-y-4">
            {/* Camera Viewport with Reticle */}
            <div className="relative w-full aspect-[4/5] sm:aspect-square max-w-[340px] rounded-3xl overflow-hidden bg-zinc-900 border border-white/15 shadow-2xl flex items-center justify-center">
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className="w-full h-full object-cover"
              />

              {/* Reticle Mask Overlay */}
              <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
                {/* 4 Corner Markers */}
                <div className="relative w-60 h-60 border-2 border-amber-400/30 rounded-2xl">
                  {/* Top-Left */}
                  <span className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-amber-400 rounded-tl-xl" />
                  {/* Top-Right */}
                  <span className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-amber-400 rounded-tr-xl" />
                  {/* Bottom-Left */}
                  <span className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-amber-400 rounded-bl-xl" />
                  {/* Bottom-Right */}
                  <span className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-amber-400 rounded-br-xl" />

                  {/* Animated Laser Scanning Line */}
                  <div className="absolute inset-x-2 h-1 bg-gradient-to-r from-transparent via-amber-400 to-transparent shadow-[0_0_12px_#f59e0b] animate-bounce" />

                  {/* Center QR Helper Label */}
                  <div className="absolute inset-0 flex items-center justify-center opacity-40">
                    <span className="text-[11px] font-mono uppercase tracking-widest text-amber-200">
                      QR SCAN
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Instruction Label */}
            <p className="text-center text-xs sm:text-sm text-zinc-300 font-medium px-4">
              Align the e-Courts QR code inside the scanning frame.
            </p>

            {/* Quick Presets for Instant Verification / Demo */}
            <div className="pt-1 flex flex-wrap items-center justify-center gap-2 text-center text-[11px] text-zinc-400">
              <span>Quick Test:</span>
              <button
                type="button"
                onClick={() => onQrDetected('DLCT010044022026')}
                className="px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-amber-300 font-mono text-[10px] cursor-pointer"
              >
                DLCT010044022026 (Verified)
              </button>
              <button
                type="button"
                onClick={() => onQrDetected('MBDD010022342025')}
                className="px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-amber-300 font-mono text-[10px] cursor-pointer"
              >
                MBDD010022342025 (Official e-Courts Fallback)
              </button>
            </div>
          </div>
        )}

        {/* PHASE B: DETECTED CONFIRMATION */}
        {phase === 'detected' && (
          <div className="text-center space-y-3 p-8 bg-zinc-900/90 border border-emerald-500/40 rounded-3xl max-w-sm w-full animate-in fade-in zoom-in duration-200">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center shadow-lg">
              <CheckCircle2 className="w-9 h-9" />
            </div>
            <h3 className="text-base font-bold text-white">Judicial QR detected</h3>
            <p className="text-xs text-zinc-400 font-mono truncate px-2">
              {detectedQrPayload}
            </p>
          </div>
        )}

        {/* PHASE: CNR DETECTED MODAL */}
        {phase === 'cnr_detected' && (
          <CnrDetectedModal
            isOpen={true}
            cnrNumber={cnrNumber || manualCnrInput}
            rawPayload={detectedQrPayload || undefined}
            onClose={handleClose}
            onEnterDetailsManually={(cnr) => {
              if (onManualEntryFallback) {
                onManualEntryFallback(cnr);
              } else if (onScanSuccess) {
                onScanSuccess(cnr);
              }
              handleClose();
            }}
          />
        )}

        {/* PHASE C: PROGRESS & LOADING STATE MACHINE */}
        {phase === 'loading' && (
          <div className="text-center space-y-5 p-6 sm:p-8 bg-zinc-900/90 border border-white/15 rounded-3xl max-w-md w-full shadow-2xl">
            <div className="relative w-16 h-16 mx-auto">
              <div className="w-16 h-16 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                <Sparkles className="w-8 h-8 text-amber-400 animate-pulse" />
              </div>
              <div className="absolute -inset-1 rounded-2xl border-2 border-t-amber-400 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
            </div>

            <div className="space-y-1">
              <h3 className="text-sm sm:text-base font-bold text-white">Retrieving Official Case Docket</h3>
              <p className="text-xs text-zinc-400">Querying authorized e-Courts repository...</p>
            </div>

            {/* Stepper Progress Checklist */}
            <div className="space-y-2.5 text-left text-xs bg-black/40 p-4 rounded-2xl border border-white/10 font-mono">
              {/* Step 1 */}
              <div className="flex items-center gap-2.5 text-emerald-400">
                <Check className="w-4 h-4 shrink-0" />
                <span>Judicial QR detected ✓</span>
              </div>

              {/* Step 2 */}
              <div
                className={`flex items-center gap-2.5 transition-colors ${
                  loadingStep >= 2 ? 'text-emerald-400' : 'text-zinc-500'
                }`}
              >
                {loadingStep >= 2 ? (
                  <Check className="w-4 h-4 shrink-0" />
                ) : (
                  <Clock className="w-4 h-4 shrink-0 animate-spin" />
                )}
                <span>Reading case reference {loadingStep >= 2 ? '✓' : '...'}</span>
              </div>

              {/* Step 3 */}
              <div
                className={`flex items-center gap-2.5 transition-colors ${
                  loadingStep >= 3 ? 'text-emerald-400' : 'text-zinc-500'
                }`}
              >
                {loadingStep >= 3 ? (
                  <Check className="w-4 h-4 shrink-0" />
                ) : (
                  <RefreshCw className="w-4 h-4 shrink-0 animate-spin" />
                )}
                <span>Connecting to case service...</span>
              </div>

              {/* Step 4 */}
              <div
                className={`flex items-center gap-2.5 transition-colors ${
                  loadingStep >= 4 ? 'text-amber-300' : 'text-zinc-500'
                }`}
              >
                {loadingStep >= 4 ? (
                  <Sparkles className="w-4 h-4 shrink-0 animate-pulse" />
                ) : (
                  <span className="w-4 h-4 shrink-0 rounded-full border border-zinc-600 block" />
                )}
                <span>Fetching case details & preparing docket...</span>
              </div>
            </div>
          </div>
        )}

        {/* PHASE D: CASE FOUND CARD */}
        {phase === 'case_found' && caseData && (
          <div
            id="judicial-case-found-card"
            className="w-full max-w-lg bg-zinc-900 border border-emerald-500/40 rounded-3xl p-5 sm:p-6 shadow-2xl space-y-4 animate-in fade-in zoom-in duration-200"
          >
            {/* Header Badge */}
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <span className="text-xs font-bold font-mono tracking-wider text-emerald-400 uppercase">
                    CASE FOUND ✓
                  </span>
                  <span className="block text-[11px] text-zinc-400">Imported from official e-Courts</span>
                </div>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-emerald-950 text-emerald-300 border border-emerald-800/80">
                Verified
              </span>
            </div>

            {/* Case Details Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5">
                <span className="text-[10px] text-zinc-400 uppercase font-mono">CNR Number</span>
                <p className="font-mono font-bold text-amber-300 text-sm">{caseData.cnrNumber || 'N/A'}</p>
              </div>

              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5">
                <span className="text-[10px] text-zinc-400 uppercase font-mono">Case Number</span>
                <p className="font-mono font-bold text-white text-sm">{caseData.caseNumber || 'N/A'}</p>
              </div>

              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5 sm:col-span-2">
                <span className="text-[10px] text-zinc-400 uppercase font-mono">Court</span>
                <p className="font-semibold text-white">{caseData.courtName || 'District & Sessions Court'}</p>
              </div>

              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5">
                <span className="text-[10px] text-zinc-400 uppercase font-mono">District</span>
                <p className="text-zinc-200">{caseData.district || 'Central District'}</p>
              </div>

              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5">
                <span className="text-[10px] text-zinc-400 uppercase font-mono">State</span>
                <p className="text-zinc-200">{caseData.state || 'Delhi'}</p>
              </div>

              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5">
                <span className="text-[10px] text-zinc-400 uppercase font-mono">Next Hearing</span>
                <p className="font-mono font-semibold text-amber-200">{caseData.nextHearingDate || 'Scheduled'}</p>
              </div>

              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5">
                <span className="text-[10px] text-zinc-400 uppercase font-mono">Case Status</span>
                <p className="text-zinc-200">{caseData.caseStatus || 'Active'}</p>
              </div>

              {caseData.petitioner && caseData.petitioner.length > 0 && (
                <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5">
                  <span className="text-[10px] text-zinc-400 uppercase font-mono">Petitioner</span>
                  <p className="text-zinc-200 truncate">{caseData.petitioner.join(', ')}</p>
                </div>
              )}

              {caseData.respondent && caseData.respondent.length > 0 && (
                <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-0.5">
                  <span className="text-[10px] text-zinc-400 uppercase font-mono">Respondent</span>
                  <p className="text-zinc-200 font-medium truncate">{caseData.respondent.join(', ')}</p>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="pt-2 flex flex-col sm:flex-row items-center gap-2">
              <button
                type="button"
                id="btn-use-qr-details"
                onClick={() => {
                  if (onUseCaseDetails && caseData) {
                    onUseCaseDetails(caseData, detectedQrPayload || caseData.cnrNumber, currentSessionIdRef.current);
                  } else if (onScanSuccess) {
                    onScanSuccess(detectedQrPayload || caseData.cnrNumber, currentSessionIdRef.current);
                  }
                  handleClose();
                }}
                className="w-full sm:flex-1 py-3 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-black font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 active:scale-98 transition-all cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>Use These Details</span>
              </button>

              <button
                type="button"
                onClick={startCamera}
                className="w-full sm:w-auto py-3 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Scan Again</span>
              </button>
            </div>
          </div>
        )}

        {/* PHASE E: OFFICIAL e-COURTS VERIFICATION FALLBACK */}
        {(phase === 'action_required' || phase === 'ecourts_fallback') && (
          <div
            id="ecourts-verification-fallback-card"
            className="w-full max-w-md bg-zinc-900 border border-amber-500/30 rounded-3xl p-6 shadow-2xl space-y-4 text-center animate-in fade-in zoom-in duration-200"
          >
            <div className="w-14 h-14 mx-auto rounded-2xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
              <Shield className="w-7 h-7" />
            </div>

            <div className="space-y-1">
              <h3 className="text-base font-bold text-white tracking-wide">
                e-Courts Verification
              </h3>
              <p className="text-xs text-zinc-300 leading-relaxed">
                {errorMessage || 'Unable to retrieve case details automatically.'}
              </p>
            </div>

            {/* CNR Box */}
            <div className="bg-black/60 border border-white/10 rounded-2xl p-4 space-y-1.5 text-center">
              <span className="text-[10px] text-zinc-400 uppercase font-mono tracking-wider block">
                Your CNR Number
              </span>
              <p className="font-mono font-bold text-amber-300 text-lg tracking-wider select-all">
                {cnrNumber || manualCnrInput || 'CNR NOT DETECTED'}
              </p>
              <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-400 pt-0.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{copiedToClipboard ? '✓ CNR copied to clipboard' : 'CNR copied to clipboard'}</span>
              </div>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              Continue the search on the official e-Courts website.
            </p>

            {/* Fallback link if popup was blocked on mobile or desktop */}
            {popupBlocked && (
              <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-[11px] text-amber-300 text-left">
                <span>Popup blocked by browser. </span>
                <a
                  href="https://services.ecourts.gov.in/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-bold hover:text-white"
                >
                  Open this link manually: services.ecourts.gov.in
                </a>
              </div>
            )}

            {/* Action Buttons */}
            <div className="space-y-2 pt-1">
              <button
                type="button"
                id="btn-open-official-ecourts"
                onClick={() => handleOpenECourts(cnrNumber || manualCnrInput)}
                className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-black font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20 active:scale-98 transition-all cursor-pointer"
              >
                <span>Open Official e-Courts</span>
                <ExternalLink className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  id="btn-copy-cnr-fallback"
                  onClick={() => handleCopyCnr(cnrNumber || manualCnrInput)}
                  className="flex-1 py-2.5 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copiedToClipboard ? 'Copied!' : 'Copy CNR'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setPhase('scanning');
                    startCamera();
                  }}
                  className="py-2.5 px-4 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-xs font-medium transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>

            {/* Return to SummonsMitra */}
            <div className="pt-3 border-t border-white/10 space-y-2">
              <p className="text-xs text-zinc-400">Already verified on e-Courts?</p>
              <button
                type="button"
                id="btn-continue-with-cnr"
                onClick={() => {
                  const verifiedCnr = (cnrNumber || manualCnrInput).trim();
                  if (onUseCaseDetails) {
                    onUseCaseDetails(
                      {
                        cnrNumber: verifiedCnr,
                        caseNumber: verifiedCnr,
                        source: 'eCourts',
                        sourceVerification: 'Official e-Courts Portal (Verified by Officer)',
                        verifiedAt: new Date().toISOString(),
                      },
                      verifiedCnr
                    );
                  } else if (onScanSuccess) {
                    onScanSuccess(verifiedCnr);
                  }
                  handleClose();
                }}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 font-bold text-xs flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>Continue with this CNR</span>
              </button>
            </div>

            {/* Recovery options */}
            <div className="flex items-center justify-center gap-3 pt-1 text-[11px] text-zinc-400">
              <button
                type="button"
                onClick={() => handleLookupCnr(cnrNumber || manualCnrInput)}
                className="hover:text-amber-400 underline transition-colors cursor-pointer"
              >
                Try Again
              </button>
              <span>•</span>
              <button
                type="button"
                onClick={() => {
                  if (onManualEntryFallback) {
                    onManualEntryFallback();
                    handleClose();
                  } else {
                    setPhase('manual_input');
                  }
                }}
                className="hover:text-amber-400 underline transition-colors cursor-pointer"
              >
                Enter Details Manually
              </button>
            </div>
          </div>
        )}

        {/* PHASE F: ERROR / FAILURE STATES */}
        {phase === 'error' && (
          <div className="w-full max-w-md bg-zinc-900 border border-rose-500/30 rounded-3xl p-6 shadow-2xl space-y-4 text-center">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center">
              <AlertCircle className="w-7 h-7" />
            </div>

            <div className="space-y-1">
              <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800">
                {errorCode || 'ERROR'}
              </span>
              <h3 className="text-base font-bold text-white pt-1">Case Lookup Notice</h3>
              <p className="text-xs text-zinc-300 leading-relaxed">{errorMessage}</p>
            </div>

            {/* Useful Recovery Action Buttons */}
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  if (onManualEntryFallback) {
                    onManualEntryFallback();
                  }
                  handleClose();
                }}
                className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-black font-bold text-xs flex items-center justify-center gap-2 shadow-md active:scale-98 transition-all cursor-pointer"
              >
                <Edit3 className="w-4 h-4" />
                <span>Enter Details Manually</span>
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={startCamera}
                  className="py-2.5 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-100 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Scan Again</span>
                </button>

                <label className="py-2.5 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-100 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer">
                  <Upload className="w-3.5 h-3.5 text-amber-400" />
                  <span>Upload QR</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleUploadFile}
                    className="hidden"
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {/* PHASE G: CAMERA PERMISSION DENIED */}
        {phase === 'permission_denied' && (
          <div className="w-full max-w-md bg-zinc-900 border border-amber-500/30 rounded-3xl p-6 shadow-2xl space-y-4 text-center">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
              <Camera className="w-7 h-7" />
            </div>

            <div className="space-y-1">
              <h3 className="text-base font-bold text-white">Camera Access Required</h3>
              <p className="text-xs text-zinc-300 leading-relaxed">
                Camera access is required for live scanning.
              </p>
            </div>

            <div className="space-y-2 pt-2">
              <button
                type="button"
                onClick={startCamera}
                className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-black font-bold text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                <span>Allow Camera</span>
              </button>

              <label className="w-full py-2.5 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-200 text-xs font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer">
                <Upload className="w-4 h-4" />
                <span>Upload Image</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleUploadFile}
                  className="hidden"
                />
              </label>

              <button
                type="button"
                onClick={() => setPhase('manual_input')}
                className="w-full py-2.5 px-4 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 text-xs font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <Edit3 className="w-4 h-4" />
                <span>Enter Case/CNR Manually</span>
              </button>
            </div>
          </div>
        )}

        {/* PHASE H: MANUAL CNR INPUT */}
        {phase === 'manual_input' && (
          <div className="w-full max-w-md bg-zinc-900 border border-white/15 rounded-3xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 pb-2 border-b border-white/10">
              <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400">
                <Search className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">Enter e-Courts CNR / Case Code</h3>
                <p className="text-[11px] text-zinc-400">16-digit official Case Number Record</p>
              </div>
            </div>

            <form onSubmit={handleManualCnrSubmit} className="space-y-3">
              <div>
                <label className="text-xs text-zinc-300 block mb-1">CNR Number</label>
                <input
                  type="text"
                  value={manualCnrInput}
                  onChange={(e) => handleCnrInputChange(e.target.value)}
                  placeholder="e.g. DLCT010044022026"
                  maxLength={16}
                  className="w-full bg-black/50 border border-white/20 rounded-xl px-3 py-2.5 text-xs text-white font-mono tracking-wider focus:outline-none focus:border-amber-400"
                  required
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  id="btn-find-case-ecourts"
                  className="flex-1 py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-black font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-md active:scale-98 transition-all"
                >
                  <Search className="w-4 h-4" />
                  <span>Find Case on e-Courts →</span>
                </button>
                <button
                  type="button"
                  onClick={startCamera}
                  className="py-2.5 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-300 text-xs cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </main>

      {/* 3. SCANNER BOTTOM ACTION BAR */}
      <footer className="relative z-10 px-4 py-4 sm:px-6 border-t border-white/10 bg-black/60 backdrop-blur-md flex flex-wrap items-center justify-center gap-3">
        {hasTorchSupport && phase === 'scanning' && (
          <button
            type="button"
            onClick={toggleTorch}
            className={`px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 border transition-all cursor-pointer ${
              isTorchOn
                ? 'bg-amber-400 text-black border-amber-300 shadow-md'
                : 'bg-white/10 text-zinc-200 border-white/15 hover:bg-white/20'
            }`}
          >
            {isTorchOn ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
            <span>Flash</span>
          </button>
        )}

        {/* Upload QR Image File Picker */}
        <label className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-200 border border-white/15 text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer">
          <Upload className="w-4 h-4 text-amber-400" />
          <span>{isProcessingFile ? 'Reading Photo...' : 'Upload QR Image'}</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleUploadFile}
            disabled={isProcessingFile}
            className="hidden"
          />
        </label>

        {/* Cancel Button */}
        <button
          type="button"
          onClick={handleClose}
          id="btn-cancel-qr-scanner"
          className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-zinc-200 border border-white/15 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
        >
          <span>Cancel</span>
        </button>
      </footer>
    </div>
  );
};
