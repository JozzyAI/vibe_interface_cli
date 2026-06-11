const PR_URL_PATTERN = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g

/**
 * Find a GitHub PR URL in agent output text. If multiple URLs are present
 * (e.g. the agent restates the link across several lines), the last match
 * wins, matching "final state" semantics for which PR the agent ended up on.
 */
export function detectPrUrl(text: string): string | undefined {
  const matches = text.match(PR_URL_PATTERN)
  if (!matches || matches.length === 0) return undefined
  return matches[matches.length - 1]
}
