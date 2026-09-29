import type { FastifyReply, FastifyRequest } from 'fastify'

/** Turn a Fastify reply into an SSE stream. Returns a writer + an abort signal tied to client disconnect. */
export function openSse(req: FastifyRequest, reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.write(': open\n\n')
  const ac = new AbortController()
  // Note: IncomingMessage 'close' fires once the body is consumed in modern Node,
  // so listen on the response: it closes only when the client goes away.
  const onClose = () => { if (!reply.raw.writableFinished) ac.abort() }
  reply.raw.on('close', onClose)
  reply.raw.on('error', onClose)
  const ping = setInterval(() => { try { reply.raw.write(': ping\n\n') } catch {} }, 15_000)
  return {
    signal: ac.signal,
    send(event: string, data: unknown) {
      if (ac.signal.aborted) return
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch {}
    },
    close() {
      clearInterval(ping)
      reply.raw.off('close', onClose)
      try { reply.raw.end() } catch {}
    },
  }
}
