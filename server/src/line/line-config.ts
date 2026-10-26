export interface LineConfig {
  secret: string | null;
  token: string | null;
  botAddUrl: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Only an https link is ever shown to a host as the bot's add-friend link. */
function httpsUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** Read from the environment on every call, so a test (or a restart-free change) sees the live value. */
export function lineConfig(): LineConfig {
  return {
    secret: nonEmpty(process.env.LINE_CHANNEL_SECRET),
    token: nonEmpty(process.env.LINE_CHANNEL_ACCESS_TOKEN),
    botAddUrl: httpsUrl(nonEmpty(process.env.LINE_BOT_ADD_URL)),
  };
}
