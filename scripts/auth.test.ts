// Unit tests for the bearer-token check + masking helpers in src/auth.ts.
// Pure-function tests — no Fastify, no server boot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkBearer, maskToken } from '../src/auth.js'

test('checkBearer: correct token → true', () => {
  assert.equal(checkBearer('Bearer s3cret', 's3cret'), true)
})

test('checkBearer: case-insensitive scheme → true', () => {
  assert.equal(checkBearer('bearer s3cret', 's3cret'), true)
  assert.equal(checkBearer('BEARER s3cret', 's3cret'), true)
})

test('checkBearer: wrong token same length → false', () => {
  assert.equal(checkBearer('Bearer abcdef', 'fedcba'), false)
})

test('checkBearer: wrong token different length → false', () => {
  assert.equal(checkBearer('Bearer abc', 's3cret'), false)
  assert.equal(checkBearer('Bearer s3cret-extra', 's3cret'), false)
})

test('checkBearer: missing header → false', () => {
  assert.equal(checkBearer(undefined, 's3cret'), false)
  assert.equal(checkBearer('', 's3cret'), false)
})

test('checkBearer: malformed (no Bearer prefix) → false', () => {
  assert.equal(checkBearer('s3cret', 's3cret'), false)
  assert.equal(checkBearer('Basic s3cret', 's3cret'), false)
  assert.equal(checkBearer('Token s3cret', 's3cret'), false)
})

test('checkBearer: Bearer with no token → false', () => {
  assert.equal(checkBearer('Bearer ', 's3cret'), false)
  assert.equal(checkBearer('Bearer', 's3cret'), false)
})

test('checkBearer: empty expected token never matches', () => {
  // Defense-in-depth — should never happen in practice (we don't mount
  // the hook unless config.token is truthy) but verify the helper isn't
  // foot-gun-able.
  assert.equal(checkBearer('Bearer ', ''), false)
  assert.equal(checkBearer('Bearer x', ''), false)
})

test('maskToken: long token → first 4 chars + ellipsis', () => {
  assert.equal(maskToken('Bearer s3cret-token-abc'), 's3cr…')
})

test('maskToken: short token → minimal hint', () => {
  assert.equal(maskToken('Bearer ab'), 'a…')
  assert.equal(maskToken('Bearer abcd'), 'a…')
})

test('maskToken: missing/malformed → safe placeholder', () => {
  assert.equal(maskToken(undefined), '<missing>')
  assert.equal(maskToken(''), '<missing>')
  assert.equal(maskToken('Basic xxx'), '<malformed>')
  assert.equal(maskToken('garbage'), '<malformed>')
})
