export function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function makeStoreId() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `STORE_${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
