export const CheckboxTreeCheckboxState = {
  UNCHECKED: 0,
  CHECKED: 1,
  INDETERMINATE: 2,
} as const
export type CheckboxTreeCheckboxState =
  (typeof CheckboxTreeCheckboxState)[keyof typeof CheckboxTreeCheckboxState]

export type CheckboxTreeItem = {
  id: number
  name: string
  parentId: number
  dependentIds?: number[]
  value: string
  // Privileged roles must be granted explicitly, never inferred from children.
  aggregateChildren?: boolean
  lockChildrenWhenChecked?: boolean
}

export type CheckboxTreeItemState = {
  id: number
  state: CheckboxTreeCheckboxState
  disabled: boolean
  value: string
}

const { UNCHECKED, CHECKED, INDETERMINATE } = CheckboxTreeCheckboxState

export function getInitialCheckboxTreeValues(
  data: CheckboxTreeItem[],
  checked: string[] = [],
): CheckboxTreeItemState[] {
  const selected = new Set(
    data.filter((item) => checked.includes(item.value)).map((item) => item.id),
  )
  const disabled = new Set<number>()
  const children = (id: number) => data.filter((item) => item.parentId === id)
  const visited = new Set<string>()
  function select(id: number, locked = false) {
    const item = data.find((item) => item.id === id)
    if (!item) return
    if (locked) disabled.add(id)
    const key = `${id}:${locked}`
    if (visited.has(key)) return
    visited.add(key)
    selected.add(id)
    for (const child of children(id))
      select(child.id, locked || !!item.lockChildrenWhenChecked)
    for (const dependency of item.dependentIds ?? []) select(dependency, true)
  }
  for (const id of selected) select(id)

  const states = new Map<number, CheckboxTreeCheckboxState>()
  function stateFor(item: CheckboxTreeItem): CheckboxTreeCheckboxState {
    const cached = states.get(item.id)
    if (cached !== undefined) return cached
    const childStates = children(item.id).map(stateFor)
    const state =
      item.aggregateChildren === false || !childStates.length
        ? selected.has(item.id)
          ? CHECKED
          : childStates.some((state) => state !== UNCHECKED)
            ? INDETERMINATE
            : UNCHECKED
        : childStates.every((state) => state === CHECKED)
          ? CHECKED
          : childStates.every((state) => state === UNCHECKED)
            ? UNCHECKED
            : INDETERMINATE
    states.set(item.id, state)
    return state
  }
  return data.map((item) => ({
    id: item.id,
    value: item.value,
    state: stateFor(item),
    disabled: disabled.has(item.id),
  }))
}

export function updateItemStates(
  oldState: CheckboxTreeItemState[],
  items: CheckboxTreeItem[],
  clickedId: number,
): CheckboxTreeItemState[] {
  const clicked = oldState.find((item) => item.id === clickedId)
  if (!clicked || clicked.disabled) return oldState
  // Aggregate parents are derived; retaining them would re-select a removed child.
  const selected = new Set(
    oldState
      .filter((state) => {
        const item = items.find((item) => item.id === state.id)
        return (
          state.state === CHECKED &&
          (item?.aggregateChildren === false ||
            !items.some((child) => child.parentId === state.id))
        )
      })
      .map((state) => state.value),
  )
  function toggle(id: number) {
    const item = items.find((item) => item.id === id)
    if (!item) return
    if (clicked!.state === CHECKED) selected.delete(item.value)
    else selected.add(item.value)
    for (const child of items.filter((item) => item.parentId === id))
      toggle(child.id)
  }
  toggle(clickedId)
  return getInitialCheckboxTreeValues(items, [...selected])
}
