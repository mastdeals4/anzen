import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  maxWidth?: string;
  maxHeight?: string;
  noPadding?: boolean;
}

export function Modal({ isOpen, onClose, title, subtitle, children, size = 'md', maxWidth, maxHeight, noPadding }: ModalProps) {
  const { t } = useLanguage();

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
  const heightClass = maxHeight || 'max-h-[85vh]';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-3 sm:p-4">
        <div
          className="fixed inset-0 bg-gray-900 bg-opacity-50 transition-opacity"
          onClick={onClose}
        />

        <div
          className={`relative bg-white rounded-xl shadow-2xl ${widthClass} w-full ${heightClass} flex flex-col overflow-hidden`}
        >
          {!noPadding && (
            <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-gray-200 shrink-0 bg-slate-50/50">
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

          <div className={`flex-1 overflow-hidden ${noPadding ? '' : 'p-4 overflow-y-auto'}`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
