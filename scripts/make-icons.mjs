// Renders the app icon to the PNG sizes phones ask for. Run with: npm run icons
import { Resvg } from "@resvg/resvg-js";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = new URL("../icons/", import.meta.url);
const NAVY = "#0F2B3A";
const WATER = "#3AAFD9";
const WATER_HI = "#8ED2EA";
const FLOAT = "#F2C640";
const GLASS = "#F8FBFA";

/**
 * The tumbler on a navy field. `scale` shrinks the glass so a maskable icon
 * survives being cropped to a circle; `radius` rounds the field's corners.
 */
function iconSvg({ scale = 1, radius = 0 }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${radius}" fill="${NAVY}"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <clipPath id="glass"><path d="M146 96 L176 388 Q180 424 216 424 L296 424 Q332 424 336 388 L366 96 Z"/></clipPath>
    <g clip-path="url(#glass)">
      <path d="M96 236 Q141 216 186 236 T276 236 T366 236 T456 236 V440 H96 Z" fill="${WATER_HI}"/>
      <path d="M56 250 Q101 230 146 250 T236 250 T326 250 T416 250 V440 H56 Z" fill="${WATER}"/>
    </g>
    <path d="M154 176 H358" stroke="${FLOAT}" stroke-width="12" stroke-dasharray="26 18" stroke-linecap="round"/>
    <path d="M146 96 L176 388 Q180 424 216 424 L296 424 Q332 424 336 388 L366 96" fill="none" stroke="${GLASS}" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

await mkdir(OUT, { recursive: true });
const rounded = iconSvg({ scale: 0.92, radius: 112 });
const square = iconSvg({ scale: 0.92 });
const maskable = iconSvg({ scale: 0.68 });

await Promise.all([
  writeFile(new URL("favicon.svg", OUT), rounded),
  writeFile(new URL("icon-192.png", OUT), png(rounded, 192)),
  writeFile(new URL("icon-512.png", OUT), png(rounded, 512)),
  writeFile(new URL("icon-maskable-512.png", OUT), png(maskable, 512)),
  // iOS rounds the corners itself and shows black behind any transparency.
  writeFile(new URL("apple-touch-icon.png", OUT), png(square, 180)),
]);
