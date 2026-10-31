import { Button } from './controls'
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: string[]
  value: string
  onChange: (value: string) => void
  label: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex flex-wrap gap-2 border-b border-border pb-3"
      onKeyDown={(e) => {
        const index = items.indexOf(value)
        const next =
          e.key === 'ArrowRight'
            ? (index + 1) % items.length
            : e.key === 'ArrowLeft'
              ? (index + items.length - 1) % items.length
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? items.length - 1
                  : -1
        if (next >= 0) {
          e.preventDefault()
          onChange(items[next]!)
          const tabs =
            e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')
          tabs[next]?.focus()
        }
      }}
    >
      {items.map((item) => (
        <Button
          key={item}
          role="tab"
          aria-selected={value === item}
          tabIndex={value === item ? 0 : -1}
          variant={value === item ? 'primary' : 'default'}
          onClick={() => onChange(item)}
        >
          {item}
        </Button>
      ))}
    </div>
  )
}
