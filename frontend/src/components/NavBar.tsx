import { useState, useRef, useEffect } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface NavBarProps {
  walletAddress?: string | null;
  walletError?: string | null;
  networkMismatch?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export function NavBar({ walletAddress, walletError, networkMismatch, onConnect, onDisconnect }: NavBarProps) {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  const showInstallPrompt = !walletAddress && walletError && /install/i.test(walletError);
  const expectedNet = (import.meta.env.VITE_STELLAR_NETWORK ?? "TESTNET").toUpperCase();

  // Activate focus trap while drawer is open
  useFocusTrap(drawerRef, open);

  // Close drawer on Escape key
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <nav className="navbar" role="navigation" aria-label="Main navigation">
      <a className="navbar__brand" href="#/" aria-label="WorkloadGovernor home">
        <span aria-hidden="true">⚙</span> WorkloadGovernor
      </a>

      {/* Hamburger — visible on mobile (< 768px) */}
      <button
        className="navbar__hamburger"
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open}
        aria-controls="navbar-drawer"
        data-testid="hamburger-button"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="hamburger-bar" />
        <span className="hamburger-bar" />
        <span className="hamburger-bar" />
      </button>

      {/* Desktop inline menu — hidden on mobile */}
      <div
        id="navbar-menu"
        className="navbar__menu"
      >
        <a className="navbar__link" href="#/activity">
          Activity
        </a>

        <div className="navbar__wallet">
          {networkMismatch && walletAddress && (
            <div className="navbar__network-warning" role="alert">
              Wrong network — switch to {expectedNet} in Freighter
            </div>
          )}
          {walletAddress ? (
            <>
              <span
                className="navbar__address"
                title={walletAddress}
                aria-label={`Connected wallet: ${walletAddress}`}
              >
                {`${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={onDisconnect}
                aria-label="Disconnect wallet"
              >
                Disconnect
              </button>
            </>
          ) : showInstallPrompt ? (
            <a
              href="https://www.freighter.app"
              target="_blank"
              rel="noreferrer"
              className="navbar__install-link"
            >
              Install Freighter
            </a>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={onConnect}
              aria-label="Connect wallet"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>

      {/* Backdrop — only rendered on mobile when drawer is open */}
      {open && (
        <div
          className="navbar__backdrop"
          data-testid="drawer-backdrop"
          aria-hidden="true"
          onClick={close}
        />
      )}

      {/* Slide-out drawer — mobile navigation */}
      <div
        id="navbar-drawer"
        ref={drawerRef}
        className={`navbar__drawer${open ? " navbar__drawer--open" : ""}`}
        data-testid="mobile-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <a className="navbar__link" href="#/activity" onClick={close}>
          Activity
        </a>

        <div className="navbar__wallet">
          {networkMismatch && walletAddress && (
            <div className="navbar__network-warning" role="alert">
              Wrong network — switch to {expectedNet} in Freighter
            </div>
          )}
          {walletAddress ? (
            <>
              <span
                className="navbar__address"
                title={walletAddress}
                aria-label={`Connected wallet: ${walletAddress}`}
              >
                {`${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => { onDisconnect?.(); close(); }}
                aria-label="Disconnect wallet"
              >
                Disconnect
              </button>
            </>
          ) : showInstallPrompt ? (
            <a
              href="https://www.freighter.app"
              target="_blank"
              rel="noreferrer"
              className="navbar__install-link"
              onClick={close}
            >
              Install Freighter
            </a>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { onConnect?.(); close(); }}
              aria-label="Connect wallet"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
