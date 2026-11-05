/**
 * Section — non-collapsible labelled group with icon + title row.
 * Used in SettingsPanel.
 */

import * as React from 'react';

export interface SectionProps {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}

export function Section({ icon, title, children }: SectionProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}
