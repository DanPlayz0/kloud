/** Keep post-login redirects on a local path, including after URL normalization. */
export function loginDestination(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\u0000-\u0020\\]/.test(value)
  )
    return '/'
  return value
}
