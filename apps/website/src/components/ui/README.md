# UI controls

Reusable Button, Input, Label, Checkbox, and NativeSelect components follow
shadcn/ui's Radix composition and use semantic Tailwind theme classes alongside
the dashboard's layout CSS. Tailwind scans the workspace root, including all local
TypeScript and TSX source locations. Button variants use class-variance-authority; labels,
checkbox state, form participation, and accessibility use Radix primitives.

Use these components in pages and shared layouts. Native elements are kept inside
these reusable components, as in shadcn/ui's Input and NativeSelect. Tables,
forms, and fieldsets remain semantic layout/grouping elements.

Use `Card` for standalone surfaces such as authentication panels and account
popups. It owns border, padding, and text wrapping. Responsive forms should wrap
their controls rather than clip overflowing content or focus outlines.

Use the shadcn/ui `Breadcrumb` components for all breadcrumb paths. The shared
shell renders header paths with `BreadcrumbList`, `BreadcrumbItem`,
`BreadcrumbSeparator`, and `BreadcrumbPage`. Use `BreadcrumbLink` when an ancestor
has a destination; section labels without a destination remain plain text.
