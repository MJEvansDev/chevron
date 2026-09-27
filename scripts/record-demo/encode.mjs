// Turns a take (screencast frames, emitted only when something changed) into a GIF: resample to a
// constant frame rate, optionally crop, encode with gifski. PNG screenshots go through pngquant.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Screencast frames are captured at 1920 px wide for the 1280 px window.
const CAPTURE_SCALE = 1920 / 1280;

/**
 * @param {string} dir  take directory (raw/, frames.json)
 * @param {string} out  .gif path
 * @param {{ fps?: number, quality?: number, width?: number, crop?: {x:number,y:number,width:number,height:number} }} options
 *   crop in window pixels (1280 × 800)
 */
export function encodeGif(dir, out, { fps = 12, quality = 80, width = 960, crop } = {}) {
  const { frames, marks } = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  if (frames.length === 0) throw new Error(`record-demo: no frames in ${dir}`);
  // A still ending emits no frames, so run to the take's 'end' mark, not the last frame.
  const endMark = marks.find((m) => m.name === 'end')?.t ?? 0;
  const start = frames[0].t;
  const end = Math.max(frames[frames.length - 1].t + 0.4, endMark);

  const seq = path.join(dir, 'seq');
  fs.rmSync(seq, { recursive: true, force: true });
  fs.mkdirSync(seq);
  let i = 0;
  let j = 0;
  for (let t = start; t <= end; t += 1 / fps) {
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    fs.linkSync(path.join(dir, 'raw', frames[j].file), path.join(seq, `s${String(i++).padStart(5, '0')}.png`));
  }

  let source = seq;
  if (crop) {
    const [x, y, w, h] = [crop.x, crop.y, crop.width, crop.height].map((v) => Math.round(v * CAPTURE_SCALE));
    source = path.join(dir, 'crop');
    fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(source);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path.join(seq, 's%05d.png'), '-vf', `crop=${w}:${h}:${x}:${y}`, path.join(source, 's%05d.png')]);
  }
  const files = fs.readdirSync(source).sort().map((f) => path.join(source, f));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('gifski', ['--fps', String(fps), '--quality', String(quality), '--width', String(width), '-o', out, ...files], { stdio: 'ignore' });
  return { frames: files.length, seconds: files.length / fps, bytes: fs.statSync(out).size };
}

/** Copies `src` to `out`, shrunk with pngquant when it's installed. */
export function optimisePng(src, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    execFileSync('pngquant', ['--quality', '80-95', '--force', '--output', out, src], { stdio: 'ignore' });
  } catch {
    fs.copyFileSync(src, out);
  }
  return { bytes: fs.statSync(out).size };
}
