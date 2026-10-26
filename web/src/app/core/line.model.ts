/** Mirrors server/src/line/line-link.service.ts LineStatus. */
export interface LineStatus {
  configured: boolean;
  botAddUrl: string | null;
  linked: boolean;
  lineGroupName: string | null;
  linkedAt: string | null;
  leftAt: string | null;
}

export interface LineLinkCode {
  code: string;
  expiresAt: string;
}

/** Mirrors server/src/line/line-roster.service.ts LatestRoster. */
export interface LatestRoster {
  text: string;
  senderName: string | null;
  postedAt: string;
  stale: boolean;
}
