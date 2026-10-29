/** The group settings list, in its fixed order (spec: Settings contents). */
export const SETTINGS_SECTIONS = ['players', 'levels', 'share', 'line', 'payment', 'advanced', 'manage'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The sections that live at /g/:groupCode/settings/:section; players and levels keep their own routes. */
export const DETAIL_SECTIONS = ['share', 'line', 'payment', 'advanced', 'manage'] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];

export function isSettingsSection(value: string | null): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? '');
}

export function isDetailSection(value: string | null): value is DetailSection {
  return (DETAIL_SECTIONS as readonly string[]).includes(value ?? '');
}

/**
 * Where a settings detail's back link goes: group home with the disclosure
 * reopened and focus on the row the host came from. Group home reads and then
 * drops the `settings` parameter (replaceUrl), so a reload does not reopen it.
 */
export function settingsReturn(groupCode: string, section: SettingsSection) {
  return { commands: ['/g', groupCode], queryParams: { settings: section } };
}
