import Bluebird from 'bluebird'
import Debug from 'debug'
import _ from 'lodash'
import Marionette from './marionette-client/lib/marionette'
import { Command } from './marionette-client/lib/marionette/message.js'
import util from 'util'
import Foxdriver from '@benmalka/foxdriver'
import * as protocol from './protocol'
import { CdpAutomation } from './cdp_automation'
import { BrowserCriClient } from './browser-cri-client'
import type { Automation } from '../automation'
import { BidiAutomation } from './bidi_automation'

const errors = require('../errors')

const debug = Debug('cypress:server:browsers:firefox-util')

let forceGcCc: () => Promise<void>

let timings = {
  gc: [] as any[],
  cc: [] as any[],
  collections: [] as any[],
}

let driver
let bidiAutomation
let foxdriver

const sendMarionette = (data) => {
  return driver.send(new Command(data))
}

const getTabId = (tab) => {
  return _.get(tab, 'browsingContextID')
}

const getDelayMsForRetry = (i) => {
  let maxRetries = Number.parseInt(process.env.CYPRESS_CONNECT_RETRY_THRESHOLD ? process.env.CYPRESS_CONNECT_RETRY_THRESHOLD : '62')

  if (i < 10) {
    return 100
  }

  if (i < 18) {
    return 500
  }

  if (i <= maxRetries) {
    return 1000
  }

  return
}

const getPrimaryTab = Bluebird.method((browser) => {
  const setPrimaryTab = () => {
    return browser.listTabs()
    .then((tabs) => {
      browser.tabs = tabs

      return browser.primaryTab = _.first(tabs)
    })
  }

  // on first connection
  if (!browser.primaryTab) {
    return setPrimaryTab()
  }

  // `listTabs` will set some internal state, including marking attached tabs
  // as detached. so use the raw `request` here:
  return browser.request('listTabs')
  .then(({ tabs }) => {
    const firstTab = _.first(tabs)

    // primaryTab has changed, get all tabs and rediscover first tab
    if (getTabId(browser.primaryTab.data) !== getTabId(firstTab)) {
      return setPrimaryTab()
    }

    return browser.primaryTab
  })
})

const attachToTabMemory = Bluebird.method((tab) => {
  // TODO: figure out why tab.memory is sometimes undefined
  if (!tab.memory) return

  if (tab.memory.isAttached) {
    return
  }

  return tab.memory.getState()
  .then((state) => {
    if (state === 'attached') {
      return
    }

    tab.memory.on('garbage-collection', ({ data }) => {
      data.num = timings.collections.length + 1
      timings.collections.push(data)
      debug('received garbage-collection event %o', data)
    })

    return tab.memory.attach()
  })
})

async function connectMarionetteToNewTab () {
  // Firefox keeps a blank tab open in versions of Firefox 123 and lower when the last tab is closed.
  // For versions 124 and above, a new tab is not created, so @packages/extension creates one for us.
  // Since the tab is always available on our behalf,
  // we can connect to it here and navigate it to about:blank to set it up for CDP connection
  const handles = await sendMarionette({
    name: 'WebDriver:GetWindowHandles',
  })

  await sendMarionette({
    name: 'WebDriver:SwitchToWindow',
    parameters: { handle: handles[0] },
  })

  await navigateToUrl('about:blank')
}

async function connectToNewSpec (options, automation: Automation, browserCriClient: BrowserCriClient) {
  debug('firefox: reconnecting to blank tab')

  await connectMarionetteToNewTab()

  debug('firefox: reconnecting CDP')

  await browserCriClient.currentlyAttachedTarget?.close().catch(() => {})
  const pageCriClient = await browserCriClient.attachToTargetUrl('about:blank')

  await CdpAutomation.create(pageCriClient.send, pageCriClient.on, pageCriClient.off, browserCriClient.resetBrowserTargets, automation)

  await options.onInitializeNewBrowserTab()

  debug(`firefox: navigating to ${options.url}`)
  await navigateToUrl(options.url)
}

async function setupRemote (remotePort, automation, onError): Promise<BrowserCriClient> {
  const browserCriClient = await BrowserCriClient.create({ hosts: ['127.0.0.1', '::1'], port: remotePort, browserName: 'Firefox', onAsynchronousError: onError, onServiceWorkerClientEvent: automation.onServiceWorkerClientEvent })
  const pageCriClient = await browserCriClient.attachToTargetUrl('about:blank')

  await CdpAutomation.create(pageCriClient.send, pageCriClient.on, pageCriClient.off, browserCriClient.resetBrowserTargets, automation)

  return browserCriClient
}

async function navigateToUrl (url) {
  await sendMarionette({
    name: 'WebDriver:Navigate',
    parameters: { url },
  })
}

const logGcDetails = () => {
  const reducedTimings = {
    ...timings,
    collections: _.map(timings.collections, (event) => {
      return _
      .chain(event)
      .extend({
        duration: _.sumBy(event.collections, (collection: any) => {
          return collection.endTimestamp - collection.startTimestamp
        }),
        spread: _.chain(event.collections).thru((collection) => {
          const first = _.first(collection)
          const last = _.last(collection)

          return last.endTimestamp - first.startTimestamp
        }).value(),
      })
      .pick('num', 'nonincrementalReason', 'reason', 'gcCycleNumber', 'duration', 'spread')
      .value()
    }),
  }

  debug('forced GC timings %o', util.inspect(reducedTimings, {
    breakLength: Infinity,
    maxArrayLength: Infinity,
  }))

  debug('forced GC times %o', {
    gc: reducedTimings.gc.length,
    cc: reducedTimings.cc.length,
    collections: reducedTimings.collections.length,
  })

  debug('forced GC averages %o', {
    gc: _.chain(reducedTimings.gc).sum().divide(reducedTimings.gc.length).value(),
    cc: _.chain(reducedTimings.cc).sum().divide(reducedTimings.cc.length).value(),
    collections: _.chain(reducedTimings.collections).sumBy('duration').divide(reducedTimings.collections.length).value(),
    spread: _.chain(reducedTimings.collections).sumBy('spread').divide(reducedTimings.collections.length).value(),
  })

  debug('forced GC totals %o', {
    gc: _.sum(reducedTimings.gc),
    cc: _.sum(reducedTimings.cc),
    collections: _.sumBy(reducedTimings.collections, 'duration'),
    spread: _.sumBy(reducedTimings.collections, 'spread'),
  })

  // reset all the timings
  timings = {
    gc: [],
    cc: [],
    collections: [],
  }
}

export default {
  log () {
    logGcDetails()
  },

  collectGarbage () {
    return forceGcCc()
  },

  async setup ({
    automation,
    extensions,
    onError,
    url,
    marionettePort,
    biDiWebSocketUrl,
    foxdriverPort,
    remotePort,
  }): Bluebird<BrowserCriClient> {
    await this.setupWebDriverBiDi(biDiWebSocketUrl)
    await this.setupFoxdriver(foxdriverPort, extensions)
    debugger
    await this.setupMarionette(extensions, url, marionettePort)

    return Bluebird.all([
      // this.setupFoxdriver(foxdriverPort, extensions),
      // this.setupMarionette(extensions, url, marionettePort),
      remotePort && setupRemote(remotePort, automation, onError),
    ]).then(([browserCriClient]) => navigateToUrl(url).then(() => browserCriClient))
  },

  connectToNewSpec,

  navigateToUrl,

  setupRemote,

  async setupFoxdriver (port, extensions) {
    await protocol._connectAsync({
      host: '127.0.0.1',
      port,
      getDelayMsForRetry,
    })

    foxdriver = await Foxdriver.attach('127.0.0.1', port)

    // await foxdriver.tabs[0].console.startListeners()
    // // wait until page is loaded
    // await new Promise((resolve) => setTimeout(resolve, 3000))
    // // receive logs and page errors
    // const logs = await foxdriver.tabs[0].console.getCachedMessages()

    // console.log(logs)

    const { browser } = foxdriver

    // extensions.forEach((extension) => {
    //   debugger
    //   browser.addons.installTemporaryAddon
    //   // debugger
    //   // launchOptions.args = launchOptions.args.concat([
    //   //   '-install-global-extension',
    //   //   extension,
    //   // ])
    // })
    // write the extension???
    // const a = [0, 5, 'Addon:Install', {
    //   path: extensions[0],
    //   temporary: true,
    // }]

    // browser.client.socket.write(JSON.stringify(a), 'utf8')
    browser.on('error', (err) => {
      debug('received error from foxdriver connection, ignoring %o', err)
    })

    forceGcCc = () => {
      let gcDuration; let ccDuration

      const gc = (tab) => {
        return () => {
          // TODO: figure out why tab.memory is sometimes undefined
          if (!tab.memory) return

          const start = Date.now()

          return tab.memory.forceGarbageCollection()
          .then(() => {
            gcDuration = Date.now() - start
            timings.gc.push(gcDuration)
          })
        }
      }

      const cc = (tab) => {
        return () => {
          // TODO: figure out why tab.memory is sometimes undefined
          if (!tab.memory) return

          const start = Date.now()

          return tab.memory.forceCycleCollection()
          .then(() => {
            ccDuration = Date.now() - start
            timings.cc.push(ccDuration)
          })
        }
      }

      debug('forcing GC and CC...')

      return getPrimaryTab(browser)
      .then((tab) => {
        return attachToTabMemory(tab)
        .then(gc(tab))
        .then(cc(tab))
      })
      .then(() => {
        debug('forced GC and CC completed %o', { ccDuration, gcDuration })
      })
      .tapCatch((err) => {
        debug('firefox RDP error while forcing GC and CC %o', err)
      })
    }
  },

  async setupWebDriverBiDi (webSocketUrl: string) {
    bidiAutomation = await BidiAutomation.create(webSocketUrl)
    await bidiAutomation.createNewSession()
  },

  async setupMarionette (extensions, url, port) {
    const host = '127.0.0.1'

    debugger
    await protocol._connectAsync({
      host,
      port,
      getDelayMsForRetry,
    })

    //  bidiAutomation = await BidiAutomation.create(host, port)

    driver = new Marionette.Drivers.Promises({
      port,
      tries: 1, // marionette-client has its own retry logic which we want to avoid
    })

    debug('firefox: navigating page with webdriver')

    const onError = (from, reject?) => {
      if (!reject) {
        reject = (err) => {
          throw err
        }
      }

      return (err) => {
        debug('error in marionette %o', { from, err })
        reject(errors.get('FIREFOX_MARIONETTE_FAILURE', from, err))
      }
    }

    debugger
    await driver.connect()
    .catch(onError('connection'))

    debugger
    // await new Bluebird((resolve, reject) => {
    // const _onError = (from) => {
    //   return onError(from, reject)
    // }

    // const { tcp } = driver

    // tcp.socket.on('error', _onError('Socket'))
    // tcp.client.on('error', _onError('CommandStream'))

    // sendMarionette({
    //   name: 'WebDriver:NewSession',
    //   parameters: { acceptInsecureCerts: true },
    // }).then(() => {
    return Bluebird.all(_.map(extensions, (path) => {
      debugger

      return sendMarionette({
        name: 'Addon:Install',
        parameters: { path, temporary: true },
      })
    }))
    // })
    // .then(resolve)
    // .catch(_onError('commands'))
    // })

    // even though Marionette is not used past this point, we have to keep the session open
    // or else `acceptInsecureCerts` will cease to apply and SSL validation prompts will appear.
  },
}
