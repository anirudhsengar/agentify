/** Read only complete application-owned audit records, not raw SDK messages. */
export function cancellationObservations(text) {
  const observed = { response: false, checkpoint: false, checkpointProof: null };
  const pendingMapWrites = new Set();
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const event = payload?.event;
    if (event?.type === 'message_end' && event.role === 'assistant'
      && event.stopReason !== 'error' && event.usage?.output > 0) observed.response = true;
    if (event?.type === 'tool_execution_start' && event.toolName === 'write_map_delta'
      && typeof event.toolCallId === 'string') pendingMapWrites.add(event.toolCallId);
    if (event?.type === 'tool_execution_end' && event.toolName === 'write_map_delta') {
      pendingMapWrites.delete(event.toolCallId);
      if (event.isError === false) {
        observed.checkpoint = true;
        observed.checkpointProof = 'successful-map-tool-result';
      }
    }
    // The pinned application wrapper can start this scout only after its
    // underlying map write succeeds and actual D1 coverage validates. Its
    // outer tool acknowledgment waits for the scout, so it is not the write
    // boundary. Match the exact pending parent call, never an arbitrary scout.
    const prefix = 'agentify-initial-scout:';
    if (event?.type === 'tool_execution_start' && event.toolName === 'spawn_explorer'
      && typeof event.toolCallId === 'string' && event.toolCallId.startsWith(prefix)
      && pendingMapWrites.has(event.toolCallId.slice(prefix.length))) {
      observed.checkpoint = true;
      observed.checkpointProof = 'application-initial-scout-after-map-write';
    }
  }
  return observed;
}
