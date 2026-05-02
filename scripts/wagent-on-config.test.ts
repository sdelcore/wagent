// Unit tests for the `wagent-on` host registry: TOML parsing + auth
// resolution from env / file with stubbed fs and env.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHostsToml,
  resolveHost,
  knownHosts,
  defaultHostsPath,
  type FsLike,
  type EnvLike,
  type HostsConfig,
} from '../src/cli/on-config.js'

function fakeFs(files: Record<string, string>): FsLike {
  return {
    readFileSync: (p) => {
      const v = files[p]
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
  }
}

function fakeEnv(vars: Record<string, string | undefined>): EnvLike {
  return {
    get: (name) => vars[name],
  }
}

test('parseHostsToml: empty file → no hosts', () => {
  const cfg = parseHostsToml('')
  assert.deepEqual(cfg.hosts, {})
})

test('parseHostsToml: minimal host with just a url', () => {
  const cfg = parseHostsToml(`
    [hosts.dayman]
    url = "http://dayman.tail.ts.net:2468"
  `)
  assert.equal(cfg.hosts.dayman?.url, 'http://dayman.tail.ts.net:2468')
})

test('parseHostsToml: full host with default_cwd + auth_token_env', () => {
  const cfg = parseHostsToml(`
    [hosts.nightman]
    url = "http://nightman.tail.ts.net:2468"
    default_cwd = "/home/sdelcore/src"
    auth_token_env = "WAGENT_NIGHTMAN_TOKEN"
  `)
  const e = cfg.hosts.nightman!
  assert.equal(e.url, 'http://nightman.tail.ts.net:2468')
  assert.equal(e.default_cwd, '/home/sdelcore/src')
  assert.equal(e.auth_token_env, 'WAGENT_NIGHTMAN_TOKEN')
})

test('parseHostsToml: missing url → error mentions the host name', () => {
  assert.throws(
    () => parseHostsToml('[hosts.bad]\ndefault_cwd = "/x"'),
    /hosts\.bad: missing required string `url`/,
  )
})

test('parseHostsToml: wrong type on a string field → error', () => {
  assert.throws(
    () => parseHostsToml('[hosts.bad]\nurl = 42'),
    // TOML numbers won't parse into a string `url`. Either the TOML
    // parser or our type check rejects this; both outcomes are fine.
    /url|invalid/i,
  )
})

test('resolveHost: unknown host → null', () => {
  const cfg = parseHostsToml('[hosts.nightman]\nurl = "http://nightman:2468"')
  const r = resolveHost(cfg, 'mystery', undefined, { fs: fakeFs({}), env: fakeEnv({}) })
  assert.equal(r, null)
})

test('resolveHost: trailing slashes on url are stripped', () => {
  const cfg = parseHostsToml('[hosts.nightman]\nurl = "http://nightman:2468///"')
  const r = resolveHost(cfg, 'nightman', '/work', { fs: fakeFs({}), env: fakeEnv({}) })
  assert.equal(r?.url, 'http://nightman:2468')
})

test('resolveHost: --cwd overrides default_cwd', () => {
  const cfg = parseHostsToml(`
    [hosts.nightman]
    url = "http://nightman:2468"
    default_cwd = "/default"
  `)
  const r = resolveHost(cfg, 'nightman', '/override', { fs: fakeFs({}), env: fakeEnv({}) })
  assert.equal(r?.cwd, '/override')
})

test('resolveHost: default_cwd used when --cwd absent', () => {
  const cfg = parseHostsToml(`
    [hosts.nightman]
    url = "http://nightman:2468"
    default_cwd = "/default"
  `)
  const r = resolveHost(cfg, 'nightman', undefined, { fs: fakeFs({}), env: fakeEnv({}) })
  assert.equal(r?.cwd, '/default')
})

test('resolveHost: cwd undefined when neither --cwd nor default_cwd set', () => {
  const cfg = parseHostsToml('[hosts.h]\nurl = "http://h:2468"')
  const r = resolveHost(cfg, 'h', undefined, { fs: fakeFs({}), env: fakeEnv({}) })
  assert.equal(r?.cwd, undefined)
})

test('resolveHost: auth_token_env present → uses env value', () => {
  const cfg = parseHostsToml(`
    [hosts.h]
    url = "http://h:2468"
    auth_token_env = "MY_TOK"
  `)
  const r = resolveHost(cfg, 'h', '/x', {
    fs: fakeFs({}),
    env: fakeEnv({ MY_TOK: 'super-secret' }),
  })
  assert.equal(r?.authToken, 'super-secret')
})

test('resolveHost: auth_token_env wins over auth_token_file when both set', () => {
  const cfg = parseHostsToml(`
    [hosts.h]
    url = "http://h:2468"
    auth_token_env = "MY_TOK"
    auth_token_file = "/run/secrets/h"
  `)
  const r = resolveHost(cfg, 'h', '/x', {
    fs: fakeFs({ '/run/secrets/h': 'from-file\n' }),
    env: fakeEnv({ MY_TOK: 'from-env' }),
  })
  assert.equal(r?.authToken, 'from-env')
})

test('resolveHost: falls back to auth_token_file when env var missing', () => {
  const cfg = parseHostsToml(`
    [hosts.h]
    url = "http://h:2468"
    auth_token_env = "MY_TOK"
    auth_token_file = "/run/secrets/h"
  `)
  const r = resolveHost(cfg, 'h', '/x', {
    fs: fakeFs({ '/run/secrets/h': 'from-file\n' }),
    env: fakeEnv({}),
  })
  assert.equal(r?.authToken, 'from-file')
})

test('resolveHost: trailing whitespace stripped from token file', () => {
  const cfg = parseHostsToml(`
    [hosts.h]
    url = "http://h:2468"
    auth_token_file = "/run/secrets/h"
  `)
  const r = resolveHost(cfg, 'h', '/x', {
    fs: fakeFs({ '/run/secrets/h': 'tok-from-file   \n\n' }),
    env: fakeEnv({}),
  })
  assert.equal(r?.authToken, 'tok-from-file')
})

test('resolveHost: empty env var value falls through to file', () => {
  const cfg = parseHostsToml(`
    [hosts.h]
    url = "http://h:2468"
    auth_token_env = "MY_TOK"
    auth_token_file = "/run/secrets/h"
  `)
  const r = resolveHost(cfg, 'h', '/x', {
    fs: fakeFs({ '/run/secrets/h': 'from-file' }),
    env: fakeEnv({ MY_TOK: '' }),
  })
  assert.equal(r?.authToken, 'from-file')
})

test('resolveHost: no auth configured → undefined token', () => {
  const cfg = parseHostsToml('[hosts.h]\nurl = "http://h:2468"')
  const r = resolveHost(cfg, 'h', '/x', { fs: fakeFs({}), env: fakeEnv({}) })
  assert.equal(r?.authToken, undefined)
})

test('knownHosts: returns sorted host names', () => {
  const cfg: HostsConfig = parseHostsToml(`
    [hosts.zulu]
    url = "http://zulu:2468"
    [hosts.alpha]
    url = "http://alpha:2468"
    [hosts.mike]
    url = "http://mike:2468"
  `)
  assert.deepEqual(knownHosts(cfg), ['alpha', 'mike', 'zulu'])
})

test('defaultHostsPath: respects XDG_CONFIG_HOME', () => {
  const path = defaultHostsPath(fakeEnv({ XDG_CONFIG_HOME: '/etc/xdg' }))
  assert.equal(path, '/etc/xdg/wagent/hosts.toml')
})

test('defaultHostsPath: falls back to $HOME/.config when XDG unset', () => {
  const path = defaultHostsPath(fakeEnv({}))
  // Don't pin to a real homedir — just check the suffix.
  assert.match(path, /\/\.config\/wagent\/hosts\.toml$/)
})
