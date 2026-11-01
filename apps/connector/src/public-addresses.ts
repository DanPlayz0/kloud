import { request } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import {
  isPublicIPv4,
  isPublicIPv6,
  type PublicAddresses,
} from '@kloud/protocol/addresses'

export function detectAddress(
  url: string,
  family: 4 | 6,
  signal: AbortSignal,
): Promise<string> {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
    throw new Error(
      'Public address discovery requires an HTTPS URL without credentials',
    )
  return new Promise((resolve, reject) => {
    const req = request(
      endpoint,
      { family, signal, timeout: 5000, headers: { accept: 'text/plain' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`Discovery returned HTTP ${response.statusCode}`))
          return
        }
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
          if (text.length > 256)
            req.destroy(new Error('Discovery response too large'))
        })
        response.on('error', reject)
        response.on('end', () => {
          const value = text.trim()
          if (!(family === 4 ? isPublicIPv4(value) : isPublicIPv6(value)))
            reject(new Error('Discovery did not return a public address'))
          else resolve(value)
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('Discovery timed out')))
    req.on('error', reject)
    req.end()
  })
}
export function publicAddressDiscovery(
  signal: AbortSignal,
  detect = detectAddress,
) {
  const empty = () =>
    ({
      address: null,
      last_success: null,
      checked_at: null,
      status: 'unknown',
      error: null,
    }) as const
  const state: PublicAddresses = { version: 1, ipv4: empty(), ipv6: empty() }
  const interval = Number(process.env.PUBLIC_ADDRESS_INTERVAL_MS ?? 900000)
  if (!Number.isFinite(interval) || interval < 60000)
    throw new Error('PUBLIC_ADDRESS_INTERVAL_MS must be at least 60000')
  const update = async (family: 4 | 6) => {
    const key = family === 4 ? 'ipv4' : 'ipv6'
    const checked_at = new Date().toISOString()
    try {
      const address = await detect(
        process.env[
          family === 4
            ? 'PUBLIC_IPV4_DISCOVERY_URL'
            : 'PUBLIC_IPV6_DISCOVERY_URL'
        ] ?? `https://api${family}.ipify.org`,
        family,
        AbortSignal.any([signal, AbortSignal.timeout(6000)]),
      )
      state[key] = {
        address,
        checked_at,
        last_success: checked_at,
        status: 'ready',
        error: null,
      }
    } catch {
      // Preserve the last successful value; failure must not block inventory or expose endpoint details.
      state[key] = {
        ...state[key],
        checked_at,
        status: 'error',
        error: `IPv${family} public address detection unavailable`,
      }
    }
  }
  const work = (async () => {
    while (!signal.aborted) {
      await Promise.allSettled([update(4), update(6)])
      await delay(interval, undefined, { signal }).catch(() => {})
    }
  })()
  return { snapshot: () => structuredClone(state), work }
}
