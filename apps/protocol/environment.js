// Deliberately does not invoke a shell or expand dollar signs/interpolation.
export class EnvironmentSyntaxError extends Error {
  constructor(line, message) {
    super(`Line ${line}: ${message}`)
    this.line = line
  }
}
export function parseEnvironment(text) {
  if (text.length > 512000)
    throw new EnvironmentSyntaxError(1, 'Document is too large')
  const values = Object.create(null)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new EnvironmentSyntaxError(i + 1, 'Expected KEY=value')
    const [, key, raw] = match
    const start = i + 1
    if (Object.hasOwn(values, key))
      throw new EnvironmentSyntaxError(start, `Duplicate key ${key}`)
    let value = ''
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0]
      let remaining = raw.slice(1),
        closed = false
      while (!closed) {
        let index = 0
        for (; index < remaining.length; index++) {
          const char = remaining[index]
          if (char === quote) {
            if (!/^\s*(?:#.*)?$/.test(remaining.slice(index + 1)))
              throw new EnvironmentSyntaxError(
                i + 1,
                'Unexpected text after quoted value',
              )
            closed = true
            break
          }
          if (quote === '"' && char === '\\') {
            const next = remaining[++index]
            const escapes = {
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
              '"': '"',
              '\\': '\\',
            }
            if (next === 'u') {
              const hex = remaining.slice(index + 1, index + 5)
              if (!/^[a-fA-F0-9]{4}$/.test(hex))
                throw new EnvironmentSyntaxError(
                  i + 1,
                  'Expected four hexadecimal digits after a Unicode escape',
                )
              value += String.fromCharCode(parseInt(hex, 16))
              index += 4
              continue
            }
            if (!Object.hasOwn(escapes, next))
              throw new EnvironmentSyntaxError(
                i + 1,
                'Unsupported escape; use \\" or \\\\',
              )
            value += escapes[next]
          } else value += char
        }
        if (!closed) {
          if (++i >= lines.length)
            throw new EnvironmentSyntaxError(start, 'Unterminated quoted value')
          value += '\n'
          remaining = lines[i]
        }
      }
    } else
      value = raw.startsWith('#') ? '' : raw.replace(/\s+#.*$/, '').trimEnd()
    if (value.length > 16384)
      throw new EnvironmentSyntaxError(
        start,
        `Value for ${key} exceeds 16384 characters`,
      )
    values[key] = value
  }
  return values
}
export function formatEnvironment(values) {
  return (
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n') + '\n'
  )
}
export function environmentChanges(previous, next) {
  return {
    added: Object.keys(next)
      .filter((key) => !Object.hasOwn(previous, key))
      .sort(),
    changed: Object.keys(next)
      .filter(
        (key) => Object.hasOwn(previous, key) && previous[key] !== next[key],
      )
      .sort(),
    removed: Object.keys(previous)
      .filter((key) => !Object.hasOwn(next, key))
      .sort(),
  }
}
