import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { reapProcessGroup } from '../src/agent/process_group.js'

test('reapProcessGroup kills descendants after the group leader exits', async () => {
  const leader = spawn(
    process.execPath,
    ['-e', "const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();"],
    { detached: true, stdio: 'ignore' },
  )
  const pgid = leader.pid!
  await new Promise<void>((resolve) => leader.once('exit', () => resolve()))
  assert.equal(await reapProcessGroup(pgid, leader, 100), true)
  assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' })
})
