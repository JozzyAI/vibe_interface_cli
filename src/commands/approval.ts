import { Command } from 'commander'

export function registerApprovalCommand(program: Command): void {
  const approval = program.command('approval').description('Approval management commands')

  approval
    .command('respond')
    .description('Respond to a pending approval request on a remote run')
    .requiredOption('--run-id <id>', 'Run ID')
    .requiredOption('--approval-id <id>', 'Approval ID (from the approval_required event)')
    .requiredOption('--decision <decision>', 'Decision: approve or deny')
    .option('--message <text>', 'Optional comment')
    .requiredOption('--relay <url>', 'Relay WebSocket URL')
    .requiredOption('--token <token>', 'Relay auth token')
    .action(async (opts: { runId: string; approvalId: string; decision: string; message?: string; relay: string; token: string }) => {
      if (opts.decision !== 'approve' && opts.decision !== 'deny') {
        process.stderr.write('Error: --decision must be "approve" or "deny"\n')
        process.exit(1)
      }

      const { remoteApprovalRespond } = await import('../relay/client.js')
      try {
        await remoteApprovalRespond(
          opts.relay,
          opts.token,
          opts.runId,
          opts.approvalId,
          opts.decision as 'approve' | 'deny',
          opts.message,
        )
        process.stdout.write(JSON.stringify({ ok: true, run_id: opts.runId, approval_id: opts.approvalId, decision: opts.decision }) + '\n')
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`)
        process.exit(1)
      }
    })
}
