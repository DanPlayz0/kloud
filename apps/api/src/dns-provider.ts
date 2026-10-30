import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import type { DnsRecord, DnsLiveRecord } from '@dedi-dash/protocol/dns'

function encryptionKey() {
  const value = process.env.DNS_ENCRYPTION_KEY ?? ''
  if (!/^[a-fA-F0-9]{64}$/.test(value))
    throw new HTTPException(503, {
      message:
        'DNS_ENCRYPTION_KEY must be configured as 64 hexadecimal characters',
    })
  return Buffer.from(value, 'hex')
}
export function encryptDnsToken(token: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ])
  return [iv, cipher.getAuthTag(), encrypted]
    .map((v) => v.toString('base64url'))
    .join('.')
}
export function decryptDnsToken(value: string) {
  try {
    const [iv, tag, content] = value
      .split('.')
      .map((v) => Buffer.from(v, 'base64url'))
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv!)
    decipher.setAuthTag(tag!)
    return Buffer.concat([
      decipher.update(content!),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new HTTPException(503, {
      message:
        'DNS credentials unavailable; check the encryption key or replace the token',
    })
  }
}
export interface ProviderZone {
  id: string
  name: string
}
export interface DnsProvider {
  check(): Promise<void>
  zones(): Promise<ProviderZone[]>
  records(zone: string): Promise<DnsLiveRecord[]>
  record(zone: string, id: string): Promise<DnsLiveRecord>
  create(zone: string, record: DnsRecord): Promise<DnsLiveRecord>
  update(zone: string, id: string, record: DnsRecord): Promise<DnsLiveRecord>
  delete(zone: string, id: string): Promise<void>
}
const identifier = (value: string) => encodeURIComponent(value)
// URI's legacy priority is top-level in Cloudflare's API. Keep the form's
// structured representation consistent with other structured record types.
export function serializeDnsRecord(record: DnsRecord): DnsRecord {
  if (record.type !== 'URI') return record
  const { priority, ...data } = record.data!
  return { ...record, priority: Number(priority), data }
}
export class CloudflareDns implements DnsProvider {
  constructor(
    private token: string,
    private request: typeof fetch = fetch,
  ) {}
  private async call<T>(
    path: string,
    method = 'GET',
    body?: DnsRecord,
  ): Promise<{ result: T; result_info?: { total_pages: number } }> {
    let response: Response
    try {
      response = await this.request(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body:
            body === undefined
              ? undefined
              : JSON.stringify(serializeDnsRecord(body)),
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        },
      )
    } catch {
      throw new HTTPException(503, {
        message:
          method === 'GET'
            ? 'DNS provider unavailable'
            : 'DNS provider did not confirm the change. Refresh records before retrying.',
      })
    }
    if (response.status === 429)
      throw new HTTPException(429, {
        message: 'DNS provider rate limit reached; try again later',
      })
    if ([401, 403].includes(response.status))
      throw new HTTPException(502, {
        message: 'DNS provider denied access; check token permissions',
      })
    if (response.status === 404)
      throw new HTTPException(404, { message: 'DNS resource not found' })
    let result: {
      success: boolean
      result: T
      result_info?: { total_pages: number }
    }
    try {
      result = (await response.json()) as typeof result
    } catch {
      throw new HTTPException(502, { message: 'Invalid DNS provider response' })
    }
    if (!response.ok || !result.success)
      throw new HTTPException(response.status >= 500 ? 503 : 400, {
        message:
          response.status >= 500
            ? 'DNS provider unavailable; refresh before retrying a change'
            : 'DNS provider rejected the request; check record values and zone restrictions',
      })
    return result
  }
  private async list<T>(path: string): Promise<T[]> {
    const records: T[] = []
    for (let page = 1; page <= 100; page++) {
      const result = await this.call<T[]>(`${path}?per_page=100&page=${page}`)
      if (!Array.isArray(result.result))
        throw new HTTPException(502, {
          message: 'Invalid DNS provider response',
        })
      records.push(...result.result)
      if (page >= (result.result_info?.total_pages ?? 1)) return records
    }
    throw new HTTPException(502, {
      message:
        'DNS provider result is too large; narrow the provider token zone scope',
    })
  }
  async check() {
    await this.zones()
  }
  zones() {
    return this.list<ProviderZone>('/zones')
  }
  records(zone: string) {
    return this.list<DnsLiveRecord>(`/zones/${identifier(zone)}/dns_records`)
  }
  async record(zone: string, id: string) {
    return (
      await this.call<DnsLiveRecord>(
        `/zones/${identifier(zone)}/dns_records/${identifier(id)}`,
      )
    ).result
  }
  async create(zone: string, record: DnsRecord) {
    return (
      await this.call<DnsLiveRecord>(
        `/zones/${identifier(zone)}/dns_records`,
        'POST',
        record,
      )
    ).result
  }
  async update(zone: string, id: string, record: DnsRecord) {
    return (
      await this.call<DnsLiveRecord>(
        `/zones/${identifier(zone)}/dns_records/${identifier(id)}`,
        'PATCH',
        record,
      )
    ).result
  }
  async delete(zone: string, id: string) {
    await this.call(
      `/zones/${identifier(zone)}/dns_records/${identifier(id)}`,
      'DELETE',
    )
  }
}
