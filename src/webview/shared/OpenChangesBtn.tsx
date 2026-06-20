import React from 'react';
import { InlineIconBtn } from './InlineIconBtn';

export function OpenChangesBtn({ visible, onClick }: { visible: boolean; onClick: (e: React.MouseEvent) => void }) {
  return <InlineIconBtn icon="diff-multiple" title="Open all changes" visible={visible} onClick={onClick} />;
}
