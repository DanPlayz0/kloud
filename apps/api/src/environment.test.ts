import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEnvironment,
  formatEnvironment,
  environmentChanges,
} from '@kloud/protocol/environment'

test('environment documents round-trip literal, multiline, empty and escaped values without expansion', () => {
  const values = {
    EMPTY: '',
    TOKEN: '$HOME ${TOKEN} $(touch /tmp/no) `id`',
    MULTILINE: 'a\nb\r\tc',
    QUOTED: '"\\ # literal',
    MASK: '********',
    CONTROL: '\u0000\b\f\v',
    __proto__: 'ignored',
  }
  assert.deepEqual({ ...parseEnvironment(formatEnvironment(values)) }, values)
  assert.equal(
    parseEnvironment(
      '# comment\n A=plain # comment\nB=\'literal $HOME\nline\'\nC="escaped\\nline"\nD=\n',
    ).B,
    'literal $HOME\nline',
  )
  assert.equal(parseEnvironment('A=one#two').A, 'one#two')
  assert.equal(parseEnvironment('__proto__=safe').__proto__, 'safe')
})
test('environment parser rejects duplicate keys and malformed documents with line numbers', () => {
  for (const [text, line] of [
    ['A=x\nA=y', 2],
    ['BAD KEY=value', 1],
    ['A="unterminated', 1],
    ['A="x" trailing', 1],
    ['A="bad\\q"', 1],
  ] as const) {
    assert.throws(() => parseEnvironment(text), new RegExp(`Line ${line}:`))
  }
})
test('full replacement review contains only added/changed/removed names', () => {
  assert.deepEqual(
    environmentChanges(
      { A: 'secret', B: 'old', KEEP: '' },
      { B: 'new', C: 'new', KEEP: '' },
    ),
    { added: ['C'], changed: ['B'], removed: ['A'] },
  )
})

test('formatter round-trips JSON control/unicode escapes and inline empty comments', () => {
  const values = {
    CONTROL: '\b\f\v\u0001',
    UNICODE: 'astral \u{1f600} lone \ud800',
  }
  assert.deepEqual({ ...parseEnvironment(formatEnvironment(values)) }, values)
  assert.equal(parseEnvironment('EMPTY= # comment').EMPTY, '')
  assert.throws(
    () => parseEnvironment('A="\\u12zz"'),
    /Line 1: Expected four hexadecimal digits/,
  )
})
