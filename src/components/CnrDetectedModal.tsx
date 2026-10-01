import React, { useState, useEffect } from 'react';
import {
  X,
  Copy,
  Check,
  ExternalLink,
  Edit3,
  Landmark,
  QrCode,
  CheckCircle2,
  FileText,
  Shield,
  ArrowRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { SummonsMitraLogo } from './SummonsMitraLogo';
import { useToast } from './Toast';

export interface CnrDetectedModalProps {
  isOpen: boolean;
  onClose: () => void;
  cnrNumber: string;
  onEnterDetailsManually: (cnr: string) => void;
  rawPayload?: string;
}

export const CnrDetectedModal: React.FC<CnrDetectedModalProps> = ({
  isOpen,
  onClose,
  cnrNumber,
  onEnterDetailsManually,
}) => {
  const { showToast } = useToast();
  const [copied, setCopied] = useState<boolean>(false);

  // Reset copied status on modal reopen
  useEffect(() => {
    if (isOpen) {
      setCopied(false);
    }
  }, [isOpen, cnrNumber]);

  // Keyboard Escape listener
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const cleanCnr = (cnrNumber || '').trim().toUpperCase();

  const handleCopy = async () => {
    if (!cleanCnr) return;

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(cleanCnr);
      } else {
        // Fallback for older webview / non-secure contexts
        const textArea = document.createElement('textarea');
        textArea.value = cleanCnr;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      showToast('CNR number copied successfully!', 'success', 'Copied');
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
      showToast('Could not access clipboard automatically. Please copy manually.', 'warning');
    }
  };

  const handleOpenECourts = () => {
    // Copy first for user convenience
    if (cleanCnr) {
      handleCopy();
    }

    const ecourtsUrl = 'https://services.ecourts.gov.in/ecourtindia_v6/';
    try {
      window.open(ecourtsUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.warn('Could not open eCourts in new tab:', err);
      showToast('Please open https://services.ecourts.gov.in/ecourtindia_v6/ in your browser', 'info');
    }
  };

  const handleProceedToManualEntry = () => {
    onClose();
    onEnterDetailsManually(cleanCnr);
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div
        id="cnr-detection-modal-backdrop"
        className="fixed inset-0 z-50 flex items-center justify-center p-3.5 sm:p-4 bg-black/75 backdrop-blur-md overflow-y-auto animate-fadeIn"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onClose();
          }
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 16 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="bg-card border border-border rounded-3xl w-full max-w-lg my-4 overflow-hidden shadow-2xl flex flex-col max-h-[92vh]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* MODAL HEADER */}
          <div className="bg-background-alt border-b border-border px-5 sm:px-6 py-4 flex items-center justify-between sticky top-0 z-20">
            <div className="flex items-center gap-3">
              <SummonsMitraLogo size={36} className="w-9 h-9" />
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">
                    CNR Number Found!
                  </h2>
                  <span className="flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                    Verified QR
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Your summons QR code has been scanned successfully.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              id="close-cnr-popup-btn"
              aria-label="Close CNR information popup"
              className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* MODAL BODY */}
          <div className="p-5 sm:p-6 overflow-y-auto space-y-5">
            {/* 1. CNR NUMBER CARD */}
            <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-b from-primary/10 via-primary/5 to-transparent border-2 border-primary/30 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-primary-text flex items-center gap-1.5">
                  <QrCode className="w-4 h-4 text-primary-text" />
                  YOUR CNR NUMBER
                </span>
                {copied && (
                  <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 animate-fadeIn">
                    <Check className="w-3.5 h-3.5" /> Copied to clipboard!
                  </span>
                )}
              </div>

              {/* Read-Only CNR Display Box */}
              <div className="flex items-center gap-2 bg-background border border-border-strong rounded-xl p-2.5 shadow-inner">
                <input
                  type="text"
                  readOnly
                  value={cleanCnr || 'CNR NOT AVAILABLE'}
                  aria-label="Extracted CNR Number"
                  className="w-full bg-transparent font-mono font-bold text-base sm:text-lg text-foreground tracking-wider focus:outline-none select-all"
                />

                <button
                  type="button"
                  onClick={handleCopy}
                  id="btn-copy-cnr"
                  aria-label="Copy CNR number"
                  title="Copy CNR number to clipboard"
                  className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 active:scale-95 shadow-sm ${
                    copied
                      ? 'bg-emerald-600 text-white shadow-emerald-500/20'
                      : 'bg-primary-btn hover:bg-primary-hover text-white shadow-primary-btn/20'
                  }`}
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>

              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Use this CNR number to find your case details on the official eCourts website. You can then return to Summons Mitra and enter the verified details manually.
              </p>
            </div>

            {/* 2. OFFICIAL eCOURTS WEBSITE SECTION */}
            <div className="p-4 sm:p-5 rounded-2xl bg-card border border-border shadow-sm space-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 shrink-0 mt-0.5">
                  <Landmark className="w-5 h-5" />
                </div>
                <div className="space-y-0.5">
                  <h3 className="text-sm sm:text-base font-bold text-foreground">
                    Find Your Case on eCourts
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Visit the official eCourts website and search using your copied CNR number.
                  </p>
                </div>
              </div>

              {/* Primary eCourts Action Button */}
              <button
                type="button"
                id="btn-open-ecourts-portal"
                onClick={handleOpenECourts}
                className="w-full py-3 px-4 rounded-xl bg-primary-btn hover:bg-primary-hover text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-primary-btn/20 active:scale-[0.98] transition-all cursor-pointer"
              >
                <span>Click to Open eCourts</span>
                <ExternalLink className="w-4 h-4" />
              </button>

              {/* Clickable Official Link */}
              <div className="text-center">
                <a
                  href="https://services.ecourts.gov.in/ecourtindia_v6/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-mono text-primary-text hover:underline break-all"
                >
                  https://services.ecourts.gov.in/ecourtindia_v6/
                </a>
              </div>

              {/* 5-Step Instruction Card */}
              <div className="p-3.5 bg-background-alt border border-border rounded-xl space-y-2">
                <span className="text-[11px] font-bold text-foreground uppercase tracking-wider font-mono block">
                  Quick Step-by-Step Guide:
                </span>
                <ol className="space-y-1.5 text-xs text-muted-foreground list-none">
                  <li className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-primary/15 text-primary-text font-mono font-bold text-[10px] flex items-center justify-center shrink-0">1</span>
                    <span>Copy your CNR number.</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-primary/15 text-primary-text font-mono font-bold text-[10px] flex items-center justify-center shrink-0">2</span>
                    <span>Open the official eCourts website.</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-primary/15 text-primary-text font-mono font-bold text-[10px] flex items-center justify-center shrink-0">3</span>
                    <span>Paste the CNR number into the CNR search field.</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-primary/15 text-primary-text font-mono font-bold text-[10px] flex items-center justify-center shrink-0">4</span>
                    <span>Complete any required verification manually.</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-primary/15 text-primary-text font-mono font-bold text-[10px] flex items-center justify-center shrink-0">5</span>
                    <span>Check your case details and return to Summons Mitra.</span>
                  </li>
                </ol>
              </div>
            </div>

            {/* 3. ENTER DETAILS MANUALLY — CRITICAL SECONDARY NAVIGATION */}
            <div className="p-4 sm:p-5 rounded-2xl bg-muted/40 border border-border space-y-3">
              <div className="flex items-center gap-2 text-foreground">
                <Edit3 className="w-4 h-4 text-primary-text" />
                <span className="text-xs font-bold uppercase tracking-wider font-mono">
                  Ready to Record Verified Details?
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Already checked your case on eCourts? Enter your verified case details in Summons Mitra.
              </p>

              <button
                type="button"
                id="btn-enter-details-manually"
                onClick={handleProceedToManualEntry}
                className="w-full py-3 px-4 rounded-xl bg-card hover:bg-card-hover text-foreground font-bold text-xs sm:text-sm flex items-center justify-center gap-2 border border-border hover:border-primary-text shadow-sm active:scale-[0.98] transition-all cursor-pointer"
              >
                <Edit3 className="w-4 h-4 text-primary-text" />
                <span>Enter Details Manually</span>
                <ArrowRight className="w-4 h-4 text-muted-foreground ml-1" />
              </button>
            </div>
          </div>

          {/* MODAL FOOTER */}
          <div className="bg-background-alt border-t border-border px-5 sm:px-6 py-3.5 flex items-center justify-between text-xs text-muted-foreground sticky bottom-0 z-20">
            <span className="text-[11px] font-mono">SummonsMitra • Judicial CNR Ingestion</span>
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline cursor-pointer"
            >
              Close
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
