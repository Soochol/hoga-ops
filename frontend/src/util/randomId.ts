/** getRandomValues remains available on HTTP LAN/Tailscale origins as well. */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
