import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactCrop, { centerCrop, makeAspectCrop, Crop, PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import {
  X,
  Camera,
  RotateCw,
  ZoomIn,
  ZoomOut,
  RefreshCw,
  Check,
  Upload,
  Zap,
  ZapOff,
  SwitchCamera,
  Sparkles,
  AlertCircle,
  AlertTriangle,
  FileCheck,
  ChevronRight,
  Loader2,
  Maximize2,
  FileText,
} from 'lucide-react';
import { scanSummonDocument, parseJudicialQRCode, OcrResult } from '../utils/ocrService';
import { scanQrFromCanvas } from '../utils/qrDecoder';

export interface ScanResultData {
  scanSessionId: string;
  originalDataUrl: string;
  croppedDataUrl: string;
  croppedBlob: Blob;
  originalFile: File;
  croppedFile: File;
  ocrResult: OcrResult;
  fileName: string;
  isManualEntry?: boolean;
}

interface DocumentCameraScannerProps {
  isOpen: boolean;
  onClose: () => void;
  onScanComplete: (result: ScanResultData) => void;
  initialImageSrc?: string | null;
  initialFileName?: string;
  sessionScanId?: string;
}

const generateScanSessionId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `scan_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
};

export type ScannerPhase =
  | 'scannerClosed'
  | 'scannerOpening'
  | 'cameraActive'
  | 'captured'
  | 'cropping'
  | 'processingOCR'
  | 'extractionError'
  | 'review';

function dataUrlToBlob(dataUrl: string): Blob {
  try {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const bstr = atob(parts[1] || '');
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (_) {
    return new Blob([], { type: 'image/jpeg' });
  }
}

function centerDocumentCrop(mediaWidth: number, mediaHeight: number) {
  // Center 90% crop suitable for portrait summons and court documents
  return centerCrop(
    {
      unit: '%',
      width: 90,
      height: 90,
      x: 5,
      y: 5,
    },
    mediaWidth,
    mediaHeight
  );
}

export const DocumentCameraScanner: React.FC<DocumentCameraScannerProps> = ({
  isOpen,
  onClose,
  onScanComplete,
  initialImageSrc,
  initialFileName,
  sessionScanId,
}) => {
  const activeSessionIdRef = useRef<string>(sessionScanId || generateScanSessionId());
  const ocrAbortControllerRef = useRef<AbortController | null>(null);

  // Overall workflow phase following user state machine
  const [phase, setPhase] = useState<ScannerPhase>(
    isOpen ? (initialImageSrc ? 'cropping' : 'scannerOpening') : 'scannerClosed'
  );

  // Camera stream state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isCameraStarting, setIsCameraStarting] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [currentCameraFacing, setCurrentCameraFacing] = useState<'environment' | 'user'>('environment');

  // Images state
  const [originalDataUrl, setOriginalDataUrl] = useState<string | null>(null);
  const [cropSourceUrl, setCropSourceUrl] = useState<string | null>(null);
  const [lastCroppedDataUrl, setLastCroppedDataUrl] = useState<string | null>(null);
  const [lastCroppedBlob, setLastCroppedBlob] = useState<Blob | null>(null);
  const [workingFileName, setWorkingFileName] = useState<string>('Summon_Scan.jpg');

  // Crop & zoom controls
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [rotationDegrees, setRotationDegrees] = useState<number>(0);
  const [isRotating, setIsRotating] = useState<boolean>(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Shutter flash effect
  const [shutterFlash, setShutterFlash] = useState(false);

  // OCR progression & error states
  const [ocrStepIndex, setOcrStepIndex] = useState<number>(1);
  const [ocrStepText, setOcrStepText] = useState<string>('Scanning document & optimizing...');
  const [ocrProgressPercent, setOcrProgressPercent] = useState<number>(15);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);

  // File input ref for upload fallback
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Helper to completely release camera hardware and LED
  const stopCameraStream = useCallback(() => {
    if (ocrAbortControllerRef.current) {
      ocrAbortControllerRef.current.abort();
      ocrAbortControllerRef.current = null;
    }
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
    setIsTorchOn(false);
    setIsCameraReady(false);
    setIsCameraStarting(false);
  }, []);

  // Prevent background scrolling while modal is open
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  // Clean up hardware on unmount or close
  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, [stopCameraStream]);

  // Connect video node to stream as soon as video mounts
  const setVideoNode = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      if (node.srcObject !== streamRef.current) {
        node.srcObject = streamRef.current;
      }
      node.play().catch((err) => {
        console.warn('[Camera] Video playback prompt:', err);
      });
    }
  }, []);

  // Check available cameras
  const enumerateVideoDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === 'videoinput');
      setAvailableCameras(videoDevices);
    } catch (e) {
      console.warn('[Camera] Enumerate devices failed:', e);
    }
  };

  // Start rear-facing camera stream
  const startCamera = useCallback(async (facing: 'environment' | 'user' = 'environment') => {
    setCameraError(null);
    setIsCameraStarting(true);
    setIsCameraReady(false);

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setCameraError('Camera access is required for live scanning. Please upload a photo instead.');
      setIsCameraStarting(false);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('Camera access is required for live scanning. Camera API is not supported on this browser. Please upload a photo instead.');
      setIsCameraStarting(false);
      return;
    }

    // Stop existing tracks before requesting new stream
    stopCameraStream();

    let stream: MediaStream | null = null;
    try {
      // 1. Mobile document camera: rear high-definition constraints
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch (e1: any) {
      console.warn('[Camera] Environment constraints failed, trying basic fallback:', e1);
      try {
        // 2. Basic video fallback
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      } catch (err: any) {
        console.error('[Camera] Access error:', err);
        setIsCameraStarting(false);
        setIsCameraReady(false);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setCameraError('Camera access is required for live scanning.');
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          setCameraError('No camera found on this device.');
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          setCameraError('Camera is already in use by another application or browser tab.');
        } else {
          setCameraError(err.message || 'Camera access is required for live scanning.');
        }
        return;
      }
    }

    if (!stream) return;
    streamRef.current = stream;

    // Check torch capability
    try {
      const track = stream.getVideoTracks()[0];
      if (track) {
        const caps = (track.getCapabilities && track.getCapabilities()) || {};
        setHasTorch(Boolean((caps as any).torch));
      }
    } catch (_) {
      setHasTorch(false);
    }

    // Connect to video element
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch((playErr) => {
        console.warn('[Camera] Play error:', playErr);
      });
    }

    enumerateVideoDevices();
  }, [stopCameraStream]);

  // Handle clean scanner close from any phase
  const handleCloseScanner = useCallback(() => {
    stopCameraStream();
    setPhase('scannerClosed');
    setOriginalDataUrl(null);
    setCropSourceUrl(null);
    setCrop(undefined);
    setCompletedCrop(undefined);
    onClose();
  }, [stopCameraStream, onClose]);

  // Initialize upon opening
  useEffect(() => {
    if (!isOpen) {
      stopCameraStream();
      setPhase('scannerClosed');
      setOriginalDataUrl(null);
      setCropSourceUrl(null);
      setCrop(undefined);
      setCompletedCrop(undefined);
      setZoomScale(1);
      setRotationDegrees(0);
      return;
    }

    if (initialImageSrc) {
      // Direct upload mode -> go directly to crop step without activating camera hardware
      const sId = sessionScanId || generateScanSessionId();
      activeSessionIdRef.current = sId;
      setOriginalDataUrl(initialImageSrc);
      setCropSourceUrl(initialImageSrc);
      setWorkingFileName(initialFileName || `Judicial_Summon_${Date.now()}.jpg`);
      setPhase('cropping');
    } else {
      // Default to live camera: scannerClosed -> scannerOpening -> cameraActive
      const sId = sessionScanId || generateScanSessionId();
      activeSessionIdRef.current = sId;
      setPhase('scannerOpening');
      startCamera('environment');
    }
  }, [isOpen, initialImageSrc, initialFileName, sessionScanId, startCamera, stopCameraStream]);

  // Toggle Torch/Flashlight
  const handleToggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const nextState = !isTorchOn;
      await track.applyConstraints({
        advanced: [{ torch: nextState } as any],
      });
      setIsTorchOn(nextState);
    } catch (err) {
      console.warn('[Camera] Torch toggle failed:', err);
    }
  };

  // Flip Camera (rear <-> front)
  const handleFlipCamera = () => {
    const nextFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
    setCurrentCameraFacing(nextFacing);
    startCamera(nextFacing);
  };

  // Capture current camera frame: cameraActive -> captured
  const handleCapture = () => {
    if (ocrAbortControllerRef.current) {
      ocrAbortControllerRef.current.abort();
      ocrAbortControllerRef.current = null;
    }
    if (!videoRef.current) return;
    const video = videoRef.current;

    if (
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return;
    }

    // Generate fresh session ID for this specific physical document capture
    const freshSessionId = generateScanSessionId();
    activeSessionIdRef.current = freshSessionId;

    // Shutter flash animation
    setShutterFlash(true);
    setTimeout(() => setShutterFlash(false), 180);

    // High resolution canvas capture
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const generatedName = `Judicial_Summon_${Date.now()}.jpg`;

    // Immediately stop live video tracks to save battery and turn off camera LED
    stopCameraStream();

    setOriginalDataUrl(dataUrl);
    setCropSourceUrl(dataUrl);
    setWorkingFileName(generatedName);
    setRotationDegrees(0);
    setZoomScale(1);

    // Transition: cameraActive -> captured (User reviews captured image full-screen)
    setPhase('captured');
  };

  // Retake photo: restart camera stream and reset preview with fresh session
  const handleRetake = () => {
    if (ocrAbortControllerRef.current) {
      ocrAbortControllerRef.current.abort();
      ocrAbortControllerRef.current = null;
    }
    const freshSessionId = generateScanSessionId();
    activeSessionIdRef.current = freshSessionId;

    if (initialImageSrc) {
      // In gallery photo mode, let user pick another photo
      fileInputRef.current?.click();
      return;
    }
    setOriginalDataUrl(null);
    setCropSourceUrl(null);
    setCrop(undefined);
    setCompletedCrop(undefined);
    setZoomScale(1);
    setRotationDegrees(0);
    setPhase('scannerOpening');
    startCamera(currentCameraFacing);
  };

  // Move from captured preview to crop step: captured -> cropping
  const handleProceedToCrop = () => {
    setPhase('cropping');
  };

  // Rotate image clockwise by 90 degrees
  const handleRotate90 = async () => {
    if (!cropSourceUrl || isRotating) return;
    setIsRotating(true);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = cropSourceUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = img.height;
      canvas.height = img.width;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((90 * Math.PI) / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        const rotatedUrl = canvas.toDataURL('image/jpeg', 0.92);
        setCropSourceUrl(rotatedUrl);
        setRotationDegrees((prev) => (prev + 90) % 360);
        setCrop(undefined);
        setCompletedCrop(undefined);
      }
    } catch (err) {
      console.warn('Rotation failed:', err);
    } finally {
      setIsRotating(false);
    }
  };

  // Reset crop to default centered document frame
  const handleResetCrop = () => {
    setZoomScale(1);
    if (imgRef.current) {
      setCrop(centerDocumentCrop(imgRef.current.width, imgRef.current.height));
    } else {
      setCrop(undefined);
    }
    setCompletedCrop(undefined);
  };

  // Handle image load in cropper
  const onCropperImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget;
    setCrop(centerDocumentCrop(width, height));
  };

  // Handle gallery upload button click from camera
  const handleSelectGalleryPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (ocrAbortControllerRef.current) {
      ocrAbortControllerRef.current.abort();
      ocrAbortControllerRef.current = null;
    }

    stopCameraStream();

    // Generate fresh session ID for new gallery file
    const freshSessionId = generateScanSessionId();
    activeSessionIdRef.current = freshSessionId;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setOriginalDataUrl(dataUrl);
      setCropSourceUrl(dataUrl);
      setWorkingFileName(file.name || `Judicial_Summon_${Date.now()}.jpg`);
      setRotationDegrees(0);
      setZoomScale(1);
      setPhase('cropping');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Generate cropped blob and trigger the multi-phase AI OCR scanning
  const handleConfirmCropAndScan = async () => {
    if (isExtracting) return; // Prevent double trigger
    if (!cropSourceUrl) return;

    if (ocrAbortControllerRef.current) {
      ocrAbortControllerRef.current.abort();
    }
    const ocrController = new AbortController();
    ocrAbortControllerRef.current = ocrController;

    setExtractionError(null);
    setIsExtracting(true);
    setPhase('processingOCR');

    // Initialize progress stage
    setOcrStepIndex(1);
    setOcrStepText('Scanning document & optimizing...');
    setOcrProgressPercent(15);

    let finalCroppedDataUrl = cropSourceUrl;
    let finalCroppedBlob: Blob;
    let canvas: HTMLCanvasElement | null = null;

    try {
      // 1. Generate Cropped Image Canvas
      if (imgRef.current && completedCrop?.width && completedCrop?.height) {
        const image = imgRef.current;
        canvas = document.createElement('canvas');
        const scaleX = image.naturalWidth / image.width;
        const scaleY = image.naturalHeight / image.height;

        const cropX = completedCrop.x * scaleX;
        const cropY = completedCrop.y * scaleY;
        const cropWidth = completedCrop.width * scaleX;
        const cropHeight = completedCrop.height * scaleY;

        // Downscale bounds for maximum OCR speed and efficiency (max 1600px)
        const MAX_DIM = 1600;
        let targetWidth = cropWidth;
        let targetHeight = cropHeight;
        if (targetWidth > MAX_DIM || targetHeight > MAX_DIM) {
          if (targetWidth > targetHeight) {
            targetHeight = Math.round((targetHeight * MAX_DIM) / targetWidth);
            targetWidth = MAX_DIM;
          } else {
            targetWidth = Math.round((targetWidth * MAX_DIM) / targetHeight);
            targetHeight = MAX_DIM;
          }
        }

        canvas.width = Math.max(1, Math.round(targetWidth));
        canvas.height = Math.max(1, Math.round(targetHeight));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');

        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
          image,
          cropX,
          cropY,
          cropWidth,
          cropHeight,
          0,
          0,
          canvas.width,
          canvas.height
        );

        finalCroppedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
        finalCroppedBlob = dataUrlToBlob(finalCroppedDataUrl);
      } else {
        // Full image fallback
        finalCroppedBlob = dataUrlToBlob(cropSourceUrl);
      }

      setLastCroppedDataUrl(finalCroppedDataUrl);
      setLastCroppedBlob(finalCroppedBlob);

      // 2. Prepare Original Blob and Files
      const originalBlob = originalDataUrl
        ? dataUrlToBlob(originalDataUrl)
        : finalCroppedBlob;

      const originalFile = new File([originalBlob], workingFileName, { type: 'image/jpeg' });
      const croppedFile = new File([finalCroppedBlob], `cropped_${workingFileName}`, {
        type: 'image/jpeg',
      });

      // 3. Execute existing AI OCR pipeline on CROPPED image with session ID, signal, and real progress callback
      const currentSessionId = activeSessionIdRef.current;
      const ocrResult = await scanSummonDocument(
        finalCroppedDataUrl,
        'image/jpeg',
        currentSessionId,
        ocrController.signal,
        (stageText, progressPercent, stepIndex) => {
          if (activeSessionIdRef.current !== currentSessionId) return;
          setOcrStepText(stageText);
          setOcrProgressPercent(progressPercent);
          setOcrStepIndex(stepIndex);
        }
      );

      // Verify that session hasn't been superseded while waiting for OCR
      if (activeSessionIdRef.current !== currentSessionId) {
        console.info(`[Camera Scanner] Dropping OCR result from superseded session (${currentSessionId})`);
        return;
      }

      // Check if OCR failed, timed out, or was flagged unreadable
      if (!ocrResult.success || ocrResult.isUnreadable) {
        console.warn('[Camera Scanner] Document extraction failed or unreadable:', ocrResult.message);
        setExtractionError(
          ocrResult.message || 'The AI extraction timed out or could not parse all fields. Your scanned image has been preserved.'
        );
        setPhase('extractionError');
        return;
      }

      // 4. Attempt to detect judicial QR code if present in the document
      try {
        if (canvas) {
          const detectedQrCode = await scanQrFromCanvas(canvas);
          if (detectedQrCode) {
            const qrParsed = parseJudicialQRCode(detectedQrCode);
            if (qrParsed.summonNumber && !ocrResult.data.summonNumber) ocrResult.data.summonNumber = qrParsed.summonNumber;
            if (qrParsed.caseNumber && !ocrResult.data.caseNumber) ocrResult.data.caseNumber = qrParsed.caseNumber;
            if (qrParsed.personName && !ocrResult.data.personName) ocrResult.data.personName = qrParsed.personName;
            if (qrParsed.courtName && !ocrResult.data.courtName) ocrResult.data.courtName = qrParsed.courtName;
            if (qrParsed.hearingDate && !ocrResult.data.hearingDate) ocrResult.data.hearingDate = qrParsed.hearingDate;
            if (qrParsed.courtAddress && !ocrResult.data.courtAddress) ocrResult.data.courtAddress = qrParsed.courtAddress;
            if (qrParsed.policeStation && !ocrResult.data.policeStation) ocrResult.data.policeStation = qrParsed.policeStation;
            if (qrParsed.district && !ocrResult.data.district) ocrResult.data.district = qrParsed.district;
            if (qrParsed.address && !ocrResult.data.address) ocrResult.data.address = qrParsed.address;
            if (qrParsed.offenseCharges && !ocrResult.data.offenseCharges) ocrResult.data.offenseCharges = qrParsed.offenseCharges;
          }
        }
      } catch (qrErr) {
        console.warn('QR check failed during document scan:', qrErr);
      }

      setOcrProgressPercent(100);

      // Pass comprehensive artifacts back to parent review modal
      onScanComplete({
        scanSessionId: currentSessionId,
        originalDataUrl: originalDataUrl || finalCroppedDataUrl,
        croppedDataUrl: finalCroppedDataUrl,
        croppedBlob: finalCroppedBlob,
        originalFile,
        croppedFile,
        ocrResult,
        fileName: workingFileName,
      });
    } catch (err: any) {
      console.warn('[Camera Scanner] Crop / OCR failed:', err);
      if (err.name === 'AbortError' || ocrController.signal.aborted) {
        console.info('[Camera Scanner] OCR aborted by user or timeout.');
      }
      setExtractionError(
        err.message || 'AI extraction timed out. Your scanned image has been preserved.'
      );
      setPhase('extractionError');
    } finally {
      setIsExtracting(false);
    }
  };

  // Retry handler that creates a fresh session ID and re-triggers extraction
  const handleRetryExtraction = () => {
    activeSessionIdRef.current = generateScanSessionId();
    handleConfirmCropAndScan();
  };

  // Skip straight to manual form entry while preserving the captured cropped image
  const handleProceedWithManualEntry = () => {
    if (ocrAbortControllerRef.current) {
      ocrAbortControllerRef.current.abort();
      ocrAbortControllerRef.current = null;
    }
    const currentSessionId = activeSessionIdRef.current;
    const targetDataUrl = lastCroppedDataUrl || cropSourceUrl || '';
    const targetBlob = lastCroppedBlob || dataUrlToBlob(targetDataUrl);
    const targetFile = new File([targetBlob], workingFileName, { type: 'image/jpeg' });

    const fallbackResult: OcrResult = {
      sessionId: currentSessionId,
      data: {
        summonNumber: '',
        caseNumber: '',
        personName: '',
        address: '',
        courtName: '',
        courtAddress: '',
        policeStation: '',
        district: '',
        state: 'Delhi NCT',
        issueDate: new Date().toISOString().split('T')[0],
        hearingDate: '',
        detectedFields: [],
      },
      success: false,
      isUnreadable: true,
      message: 'Manual entry selected. Scanned document attached.',
      isAutofilled: false,
    };

    setIsExtracting(false);
    onScanComplete({
      scanSessionId: currentSessionId,
      originalDataUrl: originalDataUrl || targetDataUrl,
      croppedDataUrl: targetDataUrl,
      croppedBlob: targetBlob,
      originalFile: targetFile,
      croppedFile: targetFile,
      ocrResult: fallbackResult,
      fileName: workingFileName,
      isManualEntry: true,
    });
  };

  if (!isOpen) return null;

  return (
    <div
      id="full-screen-camera-container"
      role="dialog"
      aria-modal="true"
      aria-label="Full-Screen Camera Document Scanner"
      className="fixed inset-0 z-[160] bg-black text-white flex flex-col select-none touch-none animate-fadeIn overflow-hidden"
      style={{
        paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)',
        paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 16px)',
      }}
    >
      {/* Hidden file input for gallery upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleSelectGalleryPhoto}
        className="hidden"
      />

      {/* Shutter flash screen animation */}
      {shutterFlash && (
        <div className="absolute inset-0 bg-white z-[200] pointer-events-none transition-opacity duration-150" />
      )}

      {/* ========================================================================= */}
      {/* PHASE 1: FULL SCREEN LIVE CAMERA                                          */}
      {/* ========================================================================= */}
      {(phase === 'scannerOpening' || phase === 'cameraActive') && (
        <div className="relative w-full h-full flex flex-col justify-between overflow-hidden">
          {/* Top Bar: Back/Close, Instruction Badge, Controls */}
          <div className="relative z-30 flex items-center justify-between px-4 py-2">
            <button
              type="button"
              onClick={handleCloseScanner}
              id="camera-close-btn"
              aria-label="Close camera"
              className="min-h-[44px] min-w-[44px] p-2.5 rounded-full bg-black/50 hover:bg-black/80 backdrop-blur-md text-white border border-white/20 transition-all active:scale-95 flex items-center justify-center cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Instruction Banner Pill */}
            <div className="px-3.5 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/20 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg pointer-events-none">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Align summon inside the frame</span>
            </div>

            {/* Top Right Controls: Torch & Camera Flip */}
            <div className="flex items-center gap-2">
              {hasTorch && (
                <button
                  type="button"
                  onClick={handleToggleTorch}
                  aria-label={isTorchOn ? 'Turn off flash' : 'Turn on flash'}
                  className={`min-h-[44px] min-w-[44px] p-2.5 rounded-full backdrop-blur-md border transition-all active:scale-95 flex items-center justify-center cursor-pointer ${
                    isTorchOn
                      ? 'bg-amber-400 text-black border-amber-300 shadow-md'
                      : 'bg-black/50 hover:bg-black/80 text-white border-white/20'
                  }`}
                >
                  {isTorchOn ? <Zap className="w-5 h-5 fill-current" /> : <ZapOff className="w-5 h-5" />}
                </button>
              )}

              {availableCameras.length > 1 && (
                <button
                  type="button"
                  onClick={handleFlipCamera}
                  aria-label="Switch camera"
                  className="min-h-[44px] min-w-[44px] p-2.5 rounded-full bg-black/50 hover:bg-black/80 backdrop-blur-md text-white border border-white/20 transition-all active:scale-95 flex items-center justify-center cursor-pointer"
                >
                  <SwitchCamera className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>

          {/* Camera Viewport & Document Reticle Overlay */}
          <div className="relative flex-1 w-full h-full flex items-center justify-center overflow-hidden">
            {/* Live Video Feed */}
            <video
              ref={setVideoNode}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={() => {
                setIsCameraReady(true);
                setIsCameraStarting(false);
                setPhase('cameraActive');
              }}
              onPlaying={() => {
                setIsCameraReady(true);
                setIsCameraStarting(false);
                setPhase('cameraActive');
              }}
              className="absolute inset-0 w-full h-full object-cover"
            />

            {/* Loading indicator while camera initializes */}
            {isCameraStarting && (
              <div className="absolute inset-0 bg-black/80 z-10 flex flex-col items-center justify-center space-y-3">
                <Loader2 className="w-10 h-10 text-emerald-400 animate-spin" />
                <p className="text-sm font-medium text-white/90">Starting document camera...</p>
              </div>
            )}

            {/* Camera Error Overlay with Upload Option */}
            {cameraError && (
              <div className="absolute inset-0 bg-black/90 z-20 p-6 flex flex-col items-center justify-center text-center space-y-4 max-w-sm mx-auto">
                <div className="w-14 h-14 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
                  <AlertCircle className="w-8 h-8" />
                </div>
                <h3 className="text-base font-bold text-white">Camera Access Notice</h3>
                <p className="text-xs text-white/80 leading-relaxed">
                  {cameraError.includes('Camera access is required')
                    ? 'Camera access is required for live scanning.'
                    : cameraError}
                </p>

                <div className="flex flex-col w-full gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full min-h-[48px] px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold flex items-center justify-center gap-2 shadow-lg cursor-pointer transition-all active:scale-98"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Upload Image</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => startCamera(currentCameraFacing)}
                    className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-medium border border-white/20 transition-colors cursor-pointer"
                  >
                    Retry Camera
                  </button>

                  <button
                    type="button"
                    onClick={handleCloseScanner}
                    className="w-full min-h-[44px] px-4 py-2 text-xs text-white/60 hover:text-white transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Document Scanning Reticle (Aspect ratio ~1:1.4 legal paper) */}
            {!cameraError && (
              <div className="relative pointer-events-none w-[84%] max-w-[340px] aspect-[1/1.38] rounded-2xl border-2 border-white/40 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] flex flex-col justify-between p-3 transition-all duration-300">
                {/* 4 Crisp Corner Accent Guides */}
                <div className="flex justify-between items-start">
                  <div className="w-6 h-6 border-t-4 border-l-4 border-emerald-400 rounded-tl-md" />
                  <div className="w-6 h-6 border-t-4 border-r-4 border-emerald-400 rounded-tr-md" />
                </div>

                {/* Subtle Animated Scanning Beam */}
                <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_12px_rgba(52,211,153,0.8)] animate-pulse my-auto" />

                <div className="flex justify-between items-end">
                  <div className="w-6 h-6 border-b-4 border-l-4 border-emerald-400 rounded-bl-md" />
                  <div className="w-6 h-6 border-b-4 border-r-4 border-emerald-400 rounded-br-md" />
                </div>
              </div>
            )}
          </div>

          {/* Bottom Bar: Large Shutter & Upload Photo Instead */}
          <div className="relative z-30 flex items-center justify-around px-6 py-4 bg-gradient-to-t from-black/80 via-black/40 to-transparent">
            {/* Gallery Upload Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              id="btn-upload-instead"
              aria-label="Upload photo from device gallery"
              className="flex flex-col items-center gap-1 text-white/80 hover:text-white transition-colors active:scale-95 cursor-pointer min-w-[64px]"
            >
              <div className="p-3 rounded-full bg-white/10 hover:bg-white/20 border border-white/20">
                <Upload className="w-5 h-5" />
              </div>
              <span className="text-[11px] font-medium tracking-tight">Upload</span>
            </button>

            {/* Primary Shutter Button */}
            <div className="relative flex items-center justify-center">
              <button
                type="button"
                onClick={handleCapture}
                disabled={!isCameraReady || isCameraStarting || !!cameraError}
                id="btn-camera-shutter"
                aria-label="Capture photo"
                className="w-20 h-20 rounded-full border-4 border-white p-1.5 flex items-center justify-center transition-all active:scale-90 disabled:opacity-40 disabled:scale-100 cursor-pointer shadow-2xl bg-black/30"
              >
                <div className="w-full h-full rounded-full bg-white transition-transform duration-100 active:scale-95 shadow-inner" />
              </button>
            </div>

            {/* Cancel Button */}
            <button
              type="button"
              onClick={handleCloseScanner}
              className="flex flex-col items-center gap-1 text-white/80 hover:text-white transition-colors active:scale-95 cursor-pointer min-w-[64px]"
            >
              <div className="p-3 rounded-full bg-white/10 hover:bg-white/20 border border-white/20">
                <X className="w-5 h-5" />
              </div>
              <span className="text-[11px] font-medium tracking-tight">Cancel</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PHASE 2: CAPTURED PHOTO REVIEW [ Retake ] [ Use Photo / Continue ]         */}
      {/* ========================================================================= */}
      {phase === 'captured' && originalDataUrl && (
        <div className="relative w-full h-full flex flex-col justify-between overflow-hidden bg-black">
          {/* Header */}
          <div className="relative z-20 flex items-center justify-between px-4 py-3 bg-black/60 backdrop-blur-md border-b border-white/10">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <FileCheck className="w-4 h-4 text-emerald-400" />
              Photo Captured
            </h3>
            <button
              type="button"
              onClick={handleCloseScanner}
              aria-label="Close scanner"
              className="p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Full Screen Image View */}
          <div className="flex-1 w-full h-full p-4 flex items-center justify-center overflow-hidden bg-neutral-950">
            <img
              src={originalDataUrl}
              alt="Captured Summon Document"
              className="max-h-full max-w-full object-contain rounded-xl shadow-2xl border border-white/10"
            />
          </div>

          {/* Action Bar: Retake vs Use Photo / Continue */}
          <div className="relative z-20 p-4 sm:p-6 bg-black/80 backdrop-blur-md border-t border-white/10 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={handleRetake}
              id="btn-retake-photo"
              className="flex-1 max-w-[200px] min-h-[48px] px-5 py-3 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer shadow"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Retake</span>
            </button>

            <button
              type="button"
              onClick={handleProceedToCrop}
              id="btn-use-photo"
              className="flex-1 max-w-[240px] min-h-[48px] px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer shadow-lg"
            >
              <Check className="w-4 h-4" />
              <span>Use Photo / Continue</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PHASE 3: CROP STEP [ Retake ] [ Reset ] [ Continue to AI OCR ]             */}
      {/* ========================================================================= */}
      {phase === 'cropping' && cropSourceUrl && (
        <div className="relative w-full h-full flex flex-col justify-between overflow-hidden bg-neutral-950">
          {/* Top Bar: Title, Zoom Controls, Rotate Button */}
          <div className="relative z-20 flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-black/80 backdrop-blur-md border-b border-white/10">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRetake}
                aria-label="Back / Retake"
                className="p-2 rounded-xl text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <div>
                <h3 className="text-xs sm:text-sm font-bold text-white flex items-center gap-1.5">
                  <Maximize2 className="w-3.5 h-3.5 text-emerald-400" />
                  Crop Document
                </h3>
                <p className="text-[10px] text-white/60">Drag handles to adjust margins</p>
              </div>
            </div>

            {/* Rotate & Zoom Utilities */}
            <div className="flex items-center gap-2">
              {/* Rotate 90° Clockwise */}
              <button
                type="button"
                onClick={handleRotate90}
                disabled={isRotating}
                aria-label="Rotate 90 degrees"
                className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-medium border border-white/15 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer disabled:opacity-50"
              >
                <RotateCw className={`w-3.5 h-3.5 ${isRotating ? 'animate-spin' : ''}`} />
                <span>Rotate 90°</span>
              </button>

              {/* Zoom Out */}
              <button
                type="button"
                onClick={() => setZoomScale((s) => Math.max(0.75, s - 0.25))}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/15 transition-all cursor-pointer"
                aria-label="Zoom out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>

              <span className="text-[11px] font-mono text-white/80 w-10 text-center">
                {Math.round(zoomScale * 100)}%
              </span>

              {/* Zoom In */}
              <button
                type="button"
                onClick={() => setZoomScale((s) => Math.min(3, s + 0.25))}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/15 transition-all cursor-pointer"
                aria-label="Zoom in"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={handleCloseScanner}
                aria-label="Close"
                className="p-2 rounded-xl text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer ml-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Interactive Crop Body */}
          <div className="flex-1 w-full h-full overflow-auto p-4 flex items-center justify-center bg-neutral-900/50">
            <ReactCrop
              crop={crop}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              onComplete={(c) => setCompletedCrop(c)}
              className="max-h-[68vh] shadow-2xl rounded-lg overflow-hidden border border-white/20"
            >
              <img
                ref={imgRef}
                alt="Summon document for cropping"
                src={cropSourceUrl}
                style={{
                  transform: `scale(${zoomScale})`,
                  transformOrigin: 'center center',
                  transition: 'transform 0.15s ease-out',
                }}
                onLoad={onCropperImageLoad}
                className="max-w-full max-h-[68vh] object-contain select-none"
              />
            </ReactCrop>
          </div>

          {/* Bottom Controls: Retake, Reset, Continue to AI OCR */}
          <div className="relative z-20 p-4 sm:p-5 bg-black/90 backdrop-blur-md border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRetake}
                id="btn-crop-retake"
                className="min-h-[44px] px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-98 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retake</span>
              </button>

              <button
                type="button"
                onClick={handleResetCrop}
                id="btn-crop-reset"
                className="min-h-[44px] px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white/80 hover:text-white text-xs font-medium flex items-center gap-1.5 transition-all active:scale-98 cursor-pointer"
              >
                <span>Reset</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleConfirmCropAndScan}
              disabled={isExtracting}
              id="btn-continue-ai-ocr"
              className="min-h-[48px] px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer shadow-xl disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4 text-emerald-200" />
              <span>Continue to AI OCR</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PHASE 4: POLISHED AI OCR PROCESSING SCREEN                                */}
      {/* ========================================================================= */}
      {phase === 'processingOCR' && (
        <div className="relative w-full h-full flex flex-col items-center justify-center p-6 bg-neutral-950">
          <div className="w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-6 sm:p-8 shadow-2xl flex flex-col items-center text-center space-y-6 animate-scaleIn">
            {/* Animated Scanner Hub */}
            <div className="relative w-20 h-20">
              <div className="w-20 h-20 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-lg">
                <Sparkles className="w-10 h-10 animate-pulse" />
              </div>
              <div className="absolute -inset-1.5 rounded-2xl border-2 border-t-emerald-400 border-r-transparent border-b-transparent border-l-transparent animate-spin pointer-events-none" />
            </div>

            {/* Current Step Status */}
            <div className="space-y-1.5">
              <h3 className="text-base font-bold text-white font-mono tracking-tight uppercase">
                AI Docket Extraction
              </h3>
              <p className="text-sm font-semibold text-emerald-400 animate-pulse">
                {ocrStepText}
              </p>
              <p className="text-xs text-white/60 pt-1">
                Reading judicial summons, accused details, and court schedule.
              </p>
            </div>

            {/* Step Progress Pills */}
            <div className="w-full space-y-2 text-left bg-black/40 p-3.5 rounded-xl border border-white/5">
              <div className="flex items-center gap-2.5 text-xs">
                <span
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    ocrStepIndex >= 1
                      ? 'bg-emerald-500 text-black'
                      : 'bg-white/20 text-white/60'
                  }`}
                >
                  {ocrStepIndex > 1 ? '✓' : '1'}
                </span>
                <span className={ocrStepIndex >= 1 ? 'text-white font-medium' : 'text-white/40'}>
                  Scanning Summon...
                </span>
              </div>

              <div className="flex items-center gap-2.5 text-xs">
                <span
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    ocrStepIndex >= 2
                      ? 'bg-emerald-500 text-black'
                      : 'bg-white/20 text-white/60'
                  }`}
                >
                  {ocrStepIndex > 2 ? '✓' : '2'}
                </span>
                <span className={ocrStepIndex >= 2 ? 'text-white font-medium' : 'text-white/40'}>
                  Extracting docket information...
                </span>
              </div>

              <div className="flex items-center gap-2.5 text-xs">
                <span
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    ocrStepIndex >= 3
                      ? 'bg-emerald-500 text-black'
                      : 'bg-white/20 text-white/60'
                  }`}
                >
                  {ocrStepIndex > 3 ? '✓' : '3'}
                </span>
                <span className={ocrStepIndex >= 3 ? 'text-white font-medium' : 'text-white/40'}>
                  Reading hearing date...
                </span>
              </div>

              <div className="flex items-center gap-2.5 text-xs">
                <span
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    ocrStepIndex >= 4
                      ? 'bg-emerald-500 text-black'
                      : 'bg-white/20 text-white/60'
                  }`}
                >
                  {ocrStepIndex > 4 ? '✓' : '4'}
                </span>
                <span className={ocrStepIndex >= 4 ? 'text-white font-medium' : 'text-white/40'}>
                  Preparing docket particulars...
                </span>
              </div>
            </div>

            {/* Visual Progress Bar */}
            <div className="w-full space-y-1">
              <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-emerald-400 h-full rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${ocrProgressPercent}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] font-mono text-white/50">
                <span>OCR Pipeline</span>
                <span>{ocrProgressPercent}%</span>
              </div>
            </div>

            {/* Manual Skip Action */}
            <button
              type="button"
              onClick={handleProceedWithManualEntry}
              className="text-xs text-white/60 hover:text-white underline underline-offset-4 cursor-pointer pt-2"
            >
              Skip AI extraction & enter details manually →
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PHASE 5: EXTRACTION ERROR / RETRY SCREEN                                   */}
      {/* ========================================================================= */}
      {phase === 'extractionError' && (
        <div className="relative w-full h-full flex flex-col items-center justify-center p-6 bg-neutral-950">
          <div className="w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-6 sm:p-8 shadow-2xl flex flex-col items-center text-center space-y-6 animate-scaleIn">
            {/* Warning Icon */}
            <div className="w-16 h-16 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-lg">
              <AlertTriangle className="w-8 h-8" />
            </div>

            {/* Error Message */}
            <div className="space-y-2">
              <h3 className="text-base font-bold text-white font-mono tracking-tight uppercase">
                AI Docket Extraction Incomplete
              </h3>
              <p className="text-xs text-white/70">
                {extractionError || 'The AI extraction timed out or could not parse all fields. Your scanned document image has been preserved.'}
              </p>
            </div>

            {/* Preserved Thumbnail */}
            {(lastCroppedDataUrl || cropSourceUrl) && (
              <div className="relative w-32 h-24 rounded-lg overflow-hidden border border-white/10 shadow bg-black/40">
                <img
                  src={lastCroppedDataUrl || cropSourceUrl || ''}
                  alt="Preserved Cropped Scan"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 bg-black/70 py-0.5 text-[10px] text-white/80 font-mono">
                  Preserved Image
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="w-full flex flex-col gap-2.5 pt-2">
              <button
                type="button"
                onClick={handleRetryExtraction}
                disabled={isExtracting}
                id="btn-retry-ai-extraction"
                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer shadow-lg disabled:opacity-50"
              >
                {isExtracting ? (
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                ) : (
                  <RefreshCw className="w-4 h-4 text-emerald-200" />
                )}
                <span>{isExtracting ? 'Retrying Extraction...' : 'Retry AI Extraction'}</span>
              </button>

              <button
                type="button"
                onClick={handleProceedWithManualEntry}
                id="btn-manual-entry-fallback"
                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer border border-white/10"
              >
                <FileText className="w-4 h-4 text-white/70" />
                <span>Keep Image & Enter Details Manually</span>
              </button>

              <button
                type="button"
                onClick={() => setPhase('cropping')}
                className="text-xs text-white/50 hover:text-white/80 pt-1 cursor-pointer transition-colors"
              >
                ← Adjust Crop Area or Re-take Photo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
