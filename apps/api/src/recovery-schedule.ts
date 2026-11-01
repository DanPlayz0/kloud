// Five-field cron with timezone-aware wall-clock evaluation. No shell commands.
export function cronFields(expression: string) {
  const pieces = expression.trim().split(/\s+/)
  if (pieces.length !== 5)
    throw new Error('Use five cron fields: minute hour day month weekday')
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const
  return pieces.map((piece, index) => {
    const [min, max] = ranges[index]!
    const values = new Set<number>()
    for (const part of piece!.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
      if (!m) throw new Error(`Invalid cron field ${index + 1}`)
      const step = Number(m[2] ?? 1)
      if (!Number.isInteger(step) || step < 1 || step > max - min + 1)
        throw new Error('Invalid cron step')
      const bounds = m[1] === '*' ? [min, max] : m[1]!.split('-').map(Number)
      const low = bounds[0]!,
        high = bounds[1] ?? low
      if (low < min || high > max || high < low)
        throw new Error(`Cron field ${index + 1} is out of range`)
      for (let n = low; n <= high; n += step) values.add(n)
    }
    return { values, any: piece === '*' }
  })
}
export function nextBackupRun(
  expression: string,
  timezone: string,
  after = new Date(),
) {
  const fields = cronFields(expression)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
  })
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  let value = Math.floor(after.getTime() / 60000) * 60000 + 60000
  for (let n = 0; n < 527040; n++, value += 60000) {
    const p = Object.fromEntries(
      formatter.formatToParts(value).map((p) => [p.type, p.value]),
    )
    const numbers = [
      Number(p.minute),
      Number(p.hour),
      Number(p.day),
      Number(p.month),
      days.indexOf(p.weekday!),
    ]
    const day = fields[2]!.values.has(numbers[2]!),
      weekday = fields[4]!.values.has(numbers[4]!)
    const dayMatch =
      fields[2]!.any || fields[4]!.any ? day && weekday : day || weekday
    if (
      fields[0]!.values.has(numbers[0]!) &&
      fields[1]!.values.has(numbers[1]!) &&
      fields[3]!.values.has(numbers[3]!) &&
      dayMatch
    )
      return new Date(value)
  }
  throw new Error('Schedule has no occurrence within the next year')
}
