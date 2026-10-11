// Echo worker fixture for WorkerSandbox round-trip tests. Receives the
// transferred MessagePort through workerData and answers governance requests.
import { workerData } from 'node:worker_threads'

const port = workerData.port

port.on('message', (msg) => {
  if (msg.type !== 'request') return
  if (msg.path === 'sandbox-error') {
    port.postMessage({ type: 'response', id: msg.id, error: 'injected failure' })
    return
  }
  if (msg.path === 'sandbox-silence') {
    // No reply on purpose: exercises the IPC timeout path in the parent.
    return
  }
  if (msg.path === 'sandbox-junk') {
    // Non-object payloads must be swallowed by the parent's guard.
    port.postMessage('not-an-envelope')
    return
  }
  if (msg.path === 'sandbox-unknown-id') {
    // A well-formed response for an id nobody is waiting on.
    port.postMessage({ type: 'response', id: 999999, result: 'orphan' })
    return
  }
  if (msg.path === 'sandbox-not-a-response') {
    // An object envelope without the response type must be ignored by the parent.
    port.postMessage({ kind: 'other' })
    return
  }
  port.postMessage({
    type: 'response',
    id: msg.id,
    result: `${String(msg.type)}:${String(msg.path)}`,
  })
})
