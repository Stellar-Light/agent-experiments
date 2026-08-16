/**
 * Deterministic blob avatars — every agent's address mints its own face.
 * Same address, same face, forever (identity you can see). Self-contained
 * SVG, no external assets.
 */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed: number) {
  let x = seed || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 10000) / 10000; };
}
export function blobAvatar(seed: string, size = 44): string {
  const r = rng(hashSeed(seed));
  const hue = Math.floor(r() * 360);
  const sat = 62 + Math.floor(r() * 18);
  const light = 58 + Math.floor(r() * 10);
  const fill = `hsl(${hue} ${sat}% ${light}%)`;
  // blob: four corner radii, organic
  const rad = () => 38 + Math.floor(r() * 24);
  const br = `${rad()}% ${rad()}% ${rad()}% ${rad()}% / ${rad()}% ${rad()}% ${rad()}% ${rad()}%`;
  // eyes: two rounded capsules, slight tilt + spacing personality
  const eyeTilt = -14 + r() * 28;
  const eyeGap = 10 + r() * 7;
  const eyeY = 16 + r() * 8;
  const eyeH = 8 + r() * 5;
  const squish = 0.92 + r() * 0.16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 44 44">
  <g transform="scale(1 ${squish.toFixed(2)}) translate(0 ${((1 - squish) * 22).toFixed(1)})">
    <foreignObject x="1" y="1" width="42" height="42">
      <div xmlns="http://www.w3.org/1999/xhtml" style="width:42px;height:42px;background:${fill};border-radius:${br}"></div>
    </foreignObject>
    <g transform="rotate(${eyeTilt.toFixed(1)} 22 ${eyeY + eyeH / 2})">
      <rect x="${(22 - eyeGap - 2.6).toFixed(1)}" y="${eyeY}" width="5.2" height="${eyeH.toFixed(1)}" rx="2.6" fill="#101014"/>
      <rect x="${(22 + eyeGap - 2.6).toFixed(1)}" y="${eyeY}" width="5.2" height="${eyeH.toFixed(1)}" rx="2.6" fill="#101014"/>
    </g>
  </g>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
