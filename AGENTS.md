# Agent instructions

- Use reusable UI components instead of directly styling native HTML controls. First look for an existing project component; otherwise, use or add an appropriate shadcn/ui component. Only use a native control directly when no suitable component exists, and explain why. This rule does not prohibit semantic HTML for layout or content, or native elements inside reusable components.
- Use semantic theme classes such as `bg-background`, `text-foreground`, `bg-card`, `border-border`, and `text-muted-foreground` for shared application structure.
- Ensure Tailwind scans every local TypeScript and TSX source location.
- Never use emojis. Prefer Lucide icons whenever an icon is needed.
