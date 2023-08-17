import type { CDPClient } from '@packages/types'
import type Protocol from 'devtools-protocol/types/protocol.d'
import { EventEmitter } from 'stream'
import { performance } from 'perf_hooks'

export class CDPSocketServer extends EventEmitter {
  private _cdpClient?: CDPClient
  private _cdpSocket?: CDPSocket
  private _namespace: string
  private _namespaceMap: Record<string, CDPSocketServer> = {}

  constructor ({ namespace = 'default' } = {}) {
    super()

    this._namespace = namespace
  }

  async attachCDPClient (cdpClient: CDPClient): Promise<void> {
    this._cdpClient?.close()

    this._cdpClient = cdpClient

    this._cdpSocket = await CDPSocket.init(cdpClient, this._namespace)

    await Promise.all(Object.values(this._namespaceMap).map(async (server) => {
      return server.attachCDPClient(cdpClient)
    }))

    super.emit('connection', this._cdpSocket)
  }

  emit = (event: string, ...args: any[]) => {
    this._cdpSocket?.emit(event, ...args)

    return true
  }

  of (namespace: string): CDPSocketServer {
    if (!this._namespaceMap[namespace]) {
      this._namespaceMap[namespace] = new CDPSocketServer({ namespace })
    }

    return this._namespaceMap[namespace]
  }

  to (room: string): CDPSocketServer {
    return this
  }

  close (): void {
    throw new Error('Method not implemented.')
  }

  disconnectSockets (close?: boolean): void {
    throw new Error('Method not implemented.')
  }
}

export class CDPSocket extends EventEmitter {
  private _cdpClient: CDPClient
  private _namespace: string

  constructor (cdpClient: CDPClient, namespace: string) {
    super()

    this._cdpClient = cdpClient
    this._namespace = namespace

    this._cdpClient.on('Runtime.bindingCalled', (event: Protocol.Runtime.BindingCalledEvent) => {
      this.processCDPRuntimeBinding(event)
    })
  }

  static async init (cdpClient: CDPClient, namespace: string): Promise<CDPSocket> {
    await cdpClient.send('Runtime.enable')

    await cdpClient.send('Runtime.addBinding', {
      name: `cypressSendToServer-${namespace}`,
    })

    return new CDPSocket(cdpClient, namespace)
  }

  join = (room: string): void => {
    return
  }

  emit = (event: string, ...args: any[]) => {
    const callbackEvent = `${event}-${performance.now()}`
    let callback

    if (typeof args[args.length - 1] === 'function') {
      callback = args.pop()
    }

    const expression = `
      if (window['cypressSocket-${this._namespace}'] && window['cypressSocket-${this._namespace}'].send) {
        window['cypressSocket-${this._namespace}'].send('${event}','${callbackEvent}','${JSON.stringify(args).replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}')
      }
    `

    if (callback) {
      this.once(callbackEvent, callback)
    }

    this._cdpClient.send('Runtime.evaluate', { expression }).catch(() => {})

    return true
  }

  private processCDPRuntimeBinding = (bindingCalledEvent: Protocol.Runtime.BindingCalledEvent) => {
    const { name, payload } = bindingCalledEvent

    if (name !== `cypressSendToServer-${this._namespace}`) {
      return
    }

    // TODO: be smarter about this
    const parsed = JSON.parse(payload)
    const { event, callbackEvent, args } = parsed

    const callback = (...callbackArgs: any[]) => {
      this.emit(callbackEvent, ...callbackArgs)
    }

    super.emit(event, ...args, callback)
  }
}
