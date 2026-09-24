'use client';

import { useState, useEffect } from 'react';

type IssueStatus = 'open' | 'assigned' | 'completed' | 'applied';

export type Issue = {
  id: string;
  title: string;
  org: string;
  status: IssueStatus;
  reward?: number;
  /**
   * Unix timestamp (seconds) when the contributor's application TTL expires.
   * Only meaningful when status === 'applied'.
   */
  expiryTimestamp?: number;
  /**
   * Callback to extend TTL via the `extend_application_ttl` contract function.
   * Returns true on success.
   */
  onExtendTTL?: (issueId: string) => Promise<boolean>;
};

type IssueCardProps = {
  issue: Issue;
  onApply?: (issueId: string) => void;
};

type IssueCardGridProps = {
  issues: Issue[];
  onApply?: (issueId: string) => void;
};

const STATUS_STYLES: Record<IssueStatus, string> = {
  open: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  applied: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  assigned: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  completed: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
};

// ---------------------------------------------------------------------------
// TTL countdown helpers
// ---------------------------------------------------------------------------

/** 24 hours in seconds — amber warning threshold */
const TTL_WARN_SECONDS = 24 * 60 * 60;
/** 1 hour in seconds — red critical threshold */
const TTL_CRIT_SECONDS = 60 * 60;

function formatTTL(remainingSeconds: number): string {
  if (remainingSeconds <= 0) return 'Expired';
  const d = Math.floor(remainingSeconds / 86400);
  const h = Math.floor((remainingSeconds % 86400) / 3600);
  const m = Math.floor((remainingSeconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type TTLState = 'ok' | 'warn' | 'crit' | 'expired';

function getTTLState(remaining: number): TTLState {
  if (remaining <= 0) return 'expired';
  if (remaining <= TTL_CRIT_SECONDS) return 'crit';
  if (remaining <= TTL_WARN_SECONDS) return 'warn';
  return 'ok';
}

const TTL_COLOR: Record<TTLState, string> = {
  ok:      'color: var(--color-complete, #22c55e)',
  warn:    'color: #f59e0b',   // amber-500
  crit:    'color: #dc2626',   // red-600
  expired: 'color: #6b7280',   // gray-500
};

// ---------------------------------------------------------------------------
// TTLCountdown sub-component
// ---------------------------------------------------------------------------

/**
 * Displays a live TTL countdown and an "Extend TTL" button.
 * Timer updates every minute (60 000 ms) per the issue spec.
 * Color changes: amber at < 24 h, red at < 1 h.
 */
function TTLCountdown({
  expiryTimestamp,
  issueId,
  issueTitle,
  onExtendTTL,
}: {
  expiryTimestamp: number;
  issueId: string;
  issueTitle: string;
  onExtendTTL?: (issueId: string) => Promise<boolean>;
}) {
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [extending, setExtending] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Update every 60 seconds
  useEffect(() => {
    const id = setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const remaining = Math.max(0, expiryTimestamp - nowSeconds);
  const state = getTTLState(remaining);
  const canExtend = state === 'warn' || state === 'crit';

  async function handleExtend() {
    if (!onExtendTTL || extending) return;
    setExtending(true);
    setStatusMsg(null);
    try {
      const ok = await onExtendTTL(issueId);
      setStatusMsg(ok ? 'TTL extended ✓' : 'Extension failed');
    } catch {
      setStatusMsg('Error extending TTL');
    } finally {
      setExtending(false);
    }
  }

  return (
    <div
      className="issue-card__ttl"
      style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span
          className="issue-card__ttl-label"
          style={{ fontSize: '0.75rem', color: 'var(--color-muted, #a8b5c8)' }}
        >
          Expires in:
        </span>
        <span
          data-testid="ttl-countdown"
          data-ttl-state={state}
          style={{
            fontSize: '0.8125rem',
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            ...(Object.fromEntries([[
              'color',
              state === 'ok' ? 'var(--color-complete, #22c55e)'
                : state === 'warn' ? '#f59e0b'
                : state === 'crit' ? '#dc2626'
                : '#6b7280',
            ]])),
          }}
          aria-label={`Application expires in ${formatTTL(remaining)}`}
          aria-live="polite"
        >
          {formatTTL(remaining)}
        </span>

        {onExtendTTL && (
          <button
            type="button"
            data-testid="extend-ttl-btn"
            onClick={handleExtend}
            disabled={!canExtend || extending || state === 'expired'}
            aria-label={`Extend TTL for: ${issueTitle}`}
            style={{
              fontSize: '0.75rem',
              padding: '2px 8px',
              borderRadius: '4px',
              border: 'none',
              cursor: canExtend && !extending ? 'pointer' : 'not-allowed',
              opacity: canExtend && !extending ? 1 : 0.45,
              background: canExtend ? '#f59e0b' : 'var(--color-border, #2e3347)',
              color: canExtend ? '#fff' : 'var(--color-muted, #a8b5c8)',
              fontWeight: 600,
              minHeight: '28px',
            }}
          >
            {extending ? 'Extending…' : 'Extend TTL'}
          </button>
        )}
      </div>

      {statusMsg && (
        <span
          role="status"
          style={{
            fontSize: '0.75rem',
            color: statusMsg.includes('✓') ? 'var(--color-complete, #22c55e)' : '#dc2626',
          }}
        >
          {statusMsg}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IssueCard
// ---------------------------------------------------------------------------

/**
 * Individual issue card.
 * The "Apply" button meets WCAG 2.5.5 minimum touch target of 44×44 px.
 * When status === 'applied' and expiryTimestamp is provided, a TTL countdown
 * is displayed with an optional Extend TTL button (closes #553).
 */
function IssueCard({ issue, onApply }: IssueCardProps) {
  return (
    <article
      data-testid="issue-card"
      className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm transition-shadow hover:shadow-md"
    >
      {/* Header: org + status badge */}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-[var(--color-text-secondary)]">
          {issue.org}
        </span>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
            STATUS_STYLES[issue.status]
          }`}
        >
          {issue.status}
        </span>
      </div>

      {/* Title */}
      <h3 className="text-sm font-semibold leading-snug text-[var(--color-text-primary)]">
        {issue.title}
      </h3>

      {/* TTL countdown — only for applied issues with an expiry */}
      {issue.status === 'applied' && issue.expiryTimestamp != null && (
        <TTLCountdown
          expiryTimestamp={issue.expiryTimestamp}
          issueId={issue.id}
          issueTitle={issue.title}
          onExtendTTL={issue.onExtendTTL}
        />
      )}

      {/* Footer: reward + action */}
      <div className="mt-auto flex items-center justify-between gap-2">
        {issue.reward != null && (
          <span className="text-sm font-medium text-brand-600 dark:text-brand-500">
            {issue.reward} XLM
          </span>
        )}

        {issue.status === 'open' && onApply && (
          <button
            type="button"
            onClick={() => onApply(issue.id)}
            aria-label={`Apply for: ${issue.title}`}
            className="touch-target ml-auto rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 active:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600"
          >
            Apply
          </button>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// IssueCardGrid
// ---------------------------------------------------------------------------

/**
 * Responsive grid of issue cards.
 *
 * Breakpoints (per issue #318):
 *  - Default (< 640px):  1 column
 *  - sm (640px+):        2 columns
 *  - lg (1024px+):       3 columns
 */
export default function IssueCardGrid({ issues, onApply }: IssueCardGridProps) {
  return (
    <div
      data-testid="issue-card-grid"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {issues.map((issue) => (
        <IssueCard key={issue.id} issue={issue} onApply={onApply} />
      ))}
    </div>
  );
}

