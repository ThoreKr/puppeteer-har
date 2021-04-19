import { harFromMessages } from "chrome-har"
import { Page } from "puppeteer"
import { Har } from "har-format"

// event types to observe
const page_observe = [
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Page.frameStartedLoading",
  "Page.frameAttached",
  "Page.frameScheduledNavigation",
]

const network_observe = [
  "Network.requestWillBeSent",
  "Network.requestServedFromCache",
  "Network.dataReceived",
  "Network.responseReceived",
  "Network.resourceChangedPriority",
  "Network.loadingFinished",
  "Network.loadingFailed",
]

type CaptureOptions = {
  saveResponses?: boolean
  captureMimeTypes?: string[]
}

type PageEvent = {
  method: string
  params: unknown
}

type NetworkEvent = {
  method: string
  params: unknown
}

type StopFn = () => Promise<Har>

export async function captureNetwork(
  page: Page,
  {
    saveResponses = false,
    captureMimeTypes = ["text/html", "application/json"],
  }: CaptureOptions = {}
): Promise<StopFn> {
  let inProgress = true

  const page_events: PageEvent[] = []
  const network_events: NetworkEvent[] = []

  const pendingRequests: Promise<void>[] = []

  const client = await page.target().createCDPSession()

  await client.send("Page.enable")
  await client.send("Network.enable")

  page_observe.forEach((method) => {
    client.on(method, (params) => {
      if (!inProgress) {
        return
      }

      page_events.push({ method, params })
    })
  })

  network_observe.forEach((method) => {
    client.on(method, async (params) => {
      if (!inProgress) {
        return
      }

      network_events.push({ method, params })

      if (!saveResponses || method !== "Network.responseReceived") {
        return
      }

      const { response, requestId } = params

      // Response body is unavailable for redirects, no-content, image, audio and video responses
      if (
        response.status === 204 ||
        response.headers.location != null ||
        !captureMimeTypes.includes(response.mimeType)
      ) {
        return
      }

      const [pendingRequest, resolve] = createResolvable()

      pendingRequests.push(pendingRequest)

      try {
        const responseBody = await client.send("Network.getResponseBody", {
          requestId,
        })

        // Set the response so `chrome-har` can add it to the HAR
        response.body = Buffer.from(
          responseBody.body,
          responseBody.base64Encoded ? "base64" : undefined
        ).toString()
      } catch (e) {
        // Resources (i.e. response bodies) are flushed after page commits
        // navigation and we are no longer able to retrieve them. In this
        // case, fail soft so we still add the rest of the response to the
        // HAR. Possible option would be force wait before navigation...
      } finally {
        resolve()
      }
    })
  })

  return async function getHar(): Promise<Har> {
    inProgress = false

    await client.detach()
    await Promise.all(pendingRequests)

    return harFromMessages(page_events.concat(network_events), {
      includeTextFromResponseBody: saveResponses,
    })
  }
}

type ResolverFn = () => void

const createResolvable = (): [Promise<void>, ResolverFn] => {
  const resolverRef: { current: null | ResolverFn } = { current: null }

  const promise = new Promise<void>((resolve) => {
    resolverRef.current = resolve
  })

  const resolver = () => {
    if (!resolverRef.current) {
      setTimeout(resolver, 1)
    } else {
      resolverRef.current()
    }
  }

  return [promise, resolver]
}
