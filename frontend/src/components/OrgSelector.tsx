import {
  useState,
  useEffect,
  useRef,
  useId,
  useCallback,
  type KeyboardEvent,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Org {
  /** Unique identifier for the organisation. */
  id: string;
  /** Display name (may differ from id). */
  name: string;
  /** Current number of active assignments for the signed-in contributor. */
  assignmentCount?: number;
}

export interface OrgSelectorProps {
  /** Full list of available organisations. */
  orgs: Org[];
  /** Currently selected org id. */
  value: string | null;
  /** Called when the user picks an org. */
  onChange: (org: Org) => void;
  /** Placeholder text for the search input. */
  placeholder?: string;
  /** Maximum number of recent orgs to store. @default 5 */
  maxRecent?: number;
  /** localStorage key for persisting recent orgs. */
  storageKey?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RECENT = 5;
const DEFAULT_STORAGE_KEY = "wg_recent_orgs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadRecentOrgs(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentOrgs(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // ignore storage quota errors
  }
}

function addRecentOrg(current: string[], id: string, max: number): string[] {
  const without = current.filter((x) => x !== id);
  return [id, ...without].slice(0, max);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Accessible org selector with:
 * - Real-time search filtering by name or id
 * - "Recent" section showing the last `maxRecent` used orgs (localStorage)
 * - Full keyboard navigation: ArrowDown/Up to move, Enter to select, Esc to close
 * - ARIA combobox pattern (role="combobox" + role="listbox")
 * - Mobile: full-screen modal overlay on small viewports
 */
export function OrgSelector({
  orgs,
  value,
  onChange,
  placeholder = "Search orgs…",
  maxRecent = DEFAULT_MAX_RECENT,
  storageKey = DEFAULT_STORAGE_KEY,
}: OrgSelectorProps) {
  const uid = useId();
  const inputId = `${uid}-input`;
  const listboxId = `${uid}-listbox`;

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [recentIds, setRecentIds] = useState<string[]>(() =>
    loadRecentOrgs(storageKey)
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Derive label for the trigger button
  const selectedOrg = orgs.find((o) => o.id === value) ?? null;

  // ── Filtering ────────────────────────────────────────────────────────────

  const q = query.trim().toLowerCase();

  const filteredOrgs = q
    ? orgs.filter(
        (o) =>
          o.name.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q)
      )
    : orgs;

  // Recent orgs that exist in the current orgs list
  const recentOrgs = recentIds
    .map((id) => orgs.find((o) => o.id === id))
    .filter((o): o is Org => o !== undefined);

  // Build the flat option list shown in the dropdown:
  // [recent section items…, all-orgs section items…]
  // When searching, skip the recent section and show filtered results only.
  const showRecent = !q && recentOrgs.length > 0;
  const optionList: Org[] = showRecent
    ? [
        ...recentOrgs,
        ...filteredOrgs.filter((o) => !recentIds.includes(o.id)),
      ]
    : filteredOrgs;

  // Index where "All orgs" section begins (used for section header rendering)
  const allOrgsStartIndex = showRecent ? recentOrgs.length : 0;

  // ── Open / close ─────────────────────────────────────────────────────────

  const openDropdown = useCallback(() => {
    setOpen(true);
    setActiveIndex(-1);
  }, []);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    inputRef.current?.blur();
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        closeDropdown();
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open, closeDropdown]);

  // Focus input when dropdown opens
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
    if (item && typeof item.scrollIntoView === "function") {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  // ── Selection ────────────────────────────────────────────────────────────

  const selectOrg = useCallback(
    (org: Org) => {
      const nextRecent = addRecentOrg(recentIds, org.id, maxRecent);
      setRecentIds(nextRecent);
      saveRecentOrgs(storageKey, nextRecent);
      onChange(org);
      closeDropdown();
    },
    [recentIds, maxRecent, storageKey, onChange, closeDropdown]
  );

  // ── Keyboard navigation ──────────────────────────────────────────────────

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((prev) =>
          prev < optionList.length - 1 ? prev + 1 : 0
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) =>
          prev > 0 ? prev - 1 : optionList.length - 1
        );
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && optionList[activeIndex]) {
          selectOrg(optionList[activeIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        closeDropdown();
        break;
      case "Tab":
        closeDropdown();
        break;
    }
  }

  // ── Option id helper (for aria-activedescendant) ─────────────────────────

  function optionId(index: number) {
    return `${uid}-option-${index}`;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className={`org-selector${open ? " org-selector--open" : ""}`}
      data-testid="org-selector"
    >
      {/* Trigger button */}
      <button
        type="button"
        className="org-selector__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => (open ? closeDropdown() : openDropdown())}
        data-testid="org-selector-trigger"
      >
        <span className="org-selector__trigger-label">
          {selectedOrg ? selectedOrg.name : "Select an organisation"}
        </span>
        <span className="org-selector__trigger-icon" aria-hidden="true">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="org-selector__dropdown"
          role="dialog"
          aria-label="Select organisation"
          data-testid="org-selector-dropdown"
        >
          {/* Search input — combobox */}
          <div className="org-selector__search">
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-activedescendant={
                activeIndex >= 0 ? optionId(activeIndex) : undefined
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(-1);
              }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="org-selector__input"
              data-testid="org-selector-input"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Option list */}
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Organisations"
            className="org-selector__list"
            data-testid="org-selector-list"
          >
            {optionList.length === 0 ? (
              <li
                role="option"
                aria-selected={false}
                className="org-selector__empty"
                data-testid="org-selector-empty"
              >
                No organisations match &ldquo;{query}&rdquo;
              </li>
            ) : (
              optionList.map((org, index) => {
                const isActive = index === activeIndex;
                const isSelected = org.id === value;

                // Section heading: "Recent" before first item, "All orgs"
                // before allOrgsStartIndex (only when there are recent items)
                const showRecentHeader = showRecent && index === 0;
                const showAllOrgsHeader =
                  showRecent && index === allOrgsStartIndex;

                return (
                  <li key={org.id}>
                    {showRecentHeader && (
                      <div
                        className="org-selector__section-header"
                        aria-hidden="true"
                        data-testid="section-recent"
                      >
                        Recent
                      </div>
                    )}
                    {showAllOrgsHeader && (
                      <div
                        className="org-selector__section-header"
                        aria-hidden="true"
                        data-testid="section-all"
                      >
                        All orgs
                      </div>
                    )}
                    <div
                      id={optionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      className={[
                        "org-selector__option",
                        isActive ? "org-selector__option--active" : "",
                        isSelected ? "org-selector__option--selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => selectOrg(org)}
                      onMouseEnter={() => setActiveIndex(index)}
                      data-testid={`org-option-${org.id}`}
                      // Support click via keyboard-driven focus
                      // (keyboard nav uses Enter; mouse click handled above)
                    >
                      <span className="org-selector__option-name">
                        {org.name}
                      </span>
                      {org.assignmentCount !== undefined && (
                        <span
                          className="org-selector__option-count"
                          aria-label={`${org.assignmentCount} of 4 assignments`}
                        >
                          {org.assignmentCount}/4
                        </span>
                      )}
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
