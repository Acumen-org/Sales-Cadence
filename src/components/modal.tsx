'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

/** Native modal semantics give every overlay focus containment, Escape and focus restoration. */
export function Modal({ children, label, onClose, className }: { children: ReactNode; label: string; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog ref={ref} aria-label={label} className={clsx('cadence-modal', className)} onCancel={(e) => { e.preventDefault(); onCloseRef.current(); }} onClick={(e) => { if (e.target === e.currentTarget) onCloseRef.current(); }}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </dialog>,
    document.body,
  );
}
