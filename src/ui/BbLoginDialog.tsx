/**
 * BbLoginDialog.tsx — the webapp's Bilibili QR login.
 *
 * The dialog asks `cors_bb` for a QR code, polls it, and records the returned
 * cookie (or the function's server-session flag) through `bbProxyInstall`. It is
 * mounted at the app root, outside the feed preview, because the preview closes
 * when the pointer leaves it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { renderSVG } from 'uqr';
import { BB_SIGNIN_HINT } from '../bb';
import { bbProxyPoll, bbProxyQr } from '../bbProxyInstall';
import { signinGoogle } from '../greet';
import { closeBbLogin, completeBbLogin, useBbLoginOpen } from './bbLogin';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'waiting'; url: string; key: string }
  | { kind: 'scanned'; url: string; key: string }
  | { kind: 'expired'; url: string; key: string }
  | { kind: 'error'; message: string };

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 120,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)',
};

const PANEL: React.CSSProperties = {
  width: 'min(360px, 92vw)', maxHeight: '90vh', overflow: 'auto',
  padding: 16, borderRadius: 14, color: 'white', fontSize: 13,
  background: 'rgba(18,20,26,0.98)',
  border: '1px solid rgba(255,255,255,0.18)',
  boxShadow: '0 18px 50px rgba(0,0,0,0.55)',
};

const HEAD: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 8, marginBottom: 10,
};

const HINT: React.CSSProperties = {
  minHeight: 32, opacity: 0.78, lineHeight: 1.45, wordBreak: 'break-word',
};

const QR: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 10, marginTop: 10, borderRadius: 10, background: '#fff',
};

const BUTTON: React.CSSProperties = {
  padding: '4px 10px', fontSize: 12, borderRadius: 5, cursor: 'pointer',
  background: 'rgba(255,255,255,0.08)', color: 'inherit',
  border: '1px solid rgba(255,255,255,0.3)',
};

const CLOSE: React.CSSProperties = {
  ...BUTTON, padding: '0 7px', fontSize: 17, lineHeight: '24px',
};

/** A thrown value as display text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The root-mounted QR dialog.
 *
 * @returns the dialog while open, otherwise null
 */
export function BbLoginDialog() {
  const open = useBbLoginOpen();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const run = useRef(0);
  const started = useRef(false);

  const start = useCallback(async () => {
    const id = ++run.current;
    setPhase({ kind: 'loading' });
    try {
      const qr = await bbProxyQr();
      if (run.current !== id) return;
      setPhase({ kind: 'waiting', url: qr.url, key: qr.key });
    } catch (error) {
      if (run.current !== id) return;
      setPhase({ kind: 'error', message: messageOf(error) });
    }
  }, []);

  useEffect(() => {
    if (!open) {
      started.current = false;
      run.current += 1;
      setPhase({ kind: 'idle' });
      return;
    }
    if (started.current) return;
    started.current = true;
    void start();
  }, [open, start]);

  const qrKey = phase.kind === 'waiting' || phase.kind === 'scanned' ? phase.key : '';
  const qrUrl = phase.kind === 'waiting' || phase.kind === 'scanned' ? phase.url : '';

  useEffect(() => {
    if (!open || qrKey === '') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const poll = await bbProxyPoll(qrKey);
        if (stopped) return;
        if (poll.dataCode === 0) {
          toast.success('bilibili logged in');
          completeBbLogin();
          return;
        }
        if (poll.dataCode === 86_038) {
          setPhase({ kind: 'expired', url: qrUrl, key: qrKey });
          return;
        }
        if (poll.dataCode === 86_090) setPhase({ kind: 'scanned', url: qrUrl, key: qrKey });
        else setPhase({ kind: 'waiting', url: qrUrl, key: qrKey });
        timer = setTimeout(tick, 2000);
      } catch (error) {
        if (stopped) return;
        setPhase({ kind: 'error', message: messageOf(error) });
      }
    };
    timer = setTimeout(tick, 1500);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [open, qrKey, qrUrl]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeBbLogin();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const status = phase.kind === 'loading'
    ? 'requesting a QR code…'
    : phase.kind === 'waiting'
      ? 'scan with the Bilibili mobile app'
      : phase.kind === 'scanned'
        ? 'scanned — confirm on your phone'
        : phase.kind === 'expired'
          ? 'QR code expired'
          : phase.kind === 'error' ? phase.message : '';
  const signIn = phase.kind === 'error' && phase.message.includes(BB_SIGNIN_HINT);
  const retry = phase.kind === 'expired' || (phase.kind === 'error' && !signIn);
  const signInWebapp = async () => {
    try {
      const [, error] = await signinGoogle();
      if (error) toast.error(error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  const svg = useMemo(() => {
    if (qrUrl === '') return '';
    try {
      return renderSVG(qrUrl, { ecc: 'M', border: 2, pixelSize: 5 });
    } catch {
      return '';
    }
  }, [qrUrl]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      style={OVERLAY}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeBbLogin();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bilibili login"
        style={PANEL}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={HEAD}>
          <strong>Bilibili login</strong>
          <button type="button" style={CLOSE} aria-label="Close" onClick={closeBbLogin}>×</button>
        </div>
        <div style={HINT}>{status}</div>
        {svg !== '' && (
          <div
            role="img"
            aria-label="Bilibili login QR code"
            style={QR}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          {retry && (
            <button type="button" style={BUTTON} onClick={() => void start()}>new QR</button>
          )}
          {signIn && (
            <button type="button" style={BUTTON} onClick={() => void signInWebapp()}>sign in</button>
          )}
          <button type="button" style={BUTTON} onClick={closeBbLogin}>close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
