import React from 'react';
import { InlineIconBtn } from './InlineIconBtn';
import * as l10n from '@vscode/l10n';

export function OpenChangesBtn({ visible, onClick }: { visible: boolean; onClick: (e: React.MouseEvent) => void }) {
  return <InlineIconBtn icon="diff-multiple" title={l10n.t('Open all changes')} visible={visible} onClick={onClick} />;
}
