# Variable drafts

The normal editor and developer `.env` editor update the same encrypted, versioned
service draft. Saving never deploys or restarts the app. The service shows when its
saved configuration has not been deployed successfully. Runtime variables, public
build arguments and private BuildKit secrets remain distinct inputs.

Normal editing is available with service deployment/configuration authority. Existing
values appear masked; keeping a mask preserves its saved value, and removing a row
removes the key only after the save review. Developer mode first loads complete
plaintext and requires the separate **Reveal service secrets** permission. Project
and server administrators can delegate that capability through service grants.
Ordinary app deployment access does not grant reveal. Loading plaintext is explicit;
responses are not cacheable. A literal `********` value in a complete developer
submission remains literal and is not interpreted as a mask.

The save review lists added, changed and removed key names without exposing their
values. Cancel leaves the saved draft unchanged. Concurrent/stale edits return a
conflict and must be reloaded instead of overwriting a newer revision.

## `.env` grammar

- Each assignment is `KEY=value`; keys match `[A-Za-z_][A-Za-z0-9_]*`.
- Blank lines and lines beginning with `#` after indentation are ignored.
- Unquoted values keep literal dollar signs and `#` within a word. Whitespace
  followed by `#` starts an inline comment. Trailing whitespace is removed.
- Single-quoted values are literal and may span lines. They do not interpret
  escape sequences.
- Double-quoted values may span lines and support JSON escapes for quotes,
  backslashes, newlines, carriage returns, tabs, backspace, form feed and
  four-digit Unicode sequences.
- After a closing quote, only whitespace and an optional comment are permitted.
- Dollar signs, `${NAME}`, command substitutions and backticks are never expanded
  or executed. `export`, shell commands and interpolation syntax are not evaluated.
- Duplicate keys, invalid keys, unsupported escapes and unterminated quotes reject
  the entire document with a line-specific error. Individual values are bounded
  to 16,384 characters and the document to 512,000 characters.

The developer document is a full replacement, including deletion of omitted keys.
Switching editor modes preserves values. Public build arguments must be declared
with `ARG` in the committed Dockerfile and can appear in image metadata/browser
bundles. Private dependency credentials belong in BuildKit secrets or scoped registry
connections; suggestions reference secret mounts rather than credential literals.
