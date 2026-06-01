import fs from 'fs'
import path from 'path'
import { vibeDir } from './config.js'
import { isTerminal, type RunEvent } from './types.js'

function eventsPath(run_id: string): string {
  return path.join(vibeDir(), 'events', `${run_id}.jsonl`)
}

export function appendEvent(event: RunEvent): void {
  fs.appendFileSync(eventsPath(event.run_id), JSON.stringify(event) + '\n')
}

export function readEvents(run_id: string): RunEvent[] {
  const p = eventsPath(run_id)
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent)
}

export function streamEvents(run_id: string): void {
  const p = eventsPath(run_id)
  let offset = 0

  const flush = (): boolean => {
    if (!fs.existsSync(p)) return false
    const stat = fs.statSync(p)
    if (stat.size <= offset) return false

    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(stat.size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    offset = stat.size

    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      process.stdout.write(line + '\n')
      try {
        const event = JSON.parse(line) as RunEvent
        if (isTerminal(event)) return true
      } catch {
        // skip malformed line
      }
    }
    return false
  }

  if (flush()) return

  const interval = setInterval(() => {
    if (flush()) clearInterval(interval)
  }, 250)

  process.on('SIGINT', () => {
    clearInterval(interval)
    process.exit(0)
  })
}
