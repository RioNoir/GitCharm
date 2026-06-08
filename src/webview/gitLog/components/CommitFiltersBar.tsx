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
}

export function CommitFiltersBar({ filters, branches, tags, repos, onFilterChange, onRepoChange, onClear, onFetchAll }: Props) {
  const localBranches = branches.filter(b => !b.isRemote);
  const uniqueBranchNames = Array.from(new Set(localBranches.map(b => b.name))).sort();
  const uniqueTagNames = Array.from(new Set(tags.map(t => t.name))).sort();

  const hasFilters = !!(filters.text || filters.author || filters.branch || filters.dateFrom || filters.dateTo || filters.repoId);

  return (
    <div style={styles.bar}>
      {/* Search */}
      <DebouncedInput
        value={filters.text}
        placeholder="Search commits…"
        icon="search"
        onChange={v => onFilterChange('text', v)}
        width={170}
        debounceMs={600}
      />

      {/* Author */}
      <DebouncedInput
        value={filters.author}
        placeholder="Author…"
        icon="person"
        onChange={v => onFilterChange('author', v)}
        width={140}
        debounceMs={600}
      />

      {/* Repo picker — only when multiple repos */}
      {repos.length > 1 && (
        <RepoPicker
          value={filters.repoId}
          repos={repos}
          onChange={onRepoChange}
        />
      )}

      {/* Branch / Tag — custom dropdown */}
      <BranchTagPicker
        value={filters.branch}
        branches={uniqueBranchNames}
        tags={uniqueTagNames}
        onChange={v => onFilterChange('branch', v)}
        width={200}
      />

      {/* Date range */}
      <DateRangePicker
        from={filters.dateFrom}
        to={filters.dateTo}
        onFromChange={v => onFilterChange('dateFrom', v)}
        onToChange={v => onFilterChange('dateTo', v)}
      />

      {hasFilters && (
        <button style={styles.clearBtn} onClick={onClear} title="Clear all filters">
          <Codicon name="close" style={{ fontSize: '11px' }} />
        </button>
      )}

      {/* Fetch All — pushed to the right */}
      <div style={{ flex: 1 }} />
      <button style={styles.fetchBtn} onClick={onFetchAll} title="Fetch all remotes and refresh log">
        <Codicon name="sync" style={{ fontSize: '13px' }} />
        <span>Refresh</span>
      </button>
    </div>
  );
}

/* ─── DebouncedInput ──────────────────────────────────────────────────────── */

function DebouncedInput({ value, placeholder, icon, onChange, width, debounceMs }: {
  value: string;
  placeholder: string;
  icon: string;
  onChange: (v: string) => void;
  width: number;
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
    <div style={{ ...styles.fieldWrap, width }}>
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

/* ─── BranchTagPicker ─────────────────────────────────────────────────────── */

function BranchTagPicker({ value, branches, tags, onChange, width }: {
  value: string;
  branches: string[];
  tags: string[];
  onChange: (v: string) => void;
  width: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const q = query.toLowerCase();
  const displayedBranches = q ? branches.filter(o => o.toLowerCase().includes(q)) : branches;
  const displayedTags = q ? tags.filter(o => o.toLowerCase().includes(q)) : tags;
  const isEmpty = displayedBranches.length === 0 && displayedTags.length === 0;

  const isTag = value ? tags.includes(value) : false;
  const buttonIcon = isTag ? 'tag' : 'git-branch';

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        style={{ ...styles.pickerBtn(!!value), width }}
        onClick={() => setOpen(o => !o)}
        title={value || 'Filter by branch or tag'}
      >
        <Codicon name={buttonIcon} style={styles.fieldIcon} />
        <span style={value ? styles.pickerLabelActive : styles.pickerLabelPlaceholder}>
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
            {displayedBranches.length > 0 && (
              <div style={styles.dropdownGroupLabel}>Branches</div>
            )}
            {displayedBranches.map(name => (
              <div
                key={`b:${name}`}
                style={styles.dropdownItem(value === name)}
                onClick={() => { onChange(name); setOpen(false); }}
              >
                <Codicon name="git-branch" style={{ fontSize: '12px', opacity: 0.55, flexShrink: 0 }} />
                <span style={styles.dropdownItemLabel}>{name}</span>
                {value === name && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, marginLeft: 'auto', flexShrink: 0 }} />}
              </div>
            ))}
            {displayedTags.length > 0 && (
              <div style={styles.dropdownGroupLabel}>Tags</div>
            )}
            {displayedTags.map(name => (
              <div
                key={`t:${name}`}
                style={styles.dropdownItem(value === name)}
                onClick={() => { onChange(name); setOpen(false); }}
              >
                <Codicon name="tag" style={{ fontSize: '12px', opacity: 0.55, flexShrink: 0 }} />
                <span style={styles.dropdownItemLabel}>{name}</span>
                {value === name && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, marginLeft: 'auto', flexShrink: 0 }} />}
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

/* ─── RepoPicker ──────────────────────────────────────────────────────────── */

function RepoPicker({ value, repos, onChange }: {
  value: string | null;
  repos: RepoMeta[];
  onChange: (repoId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, [open]);

  const active = repos.find(r => r.id === value) ?? null;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        style={{ ...styles.pickerBtn(!!value), width: 150 }}
        onClick={() => setOpen(o => !o)}
        title={active?.name ?? 'Filter by repository'}
      >
        {active
          ? <span style={{ ...styles.repoDot, background: active.color }} />
          : <Codicon name="repo" style={styles.fieldIcon} />
        }
        <span style={value ? styles.pickerLabelActive : styles.pickerLabelPlaceholder}>
          {active?.name ?? 'Repository…'}
        </span>
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px', opacity: 0.5, flexShrink: 0 }} />
      </button>

      {open && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownList}>
            <div
              style={styles.dropdownItem(!value)}
              onClick={() => { onChange(null); setOpen(false); }}
            >
              <span style={{ opacity: 0.5, fontSize: '12px' }}>All repositories</span>
              {!value && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, marginLeft: 'auto', flexShrink: 0 }} />}
            </div>
            {repos.map(repo => (
              <div
                key={repo.id}
                style={styles.dropdownItem(value === repo.id)}
                onClick={() => { onChange(repo.id); setOpen(false); }}
              >
                <span style={{ ...styles.repoDot, background: repo.color }} />
                <span style={styles.dropdownItemLabel}>{repo.name}</span>
                {value === repo.id && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, marginLeft: 'auto', flexShrink: 0 }} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── DateRangePicker ─────────────────────────────────────────────────────── */

function DateRangePicker({ from, to, onFromChange, onToChange }: {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  function normalise(raw: string, commit: (v: string) => void) {
    const v = raw.trim();
    if (!v) { commit(''); return; }
    const d = new Date(v);
    if (!isNaN(d.getTime())) commit(d.toISOString().slice(0, 10));
  }

  return (
    <div style={styles.dateRange}>
      <Codicon name="calendar" style={styles.fieldIcon} />
      <input
        style={styles.dateInput}
        type="text"
        placeholder="From YYYY-MM-DD"
        value={from}
        onChange={e => onFromChange(e.target.value)}
        onBlur={e => normalise(e.target.value, onFromChange)}
        onKeyDown={e => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.currentTarget.value.trim())) onFromChange(''); }}
        maxLength={10}
      />
      <span style={styles.dateSep}>→</span>
      <input
        style={styles.dateInput}
        type="text"
        placeholder="To YYYY-MM-DD"
        value={to}
        onChange={e => onToChange(e.target.value)}
        onBlur={e => normalise(e.target.value, onToChange)}
        onKeyDown={e => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.currentTarget.value.trim())) onToChange(''); }}
        maxLength={10}
      />
      {(from || to) && (
        <button style={styles.fieldClear} onClick={() => { onFromChange(''); onToChange(''); }} tabIndex={-1}>
          <Codicon name="close" style={{ fontSize: '10px' }} />
        </button>
      )}
    </div>
  );
}

/* ─── Styles ──────────────────────────────────────────────────────────────── */

const styles = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    gap: '6px',
    padding: '6px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
    flexShrink: 0,
  },
  fieldWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
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
  pickerBtn: (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    height: '26px',
    padding: '0 8px',
    background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'var(--vscode-input-background)',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
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
    color: 'var(--vscode-input-placeholderForeground, #6b7280)',
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    marginTop: '2px',
    zIndex: 200,
    background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    minWidth: '200px',
    maxWidth: '300px',
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
    fontStyle: 'italic',
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
  dateRange: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    padding: '0 6px',
    height: '26px',
    boxSizing: 'border-box' as const,
  },
  dateInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    width: '108px',
    padding: 0,
  } as React.CSSProperties,
  dateSep: {
    fontSize: '11px',
    opacity: 0.35,
    userSelect: 'none' as const,
    padding: '0 2px',
  },
  repoDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  } as React.CSSProperties,
  clearBtn: {
    height: '26px',
    padding: '0 7px',
    background: 'transparent',
    color: 'var(--vscode-errorForeground)',
    border: '1px solid var(--vscode-errorForeground)',
    borderRadius: '4px',
    cursor: 'pointer',
    opacity: 0.8,
    display: 'flex',
    alignItems: 'center',
  } as React.CSSProperties,
  fetchBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    height: '26px',
    padding: '0 10px',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  } as React.CSSProperties,
};
