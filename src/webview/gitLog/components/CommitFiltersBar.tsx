import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { CommitFilters } from '../store/logStore';
import type { CompareRange } from '../../../host/types/messages';
import type { BranchInfo, RepoMeta, TagInfo } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';
import * as l10n from '@vscode/l10n';
import { dateLocale } from '../../shared/l10n';
import { isImeComposing } from '../../shared/ime';
import { ensureScrollbarHideStyle } from '../../shared/ScrollArea';
import { RepoDots, type RepoDotInfo } from '../../shared/RepoDots';

interface Props {
  filters: CommitFilters;
  branches: BranchInfo[];
  tags: TagInfo[];
  repos: RepoMeta[];
  onFilterChange: (key: keyof CommitFilters, value: string) => void;
  onCompareChange: (compare: CompareRange | null) => void;
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

export function CommitFiltersBar({ filters, branches, tags, repos, onFilterChange, onCompareChange }: Props) {
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
  const reposInView = filters.repoId ? repos.filter(r => r.id === filters.repoId) : repos;


  return (
    <div style={styles.bar}>
        {/* Search */}
        <DebouncedInput
          value={filters.text}
          placeholder={l10n.t('Search commits…')}
          icon="search"
          onChange={v => onFilterChange('text', v)}
          debounceMs={600}
        />

        {/* Author */}
        <DebouncedInput
          value={filters.author}
          placeholder={l10n.t('Author…')}
          icon="person"
          onChange={v => onFilterChange('author', v)}
          debounceMs={600}
        />

        {/* Branch / Tag — or, in compare mode, target "not in" base */}
        {filters.compare ? (
          <CompareControls
            compare={filters.compare}
            branches={groupedBranches}
            tags={groupedTags}
            repos={repos}
            reposInView={reposInView}
            isLight={isLight}
            onChange={onCompareChange}
          />
        ) : (
          <BranchTagPicker
            value={filters.branch}
            branches={groupedBranches}
            tags={groupedTags}
            repos={repos}
            onChange={v => onFilterChange('branch', v)}
            isLight={isLight}
          />
        )}

        {/* Date range */}
        <DateRangePicker
          from={filters.dateFrom}
          to={filters.dateTo}
          isLight={isLight}
          onFromChange={v => onFilterChange('dateFrom', v)}
          onToChange={v => onFilterChange('dateTo', v)}
        />
      </div>
  );
}

/* ─── Compare labels ──────────────────────────────────────────────────────── */

/**
 * Display names for a compare range. `defaultName` is the default branch shared by every
 * repo in view, or null when the repos disagree or none report one — the host still
 * resolves each repo's own default, this only affects what the labels say.
 */
export function compareLabels(compare: CompareRange, repos: RepoMeta[]): { target: string; base: string; defaultName: string | null } {
  const names = new Set(repos.map(r => r.defaultBranch ?? ''));
  const defaultName = names.size === 1 && !names.has('') ? [...names][0] : null;
  return {
    target: compare.target || 'HEAD',
    base: compare.base || defaultName || l10n.t('the default branch'),
    defaultName,
  };
}

/* ─── DebouncedInput ──────────────────────────────────────────────────────── */

function DebouncedInput({ value, placeholder, icon, onChange, width, maxWidth: _maxWidth, debounceMs }: {
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
    if (isImeComposing(e)) return;
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

/* ─── CompareControls ─────────────────────────────────────────────────────── */

function CompareControls({ compare, branches, tags, repos, reposInView, isLight, onChange }: {
  compare: CompareRange;
  branches: NamedRef[];
  tags: NamedRef[];
  repos: RepoMeta[];
  reposInView: RepoMeta[];
  isLight: boolean;
  onChange: (compare: CompareRange) => void;
}) {
  const { defaultName } = compareLabels(compare, reposInView);
  const baseDefaultLabel = defaultName ? l10n.t('Default branch ({0})', defaultName) : l10n.t('Default branch');
  return (
    <div style={styles.compareGroup}>
      <BranchTagPicker
        value={compare.target}
        branches={branches}
        tags={tags}
        repos={repos}
        onChange={target => onChange({ ...compare, target })}
        isLight={isLight}
        allLabel={l10n.t('HEAD (current branch)')}
        placeholder="HEAD"
        titleText={l10n.t('Show commits on this branch')}
      />
      <NotInIcon title={l10n.t('not in')} />
      <BranchTagPicker
        value={compare.base}
        branches={branches}
        tags={tags}
        repos={repos}
        onChange={base => onChange({ ...compare, base })}
        isLight={isLight}
        allLabel={baseDefaultLabel}
        placeholder={baseDefaultLabel}
        titleText={l10n.t('…that aren\'t on this branch')}
      />
    </div>
  );
}

/** Codicons has no "not in" glyph: its arrow-right path with a slash through the shaft (↛), same 16px grid. */
function NotInIcon({ title }: { title: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={styles.compareSeparator} role="img" aria-label={title}>
      <title>{title}</title>
      <path d="M13.854 8.14576L8.854 3.14576C8.659 2.95076 8.342 2.95076 8.147 3.14576C7.952 3.34076 7.952 3.65776 8.147 3.85276L12.293 7.99876H2.5C2.224 7.99876 2 8.22276 2 8.49876C2 8.77476 2.224 8.99876 2.5 8.99876H12.293L8.147 13.1448C7.952 13.3398 7.952 13.6568 8.147 13.8518C8.245 13.9498 8.373 13.9978 8.501 13.9978C8.629 13.9978 8.757 13.9488 8.855 13.8518L13.855 8.85176C14.05 8.65676 14.05 8.33976 13.855 8.14476L13.854 8.14576Z" />
      <path d="M4.5 12L7.5 5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/* ─── BranchTagPicker ─────────────────────────────────────────────────────── */

function BranchTagPicker({ value, branches, tags, repos, onChange, width, isLight, allLabel = l10n.t('All branches & tags'), placeholder = l10n.t('Branch / Tag…'), titleText = l10n.t('Filter by branch or tag') }: {
  value: string;
  branches: NamedRef[];
  tags: NamedRef[];
  repos: RepoMeta[];
  onChange: (v: string) => void;
  width?: number;
  isLight: boolean;
  allLabel?: string;
  placeholder?: string;
  titleText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const repoMap: Record<string, RepoDotInfo> = Object.fromEntries(repos.map(r => [r.id, { name: r.name, color: r.color }]));
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
        title={value || titleText}
      >
        <Codicon name={buttonIcon} style={styles.fieldIcon} />
        <span style={value ? styles.pickerLabelActive : { ...styles.pickerLabelPlaceholder, opacity: isLight ? 0.8 : 0.4 }}>
          {value || placeholder}
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
              placeholder={l10n.t('Filter…')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (isImeComposing(e)) return; if (e.key === 'Escape') setOpen(false); }}
            />
          </div>
          <div style={styles.dropdownList}>
            <div
              style={styles.dropdownItem(!value)}
              onClick={() => { onChange(''); setOpen(false); }}
            >
              <span style={{ opacity: 0.5, fontSize: '12px' }}>{allLabel}</span>
            </div>
            {displayedLocalBranches.length > 0 && (
              <div style={styles.dropdownGroupLabel}>{l10n.t('Local Branches')}</div>
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
                  <RepoDots repoIds={repoIds} repos={repoMap} />
                )}
                {value === name && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, flexShrink: 0 }} />}
              </div>
            ))}
            {displayedRemoteBranches.length > 0 && (
              <div style={styles.dropdownGroupLabel}>{l10n.t('Remote Branches')}</div>
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
                  <RepoDots repoIds={repoIds} repos={repoMap} />
                )}
                {value === name && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, flexShrink: 0 }} />}
              </div>
            ))}
            {displayedTags.length > 0 && (
              <div style={styles.dropdownGroupLabel}>{l10n.t('Tags')}</div>
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
                  <RepoDots repoIds={repoIds} repos={repoMap} />
                )}
                {value === name && <Codicon name="check" style={{ fontSize: '11px', opacity: 0.8, flexShrink: 0 }} />}
              </div>
            ))}
            {isEmpty && (
              <div style={styles.dropdownEmpty}>{l10n.t('No matches')}</div>
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
  // Ctrl/Cmd+Alt+0…9 and [ / ] switch tab — kept here so they work even with the filters bar hidden.
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
        const currentIndex = value
          ? repos.findIndex(repo => repo.id === value)
          : -1;
        const options: Array<string | null> = [null, ...repos.map(repo => repo.id)];
        const optionIndex = currentIndex + 1;
        const delta = event.key === '[' ? -1 : 1;
        nextRepoId = options[(optionIndex + delta + options.length) % options.length];
      }

      if (nextRepoId === undefined || nextRepoId === value) return;
      event.preventDefault();
      onChange(nextRepoId);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [value, onChange, repos]);

  // With many repos (submodules) the tabs overflow. A mouse wheel only scrolls vertically,
  // which this strip can't, so turn it into horizontal scrolling — as VS Code's editor tabs
  // do. Native listener: React's wheel handlers are passive and can't preventDefault.
  const tabsRef = useRef<HTMLDivElement>(null);
  const hasTabs = repos.length > 1;
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      if (!el || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [hasTabs]);

  // The store hands over a new `repos` array on every LOG_INIT_DATA — each page of commits,
  // each ref change — even when the repos are the same. Key on their ids instead, or the
  // effects below re-run mid-scroll and snap the strip back to the selected tab.
  const repoIdsKey = repos.map(repo => repo.id).join('\n');

  // Keep the selected tab in view, e.g. after picking it with a shortcut or from the sidebar.
  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value, repoIdsKey]);

  const thumb = useHorizontalThumb(tabsRef, hasTabs, repoIdsKey);

  if (!hasTabs) return null;

  return (
    <div style={styles.repoTabsWrap}>
      <div ref={tabsRef} className="gitcharm-scroll-viewport" style={styles.repoTabs} role="tablist" aria-label={l10n.t('Repositories')}>
        <button
          type="button"
          role="tab"
          aria-selected={value === null}
          style={styles.repoTab(value === null)}
          onClick={() => onChange(null)}
          title={l10n.t('All repositories ({0})', 'Ctrl/Cmd+Alt+0')}
        >
          <Codicon name="repo" style={{ fontSize: '12px', opacity: 0.65 }} />
          <span>{l10n.t({ message: 'All', comment: ['Repository tab: show commits of all repositories'] })}</span>
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
      {thumb.width > 0 && (
        <div style={styles.repoTabsTrack} onMouseDown={thumb.onTrackMouseDown}>
          <div
            style={styles.repoTabsThumb(thumb.left, thumb.width, thumb.dragging, thumb.hovered)}
            onMouseDown={thumb.onThumbMouseDown}
            onMouseEnter={() => thumb.setHovered(true)}
            onMouseLeave={() => thumb.setHovered(false)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A horizontal scrollbar for the repo tab strip that is always visible while the tabs
 * overflow, and draggable. The native one is hidden: in a webview it only shows up as a
 * faint line on hover, too thin to grab, so with many repos the tabs past the edge were
 * reachable only with a trackpad or the wheel.
 */
function useHorizontalThumb(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean, contentKey: unknown) {
  const [geometry, setGeometry] = useState({ left: 0, width: 0 });
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) { setGeometry({ left: 0, width: 0 }); return; }
    const width = Math.max(Math.round(el.clientWidth / el.scrollWidth * el.clientWidth), 24);
    const left = Math.round(el.scrollLeft / (el.scrollWidth - el.clientWidth) * (el.clientWidth - width));
    setGeometry(prev => (prev.left === left && prev.width === width ? prev : { left, width }));
  }, [ref]);

  useEffect(() => {
    ensureScrollbarHideStyle();
    const el = ref.current;
    if (!enabled || !el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Resizing the panel or the tabs' own width (a repo added, a tab turning bold) both change the overflow.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    Array.from(el.children).forEach(child => observer.observe(child));
    return () => { el.removeEventListener('scroll', update); observer.disconnect(); };
  }, [ref, enabled, update, contentKey]);

  const onThumbMouseDown = useCallback((event: React.MouseEvent) => {
    const el = ref.current;
    if (!el || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startScroll = el.scrollLeft;
    const thumbWidth = Math.max(Math.round(el.clientWidth / el.scrollWidth * el.clientWidth), 24);
    // Pixels of scroll per pixel of thumb travel.
    const ratio = (el.scrollWidth - el.clientWidth) / Math.max(1, el.clientWidth - thumbWidth);
    setDragging(true);
    function onMove(e: MouseEvent) { if (el) el.scrollLeft = startScroll + (e.clientX - startX) * ratio; }
    function onUp() {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [ref]);

  // A click on the track beside the thumb pages toward it, like a native scrollbar.
  const onTrackMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || event.button !== 0) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const direction = x < geometry.left ? -1 : 1;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' });
  }, [ref, geometry.left]);

  return { ...geometry, dragging, hovered, setHovered, onThumbMouseDown, onTrackMouseDown };
}

/* ─── DateRangePicker ─────────────────────────────────────────────────────── */

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat(dateLocale, { month: 'short', year: 'numeric' }).format(new Date(year, month, 1));
}

/** First weekday of the calendar grid as a Date#getDay() index (Monday for it-IT/en-GB, Sunday for en-US). */
function weekStartDay(): number {
  try {
    const loc = new Intl.Locale(dateLocale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay; // 1 = Monday … 7 = Sunday
    return firstDay ? firstDay % 7 : 0;
  } catch {
    return 0;
  }
}

/** Short weekday names in grid order, starting from weekStartDay(). */
function weekdayLabels(start: number): string[] {
  const fmt = new Intl.DateTimeFormat(dateLocale, { weekday: 'short' });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + start + i)));
}

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
  const weekStart = weekStartDay();
  const leadingBlanks = (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const rangeEnd = hovered ?? to;

  return (
    <div style={calStyles.month}>
      <div style={calStyles.monthTitle}>{monthLabel(year, month)}</div>
      <div style={calStyles.grid}>
        {weekdayLabels(weekStart).map((d, i) => <div key={i} style={calStyles.dayHeader}>{d}</div>)}
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
          : <span style={{ ...styles.pickerLabelPlaceholder, opacity: isLight ? 0.8 : 0.4 }}>{l10n.t('From → To')}</span>}
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
              <span style={calStyles.navLabel}>{monthLabel(leftYM.y, leftYM.m)}</span>
              <button style={calStyles.navBtn} onClick={() => navLeft(1)}><Codicon name="chevron-right" style={{ fontSize: '12px' }} /></button>
            </div>
            <CalendarMonth year={leftYM.y} month={leftYM.m} from={fromDate} to={toDate} hovered={hovered} onDay={handleDay} onHover={setHovered} />
          </div>

          <div style={calStyles.divider} />

          {/* Right calendar */}
          <div style={calStyles.calCol}>
            <div style={calStyles.navRow}>
              <button style={calStyles.navBtn} onClick={() => navRight(-1)}><Codicon name="chevron-left" style={{ fontSize: '12px' }} /></button>
              <span style={calStyles.navLabel}>{monthLabel(rightYM.y, rightYM.m)}</span>
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
  day: (isEdge: boolean, inRange: boolean, _isStart: boolean): React.CSSProperties => ({
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
  repoTabsWrap: {
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
    flexShrink: 0,
  },
  repoTabs: {
    display: 'flex',
    gap: '2px',
    overflowX: 'auto' as const,
    overflowY: 'hidden' as const,
    // The native scrollbar is hidden in favor of the always-visible track below
    scrollbarWidth: 'none' as const,
  },
  repoTabsTrack: {
    position: 'relative' as const,
    height: '6px',
  },
  repoTabsThumb: (left: number, width: number, dragging: boolean, hovered: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `${left}px`,
    width: `${width}px`,
    background: dragging
      ? 'var(--vscode-scrollbarSlider-activeBackground)'
      : hovered
        ? 'var(--vscode-scrollbarSlider-hoverBackground)'
        : 'var(--vscode-scrollbarSlider-background)',
  }),
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
  compareGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flex: 2,
    minWidth: 400,
  } as React.CSSProperties,
  compareSeparator: {
    opacity: 0.6,
    flexShrink: 0,
  } as React.CSSProperties,
};
