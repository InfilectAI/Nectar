declare module 'ws' {
  import type { EventEmitter } from 'node:events'
  import type { ClientRequest, IncomingMessage } from 'node:http'

  export interface ClientOptions {
    headers?: Record<string, string>
    handshakeTimeout?: number
  }

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0
    static readonly OPEN: 1
    static readonly CLOSING: 2
    static readonly CLOSED: 3

    readonly readyState: number

    constructor(address: string, options?: ClientOptions)

    send(data: string | Buffer | Uint8Array): void
    close(code?: number, data?: string): void
    terminate(): void

    on(event: 'open', listener: () => void): this
    on(event: 'message', listener: (data: Buffer | string) => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(
      event: 'unexpected-response',
      listener: (req: ClientRequest, res: IncomingMessage) => void,
    ): this
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  export default WebSocket
}
