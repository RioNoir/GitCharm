import React, { useRef, useState, useEffect, useCallback } from 'react';

interface Props {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * Overlay scrollbar matching VS Code's monaco-scrollable-element style.
 * The native scrollbar is hidden; a custom thumb is rendered in absolute
 * position over the content and fades out when idle.
 */
export function ScrollArea({ children, style, className, onScroll, onClick, scrollRef }: Props) {
  const internalRef = useRef<HTMLDivElement>(null);
  const viewportRef = (scrollRef as React.RefObject<HTMLDivElement>) ?? internalRef;
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbHeight, setThumbHeight] = useState(0);
  const [thumbTop, setThumbTop] = useState(0);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStart = useRef<{ mouseY: number; scrollTop: number } | null>(null);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 1000);
  }, []);

  const updateThumb = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) { setThumbHeight(0); return; }
    const ratio = clientHeight / scrollHeight;
    const height = Math.max(Math.round(ratio * clientHeight), 20);
    const top = Math.round((scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height));
    setThumbHeight(height);
    setThumbTop(top);
  }, [viewportRef]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    updateThumb();
    setVisible(true);
    scheduleHide();
    onScroll?.(e);
  }, [updateThumb, scheduleHide, onScroll]);

  // Update thumb on resize or content change
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    updateThumb();
    const ro = new ResizeObserver(() => updateThumb());
    ro.observe(el);
    // Also observe children size changes
    const mo = new MutationObserver(() => updateThumb());
    mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: false });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [viewportRef, updateThumb]);

  // Drag logic
  const onThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = viewportRef.current;
    if (!el) return;
    dragStart.current = { mouseY: e.clientY, scrollTop: el.scrollTop };
    setActive(true);
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStart.current || !el) return;
      const { scrollHeight, clientHeight } = el;
      const trackHeight = clientHeight - thumbHeight;
      const delta = ev.clientY - dragStart.current.mouseY;
      const scrollDelta = (delta / trackHeight) * (scrollHeight - clientHeight);
      el.scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, dragStart.current.scrollTop + scrollDelta));
    };
    const onMouseUp = () => {
      dragStart.current = null;
      setActive(false);
      scheduleHide();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [viewportRef, thumbHeight, scheduleHide]);

  // Click on track (above/below thumb) scrolls by page
  const onTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // ignore clicks on thumb
    const el = viewportRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    if (clickY < thumbTop) el.scrollBy({ top: -el.clientHeight, behavior: 'smooth' });
    else el.scrollBy({ top: el.clientHeight, behavior: 'smooth' });
  }, [viewportRef, thumbTop]);

  const showScrollbar = thumbHeight > 0 && visible;

  return (
    <div style={{ position: 'relative', overflow: 'hidden', ...style }} className={className} onClick={onClick}>
      {/* Native-scrollbar-hidden viewport */}
      <div
        ref={viewportRef}
        onScroll={handleScroll}
        style={{
          position: 'absolute', inset: 0,
          overflowY: 'scroll', overflowX: 'hidden',
          // Push native scrollbar off-screen; paddingRight matches track width so content fills to the track edge
          marginRight: '-20px', paddingRight: '8px',
          boxSizing: 'content-box',
        }}
      >
        {children}
      </div>

      {/* Custom overlay scrollbar track */}
      <div
        onClick={onTrackClick}
        style={{
          position: 'absolute', right: 0, top: 0, bottom: 0,
          width: '6px',
          background: 'var(--vscode-scrollbar-background, transparent)',
          zIndex: 11,
          opacity: showScrollbar ? 1 : 0,
          transition: showScrollbar ? 'opacity 0.1s linear' : 'opacity 0.8s linear',
          pointerEvents: showScrollbar ? 'auto' : 'none',
        }}
      >
        {/* Thumb */}
        <div
          ref={thumbRef}
          onMouseDown={onThumbMouseDown}
          style={{
            position: 'absolute',
            right: 0,
            top: thumbTop,
            width: '6px',
            height: thumbHeight,
            borderRadius: '3px',
            background: active
              ? 'var(--vscode-scrollbarSlider-activeBackground)'
              : 'var(--vscode-scrollbarSlider-background)',
            opacity: 0.6,
            cursor: 'pointer',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-scrollbarSlider-hoverBackground)';
          }}
          onMouseLeave={e => {
            if (!active) (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-scrollbarSlider-background)';
          }}
        />
      </div>
    </div>
  );
}
