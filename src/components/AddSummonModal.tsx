import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  X,
  Camera,
  Image as ImageIcon,
  FileText,
  Sparkles,
  QrCode,
  Check,
  AlertCircle,
  Loader2,
  RefreshCw,
  Edit3,
  Calendar,
  MapPin,
  Building2,
  Shield,
  Upload,
  ArrowRight,
  ArrowLeft,
  Eye,
  CheckCircle2,
  UserCheck,
  Plus,
  FileCheck,
  Maximize2,
  AlertTriangle,
  Sliders,
  CheckCheck,
  Trash2,
  ShieldCheck,
  Filter,
  HelpCircle,
} from 'lucide-react';
import jsQR from 'jsqr';
import { useSummons } from '../context/SummonContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from './Toast';
import { scanSummonDocument, parseJudicialQRCode, ExtractedSummonData, DEFAULT_CONFIDENCE_THRESHOLD } from '../utils/ocrService';
import { SummonStatus, SummonUrgency, WitnessPerson, FieldExtractionMeta, ExtractionSource } from '../types';
import { SelectPersonModal } from './SelectPersonModal';
import { ImageCropperModal } from './ImageCropperModal';
import { DocumentCameraScanner, ScanResultData } from './DocumentCameraScanner';
import { JudicialQrScannerModal } from './JudicialQrScannerModal';
import { NormalizedCaseData } from '../utils/judicialQrClient';

interface AddSummonModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultHearingDate?: string;
}

type WorkflowStep = 'upload' | 'processing' | 'review';

export const AddSummonModal: React.FC<AddSummonModalProps> = ({
  isOpen,
  onClose,
  defaultHearingDate,
}) => {
  const { addSummon, summons } = useSummons();
  const { currentUser } = useAuth();
  const { showToast } = useToast();
  const shouldReduceMotion = useReducedMotion();

  // Unique Scan Session Tracking for strict data isolation
  const currentScanSessionIdRef = useRef<string>(
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `scan_${Date.now()}`
  );
  const [currentScanSessionId, setCurrentScanSessionId] = useState<string>(() => currentScanSessionIdRef.current);
  const [isUnreadable, setIsUnreadable] = useState<boolean>(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState<boolean>(false);

  // Hidden file input reference for unreadable quick recovery
  const recoveryFileInputRef = useRef<HTMLInputElement | null>(null);

  // Workflow step
  const [currentStep, setCurrentStep] = useState<WorkflowStep>('upload');

  // Attachment state
  const [rawFile, setRawFile] = useState<File | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [originalAttachmentPreview, setOriginalAttachmentPreview] = useState<string | null>(null);
  const [viewingOriginalDoc, setViewingOriginalDoc] = useState<boolean>(false);
  const [attachmentType, setAttachmentType] = useState<'image' | 'pdf' | null>(null);
  const [fileName, setFileName] = useState<string>('');

  // Full-screen camera & mobile document scanner state
  const [isFullScreenScannerOpen, setIsFullScreenScannerOpen] = useState<boolean>(false);
  const [scannerInitialImage, setScannerInitialImage] = useState<string | null>(null);
  const [scannerInitialFileName, setScannerInitialFileName] = useState<string | undefined>(undefined);

  // Dedicated Judicial QR modal state
  const [isQrModalOpen, setIsQrModalOpen] = useState<boolean>(false);
  const [selectedSource, setSelectedSource] = useState<'camera' | 'upload' | 'pdf' | 'judicial-qr' | null>(null);

  // e-Courts QR import metadata
  const [importedFromECourts, setImportedFromECourts] = useState<boolean>(false);
  const [importedFields, setImportedFields] = useState<Set<string>>(new Set());
  const [eCourtsImportMeta, setECourtsImportMeta] = useState<{
    source: string;
    verifiedAt: string;
    cnrNumber?: string;
  } | null>(null);

  // Fallback camera states
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [cameraMode, setCameraMode] = useState<'document' | 'qr'>('document');
  const [isCameraStarting, setIsCameraStarting] = useState<boolean>(false);
  const [isCameraReady, setIsCameraReady] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ocrAbortControllerRef = useRef<AbortController | null>(null);

  // Person selection modal states
  const [isSelectPersonOpen, setIsSelectPersonOpen] = useState(false);
  const [isAddPersonDirectOpen, setIsAddPersonDirectOpen] = useState(false);

  // OCR state & field telemetry
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [extractStatusText, setExtractStatusText] = useState<string>('');
  const [detectedFields, setDetectedFields] = useState<Set<string>>(new Set());
  const [ocrMessage, setOcrMessage] = useState<string | null>(null);
  const [ocrSuccess, setOcrSuccess] = useState<boolean>(false);

  // Field-level extraction metadata & confidence tracking (Zero-Hallucination & Verification Stage)
  const [fieldMeta, setFieldMeta] = useState<Record<string, FieldExtractionMeta>>({});
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(DEFAULT_CONFIDENCE_THRESHOLD);
  const [reviewFilter, setReviewFilter] = useState<'all' | 'needsVerification' | 'verified' | 'notDetected'>('all');
  const [showThresholdSettings, setShowThresholdSettings] = useState<boolean>(false);

  // Form fields
  const [summonNumber, setSummonNumber] = useState('');
  const [caseNumber, setCaseNumber] = useState('');
  const [personName, setPersonName] = useState('');
  const [fatherName, setFatherName] = useState('');
  const [address, setAddress] = useState('');
  const [courtName, setCourtName] = useState('');
  const [courtAddress, setCourtAddress] = useState('');
  const [policeStation, setPoliceStation] = useState(currentUser?.policeStation || '');
  const [district, setDistrict] = useState(currentUser?.district || '');
  const [state, setState] = useState('Delhi NCT');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0]);
  const [hearingDate, setHearingDate] = useState(
    defaultHearingDate ||
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  );
  const [issuingAuthority, setIssuingAuthority] = useState('');
  const [officerDetails, setOfficerDetails] = useState(
    currentUser ? `${currentUser.rank} ${currentUser.displayName}` : ''
  );
  const [offenseCharges, setOffenseCharges] = useState('');
  const [urgency, setUrgency] = useState<SummonUrgency>('Standard');
  const [status, setStatus] = useState<SummonStatus>('Pending');

  const [formError, setFormError] = useState<string | null>(null);
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [cropMimeType, setCropMimeType] = useState<string>('image/jpeg');
  const [cropFileName, setCropFileName] = useState<string>('image.jpg');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Helper to populate fieldMeta structured map from OCR output
  const populateFieldMetaFromOcr = useCallback((data: ExtractedSummonData, threshold: number) => {
    const newMeta: Record<string, FieldExtractionMeta> = {};
    const metaObj = data.fieldMetadata || {};

    const allKeys: Array<{ key: string; val: string | undefined }> = [
      { key: 'summonNumber', val: data.summonNumber },
      { key: 'caseNumber', val: data.caseNumber },
      { key: 'personName', val: data.personName },
      { key: 'fatherName', val: data.fatherName },
      { key: 'address', val: data.address },
      { key: 'courtName', val: data.courtName },
      { key: 'courtAddress', val: data.courtAddress },
      { key: 'policeStation', val: data.policeStation },
      { key: 'district', val: data.district },
      { key: 'state', val: data.state },
      { key: 'issueDate', val: data.issueDate },
      { key: 'hearingDate', val: data.hearingDate },
      { key: 'issuingAuthority', val: data.issuingAuthority },
      { key: 'officerDetails', val: data.officerDetails },
      { key: 'offenseCharges', val: data.offenseCharges },
      { key: 'urgency', val: data.urgency },
    ];

    allKeys.forEach(({ key, val }) => {
      const rawMeta = metaObj[key];
      const hasValue = !!(val && val.trim());
      const confidence = rawMeta ? rawMeta.confidence : (hasValue ? 0.88 : 0);
      const isDetected = hasValue && confidence > 0;

      newMeta[key] = {
        field: key,
        value: val || '',
        confidence: isDetected ? confidence : 0,
        source: isDetected ? 'ocr' : 'user',
        isVerified: isDetected ? confidence >= threshold : false,
        isModified: false,
      };
    });

    setFieldMeta(newMeta);
  }, []);

  // Check if a field is considered verified
  const isFieldVerified = useCallback((fieldKey: string, val: string) => {
    if (!val || !val.trim()) return false;
    const meta = fieldMeta[fieldKey];
    if (!meta) return true;
    if (meta.source === 'ecourts' || meta.source === 'user' || meta.isModified || meta.isVerified) return true;
    return meta.confidence >= confidenceThreshold;
  }, [fieldMeta, confidenceThreshold]);

  // Check if a field specifically needs verification (low confidence OCR)
  const isFieldNeedsVerification = useCallback((fieldKey: string, val: string) => {
    if (!val || !val.trim()) return false;
    const meta = fieldMeta[fieldKey];
    if (!meta) return false;
    if (meta.source === 'ecourts' || meta.isModified || meta.isVerified) return false;
    return meta.source === 'ocr' && meta.confidence < confidenceThreshold;
  }, [fieldMeta, confidenceThreshold]);

  // User manual field edit handler
  const handleFieldChange = (fieldKey: string, newValue: string, setter: (val: string) => void) => {
    setter(newValue);
    setFieldMeta(prev => {
      const current = prev[fieldKey];
      return {
        ...prev,
        [fieldKey]: {
          field: fieldKey,
          value: newValue,
          confidence: 1.0,
          source: current?.source === 'ecourts' ? 'ecourts' : (current?.source === 'ocr' ? 'ocr' : 'user'),
          isVerified: true,
          isModified: true,
        }
      };
    });
  };

  // User marks single field as verified
  const handleVerifyField = (fieldKey: string) => {
    setFieldMeta(prev => {
      const current = prev[fieldKey];
      if (!current) return prev;
      return {
        ...prev,
        [fieldKey]: {
          ...current,
          isVerified: true,
          isModified: true,
        }
      };
    });
    showToast('Field marked as verified.', 'info', 'Verified');
  };

  // User clears single field (e.g. false positive removal)
  const handleClearField = (fieldKey: string, setter: (val: string) => void) => {
    setter('');
    setFieldMeta(prev => ({
      ...prev,
      [fieldKey]: {
        field: fieldKey,
        value: '',
        confidence: 0,
        source: 'user',
        isVerified: false,
        isModified: true,
      }
    }));
  };

  // User marks all fields as verified
  const handleVerifyAll = () => {
    setFieldMeta(prev => {
      const next = { ...prev };
      Object.keys(next).forEach(key => {
        if (next[key].value && next[key].value.trim()) {
          next[key] = {
            ...next[key],
            isVerified: true,
            isModified: true,
          };
        }
      });
      return next;
    });
    showToast('All populated fields verified.', 'success', 'Verified All');
  };

  // User clears unverified low-confidence fields
  const handleClearUnverified = () => {
    const fields = [
      { key: 'summonNumber', setter: setSummonNumber, val: summonNumber },
      { key: 'caseNumber', setter: setCaseNumber, val: caseNumber },
      { key: 'hearingDate', setter: setHearingDate, val: hearingDate },
      { key: 'personName', setter: setPersonName, val: personName },
      { key: 'fatherName', setter: setFatherName, val: fatherName },
      { key: 'address', setter: setAddress, val: address },
      { key: 'courtName', setter: setCourtName, val: courtName },
      { key: 'courtAddress', setter: setCourtAddress, val: courtAddress },
      { key: 'policeStation', setter: setPoliceStation, val: policeStation },
      { key: 'district', setter: setDistrict, val: district },
      { key: 'issuingAuthority', setter: setIssuingAuthority, val: issuingAuthority },
      { key: 'offenseCharges', setter: setOffenseCharges, val: offenseCharges },
    ];

    let cleared = 0;
    fields.forEach(({ key, setter, val }) => {
      if (val && isFieldNeedsVerification(key, val)) {
        handleClearField(key, setter);
        cleared++;
      }
    });

    if (cleared > 0) {
      showToast(`Cleared ${cleared} unverified field(s).`, 'info', 'Cleared');
    } else {
      showToast('No unverified fields to clear.', 'info', 'Notice');
    }
  };

  // Structured metrics for Review & Save stage
  const fieldStats = useMemo(() => {
    const fields = [
      { key: 'summonNumber', val: summonNumber },
      { key: 'caseNumber', val: caseNumber },
      { key: 'hearingDate', val: hearingDate },
      { key: 'personName', val: personName },
      { key: 'fatherName', val: fatherName },
      { key: 'address', val: address },
      { key: 'courtName', val: courtName },
      { key: 'courtAddress', val: courtAddress },
      { key: 'policeStation', val: policeStation },
      { key: 'district', val: district },
      { key: 'state', val: state },
      { key: 'issuingAuthority', val: issuingAuthority },
      { key: 'offenseCharges', val: offenseCharges },
    ];

    let ocrCount = 0;
    let ecourtsCount = 0;
    let userCount = 0;
    let needsVerificationCount = 0;
    let notDetectedCount = 0;
    let verifiedCount = 0;

    fields.forEach(({ key, val }) => {
      const meta = fieldMeta[key];
      const hasVal = !!(val && val.trim());
      if (!hasVal) {
        notDetectedCount++;
      } else if (meta?.source === 'ecourts') {
        ecourtsCount++;
        verifiedCount++;
      } else if (meta?.source === 'ocr') {
        ocrCount++;
        if (meta.confidence < confidenceThreshold && !meta.isVerified && !meta.isModified) {
          needsVerificationCount++;
        } else {
          verifiedCount++;
        }
      } else {
        userCount++;
        verifiedCount++;
      }
    });

    return {
      total: fields.length,
      ocrCount,
      ecourtsCount,
      userCount,
      needsVerificationCount,
      notDetectedCount,
      verifiedCount,
    };
  }, [
    fieldMeta,
    confidenceThreshold,
    summonNumber,
    caseNumber,
    hearingDate,
    personName,
    fatherName,
    address,
    courtName,
    courtAddress,
    policeStation,
    district,
    state,
    issuingAuthority,
    offenseCharges,
  ]);

  // Badge renderer displaying source, confidence percentage, and verify/clear actions
  const renderFieldStatusBadge = (fieldKey: string, currentValue: string, onVerify?: () => void, onClear?: () => void) => {
    const meta = fieldMeta[fieldKey];
    const hasVal = !!(currentValue && currentValue.trim());

    if (!hasVal) {
      return (
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground border border-border flex items-center gap-1 font-medium">
          Not detected
        </span>
      );
    }

    if (meta?.source === 'ecourts') {
      return (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
            <Check className="w-2.5 h-2.5" />
            ✓ Retrieved from e-Courts
          </span>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              title="Clear field"
              className="text-[10px] text-muted-foreground hover:text-red-500 px-1 py-0.5 rounded hover:bg-muted cursor-pointer transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      );
    }

    if (meta?.isModified || meta?.source === 'user') {
      return (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30 flex items-center gap-1">
            <Edit3 className="w-2.5 h-2.5" />
            ✎ User verified
          </span>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              title="Clear field"
              className="text-[10px] text-muted-foreground hover:text-red-500 px-1 py-0.5 rounded hover:bg-muted cursor-pointer transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      );
    }

    if (meta?.source === 'ocr') {
      const conf = meta.confidence;
      const isBelowThreshold = conf < confidenceThreshold && !meta.isVerified;

      if (isBelowThreshold) {
        return (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-900 dark:text-amber-200 border border-amber-500/40 flex items-center gap-1">
              <AlertTriangle className="w-2.5 h-2.5 text-amber-600 dark:text-amber-400" />
              ⚠ Needs verification ({Math.round(conf * 100)}%)
            </span>
            {onVerify && (
              <button
                type="button"
                onClick={onVerify}
                className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-0.5 shadow-sm transition-transform active:scale-95 cursor-pointer"
              >
                <Check className="w-2.5 h-2.5" /> Verify
              </button>
            )}
            {onClear && (
              <button
                type="button"
                onClick={onClear}
                title="Clear field"
                className="text-[10px] text-muted-foreground hover:text-red-500 px-1 py-0.5 rounded hover:bg-muted cursor-pointer transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        );
      }

      return (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30 flex items-center gap-1">
            <Check className="w-2.5 h-2.5" />
            ✓ Extracted from document ({Math.round(conf * 100)}%)
          </span>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              title="Clear field"
              className="text-[10px] text-muted-foreground hover:text-red-500 px-1 py-0.5 rounded hover:bg-muted cursor-pointer transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      );
    }

    return null;
  };

  // Helper for input border styles based on source & verification
  const getFieldInputClass = (fieldKey: string, currentValue: string) => {
    const meta = fieldMeta[fieldKey];
    const hasVal = !!(currentValue && currentValue.trim());

    if (!hasVal) {
      return 'border-border bg-background focus:border-primary-text';
    }

    if (meta?.source === 'ecourts') {
      return 'border-emerald-500/60 bg-emerald-500/[0.02] focus:border-emerald-600';
    }

    if (meta?.isModified || meta?.source === 'user') {
      return 'border-indigo-500/60 bg-indigo-500/[0.02] focus:border-indigo-600';
    }

    if (meta?.source === 'ocr') {
      const isBelowThreshold = meta.confidence < confidenceThreshold && !meta.isVerified;
      if (isBelowThreshold) {
        return 'border-amber-500/70 bg-amber-500/[0.03] focus:border-amber-600';
      }
      return 'border-blue-500/60 bg-blue-500/[0.02] focus:border-blue-600';
    }

    return 'border-border bg-background';
  };

  // Completely stops and cleans up camera hardware tracks
  const stopCamera = useCallback((turnOffActive: boolean = true) => {
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
    if (turnOffActive) {
      setIsCameraActive(false);
    }
    setIsCameraReady(false);
    setIsCameraStarting(false);
  }, []);

  // Strict Scan Session Initializer & Complete Invalidation of Stale State
  const startNewScanSession = useCallback(() => {
    if (ocrAbortControllerRef.current) {
      ocrAbortControllerRef.current.abort();
      ocrAbortControllerRef.current = null;
    }

    const newSessionId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `scan_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    currentScanSessionIdRef.current = newSessionId;
    setCurrentScanSessionId(newSessionId);

    // Invalidate all temporary attachments
    setRawFile(null);
    setAttachmentPreview(null);
    setOriginalAttachmentPreview(null);
    setViewingOriginalDoc(false);
    setAttachmentType(null);
    setFileName('');
    setCropImageSrc(null);

    // Invalidate all OCR / QR telemetry
    setDetectedFields(new Set());
    setFieldMeta({});
    setReviewFilter('all');
    setShowThresholdSettings(false);
    setOcrMessage(null);
    setOcrSuccess(false);
    setIsUnreadable(false);
    setImportedFromECourts(false);
    setImportedFields(new Set());
    setECourtsImportMeta(null);
    setFormError(null);

    // Invalidate all form fields to prevent ANY stale data leakage
    setSummonNumber('');
    setCaseNumber('');
    setPersonName('');
    setFatherName('');
    setAddress('');
    setCourtName('');
    setCourtAddress('');
    setPoliceStation(currentUser?.policeStation || '');
    setDistrict(currentUser?.district || '');
    setState('Delhi NCT');
    setIssueDate(new Date().toISOString().split('T')[0]);
    setHearingDate(
      defaultHearingDate ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    );
    setIssuingAuthority('');
    setOfficerDetails(currentUser ? `${currentUser.rank} ${currentUser.displayName}` : '');
    setOffenseCharges('');
    setUrgency('Standard');
    setStatus('Pending');

    return newSessionId;
  }, [currentUser, defaultHearingDate]);

  // Reset or initialize on open
  useEffect(() => {
    if (isOpen) {
      startNewScanSession();
      setCurrentStep('upload');
    } else {
      stopCamera(true);
    }
  }, [isOpen, startNewScanSession, stopCamera]);

  // Clean up camera on unmount
  useEffect(() => {
    return () => {
      stopCamera(true);
    };
  }, [stopCamera]);

  // Callback ref ensuring video node connects to stream as soon as it mounts
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      if (node.srcObject !== streamRef.current) {
        node.srcObject = streamRef.current;
      }
      node.play().catch((playErr) => {
        console.warn('Video playback notice:', playErr);
      });
    }
  }, []);

  // Ensure stream connection whenever isCameraActive flips
  useEffect(() => {
    if (isCameraActive && streamRef.current && videoRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
      videoRef.current.play().catch(() => {});
    }
  }, [isCameraActive]);

  // Launch dedicated full-screen camera modal with a fresh scanSessionId
  const handleOpenFullScreenCamera = () => {
    stopCamera(true);
    startNewScanSession();
    setScannerInitialImage(null);
    setScannerInitialFileName(undefined);
    setIsFullScreenScannerOpen(true);
  };

  // Launch mobile scanner directly in crop mode for uploaded gallery image with a fresh scanSessionId
  const handleSelectPhotoForScanner = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    stopCamera(true);
    startNewScanSession();

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setScannerInitialImage(dataUrl);
      setScannerInitialFileName(file.name || 'Summon_Upload.jpg');
      setIsFullScreenScannerOpen(true);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Handler when DocumentCameraScanner completes (Camera/Upload -> Review -> Crop -> AI OCR)
  const handleScannerComplete = (result: ScanResultData) => {
    // Synchronize session ownership from the active scanner instance
    if (result.scanSessionId) {
      currentScanSessionIdRef.current = result.scanSessionId;
      setCurrentScanSessionId(result.scanSessionId);
    }

    setIsFullScreenScannerOpen(false);
    setScannerInitialImage(null);
    setScannerInitialFileName(undefined);

    setRawFile(result.croppedFile);
    setAttachmentType('image');
    setFileName(result.fileName);
    setAttachmentPreview(result.croppedDataUrl);
    setOriginalAttachmentPreview(result.originalDataUrl);
    setViewingOriginalDoc(false);

    // If user explicitly chose "Keep Image & Enter Details Manually", open manual form immediately with image preserved
    if (result.isManualEntry) {
      setIsUnreadable(false);
      setOcrSuccess(false);
      setDetectedFields(new Set());
      setFieldMeta({});
      setOcrMessage('Scanned document attached. Please enter the summon particulars manually.');
      showToast(
        'Scanned document attached. Please fill in summon particulars below.',
        'info',
        'Manual Entry Active'
      );
      setCurrentStep('review');
      return;
    }

    // Check if document was unreadable or failed completely
    if (result.ocrResult.isUnreadable || !result.ocrResult.success) {
      const partialData = result.ocrResult.data;
      const detected = new Set(partialData?.detectedFields || []);

      if (detected.size > 0 && partialData) {
        setIsUnreadable(false);
        setOcrSuccess(true);
        setDetectedFields(detected);

        if (partialData.summonNumber) setSummonNumber(partialData.summonNumber);
        if (partialData.caseNumber) setCaseNumber(partialData.caseNumber);
        if (partialData.personName) setPersonName(partialData.personName);
        if (partialData.fatherName) setFatherName(partialData.fatherName);
        if (partialData.address) setAddress(partialData.address);
        if (partialData.courtName) setCourtName(partialData.courtName);
        if (partialData.courtAddress) setCourtAddress(partialData.courtAddress);
        if (partialData.policeStation) setPoliceStation(partialData.policeStation);
        if (partialData.district) setDistrict(partialData.district);
        if (partialData.state) setState(partialData.state);
        if (partialData.hearingDate) setHearingDate(partialData.hearingDate);
        if (partialData.issuingAuthority) setIssuingAuthority(partialData.issuingAuthority);
        if (partialData.offenseCharges) setOffenseCharges(partialData.offenseCharges);
        if (partialData.urgency) setUrgency(partialData.urgency);

        populateFieldMetaFromOcr(partialData, confidenceThreshold);
        setOcrMessage('Partial extraction: Please verify and complete the highlighted particulars below.');
        showToast('Extracted partial particulars. Please verify details.', 'info', 'Partial Extraction');
      } else {
        setIsUnreadable(true);
        setOcrSuccess(false);
        setDetectedFields(new Set());
        setFieldMeta({});
        setOcrMessage(
          result.ocrResult.message ||
            "Unable to extract fields from this document. Your scan is attached—please complete details manually or retry."
        );
        showToast(
          "Your scan has been attached. Please complete summon particulars manually or retry.",
          'info',
          'Document Attached'
        );
      }
      setCurrentStep('review');
      return;
    }

    // Populate extracted fields cleanly from fresh result
    setIsUnreadable(false);
    const data = result.ocrResult.data;
    const detected = new Set(data.detectedFields || []);
    setDetectedFields(detected);

    if (data.summonNumber) setSummonNumber(data.summonNumber);
    if (data.caseNumber) setCaseNumber(data.caseNumber);
    if (data.personName) setPersonName(data.personName);
    if (data.fatherName) setFatherName(data.fatherName);
    if (data.address) setAddress(data.address);
    if (data.courtName) setCourtName(data.courtName);
    if (data.courtAddress) setCourtAddress(data.courtAddress);
    if (data.policeStation) setPoliceStation(data.policeStation);
    if (data.district) setDistrict(data.district);
    if (data.state) setState(data.state);
    if (data.hearingDate) setHearingDate(data.hearingDate);
    if (data.issuingAuthority) setIssuingAuthority(data.issuingAuthority);
    if (data.offenseCharges) setOffenseCharges(data.offenseCharges);
    if (data.urgency) setUrgency(data.urgency);

    populateFieldMetaFromOcr(data, confidenceThreshold);

    setOcrSuccess(result.ocrResult.success);
    setOcrMessage(result.ocrResult.message ? sanitizeOcrNotice(result.ocrResult.message) : null);

    if (result.ocrResult.success && detected.size > 0) {
      showToast(`AI OCR extracted ${detected.size} judicial fields from document`, 'success', 'Scan Complete');
    } else if (!result.ocrResult.success) {
      showToast(sanitizeOcrNotice(result.ocrResult.message) || 'Please verify docket particulars below.', 'warning', 'OCR Notice');
    }

    setCurrentStep('review');
  };

  // Gallery image selection with fresh session ID
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    startNewScanSession();
    setCropFileName(file.name);
    setCropMimeType(file.type || 'image/jpeg');

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setCropImageSrc(dataUrl);
      setOriginalAttachmentPreview(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // PDF file upload with fresh session ID
  const handlePdfUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const newSessionId = startNewScanSession();
    setRawFile(file);
    setFileName(file.name);
    setAttachmentType('pdf');

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setAttachmentPreview(result);
      triggerOcrPipeline(result, 'application/pdf', newSessionId);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleCropComplete = (croppedBlob: Blob) => {
    if (cropImageSrc && !originalAttachmentPreview) {
      setOriginalAttachmentPreview(cropImageSrc);
    }
    setCropImageSrc(null);
    const file = new File([croppedBlob], cropFileName, { type: cropMimeType });
    setRawFile(file);
    setAttachmentType('image');
    setFileName(cropFileName);

    const activeSessionId = currentScanSessionIdRef.current;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setAttachmentPreview(dataUrl);
      triggerOcrPipeline(dataUrl, cropMimeType, activeSessionId);
    };
    reader.readAsDataURL(croppedBlob);
  };

  // Helper to sanitize technical AI error messages into professional judicial guidance
  const sanitizeOcrNotice = (msg: string | null | undefined): string => {
    if (!msg) return '';
    let clean = msg;
    if (clean.includes('{') && clean.includes('}')) {
      try {
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        const parsed = JSON.parse(clean.slice(start, end + 1));
        if (parsed?.error?.message) {
          clean = parsed.error.message;
        }
      } catch (_) {}
    }
    if (clean.includes('503') || clean.includes('high demand') || clean.includes('UNAVAILABLE') || clean.includes('busy')) {
      return 'The AI document extraction service was temporarily experiencing peak demand. Click "Retry AI Scan" to re-process with our high-speed engine, or enter details below.';
    }
    return clean;
  };

  // Trigger AI OCR extraction pipeline with visual phases and strict session tracking
  const triggerOcrPipeline = async (dataUrl: string, mime: string, targetSessionId?: string) => {
    if (isExtracting) return; // Prevent concurrent OCR runs

    if (ocrAbortControllerRef.current) {
      ocrAbortControllerRef.current.abort();
    }
    const ocrController = new AbortController();
    ocrAbortControllerRef.current = ocrController;

    const sessionId = targetSessionId || currentScanSessionIdRef.current;
    setCurrentStep('processing');
    setIsExtracting(true);

    setOcrSuccess(false);
    setIsUnreadable(false);
    setOcrMessage(null);
    setExtractStatusText('Transmitting document to legal AI scanner...');

    const timer1 = setTimeout(() => {
      setExtractStatusText('Analyzing legal sections, court bench, and FIR details...');
    }, 900);

    const timer2 = setTimeout(() => {
      setExtractStatusText('Extracting respondent name, address, and appearance schedule...');
    }, 1800);

    try {
      const result = await scanSummonDocument(
        dataUrl,
        mime,
        sessionId,
        ocrController.signal,
        (stageText) => {
          if (currentScanSessionIdRef.current === sessionId) {
            setExtractStatusText(stageText);
          }
        }
      );
      clearTimeout(timer1);
      clearTimeout(timer2);

      // Check if session changed while awaiting response
      if (currentScanSessionIdRef.current !== sessionId) {
        console.info(`[AddSummonModal] Dropping OCR response for superseded session (${sessionId})`);
        return;
      }

      // Check if document was unreadable or failed
      if (result.isUnreadable || !result.success) {
        setIsUnreadable(true);
        setOcrSuccess(false);
        setDetectedFields(new Set());
        setFieldMeta({});
        setOcrMessage(
          result.message ||
            "Unable to read this document. Please upload a clearer image, scan again, or enter details manually."
        );
        showToast(
          "Unable to read this document. You may scan again, upload another, or enter details manually.",
          'warning',
          'Unreadable Document'
        );
        return;
      }

      setIsUnreadable(false);
      const data = result.data;
      const detected = new Set(data.detectedFields || []);
      setDetectedFields(detected);

      // Populate form fields only with actual extracted values from THIS session
      if (data.summonNumber) setSummonNumber(data.summonNumber);
      if (data.caseNumber) setCaseNumber(data.caseNumber);
      if (data.personName) setPersonName(data.personName);
      if (data.fatherName) setFatherName(data.fatherName);
      if (data.address) setAddress(data.address);
      if (data.courtName) setCourtName(data.courtName);
      if (data.courtAddress) setCourtAddress(data.courtAddress);
      if (data.policeStation) setPoliceStation(data.policeStation);
      if (data.district) setDistrict(data.district);
      if (data.state) setState(data.state);
      if (data.hearingDate) setHearingDate(data.hearingDate);
      if (data.issuingAuthority) setIssuingAuthority(data.issuingAuthority);
      if (data.offenseCharges) setOffenseCharges(data.offenseCharges);
      if (data.urgency) setUrgency(data.urgency);

      populateFieldMetaFromOcr(data, confidenceThreshold);

      setOcrSuccess(result.success);
      setOcrMessage(result.message ? sanitizeOcrNotice(result.message) : null);

      if (result.success && detected.size > 0) {
        showToast(`AI OCR extracted ${detected.size} fields from document`, 'success', 'Scan Complete');
      } else if (!result.success) {
        showToast(sanitizeOcrNotice(result.message) || 'Manual entry required.', 'warning', 'OCR Notice');
      }
    } catch (err: any) {
      console.warn('OCR Pipeline caught error:', err);
      clearTimeout(timer1);
      clearTimeout(timer2);

      if (currentScanSessionIdRef.current !== sessionId) return;

      setIsUnreadable(true);
      setOcrSuccess(false);
      setDetectedFields(new Set());
      setFieldMeta({});
      setOcrMessage(
        "Unable to read this document. Please upload a clearer image, scan again, or enter details manually."
      );
      showToast('Document scan could not complete. You may scan again, upload another, or enter details manually.', 'warning', 'Scan Notice');
    } finally {
      setIsExtracting(false);
      setCurrentStep('review');
    }
  };

  // Process decoded QR code payload from camera, image, or manual text
  const handleDecodedQr = (rawQrData: string, qrSessionId?: string) => {
    if (qrSessionId && qrSessionId !== currentScanSessionIdRef.current) {
      console.info(`[AddSummonModal] Ignored stale QR code decode for session (${qrSessionId})`);
      return;
    }

    stopCamera(true);
    const parsed = parseJudicialQRCode(rawQrData.trim());
    const detected = new Set<string>();

    if (parsed.summonNumber) {
      setSummonNumber(parsed.summonNumber);
      detected.add('summonNumber');
    }
    if (parsed.caseNumber) {
      setCaseNumber(parsed.caseNumber);
      detected.add('caseNumber');
    }
    if (parsed.personName) {
      setPersonName(parsed.personName);
      detected.add('personName');
    }
    if (parsed.fatherName) {
      setFatherName(parsed.fatherName);
      detected.add('fatherName');
    }
    if (parsed.address) {
      setAddress(parsed.address);
      detected.add('address');
    }
    if (parsed.courtName) {
      setCourtName(parsed.courtName);
      detected.add('courtName');
    }
    if (parsed.courtAddress) {
      setCourtAddress(parsed.courtAddress);
      detected.add('courtAddress');
    }
    if (parsed.policeStation) {
      setPoliceStation(parsed.policeStation);
      detected.add('policeStation');
    }
    if (parsed.district) {
      setDistrict(parsed.district);
      detected.add('district');
    }
    if (parsed.state) {
      setState(parsed.state);
      detected.add('state');
    }
    if (parsed.hearingDate) {
      setHearingDate(parsed.hearingDate);
      detected.add('hearingDate');
    }
    if (parsed.offenseCharges) {
      setOffenseCharges(parsed.offenseCharges);
      detected.add('offenseCharges');
    }

    setDetectedFields(detected);
    setIsQrModalOpen(false);
    setIsUnreadable(false);
    setOcrSuccess(true);
    if (detected.size > 0) {
      setOcrMessage(`Successfully decoded ${detected.size} judicial parameters from e-Court QR code`);
      showToast(`Decoded ${detected.size} fields from QR code!`, 'success', 'QR Decoded');
    } else {
      setOcrMessage(`Scanned QR data: ${rawQrData.substring(0, 60)}...`);
      showToast('QR code scanned. Please verify case fields.', 'info', 'QR Scanned');
    }
    setCurrentStep('review');
  };

  // Apply verified e-Courts case data from dedicated Judicial QR Scanner
  const handleApplyCaseDetails = (caseData: NormalizedCaseData, rawPayload: string, sessionId?: string) => {
    if (sessionId && sessionId !== currentScanSessionIdRef.current) {
      console.info(`[AddSummonModal] Ignored stale e-Courts QR details for session (${sessionId})`);
      return;
    }

    setIsQrModalOpen(false);
    stopCamera(true);

    const imported = new Set<string>();

    const applySafe = (_currentVal: string, newVal: string, setter: (val: string) => void, key: string) => {
      if (newVal && newVal.trim()) {
        setter(newVal.trim());
        imported.add(key);
      }
    };

    // 1. CNR / Summon Identifier
    const cnrVal = caseData.cnrNumber || (rawPayload && rawPayload.length >= 16 ? rawPayload.trim() : '');
    if (cnrVal) {
      applySafe(summonNumber, cnrVal, setSummonNumber, 'summonNumber');
    }

    // 2. Case Number
    if (caseData.caseNumber) {
      applySafe(caseNumber, caseData.caseNumber, setCaseNumber, 'caseNumber');
    }

    // 3. Court Name
    if (caseData.courtName) {
      applySafe(courtName, caseData.courtName, setCourtName, 'courtName');
    }

    // 4. Court Address / Complex / Room
    if (caseData.courtNumber) {
      applySafe(courtAddress, caseData.courtNumber, setCourtAddress, 'courtAddress');
    }

    // 5. District
    if (caseData.district) {
      applySafe(district, caseData.district, setDistrict, 'district');
    }

    // 6. State
    if (caseData.state) {
      applySafe(state, caseData.state, setState, 'state');
    }

    // 7. Police Station
    if (caseData.policeStation) {
      applySafe(policeStation, caseData.policeStation, setPoliceStation, 'policeStation');
    }

    // 8. Hearing Date
    if (caseData.nextHearingDate) {
      applySafe(hearingDate, caseData.nextHearingDate, setHearingDate, 'hearingDate');
    }

    // 9. Respondent (Person Name)
    if (caseData.respondent && caseData.respondent.length > 0) {
      applySafe(personName, caseData.respondent[0], setPersonName, 'personName');
    }

    // 10. Petitioner / Issuing Authority
    if (caseData.petitioner && caseData.petitioner.length > 0) {
      if (!issuingAuthority) {
        setIssuingAuthority(caseData.petitioner.join(', '));
        imported.add('issuingAuthority');
      }
    }

    // 11. Sections / Acts
    if (caseData.sections && caseData.sections.length > 0) {
      const secStr = caseData.sections.join(', ') + (caseData.acts && caseData.acts.length > 0 ? ` (${caseData.acts.join(', ')})` : '');
      applySafe(offenseCharges, secStr, setOffenseCharges, 'offenseCharges');
    }

    setIsUnreadable(false);
    setImportedFromECourts(true);
    setImportedFields(imported);
    setDetectedFields(imported);
    setECourtsImportMeta({
      source: 'e-Courts / Judicial QR',
      verifiedAt: new Date().toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
      cnrNumber: caseData.cnrNumber || rawPayload,
    });

    setFieldMeta(prev => {
      const next = { ...prev };
      imported.forEach(k => {
        next[k] = {
          field: k,
          value: next[k]?.value || '',
          confidence: 1.0,
          source: 'ecourts',
          isVerified: true,
          isModified: false,
        };
      });
      return next;
    });

    setOcrSuccess(true);
    setOcrMessage(`Case docket imported successfully from e-Courts (${caseData.cnrNumber || caseData.caseNumber || 'CNR Verified'})`);
    showToast('Case details imported successfully from e-Courts!', 'success', 'Case Found');
    setCurrentStep('review');
  };

  // Auto-populate fields when person is selected from directory
  const handlePersonSelected = (person: WitnessPerson) => {
    setPersonName(person.name);
    if (person.fatherName) setFatherName(person.fatherName);
    setAddress(person.address);
    if (person.policeStation) setPoliceStation(person.policeStation);
    if (person.district) setDistrict(person.district);

    const detected = new Set(detectedFields);
    detected.add('personName');
    if (person.fatherName) detected.add('fatherName');
    detected.add('address');
    setDetectedFields(detected);

    setFieldMeta(prev => ({
      ...prev,
      personName: { field: 'personName', value: person.name, confidence: 1.0, source: 'user', isVerified: true, isModified: true },
      ...(person.fatherName ? { fatherName: { field: 'fatherName', value: person.fatherName, confidence: 1.0, source: 'user', isVerified: true, isModified: true } } : {}),
      address: { field: 'address', value: person.address, confidence: 1.0, source: 'user', isVerified: true, isModified: true },
      ...(person.policeStation ? { policeStation: { field: 'policeStation', value: person.policeStation, confidence: 1.0, source: 'user', isVerified: true, isModified: true } } : {}),
      ...(person.district ? { district: { field: 'district', value: person.district, confidence: 1.0, source: 'user', isVerified: true, isModified: true } } : {}),
    }));

    showToast(`Autofilled particulars for ${person.name} (${person.role})`, 'success', 'Person Selected');
  };

  // Save summon to Firebase / database
  const handleSaveSummon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return; // Prevent double clicks
    
    setFormError(null);

    // Session validation: block save if session is stale
    if (!currentScanSessionId || currentScanSessionIdRef.current !== currentScanSessionId) {
      setFormError('Current document session is no longer active. Please start a new scan.');
      return;
    }

    // Validation
    if (!summonNumber.trim()) {
      setFormError('Summon / Warrant Number is required');
      return;
    }
    if (!caseNumber.trim()) {
      setFormError('Case or FIR Number is required');
      return;
    }
    if (!personName.trim()) {
      setFormError('Respondent / Accused Full Name is required');
      return;
    }
    if (!address.trim()) {
      setFormError('Complete Serving Address is required for police dispatch');
      return;
    }
    if (!courtName.trim()) {
      setFormError('Court / Bench Name is required');
      return;
    }
    if (!hearingDate) {
      setFormError('Court Hearing Date is required');
      return;
    }

    // Duplicate check for CNR / Summon Number
    if (!confirmDuplicate && summons && summons.length > 0) {
      const match = summons.find(
        (s) => s.summonNumber && s.summonNumber.trim().toUpperCase() === summonNumber.trim().toUpperCase()
      );
      if (match) {
        setFormError(
          `A record with Summon/CNR Number "${summonNumber.trim()}" already exists in your docket (${match.personName || 'Registered'}). Click "Save Record" again if you wish to confirm adding this docket.`
        );
        setConfirmDuplicate(true);
        setIsSubmitting(false);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      await addSummon(
        {
          summonNumber: summonNumber.trim(),
          caseNumber: caseNumber.trim(),
          personName: personName.trim(),
          fatherName: fatherName.trim() || undefined,
          address: address.trim(),
          courtName: courtName.trim(),
          courtAddress: courtAddress.trim() || 'District Court Complex',
          policeStation: policeStation.trim() || currentUser?.policeStation || 'PS Tis Hazari',
          district: district.trim() || currentUser?.district || 'Central District',
          state: state.trim() || 'Delhi NCT',
          issueDate: issueDate || new Date().toISOString().split('T')[0],
          hearingDate,
          issuingAuthority: issuingAuthority.trim() || 'Judicial Magistrate 1st Class',
          officerDetails: officerDetails.trim() || `${currentUser?.rank} ${currentUser?.displayName}`,
          offenseCharges: offenseCharges.trim(),
          status,
          urgency,
          imageUrl: attachmentType === 'image' && attachmentPreview ? attachmentPreview : undefined,
          originalImageUrl: attachmentType === 'image' && originalAttachmentPreview ? originalAttachmentPreview : undefined,
          pdfUrl: attachmentType === 'pdf' && attachmentPreview ? attachmentPreview : undefined,
          fileName: fileName || undefined,
          reminderEnabled: true,
        },
        rawFile
      );

      setSaveSuccess(true);
      showToast(`Summon ${summonNumber.trim()} registered and saved successfully`, 'success', 'Docket Saved');
      setTimeout(() => {
        stopCamera();
        onClose();
        setSaveSuccess(false);
      }, 1000);
    } catch (err: any) {
      setFormError(err.message || 'Failed to save judicial summon to database');
      showToast(err.message || 'Failed to save summon', 'error', 'Save Error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleModalClose = React.useCallback(() => {
    stopCamera(true);
    onClose();
  }, [onClose, stopCamera]);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleModalClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleModalClose]);

  if (!isOpen) return null;

  return (
    <div
      id="add-summon-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleModalClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-sm overflow-y-auto animate-fadeIn"
    >
      <div className="bg-background border border-border rounded-2xl w-full max-w-3xl my-6 overflow-hidden shadow-2xl animate-scaleIn flex flex-col max-h-[92vh]">
        {/* Modal Header & Step Indicator */}
        <div className="bg-card border-b border-border px-5 sm:px-6 py-4 sticky top-0 z-20 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-muted text-foreground border border-border">
                <FileText className="w-5 h-5 text-primary-text" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">
                  Register Judicial Summon / Warrant
                </h2>
                <p className="text-xs text-muted-foreground">
                  Law Enforcement Ingestion & AI Docket Extraction
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleModalClose}
              id="close-add-modal-btn"
              aria-label="Close summon registration"
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Workflow Stepper Bar */}
          <div className="grid grid-cols-3 gap-2 pt-1" role="tablist" aria-label="Workflow progress">
            <button
              type="button"
              role="tab"
              aria-selected={currentStep === 'upload'}
              onClick={() => {
                if (isCameraActive) stopCamera(true);
                setCurrentStep('upload');
              }}
              className={`py-2 px-3 rounded-xl text-xs font-mono font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                currentStep === 'upload'
                  ? 'bg-primary-btn text-white shadow-sm ring-1 ring-primary-text/40'
                  : 'bg-card text-muted-foreground border border-border hover:text-foreground hover:border-border-strong'
              }`}
            >
              <span>1. Ingest Document</span>
            </button>

            <div
              role="tab"
              aria-selected={currentStep === 'processing'}
              className={`py-2 px-3 rounded-xl text-xs font-mono font-bold flex items-center justify-center gap-1.5 transition-all ${
                currentStep === 'processing'
                  ? 'bg-amber-500/15 text-amber-500 border border-amber-500/40 shadow-sm animate-pulse'
                  : 'bg-card text-muted-foreground border border-border'
              }`}
            >
              <span>2. AI OCR Scan</span>
            </div>

            <button
              type="button"
              role="tab"
              aria-selected={currentStep === 'review'}
              onClick={() => {
                if (isCameraActive) stopCamera(true);
                setCurrentStep('review');
              }}
              className={`py-2 px-3 rounded-xl text-xs font-mono font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                currentStep === 'review'
                  ? 'bg-primary-btn text-white shadow-sm ring-1 ring-primary-text/40'
                  : 'bg-card text-muted-foreground border border-border hover:text-foreground hover:border-border-strong'
              }`}
            >
              <span>3. Review & Save</span>
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-6">
          {/* STEP 1: INGEST DOCUMENT & SOURCES */}
          {currentStep === 'upload' && (
            <div className="space-y-5">
              {/* Primary Ingestion Methods Grid - Select Source */}
              <div className="space-y-3">
                <div className="text-center max-w-md mx-auto py-1">
                  <h3 className="text-sm sm:text-base font-bold text-foreground">
                    Select Document Source
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Capture paper summon with camera or upload photo to begin AI extraction
                  </p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {/* 1. Live Camera */}
                  <button
                    type="button"
                    onClick={handleOpenFullScreenCamera}
                    id="btn-start-camera"
                    aria-label="Open full-screen camera to capture paper warrant"
                    className="min-h-[120px] flex flex-col items-center justify-center p-4 sm:p-5 rounded-2xl border-2 border-emerald-500/40 bg-emerald-500/5 hover:border-emerald-500 hover:bg-emerald-500/10 transition-all group cursor-pointer active:scale-[0.98] shadow-sm"
                  >
                    <div className="p-3.5 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform mb-2">
                      <Camera className="w-6 h-6" />
                    </div>
                    <span className="text-xs font-bold text-foreground">Live Camera</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5 text-center">Full-Screen Scanner</span>
                  </button>

                  {/* 2. Gallery Photo Upload with Direct Mobile Crop & OCR */}
                  <label
                    htmlFor="upload-gallery-file"
                    id="btn-gallery-select"
                    className="min-h-[120px] flex flex-col items-center justify-center p-4 sm:p-5 rounded-2xl border-2 border-primary-btn/30 bg-primary-btn/5 hover:border-primary-btn hover:bg-primary-btn/10 transition-all group cursor-pointer active:scale-[0.98] shadow-sm"
                  >
                    <input
                      id="upload-gallery-file"
                      type="file"
                      accept="image/*"
                      onChange={handleSelectPhotoForScanner}
                      className="hidden"
                    />
                    <div className="p-3.5 rounded-xl bg-primary-btn/15 text-primary-text group-hover:scale-110 transition-transform mb-2">
                      <ImageIcon className="w-6 h-6" />
                    </div>
                    <span className="text-xs font-bold text-foreground">Upload Photo</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5 text-center">Preview & Crop → AI OCR</span>
                  </label>

                  {/* 3. PDF Upload */}
                  <label
                    htmlFor="upload-pdf-file"
                    id="btn-pdf-select"
                    className="min-h-[120px] flex flex-col items-center justify-center p-4 sm:p-5 rounded-2xl border border-border bg-card hover:border-primary-text hover:bg-muted/30 transition-all group cursor-pointer active:scale-[0.98]"
                  >
                    <input
                      id="upload-pdf-file"
                      type="file"
                      accept="application/pdf"
                      onChange={handlePdfUpload}
                      className="hidden"
                    />
                    <div className="p-3.5 rounded-xl bg-muted text-muted-foreground group-hover:scale-110 transition-transform mb-2">
                      <FileText className="w-6 h-6" />
                    </div>
                    <span className="text-xs font-bold text-foreground">Court PDF</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5 text-center">Official e-Summon</span>
                  </label>

                  {/* 4. Judicial QR Code */}
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSource('judicial-qr');
                      setIsQrModalOpen(true);
                    }}
                    id="btn-open-qr"
                    aria-label="Scan judicial QR code with camera, photo upload, or CNR text"
                    className={`min-h-[120px] flex flex-col items-center justify-center p-4 sm:p-5 rounded-2xl border-2 transition-all group cursor-pointer active:scale-[0.98] shadow-sm relative ${
                      selectedSource === 'judicial-qr'
                        ? 'border-amber-500 bg-amber-500/15 ring-2 ring-amber-500/50 shadow-md'
                        : 'border-amber-500/30 bg-amber-500/5 hover:border-amber-500 hover:bg-amber-500/10'
                    }`}
                  >
                    {selectedSource === 'judicial-qr' && (
                      <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500 text-black uppercase font-mono tracking-wider shadow-sm">
                        Selected
                      </span>
                    )}
                    <div className="p-3.5 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 group-hover:scale-110 transition-transform mb-2">
                      <QrCode className="w-6 h-6" />
                    </div>
                    <span className="text-xs font-bold text-foreground">Judicial QR</span>
                    <span className="text-[10px] text-muted-foreground mt-0.5 text-center">e-Courts Barcode</span>
                  </button>
                </div>
              </div>

              {/* Secondary QR Launcher Link */}
              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => setIsQrModalOpen(true)}
                  className="text-xs text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 flex items-center gap-1.5 cursor-pointer underline-offset-4 hover:underline"
                >
                  <QrCode className="w-3.5 h-3.5 text-amber-500" />
                  <span>Have an e-Courts QR screenshot or 16-digit CNR code? Scan or test here</span>
                </button>
              </div>

              {/* Attachment Preview (if already loaded) */}
              {attachmentPreview && (
                <div className="p-4 bg-card border border-border rounded-xl flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {attachmentType === 'image' ? (
                      <img
                        src={attachmentPreview}
                        alt="Scanned summon"
                        className="w-12 h-12 rounded-lg object-cover border border-border-strong"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-muted border border-border-strong flex items-center justify-center text-primary-text">
                        <FileText className="w-6 h-6" />
                      </div>
                    )}
                    <div className="truncate">
                      <div className="text-xs font-bold text-foreground truncate">{fileName}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {attachmentType === 'image' ? 'Image Document' : 'Court PDF Notice'} • Ready for review
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => triggerOcrPipeline(attachmentPreview, attachmentType === 'pdf' ? 'application/pdf' : 'image/jpeg')}
                      className="px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-xs text-primary-text flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Re-scan
                    </button>
                    <button
                      type="button"
                      onClick={() => setCurrentStep('review')}
                      className="px-4 py-1.5 rounded-lg bg-primary-btn text-white hover:bg-primary-hover text-xs font-bold text-foreground flex items-center gap-1"
                    >
                      Proceed <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* Manual Entry Direct Action */}
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => setCurrentStep('review')}
                  id="btn-skip-to-manual"
                  className="text-xs text-primary-text hover:underline inline-flex items-center gap-1.5"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Manual Docket Entry (Skip AI OCR Scan)</span>
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: PROCESSING & AI TELEMETRY */}
          {currentStep === 'processing' && (
            <div className="py-12 px-4 text-center space-y-4 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-2xl">
              <div className="relative w-16 h-16 mx-auto">
                <div className="w-16 h-16 rounded-2xl bg-background-alt border border-border-strong flex items-center justify-center">
                  <Sparkles className="w-8 h-8 text-warning animate-pulse" />
                </div>
                <div className="absolute -inset-1 rounded-2xl border-2 border-t-primary-hover border-r-transparent border-b-transparent border-l-transparent animate-spin pointer-events-none" />
              </div>

              <div className="space-y-1 max-w-sm mx-auto">
                <h3 className="text-sm font-bold text-foreground font-mono">
                  JUDICIAL DOCUMENT OCR IN PROGRESS
                </h3>
                <p className="text-xs text-primary-text animate-pulse">{extractStatusText}</p>
                <p className="text-[11px] text-muted-foreground pt-2">
                  Gemini AI models are parsing court headers, FIR details, and respondent address.
                </p>
              </div>
            </div>
          )}

          {/* STEP 3: REVIEW & EDIT FORM */}
          {currentStep === 'review' && (
            <form onSubmit={handleSaveSummon} className="space-y-6">
              {/* e-Courts QR Import Banner */}
              {importedFromECourts && eCourtsImportMeta && (
                <div
                  id="ecourts-imported-banner"
                  className="p-4 rounded-2xl bg-emerald-500/10 border-2 border-emerald-500/40 text-emerald-950 dark:text-emerald-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-xl bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">
                      <CheckCircle2 className="w-5 h-5" />
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-emerald-950 dark:text-emerald-200">
                          ✓ Case information imported successfully
                        </h4>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-600/20 text-emerald-900 dark:text-emerald-300 border border-emerald-500/40 font-bold">
                          e-Courts
                        </span>
                      </div>
                      <p className="text-xs text-emerald-900/90 dark:text-emerald-300/90">
                        <span className="font-semibold">Source:</span> {eCourtsImportMeta.source} &nbsp;•&nbsp;{' '}
                        <span className="font-semibold">Last verified:</span> {eCourtsImportMeta.verifiedAt}
                      </p>
                      {eCourtsImportMeta.cnrNumber && (
                        <p className="text-[11px] font-mono text-emerald-800 dark:text-emerald-400">
                          CNR: {eCourtsImportMeta.cnrNumber}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSource('judicial-qr');
                        setIsQrModalOpen(true);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-950 dark:text-emerald-200 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Re-scan QR</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Unreadable Document Notice with Immediate Actions */}
              {isUnreadable && (
                <div
                  id="unreadable-document-alert"
                  className="p-4 rounded-2xl border-2 border-amber-500/50 bg-amber-500/10 text-foreground space-y-3.5 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="p-2.5 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
                      <AlertTriangle className="w-5 h-5" />
                    </div>
                    <div className="space-y-1 text-xs">
                      <h4 className="font-bold text-sm text-foreground">Unable to read this document.</h4>
                      <p className="text-foreground/90 font-medium leading-relaxed">
                        The document could not be reliably read or contains unreadable text. Please upload a clearer image, scan again, or enter details manually.
                      </p>
                      <p className="text-muted-foreground text-[11px]">
                        Zero-hallucination safeguard active: no synthetic or previous case data has been populated.
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-amber-500/20">
                    <button
                      type="button"
                      onClick={handleOpenFullScreenCamera}
                      id="btn-unreadable-scan-again"
                      className="px-3.5 py-2 rounded-xl bg-primary-btn hover:bg-primary-hover text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-sm transition-transform active:scale-95"
                    >
                      <Camera className="w-4 h-4" />
                      <span>Scan Again</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => recoveryFileInputRef.current?.click()}
                      id="btn-unreadable-upload-another"
                      className="px-3.5 py-2 rounded-xl bg-card border border-border hover:border-primary-text text-foreground text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-sm transition-transform active:scale-95"
                    >
                      <Upload className="w-4 h-4" />
                      <span>Upload Clearer Image</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsUnreadable(false)}
                      id="btn-unreadable-continue-manually"
                      className="px-3.5 py-2 rounded-xl bg-muted/70 hover:bg-muted text-foreground text-xs font-semibold flex items-center gap-1.5 cursor-pointer ml-auto transition-colors"
                    >
                      <Edit3 className="w-4 h-4 text-muted-foreground" />
                      <span>Enter Details Manually</span>
                    </button>
                  </div>
                </div>
              )}

              {/* DEDICATED REVIEW & CONFIDENCE AUDIT BAR */}
              {!isUnreadable && (
                <div className="bg-card border border-border rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-border pb-3.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                        <h3 className="text-sm font-bold text-foreground">Docket Verification & Accuracy Control</h3>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-primary/10 text-primary-text font-bold">
                          Zero-Hallucination Active
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Verify extracted fields before saving to official police records. Unclear text requires manual review.
                      </p>
                    </div>

                    {/* Confidence Threshold Switcher */}
                    <div className="flex items-center gap-2 bg-muted p-1 rounded-xl border border-border self-start md:self-auto">
                      <span className="text-[11px] font-medium text-muted-foreground pl-2 flex items-center gap-1">
                        <Sliders className="w-3 h-3" /> Min Confidence:
                      </span>
                      {[
                        { label: '60% (Relaxed)', val: 0.60 },
                        { label: '75% (Standard)', val: 0.75 },
                        { label: '85% (Strict)', val: 0.85 },
                      ].map((preset) => (
                        <button
                          key={preset.val}
                          type="button"
                          onClick={() => setConfidenceThreshold(preset.val)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                            confidenceThreshold === preset.val
                              ? 'bg-card text-foreground shadow-sm font-bold border border-border'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Extraction Metrics & Batch Controls */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    {/* Summary Badges */}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setReviewFilter('all')}
                        className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer border ${
                          reviewFilter === 'all'
                            ? 'bg-primary-btn text-white border-primary-btn shadow-sm'
                            : 'bg-muted text-foreground border-border hover:bg-card'
                        }`}
                      >
                        <span>All Fields ({fieldStats.total})</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setReviewFilter('needsVerification')}
                        className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer border ${
                          reviewFilter === 'needsVerification'
                            ? 'bg-amber-600 text-white border-amber-600 shadow-sm font-bold'
                            : fieldStats.needsVerificationCount > 0
                            ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/25'
                            : 'bg-muted text-muted-foreground border-border hover:bg-card'
                        }`}
                      >
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>Needs Verification ({fieldStats.needsVerificationCount})</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setReviewFilter('verified')}
                        className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer border ${
                          reviewFilter === 'verified'
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                            : 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20'
                        }`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        <span>Verified ({fieldStats.verifiedCount})</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setReviewFilter('notDetected')}
                        className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer border ${
                          reviewFilter === 'notDetected'
                            ? 'bg-neutral-700 text-white border-neutral-700 shadow-sm'
                            : 'bg-muted text-muted-foreground border-border hover:bg-card'
                        }`}
                      >
                        <span>Not Detected ({fieldStats.notDetectedCount})</span>
                      </button>
                    </div>

                    {/* Batch Verification Actions */}
                    <div className="flex items-center gap-2">
                      {fieldStats.needsVerificationCount > 0 && (
                        <>
                          <button
                            type="button"
                            onClick={handleVerifyAll}
                            className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer active:scale-95"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Verify All ({fieldStats.needsVerificationCount})</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleClearUnverified}
                            className="px-3 py-1.5 rounded-xl bg-card border border-border hover:bg-muted text-muted-foreground hover:text-foreground text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            <span>Clear Low-Conf</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Status & Autofill Banner (When NOT Unreadable) */}
              {!isUnreadable && ocrMessage && (
                <div
                  className={`p-3.5 rounded-xl border text-xs flex flex-col sm:flex-row sm:items-start justify-between gap-3 ${
                    ocrSuccess
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/40 dark:border-emerald-700/60 dark:text-emerald-200'
                      : 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-700/60 dark:text-amber-200'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {ocrSuccess ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <span className="font-bold block mb-0.5">
                        {ocrSuccess ? 'AI OCR Extraction Verified' : 'AI OCR Notice'}
                      </span>
                      <span>{ocrMessage}</span>
                      {detectedFields.size > 0 && (
                        <span className="block mt-1 font-mono text-[11px] opacity-85">
                          Detected in doc: {Array.from(detectedFields).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                    {!ocrSuccess && attachmentPreview && (
                      <button
                        type="button"
                        onClick={() =>
                          triggerOcrPipeline(
                            attachmentPreview,
                            attachmentPreview.startsWith('data:application/pdf') ? 'application/pdf' : 'image/jpeg'
                          )
                        }
                        className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 active:scale-95 text-white text-[11px] font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1 shadow-sm"
                      >
                        <Sparkles className="w-3 h-3" />
                        Retry AI Scan
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setCurrentStep('upload')}
                      className="text-[11px] underline hover:opacity-80 cursor-pointer"
                    >
                      Change Document
                    </button>
                  </div>
                </div>
              )}

              {formError && (
                <div className="p-3 bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-900 dark:text-red-200 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{formError}</span>
                </div>
              )}

              {/* DOCUMENT EVIDENCE PREVIEW (Cropped & Original Photos) */}
              {attachmentPreview && (
                <div className="p-4 bg-card border border-border rounded-2xl space-y-3 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-primary-text uppercase tracking-wider font-mono flex items-center gap-1.5">
                      <FileCheck className="w-4 h-4 text-emerald-500" />
                      Scanned Summon Document Evidence
                    </span>
                    {originalAttachmentPreview && (
                      <div className="flex items-center gap-1.5 bg-muted p-1 rounded-xl border border-border">
                        <button
                          type="button"
                          onClick={() => setViewingOriginalDoc(false)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                            !viewingOriginalDoc
                              ? 'bg-card text-foreground shadow-sm font-bold border border-border'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Cropped (OCR)
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewingOriginalDoc(true)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                            viewingOriginalDoc
                              ? 'bg-card text-foreground shadow-sm font-bold border border-border'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Original Photo
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col sm:flex-row items-center gap-4 bg-neutral-950/40 p-3 rounded-xl border border-border">
                    <div className="relative group max-h-48 max-w-full overflow-hidden rounded-lg border border-border shrink-0">
                      <img
                        src={viewingOriginalDoc && originalAttachmentPreview ? originalAttachmentPreview : attachmentPreview}
                        alt="Summon evidence"
                        className="max-h-44 object-contain rounded-lg shadow-sm"
                      />
                      <div className="absolute bottom-1 right-1 px-2 py-0.5 rounded bg-black/75 text-[10px] text-white/90 font-mono">
                        {viewingOriginalDoc ? 'Original Photo' : 'Cropped for AI OCR'}
                      </div>
                    </div>

                    <div className="space-y-2 text-xs text-muted-foreground flex-1">
                      <div className="font-bold text-foreground truncate">{fileName || 'Document.jpg'}</div>
                      <p className="text-[11px] leading-relaxed">
                        {viewingOriginalDoc
                          ? 'Original uncropped photograph preserved in docket records for official judicial reference.'
                          : 'Cropped document image optimized and scanned by the AI legal docket engine.'}
                      </p>
                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          type="button"
                          onClick={handleOpenFullScreenCamera}
                          className="px-3 py-1.5 rounded-lg bg-muted hover:bg-border text-foreground text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Camera className="w-3.5 h-3.5" /> Re-scan with Camera
                        </button>
                        {originalAttachmentPreview && (
                          <button
                            type="button"
                            onClick={() => {
                              setScannerInitialImage(originalAttachmentPreview);
                              setScannerInitialFileName(fileName);
                              setIsFullScreenScannerOpen(true);
                            }}
                            className="px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-xs font-medium text-primary-text flex items-center gap-1.5 cursor-pointer"
                          >
                            <Maximize2 className="w-3.5 h-3.5" /> Adjust Crop Box
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION A: WARRANT & CASE DETAILS */}
              <div className="space-y-3 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-2xl p-4 sm:p-5">
                <span className="text-xs font-bold text-primary-text uppercase tracking-wider font-mono flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-warning" />
                  A. Warrant & Case Identifiers
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Summon / Warrant / CNR *
                      </label>
                      {renderFieldStatusBadge('summonNumber', summonNumber, () => handleVerifyField('summonNumber'), () => handleClearField('summonNumber', setSummonNumber))}
                    </div>
                    <input
                      type="text"
                      id="input-summon-number"
                      value={summonNumber}
                      onChange={(e) => handleFieldChange('summonNumber', e.target.value, setSummonNumber)}
                      placeholder="e.g. SUM/2026/0892 or CNR Number"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground font-mono focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('summonNumber', summonNumber)}`}
                      required
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Case / FIR Number *
                      </label>
                      {renderFieldStatusBadge('caseNumber', caseNumber, () => handleVerifyField('caseNumber'), () => handleClearField('caseNumber', setCaseNumber))}
                    </div>
                    <input
                      type="text"
                      id="input-case-number"
                      value={caseNumber}
                      onChange={(e) => handleFieldChange('caseNumber', e.target.value, setCaseNumber)}
                      placeholder="e.g. FIR No. 248/2025 PS Tis Hazari"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground font-mono focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('caseNumber', caseNumber)}`}
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">Priority Urgency</label>
                      {renderFieldStatusBadge('urgency', urgency, () => handleVerifyField('urgency'), () => handleClearField('urgency', (v) => setUrgency(v as SummonUrgency)))}
                    </div>
                    <select
                      value={urgency}
                      onChange={(e) => handleFieldChange('urgency', e.target.value, (v) => setUrgency(v as SummonUrgency))}
                      className="w-full bg-background border border-border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all"
                    >
                      <option value="Standard">Standard</option>
                      <option value="High">High Priority</option>
                      <option value="Urgent">Urgent / Warrant</option>
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">Docket Status</label>
                      {renderFieldStatusBadge('status', status, () => handleVerifyField('status'), () => handleClearField('status', (v) => setStatus(v as SummonStatus)))}
                    </div>
                    <select
                      value={status}
                      onChange={(e) => handleFieldChange('status', e.target.value, (v) => setStatus(v as SummonStatus))}
                      className="w-full bg-background border border-border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all"
                    >
                      <option value="Pending">Pending Service</option>
                      <option value="Upcoming">Upcoming Court</option>
                      <option value="Completed">Completed / Served</option>
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">Issue Date</label>
                      {renderFieldStatusBadge('issueDate', issueDate, () => handleVerifyField('issueDate'), () => handleClearField('issueDate', setIssueDate))}
                    </div>
                    <input
                      type="date"
                      value={issueDate}
                      onChange={(e) => handleFieldChange('issueDate', e.target.value, setIssueDate)}
                      className="w-full bg-background border border-border rounded-xl px-3 py-2 text-xs text-foreground font-mono focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Hearing Date *
                      </label>
                      {renderFieldStatusBadge('hearingDate', hearingDate, () => handleVerifyField('hearingDate'), () => handleClearField('hearingDate', setHearingDate))}
                    </div>
                    <input
                      type="date"
                      id="input-hearing-date"
                      value={hearingDate}
                      onChange={(e) => handleFieldChange('hearingDate', e.target.value, setHearingDate)}
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground font-mono focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('hearingDate', hearingDate)}`}
                      required
                    />
                  </div>
                </div>
              </div>

              {/* SECTION B: RESPONDENT & SERVING ADDRESS */}
              <div className="space-y-3 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-2xl p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-primary-text uppercase tracking-wider font-mono flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-warning" />
                    B. Person Summoned & Official Serving Address
                  </span>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsSelectPersonOpen(true)}
                      id="btn-select-someone"
                      className="px-2.5 py-1 bg-card hover:bg-muted text-foreground rounded-lg text-xs font-medium flex items-center gap-1.5 border border-border transition-colors cursor-pointer shadow-sm"
                    >
                      <UserCheck className="w-3.5 h-3.5 text-warning" />
                      <span>Select Someone</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsAddPersonDirectOpen(true)}
                      id="btn-add-someone"
                      className="px-2.5 py-1 bg-primary-btn text-white hover:bg-primary-hover rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Someone</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Respondent / Accused Full Name *
                      </label>
                      {renderFieldStatusBadge('personName', personName, () => handleVerifyField('personName'), () => handleClearField('personName', setPersonName))}
                    </div>
                    <input
                      type="text"
                      id="input-person-name"
                      value={personName}
                      onChange={(e) => handleFieldChange('personName', e.target.value, setPersonName)}
                      placeholder="e.g. Ramesh Chandra / Rajesh Gupta"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('personName', personName)}`}
                      required
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Father / Husband / Guardian Name
                      </label>
                      {renderFieldStatusBadge('fatherName', fatherName, () => handleVerifyField('fatherName'), () => handleClearField('fatherName', setFatherName))}
                    </div>
                    <input
                      type="text"
                      value={fatherName}
                      onChange={(e) => handleFieldChange('fatherName', e.target.value, setFatherName)}
                      placeholder="e.g. Sh. Harish Chandra"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('fatherName', fatherName)}`}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="text-xs font-medium text-muted-foreground">
                      <span className="font-semibold text-foreground">Complete Delivery / Serving Address *</span>
                    </label>
                    {renderFieldStatusBadge('address', address, () => handleVerifyField('address'), () => handleClearField('address', setAddress))}
                  </div>
                  <textarea
                    id="input-serving-address"
                    value={address}
                    onChange={(e) => handleFieldChange('address', e.target.value, setAddress)}
                    placeholder="House/Flat number, Street, Landmark, Village/Colony, Pincode for field officer delivery..."
                    rows={3}
                    className={`w-full bg-background border rounded-xl p-3 text-xs text-foreground leading-relaxed focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('address', address)}`}
                    required
                  />
                </div>
              </div>

              {/* SECTION C: COURT & CHARGES */}
              <div className="space-y-3 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-2xl p-4 sm:p-5">
                <span className="text-xs font-bold text-primary-text uppercase tracking-wider font-mono flex items-center gap-2">
                  <Building2 className="w-3.5 h-3.5 text-warning" />
                  C. Judicial Court & Offense Sections
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Court / Bench Name *
                      </label>
                      {renderFieldStatusBadge('courtName', courtName, () => handleVerifyField('courtName'), () => handleClearField('courtName', setCourtName))}
                    </div>
                    <input
                      type="text"
                      id="input-court-name"
                      value={courtName}
                      onChange={(e) => handleFieldChange('courtName', e.target.value, setCourtName)}
                      placeholder="e.g. Chief Metropolitan Magistrate Court"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('courtName', courtName)}`}
                      required
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Court Room / Complex Location
                      </label>
                      {renderFieldStatusBadge('courtAddress', courtAddress, () => handleVerifyField('courtAddress'), () => handleClearField('courtAddress', setCourtAddress))}
                    </div>
                    <input
                      type="text"
                      value={courtAddress}
                      onChange={(e) => handleFieldChange('courtAddress', e.target.value, setCourtAddress)}
                      placeholder="e.g. Room No. 14, Tis Hazari Courts Complex, Delhi"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('courtAddress', courtAddress)}`}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">Police Station</label>
                      {renderFieldStatusBadge('policeStation', policeStation, () => handleVerifyField('policeStation'), () => handleClearField('policeStation', setPoliceStation))}
                    </div>
                    <input
                      type="text"
                      value={policeStation}
                      onChange={(e) => handleFieldChange('policeStation', e.target.value, setPoliceStation)}
                      placeholder="e.g. PS Tis Hazari"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('policeStation', policeStation)}`}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">District</label>
                      {renderFieldStatusBadge('district', district, () => handleVerifyField('district'), () => handleClearField('district', setDistrict))}
                    </div>
                    <input
                      type="text"
                      value={district}
                      onChange={(e) => handleFieldChange('district', e.target.value, setDistrict)}
                      placeholder="e.g. Central Delhi"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('district', district)}`}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">State</label>
                      {renderFieldStatusBadge('state', state, () => handleVerifyField('state'), () => handleClearField('state', setState))}
                    </div>
                    <input
                      type="text"
                      value={state}
                      onChange={(e) => handleFieldChange('state', e.target.value, setState)}
                      placeholder="e.g. Delhi NCT"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('state', state)}`}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-medium text-muted-foreground">Issuing Authority</label>
                      {renderFieldStatusBadge('issuingAuthority', issuingAuthority, () => handleVerifyField('issuingAuthority'), () => handleClearField('issuingAuthority', setIssuingAuthority))}
                    </div>
                    <input
                      type="text"
                      value={issuingAuthority}
                      onChange={(e) => handleFieldChange('issuingAuthority', e.target.value, setIssuingAuthority)}
                      placeholder="e.g. Judicial Magistrate 1st Class"
                      className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('issuingAuthority', issuingAuthority)}`}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="text-xs font-medium text-muted-foreground">
                      Offense / Legal Sections (IPC / BNS / NI Act)
                    </label>
                    {renderFieldStatusBadge('offenseCharges', offenseCharges, () => handleVerifyField('offenseCharges'), () => handleClearField('offenseCharges', setOffenseCharges))}
                  </div>
                  <input
                    type="text"
                    value={offenseCharges}
                    onChange={(e) => handleFieldChange('offenseCharges', e.target.value, setOffenseCharges)}
                    placeholder="e.g. Under Section 138 NI Act / 420 IPC"
                    className={`w-full bg-background border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary-text focus:ring-1 focus:ring-primary-text/40 transition-all ${getFieldInputClass('offenseCharges', offenseCharges)}`}
                  />
                </div>
              </div>


              {/* SECTION D: SUMMONS PHOTO (OPTIONAL) */}
              <div className="space-y-3 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-2xl p-4 sm:p-5">
                <span className="text-xs font-bold text-primary-text uppercase tracking-wider font-mono flex items-center gap-2">
                  <ImageIcon className="w-3.5 h-3.5 text-warning" />
                  D. Summons Photo (Optional)
                </span>
                
                {attachmentPreview && attachmentType === 'image' ? (
                  <div className="space-y-3">
                    <div className="relative aspect-video max-h-48 bg-black rounded-xl overflow-hidden border border-border flex items-center justify-center">
                      <img src={attachmentPreview} alt="Summons Preview" className="max-w-full max-h-full object-contain" />
                    </div>
                    <div className="flex items-center justify-center gap-3">
                      <label
                        htmlFor="manual-replace-photo"
                        className="px-4 py-2 rounded-xl border border-border hover:bg-muted text-foreground text-[11px] font-medium cursor-pointer transition-colors"
                      >
                        <input
                          id="manual-replace-photo"
                          type="file"
                          accept="image/*"
                          onChange={handleImageUpload}
                          className="hidden"
                        />
                        Replace Photo
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setAttachmentPreview(null);
                          setRawFile(null);
                          setAttachmentType(null);
                          setFileName('');
                        }}
                        className="px-4 py-2 rounded-xl text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-[11px] font-medium cursor-pointer transition-colors"
                      >
                        Remove Photo
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center p-6 border border-dashed border-border rounded-xl bg-background/50">
                    <div className="p-3 rounded-full bg-muted text-muted-foreground mb-3">
                      <ImageIcon className="w-6 h-6" />
                    </div>
                    <p className="text-xs text-muted-foreground text-center max-w-[250px] mb-4">
                      Optionally attach a clear photo of the original summons for future reference.
                    </p>
                    <label
                      htmlFor="manual-add-photo"
                      className="px-5 py-2 rounded-xl bg-primary-btn text-white hover:bg-primary-hover text-xs font-bold flex items-center gap-2 cursor-pointer shadow-sm transition-all"
                    >
                      <input
                        id="manual-add-photo"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handleImageUpload}
                        className="hidden"
                      />
                      <Plus className="w-4 h-4" />
                      Add Photo
                    </label>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setCurrentStep('upload')}
                  className="px-4 py-2.5 rounded-xl border border-border hover:bg-muted text-xs font-medium text-foreground flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" /> Back to Document
                </button>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      stopCamera();
                      onClose();
                    }}
                    className="px-4 py-2.5 rounded-xl border border-border hover:bg-muted text-xs text-muted-foreground transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    id="btn-save-summon-submit"
                    className="px-6 py-2.5 rounded-xl bg-primary-btn text-white hover:bg-primary-hover text-xs font-bold flex items-center gap-2 shadow-md hover:shadow-lg transition-all disabled:opacity-50 cursor-pointer"
                  >
                    {saveSuccess ? (
                      <>
                        <Check className="w-4 h-4" />
                        <span>Saved ✓</span>
                      </>
                    ) : isSubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Saving...</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-4 h-4" />
                        <span>{importedFromECourts ? 'Save Case' : 'Save Summons'}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Select Person / Witness Directory Modal */}
      <SelectPersonModal
        isOpen={isSelectPersonOpen}
        onClose={() => setIsSelectPersonOpen(false)}
        onSelectPerson={handlePersonSelected}
        title="Select Registered Person / Witness"
      />

      {/* Direct Add Person Modal */}
      <SelectPersonModal
        isOpen={isAddPersonDirectOpen}
        onClose={() => setIsAddPersonDirectOpen(false)}
        onSelectPerson={handlePersonSelected}
        title="Register & Select Person"
        defaultRoleFilter="Accused"
      />
      {cropImageSrc && (
        <ImageCropperModal
          isOpen={!!cropImageSrc}
          onClose={() => setCropImageSrc(null)}
          imageSrc={cropImageSrc}
          onCropComplete={handleCropComplete}
        />
      )}

      {/* Hidden recovery file input for unreadable document fast path */}
      <input
        type="file"
        ref={recoveryFileInputRef}
        accept="image/*,application/pdf"
        className="hidden"
        onChange={handleSelectPhotoForScanner}
      />

      {/* Dedicated Mobile Full-Screen Camera Document Scanner: mounts ONLY when opened */}
      {isFullScreenScannerOpen && (
        <DocumentCameraScanner
          isOpen={isFullScreenScannerOpen}
          sessionScanId={currentScanSessionId}
          onClose={() => {
            setIsFullScreenScannerOpen(false);
            setScannerInitialImage(null);
            setScannerInitialFileName(undefined);
          }}
          onScanComplete={handleScannerComplete}
          initialImageSrc={scannerInitialImage}
          initialFileName={scannerInitialFileName}
        />
      )}

      {/* Dedicated Judicial QR & CNR Scanner Modal */}
      {isQrModalOpen && (
        <JudicialQrScannerModal
          isOpen={isQrModalOpen}
          sessionScanId={currentScanSessionId}
          onClose={() => setIsQrModalOpen(false)}
          onUseCaseDetails={(caseData, rawPayload, sessionId) => {
            handleApplyCaseDetails(caseData, rawPayload, sessionId);
          }}
          onScanSuccess={(payload, sessionId) => {
            setIsQrModalOpen(false);
            handleDecodedQr(payload, sessionId);
          }}
          onManualEntryFallback={(cnr) => {
            setIsQrModalOpen(false);
            if (cnr) {
              const cleanCnr = cnr.trim().toUpperCase();
              setSummonNumber(cleanCnr);
              if (!caseNumber) {
                setCaseNumber(cleanCnr);
              }
              const detected = new Set(detectedFields);
              detected.add('summonNumber');
              setDetectedFields(detected);
              setFieldMeta((prev) => ({
                ...prev,
                summonNumber: {
                  field: 'summonNumber',
                  value: cleanCnr,
                  confidence: 1.0,
                  source: 'user',
                  isVerified: true,
                  isModified: false,
                },
              }));
              showToast(
                'Enter your verified case details below. Your scanned CNR number has been added.',
                'info',
                'CNR Added'
              );
            }
            setIsUnreadable(false);
            setCurrentStep('review');
          }}
        />
      )}
    </div>
  );
};
