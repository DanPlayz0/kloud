# UI controls

Reusable Button, Input, Label, Checkbox, and NativeSelect components follow
shadcn/ui's Radix composition and use the existing dashboard CSS theme instead
of introducing Tailwind. Button variants use class-variance-authority; labels,
checkbox state, form participation, and accessibility use Radix primitives.

Use these components in pages and shared layouts. Native elements are kept inside
these reusable components, as in shadcn/ui's Input and NativeSelect. Tables,
forms, and fieldsets remain semantic layout/grouping elements.
