'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
}

type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/**
 * One dialog instance for the whole dashboard, driven by a promise: a caller
 * writes `if (!(await confirm({...}))) return;` instead of threading open/close
 * state through every destructive action.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('confirm');
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>((next) => {
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  function settle(value: boolean) {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setRequest(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={request !== null} onOpenChange={(open) => !open && settle(false)}>
        {request ? (
          <AlertDialogContent>
            <AlertDialogTitle>{request.title}</AlertDialogTitle>
            {request.description ? (
              <AlertDialogDescription>{request.description}</AlertDialogDescription>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialogCancel asChild>
                <Button variant="outline" onClick={() => settle(false)}>
                  {t('cancel')}
                </Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button onClick={() => settle(true)}>{request.confirmLabel ?? t('confirm')}</Button>
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmProvider');
  return confirm;
}
