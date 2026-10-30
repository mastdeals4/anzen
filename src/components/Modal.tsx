import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  maxWidth?: string;
  maxHeight?: string;
  noPadding?: boolean;
}

export function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  maxWidth,
  maxHeight,
  noPadding,
}: ModalProps) {
  const { t } = useLanguage();
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevIsOpenRef = useRef(false);

  // Scroll reset effect: runs ONLY when modal transitions from closed (false) to open (true).
  // It will NOT reset scrollTop on parent re-renders or onClose reference changes.
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  // Escape key handler
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
  };

  const widthClass = maxWidth || sizeClasses[size];
  const heightClass = maxHeight || 'max-h-[88vh] sm:max-h-[85vh]';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 overflow-hidden">
      <div
        className="fixed inset-0 bg-gray-900 bg-opacity-50 transition-opacity backdrop-blur-2xs"
        onClick={onClose}
      />

      <div
        className={`relative bg-white rounded-xl shadow-2xl ${widthClass} w-full ${heightClass} flex flex-col min-h-0 overflow-hidden z-10 my-auto`}
      >
        {!noPadding && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0 bg-slate-50/90 backdrop-blur-xs z-10">
            <div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">{title}</h3>
              {subtitle && <div className="text-xs text-gray-500 font-normal mt-0.5">{subtitle}</div>}
            </div>
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="p-1 rounded-lg hover:bg-gray-200/60 text-gray-500 hover:text-gray-700 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div
          ref={bodyRef}
          className={`flex-1 min-h-0 ${noPadding ? 'overflow-hidden' : 'p-4 sm:p-5 overflow-y-auto'}`}
        >
          {children}
        </div>

        {footer && (
          <div className="px-4 py-3 border-t border-gray-200 shrink-0 bg-gray-50/90 backdrop-blur-xs flex items-center justify-end gap-3 z-10">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
