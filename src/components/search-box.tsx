'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The text of a search box that lives in the URL.
 *
 * The box owns what is typed. The URL follows it after a pause, and the box follows the URL only
 * when the URL changed for a reason other than the box itself - a chip removed, a Reset, the back
 * button. The old version adopted the URL every time it changed, which meant that when the page
 * came back from the debounce push, it overwrote whatever had been typed during the round trip:
 * letters vanished as people typed. Every search box in the workspace goes through this hook.
 */
export function useSearchBox(current: string, commit: (value: string | null) => void, debounceMs = 350) {
  const [text, setText] = useState(current);
  // The last value this box sent to the URL. When the URL comes back equal to it, nothing moved.
  const sent = useRef(current);

  useEffect(() => {
    if (current === sent.current) return;
    sent.current = current;
    setText(current);
  }, [current]);

  useEffect(() => {
    if (text === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = text;
      commit(text || null);
    }, debounceMs);
    return () => clearTimeout(timer);
    // `commit` is recreated by its toolbar on every render; the text is the only real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, debounceMs]);

  /** Clear the box and forget what it sent, so a Reset that also clears the URL is not undone. */
  const reset = () => {
    sent.current = '';
    setText('');
  };

  return { text, setText, reset };
}
