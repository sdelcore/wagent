// Argv parsing for `wagent-on`. Pure function — no I/O — so unit tests
// can exercise every flag combination without a process boundary.
//
// Shape:
//   wagent-on <host> [--cwd PATH] [--resume UUID] [--quiet|--verbose]
//             [--json] [--model MODEL] [--max-bytes N] "<prompt>"
//
// `<prompt>` may be `-` (read from stdin); the caller (entry point) is
// responsible for the actual stdin read so this module stays pure.

export interface ParsedArgs {
  host: string
  prompt: string
  cwd: string | undefined
  resume: string | undefined
  model: string | undefined
  quiet: boolean
  verbose: boolean
  json: boolean
  maxBytes: number
}

export const DEFAULT_MAX_BYTES = 65_536

const USAGE = `usage: wagent-on <host> [--cwd PATH] [--resume UUID] [--quiet|--verbose]
                [--json] [--model MODEL] [--max-bytes N] "<prompt>"`

export class ArgsError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`)
    this.name = 'ArgsError'
  }
}

// Lifts a `--flag=value` form into separate tokens so the loop below
// only ever has to deal with the spaced form. Leaves bare `--flag`
// alone.
function normalize(argv: string[]): string[] {
  const out: string[] = []
  for (const tok of argv) {
    if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=')
      out.push(tok.slice(0, eq), tok.slice(eq + 1))
    } else {
      out.push(tok)
    }
  }
  return out
}

function takeValue(name: string, argv: string[], i: number): string {
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) {
    throw new ArgsError(`flag ${name} requires a value`)
  }
  return next
}

export function parseArgs(rawArgv: string[]): ParsedArgs {
  const argv = normalize(rawArgv)
  const positional: string[] = []
  let cwd: string | undefined
  let resume: string | undefined
  let model: string | undefined
  let quiet = false
  let verbose = false
  let json = false
  let maxBytes = DEFAULT_MAX_BYTES

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    switch (tok) {
      case '-h':
      case '--help':
        throw new ArgsError('help requested')
      case '--cwd':
        cwd = takeValue('--cwd', argv, i)
        i++
        break
      case '--resume':
        resume = takeValue('--resume', argv, i)
        i++
        break
      case '--model':
        model = takeValue('--model', argv, i)
        i++
        break
      case '--max-bytes': {
        const raw = takeValue('--max-bytes', argv, i)
        const n = Number.parseInt(raw, 10)
        if (!Number.isFinite(n) || n <= 0) {
          throw new ArgsError(`--max-bytes must be a positive integer (got ${raw})`)
        }
        maxBytes = n
        i++
        break
      }
      case '--quiet':
        quiet = true
        break
      case '--verbose':
        verbose = true
        break
      case '--json':
        json = true
        break
      case '--':
        // Everything after `--` is positional. Useful when the prompt
        // itself starts with `--`.
        for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]!)
        i = argv.length
        break
      default:
        if (tok.startsWith('--')) {
          throw new ArgsError(`unknown flag: ${tok}`)
        }
        positional.push(tok)
    }
  }

  if (quiet && verbose) {
    throw new ArgsError('--quiet and --verbose are mutually exclusive')
  }

  if (positional.length < 2) {
    throw new ArgsError('expected a host and a prompt')
  }
  if (positional.length > 2) {
    throw new ArgsError(`unexpected extra arguments: ${positional.slice(2).join(' ')}`)
  }

  return {
    host: positional[0]!,
    prompt: positional[1]!,
    cwd,
    resume,
    model,
    quiet,
    verbose,
    json,
    maxBytes,
  }
}

export function helpText(): string {
  return USAGE
}
