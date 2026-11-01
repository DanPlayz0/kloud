export class EnvironmentSyntaxError extends Error {
  line: number
}
export interface EnvironmentChanges {
  added: string[]
  changed: string[]
  removed: string[]
}
export function parseEnvironment(text: string): Record<string, string>
export function formatEnvironment(values: Record<string, string>): string
export function environmentChanges(
  previous: Record<string, string>,
  next: Record<string, string>,
): EnvironmentChanges
