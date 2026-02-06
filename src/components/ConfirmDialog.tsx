import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, Info, Trash2, X } from 'lucide-react';

interface ConfirmOptions {
  id: string;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'info';
  resolve: (result: boolean) => void;
}

const variantStyles = {
  danger: {
    icon: Trash2,
    iconBg: 'bg-red-100',
    iconColor: 'text-red-600',
    confirmBtn: 'bg-red-600 hover:bg-red-700 focus:ring-red-500',
  },
  warning: {
    icon: AlertTriangle,
    iconBg: 'bg-yellow-100',
    iconColor: 'text-yellow-600',
    confirmBtn: 'bg-yellow-600 hover:bg-yellow-700 focus:ring-yellow-500',
  },
  info: {
    icon: Info,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    confirmBtn: 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500',
  },
};

function ConfirmDialogItem({ options, onDone }: { options: ConfirmOptions; onDone: (id: string) => void }) {
  const variant = variantStyles[options.variant || 'danger'];
  const Icon = variant.icon;

  const handleConfirm = useCallback(() => {
    options.resolve(true);
    onDone(options.id);
  }, [options, onDone]);

  const handleCancel = useCallback(() => {
    options.resolve(false);
    onDone(options.id);
  }, [options, onDone]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
      if (e.key === 'Enter') handleConfirm();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleCancel, handleConfirm]);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm" onClick={handleCancel} />
      <div className="relative bg-white rounded-xl shadow-2xl max-w-md w-full transform animate-in zoom-in-95 duration-200">
        <button onClick={handleCancel} className="absolute top-3 right-3 p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition">
          <X className="w-5 h-5" />
        </button>
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`${variant.iconBg} p-3 rounded-full flex-shrink-0`}>
              <Icon className={`w-6 h-6 ${variant.iconColor}`} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900">{options.title}</h3>
              <p className="mt-2 text-sm text-gray-600 leading-relaxed">{options.message}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 bg-gray-50 rounded-b-xl border-t border-gray-100">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300 transition"
          >
            {options.cancelLabel || 'Cancel'}
          </button>
          <button
            onClick={handleConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 transition ${variant.confirmBtn}`}
          >
            {options.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialogContainer() {
  const [dialogs, setDialogs] = useState<ConfirmOptions[]>([]);

  useEffect(() => {
    const handleShow = (event: CustomEvent<ConfirmOptions>) => {
      setDialogs(prev => [...prev, event.detail]);
    };
    window.addEventListener('showConfirmDialog' as any, handleShow);
    return () => window.removeEventListener('showConfirmDialog' as any, handleShow);
  }, []);

  const handleDone = useCallback((id: string) => {
    setDialogs(prev => prev.filter(d => d.id !== id));
  }, []);

  if (dialogs.length === 0) return null;

  return (
    <>
      {dialogs.map(dialog => (
        <ConfirmDialogItem key={dialog.id} options={dialog} onDone={handleDone} />
      ))}
    </>
  );
}

export function showConfirm(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'info';
}): Promise<boolean> {
  return new Promise((resolve) => {
    const event = new CustomEvent('showConfirmDialog', {
      detail: {
        ...options,
        id: Math.random().toString(36).substring(7),
        resolve,
      },
    });
    window.dispatchEvent(event);
  });
}
