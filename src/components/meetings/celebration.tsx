'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const COLOURS = ['#2f8a70', '#50a68b', '#f5b942', '#f59e0b', '#82c4ac', '#e86f5a', '#6d8bd8'];

/**
 * Right after a meeting is saved (owner, 21 Nov 2026: gamified): a burst of confetti when it counts,
 * and a card saying what it did for the month. None of it moves for someone who asked for less motion.
 * The address loses its ?celebrate=1, so a reload does not celebrate twice.
 */
export function Celebration({ title, line, counted, firstMeeting }: { title: string; line: string; counted: boolean; firstMeeting: boolean }) {
  const [open, setOpen] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('celebrate')) { url.searchParams.delete('celebrate'); window.history.replaceState(window.history.state, '', url.toString()); }
    const c = canvas.current;
    if (!counted || !c || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = window.innerWidth * dpr);
    const h = (c.height = window.innerHeight * dpr);
    const n = firstMeeting ? 170 : 110;
    const bits = Array.from({ length: n }, (_, i) => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.25, y: h * 0.62,
      vx: (Math.random() - 0.5) * 14 * dpr, vy: -(9 + Math.random() * 11) * dpr,
      r: (3 + Math.random() * 4) * dpr, spin: Math.random() * Math.PI, vs: (Math.random() - 0.5) * 0.3,
      colour: COLOURS[i % COLOURS.length],
    }));
    let frame = 0;
    let raf = 0;
    const tick = () => {
      frame++;
      ctx.clearRect(0, 0, w, h);
      for (const b of bits) {
        b.vy += 0.38 * dpr; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.spin += b.vs;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.spin);
        ctx.globalAlpha = Math.max(0, 1 - frame / 150);
        ctx.fillStyle = b.colour; ctx.fillRect(-b.r, -b.r / 2, b.r * 2, b.r);
        ctx.restore();
      }
      if (frame < 150) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [counted, firstMeeting]);

  return (
    <>
      <canvas ref={canvas} aria-hidden className="pointer-events-none fixed inset-0 z-[60] h-full w-full" />
      {open ? (
        <div role="status" className="fixed inset-x-4 bottom-5 z-[61] mx-auto max-w-md sm:inset-x-auto sm:left-1/2 sm:w-[28rem] sm:-translate-x-1/2">
          <div className="celebrate-in surface flex items-start gap-3 p-4 shadow-[0_18px_40px_-18px_rgba(25,43,41,0.45)]">
            <span aria-hidden className="mt-0.5 text-[26px] leading-none">{counted ? (firstMeeting ? '🤝' : '🎉') : '⏳'}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-ink-900">{title}</p>
              <p className="mt-0.5 text-[12.5px] text-ink-600">{line}</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Link href="/meetings" className="btn-primary btn-sm">See the scoreboard</Link>
                <Link href="/meetings/new" className="btn-secondary btn-sm">Add another</Link>
              </div>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost btn-sm -mr-1 -mt-1 px-2" aria-label="Close">✕</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
