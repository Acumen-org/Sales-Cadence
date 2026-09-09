/** Keep login return paths on this origin, including after URL normalization. */
export function safeReturnPath(value: string | undefined): string {
  if (!value?.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/home';
  try {
    const base = 'https://cadence.invalid';
    const url = new URL(value, base);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : '/home';
  } catch {
    return '/home';
  }
}
