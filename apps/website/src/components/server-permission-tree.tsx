import {
  serverCapabilities,
  serverCapabilityLabels,
  type ServerCapability,
} from '../api'
import {
  CheckboxTree,
  CheckboxTreeCheckboxState,
  getInitialCheckboxTreeValues,
  type CheckboxTreeItem,
} from './ui/checkbox-tree'

const data: CheckboxTreeItem[] = [
  {
    id: 1,
    parentId: 0,
    name: 'Server Administrator',
    value: 'admin',
    aggregateChildren: false,
    lockChildrenWhenChecked: true,
  },
  ...serverCapabilities.map((value, index) => ({
    id: index + 2,
    parentId: 1,
    name: serverCapabilityLabels[value],
    value,
  })),
]

export function ServerPermissionTree({
  admin,
  capabilities,
  onChange,
}: {
  admin: boolean
  capabilities: ServerCapability[]
  onChange: (admin: boolean, capabilities: ServerCapability[]) => void
}) {
  return (
    <CheckboxTree
      data={data}
      value={getInitialCheckboxTreeValues(
        data,
        admin ? ['admin'] : capabilities,
      )}
      onChange={(states) => {
        const checked = states.filter(
          (state) => state.state === CheckboxTreeCheckboxState.CHECKED,
        )
        onChange(
          checked.some((state) => state.value === 'admin'),
          serverCapabilities.filter((capability) =>
            checked.some((state) => state.value === capability),
          ),
        )
      }}
    />
  )
}
