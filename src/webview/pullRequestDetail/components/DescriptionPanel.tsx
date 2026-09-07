import React, { useMemo } from 'react';
import { renderMarkdown } from '../renderMarkdown';

interface Props {
  description: string;
  loading: boolean;
}

export function DescriptionPanel({ description, loading }: Props) {
  const html = useMemo(() => renderMarkdown(description), [description]);

  if (loading) return <div style={css.loading}>Loading…</div>;
  if (!html) return <div style={css.empty}>No description provided.</div>;

  return <div style={css.markdown} dangerouslySetInnerHTML={{ __html: html }} />;
}

const css = {
  loading: { padding: '12px 0', fontSize: '12px', opacity: 0.5 },
  empty: { padding: '12px 0', fontSize: '12px', opacity: 0.5, fontStyle: 'italic' as const },
  markdown: {
    fontSize: '13px', lineHeight: 1.6,
  } as React.CSSProperties,
};
