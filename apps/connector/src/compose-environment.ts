/** Compose dotenv expands double-quoted dollar expressions unless escaped. */
export function formatComposeEnvironment(values: Record<string, string>) {
  return (
    Object.entries(values)
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          throw new Error('Invalid Compose variable name')
        return `${key}=${JSON.stringify(value).replaceAll('$', () => '\\$')}`
      })
      .join('\n') + '\n'
  )
}
