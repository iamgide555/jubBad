/** class-transformer hook: trims strings, passes anything else through for the validators to reject. */
export const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
