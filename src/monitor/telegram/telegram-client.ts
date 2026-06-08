/**
 * Minimal Telegram Bot API wrapper — sendMessage + long-poll getUpdates via
 * the global fetch. Strictly an I/O edge: no command interpretation here (see
 * monitor.ts), and every error path redacts the bot token before it can reach
 * a log line or thrown message.
 */
import { redactSecrets } from './secrets.js'

export interface TelegramMessage {
  update_id: number
  chat_id: string
  text: string
}

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

interface RawUpdate {
  update_id: number
  message?: { chat?: { id?: number | string }; text?: string }
}

export class TelegramClient {
  private readonly token: string
  private readonly baseUrl: string

  constructor(token: string) {
    this.token = token
    this.baseUrl = `https://api.telegram.org/bot${token}`
  }

  /** Wraps a fetch+JSON round trip and guarantees the bot token never survives into a thrown message. */
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new Error(redactSecrets(`telegram ${method} request failed: ${(err as Error).message}`, [this.token]))
    }

    let json: TelegramApiResponse<T>
    try {
      json = (await res.json()) as TelegramApiResponse<T>
    } catch {
      throw new Error(`telegram ${method} returned a non-JSON response (status ${res.status})`)
    }

    if (!json.ok) {
      throw new Error(redactSecrets(`telegram ${method} failed: ${json.description ?? `status ${res.status}`}`, [this.token]))
    }
    return json.result as T
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text })
  }

  /**
   * Long-poll for new messages. Only text messages from the configured chat
   * are surfaced — everything else (photos, other chats, edits) is ignored,
   * since this bot never needs to act on anything but plain status commands.
   */
  async getUpdates(offset: number, allowedChatId: string, timeoutSeconds = 25): Promise<TelegramMessage[]> {
    const updates = await this.call<RawUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    })

    const messages: TelegramMessage[] = []
    for (const update of updates) {
      const chatId = update.message?.chat?.id
      const text = update.message?.text
      if (chatId === undefined || text === undefined) continue
      if (String(chatId) !== allowedChatId) continue
      messages.push({ update_id: update.update_id, chat_id: String(chatId), text })
    }
    return messages
  }
}
