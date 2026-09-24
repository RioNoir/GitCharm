import React from 'react';

interface Props {
  name: string;
  style?: React.CSSProperties;
  title?: string;
  className?: string;
}

export function Codicon({ name, style, title, className }: Props) {
  return (
    <i
      className={`codicon codicon-${name}${className ? ` ${className}` : ''}`}
      style={style}
      title={title}
      aria-hidden="true"
    />
  );
}
