/** The LIFF page a new host signs up on. Lives under the LIFF app's `/line-share` endpoint. */
export function liffSignupUrl(liffId: string): string {
  return `https://liff.line.me/${liffId}/signup`;
}

/** The LIFF page an existing host links their LINE account on. */
export function liffLinkUrl(liffId: string): string {
  return `https://liff.line.me/${liffId}/link`;
}
