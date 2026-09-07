/** Read only complete application-owned audit records, not raw SDK messages. */
export function cancellationObservations(text) {
  const observed = { response: false, checkpoint: false };
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const event = payload?.event;
    if (event?.type === 'message_end' && event.role === 'assistant'
      && event.stopReason !== 'error' && event.usage?.output > 0) observed.response = true;
    if (event?.type === 'tool_execution_end' && event.toolName === 'write_map_delta'
      && event.isError === false) observed.checkpoint = true;
  }
  return observed;
}
