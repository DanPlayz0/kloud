import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
function key() {
  const value = process.env.PLATFORM_ENCRYPTION_KEY
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value))
    throw new HTTPException(503, {
      message:
        'Configure PLATFORM_ENCRYPTION_KEY as 64 hexadecimal characters before saving service configuration',
    })
  return Buffer.from(value, 'hex')
}
export function seal(value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ])
  return [iv, cipher.getAuthTag(), body]
    .map((v) => v.toString('base64url'))
    .join('.')
}
export function unseal(value: string): any {
  const [iv, tag, body] = value
    .split('.')
    .map((v) => Buffer.from(v, 'base64url'))
  const cipher = createDecipheriv('aes-256-gcm', key(), iv!)
  cipher.setAuthTag(tag!)
  return JSON.parse(
    Buffer.concat([cipher.update(body!), cipher.final()]).toString(),
  )
}
export function redact(text: string, config: any) {
  const secrets = [
    ...Object.values(config.runtime?.environment ?? {}),
    config.source?.registry?.password,
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length)
  for (const secret of secrets) text = text.split(secret).join('[redacted]')
  return text
}
