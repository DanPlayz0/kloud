/** Redact across process-output chunk boundaries, not only within each chunk. */
export function secretOutput(secrets: string[], emit: (text: string) => void) {
  const values = [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )
  const tail = Math.max(0, ...values.map((value) => value.length - 1))
  let pending = ''
  const replace = (text: string) =>
    values.reduce(
      (result, secret) => result.replaceAll(secret, '[redacted]'),
      text,
    )
  return {
    write(text: string) {
      pending = replace(pending + text)
      const length = Math.max(0, pending.length - tail)
      if (length) {
        emit(pending.slice(0, length))
        pending = pending.slice(length)
      }
    },
    flush() {
      pending = replace(pending)
      // Do not disclose a credential prefix left at end-of-stream.
      for (const value of values)
        for (
          let length = Math.min(value.length - 1, pending.length);
          length > 0;
          length--
        ) {
          if (pending.endsWith(value.slice(0, length))) {
            pending = pending.slice(0, -length) + '[redacted]'
            break
          }
        }
      if (pending) emit(pending)
      pending = ''
    },
  }
}
