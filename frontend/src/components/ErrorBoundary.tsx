import React, { Component, ErrorInfo, ReactNode } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ErrorPayload {
  message: string;
  stack?: string;
  componentStack?: string;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback element */
  fallback?: ReactNode;
  /**
   * A value whose identity is compared on each render.
   * When it changes the boundary resets automatically —
   * used to reset on navigation (pass the current route / hash).
   */
  resetKey?: string | number;
  /** Called after the boundary resets */
  onReset?: () => void;
  /** Base URL prepended to /api/errors (defaults to '') */
  apiBase?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
  errorId?: string;
}

// ── ErrorBoundary ─────────────────────────────────────────────────────────────

/**
 * React class-based error boundary.
 *
 * Catches errors thrown in any descendant, renders a fallback UI with a
 * "Retry" button, logs the error to POST /api/errors, and resets automatically
 * when `resetKey` changes (navigation).
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  static displayName = "ErrorBoundary";

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const errorId = `ERR-${Date.now().toString(36).toUpperCase()}`;
    this.setState({ errorInfo, errorId });
    this.logError({
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack ?? undefined,
    });
  }

  /** Auto-reset when navigation key changes */
  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.hasError &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.reset();
    }
  }

  private logError(payload: ErrorPayload): void {
    const base = this.props.apiBase ?? "";
    fetch(`${base}/api/errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Never throw from an error boundary
    });
  }

  private reset(): void {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined, errorId: undefined });
    this.props.onReset?.();
  }

  handleRetry(): void {
    this.reset();
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="error-state"
      >
        <img
          src="/illustrations/error-server.svg"
          alt=""
          aria-hidden="true"
          className="error-state__illustration"
        />
        <h2 className="error-state__title">Something went wrong</h2>
        <p className="error-state__message">
          An unexpected error occurred. Please try again, or report the issue if
          the problem persists.
        </p>
        {this.state.errorId && (
          <p className="error-state__code" aria-label={`Support reference: ${this.state.errorId}`}>
            {this.state.errorId}
          </p>
        )}
        <div className="error-state__actions">
          <button
            type="button"
            onClick={this.handleRetry}
            aria-label="Try again"
            className="btn btn-primary"
          >
            Try again
          </button>
          <a
            href="https://github.com/FaveTeamz/workload-governor/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
          >
            Report issue
          </a>
        </div>
      </div>
    );
  }
}
