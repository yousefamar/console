import { hubHealth } from '../client.js'
import { output, type GlobalFlags } from '../output.js'

export async function status(flags: GlobalFlags): Promise<void> {
  const health = await hubHealth()
  output(health, flags)
}

export function version(flags: GlobalFlags): void {
  output({ version: '0.1.0', name: 'con' }, flags)
}
