import { cn } from '@/lib/utils'
import { useId, useState, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { Checkbox, Label } from './controls'
import QuickTip from '../quickTip'
import {
  CheckboxTreeCheckboxState,
  getInitialCheckboxTreeValues,
  updateItemStates,
  type CheckboxTreeItem,
  type CheckboxTreeItemState,
} from './checkbox-tree-state'

export * from './checkbox-tree-state'

export type CheckboxTreeProps = {
  data: CheckboxTreeItem[]
  value?: CheckboxTreeItemState[]
  onChange?: (value: CheckboxTreeItemState[]) => void
  disabled?: boolean
  dependentTooltip?: string
  renderItemLabel?: (
    item: CheckboxTreeItem,
    state: CheckboxTreeItemState,
  ) => ReactNode
  parseItemLabel?: (
    item: CheckboxTreeItem,
    state: CheckboxTreeItemState,
  ) => string
}

// Adapted from the supplied checkbox-tree.tsx to use the shared Radix controls.
export function CheckboxTree({
  data,
  value,
  onChange,
  disabled = false,
  dependentTooltip = 'Required by a selected permission or inherited from an administrator role.',
  renderItemLabel,
  parseItemLabel,
}: CheckboxTreeProps) {
  const prefix = useId()
  const [internalState, setInternalState] = useState(() =>
    getInitialCheckboxTreeValues(data),
  )
  const itemStates =
    value ??
    getInitialCheckboxTreeValues(
      data,
      internalState
        .filter((item) => item.state === CheckboxTreeCheckboxState.CHECKED)
        .map((item) => item.value),
    )
  function change(id: number) {
    const next = updateItemStates(itemStates, data, id)
    if (value === undefined) setInternalState(next)
    onChange?.(next)
  }
  function renderList(parentId: number): ReactNode {
    const items = data.filter((item) => item.parentId === parentId)
    if (!items.length) return null
    return (
      <ul
        className={cn(
          parentId
            ? 'ml-2 flex flex-col gap-1 border-l border-border pl-4'
            : 'flex flex-col gap-1',
        )}
      >
        {items.map((item) => {
          const state = itemStates.find((state) => state.id === item.id)!
          const id = `${prefix}-${item.id}`
          return (
            <li key={item.id}>
              <div className="flex items-center gap-2 py-1 text-foreground">
                <Checkbox
                  id={id}
                  checked={
                    state.state === CheckboxTreeCheckboxState.INDETERMINATE
                      ? 'indeterminate'
                      : state.state === CheckboxTreeCheckboxState.CHECKED
                  }
                  disabled={disabled || state.disabled}
                  onCheckedChange={() => change(item.id)}
                />
                <Label htmlFor={id} className="cursor-pointer text-sm">
                  {renderItemLabel?.(item, state) ??
                    parseItemLabel?.(item, state) ??
                    item.name}
                </Label>
                {state.disabled && (
                  <QuickTip instant portal content={dependentTooltip}>
                    <span
                      tabIndex={0}
                      role="img"
                      aria-label={`${item.name}: ${dependentTooltip}`}
                      className="cursor-help rounded-sm text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
                    >
                      <Lock size={14} aria-hidden="true" />
                    </span>
                  </QuickTip>
                )}
              </div>
              {renderList(item.id)}
            </li>
          )
        })}
      </ul>
    )
  }
  return renderList(0)
}
