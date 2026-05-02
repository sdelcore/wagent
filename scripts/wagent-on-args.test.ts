// Unit tests for the `wagent-on` argv parser. Pure-function tests — no
// I/O, no fetch, no fs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, ArgsError, DEFAULT_MAX_BYTES } from '../src/cli/on-args.js'

test('parseArgs: minimal positional form', () => {
  const a = parseArgs(['nightman', 'hello'])
  assert.equal(a.host, 'nightman')
  assert.equal(a.prompt, 'hello')
  assert.equal(a.cwd, undefined)
  assert.equal(a.resume, undefined)
  assert.equal(a.model, undefined)
  assert.equal(a.quiet, false)
  assert.equal(a.verbose, false)
  assert.equal(a.json, false)
  assert.equal(a.maxBytes, DEFAULT_MAX_BYTES)
})

test('parseArgs: flags before the prompt', () => {
  const a = parseArgs([
    'nightman',
    '--cwd',
    '/home/user/work',
    '--resume',
    '11111111-2222-3333-4444-555555555555',
    '--model',
    'claude-sonnet-4-5',
    '--max-bytes',
    '1024',
    '--verbose',
    'do the thing',
  ])
  assert.equal(a.host, 'nightman')
  assert.equal(a.prompt, 'do the thing')
  assert.equal(a.cwd, '/home/user/work')
  assert.equal(a.resume, '11111111-2222-3333-4444-555555555555')
  assert.equal(a.model, 'claude-sonnet-4-5')
  assert.equal(a.maxBytes, 1024)
  assert.equal(a.verbose, true)
})

test('parseArgs: --flag=value form is normalized to spaced form', () => {
  const a = parseArgs(['dayman', '--cwd=/srv/app', '--max-bytes=42', 'go'])
  assert.equal(a.cwd, '/srv/app')
  assert.equal(a.maxBytes, 42)
})

test('parseArgs: --json wins as a passthrough mode', () => {
  const a = parseArgs(['nightman', '--json', 'go'])
  assert.equal(a.json, true)
  assert.equal(a.quiet, false)
  assert.equal(a.verbose, false)
})

test('parseArgs: --quiet and --verbose conflict', () => {
  assert.throws(() => parseArgs(['nightman', '--quiet', '--verbose', 'go']), ArgsError)
})

test('parseArgs: stdin sentinel `-` for prompt', () => {
  const a = parseArgs(['nightman', '-'])
  assert.equal(a.prompt, '-')
})

test('parseArgs: missing host + prompt → error', () => {
  assert.throws(() => parseArgs([]), ArgsError)
  assert.throws(() => parseArgs(['nightman']), ArgsError)
})

test('parseArgs: extra positional → error', () => {
  assert.throws(() => parseArgs(['nightman', 'one', 'two']), ArgsError)
})

test('parseArgs: unknown flag → error', () => {
  assert.throws(() => parseArgs(['nightman', '--bogus', 'go']), ArgsError)
})

test('parseArgs: --max-bytes must be a positive integer', () => {
  assert.throws(() => parseArgs(['nightman', '--max-bytes', 'abc', 'go']), ArgsError)
  assert.throws(() => parseArgs(['nightman', '--max-bytes', '0', 'go']), ArgsError)
  assert.throws(() => parseArgs(['nightman', '--max-bytes', '-5', 'go']), ArgsError)
})

test('parseArgs: flag value missing → error', () => {
  assert.throws(() => parseArgs(['nightman', 'go', '--cwd']), ArgsError)
})

test('parseArgs: `--` ends flag parsing so prompts can start with --', () => {
  const a = parseArgs(['nightman', '--', '--this-is-the-prompt'])
  assert.equal(a.host, 'nightman')
  assert.equal(a.prompt, '--this-is-the-prompt')
})

test('parseArgs: -h / --help throw a help-shaped ArgsError', () => {
  assert.throws(() => parseArgs(['--help']), ArgsError)
  assert.throws(() => parseArgs(['-h']), ArgsError)
})
