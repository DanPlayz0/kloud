import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CheckboxTreeCheckboxState as State,
  getInitialCheckboxTreeValues,
  updateItemStates,
  type CheckboxTreeItem,
} from '../src/components/ui/checkbox-tree-state.ts'

const items: CheckboxTreeItem[] = [
  { id: 1, parentId: 0, name: 'All', value: 'all' },
  { id: 2, parentId: 1, name: 'View', value: 'view' },
  { id: 3, parentId: 1, name: 'Logs', value: 'logs', dependentIds: [2] },
  {
    id: 4,
    parentId: 1,
    name: 'Terminal',
    value: 'terminal',
    dependentIds: [2],
  },
]

test('parent toggles descendants; child selection rolls up to mixed and checked', () => {
  let states = getInitialCheckboxTreeValues(items)
  states = updateItemStates(states, items, 1)
  assert.ok(states.every((state) => state.state === State.CHECKED))
  states = updateItemStates(states, items, 3)
  assert.equal(states[0].state, State.INDETERMINATE)
  assert.equal(states[2].state, State.UNCHECKED)
  states = updateItemStates(states, items, 3)
  assert.equal(states[0].state, State.CHECKED)
  states = updateItemStates(states, items, 1)
  assert.ok(
    states.every((state) => state.state === State.UNCHECKED && !state.disabled),
  )
})

test('shared dependencies stay checked and locked until all requiring permissions are removed', () => {
  let states = getInitialCheckboxTreeValues(items, ['logs', 'terminal'])
  assert.equal(states[1].state, State.CHECKED)
  assert.equal(states[1].disabled, true)
  assert.deepEqual(updateItemStates(states, items, 2), states)
  states = updateItemStates(states, items, 3)
  assert.equal(states[1].disabled, true)
  states = updateItemStates(states, items, 4)
  assert.equal(states[1].disabled, false)
  states = updateItemStates(states, items, 2)
  assert.ok(states.every((state) => state.state === State.UNCHECKED))
})

test('administrator inherits all descendants but selecting all children never grants the role', () => {
  const roles = items.map((item) =>
    item.id === 1
      ? {
          ...item,
          aggregateChildren: false,
          lockChildrenWhenChecked: true,
        }
      : item,
  )
  let states = getInitialCheckboxTreeValues(roles, ['logs', 'terminal'])
  assert.equal(states[0].state, State.INDETERMINATE)
  states = updateItemStates(states, roles, 1)
  assert.ok(states.every((state) => state.state === State.CHECKED))
  assert.ok(states.slice(1).every((state) => state.disabled))
  assert.equal(states[0].disabled, false)
  states = getInitialCheckboxTreeValues(roles, ['all'])
  assert.ok(states.slice(1).every((state) => state.disabled))
  states = updateItemStates(states, roles, 1)
  assert.ok(
    states.every((state) => state.state === State.UNCHECKED && !state.disabled),
  )
})

test('nested descendants, ancestor rollup, and transitive dependencies initialize correctly', () => {
  const nested = [
    ...items,
    { id: 5, parentId: 4, name: 'Shell', value: 'shell', dependentIds: [3] },
  ]
  const states = getInitialCheckboxTreeValues(nested, ['shell'])
  assert.ok(states.every((state) => state.state === State.CHECKED))
  assert.equal(states[1].disabled, true)
  assert.equal(states[2].disabled, true)
  assert.equal(states[4].disabled, false)
})
