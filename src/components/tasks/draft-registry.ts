'use client';
const writers = new Set<() => Promise<boolean>>();
export function registerDraftWriter(writer: () => Promise<boolean>) { writers.add(writer); return () => { writers.delete(writer); }; }
export async function flushTaskDrafts() { const results = await Promise.all([...writers].map(w => w())); return results.every(Boolean); }
