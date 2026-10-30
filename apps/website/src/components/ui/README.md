# UI controls

Use `Popover`, `Command`, and `Dialog` for searchable pickers and modal forms.
They compose Radix and cmdk primitives for keyboard navigation and focus handling.
The sidebar `ProjectPicker` searches accessible projects and gates creation with
the infrastructure `projects.create` capability. Its dialog shares `ProjectFields`
and `projectFormValues` with Administration → Projects.

Reusable Button, Input, Label, Checkbox, and NativeSelect components follow
shadcn/ui's Radix composition and use semantic Tailwind theme classes alongside
the dashboard's layout CSS. Tailwind scans the workspace root, including all local
TypeScript and TSX source locations. Button variants use class-variance-authority; labels,
checkbox state, form participation, and accessibility use Radix primitives.

Use these components in pages and shared layouts. Native elements are kept inside
these reusable components, as in shadcn/ui's Input and NativeSelect. Tables,
forms, and fieldsets remain semantic layout/grouping elements.

Use `CheckboxTree` for hierarchical permission selection. It supports checked,
unchecked, and mixed states, descendant selection, and required permissions via
`dependentIds`. Checkbox IDs are unique to each tree instance. For privileged
roles, set `aggregateChildren: false` and `lockChildrenWhenChecked: true`: granting
the role selects and locks its descendants, while selecting individual child
permissions never grants the role. Clearing the role clears its descendants.
`ServerPermissionTree` maps this behavior to server roles and capabilities.

Use `QuickTip` for all tooltips, including hints on disabled controls and text
that previously used a native `title` attribute. It composes the shared Radix tooltip
components with optional instant display, portal rendering, placement, and text
shortcut badges. Icon-only triggers should have an accessible name and support
keyboard focus. Text, SVGs, fragments, and custom components are automatically
wrapped in a focusable span so the tooltip has an HTML trigger. Native HTML
elements are used directly; provide a focusable span around disabled controls.
The permission tree uses it to explain locked permissions.

Use `Card` for standalone surfaces such as authentication panels and account
popups. It owns border, padding, and text wrapping. Responsive forms should wrap
their controls rather than clip overflowing content or focus outlines.

Use the shadcn/ui `Breadcrumb` components for all breadcrumb paths. The shared
shell renders header paths with `BreadcrumbList`, `BreadcrumbItem`,
`BreadcrumbSeparator`, and `BreadcrumbPage`. Use `BreadcrumbLink` when an ancestor
has a destination; section labels without a destination remain plain text.
