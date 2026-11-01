// Public API metadata is deliberately independent of credential storage columns.
// Even an expanded query must never serialize tokens, hashes or private keys.
export function connectorView(row: Record<string, unknown>, workspace = false) {
  const fields = [
    'id',
    'name',
    'created_at',
    'discovery',
    'revoked',
    'host',
    'seen',
    'capabilities',
    'agent_status',
    'auto_update',
    'stale',
    ...(workspace
      ? ['public_addresses', 'dns_targets', 'private_addresses']
      : []),
  ]
  return Object.fromEntries(
    fields.filter((key) => key in row).map((key) => [key, row[key]]),
  )
}
