import React, { useState } from 'react';
import {
  X,
  Share2,
  FileImage,
  CheckCircle2,
  Trash2,
  Bell,
  Calendar,
  MapPin,
  Building2,
  User,
  Shield,
  Clock,
  Edit2,
  Save,
  Copy,
  Check,
  FileText,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Download,
  Maximize2,
} from 'lucide-react';
import { Summon } from '../types';
import { useSummons } from '../context/SummonContext';
import { useToast } from './Toast';
import { generateFormattedForwardText, shareSummonNative } from '../utils/shareService';
import { downloadSummonNoticePDF } from '../utils/pdfService';
import { downloadSummonImage } from '../utils/documentDownloadService';
import { ImageCropperModal } from './ImageCropperModal';

interface SummonDetailModalProps {
  summon: Summon | null;
  onClose: () => void;
  onOpenSplitScreenshot: (summon: Summon) => void;
}

export const SummonDetailModal: React.FC<SummonDetailModalProps> = ({
  summon,
  onClose,
  onOpenSplitScreenshot,
}) => {
  const { updateSummon, deleteSummon, markAsServed, toggleReminder } = useSummons();
  const { showToast } = useToast();

  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [showMarkServedModal, setShowMarkServedModal] = useState<boolean>(false);
  const [servedNotes, setServedNotes] = useState<string>('');
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState<boolean>(false);
  const [isDownloadingImage, setIsDownloadingImage] = useState<boolean>(false);

  // Edit states
  const [editPersonName, setEditPersonName] = useState('');
  const [editFatherName, setEditFatherName] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editHearingDate, setEditHearingDate] = useState('');
  const [editCourtName, setEditCourtName] = useState('');
  const [editCourtAddress, setEditCourtAddress] = useState('');
  const [editOffense, setEditOffense] = useState('');
  const [editUrgency, setEditUrgency] = useState<'Standard' | 'High' | 'Urgent'>('Standard');
  const [editRawFile, setEditRawFile] = useState<File | null>(null);
  const [editAttachmentPreview, setEditAttachmentPreview] = useState<string | null>(null);
  const [editFileName, setEditFileName] = useState<string>('');
  const [removeImage, setRemoveImage] = useState<boolean>(false);
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [cropFileName, setCropFileName] = useState<string>('');
  const [cropMimeType, setCropMimeType] = useState<string>('image/jpeg');
  const [isFullImageOpen, setIsFullImageOpen] = useState<boolean>(false);
  const [viewingOriginalPhoto, setViewingOriginalPhoto] = useState<boolean>(false);
  
  const handleEditImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCropFileName(file.name);
    setCropMimeType(file.type || 'image/jpeg');
    const reader = new FileReader();
    reader.onload = () => {
      setCropImageSrc(reader.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleEditCropComplete = (croppedBlob: Blob) => {
    setCropImageSrc(null);
    const file = new File([croppedBlob], cropFileName, { type: cropMimeType });
    setEditRawFile(file);
    setEditFileName(cropFileName);
    setRemoveImage(false);
    const reader = new FileReader();
    reader.onload = () => {
      setEditAttachmentPreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  
  const hasUnsavedChanges = () => {
    if (editRawFile !== null) return true;
    if (removeImage) return true;
    if (!isEditing || !summon) return false;
    if (editPersonName !== summon.personName) return true;
    if (editFatherName !== (summon.fatherName || '')) return true;
    if (editAddress !== summon.address) return true;
    if (editHearingDate !== summon.hearingDate) return true;
    if (editCourtName !== summon.courtName) return true;
    if (editCourtAddress !== summon.courtAddress) return true;
    if (editOffense !== (summon.offenseCharges || '')) return true;
    if (editUrgency !== summon.urgency) return true;
    return false;
  };

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Autosave Effect
  React.useEffect(() => {
    if (!isEditing || !summon) return;
    if (!hasUnsavedChanges()) return;
    setSaveStatus('saving');
    const timer = setTimeout(async () => {
      try {
        let updates: any = {
          personName: editPersonName.trim(),
          fatherName: editFatherName.trim() || undefined,
          address: editAddress.trim(),
          hearingDate: editHearingDate,
          courtName: editCourtName.trim(),
          courtAddress: editCourtAddress.trim(),
          offenseCharges: editOffense.trim(),
          urgency: editUrgency,
        };
        if (removeImage) updates.imageUrl = '';
        
        await updateSummon(summon.id, updates, editRawFile, editFileName);
        
        setEditRawFile(null);
        setRemoveImage(false);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000); // clear saved text after 2s
      } catch {
        setSaveStatus('error');
      }
    }, 1000); // 1s debounce
    return () => clearTimeout(timer);
  }, [
    editPersonName, editFatherName, editAddress, editHearingDate,
    editCourtName, editCourtAddress, editOffense, editUrgency, isEditing, summon?.id, updateSummon
  ]);

  const handleClose = React.useCallback(() => {
    setIsEditing(false);
    setEditRawFile(null);
    setRemoveImage(false);
    onClose();
  }, [onClose]);

  // Keyboard Escape listener to close modal (called unconditionally before early return)
  React.useEffect(() => {
    if (!summon) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [summon, handleClose]);

  if (!summon) return null;

  const handleStartEdit = () => {
    setEditPersonName(summon.personName);
    setEditFatherName(summon.fatherName || '');
    setEditAddress(summon.address);
    setEditHearingDate(summon.hearingDate);
    setEditCourtName(summon.courtName);
    setEditCourtAddress(summon.courtAddress);
    setEditOffense(summon.offenseCharges || '');
    setEditUrgency(summon.urgency);
    setEditRawFile(null);
    setEditAttachmentPreview(null);
    setEditFileName('');
    setRemoveImage(false);
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    try {
      let updates: any = {
        personName: editPersonName.trim(),
        fatherName: editFatherName.trim() || undefined,
        address: editAddress.trim(),
        hearingDate: editHearingDate,
        courtName: editCourtName.trim(),
        courtAddress: editCourtAddress.trim(),
        offenseCharges: editOffense.trim(),
        urgency: editUrgency,
      };
      if (removeImage) updates.imageUrl = '';
      
      await updateSummon(summon.id, updates, editRawFile, editFileName);
      setEditRawFile(null);
      setRemoveImage(false);
      setIsEditing(false);
      showToast('Summon docket updated successfully in database', 'success', 'Saved');
    } catch {
      showToast('Failed to update summon docket', 'error', 'Error');
    }
  };

  const handleConfirmServed = async () => {
    try {
      await markAsServed(summon.id, servedNotes || 'Served directly to respondent with signature.');
      setShowMarkServedModal(false);
      showToast('Summon marked as Served and Closed', 'success', 'Status Updated');
    } catch {
      showToast('Failed to mark summon as served', 'error', 'Error');
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteSummon(summon.id);
      showToast(`Summon ${summon.summonNumber} deleted`, 'info', 'Record Removed');
      setIsDeleting(false);
      handleClose();
    } catch {
      setIsDeleting(false);
      showToast('Failed to delete summon', 'error', 'Error');
    }
  };

  const handleCopyText = async () => {
    const text = generateFormattedForwardText(summon);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      showToast('Formatted court notice copied to clipboard', 'info', 'Copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Could not access clipboard', 'warning');
    }
  };

  const handleDownloadPdf = async () => {
    setIsGeneratingPdf(true);
    try {
      const filename = await downloadSummonNoticePDF(summon);
      showToast(`Official PDF downloaded: ${filename}`, 'success', 'PDF Downloaded');
    } catch (err: any) {
      console.error('PDF generation error:', err);
      showToast('Failed to generate notice PDF', 'error', 'Error');
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const handleDownloadImage = async (forceOriginal: boolean = true) => {
    if (!summon) return;
    setIsDownloadingImage(true);
    try {
      const result = await downloadSummonImage(summon, {
        preferOriginal: true,
        forceOriginal,
        isViewingOriginal: viewingOriginalPhoto,
      });
      showToast(
        `${result.isOriginal ? 'Original summons photo' : 'Scanned document'} downloaded: ${result.fileName}`,
        'success',
        'Download Complete'
      );
    } catch (err: any) {
      console.error('Failed to download summon image:', err);
      showToast(err.message || 'Failed to download original summons photo', 'error', 'Download Error');
    } finally {
      setIsDownloadingImage(false);
    }
  };

  const handleForwardNative = async () => {
    const shared = await shareSummonNative(summon);
    if (shared) {
      showToast('Notice forwarded via device share', 'success', 'Shared');
    }
  };

  const handleToggleReminder = async () => {
    await toggleReminder(summon.id);
    showToast(
      summon.reminderEnabled ? 'Hearing reminder disabled' : 'Hearing reminder enabled',
      'info',
      'Reminder'
    );
  };

  // Days remaining calculation
  const today = new Date().toISOString().split('T')[0];
  const diffDays = Math.ceil(
    (new Date(summon.hearingDate).getTime() - new Date(today).getTime()) / (1000 * 3600 * 24)
  );

  return (
    <div
      id="summon-detail-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-md overflow-y-auto animate-fadeIn"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div className="bg-background border border-border rounded-2xl w-full max-w-3xl my-8 overflow-hidden shadow-premium-hover animate-scaleIn flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="bg-background-alt border-b border-border px-6 py-4 flex items-center justify-between sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-lg ${
                summon.status === 'Completed'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400'
                  : summon.urgency === 'Urgent'
                  ? 'bg-red-50 text-red-800 border border-red-200 dark:bg-red-950/80 dark:text-red-400'
                  : 'bg-muted text-primary-text border border-border'
              }`}
            >
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold text-foreground font-mono">{summon.summonNumber}</h2>
                <span
                  className={`px-2.5 py-0.5 text-[10px] font-bold uppercase rounded-full ${
                    summon.status === 'Completed'
                      ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-900/60 dark:text-emerald-300 dark:border-emerald-500/40'
                      : summon.status === 'Upcoming'
                      ? 'bg-blue-50 text-blue-800 border border-blue-200 dark:bg-blue-900/60 dark:text-blue-300 dark:border-blue-500/40'
                      : 'bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-900/60 dark:text-amber-300 dark:border-amber-500/40'
                  }`}
                >
                  {summon.status}
                </span>
                {summon.urgency === 'Urgent' && (
                  <span className="px-2.5 py-0.5 text-[10px] font-bold uppercase rounded-full bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/80 dark:text-red-200 dark:border-red-500">
                    Urgent
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground font-mono">{summon.caseNumber}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleToggleReminder}
              title="Toggle Hearing Reminder"
              aria-label="Toggle Hearing Reminder"
              className={`p-2 rounded-lg border transition-colors cursor-pointer ${
                summon.reminderEnabled
                  ? 'bg-amber-50 border-amber-300 text-amber-800 dark:bg-warning/20 dark:border-warning dark:text-warning'
                  : 'bg-card border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <Bell className="w-4 h-4" />
            </button>
            <button
              type="button"
              id="close-summon-detail-button"
              onClick={handleClose}
              aria-label="Close summon details"
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted active:scale-95 transition-all cursor-pointer min-w-[40px] min-h-[40px] flex items-center justify-center border border-transparent hover:border-border"
              title="Close (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Days Remaining / Serving Status Banner */}
          <div
            className={`p-4 rounded-xl border flex items-center justify-between ${
              summon.status === 'Completed'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/40 dark:border-emerald-700/50 dark:text-emerald-300'
                : diffDays <= 2
                ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/40 dark:border-red-800/60 dark:text-red-300'
                : 'bg-card border-border text-foreground'
            }`}
          >
            <div className="flex items-center gap-3">
              <Clock className="w-5 h-5 shrink-0" />
              <div>
                <span className="text-xs uppercase tracking-wider font-bold block">
                  {summon.status === 'Completed'
                    ? 'SUMMON SERVED & COMPLETED'
                    : diffDays < 0
                    ? 'HEARING DATE OVERDUE'
                    : diffDays === 0
                    ? 'COURT HEARING DUE TODAY'
                    : `${diffDays} DAYS REMAINING UNTIL COURT HEARING`}
                </span>
                <span className="text-xs opacity-80">
                  {summon.status === 'Completed'
                    ? `Served on: ${summon.servedDate || 'Recorded'}`
                    : `Appearance Date: ${summon.hearingDate}`}
                </span>
              </div>
            </div>

            {summon.status !== 'Completed' && (
              <button
                type="button"
                onClick={() => setShowMarkServedModal(true)}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg flex items-center gap-1.5 shadow cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" /> Mark Served
              </button>
            )}
          </div>

          {/* Served Details if completed */}
          {summon.status === 'Completed' && summon.servedNotes && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 dark:bg-emerald-950/30 dark:border-emerald-800/40 dark:text-emerald-200">
              <span className="font-bold block mb-1 font-mono">Serving Officer Confirmation Notes:</span>
              <p>{summon.servedNotes}</p>
            </div>
          )}

          {/* DOCUMENT ATTACHMENTS (IMAGE OR PDF) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-primary-text uppercase tracking-wider font-mono">
                Official Document / Warrant Scan
              </span>
              {!isEditing && summon.imageUrl && (
                <span className="text-[11px] text-muted-foreground">
                  Preserved in encrypted cloud vault
                </span>
              )}
            </div>
            {isEditing ? (
              <div className="border border-border border-dashed rounded-xl overflow-hidden bg-black/20 p-4 flex flex-col items-center justify-center space-y-3">
                {(!removeImage && (editAttachmentPreview || summon.imageUrl)) ? (
                  <>
                    <img
                      src={editAttachmentPreview || summon.imageUrl}
                      alt="Summon document copy"
                      className="max-h-48 object-contain rounded-lg border border-border-strong"
                    />
                    <div className="flex items-center gap-3">
                      <label htmlFor="edit-replace-photo" className="px-3 py-1.5 rounded-lg bg-muted hover:bg-border text-xs cursor-pointer transition-colors">
                        <input id="edit-replace-photo" type="file" accept="image/*" onChange={handleEditImageUpload} className="hidden" />
                        Replace Photo
                      </label>
                      <button type="button" onClick={() => setRemoveImage(true)} className="px-3 py-1.5 rounded-lg text-red-400 hover:bg-red-950/30 text-xs transition-colors cursor-pointer">
                        Remove Photo
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="p-3 bg-muted rounded-full text-muted-foreground">
                      <ImageIcon className="w-5 h-5" />
                    </div>
                    <span className="text-xs text-muted-foreground">No summons photo attached</span>
                    <label htmlFor="edit-add-photo" className="px-3 py-1.5 rounded-lg bg-primary-btn hover:bg-primary-hover text-white text-xs cursor-pointer transition-colors mt-2">
                      <input id="edit-add-photo" type="file" accept="image/*" capture="environment" onChange={handleEditImageUpload} className="hidden" />
                      Add Photo
                    </label>
                  </>
                )}
              </div>
            ) : (
              summon.imageUrl || summon.originalImageUrl ? (
                <div className="border border-border rounded-xl overflow-hidden bg-black/40 p-3.5 flex flex-col items-center">
                  {/* Image Header & Action Toolbar */}
                  <div className="w-full flex items-center justify-between gap-2 flex-wrap mb-3 pb-2 border-b border-border/60">
                    {summon.originalImageUrl && summon.imageUrl ? (
                      <div className="flex items-center gap-1 bg-muted p-1 rounded-xl border border-border">
                        <button
                          type="button"
                          onClick={() => setViewingOriginalPhoto(false)}
                          className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                            !viewingOriginalPhoto
                              ? 'bg-card text-foreground shadow-sm font-bold border border-border'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Cropped (OCR)
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewingOriginalPhoto(true)}
                          className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                            viewingOriginalPhoto
                              ? 'bg-card text-foreground shadow-sm font-bold border border-border'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Original Photo
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-semibold">
                        <ImageIcon className="w-4 h-4 text-primary-text" />
                        <span>{summon.originalImageUrl ? 'Original Uploaded Photo' : 'Document Scan'}</span>
                      </div>
                    )}

                    {/* Download Button on Toolbar */}
                    <button
                      type="button"
                      onClick={() => handleDownloadImage(true)}
                      disabled={isDownloadingImage}
                      aria-label="Download original summon document photo"
                      title="Download original uncompressed photo"
                      className="px-3.5 py-1.5 rounded-xl bg-primary-btn hover:bg-primary-hover active:scale-95 text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer disabled:opacity-50"
                    >
                      {isDownloadingImage ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      <span>Download Original</span>
                    </button>
                  </div>

                  {/* Document Image */}
                  <div className="relative group w-full flex justify-center py-1">
                    <img
                      src={viewingOriginalPhoto && summon.originalImageUrl ? summon.originalImageUrl : (summon.imageUrl || summon.originalImageUrl)}
                      alt="Summon document copy"
                      className="max-h-72 w-auto object-contain rounded-lg border border-border-strong cursor-pointer shadow-sm hover:opacity-95 transition-opacity"
                      onClick={() => setIsFullImageOpen(true)}
                    />
                  </div>

                  {/* Sub-bar with View Full Image & Download Details */}
                  <div className="w-full flex items-center justify-between pt-2.5 mt-2 border-t border-border/40 text-xs text-muted-foreground flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setIsFullImageOpen(true)}
                        className="text-[11px] font-semibold text-primary-text hover:underline flex items-center gap-1 cursor-pointer"
                      >
                        <Maximize2 className="w-3.5 h-3.5" /> View Full Image
                      </button>
                      <span className="text-[10px] font-mono opacity-70">
                        {viewingOriginalPhoto ? '• Preserved Original Quality' : '• Scanned Docket Copy'}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDownloadImage(viewingOriginalPhoto)}
                      disabled={isDownloadingImage}
                      className="text-[11px] text-muted-foreground hover:text-foreground hover:underline flex items-center gap-1 cursor-pointer"
                    >
                      <Download className="w-3 h-3 text-primary-text" />
                      <span>{viewingOriginalPhoto ? 'Save High-Res Original' : 'Save Scanned Copy'}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="border border-border border-dashed rounded-xl overflow-hidden bg-black/20 p-6 flex flex-col items-center justify-center">
                  <ImageIcon className="w-6 h-6 text-muted-foreground mb-2 opacity-50" />
                  <span className="text-xs text-muted-foreground">No summons photo attached</span>
                </div>
              )
            )}
          </div>
          
      {cropImageSrc && (
        <ImageCropperModal
          isOpen={!!cropImageSrc}
          onClose={() => setCropImageSrc(null)}
          imageSrc={cropImageSrc}
          onCropComplete={handleEditCropComplete}
        />
      )}
          {/* Full Image Modal */}
          {isFullImageOpen && (summon?.imageUrl || summon?.originalImageUrl) && (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6 bg-black/90 backdrop-blur-md animate-fadeIn"
              onClick={() => setIsFullImageOpen(false)}
            >
              <div
                className="relative max-w-5xl w-full h-full flex flex-col items-center justify-between"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Full Image Top Toolbar */}
                <div className="w-full flex items-center justify-between gap-3 p-3 bg-black/75 backdrop-blur-md rounded-2xl border border-white/10 mb-2 z-10">
                  <div className="flex items-center gap-2">
                    <span className="text-white text-xs font-mono font-bold tracking-wider">
                      {summon.summonNumber}
                    </span>
                    {summon.originalImageUrl && summon.imageUrl && (
                      <div className="flex items-center gap-1 bg-white/10 p-0.5 rounded-lg ml-2">
                        <button
                          type="button"
                          onClick={() => setViewingOriginalPhoto(false)}
                          className={`px-2.5 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                            !viewingOriginalPhoto
                              ? 'bg-white text-black font-bold shadow'
                              : 'text-white/70 hover:text-white'
                          }`}
                        >
                          Cropped (OCR)
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewingOriginalPhoto(true)}
                          className={`px-2.5 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                            viewingOriginalPhoto
                              ? 'bg-white text-black font-bold shadow'
                              : 'text-white/70 hover:text-white'
                          }`}
                        >
                          Original Photo
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleDownloadImage(true)}
                      disabled={isDownloadingImage}
                      aria-label="Download original document photo"
                      className="px-3.5 py-1.5 rounded-xl bg-primary-btn hover:bg-primary-hover active:scale-95 text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow-md cursor-pointer disabled:opacity-50"
                    >
                      {isDownloadingImage ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      <span>Download Original</span>
                    </button>
                    <button
                      type="button"
                      aria-label="Close full image view"
                      onClick={() => setIsFullImageOpen(false)}
                      className="p-2 bg-white/10 hover:bg-white/20 text-white rounded-xl transition-colors cursor-pointer"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                {/* Main Full Image */}
                <div className="flex-1 w-full flex items-center justify-center overflow-hidden p-2">
                  <img
                    src={viewingOriginalPhoto && summon.originalImageUrl ? summon.originalImageUrl : (summon.imageUrl || summon.originalImageUrl)}
                    alt="Full Summons Photo"
                    className="max-w-full max-h-[82vh] object-contain rounded-xl shadow-2xl border border-white/10"
                  />
                </div>
              </div>
            </div>
          )}

          {summon.pdfUrl && (
            <div className="p-4 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-muted rounded-lg text-primary-text">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-bold text-foreground">Court PDF Notice Document</div>
                  <div className="text-[11px] text-muted-foreground">{summon.fileName || 'Notice_Document.pdf'}</div>
                </div>
              </div>
              <a
                href={summon.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 rounded-lg bg-primary-btn text-white hover:bg-primary-hover text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm"
              >
                <ExternalLink className="w-3.5 h-3.5" /> View PDF
              </a>
            </div>
          )}

          {/* PARTICULARS GRID */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <span className="text-xs font-bold text-primary-text uppercase tracking-wider font-mono">
                Judicial Docket Particulars
              </span>
              {!isEditing ? (
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="text-xs text-primary-text hover:underline flex items-center gap-1 cursor-pointer font-semibold"
                >
                  <Edit2 className="w-3.5 h-3.5" /> Edit Details
                </button>
              ) : (
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    disabled={saveStatus === 'saving'}
                    className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1 font-bold cursor-pointer disabled:opacity-50"
                  >
                    {saveStatus === 'saving' ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...</>
                    ) : saveStatus === 'saved' ? (
                      <><Check className="w-3.5 h-3.5" /> Saved</>
                    ) : (
                      <><Save className="w-3.5 h-3.5" /> Save / Done</>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditing(false);
                      setEditRawFile(null);
                      setRemoveImage(false);
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline flex items-center gap-1 font-bold cursor-pointer ml-3"
                  >
                    <X className="w-3.5 h-3.5" /> Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Respondent & Address Box */}
            <div className="p-4 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-xl space-y-3">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-muted text-primary-text shrink-0 mt-1">
                  <User className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] text-muted-foreground uppercase font-semibold">Person Summoned</span>
                  {isEditing ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                      <input
                        type="text"
                        value={editPersonName}
                        onChange={(e) => setEditPersonName(e.target.value)}
                        placeholder="Person name"
                        className="w-full bg-background border border-border-strong rounded px-2.5 py-1 text-xs text-foreground"
                      />
                      <input
                        type="text"
                        value={editFatherName}
                        onChange={(e) => setEditFatherName(e.target.value)}
                        placeholder="Father/Spouse name"
                        className="w-full bg-background border border-border-strong rounded px-2.5 py-1 text-xs text-foreground"
                      />
                    </div>
                  ) : (
                    <h3 className="text-base font-bold text-foreground">
                      {summon.personName}
                      {summon.fatherName && (
                        <span className="text-xs font-normal text-foreground-alt ml-2">
                          (S/O {summon.fatherName})
                        </span>
                      )}
                    </h3>
                  )}
                </div>
              </div>

              {/* Full Address Highlight */}
              <div className="flex items-start gap-3 pt-2 border-t border-border">
                <div className="p-2 rounded-lg bg-amber-100 text-amber-800 dark:bg-warning-muted dark:text-warning shrink-0 mt-1">
                  <MapPin className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] font-bold text-amber-800 dark:text-warning uppercase font-mono">
                    Full Residential / Serving Address
                  </span>
                  {isEditing ? (
                    <textarea
                      value={editAddress}
                      onChange={(e) => setEditAddress(e.target.value)}
                      rows={2}
                      className="w-full bg-background border border-border-strong rounded px-2.5 py-1 text-xs text-foreground mt-1"
                    />
                  ) : (
                    <p className="text-sm font-medium text-foreground mt-0.5 leading-relaxed">
                      {summon.address}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    Police Station: {summon.policeStation} • District: {summon.district}
                  </p>
                </div>
              </div>
            </div>

            {/* Court & Appearance Box */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-xl">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1 font-semibold">
                  <Building2 className="w-3.5 h-3.5 text-primary-text" />
                  <span>COURT & BENCH</span>
                </div>
                {isEditing ? (
                  <div className="space-y-2 mt-1">
                    <input
                      type="text"
                      value={editCourtName}
                      onChange={(e) => setEditCourtName(e.target.value)}
                      className="w-full bg-background border border-border-strong rounded px-2 py-1 text-xs text-foreground"
                      placeholder="Court name"
                    />
                    <input
                      type="text"
                      value={editCourtAddress}
                      onChange={(e) => setEditCourtAddress(e.target.value)}
                      className="w-full bg-background border border-border-strong rounded px-2 py-1 text-xs text-foreground"
                      placeholder="Court room/complex"
                    />
                  </div>
                ) : (
                  <>
                    <h4 className="text-sm font-bold text-foreground">{summon.courtName}</h4>
                    <p className="text-xs text-muted-foreground">{summon.courtAddress}</p>
                    <p className="text-[11px] text-foreground-alt mt-1">
                      Authority: {summon.issuingAuthority || 'Judicial Magistrate'}
                    </p>
                  </>
                )}
              </div>

              <div className="p-4 bg-card border border-border shadow-sm hover:border-border-strong transition-all duration-200 rounded-xl">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1 font-semibold">
                  <Calendar className="w-3.5 h-3.5 text-warning" />
                  <span>HEARING TIMELINE</span>
                </div>
                {isEditing ? (
                  <div className="space-y-2 mt-1">
                    <div>
                      <label className="text-[10px] text-muted-foreground block mb-0.5">Hearing Date</label>
                      <input
                        type="date"
                        value={editHearingDate}
                        onChange={(e) => setEditHearingDate(e.target.value)}
                        className="w-full bg-background border border-border-strong rounded px-2 py-1 text-xs text-foreground font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground block mb-0.5">Offense Charges</label>
                      <input
                        type="text"
                        value={editOffense}
                        onChange={(e) => setEditOffense(e.target.value)}
                        placeholder="Sections / charges"
                        className="w-full bg-background border border-border-strong rounded px-2 py-1 text-xs text-foreground"
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-bold font-mono text-warning">
                        {summon.hearingDate}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Issued on: {summon.issueDate}</p>
                    {summon.offenseCharges && (
                      <p className="text-[11px] text-primary-text mt-1">
                        Charges: {summon.offenseCharges}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Mark Served Submodal */}
          {showMarkServedModal && (
            <div className="p-4 bg-muted border border-emerald-600 rounded-xl space-y-3">
              <h4 className="text-sm font-bold text-foreground flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                Confirm Summon Service to Respondent
              </h4>
              <p className="text-xs text-foreground-alt">
                Enter delivery confirmation notes, witness details, or recipient acknowledgment:
              </p>
              <textarea
                value={servedNotes}
                onChange={(e) => setServedNotes(e.target.value)}
                placeholder="e.g. Served in person at residence. Signature obtained on police copy. Handed to respondent."
                className="w-full bg-background border border-border-strong rounded-lg p-2 text-xs text-foreground focus:outline-none focus:border-emerald-400"
                rows={2}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowMarkServedModal(false)}
                  className="px-3 py-1.5 bg-card text-xs text-muted-foreground rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmServed}
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-foreground font-bold text-xs rounded-lg cursor-pointer"
                >
                  Confirm & Close Summon
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="bg-background-alt border-t border-border px-6 py-4 flex flex-wrap items-center justify-between gap-3 sticky bottom-0 z-20">
          <div className="flex items-center gap-2">
            <button
              type="button"
              id="footer-close-summon-button"
              onClick={handleClose}
              className="px-4 py-2 rounded-xl border border-border bg-card hover:bg-muted text-xs font-bold text-foreground flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm min-h-[38px]"
            >
              <X className="w-4 h-4" /> Close
            </button>

            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 flex items-center gap-1.5 p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer min-h-[38px]"
            >
              <Trash2 className="w-4 h-4" /> Delete Record
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyText}
              aria-label="Copy notice text"
              className="px-3.5 py-2 rounded-xl border border-border bg-card hover:bg-muted text-xs font-medium text-foreground flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy Notice Text'}
            </button>

            {(summon.imageUrl || summon.originalImageUrl) && (
              <button
                type="button"
                onClick={() => handleDownloadImage(true)}
                disabled={isDownloadingImage}
                aria-label="Download original summons document photo"
                className="px-3.5 py-2 rounded-xl bg-card hover:bg-muted text-foreground text-xs font-bold flex items-center gap-1.5 border border-border transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
              >
                {isDownloadingImage ? (
                  <Loader2 className="w-4 h-4 animate-spin text-primary-text" />
                ) : (
                  <Download className="w-4 h-4 text-primary-text" />
                )}
                <span>Download Photo</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={isGeneratingPdf}
              aria-label="Download official notice PDF"
              className="px-3.5 py-2 rounded-xl bg-card hover:bg-muted text-foreground text-xs font-bold flex items-center gap-1.5 border border-border transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
            >
              {isGeneratingPdf ? <Loader2 className="w-4 h-4 animate-spin text-warning" /> : <FileText className="w-4 h-4 text-primary-text" />}
              <span>Notice PDF</span>
            </button>

            <button
              type="button"
              onClick={() => onOpenSplitScreenshot(summon)}
              aria-label="Open visual split screenshot"
              className="px-4 py-2 rounded-xl bg-muted hover:bg-muted/80 text-foreground text-xs font-bold flex items-center gap-1.5 border border-border transition-colors cursor-pointer shadow-sm"
            >
              <FileImage className="w-4 h-4 text-primary-text" /> Visual Split Copy
            </button>

            <button
              type="button"
              onClick={handleForwardNative}
              aria-label="Forward summon details"
              className="px-5 py-2 rounded-xl bg-primary-btn hover:bg-primary-hover text-white text-xs font-bold flex items-center gap-1.5 shadow transition-colors cursor-pointer"
            >
              <Share2 className="w-4 h-4" /> Forward Summon
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
