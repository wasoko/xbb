import React from 'react';
import { useEffect } from 'react';
import { Outlet, useRouteError, isRouteErrorResponse, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { noticeStore, logStoreSlice, type NoticePayload } from './notice';

// ---------------------------------------------------------------------------
// Rolling localStorage store (max 111 entries, newest first)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Notification: dispatch to background script
// ---------------------------------------------------------------------------
const notify = (scope: string, message: string, level: NoticePayload['level'] = 'error') => {
  if (level === 'error') {
    logStoreSlice(new Error(`${scope}: ${message}`));
  }
  noticeStore({ scope, message, level }, {});
};

// ---------------------------------------------------------------------------
// ErrorFallback – rendered by the error boundary, replaces the router screen
// ---------------------------------------------------------------------------
function ErrorFallback() {
  const error = useRouteError();
  const navigate = useNavigate();

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
    ? error.message
    : 'Unknown error';

  useEffect(() => {
    notify('Fallback issue', message);
  }, [error, message]);

  return null;
}

// ---------------------------------------------------------------------------
// ErrorBoundaryOutlet – drop-in replacement for <Outlet /> with error handling
// ---------------------------------------------------------------------------
export function ErrorBoundaryOutlet() {
  return <Outlet />;
}
// Attach as the route's errorElement so React Router calls it on throw
ErrorBoundaryOutlet.errorElement = <ErrorFallback />;

// This creates an isolated "pocket" where errors can't escape to the parent
export function LocalErrorBoundary({ children }: { children: React.ReactNode }) {
  // We use a local state-based boundary for component-level isolation
  return ( <ErrorBoundaryInner> {children} </ErrorBoundaryInner> );
}

// Minimal Class Component for the actual catch (React requirement)
class ErrorBoundaryInner extends React.Component<{children: React.ReactNode}, {hasError: boolean, copied: boolean}> {
  state = { hasError: false, copied: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: any) {
    notify('Component issue', error.message || 'An internal error occurred');
  }
  render() {
    if (this.state.hasError) {
      const isCopied = this.state.copied;
      return (
        <div className="p-4 text-xs opacity-50">
          Component crashed.{' '}
          <span 
            className={`${isCopied ? 'cursor-default' : 'cursor-pointer text-blue-500 underline hover:text-blue-600'}`} 
            onClick={() => {
              if (isCopied) return;
              const logsStr = localStorage.getItem('error_logs');
              const logs = logsStr ? JSON.parse(logsStr) : [];
              const lastLog = logs[0] ? JSON.stringify(logs[0], null, 2) : 'No logs found';
              navigator.clipboard.writeText(lastLog);
              this.setState({ copied: true });
            }}
          >
            {isCopied ? ' Copied..' : ' Copy Details to Clipboard'}
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}