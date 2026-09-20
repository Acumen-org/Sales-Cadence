import { expect, test } from '@playwright/test';

test('an uploaded VTT follows real media playback and timestamps seek the player', async ({ page }) => {
  // A silent 12-second WAV: exercise a real browser media clock without external recordings.
  const samples = 8000 * 12;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await page.route('https://recordings.example.test/sample.wav', route => route.fulfill({ contentType: 'audio/wav', body: wav }));
  await page.goto('/login');
  await page.getByLabel('Email').fill('alisa@cadence.local'); await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: /^Sign in/ }).click(); await page.waitForURL(/home/);
  await page.goto('/meetings/new');
  await page.getByLabel('Title', { exact: true }).fill('Playback regression');
  await page.getByLabel('Recording or meeting link').fill('https://recordings.example.test/sample.wav');
  await page.getByLabel('Date and time').fill('2026-09-20T10:00');
  await page.locator('input[type=file]').setInputFiles({ name: 'meeting.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n<v Alisa>First statement.\n\n00:00:05.000 --> 00:00:11.000\n<v Prospect>Second statement.\n') });
  await page.getByRole('button', { name: 'Add meeting', exact: true }).click();
  await expect(page).toHaveURL(/meetings\/(?!new)/);
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '0:05', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(5);
  await expect(page.locator('[data-cue="1"]')).toHaveClass(/bg-brand/);
  await expect(page.locator('[data-cue="1"]')).toContainText('Prospect:');
  await expect(page.getByText('Following playback', { exact: true })).toBeVisible();
});
