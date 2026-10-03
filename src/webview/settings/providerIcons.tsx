import React from 'react';
import { Codicon } from '../shared/Codicon';

// Icons of the AI providers, drawn like codicons (16×16, currentColor) so they follow the theme. Brand marks are
// simplified, monochrome shapes; the CLI variants carry a small terminal badge to tell them from the APIs.

const MARKS: Record<string, React.ReactNode> = {
  claude: (
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(a => (
        <line key={a} x1="8" y1="8" x2="8" y2={a % 60 === 0 ? 1.5 : 2.8} transform={`rotate(${a} 8 8)`} />
      ))}
    </g>
  ),
  openai: (
    <g fill="none" stroke="currentColor" strokeWidth="1.3">
      {[0, 60, 120].map(a => <ellipse key={a} cx="8" cy="8" rx="2.6" ry="6.3" transform={`rotate(${a} 8 8)`} />)}
    </g>
  ),
  gemini: <path fill="currentColor" d="M8 1c.5 3.6 2.4 5.5 7 7-4.6 1.5-6.5 3.4-7 7-.5-3.6-2.4-5.5-7-7 4.6-1.5 6.5-3.4 7-7Z" />,
};

function Mark({ name, cli }: { name: keyof typeof MARKS; cli?: boolean }) {
  return (
    <span className="gc-ai-icon">
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">{MARKS[name]}</svg>
      {cli && <Codicon name="terminal" className="gc-ai-icon-badge" />}
    </span>
  );
}

/** The icon of an `ai.provider` value. */
export function aiProviderIcon(provider: string): React.ReactNode {
  switch (provider) {
    case 'vscode-lm': return <span className="gc-ai-icon"><Codicon name="copilot" style={{ fontSize: 18 }} /></span>;
    case 'claude-api': return <Mark name="claude" />;
    case 'claude-cli': return <Mark name="claude" cli />;
    case 'openai-api': return <Mark name="openai" />;
    case 'codex-cli': return <Mark name="openai" cli />;
    case 'gemini-api': return <Mark name="gemini" />;
    case 'gemini-cli': return <Mark name="gemini" cli />;
    case 'ollama': return <span className="gc-ai-icon"><Codicon name="server" style={{ fontSize: 18 }} /></span>;
    case 'lmstudio': return <span className="gc-ai-icon"><Codicon name="vm" style={{ fontSize: 18 }} /></span>;
    default: return undefined;
  }
}
