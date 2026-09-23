import React from 'react';

/**
 * Slots React nodes into the `{n}` placeholders of an already-translated message, so a sentence with styled
 * pieces (bold names, branch pills, label chips) stays one translatable message whose word order translators
 * control. Call as `interpolateNodes(l10n.t('{0} added the {1} label'), actor, chip)`: with no args, l10n.t
 * leaves the placeholders untouched.
 */
export function interpolateNodes(message: string, ...nodes: React.ReactNode[]): React.ReactNode {
  return message.split(/\{(\d+)\}/).map((part, i) => (
    <React.Fragment key={i}>{i % 2 === 0 ? part : nodes[Number(part)]}</React.Fragment>
  ));
}
