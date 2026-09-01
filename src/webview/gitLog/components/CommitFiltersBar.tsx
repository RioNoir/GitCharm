import React, { useState, useRef, useEffect } from 'react';
import type { CommitFilters } from '../store/logStore';
import type { BranchInfo, RepoMeta, TagInfo } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';

interface Props {
  filters: CommitFilters;
  branches: BranchInfo[];
  tags: TagInfo[];
  repos: RepoMeta[];
  onFilterChange: (key: keyof CommitFilters, value: string) => void;
  onRepoChange: (repoId: string | null) => void;
  onClear: () => void;
  onFetchAll: () => void;
  onUndock?: (target: 'editorTab' | 'newWindow' | 'pick') => void;
  /** When true, hides the Undock menu item (already in undocked mode). */
  hideUndock?: boolean;
  /** Opens the picker that persists where the Git Log opens by default. */
  onSetDefaultLocation?: () => void;
}

function useIsLightTheme() {
  const [light, setLight] = useState(() => document.body.classList.contains('vscode-light'));
  useEffect(() => {
    const obs = new MutationObserver(() => setLight(document.body.classList.contains('vscode-light')));
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return light;
}

export function CommitFiltersBar({ filters, branches, tags, repos, onFilterChange, onRepoChange, onClear, onFetchAll, onUndock, hideUndock, onSetDefaultLocation }: Props) {
  const isLight = useIsLightTheme();
  useEffect(() => {
    const id = 'gitcharm-filter-field-focus';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `[data-filter-field]:focus-within { border-color: var(--vscode-focusBorder) !important; outline: none; }`;
    document.head.appendChild(s);
  }, []);
  const groupedBranches = groupByName(branches);
  const groupedTags = groupByName(tags);

  const hasFilters = !!(filters.text || filters.author || filters.branch || filters.dateFrom || filters.dateTo);

  useEffect(() => {
    if (repos.length <= 1) return;

    function onKeyDown(event: KeyboardEvent) {
      if (!(event.altKey && (event.ctrlKey || event.metaKey))) return;

      let nextRepoId: string | null | undefined;
      if (event.key === '0') {
        nextRepoId = null;
      } else if (/^[1-9]$/.test(event.key)) {
        nextRepoId = repos[Number(event.key) - 1]?.id;
      } else if (event.key === '[' || event.key === ']') {
        const currentIndex = filters.repoId
          ? repos.findIndex(repo => repo.id === filters.repoId)
          : -1;
        const options: Array<string | null> = [null, ...repos.map(repo => repo.id)];
        const optionIndex = currentIndex + 1;
        const delta = event.key === '[' ? -1 : 1;
        nextRepoId = options[(optionIndex + delta + options.length) % options.length];
      }

      if (nextRepoId === undefined || nextRepoId === filters.repoId) return;
      event.preventDefault();
      onRepoChange(nextRepoId);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filters.repoId, onRepoChange, repos]);

  return (
    <div style={styles.bar}>
        {/* Search */}
        <DebouncedInput
          value={filters.text}
          placeholder="Search commits…"
          icon="search"
          onChange={v => onFilterChange('text', v)}
          debounceMs={600}
        />

        {/* Author */}
        <DebouncedInput
          value={filters.author}
          placeholder="Author…"
          icon="person"
          onChange={v => onFilterChange('author', v)}
          debounceMs={600}
        />

        {/* Branch / Tag — custom dropdown */}
        <BranchTagPicker
          value={filters.branch}
          branches={groupedBranches}
          tags={groupedTags}
          repos={repos}
          onChange={v => onFilterChange('branch', v)}
          isLight={isLight}
        />

        {/* Date range */}
        <DateRangePicker
          from={filters.dateFrom}
          to={filters.dateTo}
          isLight={isLight}
          onFromChange={v => onFilterChange('dateFrom', v)}
          onToChange={v => onFilterChange('dateTo', v)}
        />

        {hasFilters && (
          <button data-top-action-btn="" style={styles.clearBtn} onClick={onClear} title="Clear all filters">
            <Codicon name="clear-all" style={{ fontSize: '15px' }} />
          </button>
        )}

        {/* More menu — pushed to the right */}
        <MoreMenu onFetchAll={onFetchAll} onUndock={onUndock} hideUndock={hideUndock} onSetDefaultLocation={onSetDefaultLocation} />
      </div>
  );
}

/* ─── MoreMenu ────────────────────────────────────────────────────────────── */

function MoreMenu({ onFetchAll, onUndock, hideUndock, onSetDefaultLocation }: {
  onFetchAll: () => void;
  onUndock?: (target: 'editorTab' | 'newWindow' | 'pick') => void;
  hideUndock?: boolean;
  onSetDefaultLocation?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    const onBlur = () => setOpen(false);
    if (open) {
      document.addEventListener('mousedown', onOut);
      window.addEventListener('blur', onBlur);
    }
    return () => {
      document.removeEventListener('mousedown', onOut);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0, marginLeft: 'auto' }}>
      <button
        data-top-action-btn=""
        style={styles.moreBtn}
        onClick={() => setOpen(o => !o)}
        title="More actions"
      >
        <Codicon name="three-bars" style={{ fontSize: '14px' }} />
      </button>
      {open && (
        <div style={styles.moreDropdown}>
          <div
            style={styles.moreItem}
            onClick={() => { onFetchAll(); setOpen(false); }}
          >
            <Codicon name="sync" style={{ fontSize: '13px', opacity: 0.7 }} />
            <span>Fetch and Refresh</span>
          </div>

          {(!hideUndock || onSetDefaultLocation) && <div style={styles.moreSeparator} />}

          {!hideUndock && (
            <div
              style={styles.moreItem}
              onClick={() => { onUndock?.('pick'); setOpen(false); }}
              title="Move the Git Log for this session only"
            >
              <Codicon name="multiple-windows" style={{ fontSize: '13px', opacity: 0.7 }} />
              <span>Undock…</span>
            </div>
          )}

          {onSetDefaultLocation && (
            <div
              style={styles.moreItem}
              onClick={() => { onSetDefaultLocation(); setOpen(false); }}
              title="Remember where the Git Log opens from now on"
            >
              <Codicon name="settings-gear" style={{ fontSize: '13px', opacity: 0.7 }} />
              <span>Default Location…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── DebouncedInput ──────────────────────────────────────────────────────── */

function DebouncedInput({ value, placeholder, icon, onChange, width, maxWidth, debounceMs }: {
  value: string;
  placeholder: string;
  icon: string;
  onChange: (v: string) => void;
  width?: number;
  maxWidth?: number;
  debounceMs: number;
}) {
  // Local display value so typing feels instant; fires onChange after debounce
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local in sync when external value changes (e.g. clear)
  useEffect(() => { setLocal(value); }, [value]);

  function handleChange(v: string) {
    setLocal(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(v), debounceMs);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { handleChange(''); e.currentTarget.blur(); }
    if (e.key === 'Enter' && !local.trim()) { handleChange(''); }
  }

  return (
    <div data-filter-field="" style={{ ...styles.fieldWrap, ...(width ? { width } : { flex: 1, minWidth: 160 }) }}>
      <Codicon name={icon} style={styles.fieldIcon} />
      <input
        style={styles.fieldInput}
        type="text"
        placeholder={placeholder}
        value={local}
        onChange={e => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {local && (
        <button style={styles.fieldClear} onClick={() => handleChange('')} tabIndex={-1}>
          <Codicon name="close" style={{ fontSize: '10px' }} />
        </button>
      )}
    </div>
  );
}

interface NamedRef {
  name: string;
  repoIds: string[];
  isRemote?: boolean;
}

function groupByName(items: Array<{ name: string; repoId: string; isRemote?: boolean }>): NamedRef[] {
  const map = new Map<string, NamedRef>();
  for (const item of items) {
    const existing = map.get(item.name);
    if (existing) {
      if (!existing.repoIds.includes(item.repoId)) existing.repoIds.push(item.repoId);
    } else {
      map.set(item.name, { name: item.name, repoIds: [item.repoId], isRemote: item.isRemote });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/* ─── BranchTagPicker ─────────────────────────────────────────────────────── */

function BranchTagPicker({ value, branches, tags, repos, onChange, width, isLight }: {
  value: string;
  branches: NamedRef[];
  tags: NamedRef[];
  repos: RepoMeta[];
  onChange: (v: string) => void;
  width?: number;
  isLight: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const repoColorMap = Object.fromEntries(repos.map(r => [r.id, r.color]));
  const multiRepo = repos.length > 1;

  const q = query.toLowerCase();
  const displayedBranches = q ? branches.filter(o => o.name.toLowerCase().includes(q)) : branches;
  const displayedTags = q ? tags.filter(o => o.name.toLowerCase().includes(q)) : tags;
  const displayedLocalBranches = displayedBranches.filter(b => !b.isRemote);
  const displayedRemoteBranches = displayedBranches.filter(b => b.isRemote);
  const isEmpty = displayedBranches.length === 0 && displayedTags.length === 0;

  const isTag = value ? tags.some(t => t.name === value) : false;
  const buttonIcon = isTag ? 'tag' : 'git-branch';

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    const onBlur = () => setOpen(false);
    if (open) {
      document.addEventListener('mousedown', onOut);
      window.addEventListener('blur', onBlur);
    }
    return () => {
      document.removeEventListener('mousedown', onOut);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...(width ? { width } : { flex: 1, minWidth: 160 }) }}>
      <button
        style={{ ...styles.pickerBtn(!!value, open), width: '100%' }}
        onClick={() => setOpen(o => !o)}
        title={value || 'Filter by branch or tag'}
      >
        <Codicon name={buttonIcon} style={styles.fieldIcon} />
        <span style={value ? styles.pickerLabelActive : { ...styles.pickerLabelPlaceholder, opacity: isLight ? 0.8 : 0.4 }}>
          {value || 'Branch / Tag…'}
        </span>
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px', opacity: 0.5, flexShrink: 0 }} />
      </button>

      {open && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownSearch}>
            <Codicon name="search" style={{ fontSize: '11px', opacity: 0.5, flexShrink: 0 }} />
            <input
              autoFocus
              style={styles.dropdownInput}
              placeholder="Filter…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
            />
          </div>
          <div style={styles.dropdownList}>
            <div
              style={styles.dropdownItem(!value)}
              onClick={() => { onChange(''); setOpen(false); }}
            >
              <span style={{ opacity: 0.5, fontSize: '12px' }}>All branches & tags</span>
            </div>
            {displayedLocalBranches.length > 0 && (
              <div style={styles.dropdownGroupLabel}>Local Branches</div>
            )}
            {displayedLocalBranches.map(({ name, repoIds, isRemote }) => (
              <div
                key={`b:${name}`}
                style={styles.dropdownItem(value === name)}
                onClick={() => { onChange(name); setOpen(false); }}
              >
                <Codicon name={isRemote ? 'cloud' : 'git-branch'} style={{ fontSize: '12px', opacity: 0.55, flexShrink: 0 }} />
                <span style={styles.dropdownItemLabel}>{name}</span>
                {multiRepo && (
                  <span style={styles.dotGroup}>
                    {repoIds.map(id => (
                      <span key={id} style={styles.repoDotSmall(repoColorMap[id] ?? '#888')} />
                    ))}
                  </span>
                )}
                {value === name && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, flexShrink: 0 }} />}
              </div>
            ))}
            {displayedRemoteBranches.length > 0 && (
              <div style={styles.dropdownGroupLabel}>Remote Branches</div>
            )}
            {displayedRemoteBranches.map(({ name, repoIds, isRemote }) => (
              <div
                key={`b:${name}`}
                style={styles.dropdownItem(value === name)}
                onClick={() => { onChange(name); setOpen(false); }}
              >
                <Codicon name={isRemote ? 'cloud' : 'git-branch'} style={{ fontSize: '12px', opacity: 0.55, flexShrink: 0 }} />
                <span style={styles.dropdownItemLabel}>{name}</span>
                {multiRepo && (
                  <span style={styles.dotGroup}>
                    {repoIds.map(id => (
                      <span key={id} style={styles.repoDotSmall(repoColorMap[id] ?? '#888')} />
                    ))}
                  </span>
                )}
                {value === name && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, flexShrink: 0 }} />}
              </div>
            ))}
            {displayedTags.length > 0 && (
              <div style={styles.dropdownGroupLabel}>Tags</div>
            )}
            {displayedTags.map(({ name, repoIds }) => (
              <div
                key={`t:${name}`}
                style={styles.dropdownItem(value === name)}
                onClick={() => { onChange(name); setOpen(false); }}
              >
                <Codicon name="tag" style={{ fontSize: '12px', opacity: 0.55, flexShrink: 0 }} />
                <span style={styles.dropdownItemLabel}>{name}</span>
                {multiRepo && (
                  <span style={styles.dotGroup}>
                    {repoIds.map(id => (
                      <span key={id} style={styles.repoDotSmall(repoColorMap[id] ?? '#888')} />
                    ))}
                  </span>
                )}
                {value === name && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, flexShrink: 0 }} />}
              </div>
            ))}
            {isEmpty && (
              <div style={styles.dropdownEmpty}>No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── RepoTabs ────────────────────────────────────────────────────────────── */

export function RepoTabs({ value, repos, onChange }: {
  value: string | null;
  repos: RepoMeta[];
  onChange: (repoId: string | null) => void;
}) {
  if (repos.length <= 1) return null;

  return (
    <div style={styles.repoTabs} role="tablist" aria-label="Repositories">
      <button
        type="button"
        role="tab"
        aria-selected={value === null}
        style={styles.repoTab(value === null)}
        onClick={() => onChange(null)}
        title="All repositories (Ctrl/Cmd+Alt+0)"
      >
        <Codicon name="repo" style={{ fontSize: '12px', opacity: 0.65 }} />
        <span>All</span>
      </button>

      {repos.map((repo, index) => (
        <button
          key={repo.id}
          type="button"
          role="tab"
          aria-selected={value === repo.id}
          style={styles.repoTab(value === repo.id)}
          onClick={() => onChange(repo.id)}
          title={`${repo.name}${index < 9 ? ` (Ctrl/Cmd+Alt+${index + 1})` : ''}`}
        >
          <span style={{ ...styles.repoDot, background: repo.color }} />
          <span style={styles.repoTabLabel}>{repo.name}</span>
        </button>
      ))}
    </div>
  );
}

/* ─── DateRangePicker ─────────────────────────────────────────────────────── */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseYMD(s: string): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function CalendarMonth({ year, month, from, to, hovered, onDay, onHover }: {
  year: number; month: number;
  from: Date | null; to: Date | null; hovered: Date | null;
  onDay: (d: Date) => void;
  onHover: (d: Date | null) => void;
}) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const rangeEnd = hovered ?? to;

  return (
    <div style={calStyles.month}>
      <div style={calStyles.monthTitle}>{MONTHS[month]} {year}</div>
      <div style={calStyles.grid}>
        {DAYS.map(d => <div key={d} style={calStyles.dayHeader}>{d}</div>)}
        {cells.map((date, i) => {
          if (!date) return <div key={`e${i}`} />;
          const ymd = toYMD(date);
          const isFrom = from ? toYMD(from) === ymd : false;
          const isTo = to ? toYMD(to) === ymd : false;
          const isHovered = hovered ? toYMD(hovered) === ymd : false;
          const lo = from && rangeEnd ? (from <= rangeEnd ? from : rangeEnd) : null;
          const hi = from && rangeEnd ? (from <= rangeEnd ? rangeEnd : from) : null;
          const inRange = lo && hi ? date > lo && date < hi : false;
          const isEdge = isFrom || isTo || isHovered;
          return (
            <div
              key={ymd}
              style={calStyles.day(isEdge, inRange, isFrom || (isHovered && !from))}
              onClick={() => onDay(date)}
              onMouseEnter={() => onHover(date)}
              onMouseLeave={() => onHover(null)}
            >
              {date.getDate()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DateRangePicker({ from, to, isLight, onFromChange, onToChange }: {
  from: string; to: string;
  isLight: boolean;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<Date | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const today = new Date();
  const fromDate = parseYMD(from);
  const toDate = parseYMD(to);

  // Show left calendar around "from" date, right around "to" or next month
  const initLeft = fromDate ?? new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const initRight = toDate ?? new Date(today.getFullYear(), today.getMonth(), 1);
  const [leftYM, setLeftYM] = useState({ y: initLeft.getFullYear(), m: initLeft.getMonth() });
  const [rightYM, setRightYM] = useState({ y: initRight.getFullYear(), m: initRight.getMonth() });

  // Close on outside click or window blur
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    document.addEventListener('mousedown', handler);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  function handleDay(date: Date) {
    const ymd = toYMD(date);
    if (!from || (from && to)) {
      // Start new selection
      onFromChange(ymd);
      onToChange('');
    } else {
      // Complete selection — ensure from <= to
      const f = parseYMD(from)!;
      if (date < f) { onFromChange(ymd); onToChange(from); }
      else { onToChange(ymd); }
      setOpen(false);
    }
  }

  function navLeft(dir: -1 | 1) {
    setLeftYM(p => {
      let m = p.m + dir, y = p.y;
      if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
      return { y, m };
    });
  }
  function navRight(dir: -1 | 1) {
    setRightYM(p => {
      let m = p.m + dir, y = p.y;
      if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
      return { y, m };
    });
  }

  const hasRange = !!(from || to);
  const label = from && to ? `${from}  →  ${to}` : from ? `${from}  →  …` : null;

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minWidth: 160 }}>
      <button style={{ ...styles.pickerBtn(hasRange, open), width: '100%' }} onClick={() => setOpen(o => !o)}>
        <Codicon name="calendar" style={{ fontSize: '13px', opacity: 0.6, flexShrink: 0 }} />
        {label
          ? <span style={styles.pickerLabelActive}>{label}</span>
          : <span style={{ ...styles.pickerLabelPlaceholder, opacity: isLight ? 0.8 : 0.4 }}>From → To</span>}
        {hasRange && (
          <span
            style={{ ...styles.fieldClear, marginLeft: 2 }}
            onClick={e => { e.stopPropagation(); onFromChange(''); onToChange(''); }}
          >
            <Codicon name="close" style={{ fontSize: '10px' }} />
          </span>
        )}
      </button>

      {open && (
        <div style={calStyles.popup}>
          {/* Left calendar */}
          <div style={calStyles.calCol}>
            <div style={calStyles.navRow}>
              <button style={calStyles.navBtn} onClick={() => navLeft(-1)}><Codicon name="chevron-left" style={{ fontSize: '12px' }} /></button>
              <span style={calStyles.navLabel}>{MONTHS[leftYM.m]} {leftYM.y}</span>
              <button style={calStyles.navBtn} onClick={() => navLeft(1)}><Codicon name="chevron-right" style={{ fontSize: '12px' }} /></button>
            </div>
            <CalendarMonth year={leftYM.y} month={leftYM.m} from={fromDate} to={toDate} hovered={hovered} onDay={handleDay} onHover={setHovered} />
          </div>

          <div style={calStyles.divider} />

          {/* Right calendar */}
          <div style={calStyles.calCol}>
            <div style={calStyles.navRow}>
              <button style={calStyles.navBtn} onClick={() => navRight(-1)}><Codicon name="chevron-left" style={{ fontSize: '12px' }} /></button>
              <span style={calStyles.navLabel}>{MONTHS[rightYM.m]} {rightYM.y}</span>
              <button style={calStyles.navBtn} onClick={() => navRight(1)}><Codicon name="chevron-right" style={{ fontSize: '12px' }} /></button>
            </div>
            <CalendarMonth year={rightYM.y} month={rightYM.m} from={fromDate} to={toDate} hovered={hovered} onDay={handleDay} onHover={setHovered} />
          </div>
        </div>
      )}
    </div>
  );
}

const calStyles = {
  popup: {
    position: 'absolute' as const,
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 300,
    background: 'var(--vscode-dropdown-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,0.35)))',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    display: 'flex',
    flexDirection: 'row' as const,
    gap: '0',
    padding: '10px',
  },
  calCol: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    minWidth: '168px',
  },
  divider: {
    width: '1px',
    background: 'var(--vscode-panel-border)',
    margin: '0 10px',
    alignSelf: 'stretch',
  },
  navRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '2px',
  },
  navBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: 0.6,
    padding: '2px 4px',
    display: 'flex',
    alignItems: 'center',
    borderRadius: '3px',
  } as React.CSSProperties,
  navLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  month: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  monthTitle: { display: 'none' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '1px',
  },
  dayHeader: {
    fontSize: '10px',
    textAlign: 'center' as const,
    opacity: 0.4,
    color: 'var(--vscode-foreground)',
    padding: '2px 0',
    fontWeight: 600,
  },
  day: (isEdge: boolean, inRange: boolean, isStart: boolean): React.CSSProperties => ({
    fontSize: '11px',
    textAlign: 'center',
    padding: '3px 1px',
    borderRadius: '3px',
    cursor: 'pointer',
    userSelect: 'none',
    background: isEdge
      ? 'var(--vscode-list-activeSelectionBackground)'
      : inRange
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : 'transparent',
    color: isEdge
      ? 'var(--vscode-list-activeSelectionForeground)'
      : 'var(--vscode-foreground)',
    fontWeight: isEdge ? 700 : 'normal',
    opacity: 1,
  }),
};

/* ─── Styles ──────────────────────────────────────────────────────────────── */

const styles = {
  repoTabs: {
    display: 'flex',
    gap: '2px',
    overflowX: 'auto' as const,
    overflowY: 'hidden' as const,
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
    flexShrink: 0,
  },
  repoTab: (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    maxWidth: '180px',
    padding: active ? '5px 12px' : '5px 10px',
    background: 'transparent',
    border: 'none',
    borderBottom: active
      ? '2px solid var(--vscode-focusBorder)'
      : '2px solid transparent',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
    fontWeight: active ? 600 : 400,
    whiteSpace: 'nowrap',
    opacity: active ? 1 : 0.6,
    color: 'var(--vscode-foreground)',
    flexShrink: 0,
    transition: 'opacity 0.1s, border-color 0.1s',
  }),
  repoTabLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    gap: '6px',
    padding: '6px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
    flexShrink: 0,
  },
  fieldWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, rgba(128,128,128,0.35))',
    borderRadius: '4px',
    padding: '0 6px',
    height: '26px',
    boxSizing: 'border-box' as const,
  },
  fieldIcon: {
    fontSize: '13px',
    opacity: 0.45,
    flexShrink: 0,
    lineHeight: 1,
  } as React.CSSProperties,
  fieldInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    flex: 1,
    minWidth: 0,
    padding: 0,
  } as React.CSSProperties,
  fieldClear: {
    background: 'transparent',
    border: 'none',
    padding: '1px',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: 0.4,
    display: 'flex',
    alignItems: 'center',
    lineHeight: 1,
    flexShrink: 0,
  } as React.CSSProperties,
  pickerBtn: (active: boolean, open = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    height: '26px',
    padding: '0 8px',
    background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'var(--vscode-input-background)',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-input-foreground)',
    border: `1px solid ${open ? 'var(--vscode-focusBorder)' : 'var(--vscode-input-border, rgba(128,128,128,0.35))'}`,
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 'normal',
    boxSizing: 'border-box',
  }),
  pickerLabelActive: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    color: 'var(--vscode-input-foreground)',
  },
  pickerLabelPlaceholder: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    fontWeight: 100,
    color: 'var(--vscode-input-foreground)',
    opacity: 0.4,
    textAlign: 'left' as const,
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    marginTop: '2px',
    zIndex: 200,
    background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,0.35)))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    width: '100%',
    boxSizing: 'border-box' as const,
    overflow: 'hidden',
  },
  dropdownSearch: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '5px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  dropdownInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    flex: 1,
    padding: 0,
  } as React.CSSProperties,
  dropdownList: {
    overflowY: 'auto' as const,
    maxHeight: '200px',
    padding: '3px 0',
  },
  dropdownItem: (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: '12px',
    background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
  }),
  dropdownItemLabel: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  dropdownEmpty: {
    padding: '6px 10px',
    fontSize: '11px',
    opacity: 0.5,
    color: 'var(--vscode-foreground)',
  },
  dropdownGroupLabel: {
    padding: '4px 10px 2px',
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    opacity: 0.45,
    color: 'var(--vscode-foreground)',
  },
  repoDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  } as React.CSSProperties,
  repoDotSmall: (color: string): React.CSSProperties => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  dotGroup: {
    display: 'flex',
    gap: '2px',
    alignItems: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  clearBtn: {
    height: '26px',
    width: '26px',
    padding: '0',
    background: 'transparent',
    color: 'var(--vscode-errorForeground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    opacity: 0.8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  moreBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    background: 'none',
    color: 'var(--vscode-foreground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    flexShrink: 0,
    opacity: 0.7,
  } as React.CSSProperties,
  moreDropdown: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    marginTop: '2px',
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    padding: '3px 0',
    minWidth: '140px',
    zIndex: 1000,
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
  } as React.CSSProperties,
  moreItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground, var(--vscode-foreground))',
    whiteSpace: 'nowrap' as const,
    position: 'relative' as const,
  } as React.CSSProperties,
  moreSeparator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground, var(--vscode-panel-border))',
    margin: '3px 0',
  } as React.CSSProperties,
};
